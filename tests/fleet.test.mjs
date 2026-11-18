import {removeFixture} from './temp-state.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const temp = mkdtempSync(path.join(os.tmpdir(), 'hvdash-fleet-test-'));
process.env.HVDASH_DATA = temp;
process.env.HVDASH_FAKE = '1';
const { fleetRoute, refreshHost, stats, fleet, host, diagnose } = await import('../fleet.mjs');
const { db, put, get } = await import('../store.mjs');
after(() => {
  db.close();
  removeFixture(temp,'hvdash-fleet-test-');
});
const user = { name: 'alice', role: 'admin' };
const fakeStats = (h, warnings = []) => ({
  computer: h,
  os: 'fixture',
  cpuPct: 25,
  memTotalMB: 16000,
  memFreeMB: 4000,
  logicalProcessors: 8,
  cores: 4,
  disks: [{ name: 'D:', sizeGB: 400, freeGB: 300 }],
  networks: [{ id: 'LAN', name: 'lan', type: 'Internal' }],
  warnings,
  vms: [
    { name: 'vm', state: 'Running', vcpu: 2, memMB: 1024, startupMB: 2048, diskGB: 20, adapters: [] },
    { name: 'idle', state: 'Off', vcpu: 4, memMB: 0, startupMB: 4096, diskGB: 40, adapters: [] },
  ],
});
const driver = async (h, op) =>
  op === 'fleet.test' ? { computer: h.name, os: 'fixture' } : fakeStats(h.name);
const call = (key, b, userObj = user, more = {}) =>
  fleetRoute({ key, b, url: new URL('https://localhost/'), user: userObj, runPs: driver, ...more });

test('PowerShell collects OS, switch attachments, per-VM allocation, and capacity using a synthetic host', () => {
  const ps = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      fileURLToPath(new URL('./fleet-collector-fixture.ps1', import.meta.url)),
    ],
    { windowsHide: true, encoding: 'utf8', timeout: 15000 },
  );
  assert.equal(ps.status, 0, ps.stderr);
  assert.match(ps.stdout, /collector fixture passed/);
});

test('test connection, save host, write-only per-host credential and role checks', async () => {
  const config = {
    name: 's1',
    address: 's1.invalid',
    transport: 'winrm',
    user: 'fixture-service-user',
    password: 'mock-input-password-1',
  };
  await assert.rejects(
    call('POST /api/hosts/save', config, { name: 'op', role: 'operator' }),
    /Administrator/,
  );
  await assert.rejects(
    call('POST /api/hosts/test', { ...config, passEnv: 'UNRELATED_SECRET' }),
    /Unknown host setting/,
  );
  await assert.rejects(call('POST /api/hosts/test', { ...config, address: '-bad' }), /DNS host name/);
  const tested = await call('POST /api/hosts/test', config);
  assert.equal(tested.ok, true);
  assert.equal(get('hosts', config.name), undefined);
  await call('POST /api/hosts/save', config);
  assert.notEqual(get('hosts', 's1').credential.secret, config.password);
  assert(!JSON.stringify(get('hosts', 's1')).includes(config.password));
  assert(!JSON.stringify(get('hosts', 's1')).includes(config.user));
  assert.equal(get('hosts', 's1').credential.format, 2);
  const [visible] = await call('GET /api/hosts', {}, { role: 'viewer' });
  assert.equal(visible.hasCredential, true);
  assert(!('credential' in visible));
  await assert.rejects(
    call('POST /api/hosts/save', {
      name: 's1',
      originalName: 's1',
      address: 'other.invalid',
      transport: 'winrm',
    }),
    /Re-enter/,
  );
  await call('POST /api/hosts/save', {
    name: 's1',
    originalName: 's1',
    displayName: 'North office',
    address: 's1.invalid',
    transport: 'winrm',
  });
  assert.equal(get('hosts', 's1').displayName, 'North office');
  assert(get('hosts', 's1').credential.secret);
  await assert.rejects(call('POST /api/hosts/remove', { name: 's1', confirm: 'wrong' }), /Type/);
});

