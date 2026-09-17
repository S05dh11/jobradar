// JobRadar SSE 端点
// POST /api/radar {categories, cities} → text/event-stream
// 每个事件一行 data: {JSON},前端流式渲染 agent 的每一步动作

import { runRadarAgent } from "../../lib/agent";
import { CITIES, JOB_CATEGORIES, JOB_TYPES, type JobType } from "../../lib/config";
import type { AgentEvent } from "../../lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TIMEOUT_MS = 45 * 60 * 1000; // 单次调研最长 45 分钟(预算 36 搜满载 + 限流退避的余量)

export async function POST(req: Request) {
  let body: { categories?: unknown; cities?: unknown; jobType?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonErr(400, "请求体不是合法 JSON");
  }

  const categories = pickStrings(body.categories, JOB_CATEGORIES);
  const cities = pickStrings(body.cities, CITIES);
  const jobType = (JOB_TYPES.some((t) => t.value === body.jobType)
    ? (body.jobType as JobType)
    : "fulltime") as JobType;
  if (!categories.length || !cities.length) {
    return jsonErr(400, "请至少选择一个岗位类别和一个城市");
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("任务超时(15 分钟),请缩小城市范围后重试")),
    TIMEOUT_MS
  );
  const signal = anySignal(req.signal, controller.signal);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(streamController) {
      const send = (ev: AgentEvent) => {
        try {
          streamController.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
        } catch {
          // 客户端已断开,忽略
        }
      };
      // 心跳:SSE 注释帧,模型长思考无事件的间隙防止代理/浏览器掐断空闲连接
      const heartbeat = setInterval(() => {
        try {
          streamController.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          /* 已关闭 */
        }
      }, 15000);
      try {
        const report = await runRadarAgent({ categories, cities, jobType }, send, signal);
        send({ type: "done", report });
      } catch (e: any) {
        send({
          type: "error",
          message: String(e?.message ?? e).slice(0, 500) || "未知错误",
        });
      } finally {
        clearInterval(heartbeat);
        clearTimeout(timeout);
        try {
          streamController.close();
        } catch {
          /* 已关闭 */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

function jsonErr(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

function pickStrings(input: unknown, allowed: readonly string[]): string[] {
  if (!Array.isArray(input)) return [];
  const set = new Set(allowed);
  return [...new Set(input.map((v) => String(v)).filter((v) => set.has(v)))];
}

// 合并多个 AbortSignal(请求断开 / 超时任一触发即中止)
function anySignal(...signals: AbortSignal[]): AbortSignal {
  const c = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      c.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => c.abort(s.reason), { once: true });
  }
  return c.signal;
}
