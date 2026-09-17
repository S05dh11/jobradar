// 诊断三段式「零真实调用」离线测试:
//   mock globalThis.fetch 接管方舟 chat/completions 与豆包搜索端点,
//   按脚本驱动 app/lib/diagnose.ts 的全部分支(直通/补搜/预算/段1重试/段3重问/双失败/搜索软失败)。
// 不连网、不读 Key、不花配额;Node 24 原生类型擦除直接加载 .ts,
// registerHooks 仅补「无扩展名相对导入 → .ts」的解析(生产代码风格不变)。
// 用法:node scripts/diag-offline-test.mjs
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && context.parentURL && !/\.[cm]?[jt]s$/.test(specifier)) {
      for (const cand of [
        new URL(specifier + ".ts", context.parentURL).href,
        new URL(specifier + "/index.ts", context.parentURL).href,
      ]) {
        if (existsSync(fileURLToPath(cand))) return next(cand, context);
      }
    }
    return next(specifier, context);
  },
});

process.env.ARK_API_KEY = "offline-test-key";
const { extractResume, analyzeResume } = await import("../app/lib/diagnose.ts");

const SEARCH_ENDPOINT = "https://open.feedcoopapi.com/search_api/web_search";
const jobs = [
  { title: "Python 后端工程师", company: "甲", city: "杭州", salary: "20-35k", skills: ["Python", "FastAPI", "MySQL", "Redis"], sourceUrl: "https://example.com/1", sourceName: "站", publishedAt: "2026-09-01", credibility: "medium" },
  { title: "Java 后端工程师", company: "乙", city: "杭州", salary: "25-40k", skills: ["Java", "Spring Boot", "MySQL", "Redis", "Kubernetes"], sourceUrl: "https://example.com/2", sourceName: "站", publishedAt: "2026-09-02", credibility: "medium" },
  { title: "大模型应用工程师", company: "丙", city: "北京", salary: "30-50k", skills: ["Python", "LangChain", "RAG", "大模型"], sourceUrl: "https://example.com/3", sourceName: "站", publishedAt: "2026-09-03", credibility: "medium" },
];

const GOOD_EXTRACTED = {
  skills: ["Python", "RAG"],
  education: "硕士",
  years: "1 年实习",
  projects: ["知识库问答"],
  degreeYear: "2027 届",
  intent: "找实习",
};
const FINAL_JSON = {
  hit: [{ skill: "Python", rank: 1, evidence: "market_pool" }],
  gaps: [{ skill: "Kubernetes", rank: 4, evidence: "market_pool" }],
  target: { category: "AI/算法", city: "杭州", reason: "池内岗集中杭州", evidence: "market_pool" },
  conclusion: "池证据结论",
};

// ---------- mock 设施 ----------

function okJson(obj) {
  return {
    ok: true,
    status: 200,
    json: async () => obj,
    text: async () => JSON.stringify(obj),
  };
}
function errStatus(status, text) {
  return { ok: false, status, json: async () => ({}), text: async () => text };
}
function arkText(content) {
  return okJson({ choices: [{ message: { role: "assistant", content } }] });
}
function arkTool(id, name, args) {
  return okJson({
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
        },
      },
    ],
  });
}
function searchResponse() {
  return okJson({
    Result: {
      ResultCount: 1,
      WebResults: [
        { Title: "RAG 工程师招聘要求", Url: "https://x.example.com/rag", Snippet: "要求 LangChain/向量库", SiteName: "示例站", AuthInfoLevel: 3 },
      ],
    },
  });
}

// handler(url, body, ctx):按脚本返回响应;ctx 计数并留存请求体
function installFetch(handler) {
  const ctx = { visionCalls: 0, chatCalls: 0, searchCalls: 0, bodies: [] };
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const body = JSON.parse(init?.body ?? "{}");
    if (u === SEARCH_ENDPOINT) {
      ctx.searchCalls++;
      return handler("search", body, ctx) ?? errStatus(500, "未配置 search 响应");
    }
    const isVision = JSON.stringify(body.messages ?? []).includes("image_url");
    ctx.bodies.push(body);
    if (isVision) {
      ctx.visionCalls++;
      return handler("vision", body, ctx) ?? errStatus(500, "未配置 vision 响应");
    }
    ctx.chatCalls++;
    return handler("chat", body, ctx) ?? errStatus(500, "未配置 chat 响应");
  };
  return ctx;
}

// ---------- 断言 ----------

let pass = 0;
let failCount = 0;
function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    failCount++;
    console.error(`  ✗ ${name} ${extra}`);
  }
}
async function caseRun(title, fn) {
  console.log(`\n== ${title} ==`);
  try {
    await fn();
  } catch (e) {
    failCount++;
    console.error(`  ✗ 用例异常:${e?.stack ?? e}`);
  }
}
const toolMsgCount = (body) => (body.messages ?? []).filter((m) => m.role === "tool").length;
const analyze = (extracted) => {
  const events = [];
  const r = analyzeResume({ extracted, jobs, extractMs: 123, onEvent: (e) => events.push(e), signal: undefined });
  return r.then((report) => ({ report, events }));
};

