# 本地可选聊天证据

这是本项目的私有 sidecar。它不改变原 `nanyue.due-diligence-input.v3` 输入、26列 XLSX、七个研究阶段、公开来源、风险核验、九维、评分或 PDF 门禁，不签发原工作流的完成证明。原采集契约的默认采集仍不包含聊天。

先用项目根目录的 `scripts/chat_collection.mjs` 完成已授权商机的逐页采集与 `accept`。本技能只读取现有文件，不连接浏览器、补采、发消息或改客户状态。全部输入和产物经同一 `dataPath()` 校验，必须处于项目根目录的忽略 `data/` 内，拒绝符号链接；不上传。

从项目根目录运行：

```text
node .agents/skills/alibaba-buyer-due-diligence/scripts/chat_evidence.mjs bind --chat-run data/<chat-run> --source data/<same-source-bundle.json> --out data/<private-manifest.json>
node .agents/skills/alibaba-buyer-due-diligence/scripts/chat_evidence.mjs validate --manifest data/<private-manifest.json>
```

`bindChatEvidence({chatRun, source, out, input?, bindings?}, projectRoot?)` 写私有 manifest 并返回安全数量汇总。`validateChatRun({chatRun, source}, projectRoot?)` 返回私有核验结果，调用者不得打印该对象。`validateChatEvidence({manifest, expectedSha256?}, projectRoot?)` 重验 manifest、当前代码与全部依赖；调用者已有 manifest 哈希时传 `expectedSha256`。

## 核验与关联

核验 checkpoint/config、来源 bundle 与 `source-proof.json`；逐个重验从1到当前 revision 的 request/accepted链、前态哈希、配置哈希、采集器哈希和实际生成的页面脚本；要求状态只能追加、会话及旧身份不变、每步至多一页。最后重建 JSONL与coverage并精确比对。存在 pending 时先用原采集入口恢复并接受已有响应，不能把未接受页纳入 sidecar。缺链文件、未知旧schema、正文缺字段、文件篡改、换买家／店铺、代码变化或不一致导出均拒绝。单文件最大128 MiB，超限保持来源并报告限制。

本地模式将每个 config 目标按 `store_key + inquiry_id + buyer_member_id` 精确关联到同一来源 bundle；会员来源必须是 `alibaba-message-querySummary-contact-loginId-v1`。不按姓名归并。相同会话消息关联多条商机时，JSONL只保留一条，manifest用消息下标分别引用；这不证明多个账号属于同一个公司客户。

可选绑定已有真实 v3 文件，额外提供 `--input data/<daily-v3.json> --bindings data/<bindings.json>`。映射文件格式：

```json
{
  "schemaVersion": "alibaba.chat-evidence-bindings.v1",
  "inputSha256": "actual-v3-file-sha256",
  "records": [
    {"store_key": "demobeta", "inquiry_id": "101", "buyer_member_id": "alibaba-visible-member:buyer001", "sourceRecordIndex": 0}
  ]
}
```

以上身份只是合成示例，不能用于真实采集。每个聊天目标都须映射，索引从0开始，且 `buyer_member_id` 必须精确等于 `alibaba-visible-member:` 加对应原记录的 `buyerLoginId`。相同映射可去重；额外目标、冲突映射、缺映射、非规范／重复根身份和文件哈希不一致拒绝。不生成或修补 CRM ID、login、日期或阶段回执。

这里只核验 v3 文件哈希与身份对应，不校验 JSON/XLSX对、来源采集完整性或研究结果。manifest的 `inputValidation`、`researchValidation`始终是 `not_performed`；原 `workflow.py init/next/advance/finalize`仍须独立通过。禁止把私有 manifest 写成 `phase_status.json`、`validation.json`或冒充某个原研究阶段的证明。

## 证据解释与复用

manifest只保存私有路径、文件／代码哈希、身份与源索引、消息引用、数量和覆盖；不复制聊天正文、附件内容、`source_content`或联系方式。原文仍在经过核验的私有 JSONL。`source_content`中的HTML只可作为不可信源字符串读取，不渲染执行，也不能投射到公开 `research.json`、搜索、`sources[]`、观察文件或PDF。代码哈希包括采集器、采集CLI和本适配器；原Python规则哈希没有覆盖根目录这两份JS，不能替代本sidecar的代码绑定。

每个关联另算 `earliest_known_buyer_message_at`，只取 buyer 方向，区别于coverage中的双方最早消息。接口触底和预算暂停均不证明公司完整历史，`historyComplete=false`固定保留。最早已知买家消息不是公司首次消息；buyer消息也未被自动认定为有效业务回复。

`reply_source=unknown`、`autoReply=0`或客户端信息不证明人工；系统、AI与自动回复不能自动计入业务员有效跟进或重置有效买家回复日期。manifest固定 `humanFollowupEstablished=false`、`effectiveBuyerReplyEstablished=false`。聊天可供后续私有角色／意向／阶段分析引用，不能计入公开独立双来源或证明付款。

核验只能证明本地文件、身份及追加收据的一致性，不证明API真实性。多文件协同伪造不是哈希能排除的事实。来源、代码、收据或导出变动后重新核验；已有manifest仅相同内容可幂等复用，冲突时生成新的产物而不覆盖旧证据。失败只输出固定错误代码，不把私有内容或任意异常文本打印到对话。
