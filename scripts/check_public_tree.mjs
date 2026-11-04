// Check tracked paths, without reading any ignored business data.
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
const paths=execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
const forbidden=/^(?:data|outputs|exports|work|envs|logs|\.browser-profiles|\.codex|\.agents|node_modules|\.venv)\/|\.private\.|\.(?:xlsx|pdf|sqlite3?|db)$/i;
const violations=paths.filter(p=>forbidden.test(p) || /^\.env(?:\.|$)/.test(p) && p!=='.env.example');
for(const path of paths.filter(p=>/\.(?:md|py|mjs|js|json|ya?ml|html|toml|txt)$/.test(p))){
  const text=readFileSync(path,'utf8');
  if(/[A-Z]:[\\/]Users[\\/][^\s/\\]+/i.test(text))violations.push(path+' (personal machine path)');
}
if(violations.length){process.stderr.write(violations.join('\n')+'\n');process.exitCode=1;}
else process.stdout.write(`Checked ${paths.length} tracked paths; no forbidden private-data paths.\n`);
