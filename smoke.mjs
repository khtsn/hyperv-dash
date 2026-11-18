// Compatibility command: test isolated HTTPS state and fake hosts.
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const result=spawnSync(process.execPath,['--test','tests/fleet-e2e.test.mjs'],{cwd:fileURLToPath(new URL('.',import.meta.url)),stdio:'inherit',windowsHide:true});
process.exitCode=result.status??1;
