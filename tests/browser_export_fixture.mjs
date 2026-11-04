import {storeProof,browserBinding} from './store_binding_fixture.mjs';
const keys={inquiries:'__LEW_INQUIRY_LIST_CONFIG__',inquiries_member_bundle:'__LEW_INQUIRY_EXPORT_CONFIG__',customer_link:'__LEW_CUSTOMER_LINK_CONFIG__',member_order_candidates:'__LEW_ORDER_EXPORT_CONFIG__',visitors:'__LEW_VISITOR_EXPORT_CONFIG__'};
export function prepareExportContext(context,kind){
  context.window??={};
  const key=keys[kind],existing=context.window[key]||{},store=existing.store||existing.storeKey||'demobeta',route=browserBinding(store);
  context.window[key]={store,storeKey:store,confirmedSellerDomain:store+'.en.alibaba.com',from:'2026-09-22',to:'2026-09-23',inquiryId:'123',
    ...existing,browserBinding:route,requestId:'synthetic-export',storeProof:storeProof(store,'synthetic-export',route)};
  return context;
}
