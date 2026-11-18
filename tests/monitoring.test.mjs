import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeFixture } from './temp-state.mjs';

const dir = mkdtempSync(path.join(os.tmpdir(), 'hvdash-monitoring-'));
process.env.HVDASH_DATA = dir;
delete process.env.HVDASH_SLACK_WEBHOOK;
const { db, put } = await import('../store.mjs');
const { activeAlerts, deliverAlerts, history, migrateMetricHistory, pruneMonitoring, recordMonitoring } = await import('../monitoring.mjs');
after(() => { db.close(); removeFixture(dir,'hvdash-monitoring-'); });

test('upgrade indexes legacy VM samples, preserves gaps, zeroes and removed VMs, and expires old data', () => {
  const now = Date.parse('2026-11-18T12:00:45Z'), host = 'legacy';
  put('hosts', host, { name: host });
  const write = db.prepare('INSERT INTO metrics VALUES(?,?,?)');
  for (const at of ['2026-10-18T12:00', '2026-10-20T12:00', '2026-11-18T11:49']) {
    write.run(host, at, JSON.stringify({ cpuPct: 0, vms: [{ id: 'removed', cpuPct: 7, memMB: 12 }] }));
  }
  write.run(host, '2026-11-18T11:50', JSON.stringify({ cpuPct: 15, vms: [] }));
  migrateMetricHistory();
  migrateMetricHistory();
  const month = history(host,'30d','removed',now);
  assert.equal(month.points.length,120);
  assert.equal(month.points.filter(p => p.value).length,2);
  assert.equal(month.points.at(-1).value.cpuPct,7);
  assert.deepEqual(month.vms.map(v=>v.id),['removed']);
  const hour = history(host,'1h','',now).points;
  assert.equal(hour.length,60);
  assert.equal(hour.filter(p=>p.value).length,2);
  assert.equal(hour.find(p=>p.value).value.cpuPct,0);
  assert.equal(hour.at(-1).value,null);
  assert.equal(history(host,'24h','',now).points.length,96);
  assert.equal(history(host,'7d','',now).points.length,84);
  assert.throws(()=>history(host,'365d','',now),{status:400});
  assert.throws(()=>history('absent','24h','',now),{status:404});
  pruneMonitoring(now);
  assert.equal(db.prepare('SELECT min(at) AS at FROM vm_metrics').get().at,'2026-10-20T12:00');
});

test('durable incidents retain unknown conditions, suppress planned stops and recover independently', () => {
  const host = 'fleet-a';
  const sample = { fresh:true,status:'online',sampledAt:'2026-11-18T12:00:13Z',lastSeen:'2026-11-18T12:00:13Z',
    memFreeMB:10,memTotalMB:100,disks:[{name:'D:',freeGB:15,sizeGB:100}],capacity:{freeDiskGB:15},
    vms:[{id:'p',name:'Planned',state:'Running'},{id:'u',name:'Unexpected',state:'Running'},{id:'idle',name:'Idle',state:'Off'}] };
  const record = overrides => recordMonitoring(host, { ...sample, ...overrides });
  const rules = () => activeAlerts().filter(a=>a.host===host).map(a=>a.rule).sort();
  record({});
  assert.deepEqual(rules(),[]);
  put('expectedStop',host+'/p',{finishedAt:Date.parse(sample.sampledAt)-1});
  const stopped = sample.vms.map(v=>({...v,state:'Off'}));
  const trouble = {memFreeMB:9,disks:[{name:'D:',freeGB:14,sizeGB:100}],vms:stopped};
  record(trouble); record(trouble);
  assert.deepEqual(rules(),['disk','memory','vm-stop']);
  assert.equal(activeAlerts().find(a=>a.rule==='vm-stop').resource,'u');
  // A later redundant Off request must not clear an open unexpected-stop alert.
  put('expectedStop',host+'/u',{finishedAt:Date.parse(sample.sampledAt)-1});
  record(trouble);
  assert.deepEqual(rules(),['disk','memory','vm-stop']);
  record({fresh:false,status:'unreachable',vms:[]});
  assert.deepEqual(rules(),['disk','memory','unreachable','vm-stop']);
  record({memFreeMB:null,disks:[{name:'D:',freeGB:null,sizeGB:100}],vms:stopped});
  assert.deepEqual(rules(),['disk','memory','vm-stop']);
  record({});
  assert.deepEqual(rules(),[]);
  assert.equal(db.prepare('SELECT count(*) AS n FROM alerts WHERE host=? AND resolved IS NOT NULL').get(host).n,4);
  // Starting again consumes a previous intentional shutdown.
  record({vms:stopped});
  assert.deepEqual(rules(),['vm-stop','vm-stop']);
});

test('Slack transitions queue once, honor retry delays and deliver recovery after the opening', async () => {
  process.env.HVDASH_SLACK_WEBHOOK = 'https://hooks.slack.com/services/test/fixture/unused';
  const host = 'delivery', at = new Date().toISOString();
  const offline = {fresh:false,status:'unreachable',sampledAt:at};
  recordMonitoring(host,offline); recordMonitoring(host,offline);
  recordMonitoring(host,{...offline,status:'degraded'});
  assert.equal(db.prepare('SELECT count(*) AS n FROM alert_delivery').get().n,2);
  const posted = [];
  const sender = async (url,options) => {
    assert.equal(url.hostname,'hooks.slack.com');
    assert.equal(options.redirect,'error');
    posted.push(JSON.parse(options.body).text);
    return {ok:posted.length!==1};
  };
  const now = Date.now();
  await deliverAlerts(sender,now); await deliverAlerts(sender,now+1000);
  assert.equal(posted.length,1);
  await deliverAlerts(sender,now+30000); await deliverAlerts(sender,now+30000);
  assert.match(posted[1],/opened/); assert.match(posted[2],/resolved/);
  await deliverAlerts(sender,now+60000);
  assert.equal(posted.length,3);
  delete process.env.HVDASH_SLACK_WEBHOOK;
});
