import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createSecureContext } from 'node:tls';
import { join } from 'node:path';

const [mode, directory] = process.argv.slice(2);
if (!['check', 'restore'].includes(mode) || !directory) throw new Error('Expected check|restore DIRECTORY');
createSecureContext({
  cert: readFileSync(join(directory, 'tls', 'cert.pem')),
  key: readFileSync(join(directory, 'tls', 'key.pem'))
});
const db = new DatabaseSync(join(directory, 'fleet.sqlite'), { readOnly: mode === 'check' });
try {
  if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('SQLite integrity check failed');
  if (db.prepare('PRAGMA foreign_key_check').get()) throw new Error('SQLite foreign key check failed');
  for (const table of ['users','sessions','kv','audit','jobs','ip_ledger','metrics']) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) throw new Error('Missing table ' + table);
  }
  if (!db.prepare("SELECT 1 FROM users WHERE role='admin' LIMIT 1").get()) throw new Error('Snapshot has no administrator account');
  if (mode === 'restore') {
    const at = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    db.exec('DELETE FROM sessions');
    db.prepare("UPDATE jobs SET status='interrupted', ended=? WHERE status='running'").run(at);
    db.prepare("INSERT INTO audit(at,actor,action,target,outcome) VALUES(?,'local-cli','restore','management database','ok')").run(at);
    db.exec('COMMIT');
  }
} finally { db.close(); }
