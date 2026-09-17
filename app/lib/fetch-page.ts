// JD 页面抓取:带浏览器 UA 拉 HTML,提取 <title> 与纯文本正文给模型核实薪资/技能
// 设计为软失败:超时、非网页、反爬拦截都返回 {ok:false,error} 让 agent 改用摘要登记,
// 只有调用方的全局中止信号触发时才向上抛(整条调研要被取消)
// 护栏:SSRF 拦截内网地址、20s 单页超时、3MB 下载上限、二进制类型拒绝

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export interface FetchedPage {
  ok: boolean;
  url: string;
  title?: string;
  text?: string;
  error?: string;
}

const MAX_TEXT = 6000; // 喂给模型的正文字符上限
const MAX_BYTES = 3_000_000; // 单页下载上限,超出部分直接断流
const FETCH_TIMEOUT_MS = 20_000;

// 抓到也不该喂模型的类型:招聘页基本都是 text/html
const NON_PAGE_TYPE = /(image|video|audio|pdf|zip|octet-stream)/;

export async function fetchPage(
  url: string,
  signal?: AbortSignal
): Promise<FetchedPage> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, url, error: "URL 无法解析" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, url, error: `不支持的协议:${parsed.protocol}` };
  }
  if (isBlockedHost(parsed.hostname)) {
    return { ok: false, url, error: "拒绝抓取:内网/本地地址不在允许范围" };
  }

  // 页内超时与全局信号合并:前者软失败回传模型,后者才向上抛
  const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const reqSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;

  try {
    const res = await fetch(parsed, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      cache: "no-store",
      signal: reqSignal,
    });

    if (!res.ok) return { ok: false, url, error: `HTTP ${res.status}` };

    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    if (NON_PAGE_TYPE.test(contentType)) {
      return {
        ok: false,
        url,
        error: `非网页内容(${contentType.split(";")[0] || "未知类型"})`,
      };
    }

    const html = decodeBytes(await readCapped(res));
    const title = extractTitle(html);
    return { ok: true, url, title: title || undefined, text: extractText(html) };
  } catch (e: any) {
    if (signal?.aborted) throw e; // 客户端断开/任务总超时:取消整条调研
    if (e?.name === "TimeoutError") {
      return { ok: false, url, error: `抓取超时(${FETCH_TIMEOUT_MS / 1000}s)` };
    }
    return { ok: false, url, error: String(e?.message ?? e).slice(0, 200) };
  }
}

// 流式读取并封顶:宁可截断正文,不能让异常大响应把内存撑爆
async function readCapped(res: Response): Promise<Buffer> {
  const reader = res.body?.getReader();
  if (!reader) return Buffer.from(await res.arrayBuffer());

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    if (total > MAX_BYTES) {
      await reader.cancel();
      break;
    }
  }
  return Buffer.concat(chunks);
}

// demo 级 SSRF 防护(不做 DNS 重绑定校验):拦字面量本地/内网/链路本地地址
function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, ""); // 去 IPv6 方括号
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) {
    return true;
  }

  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 10 || a === 127) return true; // 本机/内网 A 段/回环
    if (a === 169 && b === 254) return true; // 链路本地(含云元数据 169.254.169.254)
    if (a === 172 && b >= 16 && b <= 31) return true; // 内网 B 段
    if (a === 192 && b === 168) return true; // 内网 C 段
    if (a >= 224) return true; // 组播与保留段
  }

  if (h.includes(":")) {
    // IPv6 字面量:回环/未指定/IPv4 映射(:: 开头)、唯本地 fc/fd、链路本地 fe80
    return h.startsWith("::") || /^(f[cd]|fe80)/.test(h);
  }
  return false;
}

// 国内老站常有 GBK 编码:先按 UTF-8 严格解,失败回退 GBK,再不行容错替换
function decodeBytes(buf: Uint8Array): string {
  const strictDecode = (encoding: string): string | null => {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(buf);
    } catch {
      return null;
    }
  };
  return strictDecode("utf-8") ?? strictDecode("gbk") ?? new TextDecoder("utf-8").decode(buf);
}

function extractTitle(html: string): string {
  return (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "")
    .replace(/<[^>]+>/g, "")
    .trim();
}

// 标签级清洗:剥 head/脚本,反转义常用实体,最后压空白并截断到模型正文上限
function extractText(html: string): string {
  return html
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<(script|style|noscript|template|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TEXT);
}
