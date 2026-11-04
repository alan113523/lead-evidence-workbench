# 多店 Chrome 识别与采集绑定

目标店铺仅为 `demoalpha`、`demobeta`、`demogamma`。每店使用独立登录会话、独立 run；逐店串行执行。Chrome 的“老店/新店”等显示名、浏览器顺序和旧映射都只是定位线索，不能证明当前登录店铺。

## 先发现连接，再识别卖家

1. 从当前宿主工具枚举可用 Chrome 连接。聊天与客户通背调默认复用正式 `cua_repl` 的 `cua-cdp` 通道，也支持明确选定的原生 `chrome-devtools`。不可改写通道标签冒充另一种连接。连接缺失就记录该店未验证，不自行开调试端口、改权限、安装扩展或新建 Profile。
2. `browser_id` 必须是本次工具发现的实际浏览器 ID；原生工具只有服务器命名空间时，使用该连接的真实服务器标识。`pageId` 只在该连接内选择页面，不能作为全局浏览器 ID。连接必须能固定到一个登录会话；只能连接默认 Profile 的工具不能宣称覆盖三个 Profile。
3. 在每个连接中选已有 `https://i.alibaba.com/` 首页。生成探针后，通过该连接的允许执行页面脚本的 DevTools 能力运行；不要在只读 DOM evaluate 中请求 API。探针只请求同源 `sellerProfileAjax.do`，返回准确店铺域名、观察时间及本次路由/请求绑定，不返回公司名、客户或凭据。
4. 将工具原样返回的对象直接写到指定 `response.json`，再 `accept`。同一通道中一店对应多个浏览器、一个浏览器对应多店均拒绝；不覆盖已有冲突映射。需要重新识别时使用新的映射文件。只识别到两店时保留两店结果，明确第多店未验证，不补造第三条。
5. 保持后台执行：只读取 API，不调用聚焦、点击、滚动、刷新或更改用户工作页地址的操作。新建/导航采集页签必须有工具明确提供的后台能力；缺少该能力时报告限制。原生 `select_page` 使用 `bringToFront=false`。采集器本身不负责打开或聚焦 Chrome；连接方式不能当作“无头”或“不会抢焦点”的证据。

下面命令从项目/工作区根目录运行；`<skill>` 是本技能目录，`<observed-browser-id>` 必须替换成本次工具发现值。路径位于本地 `data/`，不得上传 Git。

```text
node <skill>/scripts/store_browser.mjs probe --channel cua-cdp --browser <observed-browser-id> --out data/browser-check/probe-one
# 在这个 browser_id 的卖家首页执行 script（CDP 表达式）或 devtools_function（原生函数）。
# 仅原生工具使用 --channel chrome-devtools；不要为了通过门禁而改通道标签。
node <skill>/scripts/store_browser.mjs accept --probe data/browser-check/probe-one --response data/browser-check/probe-one/response.json --map data/browser-check/browser-map.json
node <skill>/scripts/store_browser.mjs route --map data/browser-check/browser-map.json --store demobeta --channel cua-cdp
```

每个浏览器用自己的探针目录；三次接受写入同一个 map，最终核对所需通道的三个店铺恰好各一条。不要并发写映射。`route` 只解析已观察的连接，是路由提示，不能替代采集前的实时核验。

## 运行与续采

- 聊天：`prepare --browser-map ... [--channel cua-cdp] --store ... --run data/chat/<store>/<run>` 固定该连接；`next` 返回 `browser_binding` 和本次身份脚本。必须通过这个浏览器对象选首页及消息页，不能把两个页面分别按 URL 全局搜索。身份回执绑定本次 ticket；跨店、跨浏览器、跨 ticket 或超过五分钟的回执，在业务请求前被拒绝。每页重新核验，`accept` 保存身份回执并纳入证据链。
- 客户通：`workflow.py collect --store ... --browser-map ... --channel cua-cdp` 接受已核验的 CDP 连接；明确选择原生 MCP 时指定 `--channel chrome-devtools`。省略通道且同店有多条通道时拒绝，不自动挑选。默认输出为 `outputs/<store>/<date>/<runId>/`。`receiver` 返回 `browserBinding`、`identityFunctionFile` 和 `devtoolsFunctionFile`。先在该连接的卖家首页执行身份函数，再在同一连接的 CRM/买家主页执行采集函数，传入刚返回的身份对象；按当前工具 schema 使用函数参数或在内存中组装调用，不能把凭据脚本打印进对话。身份验证不通过时不发客户查询。
- 客户通每次启动接收器都会生成新的身份请求号。接收器和 worker 都核对回执；超过五分钟会停止，核对页面状态、正常停机后重新启动同一阶段并重新取身份，只续未保存客户。不要修改时间戳。`identity-<kind>.jsonl` 随阶段产物哈希验证。
- 店铺切换必须回到映射选择流程，不能对已开始的 run 改店铺或浏览器。浏览器重启导致 ID 改变时重新发现、新建绑定运行，保留旧来源与检查点，后续按既有稳定键去重。无浏览器绑定的旧运行可读取，不能直接续采或手填绑定冒充已验证。
- 全程保持所选 Chrome 的登录账号不变。域名证据来自阿里接口；`browser_id` 来自宿主工具，并非网页能独立验证的身份。执行者仍必须使用准确连接。文件哈希与回执只验证本地一致性，不提供防伪造保证，也不证明多店客户/聊天全量覆盖。

## 原生 Chrome DevTools 的边界与来源

复用现有采集器和宿主已授权 CDP 能力，不新增浏览器驱动或依赖。原生 MCP 的官方 [接入说明](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/advanced-usage.md#connecting-to-a-running-chrome-instance) 说明：多 Profile 时 `autoConnect` 连接 Chrome 选定的默认 Profile；[配置文档](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/configuration.md) 提供显式浏览器连接选项。三个现有 Profile 优先逐个复用 CUA 浏览器连接，不创建三个指向同一默认 Profile 的 MCP 别名。原生工具可用不代表多店原生连接均可用。

验收分别记录：代码/合成测试、多店实时身份、每店最小业务样本、授权范围完整性。前多店身份通过不能写成多店业务采集完成；某通道未暴露工具时，不把另一通道的成功代替它。
