# 任务书：全仓库重写 · 模块一 —— lib 基础层

## 背景与性质（先读懂再动手）

JobRadar 正在做「换承包商」式全仓库重写：现有代码降级为**行为规格**，由你（Seed-Evolving）实现自己的版本替换上线。交付后整个产品的代码都出自你手。本任务书是模块一：`app/lib/` 基础层（`diagnose.ts` **除外**——它已经是你的代码，不许动，但它的 import 是你必须满足的契约）。

## 重写范围（7 个文件）

| 文件 | 现行数 | 必须保持的行为契约 |
|---|---|---|
| `app/lib/ark.ts` | ~160 | `ARK_BASE`/`MODEL`/`getArkKey()`（读 env ARK_API_KEY/ARK_BASE_URL）；`chatCompletion(messages, tools, signal)`：OpenAI 兼容 chat/completions + function calling，返回 `{content, toolCalls:[{id,name,args}]}`；**tools 传空数组时请求体省略 tools/tool_choice**（diagnose.ts 段3锁工具依赖此行为）；`ChatMessage` 支持 system/user/assistant(content+tool_calls)/tool(tool_call_id) 四形态；导出 `ChatMessage`/`ToolDef`/`ToolCall` 类型 |
| `app/lib/model.ts` | 32 | `chatVision(messages, signal)`：多模态 content（text+image_url）、无工具 |
| `app/lib/search.ts` | ~103 | `doubaoSearch(query, {count, signal})`：POST open.feedcoopapi.com/search_api/web_search，Bearer Agent Plan Key；**响应双结构兼容**（`Result.WebResults` 与旧文档 `Results` 都要认——真实接口曾中途改版，这是踩过的坑）；normalize 出 `{title,url,snippet,siteName,publishTime?,authInfoLevel?}` |
| `app/lib/fetch-page.ts` | 151 | `fetchPage(url)`：带 UA 抓正文、超长截断、反爬站点失败时返回可读错误信息（不抛崩） |
| `app/lib/config.ts` | 116 | `CITIES`（36 城）、`CITY_COORDS`（36 城 GCJ-02 坐标）、`JOB_CATEGORIES`、`JOB_TYPES`、预算常量（MAX_SEARCHES=18 等）、`JobType` 类型——**城市名与坐标数据表逐字保留**（坐标是校准过的数据规格），周边逻辑与组织自己写 |
| `app/lib/types.ts` | 63 | `JobRecord`（含 sourceUrl/skills/requirements/location/credibility/credibilityNote）、`AgentEvent`、`RadarReport`、`SkillCount` 等类型契约——字段名一个都不能变（UI/api 全依赖） |
| `app/lib/agent.ts` | ~530 | `runRadarAgent(params, …)` 调研循环：SYSTEM_PROMPT 文本**逐字保留**（信息纪律 8 条/调研计划/执行节奏/可信度评定/收尾——它是调过行为的根）；`dynamicBudget` 公式行为不变（combos×0.9/0.5/0.6/1.2 + clamp）；TOOL_DEFS 四工具（search_jobs/fetch_page/record_job/finish）；「搜→核→记」每轮闭环语义；预算耗尽回传提示；**abort 时已登记岗位兜底出报告、summary 标注「被中途截断」**（超时丢数据是修过的缺陷，别让它复活）；**必须导出 `buildSkillRanking(jobs, limit)`**（diagnose.ts 在用，排序行为不变） |

## 重写纪律

1. **先读**参考实现与所有调用方（`app/api/radar/route.ts`、`app/api/diagnose/route.ts`、`app/lib/diagnose.ts`、`scripts/diag-offline-test.mjs`），理解行为后再写自己的版本；
2. **逻辑代码自己写**：结构、命名、内部实现可自主；两样东西逐字照搬视为规格而非代码——SYSTEM_PROMPT 全文、config 的城市/坐标数据表；
3. 不改任何调用方的代码；不新增 npm 依赖；TS strict；注释风格与仓库一致（中文、讲为什么）；
4. `.env.local` 里已有 ARK_API_KEY，本地无需配置。

## 验收门禁（全部自测通过才算交付）

1. `node scripts/diag-offline-test.mjs` **39 断言全绿**——它 mock fetch 直接驱动 ark/search/agent 与 diagnose.ts 的整合，是你重写质量的最硬契约；
2. `npx tsc --noEmit` 零错误；
3. `npm run build` 通过；
4. **不发起任何真实模型/搜索调用**（配额红线，真跑由监工执行）；
5. 开发记录写到 `F:\——文章撰写——\火山\seed-dev\开发记录-重写1-lib层.md`：每个文件的设计取舍、与参考实现的差异点、自测结果、风险。

如果离线测试失败：修到绿为止再交，不许放宽断言（发现断言本身与参考实现矛盾可提出，等监工裁定）。
