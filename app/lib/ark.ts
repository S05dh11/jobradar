// 火山方舟(Agent Plan)OpenAI 兼容端点封装:agent 循环与诊断判断轮的唯一模型出口
// Key 走 Agent Plan 专属 ARK_API_KEY;模型名用滚动别名,始终指向 Seed-Evolving 最新版

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

// OpenAI 消息四形态:system / user / assistant(可带 tool_calls) / tool(挂 tool_call_id)
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: unknown[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
}

export const ARK_BASE =
  process.env.ARK_BASE_URL ?? "https://ark.cn-beijing.volces.com/api/plan/v3";
export const MODEL = process.env.ARK_MODEL ?? "doubao-seed-evolving";

export function getArkKey(): string {
  const key = process.env.ARK_API_KEY;
  if (!key) {
    throw new Error(
      "缺少 ARK_API_KEY 环境变量:请在 jobradar/.env.local 中配置(参考 .env.example)"
    );
  }
  return key;
}

// 无工具的收尾重问必须把 tools 整个省略(而不是传空数组):
// 诊断段 3 靠它在协议层封死模型再次发起 function calling 的可能
// 429(RequestBurstTooFast)/5xx 自动指数退避重试:方舟 Agent Plan 对新 Key/低水位
// Key 有突发流量保护,实测退避 41s 仍会 429,窗口在分钟级 —— 退避拉长到最长 90s
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const BACKOFF_MS = [5000, 15000, 30000, 60000, 90000];
// 单次请求硬超时:防止非流式调用因模型超长思考/连接挂起而吃光整场调研的预算;
// 超时按可重试错误处理,退避后换一次尝试
const ATTEMPT_TIMEOUT_MS = 150_000;

// 全局节流:两次模型请求至少间隔 CHAT_MIN_INTERVAL_MS。Agent 循环里模型调用最密
// (每轮 1 次,秒级连发),把速率拉平到恒定低速,从源头避免触发增速风控
const CHAT_MIN_INTERVAL_MS = 2500;
let chatPaceChain: Promise<unknown> = Promise.resolve();
let lastChatAt = 0;

async function chatPacedSlot(): Promise<void> {
  const run = chatPaceChain.then(async () => {
    const wait = lastChatAt + CHAT_MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastChatAt = Date.now();
  });
  chatPaceChain = run.catch(() => {});
  await run;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
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

export async function chatCompletion(
  messages: ChatMessage[],
  tools: ToolDef[],
  signal?: AbortSignal
): Promise<ChatResult> {
  const body = JSON.stringify({
    model: MODEL,
    messages,
    ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
    temperature: 0.2,
  });
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${getArkKey()}`,
  };

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    await chatPacedSlot();
    if (attempt > 0) await sleep(BACKOFF_MS[attempt - 1], signal);
    let res: Response;
    try {
      res = await fetch(`${ARK_BASE}/chat/completions`, {
        method: "POST",
        headers,
        body,
        // 外部 signal(断连/总超时)与单次硬超时合并:任一触发即中止本次尝试
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(ATTEMPT_TIMEOUT_MS)]) : AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      });
    } catch (e: any) {
      if (String(e?.name) === "AbortError" && signal?.aborted) throw e; // 总超时/断连:上抛
      if (String(e?.name) === "TimeoutError") {
        lastError = new Error(`模型请求 ${(ATTEMPT_TIMEOUT_MS / 1000) | 0}s 无响应(可能被限流静默挂起)`);
        continue; // 视为可重试
      }
      lastError = e instanceof Error ? e : new Error(String(e));
      continue;
    }

    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      lastError = new Error(`模型接口 ${res.status}: ${detail}`);
      if (RETRYABLE_STATUS.has(res.status)) continue;
      throw lastError;
    }

    const data = await res.json();
    const message = data?.choices?.[0]?.message;
    return {
      content: typeof message?.content === "string" ? message.content : "",
      toolCalls: Array.isArray(message?.tool_calls)
        ? message.tool_calls.map(parseToolCall)
        : [],
    };
  }
  throw lastError ?? new Error("模型接口调用失败");
}

function parseToolCall(raw: any): ToolCall {
  return {
    id: String(raw?.id ?? ""),
    name: String(raw?.function?.name ?? ""),
    args: parseJsonObject(raw?.function?.arguments),
  };
}

// 模型返回的 arguments 理论上是 JSON 字符串;解析失败不炸循环,交回空对象由工具侧报参数错
function parseJsonObject(text: unknown): Record<string, unknown> {
  if (typeof text !== "string") return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}
