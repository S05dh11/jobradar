// 方舟 Agent Plan · Anthropic Messages 协议(/api/plan/v1/messages)流式传输层
// 服务端 web_search 工具(search 发生在模型侧,不烧豆包搜索 500 次/月配额):
//   - server_tool_use 的 query 流式回调 → 雷达飞行/时间线搜索事件
//   - web_search_tool_result 的 title+url 回调 → 来源白名单(服务端可硬校验 sourceUrl)
//   - max_uses 由方舟服务端硬执行(搜索预算),超限的调用返回 max_uses_exceeded
// 对外返回与 ark.ts 的 chatCompletion 同构({content, toolCalls}),agent 主循环无感切换。
// 客户端工具(record_job/finish/fetch_page)走 Anthropic 自定义工具,与服务端搜索混用。

import { getArkKey } from "./ark";
import type { ChatMessage, ToolDef, ToolCall } from "./ark";

const ANTHROPIC_BASE = process.env.ARK_ANTHROPIC_BASE ?? "https://ark.cn-beijing.volces.com/api/plan";

export interface AnthropicChatOptions {
  system: string;
  tools: ToolDef[]; // 客户端工具(OpenAI 风格定义,这里转 Anthropic custom tool)
  webSearchMaxUses: number; // 服务端搜索预算(硬执行)
  signal?: AbortSignal;
  onNote?: (text: string) => void;
  onSearchStart?: (id: string, query: string) => void;
  onSearchResults?: (id: string, results: { title: string; url: string }[]) => void;
}

export interface AnthropicChatResult {
  content: string; // 最终文本(text 块拼接)
  toolCalls: ToolCall[]; // 客户端工具调用(record_job/finish/fetch_page)
}

interface StreamBlock {
  type: string; // thinking | text | server_tool_use | web_search_tool_result | tool_use
  text: string; // text 块累积
  name?: string; // tool 名
  id?: string; // tool_use id
  inputJson: string; // tool_use 的 input 累积
  resultUrls?: { title: string; url: string }[];
}

// 重试策略与 v3 传输层一致:429/5xx 指数退避;这里请求更重(流式+服务端搜索),超时放宽
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const BACKOFF_MS = [5000, 15000, 30000, 60000, 90000];
const ATTEMPT_TIMEOUT_MS = 240_000; // 服务端搜索 + 深度思考,单次整体放宽

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// OpenAI 风格 messages → Anthropic 格式(system 单列;assistant 的 tool_calls 转为
// tool_use 块;tool 消息转为 user 侧 tool_result 块——Anthropic 要求 tool_result
// 必须紧跟在含对应 tool_use 的 assistant 消息之后)
function toAnthropicMessages(messages: ChatMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role === "system") continue; // system 走顶层字段
    if (m.role === "user") {
      out.push({ role: "user", content: typeof m.content === "string" ? m.content : String(m.content ?? "") });
    } else if (m.role === "assistant") {
      const blocks: unknown[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of (m.tool_calls ?? []) as { id: string; function: { name: string; arguments: string } }[]) {
        blocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input: safeJson(tc.function.arguments),
        });
      }
      out.push({ role: "assistant", content: blocks.length ? blocks : [{ type: "text", text: "" }] });
    } else if (m.role === "tool") {
      // Anthropic: tool 结果作为 user 消息里的 tool_result 块
      out.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: m.tool_call_id ?? "", content: m.content ?? "" }],
      });
    }
  }
  return out;
}

function safeJson(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export async function chatAnthropic(
  messages: ChatMessage[],
  opts: AnthropicChatOptions
): Promise<AnthropicChatResult> {
  const system = opts.system;
  const body = {
    model: process.env.ARK_MODEL ?? "doubao-seed-evolving",
    max_tokens: 8192,
    stream: true,
    system,
    messages: toAnthropicMessages(messages),
    tools: [
      {
        type: "web_search_20250305",
        name: "web_search",
        max_uses: opts.webSearchMaxUses,
      },
      ...opts.tools.map((t) => ({
        type: "custom",
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      })),
    ],
  };
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${getArkKey()}`,
    "anthropic-version": "2023-06-01",
  };

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    if (attempt > 0) {
      opts.onNote?.(`模型接口限流/超时,退避 ${Math.round(BACKOFF_MS[attempt - 1] / 1000)}s 后第 ${attempt + 1} 次尝试`);
      await sleep(BACKOFF_MS[attempt - 1], opts.signal);
    }
    let res: Response;
    try {
      res = await fetch(`${ANTHROPIC_BASE}/v1/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: opts.signal
          ? AbortSignal.any([opts.signal, AbortSignal.timeout(ATTEMPT_TIMEOUT_MS)])
          : AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      });
    } catch (e: any) {
      if (String(e?.name) === "AbortError" && opts.signal?.aborted) throw e;
      lastError = e instanceof Error ? e : new Error(String(e));
      continue;
    }
    if (!res.ok || !res.body) {
      const detail = (await res.text()).slice(0, 300);
      lastError = new Error(`模型接口(Anthropic) ${res.status}: ${detail}`);
      if (RETRYABLE_STATUS.has(res.status)) continue;
      throw lastError;
    }

    // ---------- 流式解析 ----------
    const blocks = new Map<number, StreamBlock>();
    const toolCalls: ToolCall[] = [];
    let textOut = "";
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data: ")) continue;
        let ev: any;
        try {
          ev = JSON.parse(line.slice(6));
        } catch {
          continue;
        }
        if (ev.type === "content_block_start") {
          const b = ev.content_block ?? {};
          const urls = Array.isArray(b.content)
            ? b.content
                .filter((r: any) => r?.type === "web_search_result" && r?.url)
                .map((r: any) => ({ title: String(r.title ?? ""), url: String(r.url) }))
            : undefined;
          blocks.set(ev.index, {
            type: b.type ?? "text",
            text: b.text ?? "",
            name: b.name,
            id: b.id ?? b.tool_use_id,
            inputJson: "",
            resultUrls: urls,
          });
          if (b.type === "web_search_tool_result" && urls) {
            opts.onSearchResults?.(String(b.tool_use_id ?? ""), urls);
          }
        } else if (ev.type === "content_block_delta") {
          const b = blocks.get(ev.index);
          const d = ev.delta ?? {};
          if (!b) continue;
          if (d.type === "text_delta") {
            b.text += d.text ?? "";
            textOut += d.text ?? "";
          } else if (d.type === "input_json_delta") {
            b.inputJson += d.partial_json ?? "";
          }
        } else if (ev.type === "content_block_stop") {
          const b = blocks.get(ev.index);
          if (b?.type === "tool_use" && b.id && b.name) {
            toolCalls.push({ id: b.id, name: b.name, args: safeJson(b.inputJson) });
          }
          // web_search 的 query 在 input 流完后才完整,此刻上报
          if (b?.type === "server_tool_use" && b.name === "web_search" && b.id) {
            const q = safeJson(b.inputJson).query;
            if (typeof q === "string" && q) opts.onSearchStart?.(b.id, q);
          }
        } else if (ev.type === "error") {
          lastError = new Error(`模型接口(Anthropic) 流内错误: ${JSON.stringify(ev.error ?? ev).slice(0, 200)}`);
        }
      }
    }
    if (lastError && !textOut && toolCalls.length === 0) continue; // 流中途坏掉且无产出 → 重试
    return { content: textOut, toolCalls };
  }
  throw lastError ?? new Error("模型接口(Anthropic)调用失败");
}
