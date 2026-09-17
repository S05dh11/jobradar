# 开发记录:全仓库重写 · 模块一 —— lib 基础层

日期:2026-09-16
仓库:F:\——文章撰写——\火山\jobradar(Next.js 16.3.4 App Router + TS strict,无新依赖)
性质:「换承包商」式重写。现行 7 个 lib 文件降级为行为规格,全部逻辑重新实现;`diagnose.ts` 是上一模块我的代码,本次**一行未动**(时间戳仍为 21:30),但其 import 契约全部满足。

## 一、改动文件清单

| 文件 | 行数 | 类型 | 说明 |
|---|---|---|---|
| `app/lib/types.ts` | 68 | 重写 | 字段名/可选性/枚举逐字段保持,注释重写 |
| `app/lib/config.ts` | 117 | 重写 | 36 城名单与 GCJ-02 坐标**逐字数据规格**;常量/类型保持 |
| `app/lib/ark.ts` | 101 | 重写 | OpenAI 兼容 chat/completions;空 tools 省略 tools/tool_choice;tool_calls 解析收紧为数组判定 |
| `app/lib/model.ts` | 37 | 重写 | chatVision 多模态、无工具 |
| `app/lib/search.ts` | 109 | 重写 | 双结构(Result.WebResults / Results)兼容;归一化拆分小函数 |
| `app/lib/fetch-page.ts` | 160 | 重写 | SSRF 护栏、20s 软超时、3MB 封顶、UTF-8/GBK 解码、6000 字正文截断 |
| `app/lib/agent.ts` | 530 | 重写 | SYSTEM_PROMPT **逐字保留**,TOOL_DEFS/用户提示词/工具回执文案保持;循环状态收进显式 state |

未动:`app/lib/diagnose.ts`、两个 route、全部 UI(`page.tsx`/`RadarMap.tsx`/`JobMap.tsx`/`dev-report`)、`scripts/*`、依赖与配置。无新增 npm 依赖。

## 二、契约保持核对(按任务书逐行)

- **ark.ts**:`ARK_BASE`(env `ARK_BASE_URL`,默认 plan v3 端点)、`MODEL`(env `ARK_MODEL`,默认 `doubao-seed-evolving`)、`getArkKey()`(缺 Key 抛中文错);`chatCompletion(messages, tools, signal)` 返回 `{content, toolCalls:[{id,name,args}]}`;`tools=[]` 时请求体整段省略 `tools`/`tool_choice`(温度仍 0.2);`ChatMessage` 四形态、`ToolDef`/`ToolCall` 类型导出;非 2xx 抛 `模型接口 {status}: {body前300字}`。
- **model.ts**:`chatVision(messages, signal)` 支持 text+image_url 多模态 content,请求体不带 tools;错误前缀与 ark 一致;返回 `choices[0].message.content` 字符串。
- **search.ts**:POST `open.feedcoopapi.com/search_api/web_search`,Bearer Agent Plan Key(复用 `getArkKey()`);请求体 `Query/SearchType/Count/Filter{NeedContent:false,NeedUrl:true,Sites?}/NeedSummary/TimeRange/QueryControl{QueryRewrite:true}`;**新结构 `Result.WebResults` 与旧文档 `Results` 都认**(另保留 snake_case/items/list 等变体兜底);非 2xx 抛 `豆包搜索失败 {status}: …`;无标题或无链接条目丢弃;单次归一化封顶 20 条。
- **fetch-page.ts**:URL 解析失败→「URL 无法解析」;非 http(s)→「不支持的协议」;SSRF 拦截 localhost/.local/.internal、IPv4 0/10/127/169.254/172.16-31/192.168/≥224、IPv6 `::`/fc/fd/fe80→「拒绝抓取:内网/本地地址不在允许范围」;页级 20s 超时与全局 signal 用 `AbortSignal.any` 合并,超时软失败「抓取超时(20s)」,全局中止才向上抛;非网页 content-type 拒绝;3MB 流式封顶;UTF-8 fatal→GBK→容错 UTF-8;title 剥标签、正文 6000 字截断。
- **config.ts**:`JOB_CATEGORIES`、`CITIES`(36)、`CITY_COORDS`(36,GCJ-02)、`JOB_TYPES`/`JobType`、`MAX_ITERATIONS=30/MAX_SEARCHES=18/MAX_FETCHES=12/TARGET_JOBS_MIN=18/TARGET_JOBS_MAX=30`、`CREDIBILITY_LABEL/COLOR` 全部保持。
- **types.ts**:`SearchResult`、`JobRecord`(含 sourceUrl/skills/requirements/location/credibility/credibilityNote)、`SkillCount`、`RadarReport`、`AgentEvent` 六成员(plan/search/fetch/job/done/error)字段名一个未变。
- **agent.ts**:`RadarParams`、`runRadarAgent(params,onEvent,signal)`;SYSTEM_PROMPT 信息纪律 8 条/调研计划/执行节奏/可信度评定/收尾全文逐字;`dynamicBudget` 公式 combos×0.9/0.5/0.6/1.2 与 clamp 边界不变(1 组合→4 搜/2 抓/3-6 岗;100 组合→18/12/18-30);TOOL_DEFS 四工具 search_jobs/fetch_page/record_job/finish;每轮「搜→核→记」闭环、预算闸先于参数校验、单工具失败软降级为 tool 文本;模型只说话不调工具→plan 事件(300 字)+独白收尾(500 字);abort 且已有岗位→兜底出报告、summary 标注「调研被中途截断(超时或连接断开)…」,零岗位或非中止错误向上抛;空结果兜底文案两条保持;**`buildSkillRanking(jobs, limit=20)` 已导出**,diagnose.ts 的 import 不变。
- **record_job 服务端硬校验**:`title/company/city/sourceUrl(http(s))` 缺失→「信息不完整」;城市白名单用 `city.includes(c)` 子串匹配(「杭州市余杭区」命中「杭州」)→拒登记文案;同 URL 或同公司+同名→去重文案;salary/sourceName/publishedAt 默认「未披露/未知来源/未知」,credibility 非枚举→medium;skills≤8、requirements≤6、各项截断长度与参考一致。

