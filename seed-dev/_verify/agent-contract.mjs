// lib 层契约自测(零联网):mock fetch 驱动 agent/ark/search/fetch-page/model。
// 覆盖离线测试没碰的部分:dynamicBudget、sanitizeJob、去重/城市闸、abort 兜底、
// 搜索双结构兼容、预算闸、ark 空 tools 省略、fetch-page 预检护栏、技能词频。
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

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
const ROOT = "F:/——文章撰写——/火山/jobradar";
const { runRadarAgent, buildSkillRanking } = await import(
  pathToFileURL(`${ROOT}/app/lib/agent.ts`).href
);
const { chatCompletion } = await import(pathToFileURL(`${ROOT}/app/lib/ark.ts`).href);
const { chatVision } = await import(pathToFileURL(`${ROOT}/app/lib/model.ts`).href);
const { doubaoSearch } = await import(pathToFileURL(`${ROOT}/app/lib/search.ts`).href);
const { fetchPage } = await import(pathToFileURL(`${ROOT}/app/lib/fetch-page.ts`).href);

const SEARCH_ENDPOINT = "https://open.feedcoopapi.com/search_api/web_search";
const CHAT_ENDPOINT = "https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions";

let pass = 0;
let fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name} ${extra}`);
  }
};
const group = (name) => console.log(`\n== ${name} ==`);

const okJson = (obj) => ({
  ok: true,
  status: 200,
  json: async () => obj,
  text: async () => JSON.stringify(obj),
});
const errStatus = (status, text) => ({
  ok: false,
  status,
  json: async () => ({}),
  text: async () => text,
});
const tc = (id, name, args) => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
const arkResp = (toolCalls, content = null) =>
  okJson({ choices: [{ message: { role: "assistant", content, tool_calls: toolCalls } }] });
const finish = (summary = "收工") => arkResp([tc("f", "finish", { summary })]);

// scripted: 每次 chat/completions 按顺序弹出一个响应;同时记录请求体
function scriptedChat(script, { onChatBody } = {}) {
  const bodies = [];
  let searchCalls = 0;
  let searchBodies = [];
  let searchResult;
  let chatIdx = 0;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u === SEARCH_ENDPOINT) {
      searchCalls++;
      searchBodies.push(JSON.parse(init?.body ?? "{}"));
      return searchResult ?? errStatus(500, "未配置搜索响应");
    }
    if (u === CHAT_ENDPOINT) {
      const body = JSON.parse(init?.body ?? "{}");
      bodies.push(body);
      onChatBody?.(body, chatIdx);
      const step = script[chatIdx] ?? finish();
      chatIdx++;
      return typeof step === "function" ? step(body) : step;
    }
    throw new Error(`测试未允许联网:${u}`);
  };
  return {
    bodies,
    get searchCalls() {
      return searchCalls;
    },
    searchBodies,
    setSearchResult: (r) => {
      searchResult = r;
    },
  };
}
const noop = () => {};
const run = (params, events = []) =>
  runRadarAgent(params, (e) => events.push(e), undefined);
const lastToolTexts = (ctx) =>
  (ctx.bodies.at(-1).messages ?? []).filter((m) => m.role === "tool").map((m) => m.content);
const allToolTexts = (ctx) =>
  ctx.bodies.flatMap((b) => (b.messages ?? []).filter((m) => m.role === "tool").map((m) => m.content));

// ---------- A:dynamicBudget 公式 ----------
group("A dynamicBudget(1 组合 → 4/2/3-6)");
{
  const ctx = scriptedChat([]);
  const events = [];
  const rep = await run({ categories: ["后端"], cities: ["杭州"], jobType: "fulltime" }, events);
  const userPrompt = ctx.bodies[0].messages[1].content;
  check("搜索 4 / 抓取 2", /搜索最多 4 次,抓取最多 2 页/.test(userPrompt));
  check("目标 3-6", /收集 3-6 个/.test(userPrompt));
  check("finish 摘要回传", rep.summary === "收工");
  check("done 事件", events.some((e) => e.type === "done") === false); // done 由 route 发,agent 不发
}

group("A2 dynamicBudget(100 组合 → 18/12/18-30,贴全局上限)");
{
  const ctx = scriptedChat([]);
  const cats = ["AI/算法", "后端", "前端", "全栈", "测试"];
  const cities = ["北京","上海","深圳","广州","杭州","成都","武汉","南京","苏州","西安","长沙","重庆","天津","厦门","青岛","合肥","郑州","宁波","东莞","佛山"];
  await run({ categories: cats, cities, jobType: "intern" });
  const userPrompt = ctx.bodies[0].messages[1].content;
  check("搜索 18 / 抓取 12", /搜索最多 18 次,抓取最多 12 页/.test(userPrompt));
  check("目标 18-30", /收集 18-30 个/.test(userPrompt));
  check("实习类型词进 prompt", userPrompt.includes("实习"));
}

// ---------- B:sanitizeJob 全分支 ----------
group("B 岗位登记清洗/去重/城市闸/默认值");
{
  const job1 = {
    title: "算法工程师", company: "甲", city: "杭州", salary: "20-30K",
    skills: ["Python", "Python", " React "],
    sourceUrl: "https://a.com/1", sourceName: "BOSS直聘", publishedAt: "2026-09-01",
    credibility: "high", credibilityNote: "直招大站", location: "滨江区", requirements: ["本科以上", "3 年以上"],
  };
  const job2 = { title: "后端工程师", company: "乙", city: "杭州市余杭区", sourceUrl: "https://b.com/2" };
  const dupUrl = { ...job1, title: "另一个岗" };
  const dupName = { title: "算法工程师", company: "甲", city: "杭州", sourceUrl: "https://a.com/x" };
  const badCity = { title: "前端", company: "丙", city: "深圳", sourceUrl: "https://c.com/3" };
  const incomplete = { title: "测试", company: "丁", city: "杭州" };
  const badCred = { title: "全栈", company: "戊", city: "杭州", sourceUrl: "https://e.com/5", credibility: "weird" };
  const ctx = scriptedChat([
    arkResp([tc("r1", "record_job", job1), tc("r2", "record_job", job2)]),
    arkResp([
      tc("d1", "record_job", dupUrl),
      tc("d2", "record_job", dupName),
      tc("d3", "record_job", badCity),
    ]),
    arkResp([tc("d4", "record_job", incomplete), tc("r3", "record_job", badCred)]),
    finish(),
  ]);
  const events = [];
  const rep = await run({ categories: ["全栈"], cities: ["杭州"], jobType: "campus" }, events);

  const j1 = rep.jobs[0];
  check("合法岗位登记", j1.title === "算法工程师" && j1.credibility === "high");
  check("登记侧只 trim 不去重(去重留给词频)", JSON.stringify(j1.skills) === JSON.stringify(["Python", "Python", "React"]));
  check("location/requirements/note 保留", j1.location === "滨江区" && j1.requirements?.length === 2 && j1.credibilityNote === "直招大站");
  const j2 = rep.jobs[1];
  check("默认值:薪资/来源/日期/可信度", j2.salary === "未披露" && j2.sourceName === "未知来源" && j2.publishedAt === "未知" && j2.credibility === "medium");
  check("城市子串匹配(杭州市余杭区 命中 杭州)", j2.city === "杭州市余杭区");
  check("非法 credibility 归一为 medium", rep.jobs[2].credibility === "medium");
  check("最终登记 3 个", rep.jobs.length === 3, `实际 ${rep.jobs.length}`);
  check("job 事件 3 个", events.filter((e) => e.type === "job").length === 3);
  check("覆盖城市=杭州", JSON.stringify(rep.cityCoverage) === JSON.stringify(["杭州"]));

  // 末轮请求体包含本轮全部工具回执(每条只出现一次),在这里断言
  const texts = lastToolTexts(ctx);
  const joined = texts.join("\n");
  check("工具回执:登记第 1/2/3 个", joined.includes("已登记第 1 个岗位") && joined.includes("已登记第 2 个岗位") && joined.includes("已登记第 3 个岗位"));
  check("重复 URL 拦截", texts.some((t) => t.includes("与已登记岗位重复")));
  check("同名同公司拦截", texts.filter((t) => t.includes("与已登记岗位重复")).length === 2);
  check("城市闸拦截", texts.some((t) => t.includes("不在用户给定的城市列表内")));
  check("信息不全拦截", texts.some((t) => t.includes("信息不完整")));
}

// ---------- C:abort 兜底 ----------
group("C abort:有岗位兜底出截断报告;零岗位向上抛");
{
  const job = { title: "算法", company: "甲", city: "杭州", sourceUrl: "https://a.com/1", credibility: "high" };
  const ac = new AbortController();
  const ctx = scriptedChat([
    arkResp([tc("r1", "record_job", job)]),
    () => {
      ac.abort(new Error("总超时"));
      const e = new Error("The operation was aborted");
      e.name = "AbortError";
      throw e;
    },
  ]);
  const rep = await runRadarAgent(
    { categories: ["AI/算法"], cities: ["杭州"], jobType: "fulltime" },
    noop,
    ac.signal
  );
  check("已登记岗位保住", rep.jobs.length === 1);
  check("summary 标注中途截断", rep.summary.includes("被中途截断"));
  check("searchCount 归零正常", rep.searchCount === 0);
  check("第二轮前已回传 tool 消息", ctx.bodies[1].messages.some((m) => m.role === "tool"));

  const ac2 = new AbortController();
  scriptedChat([
    () => {
      ac2.abort(new Error("断连"));
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    },
  ]);
  let threw = false;
  try {
    await runRadarAgent({ categories: ["后端"], cities: ["杭州"], jobType: "fulltime" }, noop, ac2.signal);
  } catch {
    threw = true;
  }
  check("零岗位 abort 直接抛错", threw);
}

// ---------- D:搜索预算闸 + 请求体 + 双结构 ----------
group("D 搜索预算(1 组合=4 次封顶,第 5 次不触网)");
{
  const searchResult = okJson({
    Result: { ResultCount: 1, WebResults: [
      { Title: "RAG 岗", Url: "https://x.example.com/rag", Snippet: "要求 LangChain", SiteName: "示例站", PublishTime: "2026-09-10", AuthInfoLevel: 3 },
    ] },
  });
  const ctx = scriptedChat([
    arkResp([1, 2, 3, 4, 5].map((i) => tc(`s${i}`, "search_jobs", { query: `q${i}` }))),
    finish(),
  ]);
  ctx.setSearchResult(searchResult);
  const events = [];
  const repD = await run({ categories: ["AI/算法"], cities: ["杭州"], jobType: "fulltime" }, events);
  check("搜索端点只打 4 次", ctx.searchCalls === 4, `实际 ${ctx.searchCalls}`);
  check("report.searchCount=4 / fetchCount=0", repD.searchCount === 4 && repD.fetchCount === 0);
  const texts = lastToolTexts(ctx);
  check("5 条 tool 结果(第 5 条是预算闸)", texts.length === 5 && texts[4].includes("搜索预算(4 次)已用尽"));
  check("4 条 search 事件", events.filter((e) => e.type === "search").length === 4);
  const se = events.find((e) => e.type === "search");
  check("search 事件字段", se.query === "q1" && se.count === 1 && se.timeRange === "OneMonth" && se.results[0].title === "RAG 岗");
  check("请求体 Query/Count/TimeRange/Filter", ctx.searchBodies[0].Query === "q1" && ctx.searchBodies[0].Count === 10 && ctx.searchBodies[0].TimeRange === "OneMonth" && ctx.searchBodies[0].Filter.NeedUrl === true);
}

group("D2 doubaoSearch 双结构兼容与归一化");
{
  // 旧文档结构 Results + 蛇形字段
  scriptedChat([]);
  globalThis.fetch = async () =>
    okJson({
      Results: [
        { Title: "旧结构", Url: "https://old.example.com", Snippet: "s", SiteName: "老站", PublishTime: "2026-08-01", AuthInfoLevel: "2" },
        { Title: "无链接丢弃" },
      ],
    });
  const old = await doubaoSearch("x");
  check("旧 Results 结构可解析", old.length === 1 && old[0].title === "旧结构");
  check("AuthInfoLevel 字符串→数字", old[0].authLevel === 2 && old[0].publishTime === "2026-08-01");

  globalThis.fetch = async () =>
    okJson({ Result: { WebResults: [{ title: "小写字段", url: "https://n.example.com", snippet: "s", site_name: "新站" }] } });
  const neu = await doubaoSearch("x", { count: 3, sites: ["zhipin.com"] });
  check("新 Result.WebResults 结构可解析", neu[0].url === "https://n.example.com" && neu[0].siteName === "新站");
  let captured;
  globalThis.fetch = async (_u, init) => {
    captured = JSON.parse(init.body);
    return okJson({ Result: { WebResults: [] } });
  };
  await doubaoSearch("y", { count: 3, sites: ["zhipin.com"], timeRange: "OneWeek" });
  check("Count 透传 + Sites 入 Filter + 时间范围", captured.Count === 3 && captured.Filter.Sites[0] === "zhipin.com" && captured.TimeRange === "OneWeek");

  globalThis.fetch = async () =>
    okJson({ Result: { WebResults: Array.from({ length: 25 }, (_, i) => ({ Title: `t${i}`, Url: `https://e.com/${i}` })) } });
  const capped = await doubaoSearch("z");
  check("归一化结果封顶 20 条", capped.length === 20);

  globalThis.fetch = async () => errStatus(500, "boom");
  let err = null;
  try {
    await doubaoSearch("z");
  } catch (e) {
    err = e;
  }
  check("非 2xx 抛「豆包搜索失败」", /豆包搜索失败 500/.test(err?.message ?? "") && err.message.includes("boom"));
}

