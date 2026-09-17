// 简历诊断 API 实测脚本(需 dev server + 配好 ARK_API_KEY,由监工执行:会真实调用视觉模型,
// 且判断轮可能触发最多 3 次搜索,会消耗搜索额度)
// 协议:成功时端点返回 text/event-stream,事件序列 stage/search(0-3 次)/retry(偶发)/done/error
// 1) 正常图 → 解析 SSE,断言 done.report 六块数据 + 证据标签合规 + searches≤3 + stages 数值
// 2) 6MB 大图 → 开流前拦截,期望 413 + JSON {error}
// 用法:node scripts/diag-test.mjs(需 dev server 在 localhost:3000)
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PNG = join(ROOT, "scripts", "out", "test-resume.png");
const API = process.env.DIAG_API ?? "http://localhost:3000/api/diagnose";
const ALLOWED_EVIDENCE = ["resume", "market_pool", "search"];

const fakeJobs = [
  {
    title: "Java 后端开发工程师",
    company: "示例公司甲",
    city: "杭州",
    salary: "25-40k",
    skills: ["Java", "Spring Boot", "MySQL", "Redis", "微服务"],
    sourceUrl: "https://example.com/job/1",
    sourceName: "示例来源",
    publishedAt: "2026-09-01",
    credibility: "medium",
  },
  {
    title: "Golang 后端工程师",
    company: "示例公司乙",
    city: "杭州",
    salary: "20-35k",
    skills: ["Go", "MySQL", "Redis", "Kafka", "Kubernetes"],
    sourceUrl: "https://example.com/job/2",
    sourceName: "示例来源",
    publishedAt: "2026-09-02",
    credibility: "medium",
  },
  {
    title: "Python 后端工程师",
    company: "示例公司丙",
    city: "杭州",
    salary: "18-30k",
    skills: ["Python", "FastAPI", "MySQL", "Redis"],
    sourceUrl: "https://example.com/job/3",
    sourceName: "示例来源",
    publishedAt: "2026-09-03",
    credibility: "medium",
  },
];

// 读 SSE 流,收集事件;done 返回 report,error 抛错
async function consumeSse(res, events) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const ev = JSON.parse(line.slice(5).trim());
        events.push(ev);
        if (ev.type === "done") return ev.report;
        if (ev.type === "error") throw new Error(ev.message);
      }
    }
  }
  return null;
}

// ---- 1) 正常简历图 ----
console.log("== 测试 1:正常简历图(SSE 三段式) ==");
let report;
const events = [];
try {
  const imgB64 = readFileSync(PNG).toString("base64");
  const dataURL = `data:image/png;base64,${imgB64}`;
  console.log(`  图片 dataURL 长度:${dataURL.length}(约 ${(imgB64.length * 0.75 / 1024).toFixed(0)}KB)`);

  const t0 = Date.now();
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: dataURL, jobs: fakeJobs }),
  });
  if (!res.ok || !res.body) {
    const t = await res.text();
    console.error(`FAIL: 开流失败 HTTP ${res.status}:\n${t.slice(0, 400)}`);
    process.exit(1);
  }
  report = await consumeSse(res, events);
  if (!report) {
    console.error("FAIL: 流结束但未收到 done 事件");
    process.exit(1);
  }
  console.log(`  事件序列:${events.map((e) => (e.type === "search" ? `search(${e.query})` : e.type)).join(" → ")}`);
  console.log(`  总耗时:${((Date.now() - t0) / 1000).toFixed(1)}s`);
} catch (e) {
  console.error("FAIL: 请求异常:" + String(e?.message ?? e));
  process.exit(1);
}

// ---- done.report 契约检查 ----
const fail = (m) => {
  console.error("FAIL: " + m);
  process.exit(1);
};
if (typeof report.conclusion !== "string" || !report.conclusion) fail("conclusion 缺失");
if (!Array.isArray(report.searches) || report.searches.length > 3)
  fail(`searches 不合规:${JSON.stringify(report.searches)}`);
if (
  !report.stages ||
  typeof report.stages.extractMs !== "number" ||
  typeof report.stages.agentMs !== "number"
)
  fail("stages 缺失或不是数值");
for (const [name, list] of [
  ["hit", report.hit],
  ["gaps", report.gaps],
]) {
  if (!Array.isArray(list)) fail(`${name} 不是数组`);
  for (const it of list) {
    if (!it.skill || !ALLOWED_EVIDENCE.includes(it.evidence))
      fail(`${name} 条目证据标签不合规:${JSON.stringify(it)}`);
    if (it.evidence === "search" && !it.url) fail(`${name} 标 search 却无 url:${it.skill}`);
    if (it.evidence !== "search" && it.url) fail(`${name} 非 search 条目不应带 url:${it.skill}`);
  }
}
if (!report.target || !ALLOWED_EVIDENCE.includes(report.target.evidence))
  fail("target 证据标签不合规");
if (report.target.evidence === "search" && !report.target.url) fail("target 标 search 却无 url");

console.log("  契约 OK。诊断内容:");
console.log(
  `    extracted: ${(report.extracted?.skills ?? []).join("/") || "未识别技能"} | 学历 ${report.extracted?.education ?? "未识别"} | 年限 ${report.extracted?.years ?? "未识别"}${report.extracted?.degreeYear ? ` | 届别 ${report.extracted.degreeYear}` : ""}`
);
console.log(
  `    hit: ${report.hit.map((h) => `${h.skill}${h.rank ? "@TOP" + h.rank : ""}[${h.evidence}]`).join(", ") || "无"}`
);
console.log(`    gaps: ${report.gaps.map((g) => `${g.skill}[${g.evidence}]`).join(" | ") || "无"}`);
console.log(
  `    target: ${report.target.category} / ${report.target.city} [${report.target.evidence}] | 依据:${(report.target.reason ?? "").slice(0, 60)}`
);
console.log(
  `    searches: ${report.searches.length} 次 ${report.searches.map((s) => "「" + s.query + "」").join(" ")}`
);
console.log(
  `    stages: 提取 ${(report.stages.extractMs / 1000).toFixed(1)}s · 分析 ${(report.stages.agentMs / 1000).toFixed(1)}s`
);
console.log(`    conclusion: ${report.conclusion}`);

// ---- 2) 超限大图拦截(>5MB → base64 >7M 字符,开流前必须触发 413) ----
console.log("\n== 测试 2:超限大图拦截 ==");
const bigDataURL = "data:image/png;base64," + "A".repeat(8 * 1024 * 1024); // ≈6MB 图片
const res2 = await fetch(API, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ image: bigDataURL, jobs: fakeJobs }),
});
const body2 = await res2.text();
console.log(`  状态:${res2.status}(期望 413)  CT:${res2.headers.get("content-type")}`);
console.log(`  响应:${body2.slice(0, 150)}`);
if (res2.status !== 413 || !res2.headers.get("content-type")?.includes("application/json")) {
  console.error("FAIL: 大图未被开流前拦截为 413 JSON");
  process.exit(1);
}

console.log("\n全部通过 ✅");
await sleep(300);