test('cached totals exclude unreachable hosts and retain their last successful observation', async () => {
  const online = { name: 'healthy', transport: 'winrm', address: 'ok.invalid' },
    other = { name: 'offline', transport: 'winrm', address: 'bad.invalid' };
  put('hosts', online.name, online);
  put('hosts', other.name, other);
  await refreshHost(online.name, driver);
  await refreshHost(other.name, driver);
  const observed = stats(other.name).lastSeen;
  let release;
  const slow = refreshHost(
    other.name,
    () =>
      new Promise((_, reject) => {
        release = reject;
      }),
  );
  assert.equal(stats(online.name).status, 'online'); // the other request is still outstanding
  release(Error('ECONNREFUSED'));
  await slow;
  const bad = stats(other.name);
  assert.equal(bad.lastSeen, observed);
  assert.equal(bad.status, 'unreachable');
  assert.equal(bad.vms.length, 2);
  assert.equal(bad.fresh, false);
  const inventory = stats(online.name);
  assert.equal(inventory.capacity.allocatedVcpus, 6);
  assert.equal(inventory.capacity.allocatedMemoryMB, 6144);
  assert.equal(inventory.capacity.provisionedDiskGB, 60);
  const totals = fleet().totals;
  assert.equal(totals.unreachable, 1);
  assert.equal(totals.freeCpuCores, 6 * totals.reportingHosts);
  assert.equal(totals.freeMemoryMB, 4000 * totals.reportingHosts);
  assert.equal(totals.freeDiskGB, 300 * totals.reportingHosts);
});

test('diagnostics classify DNS, port, auth, trust, and missing role without quoting remote secrets', () => {
  for (const [error, part] of [
    ['getaddrinfo ENOTFOUND', 'resolve'],
    ['ECONNREFUSED', 'port'],
    ['Access is denied', 'Authentication'],
    ['WSMan TrustedHosts', 'trust'],
    ['HVDASH_ROLE', 'Hyper-V'],
    ['HVDASH_VMMS', 'stopped'],
  ]) {
    const result = diagnose(Error(error + ' mock-secret'));
    assert(result.error.includes(part), JSON.stringify(result));
    assert(result.suggestion);
    assert(!JSON.stringify(result).includes('mock-secret'));
  }
});

test('an address returning a different server cannot be used for VM operations', async () => {
  const h = { name: 'moved', address: 'identity.invalid', transport: 'winrm' };
  put('hosts', h.name, h);
  await refreshHost(h.name, async () => fakeStats('original-machine'));
  await refreshHost(h.name, async () => fakeStats('unexpected-machine'));
  assert.equal(stats(h.name).status, 'degraded');
  assert.equal(stats(h.name).fresh, false);
  assert.throws(() => host(h.name), /identity changed/);
  await refreshHost(h.name, async () => fakeStats('original-machine'));
  assert.equal(host(h.name).name, h.name);
});

test('WinNAT requires an administrator, valid internal subnet and exact delete confirmation', async () => {
  const mapping = {
    id: 7,
    nat: 'lan',
    protocol: 'TCP',
    externalIP: '0.0.0.0/0',
    externalPort: 8443,
    internalIP: '192.0.2.4',
    internalPort: 443,
  };
  const dispatched = [];
  const natDriver = async (h, op, p) => {
    if (op === 'fleet.nat')
      return { networks: [{ name: 'lan', prefix: '192.0.2.0/24' }], mappings: [mapping] };
    dispatched.push({ op, p });
  };
  const opts = {
    runPs: natDriver,
    startJob: async (a, h, n, o, work) => {
      await work(() => {});
      return { job: 'job' };
    },
  };
  const body = { ...mapping, host: 'healthy', action: 'remove', confirm: 'lan/7' };
  await assert.rejects(call('POST /api/nat', body, { role: 'operator' }, opts), /Administrator/);
  await assert.rejects(call('POST /api/nat', { ...body, confirm: 'lan' }, user, opts), /Confirm/);
  await assert.rejects(call('POST /api/nat', { ...body, internalPort: 80 }, user, opts), /changed/);
  await assert.rejects(
    call('POST /api/nat', { ...body, action: 'add', internalIP: '192.0.3.1' }, user, opts),
    /within/,
  );
  assert.equal((await call('POST /api/nat', body, user, opts)).job, 'job');
  assert.equal(dispatched[0].op, 'fleet.natRemove');
  assert.equal(dispatched.length, 1);
});
