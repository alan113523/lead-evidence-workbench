import {createHash} from 'node:crypto';
import {buildVisitorListRequest,buildVisitorDetailRequest,decodeVisitorListResponse,decodeVisitorDetailResponse,buildCampaignOpportunityQuery,decodeCampaignOpportunityResponse,projectCampaignOpportunityRow} from './wire.mjs';
import {createInquiryReadClient,decodeInquiryPage,decodeExtraInfo} from './inquiry-protocol.mjs';
import {inquiryExtraPair,enrichInquiryCustomer} from './inquiry-enrichment.mjs';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const check=(condition,code)=>{if(!condition)throw Error(code);};
export function validateOptions(options){
  check(typeof options.store==='string'&&/^[a-z][a-z0-9-]{0,62}$/.test(options.store),'invalid_store');
  for(const day of [options.from,options.to]){const date=new Date(day+'T00:00:00Z');check(/^\d{4}-\d{2}-\d{2}$/.test(day||'')&&Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===day,'invalid_date');}
  check(options.from<=options.to&&(Date.parse(options.to)-Date.parse(options.from))/86400000<31,'invalid_date_range');
  for(const [key,max]of [['pageSize',100],['maxPages',10],['detailPages',10],['enrichLimit',20]])check(Number.isInteger(options[key])&&options[key]>=(key==='enrichLimit'?0:1)&&options[key]<=max,'invalid_'+key);
  check(Array.isArray(options.chains)&&options.chains.length>0&&new Set(options.chains).size===options.chains.length&&options.chains.every(x=>['visitors','opportunities','inquiries'].includes(x)),'invalid_chains');
  if(options.chains.includes('opportunities'))check(/^\d+$/.test(String(options.campaignId||''))&&Number(options.campaignId)>0,'campaign_id_required');
  return options;
}

/** Only business payloads reach disk. HTML, cookies, CSRF and token-bearing URLs do not. */
export function sanitizeData(value){
  if(Array.isArray(value))return value.map(sanitizeData);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>key==='buyerCookieId'||!/token|csrf|authorization|secret|pass.?word|session|credentials|headers?$|cookie|^(?:raw)?html$/i.test(key)).map(([key,v])=>[key,sanitizeData(v)]));
  if(typeof value==='string'){
    if(/<(?:!doctype|html|head|body|script)\b|window\.KHTAccessToken|csrfTokenVal\s*:/i.test(value))return '[HTML omitted]';
    let text=value;
    // URLs may carry one or more percent-encoding layers; decode only for the
    // redaction check, leaving ordinary business strings unchanged.
    let decoded=value;
    for(let round=0;round<3;round++){
      try{decoded=decodeURIComponent(decoded);}catch{break;}
      if(decoded===text)break;
      if(/(?:token|csrf|pass.?word|secret|session|auth|signature|cookie)[^=&\s]{0,30}=/i.test(decoded))text=decoded;
    }
    if(/\bbearer\s+\S+|\b(?:authorization|set-cookie|cookie|pass.?word|secret|session)\s*:/i.test(text))return '[sensitive transport omitted]';
    return text.replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/ig,'https://[redacted]@')
      .replace(/((?:[A-Za-z0-9_-]*(?:token|csrf|pass.?word|secret|session|auth|signature|cookie)[A-Za-z0-9_-]*|sign)=)[^&#\s"'<>]*/ig,'$1[redacted]');
  }
  return value;
}

