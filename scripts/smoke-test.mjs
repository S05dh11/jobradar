// 连通性冒烟测试:模型 chat/completions + 豆包搜索各一次
// 用法:node scripts/smoke-test.mjs  (从 jobradar 目录)
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// 从 .env.local 读取 Key(不打印)
function loadEnv(path) {
  const out = {};
  for (const line of readFileSync(path, "utf-8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

const env = loadEnv(resolve(process.cwd(), ".env.local"));
const KEY = env.ARK_API_KEY;
const BASE = env.ARK_BASE_URL ?? "https://ark.cn-beijing.volces.com/api/plan/v3";
const MODEL = env.ARK_MODEL ?? "doubao-seed-evolving";

if (!KEY) {
  console.error("FAIL: .env.local 中没有 ARK_API_KEY");
  process.exit(1);
}
console.log(`Key: ${"*".repeat(12)}${KEY.slice(-4)}  (长度 ${KEY.length})`);
console.log(`端点: ${BASE}  模型: ${MODEL}\n`);

// 1) 模型对话
console.log("[1/2] 模型 chat/completions ...");
try {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: "用一句话介绍你自己,不超过20字。" }],
      temperature: 0.2,
    }),
  });
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  console.log(
    `  OK (${((Date.now() - t0) / 1000).toFixed(1)}s): ${data?.choices?.[0]?.message?.content ?? JSON.stringify(data).slice(0, 200)}`
  );
} catch (e) {
  console.error("  FAIL:", e.message);
  process.exit(1);
}

// 2) 豆包搜索
console.log("[2/2] 豆包搜索 open.feedcoopapi.com ...");
try {
  const t0 = Date.now();
  const res = await fetch("https://open.feedcoopapi.com/search_api/web_search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      Query: "杭州 后端工程师 招聘",
      SearchType: "web",
      Count: 5,
      Filter: { NeedContent: false, NeedUrl: true },
      NeedSummary: true,
      TimeRange: "OneMonth",
      QueryControl: { QueryRewrite: true },
    }),
  });
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  // 兼容新旧两种响应结构(2026-09-07 起实测为 { Result: { ResultCount, WebResults } })
  const raw =
    data?.Result?.WebResults ??
    data?.result?.web_results ??
    data?.Results ??
    data?.results ??
    data?.data?.results ??
    data?.data?.Results ??
    [];
  console.log(`  OK (${((Date.now() - t0) / 1000).toFixed(1)}s): 返回 ${Array.isArray(raw) ? raw.length : "?"} 条`);
  if (Array.isArray(raw)) {
    for (const r of raw.slice(0, 3)) {
      console.log(`    - ${String(r?.Title ?? r?.title ?? "?").slice(0, 50)} | ${String(r?.SiteName ?? r?.site_name ?? "?").slice(0, 20)} | ${String(r?.Url ?? r?.url ?? "?").slice(0, 60)}`);
    }
  } else {
    console.log("  响应结构:", JSON.stringify(data).slice(0, 400));
  }
} catch (e) {
  console.error("  FAIL:", e.message);
  process.exit(1);
}

console.log("\n全部通过 ✅");
