import {realpathSync,rmSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
export function removeFixture(directory,prefix){
 const absolute=realpathSync(directory),parent=realpathSync(tmpdir());
 if(path.dirname(absolute)!==parent || !path.basename(absolute).startsWith(prefix) || path.basename(absolute).length<=prefix.length)throw Error('Unexpected fixture path; refusing cleanup.');
 rmSync(absolute,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
