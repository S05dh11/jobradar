// 简历诊断三段式:视觉提取 → 带搜索工具的判断轮 → 带证据标签的结论 JSON
// 段 1 chatVision 读图(无搜索,解析失败在搜索前整体重试 1 次,零配额损耗)
// 段 2 chatCompletion + search_market 工具(预算 3 次):岗位池够用时不搜,该取证才取证
// 段 3 结论校验失败时保留段 2 完整对话、无工具重问 1 次(锁死工具,保证不再发生搜索)
// 所有 search 证据的 url 必须来自真实工具返回(与 radar agent 同一条溯源红线)

import { chatCompletion, type ChatMessage, type ToolDef } from "./ark";
import { chatVision } from "./model";
import { doubaoSearch } from "./search";
import { buildSkillRanking } from "./agent";
import type { JobRecord } from "./types";

// ---------- 对外类型 ----------

export type Evidence = "resume" | "market_pool" | "search";

export interface ResumeExtracted {
  skills: string[];
  education: string | null;
  years: string | null;
  projects: string[];
  degreeYear?: string | null; // 届别,如图中写明(如「2026 届」)
  intent?: string | null; // 实习意向,如图中写明
}

export interface DiagItem {
  skill: string;
  rank?: number;
  evidence: Evidence;
  url?: string;
}

export interface DiagTarget {
  category: string;
  city: string;
  reason: string;
  evidence: Evidence;
  url?: string;
}

export interface DiagSearchRecord {
  query: string;
  url?: string;
}

export interface DiagnoseReport {
  extracted: ResumeExtracted;
  hit: DiagItem[];
  gaps: DiagItem[];
  target: DiagTarget;
  conclusion: string;
  searches: DiagSearchRecord[]; // 实际发生的搜索;空数组 = 判断轮没搜(本身是有效结果)
  stages: { extractMs: number; agentMs: number };
}

// SSE 事件:stage=阶段推进 / search=补搜一次 / retry=发生了自动重试 / done / error
export type DiagnoseSseEvent =
  | { type: "stage"; stage: "extracting" | "analyzing" | "done"}
  | { type: "search"; query: string; count: number }
  | { type: "retry"; stage: "extract" | "conclusion"; attempt: number }
  | { type: "done"; report: DiagnoseReport }
  | { type: "error"; message: string };

// ---------- 常量与提示词 ----------

const MAX_SEARCHES = 3; // 判断轮搜索硬预算
const MAX_ROUNDS = 6; // 工具轮次上限(3 搜索 + 余量,超了强制无工具收尾)
const MAX_GAPS = 5;
const MAX_HITS = 10;

const EXTRACT_PROMPT = `你是岗位雷达的简历识别器。用户上传一张简历照片,只做事实提取,不做评价。

【纪律】
1. 只提图里白纸黑字写明的内容;照片模糊或字段缺失时填 null 或空数组,标注「未识别」可以,严禁凭常识猜测补全。
2. 只输出一个 JSON 对象,不要输出 JSON 外任何文字。

JSON 格式:
{"skills":[],"education":null,"years":null,"projects":[],"degreeYear":null,"intent":null}
- skills:图中出现的技能/技术栈关键词原文(如 Python、Vue、Spring Boot)
- education:学历(如「本科」「硕士」);未写明为 null
- years:工作/实习年限原文(如「1 年实习」「应届」);未写明为 null
- projects:项目方向原文(如「推荐系统」「电商小程序」);未写明为空数组
- degreeYear:毕业届别(如「2026 届」);未写明为 null
- intent:求职意向原文(尤其是否找实习/校招/社招);未写明为 null`;

