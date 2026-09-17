// 探针:方舟 Agent Plan 的 Anthropic 协议端点是否支持服务端 web_search 工具,
// 流式返回里是否吐出「搜索词/结果URL」事件(决定能否保留雷达打点+来源白名单)。
// 用法:node scripts/probe-websearch-tool.mjs  (从 jobradar 目录)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const env = {};
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf-8").split(/\r?\n/)) {
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
    max_tokens: 1024,
    stream: true,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }],
    messages: [
      {
        role: "user",
        content: "联网搜索「北京 后端开发 社招 招聘」,从结果里列 2 个真实在招岗位,每个带来源链接。",
      },
    ],
  }),
});

console.log("HTTP", res.status);
if (!res.ok) {
  console.log((await res.text()).slice(0, 500));
  process.exit(1);
}

// 原样落盘事件流,只打印事件类型统计与关键片段
const events = [];
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
    if (line.startsWith("data: ")) {
      try {
        events.push(JSON.parse(line.slice(6)));
      } catch {}
    }
  }
}
mkdirSync(resolve(process.cwd(), "scripts/out"), { recursive: true });
writeFileSync(resolve(process.cwd(), "scripts/out/websearch-probe-events.json"), JSON.stringify(events, null, 2));
const kinds = {};
for (const e of events) kinds[e.type] = (kinds[e.type] ?? 0) + 1;
console.log("事件类型统计:", kinds);
for (const e of events) {
  const s = JSON.stringify(e);
  if (/web_search|query|url/i.test(s) && s.length < 400) console.log("·", s);
}
