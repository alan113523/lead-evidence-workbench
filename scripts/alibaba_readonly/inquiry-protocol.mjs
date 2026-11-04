/** Standalone Node read-only request descriptors and inert parsers; no app/JSC/MCP dependency. */
const ORIGIN='https://message.alibaba.com';
export const ENDPOINTS=Object.freeze({
  list:`${ORIGIN}/message/ajax/feedback/subjectList.htm`,
  extra:`${ORIGIN}/message/ajax/feedback/subjectListExtraInfo.htm`,
  summary:`${ORIGIN}/message/ajax/feedback/querySummary.htm`,
  maDetail:`${ORIGIN}/message/maDetail.htm`,
  customerTag:'https://alicrm.alibaba.com/jsonp/customerPluginQueryServiceI/queryCustomerTag.json',
  customerInfo:'https://alicrm.alibaba.com/jsonp/customerPluginQueryServiceI/queryCustomerInfo.json',
  orders:'https://alicrm.alibaba.com/eggCrmQn/crm/orderQueryServiceI/queryCountOrders.json',
});

export class ProtocolError extends Error {
  constructor(code){super(code);this.code=code;}
}
const requireThat=(condition,code)=>{if(!condition)throw new ProtocolError(code);};
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const valueString=value=>value==null?'':String(value);