## 三、我的设计取舍 / 与参考实现的差异点

1. **SYSTEM_PROMPT、城市/坐标表按数据规格逐字照搬**(任务书明确这两样不算代码抄袭)。TOOL_DEFS、buildUserPrompt、工具回执/预算告警/兜底 summary 等**模型面文案虽不在逐字清单,但属调过行为的 tuning 文本,一并保持原文**,只重写结构与注释。
2. **agent 主循环状态收进显式 `RunState`**(jobs/searchCount/fetchCount/summary/finished),替代散在闭包里的多个 `let`;工具上下文按每次调用构造。**刻意保留参考实现的一个怪癖**:搜索回执里的「预算还剩 N 次」用本次调用*开始前*的快照计算(即打完第 1 次显示还剩 4 次,偏松 1),≤2 的临尽告警也随之晚一轮;预算硬闸本身用实时计数,正确。统一改成实时值会改变模型看到的数字,属未被要求的行为变更,故不动。
3. **ark 解析收紧**:`tool_calls` 用 `Array.isArray` 判定后再 map(参考实现对非数组真值会抛),更防御,正常响应无差异;arguments 坏 JSON 仍归 `{}` 由工具侧报参数错。
4. **search 归一化结构重排**:数组定位与字段读取拆成 `pickResultArray/asString/asNumber`;双结构兼容一个不少。一个**细微行为差异**:`publishTime` 缺失时参考实现写出空字符串(类型却声明可选),我按类型契约与任务书 normalize 形状(`publishTime?`)写 `undefined`;agent 回执因此显示「未知」而不是空白,更贴合该字段语义,且不影响事件结构(键本来就可选)。
5. **字段名澄清**:任务书 search 行写的 `authInfoLevel` 是**上游接口字段名**(AuthInfoLevel);归一化后的 TS 字段参考实现、`types.ts` 契约与 agent 消费方均为 **`authLevel`**,保持 `authLevel` 未改名(diagnose.ts 不读该字段,types 行又明令字段名不可变)。
6. **fetch-page 内部重组**:常量/正则命名化(NON_PAGE_TYPE),护栏判定与参考逐条等价;`signal?.aborted` 才重抛的软失败边界不变。
7. **删掉参考实现里未使用的 `CITIES` import**(agent.ts 导入了但全文件未用);不导入无关联的东西。
8. types.ts 注释按我的理解重写;字段、可选性、联合类型顺序与原文件一致。

