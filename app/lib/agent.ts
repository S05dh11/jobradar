// JobRadar 调研 Agent:模型(doubao-seed-evolving)用 function calling 自主决定
// 搜什么词、抓哪个链接、登记哪些岗位、何时收尾;每轮「搜 → 核 → 记」闭环。
// 红线:岗位只允许来自工具返回,sourceUrl 全程可追溯;断连/超时也要兜住已登记的数据。

import { chatCompletion, type ChatMessage, type ToolCall, type ToolDef } from "./ark";
import { doubaoSearch } from "./search";
import { fetchPage } from "./fetch-page";
import {
  MAX_FETCHES,
  MAX_ITERATIONS,
  MAX_SEARCHES,
  TARGET_JOBS_MAX,
  TARGET_JOBS_MIN,
  type JobType,
} from "./config";
import type { AgentEvent, JobRecord, RadarReport, SkillCount } from "./types";

export interface RadarParams {
  categories: string[];
  cities: string[];
  jobType: JobType;
}

// ---------- 系统提示词(调过行为的根,逐字规格,改动需重新评估线上表现) ----------

const SYSTEM_PROMPT = `你是 JobRadar(岗位雷达)的调研 Agent,任务是:针对用户选定的岗位类别和城市,通过联网搜索和网页抓取,收集真实在招岗位信息,输出一份可逐条溯源验证的岗位报告。

你的工具:
- search_jobs:联网搜索招聘信息,返回结果列表(标题、URL、摘要、来源站、发布时间、权威性等级)
- fetch_page:抓取网页正文,读取具体 JD 的薪资、技能要求等细节
- record_job:把核实过的岗位登记进报告
- finish:调研完成,输出小结

【信息纪律——最高优先级,违反即失败】
1. 每一个岗位的 sourceUrl 必须来自工具返回值中真实出现的链接,严禁编造 URL。
2. 薪资以 JD 原文为准,没写就填「未披露」;严禁估算或猜测薪资。
3. 技能从 JD 原文归纳;公司名、城市、发布日期必须来自搜索结果或页面内容。
4. 搜索结果的摘要若信息不全(缺薪资/技能),先 fetch_page 核实再 record_job;抓不到的岗位不登记或标低可信。
5. 岗位城市必须落在用户给定的城市列表内,不在列表内的跳过。
6. 具体工作地点(location):JD 写明区/园区/路名就填(如「滨江区」「余杭区未来科技城」),没写就省略该字段,严禁编造地点。
7. 硬性要求(requirements):学历、经验年限、证书等「必须满足」的硬门槛,从 JD 原文归纳为短语列表(如「本科以上」「3 年以上经验」);JD 没写硬性要求就省略。
8. 招聘类型纪律:用户选定了招聘类型,只登记对应类型的岗位——实习=实习岗,秋招(校招)=面向应届生的校招岗,正式(社招)=全职社招岗;搜索词带上类型关键词,类型不符的岗位跳过。

【调研计划】
- 用户会给定岗位类别与城市列表。类别 × 城市组合很多,无法穷举,要合理抽样轮换:每个类别都要有岗位,城市尽量分散覆盖,优先覆盖大城市,别只盯一个城市。
- 搜索词格式:「{城市} {类别/技能方向} 招聘」,如「杭州 后端工程师 招聘」「深圳 大模型算法 招聘」;按用户选定的招聘类型加类型关键词:正式加「社招」或不加,实习加「实习」,秋招加「校招」或「应届」。
- 默认时间范围 OneMonth(近 30 天),确保时效性。
- 搜索时看摘要和来源站质量:官方招聘站/公司官网/直招平台优先;明显过期或与岗位无关的结果跳过。
- 对信息不全但有价值的链接(摘要缺薪资或技能),fetch_page 抓取正文核实;一次抓取可从中登记 1-3 个岗位。
- 已登记的岗位不要重复登记。

【执行节奏——严禁攒着不登记,违反即失败】
- 每轮必须走完小闭环:搜索/抓取 → 立即用 record_job 登记当轮已核实的岗位,再进入下一轮。
- 绝不允许「先把所有搜索/抓取做完、最后统一登记」:搜索或抓取预算耗尽时,未登记的岗位会全部丢失,调研失败。
- 尽量在一次回复中并行调用多个工具(例如同时搜索两个城市、同时抓两页、登记多个岗位),减少往返轮次、节约时间预算。

【可信度评定】
- high:公司官网、BOSS直聘、拉勾、猎聘、前程无忧、智联招聘等直招大站的当前岗位页。
- medium:聚合站、招聘信息转载页、内容较新的第三方来源。
- low:信息明显不全、二手转载、来源站可信度存疑;credibilityNote 说明原因。

【收尾】
岗位数达到目标数量(或搜索/抓取预算用尽、无更多有价值线索)时,立即调用 finish 并写小结:覆盖了哪些类别/城市、数据质量如何、哪些类别或城市覆盖不足及原因。
不要为填满预算继续搜索:时间有限,见好就收。

每次行动前先想:这一步搜什么、为什么。可以在回复正文里用一两句话说明当前计划,然后调用工具。`;

