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
export async function chatCompletion(
  messages: ChatMessage[],
  tools: ToolDef[],
  signal?: AbortSignal
): Promise<ChatResult> {
  const res = await fetch(`${ARK_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getArkKey()}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
      temperature: 0.2,
    }),
    signal,
  });

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(`模型接口 ${res.status}: ${detail}`);
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
