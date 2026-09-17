// 探针:把 server_tool_use + web_search_tool_result 块回显进 assistant 历史,端点是否接受、模型能否读到。
// 背景:toAnthropicMessages 重建历史只回传 text+tool_use,服务端搜索块被丢 → 模型下一轮"失忆"
// (run2 实测:模型自述"搜索结果未回传可引用的真实URL",只登记 1 岗)。
// 判定:①HTTP 400/422 → 端点拒绝回显,不能用;②模型答出第一轮捕获的精确 URL → 回显生效;
// ③模型答不知 → 块被静默剥离。用法:node scripts/probe-echo-search-blocks.mjs
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
const BASE = "https://ark.cn-beijing.volces.com/api/plan/v1/messages";
const HEADERS = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${KEY}`,
  "anthropic-version": "2023-06-01",
};

async function call(body) {
  const res = await fetch(BASE, { method: "POST", headers: HEADERS, body: JSON.stringify(body) });
  if (!res.ok) return { error: `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}` };
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
  return { events };
}

function fold(events) {
  const blocks = new Map();
  let text = "";
  for (const e of events) {
    if (e.type === "content_block_start") {
      const b = e.content_block ?? {};
      blocks.set(e.index, {
        type: b.type,
        name: b.name,
        id: b.id ?? b.tool_use_id,
        inputJson: "",
        results: Array.isArray(b.content)
          ? b.content.filter((r) => r?.type === "web_search_result" && r?.url) // 原样保留全部字段(含 encrypted_content,回显凭据)
          : undefined,
        caller: b.caller,
      });
    } else if (e.type === "content_block_delta") {
      const b = blocks.get(e.index);
      if (!b) continue;
      const d = e.delta ?? {};
      if (d.type === "text_delta") { b.text = (b.text ?? "") + (d.text ?? ""); text += d.text ?? ""; }
      if (d.type === "input_json_delta") b.inputJson += d.partial_json ?? "";
    }
  }
  return { blocks: [...blocks.values()], text };
}

// ---- 第 1 轮:搜索,但禁止模型在正文里输出任何 URL ----
console.log("=== 第 1 轮:搜索(模型不得输出 URL) ===");
const r1 = await call({
  model: "doubao-seed-evolving",
  max_tokens: 2048,
  stream: true,
  tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }],
  messages: [{ role: "user", content: "联网搜索「杭州 Java 后端 招聘」。不要在回复正文里输出任何链接或网址,只回复『已搜索』三个字。" }],
});
if (r1.error) { console.log("第 1 轮失败:", r1.error); process.exit(1); }
const f1 = fold(r1.events);
const searchUse = f1.blocks.find((b) => b.type === "server_tool_use");
const searchRes = f1.blocks.find((b) => b.type === "web_search_tool_result");
console.log("第 1 轮模型正文:", JSON.stringify(f1.text.trim().slice(0, 120)));
if (!searchUse || !searchRes || !searchRes.results?.length) {
  console.log("!! 未捕获到搜索块,探针无效", { searchUse, searchRes });
  process.exit(1);
}
let query = "";
try { query = JSON.parse(searchUse.inputJson || "{}").query ?? ""; } catch {}
console.log(`捕获: query=${JSON.stringify(query)} id=${searchUse.id} 结果数=${searchRes.results.length}`);
console.log("第一条结果:", searchRes.results[0].title, "|", searchRes.results[0].url);
if (/https?:\/\//.test(f1.text)) console.log("⚠ 第 1 轮正文泄漏了 URL,若第 2 轮答对则判定不严谨");

// ---- 第 2 轮:回显搜索块,问 URL ----
console.log("\n=== 第 2 轮:回显搜索块 ===");
const echoAssistant = {
  role: "assistant",
  content: [
    { type: "server_tool_use", id: searchUse.id, name: "web_search", input: { query } },
    { type: "web_search_tool_result", tool_use_id: searchUse.id, content: searchRes.results, ...(searchRes.caller ? { caller: searchRes.caller } : {}) },
    { type: "text", text: f1.text.trim() || "已搜索" },
  ],
};
const r2 = await call({
  model: "doubao-seed-evolving",
  max_tokens: 512,
  stream: true,
  messages: [
    { role: "user", content: "联网搜索「杭州 Java 后端 招聘」。不要在回复正文里输出任何链接或网址,只回复『已搜索』三个字。" },
    echoAssistant,
    { role: "user", content: "刚才第一条搜索结果的完整网址是什么?只输出那个 URL,不要联网搜索,不要输出其他内容。" },
  ],
});
if (r2.error) { console.log("第 2 轮被拒(端点不接受回显):", r2.error); process.exit(2); }
const f2 = fold(r2.events);
console.log("第 2 轮模型回答:", JSON.stringify(f2.text.trim().slice(0, 200)));
const target = searchRes.results[0].url;
const answered = f2.text.includes(target);
console.log(answered ? "\n✅ 回显生效:模型答出了第 1 轮捕获的精确 URL" : `\n❌ 回显未生效(或被剥离):模型没答出 ${target}`);
process.exit(answered ? 0 : 3);
