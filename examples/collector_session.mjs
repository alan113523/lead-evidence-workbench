// Invented platform responses for offline orchestration tests and demos only.
export function syntheticCollectorSession(config){
  const audit=[];
  return {config,audit,synthetic:true,identity:{minisite:'https://'+config.expectedHost,companyId:config.companyId,adminAliId:config.adminAliId},
    async connect(){return this;},async close(){},async verifyIdentity(){return this.identity;},
    async hints(){return {ctoken:'synthetic-ephemeral-token',csrfToken:'synthetic-ephemeral-csrf'};},
    async request(spec){
      const url=new URL(spec.url);audit.push({host:url.hostname,path:url.pathname,method:spec.method||'GET',transport:'synthetic',httpStatus:200});
      const form=new URLSearchParams(spec.body||'');
      if(url.pathname==='/self/.json'&&url.searchParams.get('iName')==='getVisitors')return {successed:true,value:{total:1,data:[{visitorId:'synthetic-visitor',buyerCookieId:'synthetic-business-id',statDate:form.get('startDate')} ]}};
      if(url.pathname.endsWith('/subjectList.htm')){
        const params=JSON.parse(form.get('params'));
        return {code:200,data:{pagination:{totalCount:1,pageSize:3},list:[[{id:201,tradeId:201,secTradeId:'synthetic-sec-trade',createTime:params.search.startTime+3600000,ownerName:'Demo Owner',subject:'Synthetic inquiry',feedbackType:0,process:'NEW'}]]}};
      }
      if(url.pathname.endsWith('/subjectListExtraInfo.htm'))return {code:200,data:{list:{'201':{sender:{userNewLevel:'L1'},isRepeat:false,isLowQuality:false}}}};
      if(url.pathname==='/api/csrf')return {parameterName:'_csrf',token:'synthetic-ephemeral-csrf'};
      if(/^\/api\/campaign\/\d+$/.test(url.pathname))return {status:1000,data:{id:Number(url.pathname.split('/').at(-1)),type:47,productLineId:110106,subType:'whole_store_hot_product',properties:{optimizeTarget:'whole_site_fb'}}};
      if(url.pathname==='/api/data/dynamic/scene/data'){
        const query=JSON.parse(form.get('data'));
        if(!query.subSceneName)return {status:1000,data:{extendConfigs:{referSubScenes:[{name:'list',defaultQueryCondition:{granularity:'all'}}]}}};
        return {status:1000,data:{totalRows:1,detailList:[{fbId:{main:'301'},fbType:{main:'inquiry'},buyerCountry:{main:'US'}}]}};
      }
      throw Error('synthetic_endpoint_not_implemented');
    }};
}
