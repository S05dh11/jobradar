// 探针:服务端 web_search 搜索发生后,模型「当轮」能否看到结果的标题和 URL?
// 判定:模型正文里逐字出现流内捕获到的 web_search_result.url → 当轮可见(跨轮失忆只是回显问题);
//      模型只说搜到了但给不出 URL/编造 URL → 当轮也不可见,该链路无法支撑来源引用,需回退。
// 用法:node scripts/probe-inturn-visibility.mjs
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const env = {};
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("=");
  if (i > 0) env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
}
const KEY = env.ARK_API_KEY;

const res = await fetch("https://ark.cn-beijing.volces.com/api/plan/v1/messages", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${KEY}`,
    "anthropic-version": "2023-06-01",
  },
  body: JSON.stringify({
    model: "doubao-seed-evolving",
    max_tokens: 2048,
    stream: true,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }],
    messages: [
      {
        role: "user",
        content:
          "请联网搜索「杭州 Java 后端 招聘」。搜索完成后,把你实际看到的前 3 条搜索结果的标题和完整网址原样列出来,一条一行。不要编造,只列搜索结果里真实存在的。",
      },
    ],
  }),
});
if (!res.ok) {
  console.log("HTTP", res.status, (await res.text()).slice(0, 300));
  process.exit(1);
}
const blocks = new Map();
let text = "";
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = "";
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line.startsWith("data: ")) continue;
    let e;
    try {
      e = JSON.parse(line.slice(6));
    } catch {
      continue;
    }
    if (e.type === "content_block_start") {
      const b = e.content_block ?? {};
      blocks.set(e.index, {
        type: b.type,
        urls: Array.isArray(b.content) ? b.content.filter((r) => r?.url).map((r) => r.url) : undefined,
      });
    } else if (e.type === "content_block_delta" && e.delta?.type === "text_delta") {
      text += e.delta.text ?? "";
    }
  }
}
const streamUrls = [...blocks.values()].find((b) => b.type === "web_search_tool_result")?.urls ?? [];
console.log("流内捕获结果 URL:");
streamUrls.slice(0, 3).forEach((u) => console.log("  ·", u));
console.log("\n模型正文:\n" + text.trim());
const hits = streamUrls.filter((u) => text.includes(u));
console.log(`\n判定:模型正文命中流内 URL ${hits.length}/${Math.min(3, streamUrls.length)}`, hits.length > 0 ? "→ ✅ 当轮可见" : "→ ❌ 当轮不可见");
process.exit(hits.length > 0 ? 0 : 3);
