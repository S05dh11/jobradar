"use client";

import { useEffect, useRef, useState } from "react";
import type { AgentEvent, JobRecord, RadarReport } from "./lib/types";
import { CITIES, CREDIBILITY_LABEL, JOB_CATEGORIES, JOB_TYPES, type JobType } from "./lib/config";
import JobMap from "./JobMap";
import RadarMap from "./RadarMap";

type Stage = "config" | "running" | "done" | "error";

// 带前端接收时刻的事件(时间戳仅用于时间线展示)
type TEvent = AgentEvent & { t?: string };

// ---------- 岗位类别判定(前端展示用,按标题关键词) ----------

const CAT_KEYWORDS: [string, string[]][] = [
  ["全栈", ["全栈", "fullstack", "full-stack", "前后端"]],
  ["测试", ["测试", "qa", "质量保障", "测开"]],
  [
    "前端",
    ["前端", "web前端", "react", "vue", "小程序", "h5", "android", "ios", "安卓", "客户端", "flutter"],
  ],
  [
    "AI/算法",
    ["算法", "机器学习", "深度学习", "大模型", "nlp", "cv", "计算机视觉", "推荐", "aigc", "数据挖掘", "强化学习", "llm", "多模态", "数据科学"],
  ],
  [
    "后端",
    ["后端", "java", "go", "golang", "服务端", "c++", "php", "python", "大数据", "数据开发", "运维", "devops", "sre", "数据库", "嵌入式"],
  ],
];

function classifyJob(title: string): string {
  const t = title.toLowerCase();
  for (const [cat, kws] of CAT_KEYWORDS) {
    if (kws.some((k) => t.includes(k.toLowerCase()))) return cat;
  }
  return "其他";
}

// ---------- 可信度徽章样式与信号脊条 ----------

const CRED_STYLE: Record<string, string> = {
  high: "text-emerald-300 bg-emerald-400/10 border-emerald-400/30",
  medium: "text-amber-300 bg-amber-400/10 border-amber-400/30",
  low: "text-zinc-400 bg-zinc-400/10 border-zinc-400/30",
};

const SPINE: Record<string, string> = {
  high: "bg-emerald-400/80",
  medium: "bg-amber-400/80",
  low: "bg-zinc-500/80",
};

function mmss(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

// ---------- 小图标(内联 SVG,无第三方依赖) ----------

function CrosshairIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="12" cy="12" r="7" />
      <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="5" y="5" width="14" height="14" rx="1" />
    </svg>
  );
}

function RestartIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v5h5" />
    </svg>
  );
}

// ---------- 主页面 ----------

export default function Home() {
  const [stage, setStage] = useState<Stage>("config");
  const [selCats, setSelCats] = useState<string[]>([...JOB_CATEGORIES]);
  const [selCities, setSelCities] = useState<string[]>([]); // 默认不勾选:勾哪些城市查哪些
  const [jobType, setJobType] = useState<JobType>("fulltime");
  const [events, setEvents] = useState<TEvent[]>([]);
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [report, setReport] = useState<RadarReport | null>(null);
  const [error, setError] = useState("");
  const [activeCat, setActiveCat] = useState("全部");
  const [elapsed, setElapsed] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const t0Ref = useRef(0);

  useEffect(() => {
    const el = timelineRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events]);

  // 运行中的秒表(1s 一跳,与地图波纹同为"活着的仪器"语言)
  useEffect(() => {
    if (stage !== "running") return;
    const iv = setInterval(() => setElapsed((Date.now() - t0Ref.current) / 1000), 1000);
    return () => clearInterval(iv);
  }, [stage]);

  const stamp = () => mmss((Date.now() - t0Ref.current) / 1000);

  const applyEvent = (ev: AgentEvent) => {
    setEvents((prev) => [...prev, { ...ev, t: stamp() }]);
    if (ev.type === "job") {
      setJobs((prev) => [...prev, ev.job]);
    } else if (ev.type === "done") {
      setReport(ev.report);
      setJobs(ev.report.jobs);
      setStage("done");
    } else if (ev.type === "error") {
      setError(ev.message);
      setStage("error");
    }
  };

  const startRun = async () => {
    if (!selCats.length || !selCities.length) return;
    t0Ref.current = Date.now();
    setElapsed(0);
    setStage("running");
    setEvents([]);
    setJobs([]);
    setReport(null);
    setError("");
    setActiveCat("全部");

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const res = await fetch("/api/radar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ categories: selCats, cities: selCities, jobType }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(`接口返回 ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of chunk.split("\n")) {
            if (!line.startsWith("data:")) continue;
            try {
              applyEvent(JSON.parse(line.slice(5).trim()) as AgentEvent);
            } catch {
              /* 忽略坏块 */
            }
          }
        }
      }
    } catch (e: any) {
      if (e?.name === "AbortError") {
        setStage("config");
      } else {
        setError(String(e?.message ?? e));
        setStage("error");
      }
    }
  };

  const stopRun = () => abortRef.current?.abort();

  const toggle = (list: string[], set: (v: string[]) => void, v: string) =>
    set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const searched = events.filter((e) => e.type === "search").length;
  const fetched = events.filter((e) => e.type === "fetch").length;

  return (
    <div className="min-h-screen">
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        {/* 头部:设备铭牌式状态栏 */}
        <header className="mb-8 flex items-center gap-3.5 border-b border-white/[0.07] pb-5">
          <span className="sweep shrink-0" aria-hidden="true" />
          <div>
            <h1 className="text-xl font-bold tracking-tight text-ink-hi">
              JobRadar <span className="ml-1 font-semibold text-ink-mid">岗位雷达</span>
            </h1>
            <p className="mt-0.5 text-xs text-ink-dim">
              模型自主决定搜什么 / 抓哪个 / 何时核实,每条岗位附来源链接
            </p>
          </div>
          <div className="ml-auto hidden text-right sm:block">
            <p className="readout text-xs text-signal/90">doubao-seed-evolving</p>
            <p className="mt-0.5 text-xs text-ink-dim">实时搜索 / 网页抓取 / 逐条溯源</p>
          </div>
        </header>

        {/* 配置阶段 */}
        {stage === "config" && (
          <ConfigPanel
            selCats={selCats}
            selCities={selCities}
            jobType={jobType}
            onToggleCat={(v) => toggle(selCats, setSelCats, v)}
            onToggleCity={(v) => toggle(selCities, setSelCities, v)}
            onSelectAllCities={() => setSelCities([...CITIES])}
            onClearCities={() => setSelCities([])}
            onJobType={(v) => setJobType(v)}
            onStart={startRun}
          />
        )}

        {/* 运行阶段 */}
        {stage === "running" && (
          <RunningPanel
            events={events}
            jobs={jobs}
            searched={searched}
            fetched={fetched}
            elapsed={elapsed}
            timelineRef={timelineRef}
            onStop={stopRun}
          />
        )}

        {/* 错误 */}
        {stage === "error" && (
          <div className="rounded-[4px] border border-red-400/30 bg-red-400/10 p-6">
            <p className="mb-2 text-lg font-semibold text-red-300">运行出错</p>
            <p className="mb-4 whitespace-pre-wrap break-all text-sm text-red-200/80">{error}</p>
            <button onClick={() => setStage("config")} className="btn-primary">
              返回重试
            </button>
          </div>
        )}

        {/* 报告阶段 */}
        {stage === "done" && report && (
          <ReportView
            report={report}
            jobs={jobs}
            activeCat={activeCat}
            setActiveCat={setActiveCat}
            onRestart={() => setStage("config")}
          />
        )}

        <footer className="mt-14 border-t border-white/[0.06] pt-6 text-center text-xs text-ink-dim">
          JobRadar · Seed-Evolving 征文实测 Demo · 数据来自实时搜索与抓取,来源链接可逐条验证
        </footer>
      </div>
    </div>
  );
}