// ---------- A:岗位池证据足够 → 零搜索直通 ----------

await caseRun("A 池证据足够,不搜索直通", async () => {
  const ctx = installFetch((kind) => {
    if (kind === "vision") return arkText(JSON.stringify(GOOD_EXTRACTED));
    if (kind === "chat") return arkText(JSON.stringify(FINAL_JSON));
    throw new Error("不应发生搜索");
  });
  const ext = await extractResume("data:image/png;base64,AAAA");
  const { report, events } = await analyze(ext.data);
  check("视觉只调 1 次", ctx.visionCalls === 1);
  check("判断轮只调 1 次", ctx.chatCalls === 1);
  check("搜索 0 次", ctx.searchCalls === 0);
  check("请求体带 tools", Array.isArray(ctx.bodies.at(-1).tools) && ctx.bodies.at(-1).tools.length === 1);
  check("searches 为空数组", Array.isArray(report.searches) && report.searches.length === 0);
  check("事件=stage analyzing → stage done", events.map((e) => `${e.type}:${e.stage ?? ""}`).join("|") === "stage:analyzing|stage:done");
  check("hit 证据 market_pool", report.hit[0]?.evidence === "market_pool" && report.hit[0].rank === 1);
  check("extracted 由段 1 原样回填", report.extracted.degreeYear === "2027 届" && report.extracted.intent === "找实习");
  check("stages 耗时数值", report.stages.extractMs === 123 && typeof report.stages.agentMs === "number");
});

// ---------- B:补搜 1 次 + search 证据 url 溯源纪律 ----------

await caseRun("B 补搜取证,假 url 被剥离", async () => {
  const ctx = installFetch((kind, body) => {
    if (kind === "vision") return arkText(JSON.stringify(GOOD_EXTRACTED));
    if (kind === "search") return searchResponse();
    if (toolMsgCount(body) === 0) return arkTool("c1", "search_market", { query: "RAG 工程师 招聘要求" });
    return arkText(
      JSON.stringify({
        hit: [{ skill: "Python", rank: 1, evidence: "market_pool" }],
        gaps: [
          "Kubernetes", // 旧字符串形态兜底
          { skill: "RAG", evidence: "search", url: "https://x.example.com/rag" },
          { skill: "幽灵技能", evidence: "search", url: "https://evil.example.com/fake" }, // 工具没返回过
        ],
        target: { category: "AI/算法", city: "北京", reason: "搜到的 RAG 岗多在北京", evidence: "search", url: "https://x.example.com/rag" },
        conclusion: "补搜结论",
      })
    );
  });
  const ext = await extractResume("data:image/png;base64,AAAA");
  const { report, events } = await analyze(ext.data);
  check("搜索恰好 1 次", ctx.searchCalls === 1);
  check("search 事件带真实计数", events.some((e) => e.type === "search" && e.query === "RAG 工程师 招聘要求" && e.count === 1));
  check("searches 记录 query+首条 url", report.searches[0]?.query === "RAG 工程师 招聘要求" && report.searches[0]?.url === "https://x.example.com/rag");
  const gaps = Object.fromEntries(report.gaps.map((g) => [g.skill, g]));
  check("字符串缺口兜底为 market_pool", gaps["Kubernetes"]?.evidence === "market_pool" && !gaps["Kubernetes"].url);
  check("真实搜索 url 保留", gaps["RAG"]?.url === "https://x.example.com/rag");
  check("编造 url 被剥离", gaps["幽灵技能"]?.evidence === "search" && gaps["幽灵技能"]?.url === undefined);
  check("target 挂 search 真链接", report.target.url === "https://x.example.com/rag" && report.target.evidence === "search");
});

// ---------- C:搜索硬预算 3 次,第 4 次工具调用不触网 ----------

await caseRun("C 搜索预算 3 次封顶", async () => {
  const ctx = installFetch((kind, body) => {
    if (kind === "vision") return arkText(JSON.stringify(GOOD_EXTRACTED));
    if (kind === "search") return searchResponse();
    const n = toolMsgCount(body);
    if (n < 4) return arkTool(`c${n + 1}`, "search_market", { query: `q${n + 1}` });
    return arkText(
      JSON.stringify({ hit: [], gaps: [], target: { category: "后端", city: "杭州", reason: "x", evidence: "market_pool" }, conclusion: "ok" })
    );
  });
  const ext = await extractResume("data:image/png;base64,AAAA");
  const { report, events } = await analyze(ext.data);
  check("搜索端点只打到第 3 次", ctx.searchCalls === 3, `实际 ${ctx.searchCalls}`);
  check("searches 记录 3 条", report.searches.length === 3);
  check("仍正常出报告", report.conclusion === "ok");
  check("3 条 search 事件", events.filter((e) => e.type === "search").length === 3);
  // 第 4 次工具结果必须是预算耗尽文案(查最后一轮请求体里回传的 tool 消息序列)
  const lastToolTexts = (ctx.bodies.at(-1).messages ?? [])
    .filter((m) => m.role === "tool")
    .map((m) => m.content);
  check("第 4 次工具结果为预算耗尽提示", lastToolTexts.length === 4 && lastToolTexts[3].includes("预算(3 次)已用尽"));
});

