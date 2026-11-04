/** 阿里访客及广告报表的只读请求描述；不包含任何网络调用或凭据读取。 */
export const endpoints = Object.freeze({
  visitors: 'https://mydata.alibaba.com/self/.json?action=CommonAction&iName=getVisitors&isVip=true&',
  visitorDetails: 'https://hz-mydata.alibaba.com/self/.json?action=CommonAction&iName=getVisitorDetails',
  adsScene: 'https://www2.alibaba.com/api/data/dynamic/scene/data',
});

const formHeaders = Object.freeze({ 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' });

/** 固定字段由实测或调用方显式提供；未解析的原模板默认值不擅自补成空串。 */
export function buildVisitorListRequest({ pageNO = 1, pageSize = 15, startDate, endDate, desTime, cacheBust, verifiedStaticFields = {} }) {
  const fields = {
    ...verifiedStaticFields,
    pageNO: String(pageNO), pageSize: String(pageSize), startDate, endDate,
    statisticType: 'os', desTime: String(desTime),
  };
  const body = formBody(fields);
  return {
    url: endpoints.visitors + String(cacheBust), method: 'POST', headers: { ...formHeaders }, body,
    credentials: 'include', timeoutMs: 20000,
  };
}

/** 原请求明确的字段名来自 observed request handler；未解析模板字段交调用方。 */
export function buildVisitorDetailRequest({ pageNO = 1, pageSize = 15, statDate, buyerCookieId, orderBy, orderModel, verifiedStaticFields = {} }) {
  return {
    url: endpoints.visitorDetails, method: 'POST', headers: { ...formHeaders },
    body: formBody({ ...verifiedStaticFields, statDate, buyerCookieId, pageNO, pageSize, orderBy, orderModel }),
    credentials: 'include', timeoutMs: 20000,
  };
}

function formBody(fields) {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    // qs.stringify 对 undefined 省略，null 输出为空值；采用相同语义。
    if (value === undefined) continue;
    form.set(key, value === null ? '' : String(value));
  }
  return form.toString();
}

/** 响应 value/total 均已由原指令 inline 字面量恢复，不再使用猜测外壳。 */
export function decodeVisitorListResponse(payload) {
  if (!payload?.successed) {
    const error = new Error('访客列表接口未返回 successed');
    error.code = 'ALI_VISITOR_RESPONSE_ERROR'; throw error;
  }
  const responseValue = payload.value;
  const rawTotal = responseValue?.total;
  if (!responseValue || rawTotal === undefined || rawTotal === null) throw new Error('访客列表 value.total 缺失');
  // Number 成员名称尚未恢复；安全整数约束是独立程序的边界条件。
  if (!(Number.isSafeInteger(rawTotal) || typeof rawTotal === 'string' && /^\d+$/.test(rawTotal.trim()))) throw new Error('访客 total 格式异常');
  const total = Number(rawTotal);
  if (!Number.isSafeInteger(total) || total < 0) throw new Error('访客 total 范围异常');
  const rows = responseValue.data;
  if (total === 0 && rows == null) return { responseValue: { ...responseValue, data: [] }, total };
  if (!Array.isArray(rows)) throw new Error('访客 value.data 不是数组');
  return { responseValue, total };
}

/** 明细只返回原始已确认外壳，字段校验由真实捕获后进一步核验。 */
export function decodeVisitorDetailResponse(payload) {
  if (!payload?.successed) throw new Error('访客明细接口未返回 successed');
  if (!Object.hasOwn(payload, 'value')) throw new Error('访客明细 value 缺失');
  return payload.value;
}

/** 来源：静态 getSceneData 字节码 + 已有 whole-site-ads 的只读请求实现。 */
export function buildAdsSceneRequest({ data, productLineId = 110106, csrfToken, type = 'normal' }) {
  if (!csrfToken) throw new Error('广告报表需要运行时 CSRF 值');
  return {
    url: endpoints.adsScene, method: 'POST', headers: { ...formHeaders },
    body: new URLSearchParams({ ads: JSON.stringify({ productLineId }), type, data: JSON.stringify(data), _csrf: csrfToken }).toString(),
    credentials: 'include', timeoutMs: 20000,
  };
}

/** 可用现场 scene defaults 合并；保留原代码两次 campaignId 筛选及订单排除。 */
export function buildCampaignOpportunityQuery({ campaignId, page = 1, pageSize = 20, beginDateTime, endDateTime, sceneDefaults = {}, contextDefaults = {} }) {
  const id = Number(campaignId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('campaignId 需要正整数');
  const context = {
    campaignType: 47, subType: 'whole_store_hot_product',
    productLineId: 110106, optimize_target: 'whole_site_fb', optimizeTarget: 'whole_site_fb',
    ...contextDefaults, campaignId: id,
  };
  return {
    // 现场 scene-base 默认条件与非空响应共同验证：遗漏二者会成功但返回空行。
    subSceneName: 'list', granularity: 'all', ...sceneDefaults, sceneName: 'scene_whole_site_conv_detail_bp5',
    rawFilters: [
      { field: 'campaignId', value: id },
      { field: 'fbTypeExcludeOrder', value: 'pay_order' },
      { field: 'campaignId', value: id },
    ],
    orders: sceneDefaults.orders ?? [], derives: sceneDefaults.derives ?? [],
    pageIndex: page, pageSize, beginDateTime, endDateTime,
    extendParams: { ...sceneDefaults.extendParams, context },
  };
}

/** 已有报表协议与原状态1000分支相符；行身份及新客属性不在此推断。 */
export function decodeAdsSceneResponse(payload) {
  if (payload?.status !== 1000) throw new Error('广告报表业务状态不是 1000');
  return payload.data;
}

/** 真实报表行保留原 main 包装，继续供 r03 的访客线索联接使用。 */
export function decodeCampaignOpportunityResponse(payload) {
  const data = decodeAdsSceneResponse(payload);
  if (!data || !Array.isArray(data.detailList)) throw new Error('广告商机 data.detailList 不是数组');
  if (!Number.isSafeInteger(data.totalRows) || data.totalRows < 0) throw new Error('广告商机 totalRows 范围异常');
  for (const row of data.detailList) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('广告商机行格式异常');
  }
  return { rows: data.detailList, total: data.totalRows };
}

/** 展示 / 本地快照投影：仅剥一层 main；保留 isRepeat 等标志的原始字符串与对象。 */
export function projectCampaignOpportunityRow(row) {
  return Object.fromEntries(Object.entries(row).map(([field, value]) => [
    field,
    value && typeof value === 'object' && Object.hasOwn(value, 'main') ? value.main : value,
  ]));
}