// ---------- 配置面板 ----------

function ConfigPanel(props: {
  selCats: string[];
  selCities: string[];
  jobType: JobType;
  onToggleCat: (v: string) => void;
  onToggleCity: (v: string) => void;
  onSelectAllCities: () => void;
  onClearCities: () => void;
  onJobType: (v: JobType) => void;
  onStart: () => void;
}) {
  return (
    <div className="boot-stage relative space-y-5">
      {/* 开机扫描线:单次扫过,装饰层不参与布局 */}
      <div aria-hidden="true" className="boot-scanline" />
      <section className="panel boot-panel p-5" style={{ animationDelay: "0ms" }}>
        <h2 className="mb-4 text-base font-semibold text-ink-hi">① 勾选岗位类别</h2>
        <div className="flex flex-wrap gap-2">
          {JOB_CATEGORIES.map((c) => (
            <Chip key={c} label={c} on={props.selCats.includes(c)} onClick={() => props.onToggleCat(c)} />
          ))}
        </div>
      </section>

      <section className="panel boot-panel p-5" style={{ animationDelay: "90ms" }}>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-ink-hi">② 勾选城市(发达 + 中发达,勾哪些查哪些)</h2>
          <div className="flex items-center gap-2 text-xs">
            <button onClick={props.onSelectAllCities} className="text-cyan-300 hover:text-cyan-200">
              全选
            </button>
            <span className="text-ink-dim">/</span>
            <button onClick={props.onClearCities} className="text-ink-mid hover:text-ink-hi">
              清空
            </button>
            <span className="readout ml-2 text-ink-dim">
              {props.selCities.length}/{CITIES.length}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {CITIES.map((c) => (
            <Chip key={c} label={c} on={props.selCities.includes(c)} onClick={() => props.onToggleCity(c)} />
          ))}
        </div>
      </section>

      <section className="panel boot-panel p-5" style={{ animationDelay: "180ms" }}>
        <h2 className="mb-4 text-base font-semibold text-ink-hi">③ 岗位类型</h2>
        <div className="flex flex-wrap gap-2">
          {JOB_TYPES.map((t) => (
            <button
              key={t.value}
              onClick={() => props.onJobType(t.value)}
              className={
                "rounded-[3px] border px-4 py-1.5 text-sm transition-colors " +
                (props.jobType === t.value
                  ? "chip-on border-cyan-400/60"
                  : "border-white/10 bg-white/[0.02] text-ink-mid hover:border-white/25 hover:text-ink-hi")
              }
            >
              {t.label}
            </button>
          ))}
        </div>
        <p className="mt-3 text-xs text-ink-dim">
          选实习就只搜实习岗,选秋招就只搜校招岗,选正式就只搜社招全职岗
        </p>
      </section>

      <div className="boot-panel flex flex-col items-center gap-3 pt-2" style={{ animationDelay: "270ms" }}>
        <button
          onClick={props.onStart}
          disabled={!props.selCats.length || !props.selCities.length}
          className="btn-primary flex w-full max-w-sm items-center justify-center gap-2 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <CrosshairIcon />
          开始调研
        </button>
        <p className="text-xs text-ink-dim">
          已选 {props.selCats.length} 类岗位 × {props.selCities.length} 个城市 · 约 3-15 分钟,模型自行规划搜索与抓取
        </p>
      </div>
    </div>
  );
}

