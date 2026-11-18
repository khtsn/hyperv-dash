import { db, get, put, del, stamp, fail } from './store.mjs';

const windows = new Map([['1h', [60, 1]], ['24h', [1440, 15]], ['7d', [10080, 120]], ['30d', [43200, 360]]]);
const minute = ms => new Date(ms).toISOString().slice(0, 16);
export const thresholds = () => get('config', 'alertThresholds') ?? { diskFreePct: 15, memoryUsedPct: 90 };

export function migrateMetricHistory() {
  if (get('meta', 'indexedVmMetrics')) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`INSERT OR IGNORE INTO vm_metrics SELECT m.host, json_extract(v.value,'$.id'), m.at, v.value
      FROM metrics m,json_each(m.value,'$.vms') v WHERE json_type(v.value,'$.id')='text';
      INSERT OR IGNORE INTO metric_guests SELECT host,vm,coalesce(json_extract(value,'$.name'),vm),max(at)
      FROM vm_metrics GROUP BY host,vm`);
    put('meta', 'indexedVmMetrics', true);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

// Read one indexed row per time bucket. A month of device snapshots can
// otherwise cost hundreds of MB to deserialize on the HTTPS event loop.
export function history(host, range, vmId = '', now = Date.now()) {
  if (!get('hosts', host)) throw fail('Choose a registered host.', 404);
  if (!windows.has(range)) throw fail('Choose 1h, 24h, 7d or 30d.');
  const [minutes, step] = windows.get(range);
  const end = (Math.floor(now / 60000) + 1) * 60000, start = end - minutes * 60000;
  const read = vmId
    ? db.prepare('SELECT at,value FROM vm_metrics WHERE host=? AND vm=? AND at>=? AND at<? ORDER BY at DESC LIMIT 1')
    : db.prepare('SELECT at,value FROM metrics WHERE host=? AND at>=? AND at<? ORDER BY at DESC LIMIT 1');
  const scope = vmId ? [host, vmId] : [host];
  const vms = db.prepare('SELECT vm AS id,name FROM metric_guests WHERE host=? AND last_seen>=? ORDER BY name,vm').all(host, minute(start));
  const points = [];
  for (let at = start; at < end; at += step * 60000) {
    const row = read.get(...scope, minute(at), minute(at + step * 60000));
    const entry = { at, sampledAt: null, value: null };
    if (row) {
      entry.sampledAt = row.at + ':00Z';
      entry.value = JSON.parse(row.value);
      delete entry.value.vms; // legacy host snapshot
    }
    points.push(entry);
  }
  return { start, end, stepMinutes: step, points, vms };
}

const finite = Number.isFinite;
function recordMetrics(host, s) {
  const value = {
    cpuPct: s.cpuPct, memFreeMB: s.memFreeMB, memTotalMB: s.memTotalMB,
    freeDiskGB: s.capacity.freeDiskGB, io: s.io,
  };
  const at = s.lastSeen.slice(0, 16);
  db.prepare('INSERT OR REPLACE INTO metrics(host,at,value) VALUES(?,?,?)').run(host, at, JSON.stringify(value));
  const vmRow = db.prepare('INSERT OR REPLACE INTO vm_metrics VALUES(?,?,?,?)');
  const guestRow = db.prepare('INSERT OR REPLACE INTO metric_guests VALUES(?,?,?,?)');
  for (const { id, name, cpuPct, memMB, state, io } of s.vms) {
    if (!id) continue;
    vmRow.run(host, id, at, JSON.stringify({ cpuPct, memMB, state, io }));
    guestRow.run(host, id, name || id, at);
  }
}

