import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {BrowserSession,assertReadDescriptor} from '../scripts/alibaba_readonly/browser-session.mjs';
import {validateOptions,sanitizeData,inquiryBundle,collectReadOnly} from '../scripts/alibaba_readonly/collect.mjs';
import {buildSubjectListRequest,decodeInquiryPage,extractKhtAccessToken} from '../scripts/alibaba_readonly/inquiry-protocol.mjs';
import {enrichInquiryCustomer} from '../scripts/alibaba_readonly/inquiry-enrichment.mjs';
import {decodeVisitorListResponse,decodeVisitorDetailResponse,decodeCampaignOpportunityResponse,projectCampaignOpportunityRow,buildCampaignOpportunityQuery} from '../scripts/alibaba_readonly/wire.mjs';
import {openStore,importMemberBundle} from '../scripts/inquiry_store.mjs';

const options={store:'demobeta',from:'2026-10-01',to:'2026-10-28',chains:['inquiries'],pageSize:3,maxPages:1,detailPages:2,enrichLimit:1};
const hints={ctoken:'synthetic-token',csrfToken:'synthetic-csrf'};
test('bounds require explicit dates, recognised store and bounded work',()=>{
  assert.deepEqual(validateOptions({...options}),options);
  for(const patch of [{from:'2026-10-32'},{store:'../other'},{maxPages:0},{pageSize:101},{to:'2026-12-01'},{chains:['write']},{chains:['opportunities']}])assert.throws(()=>validateOptions({...options,...patch}));
});
test('transport rejects writes, method overrides, duplicate operations and nonstandard URLs',()=>{
  const request=buildSubjectListRequest({page:1,pageSize:3,startTime:1,endTime:2},hints);
  assert.doesNotThrow(()=>assertReadDescriptor(request));
  for(const patch of [
    {url:'https://www2.alibaba.com/api/campaign/update'},
    {method:'DELETE'},{method:'GET'},{headers:{'X-HTTP-Method-Override':'DELETE'}},
    {url:request.url+'&ctoken=again'},{url:request.url.replace('https://','https://user:pass@')},
    {url:request.url.replace('.com/','.com:444/')},{body:request.body+'&action=delete'},
  ])assert.throws(()=>assertReadDescriptor({...request,...patch}));
  assert.throws(()=>assertReadDescriptor({url:'https://mydata.alibaba.com/self/.json?action=CommonAction&iName=getVisitors&iName=delete',method:'POST'}));
  assert.throws(()=>assertReadDescriptor({url:'https://mydata.alibaba.com/self/.json?action=CommonAction&iName=getVisitorDetails',method:'POST'}));
});
test('request snapshots descriptor before await and verifies identity before/after sending',async()=>{
  const request={url:'https://i.alibaba.com/ajax/sellerProfileAjax.do',method:'GET'};
  const calls=[],session=new BrowserSession({});
  session.verifyIdentity=async()=>{calls.push('identity');request.url='https://www2.alibaba.com/api/campaign/update';};
  session.pageFor=async()=>({evaluate:async(_,spec)=>{calls.push(spec.url);return {status:200,type:'application/json',text:'{}'};}});
  await session.request(request);
  assert.deepEqual(calls,['identity','https://i.alibaba.com/ajax/sellerProfileAjax.do','identity']);
});
test('identity failure prevents network read and is not swallowed by enrichment',async()=>{
  const session=new BrowserSession({});let sent=false;
  session.verifyIdentity=async()=>{throw Error('store_identity_mismatch');};session.pageFor=async()=>{sent=true;};
  await assert.rejects(session.request({url:'https://i.alibaba.com/ajax/sellerProfileAjax.do'}),/store_identity_mismatch/);assert.equal(sent,false);
  await assert.rejects(enrichInquiryCustomer({row:{tradeId:1,secTradeId:'synthetic'},client:{getMaDetailHtml:async()=>{throw Error('store_identity_mismatch');},querySummary:async()=>null}}),/store_identity_mismatch/);
});
test('order count uses existing session API without following redirects or logging query',async()=>{
  const session=new BrowserSession({});let disposed=false,verified=0;
  session.verifyIdentity=async()=>{verified++;};
  session.context={request:{fetch:async(url,options)=>{
    assert.equal(options.maxRedirects,0);assert.equal(options.method,'GET');
    return {status:()=>200,headers:()=>({'content-type':'application/json'}),text:async()=>'{"data":{}}',dispose:async()=>{disposed=true;}};
  }}};
  await session.request({url:'https://alicrm.alibaba.com/eggCrmQn/crm/orderQueryServiceI/queryCountOrders.json?customerId=synthetic',method:'GET'});
  assert.equal(disposed,true);assert.equal(verified,2);assert(!JSON.stringify(session.audit).includes('synthetic'));
});
test('persistence strips credentials, inert HTML and token URL values while retaining business cookie ID',()=>{
  const result=sanitizeData({csrf:'do-not-save',authorization:'do-not-save',tbToken:'do-not-save',xsrfToken:'do-not-save',_tb_token_:'do-not-save',token:'do-not-save',buyerCookieId:'business-id',nested:{KHTAccessToken:'do-not-save'},url:'https://example.invalid/?ctoken=do-not-save&secReqToken=do-not-save',encoded:'https%3A%2F%2Fexample.invalid%2F%3Fctoken%3Ddo-not-save%26XSRF-TOKEN%3Ddo-not-save',html:'<script>window.KHTAccessToken="do-not-save"</script>'});
  assert(!JSON.stringify(result).includes('do-not-save'));assert.equal(result.buyerCookieId,'business-id');
});
test('HTML parsing is inert and customer classification remains unknown',()=>{
  globalThis.readonlyParserExecuted=false;
  assert.equal(extractKhtAccessToken('<script>window.KHTAccessToken="synthetic"; globalThis.readonlyParserExecuted=true;</script>'),'synthetic');
  assert.equal(globalThis.readonlyParserExecuted,false);
  const row=projectCampaignOpportunityRow({isRepeat:{main:'false'},isL3Plus:{main:'true'}});
  assert.deepEqual(row,{isRepeat:'false',isL3Plus:'true'});assert(!Object.hasOwn(row,'newCustomer'));
});
test('visitor overlap is rejected instead of claiming completeness',async()=>{
  const payload={successed:true,value:{total:2,data:[{visitorId:'same'}]}};
  const session={config:{expectedHost:'demobeta.en.alibaba.com'},verifyIdentity:async()=>{},hints:async()=>hints,request:async()=>payload};
  await assert.rejects(collectReadOnly(session,{...options,chains:['visitors'],enrichLimit:0,maxPages:2}),/overlapping/);
});

