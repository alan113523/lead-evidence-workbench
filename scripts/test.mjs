import {readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const python=process.env.PYTHON_EXECUTABLE || (process.platform==='win32'?'python':'python3');
const mode=process.argv[2] || 'all';
if(!['all','node','python','formal'].includes(mode))throw Error('Choose node, python or formal');
const env={...process.env,PYTHON_EXECUTABLE:python,PYTHONUTF8:'1'};
function run(command,args){
  const result=spawnSync(command,args,{stdio:'inherit',env,windowsHide:true});
  if(result.error)throw result.error;
  if(result.status!==0)process.exit(result.status || 1);
}
if(['all','node'].includes(mode))run(process.execPath,['--test',...readdirSync('tests').filter(p=>p.endsWith('.test.mjs')).map(p=>'tests/'+p)]);
if(['all','python'].includes(mode))run(python,['-X','utf8','-B','-m','unittest','discover','-s','tests','-p','test_*.py']);
if(['all','formal'].includes(mode))run(python,['-X','utf8','-B','-m','unittest','discover','-s','formal-review/tests','-p','test_*.py']);
