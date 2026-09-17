// 简历诊断端点(三段式):
//   段 1 视觉提取在开 SSE 流之前完成 → 段 1 两次失败可返回真 502(带原文片段)
//   段 2 判断轮(chatCompletion + search_market,预算 3 次)走 SSE:stage/search/retry/done/error
//   段 3 结论重问(无工具)也在流内,此时 HTTP 已 200,失败发 error 事件(同样带原文片段)
// POST /api/diagnose { image: dataURL, jobs: JobRecord[] } → text/event-stream
// 红线:图片只在内存中拼进视觉请求,严禁落盘/写日志

import { analyzeResume, extractResume, type DiagnoseSseEvent } from "../../lib/diagnose";
import type { JobRecord } from "../../lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_IMAGE_CHARS = 5 * 1024 * 1024 * 1.4; // dataURL 文本长度上限(≈5MB 图片)
const TIMEOUT_MS = 240 * 1000; // 三段合计上限:视觉 + 判断轮(≤3 搜索)+ 结论重问

export async function POST(req: Request) {
  let body: { image?: unknown; jobs?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonErr(400, "请求体不是合法 JSON");
  }

  // ---- 入参校验(全在模型调用前,省配额) ----
  const image = typeof body.image === "string" ? body.image : "";
  if (!image.startsWith("data:image/")) {
    return jsonErr(400, "image 必须是 data:image/ 开头的 dataURL");
  }
  if (image.length > MAX_IMAGE_CHARS) {
    return jsonErr(413, "图片过大(>5MB),请压缩后重试");
  }
  const jobs = Array.isArray(body.jobs) ? (body.jobs as JobRecord[]) : [];
  if (jobs.length === 0) {
    return jsonErr(400, "jobs 为空:诊断需要本次调研的岗位数据");
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("诊断超时(240s),请稍后重试")),
    TIMEOUT_MS
  );
  const signal = anySignal(req.signal, controller.signal);

  // ---- 段 1:视觉提取(开流前;失败按旧行为返 502,报文中保留模型原文片段) ----
  let extracted;
  try {
    extracted = await extractResume(image, signal);
  } catch (e: any) {
    clearTimeout(timeout);
    const msg = String(e?.message ?? e).slice(0, 500);
    return jsonErr(502, `模型调用失败:${msg}`);
  }

  // ---- 段 2+3:SSE 把判断轮的每个动作推给前端(补搜次数必须真实) ----
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(sc) {
      const send = (ev: DiagnoseSseEvent) => {
        try {
          sc.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
        } catch {
          /* 客户端已断开 */
        }
      };
      // 心跳:视觉后是多轮模型思考,间隙防止代理掐断空闲连接(与 /api/radar 同)
      const heartbeat = setInterval(() => {
        try {
          sc.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          /* 已关闭 */
        }
      }, 15000);
      try {
        if (extracted.retries > 0) {
          send({ type: "retry", stage: "extract", attempt: extracted.retries });
        }
        const report = await analyzeResume({
          extracted: extracted.data,
          jobs,
          extractMs: extracted.ms,
          onEvent: send,
          signal,
        });
        send({ type: "done", report });
      } catch (e: any) {
        if (signal.aborted) {
          send({ type: "error", message: "诊断中断(超时或页面关闭)" });
        } else {
          send({ type: "error", message: String(e?.message ?? e).slice(0, 500) || "未知错误" });
        }
      } finally {
        clearInterval(heartbeat);
        clearTimeout(timeout);
        try {
          sc.close();
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

// 合并多个 AbortSignal(请求断开 / 240s 超时任一触发即中止)
function anySignal(s1: AbortSignal, s2: AbortSignal): AbortSignal {
  const c = new AbortController();
  for (const s of [s1, s2]) {
    if (s.aborted) {
      c.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => c.abort(s.reason), { once: true });
  }
  return c.signal;
}