function Chip(props: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button
      onClick={props.onClick}
      className={
        "flex items-center rounded-[3px] border px-3 py-1.5 text-sm transition-colors " +
        (props.on
          ? "chip-on border-cyan-400/60"
          : "border-white/10 bg-white/[0.02] text-ink-mid hover:border-white/25 hover:text-ink-hi")
      }
    >
      {/* 指示方块:空 span 不产生文本,保证按钮 textContent 精确等于 label(ui-test 依赖) */}
      <span
        aria-hidden="true"
        className={
          "mr-2 inline-block h-[7px] w-[7px] rounded-[1px] " +
          (props.on ? "bg-cyan-300 shadow-[0_0_6px_rgba(103,232,249,0.8)]" : "bg-white/10")
        }
      />
      <span>{props.label}</span>
    </button>
  );
}

// ---------- 运行面板 ----------

function RunningPanel(props: {
  events: TEvent[];
  jobs: JobRecord[];
  searched: number;
  fetched: number;
  elapsed: number;
  timelineRef: React.RefObject<HTMLDivElement | null>;
  onStop: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="panel flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <div className="flex items-center gap-2 text-sm text-ink-hi">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.8)]" />
          Agent 正在调研中
        </div>
        <span className="readout text-xs text-signal">REC {mmss(props.elapsed)}</span>
        <div className="ml-auto flex items-center gap-4 text-xs text-ink-mid">
          <span>
            搜索 <b className="readout font-semibold text-ink-hi">{props.searched}</b>
          </span>
          <span>
            抓取 <b className="readout font-semibold text-ink-hi">{props.fetched}</b>
          </span>
          <span>
            已登记岗位 <b className="readout font-semibold text-ink-hi">{props.jobs.length}</b>
          </span>
          <button
            onClick={props.onStop}
            className="flex items-center gap-1.5 text-ink-dim transition-colors hover:text-ink-hi"
          >
            <StopIcon />
            停止
          </button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_400px]">
        {/* 雷达地图 */}
        <div className="panel h-[62vh] min-h-[440px] overflow-hidden">
          <RadarMap events={props.events} jobs={props.jobs} />
        </div>

        {/* 侧边时间线 */}
        <div
          ref={props.timelineRef}
          className="panel h-[62vh] min-h-[440px] overflow-y-auto p-5"
        >
          {props.events.length === 0 ? (
            <p className="text-sm text-ink-dim">正在连接模型…</p>
          ) : (
            <Timeline events={props.events} />
          )}
        </div>
      </div>
    </div>
  );
}

function Timeline({ events }: { events: TEvent[] }) {
  return (
    <div className="relative pl-9">
      <div className="absolute bottom-1 left-[13px] top-1 w-px bg-white/10" />
      {events.map((ev, i) => (
        <TimelineItem key={i} ev={ev} />
      ))}
    </div>
  );
}

// 菱形节点:雷达回波的语言(方块旋转 45°)
function Node({ tone }: { tone: string }) {
  return (
    <span className={`absolute -left-9 top-1.5 block h-2.5 w-2.5 rotate-45 rounded-[1px] border ${tone}`} />
  );
}

const NODE_TONES = {
  plan: "border-violet-400/60 bg-violet-400/20",
  search: "border-cyan-400/60 bg-cyan-400/20",
  ok: "border-emerald-400/60 bg-emerald-400/20",
  fail: "border-red-400/60 bg-red-400/20",
};

function TimelineItem({ ev }: { ev: TEvent }) {
  const ts = (
    <span className="readout mr-2 text-[11px] text-ink-dim">{ev.t}</span>
  );

  if (ev.type === "plan") {
    return (
      <div className="relative mb-3">
        <Node tone={NODE_TONES.plan} />
        <p className="text-sm leading-relaxed text-ink-mid">
          {ts}
          {ev.text}
        </p>
      </div>
    );
  }
  if (ev.type === "search") {
    return (
      <div className="relative mb-3">
        <Node tone={NODE_TONES.search} />
        <p className="text-sm text-ink-hi">
          {ts}
          搜索 <span className="font-medium text-cyan-200">「{ev.query}」</span>
          <span className="text-ink-dim"> · {ev.count} 条结果</span>
        </p>
        {ev.results.slice(0, 3).map((r, i) => (
          <p key={i} className="mt-1 truncate text-xs text-ink-dim">
            ↳ {r.title} <span className="text-ink-dim/70">({r.siteName || "未知来源"})</span>
          </p>
        ))}
        {ev.results.length > 3 && (
          <p className="mt-0.5 text-xs text-ink-dim/70">… 还有 {ev.results.length - 3} 条</p>
        )}
      </div>
    );
  }
  if (ev.type === "fetch") {
    return (
      <div className="relative mb-3">
        <Node tone={ev.ok ? NODE_TONES.ok : NODE_TONES.fail} />
        <p className="break-all text-sm text-ink-hi">
          {ts}
          抓取{" "}
          <a
            href={ev.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-cyan-300 underline decoration-cyan-400/40 hover:text-cyan-200"
          >
            {ev.url.length > 70 ? ev.url.slice(0, 70) + "…" : ev.url}
          </a>
          {ev.ok ? (
            <span className="text-ink-dim"> · ✓ {ev.title || "成功"} · 正文 {ev.length ?? 0} 字符</span>
          ) : (
            <span className="text-red-300"> · ✗ {ev.error}</span>
          )}
        </p>
      </div>
    );
  }
  if (ev.type === "job") {
    return (
      <div className="relative mb-3">
        <Node tone={NODE_TONES.ok} />
        <p className="text-sm text-ink-hi">
          {ts}
          登记岗位 <span className="font-medium text-white">{ev.job.title}</span>
          <span className="text-ink-mid"> @ {ev.job.company}({ev.job.city})</span>
          <span className="ml-2 text-xs text-ink-dim">
            {ev.job.salary === "未披露" ? "薪资未披露" : ev.job.salary}
          </span>
        </p>
      </div>
    );
  }
  return null;
}

// ---------- 报告面板 ----------

// ---------- 复制岗位表格(纯前端:state 里的岗位 → Markdown 表格 → 剪贴板) ----------

function CopyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="1.5" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  );
}

