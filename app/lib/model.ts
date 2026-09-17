// 一次性多模态调用:简历照片识别用,只传文本/图片 content、不挂任何工具
// agent 多轮工具循环不走这里,仍由 ark.ts 的 chatCompletion 承担

import { ARK_BASE, MODEL, getArkKey } from "./ark";

export interface VisionMessage {
  role: "system" | "user";
  content:
    | string
    | Array<
        { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }
      >;
}

export async function chatVision(
  messages: VisionMessage[],
  signal?: AbortSignal
): Promise<string> {
  const res = await fetch(`${ARK_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getArkKey()}`,
    },
    // 无 tools 字段:视觉提取只需要一段 JSON 文本
    body: JSON.stringify({ model: MODEL, messages, temperature: 0.2 }),
    signal,
  });

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(`模型接口 ${res.status}: ${detail}`);
  }

  const data = await res.json();
  return String(data?.choices?.[0]?.message?.content ?? "");
}
