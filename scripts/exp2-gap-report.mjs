// 浅实验 2:多工具协同极限
// 目的:验证第三次更新宣称的「工具调用 & 复杂任务」——给模型两个异构工具
// (read_local_file 读本地简历 + web_search 联网搜 JD),发一条模糊指令:
// 「读我的简历 + 结合网上当前 AI 岗位要求 → 生成我与市场的差距报告」。
// 观察模型是否自主完成:读文件 → 提炼技能 → 搜索 JD → 对比 → 输出结构化报告。
// 用法:node scripts/exp2-gap-report.mjs
// 输出:experiments/exp2-gap-report/transcript.md(完整对话)+ report.md(最终报告)

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "experiments", "exp2-gap-report");
const RESUME = join(ROOT, "experiments", "sample-resume.txt");

// ---------- 环境配置 ----------
function loadEnv() {
  const txt = readFileSync(join(ROOT, ".env.local"), "utf8");
  const m = txt.match(/^ARK_API_KEY=(.+)$/m);
  if (!m) throw new Error(".env.local 中未找到 ARK_API_KEY");
  return m[1].trim();
}
const KEY = loadEnv();
const MODEL = "doubao-seed-evolving";
const ARK_BASE = "https://ark.cn-beijing.volces.com/api/plan/v3";
const SEARCH_API = "https://open.feedcoopapi.com/search_api/web_search";

// ---------- 模型调用 ----------
async function chat(messages, tools) {
  const res = await fetch(`${ARK_BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages,
      tools,
      tool_choice: "auto",
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(240_000),
  });
  if (!res.ok) throw new Error(`模型接口 ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const msg = data?.choices?.[0]?.message ?? {};
  return {
    content: typeof msg.content === "string" ? msg.content : "",
    toolCalls: (msg.tool_calls ?? []).map((tc) => {
      let args = {};
      try {
        args = JSON.parse(tc.function?.arguments || "{}");
      } catch {}
      return { id: String(tc.id ?? ""), name: String(tc.function?.name ?? ""), args };
    }),
  };
}

// ---------- 豆包搜索 ----------
async function webSearch(query, timeRange = "OneMonth", count = 8) {
  const res = await fetch(SEARCH_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      Query: query,
      SearchType: "web",
      Count: count,
      Filter: { NeedContent: false, NeedUrl: true },
      NeedSummary: true,
      TimeRange: timeRange,
      QueryControl: { QueryRewrite: true },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) return `搜索接口错误 ${res.status}`;
  const data = await res.json();
  const raw = data?.Result?.WebResults ?? [];
  if (!Array.isArray(raw) || raw.length === 0) return "(无结果)";
  return raw
    .map(
      (i) =>
        `[${i.PublishTime ?? "时间未知"}] ${i.Title}\n${i.Snippet ?? i.Summary ?? ""}\n来源:${i.SiteName ?? "?"} | 权威性:${i.AuthInfoLevel ?? "?"}\n${i.Url}`
    )
    .join("\n\n");
}

// ---------- 系统提示词 ----------
const SYSTEM = `你是一名严谨的求职调研助理,配有两个工具:
- read_local_file:读取用户本地文本文件(如简历)
- web_search:联网搜索(如搜索招聘 JD)

任务背景:用户想转向 AI/大模型方向,给了你一份他的简历文件。你要读简历、结合网上当前真实的招聘要求,写一份「我与市场的差距」报告。

【真实性纪律】:
1. 报告中的市场要求必须来自 web_search 的真实结果,每条尽量附来源 URL;搜不到的就写「未找到可靠数据」,严禁编造 JD 要求、薪资数字。
2. 简历信息只以 read_local_file 读到的内容为准,不要凭空推测用户会什么。
3. 对比要具体到技能点:用户简历里明确没有的技能,如实列出。
4. 最终输出一份结构化的差距报告,而不是继续调用工具。

【过程要求】:
- 先读文件,再根据简历内容决定搜什么 JD(自行拆解任务步骤,不要问用户)。
- 搜索词要具体,如「大模型应用开发 招聘」「AI 应用工程师 JD」等;
- 报告结构建议:一、市场要求概览(带来源);二、我的现状(来自简历);三、差距清单(按优先级);四、接下来 3-6 个月的补强建议。`;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "read_local_file",
      description: "读取用户本地文本文件,返回文件内容。path 需为相对 jobradar 目录的路径。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "文件路径,如 experiments/sample-resume.txt" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "联网搜索。参数:query 搜索词;timeRange 时间范围(OneDay/OneWeek/OneMonth/OneYear);count 条数。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索词" },
          timeRange: { type: "string", enum: ["OneDay", "OneWeek", "OneMonth", "OneYear"] },
          count: { type: "integer", description: "条数,默认 8" },
        },
        required: ["query"],
      },
    },
  },
];

