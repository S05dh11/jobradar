// 豆包联网搜索封装(Agent Plan Key 复用,Bearer 鉴权)
// 端点:POST https://open.feedcoopapi.com/search_api/web_search
// 该接口线上改过版:早期文档是顶层 Results,现网是 Result.WebResults——
// 两层都必须认,否则接口一切换整份调研就空(踩过的坑)
// 返回项里的 AuthInfoLevel(权威性等级)是岗位可信度徽章的参考输入

import { getArkKey } from "./ark";
import type { SearchResult } from "./types";

const ENDPOINT = "https://open.feedcoopapi.com/search_api/web_search";

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

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getArkKey()}`,
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(`豆包搜索失败 ${res.status}: ${detail}`);
  }

  const data = await res.json();
  return normalizeResults(data);
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