function uniqueRows(rows,key,seen,kind='row'){
  for(const row of rows){const raw=key(row);check(raw!==null&&raw!==undefined&&raw!=='',kind+'_missing_identity');const id=String(raw);check(!seen.has(id),kind+'_missing_or_overlapping_identity');seen.add(id);}
}
function addCtoken(descriptor,hints){
  const url=new URL(descriptor.url);if(hints.ctoken)url.searchParams.set('ctoken',hints.ctoken);url.searchParams.set('_bx-v','1.1.21');return {...descriptor,url:url.href};
}
function contextFor(c){
  const p=c.properties||{},get=(o,k)=>Object.hasOwn(o||{},k)?o[k]:false;
  return {campaignId:c.id,campaignType:c.type,subType:c.subType,productLineId:c.productLineId,optimize_target:p.optimizeTarget,optimizeTarget:p.optimizeTarget,
    setL3Premium:get(p.bidConfig,'extraTargetTagFlag'),setCountryPremium:get(p,'regionPremiumUsedFlag'),setHighIntent:get(p,'setHighIntent'),
    setNewL3Premium:!!p.premiumTagsStatus?.firstOpenTime?.buyer_level_l3_plus,setNewL2Premium:!!p.premiumTagsStatus?.firstOpenTime?.buyer_level_l2_plus,
    setNewCountryPremium:!!p.premiumTagsStatus?.firstOpenTime?.region,setNewHighIntent:!!p.premiumTagsStatus?.firstOpenTime?.buyer_intent_high,
    currentCountryPremium:get(p.bidConfig,'targetTagsDiscountFlag'),showNobidL3Metric:false,showNobidL1Metric:false};
}
export function inquiryBundle(rows,enrichments,options,observedAt){
  const start=Date.parse(options.from+'T00:00:00+08:00'),end=Date.parse(options.to+'T00:00:00+08:00')+86400000;
  const inquiries=rows.map(row=>{
    const created=Number(row.createTime);check(Number.isFinite(created)&&created>=start&&created<end,'inquiry_out_of_range');
    return {store_key:options.store,inquiry_id:String(row.id),customer_id:null,created_at:new Date(created).toISOString(),first_sent_at:null,owner:row.ownerName||null,source:row.subject||null,
      inquiry_type:row.feedbackType==null?null:String(row.feedbackType),business_type:row.appFrom||null,follow_up_status:row.process||null,
      product_id:row.productInfo?.[0]?.productId==null?null:String(row.productInfo[0].productId),observed_at:observedAt,source_system:'alibaba-message-subjectList-v1'};
  });
  const buyer_member_links=enrichments.filter(item=>/^[a-z0-9]{3,64}$/i.test(item.result.patch.customerId||'')).map(item=>({
    store_key:options.store,inquiry_id:item.inquiry_id,buyer_member_id:'alibaba-visible-member:'+item.result.patch.customerId,observed_at:observedAt,source_system:'alibaba-message-querySummary-contact-loginId-v1'
  }));
  return {store_key:options.store,observed_at:observedAt,from_day:options.from,to_day_inclusive:options.to,coverage_status:'sample_only',inquiries,buyer_member_links};
}