// ---------- E:fetch-page 预检护栏(不触网) ----------
group("E fetchPage 预检护栏");
{
  scriptedChat([]); // 安装一个会拒绝联网的 mock
  const bad = await fetchPage("not a url");
  check("URL 无法解析", bad.ok === false && bad.error === "URL 无法解析");
  const ftp = await fetchPage("ftp://x.com/a");
  check("协议拒绝", /不支持的协议/.test(ftp.error ?? ""));
  for (const [name, u] of [
    ["localhost", "http://localhost/"],
    ["IPv4 回环", "http://127.0.0.1:8080/"],
    ["元数据地址", "http://169.254.169.254/latest/meta-data"],
    ["内网 A 段", "http://10.1.2.3/"],
    ["内网 B 段", "http://172.20.0.1/"],
    ["内网 C 段", "http://192.168.0.1/"],
    ["IPv6 回环", "http://[::1]/"],
    ["IPv6 链路本地", "http://[fe80::1]/"],
  ]) {
    const r = await fetchPage(u);
    check(`SSRF 拦截 ${name}`, r.ok === false && r.error.includes("内网/本地地址"));
  }
  const outer = await fetchPage("http://172.32.0.1/");
  check("172.32 不属内网段(放行到请求阶段)", outer.ok === false && !outer.error.includes("内网/本地地址"));
}

