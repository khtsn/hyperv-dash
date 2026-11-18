import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { db, get, put, del, list, stamp, fail } from './store.mjs';
import { runPs, protectSecret } from './driver.mjs';
import { activeAlerts, deliverAlerts, migrateMetricHistory, pruneMonitoring, recordMonitoring, retireMonitoring } from './monitoring.mjs';

const samples = new Map();
const pending = new Map();
const hostChanges = new Set();
const interval = 10000;
const staleAfter = 60000;
let timer;
const array = (value) => (value == null ? [] : [].concat(value));
const sum = (rows, field) => rows.reduce((a, b) => a + (Number(b[field]) || 0), 0);
const publicHost = (h) => ({
  name: h.name,
  displayName: h.displayName || h.name,
  address: h.address,
  transport: h.transport,
  hasCredential: Boolean(h.credential || h.userEnv),
});
function registeredHost(name) {
  const h = typeof name === 'string' && get('hosts', name);
  if (!h) throw fail('Unknown host. Refresh the host list.', 404);
  return h;
}
export function host(name) {
  const h = registeredHost(name);
  if (get('identityMismatch', h.name))
    throw fail(
      'Host identity changed. Verify the address and save a successful connection test before managing this host.',
      409,
    );
  return h;
}

export function diagnose(error) {
  const detail = String(error?.message || '');
  if (/HVDASH_IDENTITY/.test(detail)) {
    return {
      error: 'The address now points to a different machine.',
      suggestion: 'Verify its host identity before using this registration.',
    };
  }
  if (/HVDASH_DNS|DNS|ENOTFOUND|getaddrinfo|No such host is known/i.test(detail)) {
    return {
      error: 'The host name did not resolve.',
      suggestion: 'Check the address and the management machine’s DNS resolver.',
    };
  }
  if (/HVDASH_PORT|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH/.test(detail)) {
    return {
      error: 'The management port is unreachable.',
      suggestion: 'Check host power, routing, the firewall and the configured WinRM listener.',
    };
  }
  if (/TrustedHosts|trusted hosts/i.test(detail)) {
    return {
      error: 'WinRM does not trust the target for this authentication method.',
      suggestion:
        'Use a domain name with Kerberos or HTTPS WinRM. For workgroups, trust only the verified target.',
    };
  }
  if (
    /access is denied|access denied|credential|logon failure|authentication failed|user name or password|0x80070005|0x8007052e/i.test(
      detail,
    )
  ) {
    return {
      error: 'Authentication or authorization failed.',
      suggestion: 'Check the per-host credential and its WinRM and Hyper-V permissions.',
    };
  }
  if (/HVDASH_ROLE|Get-VMHost.*not recognized|Hyper-V role/i.test(detail)) {
    return {
      error: 'Hyper-V or its management module is missing.',
      suggestion: 'Install the Hyper-V role and its PowerShell tools on the selected host.',
    };
  }
  if (/HVDASH_VMMS/.test(detail)) {
    return {
      error: 'Hyper-V Virtual Machine Management is stopped.',
      suggestion: 'Check the VMMS service on the host.',
    };
  }
  if (/certificate|SSL|TLS/i.test(detail)) {
    return {
      error: 'The WinRM TLS connection failed.',
      suggestion: 'Check certificate trust, the certificate host name and the HTTPS listener.',
    };
  }
  if (/timeout|timed out|WSManFault|WinRM cannot complete/i.test(detail)) {
    return {
      error: 'The host did not answer the remoting request in time.',
      suggestion: 'Verify the WinRM service and firewall, then test the connection again.',
    };
  }
  return {
    error: 'The Hyper-V host operation failed.',
    suggestion: 'Run the connection test and inspect the host’s WinRM and VMMS event logs.',
  };
}

function identity(sample) {
  const uuid = String(sample?.uuid || '').toLowerCase();
  // Some hardware vendors return an all-zero/all-ones SMBIOS placeholder.
  if (
    /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(uuid) &&
    !/^0+$|^f+$/.test(uuid.replaceAll('-', ''))
  )
    return 'uuid:' + uuid;
  const name = String(sample?.computer || '')
    .trim()
    .toLowerCase();
  if (!name) throw fail('The host did not return a computer identity. Verify the remote CIM provider.', 502);
  return 'computer:' + name;
}

