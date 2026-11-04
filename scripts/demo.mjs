// Entirely invented leads and messages. No browser, account or network calls.
import {mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const python=process.env.PYTHON_EXECUTABLE || (process.platform==='win32'?'python':'python3');
const name=process.argv[2] || `demo-${new Date().toISOString().replace(/[:.]/g,'-')}`;
if(!/^[a-zA-Z0-9_-]+$/.test(name))throw Error('Demo name must be a simple directory name');
const out=resolve('data',name);
if(existsSync(out))throw Error('Use a new demo name; prior outputs are preserved');
mkdirSync(out,{recursive:true});
const save=(file,value)=>writeFileSync(join(out,file),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const cutoff='2026-01-15T00:00:00+08:00',names=['Example Retail','Example Projects','Example Studio','Example Distribution','Example Test Buyer','Example Duplicate'];
const messages=[],rows=[],evidence=[],inquiries=[];
for(let i=0;i<6;i++){
  const id=String(101+i),store=i%2?'demobeta':'demoalpha',at=Date.parse('2026-01-05T09:00:00+08:00')+i*86400000;
  const created=new Date(at).toISOString(),key=`${store}|conversation-${id}`;
  const request=['We need a sample of the example product.','Please confirm the sample lead time.','Could you share the specification?','We distribute example products locally.','Thanks, please send a catalogue.','This is a duplicate synthetic inquiry.'][i];
  const conversation=[['buyer',0,request],['seller',30,'SYNTHETIC: the sample specification is ready for review.']];
  if(i<2)conversation.push(['buyer',90,'SYNTHETIC: please confirm the sample delivery date.']);
  const refs=[];
  for(const [direction,minutes,text] of conversation){
    const mid=`${key}|${refs.length+1}`,message={message_id:String(refs.length+1),direction,text,content_status:'read',send_time_ms:at+minutes*60000,reply_source:'unknown',automation_flags:{auto_reply:false,robot_message:false}};
    messages.push({key:mid,store_key:store,inquiry_keys:[`${store}|${id}`],variants:[{message}]});
    refs.push({message_key:mid,role:'current_inquiry_window'});
  }
  const eid=`E${id}`;
  evidence.push({id:eid,row_key:`R${id}`,store_key:store,inquiry_id:id,use:'产品',source_type:'synthetic_buyer_statement',observed_at:created,locator:`synthetic:${id}:1`,description:'SYNTHETIC example: '+request});
  rows.push({row_key:`R${id}`,store_key:store,inquiry_id:id,created_at:created,buyer_name:names[i],country:i%2?'GB':'US',buyer_level:'L1',product:'Example product',owner:i%2?'Demo B':'Demo A',excluded:i===5,exclusion_reason:i===5?'Synthetic duplicate retained separately':null,
    quality:i<2?'好':i===4?'差':'中',quality_reason:'SYNTHETIC: assessed against the invented conversation.',next_action:'SYNTHETIC draft: confirm sample specifications and delivery date.',deep_communication:i<2?'Y':i===4?'未核实':'N',deep_stage:i<2?'样品沟通':'需求确认',deep_reason:'SYNTHETIC training example; no real buyer assessment.',
    deal_status:'未核实',payment_verified:false,formal_due_diligence_complete:false,business_model:'证据不足：synthetic demo',purchase_purpose:'证据不足：synthetic demo',chat_snapshot_at:cutoff,chat_origin:'synthetic',chat_status:'synthetic_complete',
    diligence:{status:'合成演示',platform_status:'synthetic only',entity_status:'未核实',public_status:'未执行公开检索',formal_v3_status:'未执行正式背调',gaps:['All names, messages and assessments are invented.']},
    reviewed_message_binding:{store_key:store,inquiry_id:id,messages_file:{path:`data/${name}/messages.jsonl`},messages:refs}});
  inquiries.push({store_key:store,inquiry_id:id,created_at:created,owner:i%2?'Demo B':'Demo A',observed_at:cutoff,source_system:'synthetic-demo-v1'});
}
const raw=messages.map(m=>JSON.stringify(m)).join('\n')+'\n';
writeFileSync(join(out,'messages.jsonl'),raw,{flag:'wx'});
for(const row of rows)row.reviewed_message_binding.messages_file.sha256=createHash('sha256').update(raw).digest('hex');
save('final-data.json',{synthetic:true,schema_version:'lew.final-operational-data.v1',population_total:rows.length,analysis_before_exclusive:cutoff,rows,evidence});
writeFileSync(join(out,'inquiries.jsonl'),inquiries.map(r=>JSON.stringify(r)).join('\n')+'\n',{flag:'wx'});
writeFileSync(join(out,'inquiries-demoalpha.jsonl'),inquiries.filter(r=>r.store_key==='demoalpha').map(r=>JSON.stringify(r)).join('\n')+'\n',{flag:'wx'});
function py(script,args){const r=spawnSync(python,['-X','utf8','-B','scripts/'+script,...args],{stdio:'inherit',windowsHide:true});if(r.error)throw r.error;if(r.status!==0)process.exit(r.status||1);}
py('followup_metrics.py',['--input',join(out,'final-data.json'),'--messages',join(out,'messages.jsonl'),'--out',join(out,'metrics.json')]);
py('build_dashboard.py',['--input',join(out,'final-data.json'),'--metrics',join(out,'metrics.json'),'--messages',join(out,'messages.jsonl'),'--out',join(out,'dashboard.html'),'--period','Synthetic demo · Jan 2026']);
py('build_followup_workbook.py',['--input',join(out,'final-data.json'),'--metrics',join(out,'metrics.json'),'--out',join(out,'follow-up.xlsx'),'--from','2026-01-01T00:00:00+08:00','--to',cutoff]);
process.stdout.write(`\nSynthetic demo written to ${out}\nOpen dashboard.html locally. All runtime files remain Git-ignored.\n`);