function queue(id, transition) {
  if (process.env.HVDASH_SLACK_WEBHOOK)
    db.prepare('INSERT INTO alert_delivery(alert,transition) VALUES(?,?)').run(id, transition);
}
function resolveAlert(alert, at) {
  db.prepare('UPDATE alerts SET resolved=? WHERE id=?').run(at, alert.id);
  queue(alert.id, 'resolved');
}
export function retireMonitoring(host) {
  for (const alert of db.prepare('SELECT id FROM alerts WHERE host=? AND resolved IS NULL').all(host))
    resolveAlert(alert, stamp());
  del('observedRunning', host);
  db.prepare("DELETE FROM kv WHERE category='expectedStop' AND instr(id,?)=1").run(host.toLowerCase() + '/');
}

export function recordMonitoring(host, s, pollStarted = Date.parse(s.sampledAt)) {
  const active = db.prepare('SELECT * FROM alerts WHERE host=? AND resolved IS NULL').all(host);
  const key = (rule, resource) => JSON.stringify([rule, resource]);
  const previous = new Map(active.map(a => [key(a.rule, a.resource), a]));
  const evaluated = new Set();
  const at = s.sampledAt;
  function condition(rule, resource, triggered, message) {
    const k = key(rule, resource), alert = previous.get(k);
    evaluated.add(k);
    if (triggered == null) return;
    if (!triggered && alert) resolveAlert(alert, at);
    if (triggered && !alert) {
      const { lastInsertRowid } = db.prepare('INSERT INTO alerts(host,rule,resource,message,opened) VALUES(?,?,?,?,?)')
        .run(host, rule, resource, message, at);
      queue(lastInsertRowid, 'opened');
    }
    if (triggered && alert && message !== alert.message)
      db.prepare('UPDATE alerts SET message=? WHERE id=?').run(message, alert.id);
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    condition('unreachable', '', s.status === 'unreachable', 'Host unreachable');
    if (s.fresh) {
      recordMetrics(host, s);
      const limits = thresholds();
      const used = finite(s.memFreeMB) && s.memTotalMB > 0 ? 100 * (1 - s.memFreeMB / s.memTotalMB) : null;
      condition('memory', '', used == null ? null : used > limits.memoryUsedPct,
        'Memory usage above ' + limits.memoryUsedPct + '%');
      for (const disk of s.disks) {
        const free = finite(disk.freeGB) && disk.sizeGB > 0 ? 100 * disk.freeGB / disk.sizeGB : null;
        condition('disk', disk.name, free == null ? null : free < limits.diskFreePct,
          disk.name + ' below ' + limits.diskFreePct + '% free');
      }
      const running = new Set(get('observedRunning', host) ??
        get('fleetCache', host)?.vms?.filter(v => v.state === 'Running').map(v => v.id) ?? []), next = [];
      for (const vm of s.vms) {
        if (!vm.id) continue;
        const intentKey = host.toLowerCase() + '/' + vm.id.toLowerCase();
        const intent = get('expectedStop', intentKey);
        const off = ['Off', 'OffCritical'].includes(vm.state);
        if (vm.state === 'Running' || (running.has(vm.id) && !off && vm.state !== 'Saved')) next.push(vm.id);
        const intentional = intent && (intent.finishedAt != null || intent.expires >= pollStarted);
        if (off || vm.state === 'Running' || vm.state === 'Saved') {
          const unexpected = off && (previous.has(key('vm-stop', vm.id)) || (running.has(vm.id) && !intentional));
          condition('vm-stop', vm.id, unexpected, vm.name + ' stopped unexpectedly');
        }
        else evaluated.add(key('vm-stop', vm.id)); // transient state
        // An in-flight poll can predate the command. Only a subsequent
        // observation may consume the confirmed intent after a service restart.
        const confirmed = intent?.finishedAt != null && intent.finishedAt <= pollStarted;
        if (intent && (!intentional || (confirmed && (off || vm.state === 'Running' || vm.state === 'Saved'))))
          del('expectedStop', intentKey);
      }
      put('observedRunning', host, next);
      // Fresh inventory confirms a disk or guest has been removed.
      for (const alert of active) if (!evaluated.has(key(alert.rule, alert.resource))) resolveAlert(alert, at);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function activeAlerts() {
  return db.prepare('SELECT * FROM alerts WHERE resolved IS NULL ORDER BY opened DESC,id DESC').all();
}

function slackEndpoint() {
  try {
    const url = new URL(process.env.HVDASH_SLACK_WEBHOOK);
    if (url.origin === 'https://hooks.slack.com' && !url.username && !url.password && !url.search && !url.hash &&
        /^\/services\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(url.pathname)) return url;
  } catch {}
}
let delivering = false;
export async function deliverAlerts(send = fetch, now = Date.now()) {
  const endpoint = slackEndpoint();
  if (delivering || !endpoint) return;
  delivering = true;
  try {
    const batch = db.prepare(`SELECT d.*,a.host,a.message,a.opened,a.resolved FROM alert_delivery d
      JOIN alerts a ON a.id=d.alert WHERE d.sent IS NULL AND d.due<=?
      AND NOT EXISTS (SELECT 1 FROM alert_delivery earlier WHERE earlier.alert=d.alert AND earlier.id<d.id AND earlier.sent IS NULL)
      ORDER BY d.id LIMIT 10`).all(now);
    for (const event of batch) {
      try {
        const text = ['Hyper-V Dash', event.transition, event.host, event.message,
          event.transition === 'opened' ? event.opened : event.resolved].join(' · ');
        const response = await send(endpoint, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, mrkdwn: false, blocks: [{ type: 'section', text: { type: 'plain_text', text } }] }),
        });
        await response.body?.cancel();
        if (!response.ok) throw Error('Delivery failed');
        db.prepare('UPDATE alert_delivery SET sent=? WHERE id=?').run(stamp(), event.id);
      } catch {
        const retryMs = Math.min(3600000, 30000 * 2 ** Math.min(event.attempts, 7));
        db.prepare('UPDATE alert_delivery SET attempts=attempts+1,due=? WHERE id=?').run(now + retryMs, event.id);
      }
    }
  } finally { delivering = false; }
}