// Markdown 单元格:压平换行、转义竖线;空值统一写「-」
function mdCell(v: string | null | undefined): string {
  const s = (v ?? "").trim().replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
  return s || "-";
}

// 列与 scripts/export-jobs.mjs 的字段对齐:公司/岗位/城市/薪资/硬性要求/核心技能/可信度/来源URL
function jobsToMarkdown(jobs: JobRecord[]): string {
  const header = "| 公司 | 岗位 | 城市 | 薪资 | 硬性要求 | 核心技能 | 可信度 | 来源URL |";
  const sep = "| --- | --- | --- | --- | --- | --- | --- | --- |";
  const rows = jobs.map((j) => {
    const cells = [
      mdCell(j.company),
      mdCell(j.title),
      mdCell(j.city),
      mdCell(j.salary),
      mdCell(j.requirements?.join("、")),
      mdCell(j.skills.join("、")),
      mdCell(CREDIBILITY_LABEL[j.credibility] ?? j.credibility),
      mdCell(j.sourceUrl),
    ];
    return `| ${cells.join(" | ")} |`;
  });
  return [header, sep, ...rows].join("\n");
}

// 写剪贴板:优先 Clipboard API;不可用/被拒则 textarea + execCommand 兜底
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 非安全上下文或权限被拒,走兜底 */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.readOnly = true;
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    if (ok) return true;
  } catch {
    /* 兜底也失败,交给调用方提示手动选择 */
  }
  return false;
}

function CopyJobsButton({ jobs }: { jobs: JobRecord[] }) {
  const [copied, setCopied] = useState<number | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    },
    []
  );

  const onCopy = async () => {
    const ok = await copyText(jobsToMarkdown(jobs));
    if (!ok) {
      window.alert("复制失败:浏览器拒绝了剪贴板访问,请手动选择页面上的岗位文本复制。");
      return;
    }
    setCopied(jobs.length);
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopied(null), 2000);
  };

  return (
    <button onClick={onCopy} className="btn-primary flex items-center gap-1.5 !px-4 !py-1.5 text-sm">
      <CopyIcon />
      {copied === null ? "复制岗位表格" : `已复制 ${copied} 个岗位`}
    </button>
  );
}

// ---------- 导出报告文件(纯前端 Blob 下载:Markdown / CSV / JSON,零后端) ----------

function DownloadIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M4 19h16" />
    </svg>
  );
}