// ---------- 预算与开场 ----------

interface Budget {
  maxSearches: number;
  maxFetches: number;
  targetMin: number;
  targetMax: number;
}

// 预算随「类别 × 城市」组合数缩放,防小范围调研被无限拖长:
// 满量 5×20=100 组合时恰好贴住全局上限(18 搜 / 12 抓 / 18-30 岗);
// 单组合缩到 4 搜 / 2 抓 / 3-6 岗,约 3-4 分钟出报告。
function dynamicBudget(params: RadarParams): Budget {
  const combos = Math.max(1, params.categories.length * params.cities.length);
  return {
    maxSearches: clamp(Math.ceil(combos * 0.9), 4, MAX_SEARCHES),
    maxFetches: clamp(Math.ceil(combos * 0.5), 2, MAX_FETCHES),
    targetMin: clamp(Math.ceil(combos * 0.6), 3, TARGET_JOBS_MIN),
    targetMax: clamp(Math.ceil(combos * 1.2), 6, TARGET_JOBS_MAX),
  };
}

function buildUserPrompt(params: RadarParams, budget: Budget): string {
  const cats = params.categories.join("、");
  const cities = params.cities.join("、");
  const typeLabel =
    { fulltime: "正式(社招全职)", intern: "实习", campus: "秋招(校招)" }[params.jobType] ??
    "正式(社招全职)";
  return `请调研以下招聘需求:

- 岗位类别:${cats}
- 城市:${cities}(发达城市,要求尽量分散覆盖,不要只盯一两个城市)
- 招聘类型:${typeLabel}——搜索词带上类型关键词,只登记该类型岗位,类型不符的跳过
- 目标:收集 ${budget.targetMin}-${budget.targetMax} 个真实在招岗位

执行预算:
- 搜索最多 ${budget.maxSearches} 次,抓取最多 ${budget.maxFetches} 页,请合理规划
- 优先近 30 天发布的岗位
- 每个岗位登记一次 record_job,字段齐全、可溯源;JD 写了具体工作地点(location)和硬性要求(requirements)务必提取

现在开始。`;
}

// ---------- 工具定义(OpenAI function calling) ----------

const TOOL_DEFS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "search_jobs",
      description:
        "联网搜索招聘岗位。一次搜索覆盖「一个城市 + 一类岗位/技能方向」,返回结果列表(标题、URL、摘要、来源站、发布时间、权威性等级)。",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "搜索词,格式如「杭州 后端工程师 招聘」「深圳 大模型算法 招聘」",
          },
          timeRange: {
            type: "string",
            enum: ["OneDay", "OneWeek", "OneMonth", "OneYear"],
            description: "时间范围,默认 OneMonth(近 30 天)",
          },
          count: { type: "integer", description: "返回条数 5-10,默认 10" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_page",
      description:
        "抓取网页正文,用于核实 JD 详情(薪资、技能要求、公司信息)。URL 必须来自 search_jobs 的返回结果。BOSS直聘/鱼泡网等强反爬站正文常抓不到,抓取失败不要重试同一域名,直接用搜索摘要登记并标 medium 可信度。",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "要抓取的页面 URL(来自搜索结果)" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "record_job",
      description: "登记一个已核实的岗位到报告。所有字段必须来自搜索/抓取结果,严禁编造。",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "岗位名称" },
          company: { type: "string", description: "公司名称" },
          city: { type: "string", description: "工作城市,必须在用户给定城市列表内" },
          salary: {
            type: "string",
            description: "薪资原文,如「20-40K·14薪」;未披露就填「未披露」",
          },
          skills: {
            type: "array",
            items: { type: "string" },
            description: "JD 要求的技术/技能关键词,3-8 个,如 Python、分布式、React、SQL",
          },
          sourceUrl: {
            type: "string",
            description: "来源 URL,必须是工具返回值中真实出现的链接",
          },
          sourceName: {
            type: "string",
            description: "来源站点名,如 BOSS直聘、拉勾网、公司官网",
          },
          publishedAt: {
            type: "string",
            description: "发布时间,如 2026-08-30;未知填「未知」",
          },
          credibility: {
            type: "string",
            enum: ["high", "medium", "low"],
            description: "high=直招大站/官网当前岗,medium=聚合站/转载,low=信息不全二手来源",
          },
          credibilityNote: {
            type: "string",
            description: "一句话说明可信度依据",
          },
          location: {
            type: "string",
            description: "具体工作地点(区/园区/路名),如「滨江区」;JD 未写明则省略",
          },
          requirements: {
            type: "array",
            items: { type: "string" },
            description: "硬性要求短语列表,如 [\"本科以上\",\"3 年以上经验\"];JD 未写明则省略",
          },
        },
        required: [
          "title",
          "company",
          "city",
          "salary",
          "skills",
          "sourceUrl",
          "sourceName",
          "credibility",
        ],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finish",
      description: "调研完成,输出小结。调用后任务结束。",
      parameters: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description:
              "本次调研小结:覆盖的类别/城市、数据质量、未能覆盖的部分及原因(50-200 字)",
          },
        },
        required: ["summary"],
      },
    },
  },
];