// ---------- D:段 1 解析失败 → 搜索前整体重试 1 次 ----------

await caseRun("D 段1失败自动重试(零搜索损耗)", async () => {
  let vision = 0;
  const ctx = installFetch((kind) => {
    if (kind === "vision") {
      vision++;
      return vision === 1 ? arkText("嗯我先看看这张图{坏 json") : arkText(JSON.stringify(GOOD_EXTRACTED));
    }
    throw new Error("段 1 期间不应有判断轮调用");
  });
  const ext = await extractResume("data:image/png;base64,AAAA");
  check("视觉调用 2 次", ctx.visionCalls === 2 && vision === 2);
  check("retries=1", ext.retries === 1);
  check("重试期间零判断轮/零搜索", ctx.chatCalls === 0 && ctx.searchCalls === 0);
  check("提取结果正确", ext.data.skills.includes("Python") && ext.data.education === "硕士");
});

// ---------- E:段 3 解析失败 → 保留对话、无工具重问 1 次 ----------

await caseRun("E 段3失败无工具重问成功", async () => {
  const ctx = installFetch((kind, body) => {
    if (kind === "vision") return arkText(JSON.stringify(GOOD_EXTRACTED));
    if (Array.isArray(body.tools)) return arkText("好的我分析一下,结论稍后给……(不是 JSON)");
    return arkText(JSON.stringify(FINAL_JSON)); // 无 tools 的重问调用
  });
  const ext = await extractResume("data:image/png;base64,AAAA");
  const { report, events } = await analyze(ext.data);
  const reask = ctx.bodies.at(-1);
  check("判断轮 2 次(初次 + 重问)", ctx.chatCalls === 2);
  check("重问请求不含 tools / tool_choice", reask.tools === undefined && reask.tool_choice === undefined);
  check("重问前保留了段 2 完整对话", (reask.messages ?? []).some((m) => m.role === "system") && (reask.messages ?? []).length >= 3);
  check("全程零搜索", ctx.searchCalls === 0);
  check("发出 conclusion 重试事件", events.some((e) => e.type === "retry" && e.stage === "conclusion"));
  check("重问后报告正常", report.conclusion === "池证据结论");
});

// ---------- F:段 3 两次都失败 → 抛错带原文片段 ----------

await caseRun("F 段3双失败报错含片段", async () => {
  installFetch((kind) => {
    if (kind === "vision") return arkText(JSON.stringify(GOOD_EXTRACTED));
    return arkText("@@@自言自语标记@@@");
  });
  const ext = await extractResume("data:image/png;base64,AAAA");
  let err = null;
  try {
    await analyze(ext.data);
  } catch (e) {
    err = e;
  }
  check("抛出错误", !!err);
  check("报文含失败原文片段", /原文片段/.test(err?.message ?? "") && err?.message.includes("@@@自言自语标记@@@"));
});

// ---------- G:段 1 两次都失败 → 抛错带原文片段 ----------

await caseRun("G 段1双失败报错含片段", async () => {
  const ctx = installFetch((kind) =>
    kind === "vision" ? arkText("@@@视觉自言自语@@@{") : errStatus(500, "unused")
  );
  let err = null;
  try {
    await extractResume("data:image/png;base64,AAAA");
  } catch (e) {
    err = e;
  }
  check("视觉调用 2 次后放弃", ctx.visionCalls === 2);
  check("抛出错误", !!err);
  check("报文含两次失败与原文片段", /两次/.test(err?.message ?? "") && err?.message.includes("@@@视觉自言自语@@@"));
});

// ---------- H:搜索接口软失败 → 不记 searches、占预算、报告仍可成 ----------

await caseRun("H 搜索软失败可降级", async () => {
  const ctx = installFetch((kind, body) => {
    if (kind === "vision") return arkText(JSON.stringify(GOOD_EXTRACTED));
    if (kind === "search") return errStatus(500, "boom");
    if (toolMsgCount(body) === 0) return arkTool("c1", "search_market", { query: "坏词" });
    return arkText(JSON.stringify({ ...FINAL_JSON, conclusion: "降级结论" }));
  });
  const ext = await extractResume("data:image/png;base64,AAAA");
  const { report } = await analyze(ext.data);
  check("搜索打了 1 次(失败)", ctx.searchCalls === 1);
  check("失败搜索不进 searches", report.searches.length === 0);
  check("基于岗位池照常出报告", report.conclusion === "降级结论");
});

console.log(`\n${failCount === 0 ? "全部通过 ✅" : "存在失败 ❌"}:${pass} 通过,${failCount} 失败`);
process.exit(failCount === 0 ? 0 : 1);