// 生成 Blob 并触发浏览器下载,用完立即 revoke 释放
function downloadFile(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// 文件名时间戳:20260917-1215
function exportStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

// CSV 单元格:压平换行;含逗号/引号时套引号并转义内部引号
function csvCell(v: string | null | undefined): string {
  const s = (v ?? "").trim().replace(/\r?\n/g, " ");
  return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// 列与 Markdown 表格对齐,另补工作地点/来源站点/发布时间;头部 BOM 保证 Excel 直开不乱码
function jobsToCsv(jobs: JobRecord[]): string {
  const header = ["公司", "岗位", "城市", "薪资", "工作地点", "硬性要求", "核心技能", "可信度", "来源站点", "发布时间", "来源URL"];
  const rows = jobs.map((j) =>
    [
      j.company,
      j.title,
      j.city,
      j.salary,
      j.location,
      j.requirements?.join("、"),
      j.skills.join("、"),
      CREDIBILITY_LABEL[j.credibility] ?? j.credibility,
      j.sourceName,
      j.publishedAt,
      j.sourceUrl,
    ]
      .map(csvCell)
      .join(",")
  );
  return "\uFEFF" + [header.join(","), ...rows].join("\r\n");
}

// 完整 Markdown 报告:统计头 + 小结 + 技能词频表 + 岗位明细表(复用 jobsToMarkdown)
function reportToMarkdown(report: RadarReport, jobs: JobRecord[]): string {
  const lines = [
    "# 岗位雷达调研报告",
    "",
    `- 生成时间:${new Date().toLocaleString("zh-CN")}`,
    `- 搜索 ${report.searchCount} 次 · 抓取 ${report.fetchCount} 页 · 覆盖城市:${report.cityCoverage.join("、") || "-"} · 岗位 ${jobs.length} 条`,
    "",
    "## Agent 调研小结",
    "",
    report.summary.trim() || "-",
    "",
  ];
  if (report.skillRanking.length > 0) {
    lines.push(`## 技能要求词频 TOP${report.skillRanking.length}`, "", "| 技能 | 次数 |", "| --- | --- |");
    for (const s of report.skillRanking) lines.push(`| ${mdCell(s.skill)} | ${s.count} |`);
    lines.push("");
  }
  lines.push(`## 岗位明细(${jobs.length} 条,来源链接可逐条验证)`, "", jobsToMarkdown(jobs), "");
  return lines.join("\n");
}

// 导出按钮组:与「复制岗位表格」并排;始终导出全部岗位(不受明细区类别筛选影响)
function ExportGroup({ report, jobs }: { report: RadarReport; jobs: JobRecord[] }) {
  const base = `岗位雷达报告-${exportStamp()}`;
  const items = [
    {
      label: "Markdown",
      title: "完整报告(小结+技能词频+岗位表格),适合笔记/文档",
      filename: `${base}.md`,
      mime: "text/markdown;charset=utf-8",
      build: () => reportToMarkdown(report, jobs),
    },
    {
      label: "CSV",
      title: "岗位表格,Excel/WPS 可直接打开(含 BOM 不乱码)",
      filename: `${base}.csv`,
      mime: "text/csv;charset=utf-8",
      build: () => jobsToCsv(jobs),
    },
    {
      label: "JSON",
      title: "完整结构化数据,便于程序二次处理",
      filename: `${base}.json`,
      mime: "application/json;charset=utf-8",
      build: () => JSON.stringify({ generatedAt: new Date().toISOString(), ...report, jobs }, null, 2),
    },
  ];
  return (
    <div className="flex items-center overflow-hidden rounded-[4px] border border-white/10" role="group" aria-label="导出报告文件">
      <span className="flex items-center gap-1 border-r border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs text-ink-dim">
        <DownloadIcon />
        导出
      </span>
      {items.map((it) => (
        <button
          key={it.label}
          title={it.title}
          onClick={() => downloadFile(it.filename, it.build(), it.mime)}
          className="border-r border-white/10 px-3 py-1.5 text-xs text-ink-mid transition-colors last:border-r-0 hover:bg-white/[0.04] hover:text-cyan-300"
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

// 导出组件供 /dev-report 夹具页复用(零配额 UI 验证)
export function ReportView(props: {
  report: RadarReport;
  jobs: JobRecord[];
  activeCat: string;
  setActiveCat: (c: string) => void;
  onRestart: () => void;
}) {
  const { report } = props;
  const cats = ["全部", ...JOB_CATEGORIES, "其他"];
  const counts: Record<string, number> = {};
  for (const j of props.jobs) {
    const c = classifyJob(j.title);
    counts[c] = (counts[c] ?? 0) + 1;
  }
  const visible =
    props.activeCat === "全部"
      ? props.jobs
      : props.jobs.filter((j) => classifyJob(j.title) === props.activeCat);

  const stats = [
    { label: "岗位总数", value: String(props.jobs.length) },
    { label: "搜索次数", value: String(report.searchCount) },
    { label: "抓取页数", value: String(report.fetchCount) },
    { label: "覆盖城市", value: String(report.cityCoverage.length) },
  ];

  return (
    <div className="space-y-6">
      {/* 统计条:单块仪表,内部分隔 */}
      <div className="panel grid grid-cols-2 sm:grid-cols-4 sm:divide-x sm:divide-white/[0.07]">
        {stats.map((s) => (
          <div key={s.label} className="px-4 py-4 text-center">
            <p className="readout text-3xl font-bold leading-none text-cyan-300">{s.value}</p>
            <p className="mt-2 text-xs text-ink-dim">{s.label}</p>
          </div>
        ))}
      </div>

      {/* 工具区:复制 Markdown 表格 + 导出文件(纯前端,数据为当前 state 里的全部岗位,不重新请求) */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <ExportGroup report={report} jobs={props.jobs} />
        <CopyJobsButton jobs={props.jobs} />
      </div>

      {/* 岗位分布地图 */}
      <section className="panel p-5">
        <h2 className="mb-3 flex flex-wrap items-baseline justify-between gap-2 text-sm font-semibold text-cyan-300">
          <span>岗位城市分布</span>
          <span className="font-normal text-xs text-ink-dim">标记数字 = 该城岗位数,点击查看</span>
        </h2>
        <JobMap jobs={props.jobs} />
      </section>

      {/* 小结 */}
      <section className="panel relative overflow-hidden p-5">
        <span aria-hidden="true" className="absolute bottom-5 left-0 top-5 w-[2px] bg-cyan-400/50" />
        <h2 className="mb-2 pl-4 text-sm font-semibold text-cyan-300">Agent 调研小结</h2>
        <p className="whitespace-pre-wrap pl-4 text-sm leading-relaxed text-ink-mid">{report.summary}</p>
      </section>

      {/* 技能排行 */}
      {report.skillRanking.length > 0 && (
        <section className="panel p-5">
          <h2 className="mb-4 text-sm font-semibold text-cyan-300">
            技能要求词频 TOP{report.skillRanking.length}
          </h2>
          <div className="space-y-2">
            {report.skillRanking.map((s) => {
              const max = report.skillRanking[0]?.count ?? 1;
              const pct = Math.max(4, Math.round((s.count / max) * 100));
              return (
                <div key={s.skill} className="flex items-center gap-3">
                  <span className="w-36 shrink-0 truncate text-right text-sm text-ink-mid">
                    {s.skill}
                  </span>
                  <div className="h-2.5 flex-1 overflow-hidden rounded-[2px] bg-white/5">
                    <div
                      className="h-full rounded-[2px] bg-gradient-to-r from-cyan-400 to-teal-300"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="readout w-8 shrink-0 text-sm text-ink-mid">{s.count}</span>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* 岗位列表 */}
      <section className="panel p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-cyan-300">岗位明细(每条附来源链接)</h2>
          <button
            onClick={props.onRestart}
            className="btn-primary flex items-center gap-1.5 !px-4 !py-1.5 text-sm"
          >
            <RestartIcon />
            再来一次
          </button>
        </div>

        <div className="mb-4 flex flex-wrap gap-2">
          {cats.map((c) => (
            <button
              key={c}
              onClick={() => props.setActiveCat(c)}
              className={
                "rounded-[3px] border px-3 py-1 text-xs transition-colors " +
                (props.activeCat === c
                  ? "chip-on border-cyan-400/60"
                  : "border-white/10 text-ink-mid hover:text-ink-hi")
              }
            >
              {c}
              {c === "全部" ? `(${props.jobs.length})` : counts[c] ? `(${counts[c]})` : ""}
            </button>
          ))}
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          {visible.map((job, i) => (
            <JobCard key={i} job={job} />
          ))}
        </div>
      </section>

      {/* 简历诊断 */}
      <ResumeDiagnose jobs={props.jobs} />
    </div>
  );
}

// 信号格可信度徽章:▮▮▮ = 高可信,信号强度即语义
function CredBadge({ credibility, note }: { credibility: string; note?: string }) {
  const lit = credibility === "high" ? 3 : credibility === "medium" ? 2 : 1;
  return (
    <span
      title={note ?? ""}
      className={`flex shrink-0 items-center gap-1.5 rounded-[3px] border px-2 py-1 text-xs ${CRED_STYLE[credibility] ?? CRED_STYLE.medium}`}
    >
      <span aria-hidden="true" className="flex items-end gap-[2px]">
        {[10, 7, 4].map((h, i) => (
          <i
            key={h}
            style={{ height: `${h}px` }}
            className={`inline-block w-[3px] rounded-[1px] ${i < lit ? "bg-current" : "bg-white/15"}`}
          />
        ))}
      </span>
      {CREDIBILITY_LABEL[credibility]}
    </span>
  );
}

function JobCard({ job }: { job: JobRecord }) {
  return (
    <article className="relative flex flex-col gap-2.5 overflow-hidden rounded-[4px] border border-white/10 bg-white/[0.02] p-4 pl-5 transition-colors hover:border-white/25">
      {/* 信号脊条:颜色 = 可信度 */}
      <span
        aria-hidden="true"
        className={`absolute bottom-3 left-0 top-3 w-[2px] ${SPINE[job.credibility] ?? SPINE.medium}`}
      />
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-semibold leading-snug text-ink-hi">{job.title}</h3>
        <CredBadge credibility={job.credibility} note={job.credibilityNote} />
      </div>
      <p className="text-sm text-ink-mid">
        {job.company} · {job.city}
        {job.location && <span className="text-ink-dim"> · 📍 {job.location}</span>}
        {job.publishedAt !== "未知" && <span className="text-ink-dim/70"> · {job.publishedAt}</span>}
      </p>
      <p className="text-sm font-semibold text-amber-300">{job.salary}</p>
      {job.requirements && job.requirements.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {job.requirements.map((r, i) => (
            <span
              key={i}
              className="rounded-[3px] border border-rose-400/30 bg-rose-400/10 px-2 py-0.5 text-xs text-rose-200"
            >
              必须:{r}
            </span>
          ))}
        </div>
      )}
      {job.skills.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {job.skills.map((s, i) => (
            <span key={i} className="rounded-[3px] bg-cyan-400/10 px-2 py-0.5 text-xs text-cyan-200">
              {s}
            </span>
          ))}
        </div>
      )}
      <div className="mt-auto flex items-center justify-between gap-2 pt-1">
        <a
          href={job.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="truncate text-xs text-ink-dim underline decoration-ink-dim/50 underline-offset-2 hover:text-cyan-300"
          title={job.sourceUrl}
        >
          来源:{job.sourceName} · 查看原文
        </a>
        {job.credibilityNote && (
          <span className="ml-2 max-w-[45%] shrink-0 truncate text-xs text-ink-dim/70" title={job.credibilityNote}>
            {job.credibilityNote}
          </span>
        )}
      </div>
    </article>
  );
}

// ---------- 简历诊断(视觉理解:上传简历照片 → 模型提取 + 对照市场数据) ----------

// 证据三源:📷图=简历照片 / 📊岗位池=本次调研数据 / 🔍搜索=判断轮补搜
type DiagEvidence = "resume" | "market_pool" | "search";

interface DiagItem {
  skill: string;
  rank?: number;
  evidence: DiagEvidence;
  url?: string;
}

export interface DiagnoseResult {
  extracted?: {
    skills?: string[];
    education?: string | null;
    years?: string | null;
    projects?: string[];
    degreeYear?: string | null;
    intent?: string | null;
  };
  hit?: DiagItem[];
  gaps?: DiagItem[];
  target?: { category: string; city: string; reason: string; evidence: DiagEvidence; url?: string };
  conclusion?: string;
  searches?: { query: string; url?: string }[];
  stages?: { extractMs: number; agentMs: number };
}

// 图片等比压缩到长边 ≤1600px 再转 JPEG dataURL(手机照片原图常达数 MB)
async function compressImage(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("图片读取失败,请换一张试试"));
      i.src = url;
    });
    const maxSide = 1600;
    const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas 不可用");
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// 证据标签:📷图(紫,简历照片) / 📊岗位池(青,本次调研) / 🔍搜索(琥珀,判断轮补搜,挂真实链接)
const EVIDENCE_TAG: Record<DiagEvidence, { label: string; cls: string }> = {
  resume: { label: "📷图", cls: "border-violet-400/30 bg-violet-400/10 text-violet-200" },
  market_pool: {
    label: "📊岗位池",
    cls: "border-cyan-400/30 bg-cyan-400/10 text-cyan-200",
  },
  search: { label: "🔍搜索", cls: "border-amber-400/30 bg-amber-400/10 text-amber-200" },
};

function EvidenceTag({ evidence, url }: { evidence: DiagEvidence; url?: string }) {
  const tag = EVIDENCE_TAG[evidence] ?? EVIDENCE_TAG.market_pool;
  const cls = `inline-flex items-center rounded-[3px] border px-1.5 py-[1px] text-[11px] leading-tight ${tag.cls}`;
  if (evidence === "search" && url) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className={`${cls} underline decoration-amber-400/40 underline-offset-2 hover:brightness-125`}
        title={url}
      >
        {tag.label} ↗
      </a>
    );
  }
  return <span className={cls}>{tag.label}</span>;
}

// 诊断过程状态行:与运行页同一种「活着的仪器」语言(脉冲点 + readout)
function DiagProgress({ phase, searches, retries }: { phase: "extracting" | "analyzing"; searches: number; retries: number }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[3px] border border-white/10 bg-white/[0.02] px-4 py-2.5 text-sm">
      <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.8)]" />
      {phase === "extracting" ? (
        <span className="text-ink-hi">提取简历中(视觉读取照片)…</span>
      ) : (
        <span className="text-ink-hi">
          分析中
          <span className="ml-1 text-xs text-ink-dim">(岗位池取证,必要时才补搜)</span>
        </span>
      )}
      {phase === "analyzing" && (
        <span className="readout text-xs text-amber-300">
          {searches > 0 ? `补搜 ${searches} 次` : "尚未补搜"}
        </span>
      )}
      {retries > 0 && <span className="text-xs text-rose-300">· 已自动重试 {retries} 次</span>}
    </div>
  );
}

export function ResumeDiagnose({ jobs }: { jobs: JobRecord[] }) {
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [phase, setPhase] = useState<"extracting" | "analyzing">("extracting");
  const [searchCount, setSearchCount] = useState(0);
  const [retries, setRetries] = useState(0);
  const [result, setResult] = useState<DiagnoseResult | null>(null);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const onFile = async (file: File | null) => {
    if (!file || state === "loading") return;
    setState("loading");
    setPhase("extracting");
    setSearchCount(0);
    setRetries(0);
    setError("");
    let finished = false;
    try {
      const dataURL = await compressImage(file);
      const res = await fetch("/api/diagnose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: dataURL, jobs }),
      });
      // 开流前的错误(400/413/段 1 双失败 502)仍是普通 JSON
      if (!res.ok || !res.body) {
        const t = await res.json().catch(() => null);
        throw new Error(t?.error ?? `接口返回 ${res.status}`);
      }
      // SSE:阶段推进 / 补搜 / 重试逐个到达,补搜次数为服务端真实计数
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of chunk.split("\n")) {
            if (!line.startsWith("data:")) continue; // 心跳帧(: ping)忽略
            let ev: any;
            try {
              ev = JSON.parse(line.slice(5).trim());
            } catch {
              continue;
            }
            if (ev.type === "stage" && ev.stage === "analyzing") setPhase("analyzing");
            else if (ev.type === "search") setSearchCount((n) => n + 1);
            else if (ev.type === "retry") setRetries((n) => n + 1);
            else if (ev.type === "done") {
              setResult(ev.report as DiagnoseResult);
              setState("done");
              finished = true;
            } else if (ev.type === "error") {
              throw new Error(ev.message);
            }
          }
        }
      }
      if (!finished) throw new Error("诊断连接中断,未收到完成事件");
    } catch (e: any) {
      setError(String(e?.message ?? e));
      setState("error");
    }
  };

  const extracted = result?.extracted;
  const hit = result?.hit ?? [];
  const gaps = result?.gaps ?? [];
  const target = result?.target;
  const searches = result?.searches ?? [];

  return (
    <section className="panel p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-cyan-300">简历诊断(视觉理解)</h2>
          <p className="mt-1 text-xs text-ink-dim">
            上传简历照片,模型提取技能 / 学历 / 年限,对照本次调研数据给出差距与投递定位
          </p>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            e.target.value = ""; // 允许同一文件重复上传
            onFile(f);
          }}
        />
        <button
          onClick={() => fileRef.current?.click()}
          disabled={state === "loading"}
          className="btn-primary !px-4 !py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50"
        >
          {state === "loading"
            ? phase === "extracting"
              ? "提取简历中…"
              : "分析中…"
            : state === "done"
              ? "再传一张"
              : "上传简历照片"}
        </button>
      </div>

      {state === "loading" && (
        <DiagProgress phase={phase} searches={searchCount} retries={retries} />
      )}

      {state === "error" && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[3px] border border-rose-400/30 bg-rose-400/10 px-4 py-3">
          <p className="text-sm text-rose-200">诊断失败:{error}</p>
          <button
            onClick={() => {
              setState("idle");
              setError("");
            }}
            className="rounded-[3px] border border-rose-400/40 px-3 py-1 text-xs text-rose-200 hover:bg-rose-400/10"
          >
            重新上传
          </button>
        </div>
      )}

      {state === "done" && result && (
        <div className="space-y-4">
          {/* 提取信息条:全部来自照片,统一挂 📷图 证据 */}
          {extracted && (
            <div className="rounded-[3px] border border-violet-400/20 bg-violet-400/[0.05] px-4 py-3">
              <div className="mb-1.5 flex items-center gap-2">
                <h3 className="text-xs font-semibold text-violet-300">照片识别</h3>
                <EvidenceTag evidence="resume" />
              </div>
              <p className="text-xs leading-relaxed text-ink-mid">
                技能
                <span className="text-ink-hi">
                  {extracted.skills?.length ? extracted.skills.join(" / ") : "未识别"}
                </span>
                {extracted.education ? ` · 学历 ${extracted.education}` : " · 学历未识别"}
                {extracted.years ? ` · 年限 ${extracted.years}` : " · 年限未识别"}
                {extracted.degreeYear ? ` · 届别 ${extracted.degreeYear}` : ""}
                {extracted.intent ? ` · 意向 ${extracted.intent}` : ""}
                {extracted.projects?.length ? ` · 项目 ${extracted.projects.join(" / ")}` : " · 项目未识别"}
              </p>
            </div>
          )}

          <div className="grid gap-3 md:grid-cols-2">
            {/* 命中技能 */}
            <div className="rounded-[3px] border border-white/10 bg-white/[0.02] p-4">
              <h3 className="mb-2 text-xs font-semibold text-emerald-300">命中技能(市场需求 TOP 内)</h3>
              {hit.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {hit.map((h, i) => (
                    <span
                      key={i}
                      className="flex items-center gap-1 rounded-[3px] border border-emerald-400/30 bg-emerald-400/10 py-0.5 pl-2 pr-1 text-xs text-emerald-200"
                    >
                      {h.skill}
                      {h.rank ? <span className="text-emerald-400/70">TOP{h.rank}</span> : null}
                      <EvidenceTag evidence={h.evidence} url={h.url} />
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-ink-dim">无命中项</p>
              )}
            </div>

            {/* 市场缺口 */}
            <div className="rounded-[3px] border border-white/10 bg-white/[0.02] p-4">
              <h3 className="mb-2 text-xs font-semibold text-rose-300">市场缺口(需求 TOP,简历没有)</h3>
              {gaps.length ? (
                <ul className="space-y-1.5">
                  {gaps.slice(0, 5).map((g, i) => (
                    <li key={i} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-mid">
                      <span className="text-rose-400/70">{i + 1}.</span>
                      <span>{g.skill}</span>
                      {g.rank ? <span className="text-rose-400/60">需求 TOP{g.rank}</span> : null}
                      <EvidenceTag evidence={g.evidence} url={g.url} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-ink-dim">无缺口项</p>
              )}
            </div>
          </div>

          {/* 投递定位 */}
          {target && (
            <div className="rounded-[3px] border border-cyan-400/20 bg-cyan-400/[0.05] p-4">
              <div className="mb-1.5 flex items-center gap-2">
                <h3 className="text-xs font-semibold text-cyan-300">投递定位</h3>
                <EvidenceTag evidence={target.evidence} url={target.url} />
              </div>
              <p className="text-sm text-ink-hi">
                {target.category || "未给出类别"}
                {target.city ? ` · ${target.city}` : ""}
              </p>
              {target.reason && <p className="mt-1 text-xs text-ink-dim">依据:{target.reason}</p>}
            </div>
          )}

          {/* 一句话结论 */}
          {result.conclusion && (
            <div className="rounded-[3px] border border-white/10 bg-white/[0.02] p-4">
              <h3 className="mb-1.5 text-xs font-semibold text-cyan-300">一句话结论</h3>
              <p className="text-sm leading-relaxed text-ink-hi">{result.conclusion}</p>
            </div>
          )}

          {/* 取证记录:补搜词与各段实测耗时(空补搜 = 岗位池证据足够,本身是有效结果) */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-white/[0.07] pt-3 text-xs text-ink-dim">
            <span>
              判断轮补搜 <b className="readout text-amber-300">{searches.length}</b> 次
              {searches.length === 0 ? "(岗位池证据已足够,未花搜索配额)" : ""}
            </span>
            {searches.map((s, i) => (
              <span key={i} className="inline-flex items-center gap-1">
                🔍
                {s.url ? (
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-cyan-300 underline decoration-cyan-400/40 underline-offset-2 hover:text-cyan-200"
                  >
                    「{s.query}」
                  </a>
                ) : (
                  <span className="text-ink-mid">「{s.query}」</span>
                )}
              </span>
            ))}
            {result.stages && (
              <span className="readout ml-auto">
                提取 {(result.stages.extractMs / 1000).toFixed(1)}s · 分析{" "}
                {(result.stages.agentMs / 1000).toFixed(1)}s
              </span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