// ---------- 运行态 ----------

interface RunState {
  jobs: JobRecord[];
  searchCount: number;
  fetchCount: number;
  summary: string;
  finished: boolean;
}

// ---------- 主循环 ----------

export async function runRadarAgent(
  params: RadarParams,
  onEvent: (ev: AgentEvent) => void,
  signal?: AbortSignal
): Promise<RadarReport> {
  const budget = dynamicBudget(params);
  const state: RunState = {
    jobs: [],
    searchCount: 0,
    fetchCount: 0,
    summary: "",
    finished: false,
  };

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildUserPrompt(params, budget) },
  ];

  let truncated = false;

  try {
    for (let iter = 0; iter < MAX_ITERATIONS && !state.finished; iter++) {
      const res = await chatCompletion(messages, TOOL_DEFS, signal);
      const text = res.content.trim();

      // 模型不调工具:有正文当作计划/收尾独白推给前端,空回复直接结束
      if (res.toolCalls.length === 0) {
        if (text) {
          onEvent({ type: "plan", text: text.slice(0, 300) });
          if (!state.summary) state.summary = text.slice(0, 500);
        }
        break;
      }

      // 回传的 assistant 消息必须是 OpenAI 规范结构:
      // tool_calls 带 id/type/function,arguments 重新序列化为 JSON 字符串
      messages.push({
        role: "assistant",
        content: res.content || null,
        tool_calls: res.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.args) },
        })),
      });

      for (const call of res.toolCalls) {
        let toolText: string;
        try {
          toolText = await runTool(call, { state, budget, allowedCities: params.cities, signal, onEvent });
        } catch (e: any) {
          if (signal?.aborted) throw e; // 断连/总超时:取消整条调研
          // 单工具失败不致命:错误作为工具结果回喂,让模型换策略
          toolText = `工具 ${call.name} 执行出错:${String(e?.message ?? e).slice(0, 200)}。可换关键词或链接重试,或基于已有结果收尾。`;
        }
        messages.push({ role: "tool", tool_call_id: call.id, content: toolText });
        if (state.finished) break;
      }
    }
  } catch (e: any) {
    // 中止时若已有登记岗位,兜底出报告:超时丢数据是修过的缺陷,不能复活
    if (!(signal?.aborted) || state.jobs.length === 0) throw e;
    truncated = true;
  }

  if (truncated) {
    state.summary = `调研被中途截断(超时或连接断开),已收集 ${state.jobs.length} 个真实在招岗位,覆盖 ${buildCityCoverage(params.cities, state.jobs).length} 个城市,详见报告。`;
  } else if (!state.summary && state.jobs.length > 0) {
    state.summary = `共收集 ${state.jobs.length} 个真实在招岗位,详见报告。`;
  } else if (!state.summary) {
    state.summary = "本次调研未收集到岗位,请检查网络与 Key 配置后重试。";
  }

  return {
    jobs: state.jobs,
    skillRanking: buildSkillRanking(state.jobs),
    searchCount: state.searchCount,
    fetchCount: state.fetchCount,
    cityCoverage: buildCityCoverage(params.cities, state.jobs),
    summary: state.summary,
  };
}