const USER = `我的简历放在 experiments/sample-resume.txt。帮我读一下,再结合网上当前的 AI 相关岗位招聘要求,写一份「我与市场的差距」报告,告诉我接下来该补什么。`;

const MAX_ITERS = 12; // 最多 12 轮
const MAX_SEARCHES = 6; // 搜索预算
const MAX_READS = 2; // 读文件预算

function readLocalFile(pathArg) {
  const p = String(pathArg ?? "").trim();
  if (!p) return "缺少 path 参数";
  const abs = resolve(ROOT, p);
  const allowed = resolve(ROOT, "experiments") + sep;
  if (!abs.startsWith(allowed)) return `拒绝:只允许读取 ${allowed} 目录下的文件`;
  try {
    const txt = readFileSync(abs, "utf8").slice(0, 12000);
    return `文件 ${p} 内容(${txt.length} 字符):\n${txt}`;
  } catch (e) {
    return `读取失败:${String(e?.message ?? e).slice(0, 200)}`;
  }
}

// ---------- 主流程 ----------
mkdirSync(OUT_DIR, { recursive: true });
const md = [
  `# 浅实验 2:多工具协同极限`,
  ``,
  `- 时间:${new Date().toISOString()}`,
  `- 模型:${MODEL}`,
  `- 工具:read_local_file + web_search`,
  `- 预算:最多 ${MAX_ITERS} 轮 / ${MAX_SEARCHES} 次搜索 / ${MAX_READS} 次读文件`,
  ``,
  `## 用户指令(模糊指令)`,
  ``,
  USER,
  ``,
];
const consoleOut = [`===== 浅实验 2:多工具协同 =====`, `Q: ${USER}`];

const messages = [
  { role: "system", content: SYSTEM },
  { role: "user", content: USER },
];
let searches = 0;
let reads = 0;
let finalAnswer = "";

for (let iter = 0; iter < MAX_ITERS; iter++) {
  consoleOut.push(`--- 第 ${iter + 1} 轮模型调用 ---`);
  const res = await chat(messages, TOOLS);
  if (res.content) {
    md.push(`## 第 ${iter + 1} 轮 · 模型回复`, ``, res.content, ``);
    consoleOut.push(`[模型文字] ${res.content.slice(0, 100)}`);
  }

  if (res.toolCalls.length === 0) {
    finalAnswer = res.content;
    consoleOut.push("[无工具调用,任务结束]");
    break;
  }

  messages.push({
    role: "assistant",
    content: res.content || null,
    tool_calls: res.toolCalls.map((tc) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: JSON.stringify(tc.args) },
    })),
  });

  for (const call of res.toolCalls) {
    let toolText;
    if (call.name === "read_local_file") {
      if (reads >= MAX_READS) {
        toolText = "读文件预算已用尽。请基于已读到的内容继续。";
      } else {
        reads++;
        const p = String(call.args.path ?? "");
        md.push(`## 第 ${iter + 1} 轮 · 工具调用`, ``, `read_local_file(path="${p}")`, ``);
        consoleOut.push(`[read_local_file] ${p}`);
        toolText = readLocalFile(p);
        md.push(`### 文件内容`, ``, toolText, ``);
      }
    } else if (call.name === "web_search") {
      if (searches >= MAX_SEARCHES) {
        toolText = "搜索预算已用尽(最多 6 次)。请基于已有信息直接输出报告。";
      } else {
        searches++;
        const q = String(call.args.query ?? "");
        const tr = String(call.args.timeRange ?? "OneMonth");
        const n = Math.min(Math.max(Number(call.args.count ?? 8) || 8, 1), 10);
        md.push(`## 第 ${iter + 1} 轮 · 工具调用`, ``, `web_search(query="${q}", timeRange=${tr}, count=${n})`, ``);
        consoleOut.push(`[web_search] ${q} (${tr})`);
        toolText = await webSearch(q, tr, n);
        md.push(`### 搜索结果`, ``, toolText, ``);
      }
    } else {
      toolText = `未知工具:${call.name}`;
    }
    messages.push({ role: "tool", tool_call_id: call.id, content: toolText.slice(0, 10000) });
  }
}

if (!finalAnswer) finalAnswer = messages.filter((m) => m.role === "assistant").pop()?.content ?? "(轮次用尽)";
md.push(`## 最终报告(模型输出)`, ``, finalAnswer, ``);
writeFileSync(join(OUT_DIR, "transcript.md"), md.join("\n"), "utf8");
writeFileSync(join(OUT_DIR, "report.md"), finalAnswer, "utf8");

consoleOut.push(`统计:读文件 ${reads} 次,搜索 ${searches} 次`);
consoleOut.push(`A: ${finalAnswer.slice(0, 500)}`);
console.log(consoleOut.join("\n"));
console.log(`完整记录:experiments/exp2-gap-report/transcript.md`);
console.log(`最终报告:experiments/exp2-gap-report/report.md`);
