import {ProtocolError,decodeSummary,decodeCustomerResponse,extractKhtAccessToken} from './inquiry-protocol.mjs';

const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);

/** The live sample has all three IDs equal. Preserve the source's priority when they differ. */
export function inquiryExtraPair(row){
  const tradeId=row.tradeId??row.feedbackId??row.id;
  return row.secTradeId&&tradeId!==undefined&&tradeId!==null?{secTradeId:row.secTradeId,tradeId}:null;
}

/** observed request handler: known, literal field projections only. No guessed tag labels/date format. */
export function projectCustomerInfo(info){
  const crm=record(info.alicrmCustomerInfo)?info.alicrmCustomerInfo:{};
  const buyer=record(info.buyerInfo)?info.buyerInfo:{};
  const contact=record(buyer.buyerContactInfo)?buyer.buyerContactInfo:{};
  const behavior=record(buyer.buyerShopBehaviorInfo)?buyer.buyerShopBehaviorInfo:{};
  const patch={
    email:contact.email||crm.email||'',
    mobileNumber:contact.mobileNumber||crm.mobileNumber||'',
    phoneNumber:contact.phoneNumber||crm.phoneNumber||'',
    productId:String(behavior.productId??'').trim(),
    productLink:String(behavior.url??'').trim(),
    productImage:String(behavior.imageUrl??'').trim(),
    loginDays90:buyer.loginDays??null,
    productViewCount90:buyer.productViewCount??null,
    validInquiryCount90:buyer.validInquiryCount??null,
    repliedInquiryCount:buyer.repliedInquiryCount??null,
    validRfqCount90:buyer.validRfqCount??null,
    spamInquiryCount90:buyer.spamInquiryMarkedBySupplierCount??null,
    addedToBlacklistCount:buyer.addedToBlacklistCount??null,
    daysSinceLastPurchase:crm.taLastBuyPast??null,
  };
  if(buyer.companyName||crm.companyName)patch.companyName=buyer.companyName||crm.companyName;
  return {patch,orderCustomerId:crm.customerId||''};
}

/**
 * observed request handler: parallel HTML + summary, gated parallel tag + info, then order count.
 * The KHT token is used only as an in-memory request argument and never returned.
 * Ordinary step failures preserve other results. A caller's aborted signal propagates.
 * registerTime formatting and buyerTags' unknown label lookup remain explicit gaps.
 */
export async function enrichInquiryCustomer({client,row,signal}){
  const patch={},failedSteps=[],failureReasons=[];
  const check=()=>{if(signal?.aborted)throw new ProtocolError('inquiry_cancelled');};
  async function step(name,callback){
    check();
    try{const result=await callback();check();return result;}
    catch(error){
      check();
      if(error?.code==='INQUIRY_DETAIL_TASK_CANCELLED'||error?.code==='inquiry_cancelled'||/identity|store_.*mismatch/.test(error?.message||''))throw error;
      failedSteps.push(name);
      const candidate=error?.code||error?.message||'';
      failureReasons.push({step:name,code:/^[A-Za-z][A-Za-z0-9_]{0,90}$/.test(candidate)?candidate:'read_step_failed'});
      return null;
    }
  }
  const detailId=row.imInquiryId||row.tradeId;
  if(!detailId)failedSteps.push('imInquiryId');
  if(!row.secTradeId)failedSteps.push('secTradeId');
  const [html,summary]=await Promise.all([
    detailId?step('maDetail',()=>client.getMaDetailHtml({imInquiryId:detailId})):null,
    row.secTradeId?step('querySummary',async()=>decodeSummary(await client.querySummary({secTradeId:row.secTradeId}))):null,
  ]);
  if(summary?.customerId)patch.customerId=summary.customerId;
  const secReqToken=extractKhtAccessToken(html);
  const buyerAccountId=summary?.buyerAccountId||'';
  let tags=null,info=null,orders=null;
  if(secReqToken&&buyerAccountId&&row.secTradeId){
    const fields={secReqToken,buyerAccountId,secTradeId:row.secTradeId};
    [tags,info]=await Promise.all([
      step('queryCustomerTag',async()=>decodeCustomerResponse(await client.queryCustomerTag(fields))),
      step('queryCustomerInfo',async()=>decodeCustomerResponse(await client.queryCustomerInfo(fields))),
    ]);
  }else{
    if(html!==null&&!secReqToken)failedSteps.push('secReqToken');
    if(summary!==null&&!buyerAccountId)failedSteps.push('buyerAccountId');
  }
  // The exact feature normalizer and buyerTags' label table are partly unknown.
  // Keep the observed original tag shape under an explicitly raw field.
  if(tags?.data?.data?.buyerPortraitCnTag!==undefined)patch.buyerFeaturesRaw=tags.data.data.buyerPortraitCnTag;
  const customerInfo=record(info?.data?.data)?info.data.data:null;
  if(customerInfo){
    const projected=projectCustomerInfo(customerInfo);Object.assign(patch,projected.patch);
    if(projected.orderCustomerId){
      orders=await step('queryCountOrders',async()=>{
        const result=await client.queryCountOrders({customerId:projected.orderCustomerId});
        if(!record(result)||!record(result.data))throw new ProtocolError('order_response_shape_mismatch');
        return result;
      });
      if(orders){
        patch.tradeAssuranceOrderCount=orders.data.companyTotalCount??null;
        patch.tradeAssuranceTotalAmount=orders.data.companyTotalAmount??null;
      }
    }
  }
  check();
  const uniqueFailures=[...new Set(failedSteps)];
  return {patch,failedSteps:uniqueFailures,failureReasons,status:uniqueFailures.length?(Object.keys(patch).length?'partial':'failed'):'success',
    steps:{html:html!==null,summary:summary!==null,customerTags:tags!==null,customerInfo:info!==null,orders:orders!==null},
    unrecoveredFields:['buyerTags label table','registerTime format','buyerFeatures normalizer']};
}