// ---------- 工具执行 ----------

interface ToolDeps {
  state: RunState;
  budget: Budget;
  allowedCities: string[];
  signal?: AbortSignal;
  onEvent: (ev: AgentEvent) => void;
}

const TIME_RANGES = ["OneDay", "OneWeek", "OneMonth", "OneYear"] as const;
type TimeRange = (typeof TIME_RANGES)[number];

async function runTool(call: ToolCall, deps: ToolDeps): Promise<string> {
  const { state, budget, allowedCities, signal, onEvent } = deps;
  const { name, args } = call;

  switch (name) {
    case "search_jobs": {
      if (state.searchCount >= budget.maxSearches) {
        return `搜索预算(${budget.maxSearches} 次)已用尽,请基于已有结果登记岗位并调用 finish 收尾。`;
      }
      // 攒批闸门:已搜索≥2次仍零登记 → 拒发新结果(不耗预算),逼模型先登记再继续。
      // 防的是「搜完全部预算最后统一登记」——跑到超时被截断时兜底报告会是 0 岗。
      if (state.jobs.length === 0 && state.searchCount >= 2) {
        return (
          `【纪律闸门】你已搜索 ${state.searchCount} 次但尚未登记任何岗位,本次搜索请求被拒绝(未消耗预算)。` +
          `请立即基于已有搜索/抓取结果调用 record_job 登记已核实的岗位(可在一次回复中并行登记多个;` +
          `正文抓不到的岗位按搜索摘要登记并标 medium 可信度)。登记之后才允许继续搜索;` +
          `若确认已有结果全都不可登记,说明原因并调用 finish 收尾。`
        );
      }
      const query = String(args.query ?? "");
      if (!query) return "错误:缺少 query 参数";
      const timeRange: TimeRange = TIME_RANGES.includes(String(args.timeRange) as TimeRange)
        ? (String(args.timeRange) as TimeRange)
        : "OneMonth";
      const count = clamp(Number(args.count ?? 10), 5, 10);

      const usedBefore = state.searchCount; // 本调用开始前的快照,剩余提示与旧行为一致
      state.searchCount++;
      const results = await doubaoSearch(query, { timeRange, count, signal });
      onEvent({ type: "search", query, timeRange, count: results.length, results });

      const remaining = budget.maxSearches - usedBefore;
      const lines = results.map((r) => ({
        title: r.title,
        url: r.url,
        site: r.siteName,
        time: r.publishTime ?? "未知",
        auth: r.authLevel ?? "未知",
        snippet: r.snippet.slice(0, 180),
      }));
      return (
        `搜索「${query}」返回 ${results.length} 条结果(搜索预算还剩 ${remaining} 次):\n` +
        JSON.stringify(lines, null, 0) +
        (remaining <= 2 ? "\n【注意】搜索预算即将用尽,请尽快登记已核实岗位并 finish。" : "") +
        (state.jobs.length === 0
          ? "\n【提醒】当前登记数为 0。下一轮优先 record_job 登记本轮已核实岗位,不要攒到搜索预算耗尽再统一登记。"
          : "")
      );
    }

    case "fetch_page": {
      if (state.fetchCount >= budget.maxFetches) {
        return `抓取预算(${budget.maxFetches} 页)已用尽,请基于已有信息登记岗位并调用 finish 收尾。`;
      }
      const url = String(args.url ?? "");
      if (!/^https?:\/\//i.test(url)) return "错误:url 必须是 http(s) 链接";
      state.fetchCount++;
      const page = await fetchPage(url, signal);
      onEvent({
        type: "fetch",
        url,
        ok: page.ok,
        title: page.title,
        length: page.text?.length,
        error: page.error,
      });
      if (!page.ok) return `抓取失败(${page.error}):${url}。换其他链接或直接基于摘要登记。`;
      return `页面「${page.title ?? "无标题"}」正文(${page.text?.length ?? 0} 字符):\n${page.text}`;
    }

    case "record_job": {
      const job = sanitizeJob(args, state.jobs, allowedCities);
      if (job === "dup") {
        return "该岗位与已登记岗位重复(同 URL 或同公司同名岗位),已跳过,请登记其他岗位。";
      }
      if (job === "city") {
        return "登记被拒:岗位城市不在用户给定的城市列表内,请只登记列表内城市的岗位。";
      }
      if (!job) return "登记失败:信息不完整(必须含 title/company/city/sourceUrl)";
      state.jobs.push(job);
      onEvent({ type: "job", job });
      return `已登记第 ${state.jobs.length} 个岗位:${job.title} @ ${job.company}(${job.city}),来源 ${job.sourceName}`;
    }

    case "finish": {
      state.summary = String(args.summary ?? "").slice(0, 600) || "调研完成。";
      state.finished = true;
      return "调研完成。";
    }

    default:
      return `未知工具:${name}`;
  }
}

// ---------- 岗位登记清洗 ----------

type RejectReason = "dup" | "city";

function sanitizeJob(
  raw: Record<string, unknown>,
  existing: JobRecord[],
  allowedCities: string[]
): JobRecord | RejectReason | null {
  const title = String(raw.title ?? "").trim().slice(0, 120);
  const company = String(raw.company ?? "").trim().slice(0, 120);
  const city = String(raw.city ?? "").trim().slice(0, 60);
  const sourceUrl = String(raw.sourceUrl ?? "").trim();
  const sourceName = String(raw.sourceName ?? "").trim().slice(0, 80);
  if (!title || !company || !city || !/^https?:\/\//i.test(sourceUrl)) return null;

  // 城市白名单是服务端硬校验,不靠提示词自觉
  if (!allowedCities.some((c) => city.includes(c))) return "city";

  // 同 URL 或同公司同岗位名视为重复
  const isDup = existing.some(
    (j) => j.sourceUrl === sourceUrl || (j.company === company && j.title === title)
  );
  if (isDup) return "dup";

  const skills = Array.isArray(raw.skills)
    ? raw.skills.map((s) => String(s).trim().slice(0, 60)).filter(Boolean).slice(0, 8)
    : [];

  const location = String(raw.location ?? "").trim().slice(0, 80) || undefined;
  const requirements = Array.isArray(raw.requirements)
    ? raw.requirements.map((s) => String(s).trim().slice(0, 60)).filter(Boolean).slice(0, 6)
    : undefined;

  const credibility = (["high", "medium", "low"].includes(String(raw.credibility))
    ? String(raw.credibility)
    : "medium") as JobRecord["credibility"];

  return {
    title,
    company,
    city,
    salary: String(raw.salary ?? "未披露").trim().slice(0, 80) || "未披露",
    skills,
    ...(location ? { location } : {}),
    ...(requirements && requirements.length > 0 ? { requirements } : {}),
    sourceUrl,
    sourceName: sourceName || "未知来源",
    publishedAt: String(raw.publishedAt ?? "未知").trim().slice(0, 60) || "未知",
    credibility,
    credibilityNote: String(raw.credibilityNote ?? "").trim().slice(0, 200) || undefined,
  };
}

// ---------- 统计 ----------

// 同义技能归一表:统计 key 一律小写,避免 React/react、K8s/kubernetes 被算成两项
const SKILL_ALIASES: Record<string, string> = {
  nodejs: "node.js",
  node: "node.js",
  python3: "python",
  golang: "go",
  k8s: "kubernetes",
  "vue.js": "vue",
  vuejs: "vue",
  "react.js": "react",
  reactjs: "react",
  postgresql: "postgres",
  ts: "typescript",
};

// 导出给诊断段复用:同一套词频口径,诊断的 rank 才能与报告页对齐
export function buildSkillRanking(jobs: JobRecord[], limit = 20): SkillCount[] {
  const counts = new Map<string, number>();
  const display = new Map<string, string>();

  for (const job of jobs) {
    const countedInJob = new Set<string>(); // 同一岗位重复列同一技能只计一次
    for (const rawSkill of job.skills ?? []) {
      const t = rawSkill.trim();
      if (!t) continue;
      const key = SKILL_ALIASES[t.toLowerCase()] ?? t.toLowerCase();
      if (countedInJob.has(key)) continue;
      countedInJob.add(key);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (!display.has(key)) display.set(key, SKILL_ALIASES[t.toLowerCase()] ?? t);
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1]) // 同频保持首次出现顺序(Map 插入序,排序稳定)
    .slice(0, limit)
    .map(([key, count]) => ({ skill: display.get(key) ?? key, count }));
}

function buildCityCoverage(cities: string[], jobs: JobRecord[]): string[] {
  return cities.filter((c) => jobs.some((j) => j.city.includes(c)));
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return max;
  return Math.min(max, Math.max(min, Math.floor(n)));
}