/** Exact recovered regex patterns; no evaluation of HTML or embedded JavaScript. */
export function extractKhtAccessToken(html){
  if(typeof html!=='string')return '';
  return html.match(/window\.KHTAccessToken\s*=\s*['"]([^'"]+)['"]/)?.[1]||'';
}
export function extractCtoken(cookieText){
  if(typeof cookieText!=='string')return '';
  return cookieText.match(/(?:^|[;&])ctoken=([\w-]+)/i)?.[1]||cookieText.match(/(?:%3F|%26)ctoken%3D([\w-]+)/i)?.[1]||'';
}
export function extractDmtrackPageId(html){
  if(typeof html!=='string')return '';
  const exparams=html.match(/setAttribute\(\s*["']exparams["']\s*,\s*["']([^"']*)["']/i)?.[1];
  if(!exparams)return '';
  return new URLSearchParams(exparams.replaceAll('&amp;','&')).get('pageid')||'';
}
/** Existing independently used local collector reads this page assignment. */
export function extractCsrfToken(html){
  if(typeof html!=='string')return '';
  return html.match(/csrfTokenVal:\s*['"]([^'"]+)/)?.[1]||'';
}
export function extractSessionHints({cookieText='',html=''}){
  return {ctoken:extractCtoken(cookieText),csrfToken:extractCsrfToken(html),dmtrackPageId:extractDmtrackPageId(html)};
}
export function describeHints(hints){
  return {ctoken_present:!!hints.ctoken,csrf_present:!!hints.csrfToken,dmtrack_pageid_present:!!hints.dmtrackPageId};
}

export function buildInquiryParams({page=1,pageSize=100,startTime,endTime,process='',senderName='',requestNo}={}){
  requireThat(Number.isInteger(page)&&page>=1,'invalid_page');
  requireThat(Number.isInteger(pageSize)&&pageSize>=1&&pageSize<=100,'invalid_page_size');
  const search={};
  if(startTime!==undefined||endTime!==undefined){
    requireThat(Number.isFinite(startTime)&&Number.isFinite(endTime)&&startTime<endTime,'invalid_time_range');
    search.startTime=startTime;search.endTime=endTime;
  }
  if(requestNo!==undefined){requireThat(typeof requestNo==='string'&&/^\d+$/.test(requestNo),'invalid_request_no');search.requestNo=requestNo;}
  const sender=typeof senderName==='string'?senderName.trim():'';
  if(sender)search.senderName=sender;
  requireThat(Object.keys(search).length>0,'bounded_search_required');
  return {system:'feedback',listType:'all',isAdvanceSearch:'true',
    filter:{process:typeof process==='string'?process:'',isShowAtm:false,queryType:'recentlyYear'},
    pagination:{nextPage:page,pageSize},order:{order:'desc',orderBy:'latest_contact_time'},search};
}

function queryForSession(url,session,{includeTbToken=false}={}){
  requireThat(session&&typeof session.ctoken==='string'&&session.ctoken.length>0,'ctoken_missing');
  const result=new URL(url);result.searchParams.set('ctoken',session.ctoken);
  if(session.dmtrackPageId)result.searchParams.set('dmtrack_pageid',session.dmtrackPageId);
  if(includeTbToken&&session.tbToken)result.searchParams.set('_tb_token_',session.tbToken);
  return result.href;
}
function messagePost(url,params,session,{includePostId=true,includeTbToken=false}={}){
  requireThat(session&&typeof session.csrfToken==='string'&&session.csrfToken.length>0,'csrf_missing');
  const form=new URLSearchParams({_csrf_token_:session.csrfToken});
  if(includePostId)form.set('postId',valueString(session.postId??Date.now()));
  form.set('params',JSON.stringify(params));
  return {url:queryForSession(url,session,{includeTbToken}),method:'POST',
    headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded; charset=UTF-8'},body:form.toString(),sensitive:true};
}
export function buildSubjectListRequest(options,session){return messagePost(ENDPOINTS.list,buildInquiryParams(options),session);}
export function buildExtraInfoRequest({secTradeIds,tradeIds},session){
  requireThat(Array.isArray(secTradeIds)&&Array.isArray(tradeIds)&&secTradeIds.length===tradeIds.length&&tradeIds.length>0&&tradeIds.length<=20,'invalid_extra_batch');
  requireThat(secTradeIds.every(id=>typeof id==='string'&&id.length>0),'invalid_sec_trade_ids');
  requireThat(tradeIds.every(id=>id!==null&&id!==undefined),'invalid_trade_ids');
  return messagePost(ENDPOINTS.extra,{secTradeIds,tradeIds},session);
}
export function buildSummaryRequest({secTradeId},session){
  requireThat(typeof secTradeId==='string'&&secTradeId.length>0,'sec_trade_id_missing');
  return messagePost(ENDPOINTS.summary,{secTradeId},session,{includePostId:false,includeTbToken:true});
}
export function buildMaDetailRequest({imInquiryId},session){
  requireThat(imInquiryId!==null&&imInquiryId!==undefined&&/^\d+$/.test(String(imInquiryId)),'invalid_inquiry_id');
  const url=new URL(ENDPOINTS.maDetail);url.searchParams.set('imInquiryId',String(imInquiryId));
  // The matched application only sends this read URL and session cookie header.
  // Transport owns browser cookies; they are not exposed by this descriptor.
  return {url:url.href,method:'GET',headers:{Accept:'text/html'},sensitive:true};
}
export function buildCustomerRequest(kind,{buyerAccountId,secTradeId,secReqToken},session){
  requireThat(kind==='customerTag'||kind==='customerInfo','unsupported_customer_read');
  requireThat([buyerAccountId,secTradeId,secReqToken].every(x=>typeof x==='string'&&x.length>0),'customer_link_fields_missing');
  const url=new URL(ENDPOINTS[kind]);
  for(const [name,value]of Object.entries({buyerAccountId,secTradeId,secReqToken}))url.searchParams.set(name,value);
  if(session?.tbToken)url.searchParams.set('_tb_token_',session.tbToken);
  return {url:url.href,method:'GET',headers:{Accept:'application/json'},sensitive:true};
}
export function buildOrderCountRequest({customerId},session){
  requireThat(typeof customerId==='string'&&customerId.length>0,'customer_id_missing');
  const url=new URL(ENDPOINTS.orders);url.searchParams.set('customerId',customerId);
  if(session?.tbToken)url.searchParams.set('_tb_token_',session.tbToken);
  url.searchParams.set('__t__',valueString(session?.postId??Date.now()));
  return {url:url.href,method:'GET',headers:{Accept:'application/json'},sensitive:true};
}

function parsePayload(payload){
  if(typeof payload==='string'){
    try{payload=JSON.parse(payload);}catch{throw new ProtocolError('response_not_json');}
  }
  requireThat(record(payload),'response_not_object');
  requireThat(String(payload.code)==='200','platform_code_not_200');
  requireThat(record(payload.data),'response_data_missing');
  return payload;
}
export function decodeInquiryPage(payload){
  payload=parsePayload(payload);
  requireThat(Array.isArray(payload.data.list),'subject_list_missing');
  // observed request handler flattens one level, preserving every sibling record.
  const rows=payload.data.list.flat(1).filter(Boolean);
  requireThat(rows.every(record),'subject_row_shape_mismatch');
  const pagination=record(payload.data.pagination)?payload.data.pagination:{};
  return {rows,totalCount:Number(pagination.totalCount)||0,pageSize:Number(pagination.pageSize)||100};
}
export function decodeExtraInfo(payload){
  payload=parsePayload(payload);
  requireThat(record(payload.data.list),'extra_list_missing');
  return payload.data.list;
}
export function decodeSummary(payload){
  payload=parsePayload(payload);
  const contact=record(payload.data.contact)?payload.data.contact:{};
  // customerId is the name used by this application's order-count chain;
  // contact.loginId alone does not establish a CRM identity or account ownership.
  return {data:payload.data,contact,customerId:contact.loginId||'',buyerAccountId:contact.accountIdEncrypt||''};
}
export function decodeCustomerResponse(payload){
  if(typeof payload==='string'){try{payload=JSON.parse(payload);}catch{throw new ProtocolError('customer_response_not_json');}}
  requireThat(record(payload)&&payload.success===true,'customer_response_not_success');
  return payload;
}
/** This is the only logging-friendly representation of a request. Values never appear. */
export function describeRequest(request){
  const url=new URL(request.url);const form=request.body?new URLSearchParams(request.body):null;
  return {origin:url.origin,path:url.pathname,method:request.method,query_keys:[...url.searchParams.keys()].sort(),form_keys:form?[...form.keys()].sort():[],sensitive:true};
}

/**
 * request(descriptor) must return the JSON payload or HTML text only. The owning
 * browser/CDP transport handles current cookies, identity checks and HTTP status.
 * sessionProvider() returns session hints in memory; this module never persists them.
 */
export function createInquiryReadClient({request,sessionProvider}){
  requireThat(typeof request==='function'&&typeof sessionProvider==='function','client_dependencies_missing');
  async function send(build){return request(build(await sessionProvider()));}
  return Object.freeze({
    async getInquiryDmtrackPageId(){return (await sessionProvider()).dmtrackPageId||'';},
    getInquiryData({pageNO=1,pageSize=100,startTime,endTime,process='',senderName='',requestNo}){
      return send(session=>buildSubjectListRequest({page:pageNO,pageSize,startTime,endTime,process,senderName,requestNo},session));
    },
    getInquiryExtraInfo({secTradeIds,tradeIds}){return send(session=>buildExtraInfoRequest({secTradeIds,tradeIds},session));},
    querySummary({secTradeId}){return send(session=>buildSummaryRequest({secTradeId},session));},
    getMaDetailHtml({imInquiryId}){return send(session=>buildMaDetailRequest({imInquiryId},session));},
    queryCustomerTag(fields){return send(session=>buildCustomerRequest('customerTag',fields,session));},
    queryCustomerInfo(fields){return send(session=>buildCustomerRequest('customerInfo',fields,session));},
    queryCountOrders({customerId}){return send(session=>buildOrderCountRequest({customerId},session));},
  });
}
