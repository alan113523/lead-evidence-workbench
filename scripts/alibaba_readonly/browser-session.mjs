import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);

const READ_ENDPOINTS=new Set([
 'i.alibaba.com/ajax/sellerProfileAjax.do',
 'message.alibaba.com/message/default.htm',
 'message.alibaba.com/message/ajax/feedback/subjectList.htm',
 'message.alibaba.com/message/ajax/feedback/subjectListExtraInfo.htm',
 'message.alibaba.com/message/ajax/feedback/querySummary.htm',
 'message.alibaba.com/message/maDetail.htm',
 'alicrm.alibaba.com/jsonp/customerPluginQueryServiceI/queryCustomerTag.json',
 'alicrm.alibaba.com/jsonp/customerPluginQueryServiceI/queryCustomerInfo.json',
 'alicrm.alibaba.com/eggCrmQn/crm/orderQueryServiceI/queryCountOrders.json',
 'www2.alibaba.com/api/data/dynamic/scene/data',
 'www2.alibaba.com/api/campaign/type/allList',
 'www2.alibaba.com/api/csrf',
 'mydata.alibaba.com/self/.json',
 'hz-mydata.alibaba.com/self/.json',
]);
const ENTRY={
 'https://i.alibaba.com':'https://i.alibaba.com/',
 'https://message.alibaba.com':'https://message.alibaba.com/message/default.htm',
 'https://hz-mydata.alibaba.com':'https://hz-mydata.alibaba.com/',
 'https://mydata.alibaba.com':'https://mydata.alibaba.com/',
 'https://www2.alibaba.com':'https://www2.alibaba.com/ads/wide/campaignManage.htm',
 'https://alicrm.alibaba.com':'https://alicrm.alibaba.com/',
};
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const onlyKeys=(value,keys)=>plain(value)&&Object.keys(value).every(key=>keys.includes(key));
const json=value=>{try{return JSON.parse(value);}catch{throw Error('invalid_read_json');}};
export function validateCollectorConfig(config){
 if(!onlyKeys(config,['store','cdp','expectedHost','companyId','adminAliId'])||Object.keys(config).length!==5)throw Error('invalid_collector_config_fields');
 if(typeof config.store!=='string'||!/^[a-z][a-z0-9-]{0,62}$/.test(config.store)||config.expectedHost!==config.store+'.en.alibaba.com')throw Error('config_identity_required');
 for(const key of ['companyId','adminAliId'])if(!/^\d{1,30}$/.test(String(config[key]))||typeof config[key]==='number'&&!Number.isSafeInteger(config[key]))throw Error('config_identity_required');
 const endpoint=new URL(config.cdp);
 if(endpoint.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname)||endpoint.username||endpoint['pass'+'word']||endpoint.search||endpoint.hash||endpoint.pathname!=='/')throw Error('only_unauthenticated_loopback_cdp_allowed');
 return Object.freeze({...config});
}
export function assertReadDescriptor(request){
 const url=new URL(request.url);
 if(url.username||url.password||url.port||url.hash)throw Error('nonstandard_read_url');
 const campaignMetadata=url.hostname==='www2.alibaba.com'&&/^\/api\/campaign\/\d+$/.test(url.pathname);
 if(url.protocol!=='https:'||(!READ_ENDPOINTS.has(url.hostname+url.pathname)&&!campaignMetadata))throw Error('endpoint_not_in_read_allowlist');
 if(!['GET','POST'].includes(request.method||'GET'))throw Error('method_not_allowed');
 if([...url.searchParams.keys()].some(key=>url.searchParams.getAll(key).length!==1))throw Error('duplicate_query_key');
 const method=request.method||'GET';
 if(method==='GET'&&request.body!==undefined)throw Error('get_body_not_allowed');
 const queryKeys=url.pathname==='/self/.json'?['action','iName','isVip','ctoken','_bx-v']:
  url.pathname.includes('/ajax/feedback/')?['ctoken','dmtrack_pageid','_tb_token_']:
  url.pathname==='/message/maDetail.htm'?['imInquiryId']:
  url.pathname.includes('/customerPluginQueryServiceI/')?['buyerAccountId','secTradeId','secReqToken','_tb_token_']:
  url.pathname.includes('/orderQueryServiceI/')?['customerId','_tb_token_','__t__']:
  url.pathname==='/api/csrf'?['type','ads','data']:[];
 for(const key of url.searchParams.keys())if(!queryKeys.includes(key)&&!(url.pathname==='/self/.json'&&/^\d{1,16}$/.test(key)&&url.searchParams.get(key)===''))throw Error('query_field_not_allowed');
 const postOnly=campaignMetadata||url.pathname.includes('/ajax/feedback/')||url.pathname==='/self/.json'||url.pathname==='/api/campaign/type/allList'||url.pathname==='/api/data/dynamic/scene/data';
 if(method!==(postOnly?'POST':'GET'))throw Error('endpoint_method_mismatch');
 for(const [key,value]of Object.entries(request.headers||{})){
  if(!['accept','content-type'].includes(key.toLowerCase()))throw Error('header_not_allowed');
  if(key.toLowerCase()==='content-type'&&!/^application\/x-www-form-urlencoded(?:;.*)?$/i.test(value))throw Error('content_type_not_allowed');
 }
 const body=new URLSearchParams(request.body||'');
 if([...body.keys()].some(key=>body.getAll(key).length!==1))throw Error('duplicate_form_key');
 if([...body.keys()].some(key=>/method|action|iname/i.test(key)))throw Error('body_operation_not_allowed');
 if(url.pathname==='/self/.json'&&(!['getVisitors','getVisitorDetails'].includes(url.searchParams.get('iName'))||url.searchParams.get('action')!=='CommonAction'))throw Error('data_advisor_action_not_allowed');
 if(url.pathname==='/self/.json'){
  const list=url.searchParams.get('iName')==='getVisitors';
  if(url.hostname!==(list?'mydata.alibaba.com':'hz-mydata.alibaba.com'))throw Error('data_advisor_host_mismatch');
  const allowed=new Set((list?'orderBy orderModel statisticsType selected searchKeyword buyerRegion buyerCountry subMemberSeq isMcFb isAtmFb mailable mailed hasRemarks statisticType desTime pageNO pageSize startDate endDate':'orderBy orderModel statisticsType selected pageNO pageSize statDate buyerCookieId').split(' '));
  if([...body.keys()].some(key=>!allowed.has(key)))throw Error('visitor_form_field_not_allowed');
  if(url.searchParams.has('isVip')&&url.searchParams.get('isVip')!=='true')throw Error('visitor_query_value_not_allowed');
 }
 if(url.pathname==='/api/csrf'&&(url.searchParams.get('type')!=='normal'||JSON.stringify(json(url.searchParams.get('ads')))!==JSON.stringify({productLineId:110101})||JSON.stringify(json(url.searchParams.get('data')))!=='{}'))throw Error('invalid_ads_preparation_query');
 if(url.hostname==='www2.alibaba.com'&&method==='POST'){
  if([...body.keys()].some(key=>!['ads','type','data','_csrf'].includes(key)))throw Error('ads_form_field_not_allowed');
  let ads,data;try{ads=JSON.parse(body.get('ads'));data=JSON.parse(body.get('data'));}catch{throw Error('invalid_ads_form');}
  if(ads?.productLineId!==110106||body.get('type')!=='normal')throw Error('invalid_ads_scope');
  if(url.pathname.endsWith('/scene/data')&&data?.sceneName!=='scene_whole_site_conv_detail_bp5')throw Error('ads_scene_not_allowed');
  if(url.pathname.endsWith('/scene/data')&&!onlyKeys(data,['sceneName','subSceneName','granularity','rawFilters','orders','derives','pageIndex','pageSize','beginDateTime','endDateTime','extendParams']))throw Error('ads_query_field_not_allowed');
  if(url.pathname.endsWith('/scene/data')){
   const fields=['campaignId','campaignType','subType','productLineId','optimize_target','optimizeTarget','setL3Premium','setCountryPremium','setHighIntent','setNewL3Premium','setNewL2Premium','setNewCountryPremium','setNewHighIntent','currentCountryPremium','showNobidL3Metric','showNobidL1Metric'];
   if(!onlyKeys(data.extendParams,['context'])||!onlyKeys(data.extendParams.context,fields))throw Error('ads_context_field_not_allowed');
   if(data.rawFilters&&(!Array.isArray(data.rawFilters)||!data.rawFilters.every(item=>onlyKeys(item,['field','value'])&&['campaignId','fbTypeExcludeOrder'].includes(item.field))))throw Error('ads_filter_not_allowed');
  }
  if(campaignMetadata&&Object.keys(data||{}).length)throw Error('campaign_metadata_body_not_empty');
  if(url.pathname.endsWith('/allList')&&(data?.paging!==false||JSON.stringify(data.typeList)!=='[47]'||Object.keys(data).length!==2))throw Error('campaign_list_scope_not_allowed');
 }
 if(url.pathname.includes('/ajax/feedback/')){
  if([...body.keys()].some(key=>!['_csrf_token_','postId','params'].includes(key)))throw Error('message_form_field_not_allowed');
  let params;try{params=JSON.parse(body.get('params'));}catch{throw Error('invalid_message_params');}
  if(url.pathname.endsWith('/subjectList.htm')&&!(params?.system==='feedback'&&params?.listType==='all'&&Number.isFinite(params.search?.startTime)&&Number.isFinite(params.search?.endTime)&&params.search.startTime<params.search.endTime))throw Error('unbounded_inquiry_read');
  if(url.pathname.endsWith('/subjectList.htm')&&(!onlyKeys(params,['system','listType','isAdvanceSearch','filter','pagination','order','search'])||!onlyKeys(params.search,['startTime','endTime','requestNo','senderName'])||!onlyKeys(params.filter,['process','isShowAtm','queryType'])||!onlyKeys(params.pagination,['nextPage','pageSize'])||!onlyKeys(params.order,['order','orderBy'])))throw Error('inquiry_query_field_not_allowed');
  if(url.pathname.endsWith('/subjectListExtraInfo.htm')&&(!onlyKeys(params,['secTradeIds','tradeIds'])||!Array.isArray(params.tradeIds)||!Array.isArray(params.secTradeIds)||params.tradeIds.length<1||params.tradeIds.length>20||params.tradeIds.length!==params.secTradeIds.length))throw Error('invalid_extra_read');
  if(url.pathname.endsWith('/querySummary.htm')&&(!onlyKeys(params,['secTradeId'])||typeof params.secTradeId!=='string'||!params.secTradeId))throw Error('invalid_summary_read');
 }
 return url;
}
export class BrowserSession{
 constructor(config,{chromium}={}){this.config=config;this.chromium=chromium;this.ownedPages=[];this.audit=[];}
 async connect(){
  this.config=validateCollectorConfig(this.config);
  const endpoint=new URL(this.config.cdp);
  process.env.NO_PROXY=[process.env.NO_PROXY,'127.0.0.1','localhost','[::1]'].filter(Boolean).join(',');
  let chromium=this.chromium;
  if(!chromium){try{chromium=require('../../.deps/node_modules/playwright-core').chromium;}catch{throw Error('playwright_core_missing_see_docs_collectors');}}
  try{
   this.browser=await chromium.connectOverCDP(endpoint.href,{noDefaults:true,timeout:15000});
   this.context=this.browser.contexts()[0];
   if(!this.context)throw Error('browser_context_missing');
   await this.verifyIdentity();return this;
  }catch(error){await this.close();throw error;}
 }
 async pageFor(origin){
  if(!ENTRY[origin])throw Error('origin_not_allowed');
  let page=this.context.pages().find(p=>{try{return new URL(p.url()).origin===origin}catch{return false}});
  if(!page){
   page=await this.context.newPage();this.ownedPages.push(page);
   await page.goto(ENTRY[origin],{waitUntil:'domcontentloaded',timeout:30000});
  }
  return page;
 }
 async verifyIdentity(){
  const page=await this.pageFor('https://i.alibaba.com');
  const identity=await page.evaluate(async()=>{
   const r=await fetch('/ajax/sellerProfileAjax.do',{credentials:'include',redirect:'error',signal:AbortSignal.timeout(15000)});
   if(!r.ok)throw Error('identity_http_'+r.status);
   const d=await r.json();return {companyId:String(d.companyId),adminAliId:String(d.adminAliId),minisite:d.minisite};
  });
  const site=new URL(identity.minisite.startsWith('//')?'https:'+identity.minisite:identity.minisite);
  if(!['http:','https:'].includes(site.protocol)||site.username||site['pass'+'word']||site.port||site.hostname!==this.config.expectedHost||identity.companyId!==String(this.config.companyId)||identity.adminAliId!==String(this.config.adminAliId))throw Error('store_identity_mismatch');
  this.identity=identity;return identity;
 }
 async hints(origin='https://message.alibaba.com'){
  const page=await this.pageFor(origin);
  // Only the required values leave browser memory, remain in this local
  // process, and are never written to disk or logs.
  return page.evaluate(()=>{
   const cookie=document.cookie;
   const html=document.documentElement.outerHTML;
   const ctoken=cookie.match(/(?:^|[;&])ctoken=([\w-]+)/i)?.[1]||cookie.match(/(?:%3F|%26)ctoken%3D([\w-]+)/i)?.[1]||'';
   const csrfToken=html.match(/csrfTokenVal:\s*['"]([^'"]+)/)?.[1]||'';
   const exparams=html.match(/setAttribute\(\s*["']exparams["']\s*,\s*["']([^"']*)["']/i)?.[1];
   const dmtrackPageId=exparams?new URLSearchParams(exparams.replaceAll('&amp;','&')).get('pageid')||'':'';
   const value=name=>cookie.split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='))?.slice(name.length+1)||'';
   return {ctoken,csrfToken,dmtrackPageId,tbToken:value('_tb_token_'),xsrfToken:value('XSRF-TOKEN')};
  });
 }
 async request(request){
  const spec={url:String(request.url),method:request.method||'GET',headers:{...request.headers},...(request.body===undefined?{}:{body:String(request.body)})};
  const url=assertReadDescriptor(spec);
  await this.verifyIdentity();
  let result;
  const directApi=url.pathname==='/eggCrmQn/crm/orderQueryServiceI/queryCountOrders.json';
  if(directApi){
   // The original main-process endpoint is a direct HTTP read. Use the
   // existing browser context's shared session without a page-origin fetch.
   let response;
   try{
    response=await this.context.request.fetch(spec.url,{method:spec.method,headers:spec.headers,timeout:25000,maxRedirects:0,failOnStatusCode:false});
    result={status:response.status(),type:response.headers()['content-type']||'',text:await response.text()};
   }catch{throw Error('context_api_read_transport_failed');}
   finally{await response?.dispose();}
  }else{
   const page=await this.pageFor(url.origin);
   try{result=await page.evaluate(async spec=>{
    const r=await fetch(spec.url,{method:spec.method||'GET',headers:spec.headers,body:spec.body,credentials:'include',redirect:'error',signal:AbortSignal.timeout(25000)});
    const text=await r.text();
    return {status:r.status,type:r.headers.get('content-type')||'',text};
   },spec);}catch{throw Error('browser_read_transport_failed');}
  }
  this.audit.push({host:url.hostname,path:url.pathname,method:spec.method,transport:directApi?'browser-context-request':'browser-fetch',httpStatus:result.status,bytes:Buffer.byteLength(result.text)});
  await this.verifyIdentity();
  if(result.status<200||result.status>=300)throw Error('read_http_'+result.status);
  if(result.type.includes('json'))return json(result.text);
  try{return JSON.parse(result.text)}catch{return result.text;}
 }
 async close(){
  for(const page of this.ownedPages)await page.close().catch(()=>{});
  this.ownedPages=[];
  const browser=this.browser;this.browser=null;
  if(browser)await browser.close(); // CDP attachment: disconnect, preserving the existing browser.
 }
}