## 四、验收门禁结果(全部本地完成,零真实模型/搜索调用)

1. `node scripts/diag-offline-test.mjs`:**8 场景 39 断言全绿**(A 直通/B 补搜溯源/C 预算封顶/D 段1重试/E 段3无工具重问/F·G 双失败片段/H 搜索软失败)。
2. `npx tsc --noEmit`:**零错误**。
3. `npm run build`:Next 16.3.4 Turbopack **通过**(编译 19.9s + TypeScript + 5 页静态生成;/api/radar、/api/diagnose 为 ƒ Dynamic)。
4. 全程未启动 dev server、未 curl 任何真实端点;离线测试与自测均 mock `globalThis.fetch`,`.env.local` 的 Key 未被真实使用。

**额外契约自测**(我自写的零联网脚本,在 seed-dev 工作区,不污染仓库):

- `seed-dev/_verify/verify.mjs`:用**第二遍独立转写**的期望文本逐字比对 SYSTEM_PROMPT(逐字符一致)、36 城名单顺序、36 条坐标逐值、全部常量 —— 12 项全绿。这是无 git 历史下对「逐字保留」的独立校验。
- `seed-dev/_verify/agent-contract.mjs`:mock fetch 直驱生产 .ts(Node 24 类型擦除 + registerHooks,同离线测试手法),**66 断言全绿**,覆盖离线测试不碰的契约:
  - dynamicBudget 1 组合(4/2/3-6)与 100 组合(18/12/18-30)两端、类型词进 prompt;
  - record_job 全分支:合法登记/skills 只 trim(岗内去重归词频层)/location/requirements/note、默认值四连、城市子串命中、非法 credibility、同 URL 与同名同公司两类去重、城市闸、信息不全拦截、回执序号、job 事件、cityCoverage;
  - abort:有岗位→截断报告且岗位保住/summary 含「被中途截断」,零岗位→向上抛;
  - 搜索预算第 5 次不触网 + 「搜索预算(4 次)已用尽」回执、search 事件字段、请求体 Query/Count/TimeRange/Filter;
  - doubaoSearch 旧 `Results`+蛇形字段、新 `Result.WebResults`、AuthInfoLevel 字符串→数字、Sites 透传、20 条封顶、500 报错文案;
  - fetchPage 预检:URL/协议/localhost/回环/元数据 169.254/三段内网/IPv6 回环与链路本地全拦、172.32 放行到请求阶段;
  - chatCompletion 空 tools 省略两键、温度/model、toolCalls 解析与坏 JSON、429 文案;
  - buildSkillRanking 别名(nodejs/node/Node.js 合一、K8s/k8s)、岗内去重、同频首次出现稳定序、limit;
  - chatVision 请求无 tools、image_url 透传;
  - 模型独白不调工具→plan 事件 + 单轮结束。

## 五、遗留问题 / 风险(交监工实跑)

1. **真实模型/搜索行为未验证**(配额红线):双结构兼容、abort 兜底、预算闸均为 mock 级证明;线上重点观察:模型是否每轮即搜即记(执行节奏)、空 tools 重问时方舟协议层确实收不到工具(离线已证请求体无该两键)、强反爬站软失败后是否改用摘要登记。
2. **搜索「剩余预算」显示偏松 1 次**(见取舍 2):承袭参考行为,硬闸正确;若监工认为应修成实时值,一处快照改成实时读数即可,会动模型面文案时序,需重新观察。
3. **`publishTime` 缺失由空串改为 undefined**(见取舍 4):模型回执由空白变「未知」,更优但严格说与参考有可观察差异;如裁定必须逐字节复刻,回退为始终写字符串即可。
4. **`npm run lint` 在本机配置加载阶段即崩**(node_modules 内 object.fromentries→es-abstract/2024/Call.js 缺 ./IsArray,依赖树预装损坏,上一模块开发记录已记载,与本次代码无关);类型门禁由 `tsc --noEmit` 与 build 内置 TypeScript 检查承担,必要时 `npm install` 修复后再跑。
5. 离线/自测脚本放在 `seed-dev/_verify/`(仓库外),引用绝对路径;需要长期留存可移入 jobradar/scripts,但会引入新文件,本次按「外科手术只动 lib」未放进去。