function safeName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(value))
    throw fail('Enter a host ID using letters, digits, dot, dash or underscore.');
  return value;
}
function safeAddress(value) {
  if (
    typeof value !== 'string' ||
    (!net.isIP(value) &&
      (value.length > 253 ||
        !value.split('.').every((v) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(v))))
  )
    throw fail('Enter an IP address or DNS host name.');
  return value;
}
function admin(user) {
  if (user?.role !== 'admin') throw fail('Administrator access required.', 403);
}
function inUse(h) {
  return Boolean(
    db.prepare("SELECT 1 FROM jobs WHERE host=? COLLATE NOCASE AND status='running'").get(h.name),
  );
}
function hostOptions(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw fail('Invalid host configuration.');
  const known = [
    'originalName',
    'name',
    'displayName',
    'address',
    'transport',
    'user',
    'password',
    'clearCredential',
  ];
  if (Object.keys(b).some((k) => !known.includes(k))) throw fail('Unknown host setting.');
  const name = safeName(b.name),
    address = safeAddress(b.transport === 'local' && b.address === '.' ? 'localhost' : b.address);
  const displayName = b.displayName ?? name;
  if (typeof displayName !== 'string' || displayName.trim().length < 1 || displayName.length > 80)
    throw fail('Enter a display name of 1–80 characters.');
  const transport = b.transport || 'winrm';
  if (!['local', 'winrm', 'winrm-https'].includes(transport))
    throw fail('Select local, WinRM, or WinRM HTTPS.');
  if (transport === 'local' && !['localhost', '127.0.0.1', '::1', '.'].includes(address.toLowerCase()))
    throw fail('Use localhost for the local transport.');
  if (b.originalName && b.originalName !== name)
    throw fail('Host IDs are permanent. Edit the display name instead.');
  if (
    typeof b.user !== 'undefined' &&
    (typeof b.user !== 'string' || b.user.length > 200 || /[\r\n\x00]/.test(b.user))
  )
    throw fail('Invalid credential user.');
  if (typeof b.password !== 'undefined' && (typeof b.password !== 'string' || b.password.length > 2048))
    throw fail('Invalid credential password.');
  if (b.clearCredential !== undefined && typeof b.clearCredential !== 'boolean')
    throw fail('Invalid clearCredential setting.');
  return { name, address, displayName: displayName.trim(), transport };
}

async function candidate(b) {
  const h = hostOptions(b),
    old = b.originalName ? registeredHost(b.originalName) : null;
  const duplicate = list('hosts').find((x) => x.name.toLowerCase() === h.name.toLowerCase());
  if (duplicate && !old) throw fail('This host ID already exists. Edit the registered host.', 409);
  if (b.password && (!b.user || b.clearCredential || h.transport === 'local'))
    throw fail('A remote credential needs a username, password and a WinRM transport.');
  if (b.user && !b.password)
    throw fail('Enter both a username and a password to replace the saved credential.');
  if (b.password)
    h.credential = {
      format: 2,
      secret: await protectSecret(JSON.stringify({ user: b.user, password: b.password })),
    };
  else if (old && !b.clearCredential && h.transport !== 'local') {
    if ((old.credential || old.userEnv) && (old.address !== h.address || old.transport !== h.transport))
      throw fail('Re-enter the credential or explicitly clear it when changing the connection target.');
    if (old.credential) h.credential = old.credential;
    else if (old.userEnv && old.passEnv) {
      h.userEnv = old.userEnv;
      h.passEnv = old.passEnv;
    }
  }
  return h;
}

