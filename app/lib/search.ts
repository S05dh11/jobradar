// 豆包联网搜索封装(Agent Plan Key 复用,Bearer 鉴权)
// 端点:POST https://open.feedcoopapi.com/search_api/web_search
// 该接口线上改过版:早期文档是顶层 Results,现网是 Result.WebResults——
// 两层都必须认,否则接口一切换整份调研就空(踩过的坑)
// 返回项里的 AuthInfoLevel(权威性等级)是岗位可信度徽章的参考输入

import { getArkKey, sleep } from "./ark";
import type { SearchResult } from "./types";

const ENDPOINT = "https://open.feedcoopapi.com/search_api/web_search";

// 全局节流:两次搜索至少间隔 MIN_INTERVAL_MS。Agent 开局常在数秒内连发多个类别的
// 搜索,叠加模型调用易触发方舟突发保护(RequestBurstTooFast),拉开间隔从源头减压
const MIN_INTERVAL_MS = 2000;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const BACKOFF_MS = [3000, 6000, 12000];

let paceChain: Promise<unknown> = Promise.resolve();
let lastSearchAt = 0;

async function pacedSlot(): Promise<void> {
  const run = paceChain.then(async () => {
    const wait = lastSearchAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastSearchAt = Date.now();
  });
  paceChain = run.catch(() => {});
  await run;
}

export interface SearchOptions {
  count?: number;
  timeRange?: "OneDay" | "OneWeek" | "OneMonth" | "OneYear";
  sites?: string[];
  signal?: AbortSignal;
}

export async function doubaoSearch(
  query: string,
  opts: SearchOptions = {}
): Promise<SearchResult[]> {
  const body = {
    Query: query,
    SearchType: "web",
    Count: opts.count ?? 10,
    Filter: {
      NeedContent: false,
      NeedUrl: true,
      ...(opts.sites && opts.sites.length > 0 ? { Sites: opts.sites } : {}),
    },
    NeedSummary: true,
    TimeRange: opts.timeRange ?? "OneMonth",
    QueryControl: { QueryRewrite: true },
  };

  const payload = JSON.stringify(body);
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${getArkKey()}`,
  };

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    await pacedSlot();
    if (attempt > 0) await sleep(BACKOFF_MS[attempt - 1], opts.signal);
    let res: Response;
    try {
      res = await fetch(ENDPOINT, {
        method: "POST",
        headers,
        body: payload,
        signal: opts.signal,
      });
    } catch (e: any) {
      if (String(e?.name) === "AbortError") throw e;
      lastError = e instanceof Error ? e : new Error(String(e));
      continue;
    }

    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      lastError = new Error(`豆包搜索失败 ${res.status}: ${detail}`);
      if (RETRYABLE_STATUS.has(res.status)) continue;
      throw lastError;
    }

    const data = await res.json();
    return normalizeResults(data);
  }
  throw lastError ?? new Error("豆包搜索失败");
}

// 结果数组定位:新结构 Result.WebResults 优先,旧文档 Results 及常见变体兜底
function pickResultArray(data: any): any[] {
  const raw =
    data?.Result?.WebResults ??
    data?.result?.web_results ??
    data?.Results ??
    data?.results ??
    data?.data?.Results ??
    data?.Data?.Results ??
    data?.data?.results ??
    data?.data ??
    data?.items ??
    data?.list;
  return Array.isArray(raw) ? raw : [];
}

function normalizeResults(data: any): SearchResult[] {
  return pickResultArray(data)
    .map((item) => {
      const title = asString(item?.Title ?? item?.title);
      const url = asString(item?.Url ?? item?.url ?? item?.Link ?? item?.link);
      return {
        title,
        url,
        snippet: asString(
          item?.Snippet ??
            item?.snippet ??
            item?.Summary ??
            item?.summary ??
            item?.Content ??
            item?.content
        ),
        siteName: asString(item?.SiteName ?? item?.site_name ?? item?.site),
        publishTime:
          asString(
            item?.PublishTime ?? item?.publish_time ?? item?.PublishDate ?? item?.date
          ) || undefined,
        authLevel: asNumber(item?.AuthInfoLevel ?? item?.auth_info_level),
      };
    })
    // 没有标题或链接的条目无法溯源,直接丢
    .filter((r) => r.title && r.url)
    .slice(0, 20);
}

function asString(v: unknown): string {
  if (typeof v === "string") return v;
  return v == null ? "" : String(v);
}

function asNumber(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}
