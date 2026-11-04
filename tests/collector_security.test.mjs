import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BrowserSession,validateCollectorConfig,assertReadDescriptor} from '../scripts/alibaba_readonly/browser-session.mjs';
import {sanitizeData} from '../scripts/alibaba_readonly/collect.mjs';
import {buildSubjectListRequest} from '../scripts/alibaba_readonly/inquiry-protocol.mjs';
import {main,parseArgs} from '../scripts/collect_readonly_chains.mjs';
import {syntheticCollectorSession} from '../examples/collector_session.mjs';
const config={store:'example-seller',cdp:'http://127.0.0.1:9222/',expectedHost:'example-seller.en.alibaba.com',companyId:'1',adminAliId:'2'};
const args=['--config','data/config.json','--out','data/new/run','--from','2026-01-05','--to','2026-01-05','--enrich-limit','0'];
function fixture(t){const root=mkdtempSync(join(tmpdir(),'public-collector-'));t.after(()=>rmSync(root,{recursive:true,force:true}));mkdirSync(join(root,'data'));writeFileSync(join(root,'data/config.json'),JSON.stringify(config));return root;}

test('config cannot select arbitrary modules or remote/authenticated CDP endpoints',()=>{
  assert.equal(validateCollectorConfig(config).store,'example-seller');
  for(const patch of [{playwrightModule:'arbitrary.js'},{playwright:{}},{token:'synthetic'},
    {cdp:'http://remote.invalid:9222/'},{cdp:'http://user:synthetic@127.0.0.1:9222/'},{cdp:'http://127.0.0.1:9222/?token=synthetic'},
    {companyId:1e25},{expectedHost:'another.en.alibaba.com'}])assert.throws(()=>validateCollectorConfig({...config,...patch}));
  assert.throws(()=>parseArgs([...args,'--module','arbitrary.js']));
});

test('read endpoint guard rejects unknown queries, nested actions and GET bodies',()=>{
  const request=buildSubjectListRequest({page:1,pageSize:3,startTime:1,endTime:2},{ctoken:'synthetic',csrfToken:'synthetic'});
  assert.doesNotThrow(()=>assertReadDescriptor(request));
  for(const key of ['action','method','operation','unknown'])assert.throws(()=>assertReadDescriptor({...request,url:request.url+'&'+key+'=delete'}),/query_field/);
  const form=new URLSearchParams(request.body),params=JSON.parse(form.get('params'));params.search.action='send';form.set('params',JSON.stringify(params));
  assert.throws(()=>assertReadDescriptor({...request,body:form.toString()}),/query_field/);
  assert.throws(()=>assertReadDescriptor({url:'https://i.alibaba.com/ajax/sellerProfileAjax.do',method:'GET',body:'action=delete'}),/get_body/);
});

test('persistence strips credential fields, header values, userinfo and encoded secrets',()=>{
  const data=sanitizeData({secret:'drop-me',password:'drop-me',sessionId:'drop-me',sessionKey:'drop-me',cookieHeader:'drop-me','Set-Cookie':'drop-me',headers:{Authorization:'drop-me'},buyerCookieId:'business-cookie',
    text:'prefix Authorization: Bearer drop-me',bearer:'Bearer drop-me',url:'https://user:drop-me@example.invalid/?session=drop-me&password=drop-me',encoded:encodeURIComponent('https://example.invalid/?secret=drop-me')});
  assert(!JSON.stringify(data).includes('drop-me'));assert.equal(data.buyerCookieId,'business-cookie');
});

test('an already-open page does not bypass the origin allowlist',async()=>{
  const session=new BrowserSession(config);session.context={pages:()=>[{url:()=> 'https://unrelated.invalid/'}]};
  await assert.rejects(()=>session.pageFor('https://unrelated.invalid'),/origin_not_allowed/);
});

test('CDP cleanup closes only owned pages and disconnects after identity failure',async()=>{
  let ownedClosed=0,userClosed=0,disconnected=0;
  const user={url:()=> 'https://example.invalid/',close:async()=>{userClosed++;}};
  const owned={goto:async()=>{},close:async()=>{ownedClosed++;},evaluate:async()=>({companyId:'1',adminAliId:'WRONG',minisite:'https://example-seller.en.alibaba.com/'})};
  const browser={contexts:()=>[{pages:()=>[user],newPage:async()=>owned}],close:async()=>{disconnected++;}};
  const session=new BrowserSession(config,{chromium:{connectOverCDP:async()=>browser}});
  await assert.rejects(()=>session.connect(),/store_identity_mismatch/);
  assert.equal(ownedClosed,1);assert.equal(userClosed,0);assert.equal(disconnected,1);
  await session.close();assert.equal(disconnected,1);
});

test('CLI rejects existing output before connecting and preserves its evidence',async t=>{
  const root=fixture(t);mkdirSync(join(root,'data/new/run'),{recursive:true});writeFileSync(join(root,'data/new/run/keep.txt'),'frozen');let connected=false;
  await assert.rejects(()=>main(args,{root,sessionFactory:()=>{connected=true;}}),/output_already_exists/);
  assert.equal(connected,false);assert.equal(readFileSync(join(root,'data/new/run/keep.txt'),'utf8'),'frozen');
});

test('a symlinked output parent cannot create outside directories or open a connection',async t=>{
  const root=fixture(t),outside=mkdtempSync(join(tmpdir(),'collector-outside-'));t.after(()=>rmSync(outside,{recursive:true,force:true}));
  symlinkSync(outside,join(root,'data/new'),'junction');let connected=false;
  await assert.rejects(()=>main(args,{root,sessionFactory:()=>{connected=true;}}),/symlink|escapes/);
  assert.equal(connected,false);assert.equal(existsSync(join(outside,'run')),false);
});

test('offline CLI uses the same collection path and saves an importable private member bundle',async t=>{
  const root=fixture(t);let output='';
  const summary=await main(args,{root,sessionFactory:syntheticCollectorSession,stdout:{write:s=>{output+=s;}}});
  assert.equal(summary.synthetic,true);assert.equal(summary.chains.inquiries.rows,1);
  const bundle=JSON.parse(readFileSync(join(root,'data/new/run/inquiry-member-bundle.json'),'utf8'));
  assert.equal(bundle.store_key,'example-seller');assert.equal(bundle.inquiries.length,1);assert(!output.includes('ephemeral'));
});

test('help does not load browser dependencies or access a config',async()=>{
  let text='';await main(['--help'],{sessionFactory:()=>{throw Error('must_not_connect');},stdout:{write:s=>{text+=s;}}});assert.match(text,/Default chain: inquiries/);
});