async function portTest(h) {
  if (h.transport === 'local' || process.env.HVDASH_FAKE === '1') return;
  const port = h.transport === 'winrm-https' ? 5986 : 5985;
  let handle;
  try {
    await Promise.race([
      lookup(h.address),
      new Promise((_, reject) => {
        handle = setTimeout(() => reject(Error('HVDASH_DNS')), 4000);
      }),
    ]);
  } catch {
    throw Error('HVDASH_DNS');
  } finally {
    clearTimeout(handle);
  }
  await new Promise((resolve, reject) => {
    const sock = net.connect({ host: h.address, port });
    const done = (err) => {
      clearTimeout(t);
      sock.destroy();
      if (err) reject(Error('HVDASH_PORT'));
      else resolve();
    };
    const t = setTimeout(() => done(true), 4000);
    sock.once('connect', () => done(false));
    sock.once('error', () => done(true));
  });
}
async function testHost(h, driver) {
  try {
    await portTest(h);
    return await driver(h, 'fleet.test', {}, { timeoutMs: 18000 });
  } catch (e) {
    const d = diagnose(e);
    throw fail(d.error + ' ' + d.suggestion, 502);
  }
}
function normalize(h, data) {
  if (!data || typeof data.computer !== 'string' || !(data.memTotalMB > 0))
    throw Error('Invalid host response');
  const networks = array(data.networks).map((s) => ({
    ...s,
    adapters: array(s.adapters),
    ipv4: array(s.ipv4),
    physicalAdapters: array(s.physicalAdapters),
  }));
  const vms = array(data.vms).map((v) => ({
    ...v,
    ips: array(v.ips),
    io: array(v.io),
    adapters: array(v.adapters).map((a) => ({ ...a, ips: array(a.ips) })),
  }));
  const disks = array(data.disks);
  const warnings = array(data.warnings);
  const lastSeen = stamp();
  return {
    ...publicHost(h),
    ...data,
    networks,
    io: array(data.io),
    switches: networks.map((n) => n.name),
    vms,
    disks,
    warnings,
    lastSeen,
    sampledAt: lastSeen,
    status: warnings.length ? 'degraded' : 'online',
    error: warnings.join(' '),
    suggestion: warnings.length ? 'Review access to the affected host resources.' : '',
    fresh: true,
    capacity: {
      allocatedVcpus: sum(vms, 'vcpu'),
      allocatedMemoryMB: sum(vms, 'startupMB'),
      provisionedDiskGB: data.provisionedDiskGB ?? sum(vms, 'diskGB'),
      physicalDiskGB: sum(disks, 'sizeGB'),
      freeDiskGB: sum(disks, 'freeGB'),
    },
  };
}
const stateKey = (h) => [h.address, h.transport, h.credential?.secret, h.userEnv, h.passEnv].join('\0');
function blank(h) {
  return {
    ...publicHost(h),
    status: 'degraded',
    fresh: false,
    lastSeen: null,
    sampledAt: null,
    error: 'First sample pending.',
    suggestion: 'Wait for the first inventory scan.',
    vms: [],
    disks: [],
    switches: [],
    networks: [],
    warnings: [],
    capacity: null,
  };
}
export function stats(name) {
  const h = registeredHost(typeof name === 'string' ? name : name?.name);
  const s = samples.get(h.name) ?? get('fleetCache', h.name) ?? blank(h);
  const tooOld = s.lastSeen && Date.now() - Date.parse(s.lastSeen) > staleAfter;
  return {
    ...s,
    ...publicHost(h),
    fresh: !!s.fresh && !tooOld,
    ...(tooOld && s.status === 'online'
      ? {
          status: 'degraded',
          error: 'Showing a stale inventory sample.',
          suggestion: 'Check the host connection.',
        }
      : {}),
  };
}
export async function refreshHost(name, driver = runPs) {
  const h = registeredHost(name),
    fingerprint = stateKey(h);
  const current = pending.get(name);
  if (current?.fingerprint === fingerprint) return current.promise;
  const token = { fingerprint };
  pending.set(name, token);
  token.promise = (async () => {
    const pollStarted = Date.now();
    let s,
      changed = false;
    try {
      const data = await driver(h, 'fleet.stats', {}, { timeoutMs: 45000 });
      const target = identity(data),
        known = get('hostIdentity', h.name.toLowerCase());
      if (known && known !== target) {
        changed = true;
        throw fail('HVDASH_IDENTITY');
      }
      s = normalize(h, data);
    } catch (e) {
      const problem = diagnose(e);
      const reachable = /HVDASH_ROLE|HVDASH_VMMS|HVDASH_IDENTITY|access is denied|authorization failed/i.test(
        e?.message || '',
      );
      s = {
        ...(samples.get(name) ?? get('fleetCache', name) ?? blank(h)),
        ...problem,
        status: reachable ? 'degraded' : 'unreachable',
        fresh: false,
        sampledAt: stamp(),
      };
    }
    const registered = get('hosts', name);
    if (pending.get(name) !== token || !registered || stateKey(registered) !== fingerprint) return;
    if (changed) put('identityMismatch', name, true);
    if (s.fresh) {
      const { recordObserved } = await import('./provisioning.mjs');
      if (pending.get(name) !== token) return;
      put('hostIdentity', name.toLowerCase(), identity(s));
      del('identityMismatch', name);
      recordObserved(name, s);
    }
    recordMonitoring(name, s, pollStarted);
    samples.set(name, s);
    put('fleetCache', name, s);
    return s;
  })().finally(() => {
    if (pending.get(name) === token) pending.delete(name);
  });
  return token.promise;
}
export function startFleet() {
  if (timer) return;
  migrateMetricHistory();
  let nextPrune = 0;
  function poll() {
    for (const h of list('hosts')) refreshHost(h.name).catch(() => {});
    if (Date.now() >= nextPrune) {
      pruneMonitoring();
      nextPrune = Date.now() + 3600000;
    }
    void deliverAlerts().catch(() => {});
  }
  poll();
  timer = setInterval(poll, interval);
  timer.unref();
}
export function stopFleet() {
  clearInterval(timer);
  timer = undefined;
}
export function fleet() {
  const hosts = list('hosts').map((h) => stats(h.name));
  const live = hosts.filter((h) => h.fresh),
    vms = live.flatMap((h) => h.vms);
  const count = (status) => hosts.filter((h) => h.status === status).length;
  return {
    hosts,
    alerts: activeAlerts(),
    updatedAt: stamp(),
    totals: {
      hosts: hosts.length,
      online: count('online'),
      degraded: count('degraded'),
      unreachable: count('unreachable'),
      reportingHosts: live.length,
      totalVMs: vms.length,
      running: vms.filter((v) => v.state === 'Running').length,
      stopped: vms.filter((v) => v.state === 'Off').length,
      freeMemoryMB: sum(live, 'memFreeMB'),
      freeDiskGB: sum(
        live.map((s) => s.capacity),
        'freeDiskGB',
      ),
      freeCpuCores:
        Math.round(
          live.reduce(
            (n, s) => n + (s.cpuPct != null ? (s.logicalProcessors || s.cores) * (1 - s.cpuPct / 100) : 0),
            0,
          ) * 10,
        ) / 10,
    },
  };
}
function ipv4part(value) {
  if (typeof value !== 'string' || net.isIP(value) !== 4) throw fail('Enter valid IPv4 addresses for NAT.');
  return value;
}
const asNumber = (s) => s.split('.').reduce((n, x) => n * 256 + Number(x), 0);
function natParams(b) {
  if (typeof b.nat !== 'string' || !b.nat.trim() || b.nat.length > 128 || /[\x00-\x1f*?[\]]/.test(b.nat))
    throw fail('Select a valid NAT network.');
  if (!['TCP', 'UDP'].includes(b.protocol)) throw fail('Select TCP or UDP.');
  const internalIP = ipv4part(b.internalIP);
  const [ip, slash, extra] = String(b.externalIP || '').split('/');
  ipv4part(ip);
  if (extra !== undefined || (slash !== undefined && !/^(?:[0-9]|[12][0-9]|3[012])$/.test(slash)))
    throw fail('Enter a valid external IPv4 address or prefix.');
  const port = (n) => {
    if (!Number.isInteger(Number(n)) || Number(n) < 1 || Number(n) > 65535)
      throw fail('Ports must be 1–65535.');
    return Number(n);
  };
  return {
    nat: b.nat,
    protocol: b.protocol,
    internalIP,
    externalIP: b.externalIP,
    externalPort: port(b.externalPort),
    internalPort: port(b.internalPort),
  };
}
function inPrefix(ip, prefix) {
  const [addr, bits] = String(prefix || '').split('/');
  if (net.isIP(addr) !== 4 || !/^(?:[0-9]|[12][0-9]|3[012])$/.test(bits)) return false;
  const size = 2 ** (32 - Number(bits));
  const netId = Math.floor(asNumber(addr) / size) * size;
  return asNumber(ip) >= netId + (size > 2 ? 1 : 0) && asNumber(ip) < netId + size - (size > 2 ? 1 : 0);
}
async function natList(h, driver) {
  try {
    const r = await driver(h, 'fleet.nat');
    return {
      networks: array(r.networks),
      mappings: array(r.mappings).map((m) => ({
        ...m,
        protocol: { 6: 'TCP', 17: 'UDP' }[m.protocol] || String(m.protocol).toUpperCase(),
      })),
    };
  } catch {
    throw fail(
      'Unable to read WinNAT. Check the NetNat module, service, connection and host permissions.',
      502,
    );
  }
}
export async function fleetRoute(ctx) {
  const { key, b = {}, url, user } = ctx,
    driver = ctx.runPs || runPs;
  if (key === 'GET /api/hosts') return list('hosts').map(publicHost);
  if (key === 'GET /api/host') return stats(url.searchParams.get('name'));
  if (key === 'GET /api/fleet') return fleet();
  if (key === 'GET /api/nat') return natList(host(url.searchParams.get('host')), driver);
  if (key === 'POST /api/hosts/test' || key === 'POST /api/hosts/save') {
    admin(user);
    const id = safeName(b.name).toLowerCase();
    if (hostChanges.has(id)) throw fail('A host change is already in progress.', 409);
    hostChanges.add(id);
    try {
      const h = await candidate(b);
      const test = await testHost(h, driver);
      if (key.endsWith('/test')) return { ok: true, computer: test.computer, os: test.os };
      if (inUse(h))
        throw fail('Wait for the running host jobs to finish before changing this connection.', 409);
      const known = get('hostIdentity', id),
        match = identity(test),
        retired = get('retiredHost', id);
      if (
        (known && known !== match) ||
        (!known && retired && (retired.address !== h.address || retired.transport !== h.transport))
      )
        throw fail('This host ID belongs to a different machine. Use a new ID for this host.', 409);
      if (list('hosts').some((x) => x.name !== h.name && get('hostIdentity', x.name.toLowerCase()) === match))
        throw fail('This machine already has a host ID. Edit its existing registration.', 409);
      put('hostIdentity', id, match);
      del('retiredHost', id);
      del('identityMismatch', h.name);
      put('hosts', h.name, h);
      pending.delete(h.name);
      samples.delete(h.name);
      del('fleetCache', h.name);
      void refreshHost(h.name, driver).catch(() => {});
      return { ok: true, ...publicHost(h) };
    } finally {
      hostChanges.delete(id);
    }
  }
  if (key === 'POST /api/hosts/remove') {
    admin(user);
    const h = registeredHost(b.name);
    if (b.confirm !== h.name) throw fail('Type the host ID to remove its registration.');
    if (hostChanges.has(h.name.toLowerCase()) || inUse(h))
      throw fail('Wait for running host work to finish.', 409);
    // Keep IP reservations and ownership records. Reconnecting the same ID is
    // restricted to the verified computer identity, even after unregistering.
    put('retiredHost', h.name.toLowerCase(), { address: h.address, transport: h.transport });
    db.exec('BEGIN IMMEDIATE');
    try {
      retireMonitoring(h.name);
      del('hosts', h.name);
      del('fleetCache', h.name);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    pending.delete(h.name);
    samples.delete(h.name);
    return { ok: true };
  }
  if (key === 'POST /api/nat') {
    admin(user);
    const h = host(b.host),
      p = natParams(b);
    if (!['add', 'remove'].includes(b.action)) throw fail('Select add or remove.');
    if (b.action === 'remove') {
      if (!Number.isSafeInteger(Number(b.id)) || Number(b.id) < 0 || b.confirm !== p.nat + '/' + b.id)
        throw fail('Confirm the network and mapping ID before removal.');
      p.id = Number(b.id);
    }
    const listing = await natList(h, driver);
    if (b.action === 'remove') {
      if (
        !listing.mappings.some(
          (m) => Number(m.id) === p.id && Object.keys(p).every((k) => k === 'id' || m[k] === p[k]),
        )
      )
        throw fail('The mapping has changed. Refresh and confirm it again.', 409);
    } else {
      const network = listing.networks.find((n) => n.name === p.nat);
      if (!network || !inPrefix(p.internalIP, network.prefix))
        throw fail('Choose an internal host address within the selected NAT prefix.');
    }
    return ctx.startJob(user.name, h.name, '$nat', 'nat.' + b.action, async (step) => {
      step(b.action === 'add' ? 'Creating NAT mapping' : 'Removing confirmed NAT mapping');
      try {
        await driver(h, b.action === 'add' ? 'fleet.natAdd' : 'fleet.natRemove', p);
      } catch {
        throw fail(
          'WinNAT could not update the mapping. Check for a conflicting port or changed mapping, then refresh the list.',
          502,
        );
      }
    });
  }
}