const JUDGE_SYSTEM_PROMPT = `你是岗位雷达的差距分析官,现在进入「判断轮」。用户会给你三样东西:简历照片的视觉提取结果、本次调研岗位池的技能词频、岗位池明细。你的任务是判断命中、缺口、投递定位,并为每一条结论标注证据来源。

【证据纪律——最高优先级,违反即失败】
1. 证据只有三个来源:
   - resume:简历提取里写明的事实(证明「候选人有什么」)
   - market_pool:本次岗位池(词频排行或岗位明细)能直接支撑的判断
   - search:你调用 search_market 补搜得到的行情
2. 岗位池足以支撑的结论(命中词频 TOP 的技能、池内高频缺口、按池子分布定类别/城市)一律标 market_pool,严禁为此调用搜索——证据就在手里还去搜是浪费配额。
3. 只有当岗位池不足以支撑某条结论时才补搜,例如:简历主技术栈在池子里几乎没有对应行情、需要池外城市或薪资的行情参照、某个池内完全没出现的技能到底热不热门。
4. 搜索硬预算 3 次。可以不搜直接出结论;一旦搜过,后续轮次尽快收尾,严禁把预算花在重复或相近的词上。
5. 标 evidence 为 search 的条目,其 url 必须是 search_market 返回值里真实出现的链接,严禁编造;搜不到就别写那条结论,或改用 market_pool/resume 能支撑的表述。
6. 每条 hit、gaps 条目以及 target 都必须带 evidence 字段;没有证据的结论一律不写。

【输出纪律】
1. 不要重复简历提取字段,extracted 由系统回填。你只输出 hit/gaps/target/conclusion。
2. rank 是该技能在岗位池词频中的名次(从 1 起);非词频依据(含搜索)的条目不写 rank。
3. gaps 按重要性从高到低最多 ${MAX_GAPS} 项;hit 最多 ${MAX_HITS} 项。
4. 决定不搜索时,直接输出最终 JSON,不要有 JSON 外的自言自语。

最终输出只能是这个 JSON(无工具可调用后尤其严格):
{"hit":[{"skill":"","rank":1,"evidence":"market_pool"}],"gaps":[{"skill":"","rank":2,"evidence":"search","url":"https://..."}],"target":{"category":"","city":"","reason":"","evidence":"market_pool"},"conclusion":""}`;

// ---------- 段 1:视觉提取(开流前完成;解析/结构失败重试 1 次,此时没花过搜索配额) ----------

export interface ExtractResult {
  data: ResumeExtracted;
  ms: number;
  retries: number;
}

export async function extractResume(image: string, signal?: AbortSignal): Promise<ExtractResult> {
  const t0 = Date.now();
  let raw = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    raw = await chatVision(
      [
        { role: "system", content: EXTRACT_PROMPT},
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: image } },
            { type: "text", text: "提取这张简历照片,只输出约定的 JSON。" },
          ],
        },
      ],
      signal
    );
    const data = sanitizeExtracted(parseJsonLooseSafe(raw));
    if (data) return { data, ms: Date.now() - t0, retries: attempt };
  }
  throw new Error(`简历提取失败:模型两次返回均无法解析为合规 JSON,原文片段:${raw.slice(0, 400)}`);
}

// ---------- 段 2+3:判断轮与结论 ----------

export interface AnalyzeParams {
  extracted: ResumeExtracted;
  jobs: JobRecord[];
  extractMs: number;
  onEvent: (ev: DiagnoseSseEvent) => void;
  signal?: AbortSignal;
}