// ---------- F:ark 协议细节 ----------
group("F chatCompletion 请求/解析契约");
{
  let captured;
  globalThis.fetch = async (_u, init) => {
    captured = JSON.parse(init.body);
    return okJson({ choices: [{ message: { role: "assistant", content: "你好" } }] });
  };
  const r0 = await chatCompletion([{ role: "user", content: "hi" }], []);
  check("空 tools 省略 tools/tool_choice", captured.tools === undefined && captured.tool_choice === undefined);
  check("model/temperature", captured.model === "doubao-seed-evolving" && captured.temperature === 0.2);
  check("纯文本回复", r0.content === "你好" && r0.toolCalls.length === 0);

  globalThis.fetch = async (_u, init) => {
    captured = JSON.parse(init.body);
    return okJson({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              tc("c1", "search_jobs", { query: "杭州 后端 招聘" }),
              { id: "c2", type: "function", function: { name: "bad", arguments: "坏 json{" } },
            ],
          },
        },
      ],
    });
  };
  const r1 = await chatCompletion([], [{ type: "function", function: { name: "x", description: "", parameters: {} } }]);
  check("带工具时 tools/tool_choice 在请求体", captured.tools.length === 1 && captured.tool_choice === "auto");
  check("toolCalls 解析 args;坏 JSON → {}", r1.toolCalls[0].args.query === "杭州 后端 招聘" && JSON.stringify(r1.toolCalls[1].args) === "{}");

  globalThis.fetch = async () => errStatus(429, "rate limited");
  let err = null;
  try {
    await chatCompletion([], []);
  } catch (e) {
    err = e;
  }
  check("非 2xx 抛「模型接口 429」", /模型接口 429/.test(err?.message ?? ""));
}

