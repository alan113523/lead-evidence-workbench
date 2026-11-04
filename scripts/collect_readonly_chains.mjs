import {readFileSync,mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {BrowserSession,validateCollectorConfig} from './alibaba_readonly/browser-session.mjs';
import {collectReadOnly,validateOptions} from './alibaba_readonly/collect.mjs';
import {dataPath} from './chat_collection.mjs';

const ROOT=resolve(fileURLToPath(new URL('..',import.meta.url)));
const HELP=`Read-only Alibaba collection (your own verified browser/account).

node scripts/collect_readonly_chains.mjs --config data/collector.json --out data/new-run
  --from YYYY-MM-DD --to YYYY-MM-DD [--chains inquiries,visitors,opportunities]
  [--campaign-id ID] [--page-size 3] [--max-pages 1] [--detail-pages 2] [--enrich-limit 1]

Default chain: inquiries. Advertising opportunities require an explicit campaign ID.
Config and new output must be inside ignored data/. See docs/collectors.md.
`;
export function parseArgs(argv){
  if(argv.length===1&&['--help','-h'].includes(argv[0]))return {help:true};
  const args={},allowed=new Set(['config','out','from','to','chains','campaign-id','page-size','max-pages','detail-pages','enrich-limit']);
  for(let i=0;i<argv.length;i+=2){
    const key=argv[i]?.slice(2);
    if(!argv[i]?.startsWith('--')||!allowed.has(key)||!argv[i+1]||Object.hasOwn(args,key))throw Error('expected_unique_known_option_value_pairs');
    args[key]=argv[i+1];
  }
  if(!args.config||!args.out)throw Error('config_and_out_required_see_docs_collectors');
  return args;
}
export async function main(argv,{root=ROOT,sessionFactory=config=>new BrowserSession(config),stdout=process.stdout}={}){
  const args=parseArgs(argv);
  if(args.help){stdout.write(HELP);return;}
  const config=validateCollectorConfig(JSON.parse(readFileSync(dataPath(args.config,root),'utf8')));
  const options=validateOptions({store:config.store,from:args.from,to:args.to,chains:(args.chains||'inquiries').split(','),campaignId:args['campaign-id'],
    pageSize:Number(args['page-size']??3),maxPages:Number(args['max-pages']??1),detailPages:Number(args['detail-pages']??2),enrichLimit:Number(args['enrich-limit']??1)});
  const out=dataPath(args.out,root);
  if(existsSync(out))throw Error('output_already_exists');
  mkdirSync(dirname(dataPath(args.out,root)),{recursive:true,mode:0o700});
  const session=sessionFactory(config);
  try{
    await session.connect();
    const result=await collectReadOnly(session,options);
    if(session.synthetic===true)result.synthetic=true;
    mkdirSync(dataPath(args.out,root),{mode:0o700});
    const save=(name,value)=>writeFileSync(resolve(out,name),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
    save('collection.json',result);
    if(result.inquiry_bundle)save('inquiry-member-bundle.json',result.inquiry_bundle);
    const summary={read_completed:true,...(result.synthetic?{synthetic:true}:{}),store:options.store,chains:Object.fromEntries(Object.entries(result.chains).map(([name,value])=>[name,{rows:value.rows.length,coverage_status:value.coverage_status,platform_total:value.platform_total??value.platform_total_declared}])),requests:result.audit.length};
    save('receipt.json',summary);stdout.write(JSON.stringify(summary,null,2)+'\n');return summary;
  }finally{await session.close();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  main(process.argv.slice(2)).catch(error=>{const code=/^[a-z][a-z0-9_]{0,90}$/.test(error?.message||'')?error.message:'collection_failed_no_credentials_logged';process.stderr.write(code+'\n');process.exitCode=1;});
}