export async function analyzeResume(params: AnalyzeParams): Promise<DiagnoseReport> {
  const { extracted, jobs, extractMs, onEvent, signal } = params;
  const t0 = Date.now();
  onEvent({ type: "stage", stage: "analyzing" });

  // 岗位数据瘦身(沿用旧端点逻辑:只挑展示与判断用得到的字段,控制提示词体积)
  const slimJobs = jobs.slice(0, 30).map((j) => ({
    title: j.title,
    city: j.city,
    salary: j.salary ?? "未披露",
    skills: Array.isArray(j.skills) ? j.skills.slice(0, 8) : [],
  }));
  const ranking = buildSkillRanking(jobs).slice(0, 20);

  const messages: ChatMessage[] = [
    { role: "system", content: JUDGE_SYSTEM_PROMPT },
    {
      role: "user",
      content:
        `简历视觉提取结果(字段为 null/空 = 照片里没写明,不是你可以补的知识):\n${JSON.stringify(extracted)}\n\n` +
        `岗位池技能词频 TOP${ranking.length}(rank 依据):\n${JSON.stringify(ranking)}\n\n` +
        `岗位池明细(紧凑 JSON,共 ${slimJobs.length} 条):\n${JSON.stringify(slimJobs)}\n\n` +
        `先判断现有岗位池证据是否足够:够就直接输出最终 JSON;不够再调用 search_market(预算 ${MAX_SEARCHES} 次)。`,
    },
  ];

  const searches: DiagSearchRecord[] = [];
  const knownUrls = new Set<string>(); // 工具真实返回过的 url,search 证据只能挂这里的链接
  let searchAttempts = 0;
  let candidate = "";

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await chatCompletion(messages, TOOL_DEFS, signal);

    if (res.toolCalls.length > 0) {
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
        const toolText = await runSearchTool(call, {
          signal,
          attempts: searchAttempts,
          onConsume: () => searchAttempts++,
          onSearch: (query, results) => {
            searches.push({ query, ...(results[0]?.url ? { url: results[0].url } : {}) });
            results.forEach((r) => knownUrls.add(r.url));
            onEvent({ type: "search", query, count: results.length });
          },
        });
        messages.push({ role: "tool", tool_call_id: call.id, content: toolText });
      }
      continue;
    }

    // 无工具调用:有正文则视为结论候选;空回复落入强制收尾
    candidate = res.content.trim();
    if (candidate) break;
  }

  let conclusion = candidate ? sanitizeConclusion(parseJsonLooseSafe(candidate), knownUrls) : null;

  // 段 3 失败兜底:保留完整对话,无工具重问一次——tools 传空数组,
  // 服务端从请求体省略 tools/tool_choice(见 ark.ts),物理上封死再搜的可能
  if (!conclusion) {
    onEvent({ type: "retry", stage: "conclusion", attempt: 1 });
    messages.push({ role: "assistant", content: candidate || "(模型未输出正文)" });
    messages.push({
      role: "user",
      content:
        "你上一次的输出无法解析为约定 JSON(可能混入了解释文字或字段缺失)。现在不能再调用任何工具," +
        "请严格只输出一个 JSON 对象,格式为 " +
        '{"hit":[{"skill":"","rank":1,"evidence":"market_pool"}],"gaps":[],"target":{"category":"","city":"","reason":"","evidence":"market_pool"},"conclusion":""}' +
        ",基于本轮已有信息(简历提取、岗位池、已返回的搜索结果)作答,不要输出 JSON 外任何字符。",
    });
    const res = await chatCompletion(messages, [], signal);
    const raw = res.content.trim();
    conclusion = sanitizeConclusion(parseJsonLooseSafe(raw), knownUrls);
    if (!conclusion) {
      throw new Error(`诊断结论失败:模型两次输出均无法解析为合规 JSON,原文片段:${raw.slice(0, 400)}`);
    }
  }

  onEvent({ type: "stage", stage: "done" });
  return {
    extracted,
    ...conclusion,
    searches,
    stages: { extractMs, agentMs: Date.now() - t0 },
  };
}

// ---------- search_market 工具 ----------

const TOOL_DEFS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "search_market",
      description:
        "联网搜索招聘市场行情,仅在岗位池证据不足以支撑某条结论时使用(如池内没有简历技术栈的对应行情、需要池外城市/薪资参照)。岗位池已能支撑的结论禁止搜索。",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "搜索词,如「大模型算法工程师 招聘要求」「杭州 React 前端 薪资」",
          },
          count: { type: "integer", description: "返回条数 5-10,默认 8" },
        },
        required: ["query"],
      },
    },
  },
];

interface SearchToolCtx {
  signal?: AbortSignal;
  attempts: number;
  onConsume: () => void;
  onSearch: (query: string, results: { title: string; url: string; snippet: string; siteName: string }[]) => void;
}

async function runSearchTool(call: { name: string; args: Record<string, unknown> }, ctx: SearchToolCtx): Promise<string> {
  if (call.name !== "search_market") return `未知工具:${call.name},请只使用 search_market。`;
  if (ctx.attempts >= MAX_SEARCHES) {
    return `搜索预算(${MAX_SEARCHES} 次)已用尽。立即基于已有信息输出最终 JSON,不要再调用任何工具。`;
  }
  const query = String(call.args.query ?? "").trim().slice(0, 100);
  if (!query) return "错误:缺少 query 参数。";
  const count = clampCount(Number(call.args.count ?? 8));

  // 尝试即占用预算:搜索接口本身失败时也不允许换词重试把配额翻倍
  ctx.onConsume();
  try {
    const results = await doubaoSearch(query, { count, signal: ctx.signal });
    ctx.onSearch(
      query,
      results.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet, siteName: r.siteName }))
    );
    const remaining = MAX_SEARCHES - ctx.attempts;
    return (
      `搜索「${query}」返回 ${results.length} 条结果(预算还剩 ${remaining} 次):\n` +
      JSON.stringify(
        results.map((r) => ({
          title: r.title,
          url: r.url,
          site: r.siteName,
          snippet: r.snippet.slice(0, 180),
        }))
      ) +
      (remaining === 0
        ? "\n【注意】搜索预算已用尽,下一轮必须直接输出最终 JSON。"
        : "\n证据足够后立即输出最终 JSON,不要重复搜索相近词。")
    );
  } catch (e: any) {
    return `搜索「${query}」失败:${String(e?.message ?? e).slice(0, 160)}。可换关键词再试(预算仅剩 ${
      MAX_SEARCHES - ctx.attempts
    } 次),或基于岗位池直接出结论。`;
  }
}