export function pruneMonitoring(now = Date.now()) {
  const cutoff = new Date(now - 30 * 86400000).toISOString();
  db.prepare('DELETE FROM metrics WHERE at < ?').run(cutoff.slice(0, 16));
  db.prepare('DELETE FROM vm_metrics WHERE at < ?').run(cutoff.slice(0, 16));
  db.prepare('DELETE FROM metric_guests WHERE last_seen < ?').run(cutoff.slice(0, 16));
  db.prepare('DELETE FROM alerts WHERE resolved < ? AND id NOT IN (SELECT alert FROM alert_delivery WHERE sent IS NULL)').run(cutoff);
}
export function monitoringRoute({ key, url, b, user }) {
  if (key === 'GET /api/history')
    return history(url.searchParams.get('host') || '', url.searchParams.get('range') || '1h', url.searchParams.get('vm'));
  if (key === 'GET /api/alerts') {
    const delivery = !process.env.HVDASH_SLACK_WEBHOOK ? 'Disabled' : slackEndpoint() ? 'Slack enabled' : 'Invalid Slack configuration';
    return { active: activeAlerts(),
      recent: db.prepare('SELECT * FROM alerts WHERE resolved IS NOT NULL ORDER BY resolved DESC,id DESC LIMIT 100').all(),
      thresholds: thresholds(), delivery,
      pending: db.prepare('SELECT COUNT(*) AS count FROM alert_delivery WHERE sent IS NULL').get().count,
      retrying: db.prepare('SELECT COUNT(*) AS count FROM alert_delivery WHERE sent IS NULL AND attempts>0').get().count };
  }
  if (key === 'POST /api/alerts/thresholds') {
    if (user.role !== 'admin') throw fail('Administrator access required.', 403);
    const { diskFreePct, memoryUsedPct } = b;
    if (![diskFreePct, memoryUsedPct].every(n => Number.isInteger(n) && n >= 1 && n <= 99))
      throw fail('Enter whole percentages from 1 to 99.');
    put('config', 'alertThresholds', { diskFreePct, memoryUsedPct });
    return thresholds();
  }
}