// ---------- G:buildSkillRanking ----------
group("G 技能词频:别名归一/岗内去重/同频稳定序/limit");
{
  const jobs = [
    { skills: ["Node.js", "React", "Node.js"], city: "杭州", company: "a", title: "1", salary: "", sourceUrl: "https://e.com/1", sourceName: "", publishedAt: "", credibility: "medium" },
    { skills: ["node", "K8s", "k8s"], city: "杭州", company: "b", title: "2", salary: "", sourceUrl: "https://e.com/2", sourceName: "", publishedAt: "", credibility: "medium" },
  ];
  const rank = buildSkillRanking(jobs);
  check("node.js 跨别名合计 2(展示名取首次原文 Node.js)", rank[0].skill === "Node.js" && rank[0].count === 2);
  const rest = Object.fromEntries(rank.map((r) => [r.skill, r.count]));
  check("K8s/k8s 归一 kubernetes 且岗内去重=1", rest["kubernetes"] === 1);
  check("React=1", rest["React"] === 1);
  const tie = rank.slice(1).map((r) => r.skill);
  check("同频按首次出现序(React 先于 kubernetes)", JSON.stringify(tie) === JSON.stringify(["React", "kubernetes"]), tie.join(","));
  check("limit 生效", buildSkillRanking(jobs, 2).length === 2);
}