/** Bounded sample collector; uses current authenticated browser, independent of any desktop-software installation. */
export async function collectReadOnly(session,options){
  validateOptions(options);
  check(session.config.expectedHost===options.store+'.en.alibaba.com','config_store_mismatch');
  await session.verifyIdentity();
  const observedAt=new Date().toISOString();
  const output={schema:'alibaba_readonly_chains_v1',store_key:options.store,observed_at:observedAt,from_day:options.from,to_day_inclusive:options.to,identity:session.identity,chains:{}};
  if(options.chains.includes('visitors')){
    const hints=await session.hints('https://i.alibaba.com'),rows=[],daily=[];
    for(let instant=Date.parse(options.from);instant<=Date.parse(options.to);instant+=86400000){
      const day=new Date(instant).toISOString().slice(0,10),dayRows=[],seen=new Set();let total=null;
      for(let page=1;page<=options.maxPages;page++){
        const descriptor=buildVisitorListRequest({pageNO:page,pageSize:options.pageSize,startDate:day,endDate:day,desTime:Date.now(),cacheBust:Date.now(),verifiedStaticFields:{orderBy:'',orderModel:'',statisticsType:'day',selected:'0',searchKeyword:'',buyerRegion:'',buyerCountry:'',subMemberSeq:'',isMcFb:'true',isAtmFb:'false',mailable:'false',mailed:'false',hasRemarks:'false'}});
        const result=decodeVisitorListResponse(await session.request(addCtoken(descriptor,hints)));
        check(total===null||total===result.total,'visitor_total_changed');total=result.total;
        const pageRows=result.responseValue.data;check(pageRows.every(row=>!row.statDate||row.statDate===day),'visitor_date_mismatch');
        uniqueRows(pageRows,row=>row.visitorId,seen,'visitor');dayRows.push(...pageRows.map(row=>({...row,statDate:day})));
        check(dayRows.length<=total,'visitor_row_count_exceeds_total');if(dayRows.length===total||!pageRows.length)break;
      }
      daily.push({day,total,rows:dayRows.length,coverage_status:dayRows.length===total?'complete':'sample_only'});rows.push(...dayRows);
    }
    const details=[];
    for(const row of rows.slice(0,options.enrichLimit)){
      check(typeof row.buyerCookieId==='string'&&typeof row.statDate==='string','visitor_detail_link_missing');
      const events=[];let detailTotal=null;
      for(let page=1;page<=options.detailPages;page++){
        const descriptor=buildVisitorDetailRequest({pageNO:page,pageSize:options.pageSize,statDate:row.statDate,buyerCookieId:row.buyerCookieId,orderBy:'',orderModel:'',verifiedStaticFields:{statisticsType:'day',selected:'0'}});
        const result=decodeVisitorDetailResponse(await session.request(addCtoken(descriptor,hints)));
        check(Array.isArray(result?.data)&&Number.isSafeInteger(result.total)&&result.total>=0&&result.pageNO===page,'invalid_visitor_detail_page');
        check(detailTotal===null||detailTotal===result.total,'visitor_detail_total_changed');detailTotal=result.total;
        // The real API can return distinct occurrences with identical fields.
        // There is no event ID; retain all occurrences instead of inventing one.
        events.push(...result.data);
        check(events.length<=detailTotal,'visitor_detail_overlap');if(events.length===detailTotal||!result.data.length)break;
      }
      details.push({visitorId:row.visitorId,statDate:row.statDate,total:detailTotal,events,event_identity:'not_provided; identical occurrences retained',coverage_status:events.length===detailTotal?'complete':'sample_only'});
    }
    output.chains.visitors={rows,details,daily,platform_total:daily.reduce((sum,day)=>sum+day.total,0),total_semantics:'sum of daily visitor records, not period unique people',coverage_status:daily.every(day=>day.coverage_status==='complete')?'complete':'sample_only',filter_scope:'isMcFb=true (inquiry-associated visitors)'};
  }
  if(options.chains.includes('opportunities')){
    const ready=await session.request({url:'https://www2.alibaba.com/api/csrf?type=normal&ads=%7B%22productLineId%22%3A110101%7D&data=%7B%7D',method:'GET'});
    check(ready?.parameterName==='_csrf'&&typeof ready.token==='string'&&ready.token.length>0,'invalid_ads_preparation');
    async function post(path,data){
      return session.request({url:'https://www2.alibaba.com'+path,method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8'},body:new URLSearchParams({ads:JSON.stringify({productLineId:110106}),type:'normal',data:JSON.stringify(data),_csrf:ready.token}).toString()});
    }
    const meta=await post('/api/campaign/'+options.campaignId,{}),c=meta.data;
    check(meta.status===1000&&String(c?.id)===String(options.campaignId)&&c.type===47&&c.productLineId===110106&&c.properties?.optimizeTarget==='whole_site_fb','campaign_metadata_mismatch');
    const context=contextFor(c),base=await post('/api/data/dynamic/scene/data',{sceneName:'scene_whole_site_conv_detail_bp5',extendParams:{context}});
    const sub=base.data?.extendConfigs?.referSubScenes?.find(x=>x.name==='list');
    check(base.status===1000&&sub?.defaultQueryCondition?.granularity==='all','unsupported_ads_scene_configuration');
    const rows=[],seen=new Set();let total=null;
    for(let page=1;page<=options.maxPages;page++){
      const query=buildCampaignOpportunityQuery({campaignId:c.id,page,pageSize:options.pageSize,beginDateTime:options.from+' 00:00:00',endDateTime:options.to+' 23:59:59',contextDefaults:context,sceneDefaults:{subSceneName:sub.name,granularity:sub.defaultQueryCondition.granularity}});
      const result=decodeCampaignOpportunityResponse(await post('/api/data/dynamic/scene/data',query));
      check(total===null||total===result.total,'ads_total_changed');total=result.total;
      uniqueRows(result.rows,row=>hash(row),seen,'opportunity');rows.push(...result.rows);
      check(rows.length<=total,'ads_row_count_exceeds_total');if(rows.length===total||!result.rows.length)break;
    }
    output.chains.opportunities={campaign_id:String(c.id),rows,projected_rows:rows.map(projectCampaignOpportunityRow),platform_total:total,coverage_status:rows.length===total?'complete':'sample_only',new_customer_status:'not_inferred'};
  }
  if(options.chains.includes('inquiries')){
    const hints=await session.hints(),client=createInquiryReadClient({request:descriptor=>session.request(descriptor),sessionProvider:async()=>hints});
    const rows=[],seen=new Set();let total=null;
    for(let page=1;page<=options.maxPages;page++){
      const result=decodeInquiryPage(await client.getInquiryData({pageNO:page,pageSize:options.pageSize,startTime:Date.parse(options.from+'T00:00:00+08:00'),endTime:Date.parse(options.to+'T00:00:00+08:00')+86400000}));
      total=result.totalCount;uniqueRows(result.rows,row=>row.id,seen,'inquiry');rows.push(...result.rows);
      if(!result.rows.length)break;
    }
    const pairs=rows.map(inquiryExtraPair).filter(Boolean);let extra={};
    for(let offset=0;offset<pairs.length;offset+=20){const group=pairs.slice(offset,offset+20);Object.assign(extra,decodeExtraInfo(await client.getInquiryExtraInfo({secTradeIds:group.map(x=>x.secTradeId),tradeIds:group.map(x=>x.tradeId)})));}
    const enrichments=[];
    for(const row of rows.slice(0,options.enrichLimit))enrichments.push({inquiry_id:String(row.id),result:await enrichInquiryCustomer({client,row})});
    output.chains.inquiries={rows,extra,enrichments,platform_total_declared:total,coverage_status:'sample_only',total_semantics:total===99999?'sentinel_or_capped_unverified':'platform_declared_only'};
    output.inquiry_bundle=inquiryBundle(rows,enrichments,options,observedAt);
  }
  await session.verifyIdentity();output.audit=session.audit;
  return sanitizeData(output);
}