// ---------- 解析与清洗 ----------

function parseJsonLooseSafe(text: string): unknown {
  try {
    return parseJsonLoose(text);
  } catch {
    return null;
  }
}

// 剥 ```json 围栏 + 截取首个 { 到末个 },容忍模型在 JSON 前后插自言自语
function parseJsonLoose(text: string): unknown {
  let t = text.trim();
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  return JSON.parse(t);
}

function sanitizeExtracted(raw: unknown): ResumeExtracted | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.skills)) return null; // skills 是提取契约的必备键,缺失视为整段不合规 → 重试
  return {
    skills: o.skills.map((s) => str(s)).filter(Boolean).slice(0, 20),
    education: strOrNull(o.education),
    years: strOrNull(o.years),
    projects: Array.isArray(o.projects)
      ? o.projects.map((s) => str(s)).filter(Boolean).slice(0, 10)
      : [],
    ...(o.degreeYear !== undefined ? { degreeYear: strOrNull(o.degreeYear) } : {}),
    ...(o.intent !== undefined ? { intent: strOrNull(o.intent) } : {}),
  };
}

interface RawConclusion {
  hit: DiagItem[];
  gaps: DiagItem[];
  target: DiagTarget;
  conclusion: string;
}

function sanitizeConclusion(raw: unknown, knownUrls: Set<string>): RawConclusion | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.hit) || !Array.isArray(o.gaps) || !o.target || typeof o.target !== "object") {
    return null;
  }
  const targetRaw = o.target as Record<string, unknown>;
  const target: DiagTarget = {
    category: str(targetRaw.category).slice(0, 60),
    city: str(targetRaw.city).slice(0, 60),
    reason: str(targetRaw.reason).slice(0, 300),
    evidence: pickEvidence(targetRaw.evidence, "market_pool"),
    ...evidenceUrl(targetRaw.evidence, targetRaw.url, knownUrls),
  };
  return {
    hit: o.hit
      .map((it) => sanitizeItem(it, knownUrls))
      .filter((it): it is DiagItem => it !== null)
      .slice(0, MAX_HITS),
    gaps: o.gaps
      .map((it) => sanitizeItem(it, knownUrls))
      .filter((it): it is DiagItem => it !== null)
      .slice(0, MAX_GAPS),
    target,
    conclusion: str(o.conclusion).slice(0, 600),
  };
}

// 旧契约 gaps/hit 元素形态不一(字符串/对象)都兜底;字段名 skill 缺失时退而取 text/name
function sanitizeItem(raw: unknown, knownUrls: Set<string>): DiagItem | null {
  if (typeof raw === "string") {
    const skill = raw.trim().slice(0, 60);
    return skill ? { skill, evidence: "market_pool" } : null;
  }
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const skill = str(o.skill ?? o.text ?? o.name ?? o.title).slice(0, 60);
  if (!skill) return null;
  const evidence = pickEvidence(o.evidence, "market_pool");
  const rankNum = Number(o.rank);
  return {
    skill,
    ...(Number.isInteger(rankNum) && rankNum >= 1 ? { rank: rankNum } : {}),
    evidence,
    ...evidenceUrl(o.evidence, o.url, knownUrls),
  };
}

function evidenceUrl(evidence: unknown, url: unknown, knownUrls: Set<string>): { url?: string } {
  const u = str(url);
  // 溯源红线:search 证据只挂工具真实返回过的链接,编造或张冠李戴的一律剥离
  if (evidence === "search" && u && knownUrls.has(u)) return { url: u };
  return {};
}

function pickEvidence(v: unknown, fallback: Evidence): Evidence {
  return v === "resume" || v === "market_pool" || v === "search" ? v : fallback;
}

function str(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (v == null) return "";
  return String(v).trim();
}

// 模型若把未识别直接写成「未识别」,展示层需要的是 null;提取清洗时归一
function strOrNull(v: unknown): string | null {
  const s = str(v).slice(0, 80);
  if (!s || s === "未识别" || s.toLowerCase() === "null") return null;
  return s;
}

function clampCount(n: number): number {
  if (!Number.isFinite(n)) return 8;
  return Math.min(10, Math.max(5, Math.floor(n)));
}