// ---------- H:chatVision 请求形态 ----------
group("H chatVision 多模态请求");
{
  let captured;
  globalThis.fetch = async (_u, init) => {
    captured = JSON.parse(init.body);
    return okJson({ choices: [{ message: { content: '{"skills":[]}' } }] });
  };
  const out = await chatVision([
    { role: "system", content: "sys" },
    { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,x" } }] },
  ]);
  check("请求无 tools 字段", captured.tools === undefined && captured.model === "doubao-seed-evolving");
  check("image_url 透传 + 文本返回", JSON.stringify(captured.messages[1].content).includes("image_url") && out.includes("skills"));
}

// ---------- I:plan 独白结束循环 ----------
group("I 模型不调工具只说话 → plan 事件 + 用其文案收尾");
{
  const ctx = scriptedChat([arkResp([], "我先规划一下:重点搜杭州。")]);
  const events = [];
  const rep = await run({ categories: ["后端"], cities: ["杭州"], jobType: "fulltime" }, events);
  check("只调 1 轮模型", ctx.bodies.length === 1);
  check("plan 事件截断 300 字", events[0].type === "plan" && events[0].text.startsWith("我先规划一下"));
  check("summary 取独白", rep.summary === "我先规划一下:重点搜杭州。");
  check("空岗位兜底文案不覆盖独白", !rep.summary.includes("未收集到岗位"));
}

console.log(`\n${fail === 0 ? "全部通过 ✅" : "存在失败 ❌"}:${pass} 通过,${fail} 失败`);
process.exit(fail ? 1 : 0);