const sampleDir=process.env.READONLY_SAMPLE_DIR;
test('real local samples replay all three chains and existing inquiry import', {skip:!sampleDir},async()=>{
  const read=name=>JSON.parse(readFileSync(resolve(sampleDir,name+'.json'),'utf8'));
  const payload=name=>read(name).payload;
  const visitor=decodeVisitorListResponse(payload('visitors-list'));
  assert.equal(visitor.responseValue.data.length,1);assert.equal(visitor.total,1);
  const detail=decodeVisitorDetailResponse(payload('visitor-detail'));assert.equal(detail.data.length,3);assert.equal(detail.total,5);
  const ads=decodeCampaignOpportunityResponse(payload('ads-opportunities'));assert.equal(ads.rows.length,3);assert.equal(ads.total,78);
  const query=payload('ads-query');
  assert.deepEqual(buildCampaignOpportunityQuery({campaignId:query.extendParams.context.campaignId,page:query.pageIndex,pageSize:query.pageSize,beginDateTime:query.beginDateTime,endDateTime:query.endDateTime,contextDefaults:query.extendParams.context}),query);
  const inquiries=decodeInquiryPage(payload('inquiry-list'));assert.equal(inquiries.rows.length,3);assert.equal(inquiries.totalCount,99999);
  const html=read('inquiry-html-carrier').html;
  const result=await enrichInquiryCustomer({row:inquiries.rows[0],client:{
    getMaDetailHtml:async()=>html,querySummary:async()=>payload('enrich-querySummary'),queryCustomerTag:async()=>payload('enrich-queryCustomerTag'),queryCustomerInfo:async()=>payload('enrich-queryCustomerInfo'),queryCountOrders:async()=>payload('enrich-queryCountOrders'),
  }});
  assert.equal(result.status,'success');assert.deepEqual(Object.values(result.steps),[true,true,true,true,true]);
  assert(!JSON.stringify(result).includes('LOCAL_REDACTED_TOKEN'));
  const bundle=inquiryBundle(inquiries.rows,[{inquiry_id:String(inquiries.rows[0].id),result}],options,new Date().toISOString());
  const db=openStore(':memory:');
  try{
    const imported=importMemberBundle(db,bundle,options.store);assert.equal(imported.coverage_status,'sample_only');
    assert.equal(db.prepare('SELECT count(*) AS n FROM inquiries_current').get().n,3);
    assert.equal(db.prepare('SELECT count(*) AS n FROM inquiry_buyer_member_links').get().n,1);
  }finally{db.close();}
  const state=read('inquiry-read-state');assert.equal(state.matched,true);assert.deepEqual(state.changedFields,[]);
});
