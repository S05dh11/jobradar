"use client";

// 报告页岗位分布地图:高德 JS API 2.0。
// 每个岗位标到「公司所在位置」——用高德 Geocoder 插件把「城市+具体地点+公司名」转坐标
// (同一把 JS API Key);转不出的回退到城市中心并聚合计数。
// 城市坐标内置在 lib/config.ts,零服务端 API 调用。

import { useEffect, useRef, useState } from "react";
import type { JobRecord } from "./lib/types";
import { CITIES, CITY_COORDS } from "./lib/config";

const AMAP_KEY = process.env.NEXT_PUBLIC_AMAP_KEY ?? "";
const AMAP_SRC = `https://webapi.amap.com/maps?v=2.0&key=${AMAP_KEY}`;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface Window {
    AMap: any;
  }
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// 岗位 city 字段可能带区/县(如"杭州 滨江区"),取第一个命中的内置城市名
function matchCity(city: string): string | null {
  for (const name of CITIES) {
    if (city.includes(name)) return name;
  }
  return null;
}

// ---------- 地理编码(公司地址 → 坐标,带缓存,失败回退 null) ----------
// 直接调高德 Web 服务端点(实测 2026-09-08:同一把 Key 可用、CORS 全开;
// JS API 的 Geocoder 插件在无头浏览器里回调会挂起,弃用插件方案)
const geoCache = new Map<string, [number, number] | null>();

async function geocodeJob(job: JobRecord): Promise<[number, number] | null> {
  const key = `${job.city}|${job.location ?? ""}|${job.company}`;
  if (geoCache.has(key)) return geoCache.get(key) ?? null;
  try {
    const address = `${job.city}${job.location ? " " + job.location : ""} ${job.company}`.trim();
    const res = await fetch(
      `https://restapi.amap.com/v3/geocode/geo?address=${encodeURIComponent(address)}&key=${AMAP_KEY}`
    );
    if (!res.ok) throw new Error(`http ${res.status}`);
    const data = await res.json();
    if (data?.status !== "1" || !data?.geocodes?.length) throw new Error(data?.info ?? "no result");
    const [lng, lat] = data.geocodes[0].location.split(",").map(Number);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) throw new Error("bad coords");
    const result: [number, number] = [lng, lat];
    geoCache.set(key, result);
    return result;
  } catch {
    geoCache.set(key, null);
    return null;
  }
}

// ---------- 高德脚本加载(模块级,防重复 append;失败可重试) ----------
let amapScriptPromise: Promise<void> | null = null;

function loadAmapScript(): Promise<void> {
  if (window.AMap) return Promise.resolve();
  if (!amapScriptPromise) {
    amapScriptPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = AMAP_SRC;
      s.onload = () => resolve();
      s.onerror = () => {
        amapScriptPromise = null;
        reject(new Error("高德地图脚本加载失败"));
      };
      document.head.appendChild(s);
    });
  }
  return amapScriptPromise;
}

// 公司点:青点 + 公司名(截断)
function companyPin(company: string): string {
  const short = company.length > 8 ? company.slice(0, 8) + "…" : company;
  return `<div class="jm-pin"><span class="jm-dot jm-dot-comp"></span><span class="jm-city">${esc(short)}</span></div>`;
}

export default function JobMap({ jobs }: { jobs: JobRecord[] }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const initedRef = useRef(false);
  const mapRef = useRef<any>(null);
  const heatLayerRef = useRef<{ el: HTMLDivElement; onMove: () => void } | null>(null);
  const heatDataRef = useRef<{ lng: number; lat: number; count: number }[]>([]); // 热力数据(公司坐标,失败回退城市中心)
  const [status, setStatus] = useState<"loading" | "ok" | "fail">("loading");
  const [err, setErr] = useState("");
  const [view, setView] = useState<"company" | "heat">("company");
  const [heatErr, setHeatErr] = useState("");

  useEffect(() => {
    if (initedRef.current) return;
    const el = boxRef.current;
    if (!el || jobs.length === 0) return;
    let cancelled = false;

    const render = async () => {
      if (cancelled || initedRef.current || !boxRef.current) return;
      const AMap = window.AMap;
      if (!AMap) return;
      initedRef.current = true;

      const map = new AMap.Map(boxRef.current, {
        center: [108.5, 34.5],
        zoom: 4,
        mapStyle: "amap://styles/darkblue",
        viewMode: "2D",
        resizeEnable: true,
      });
      mapRef.current = map;

      // 异步 geocode 全部岗位:成功标公司点,失败落入城市兜底计数
      // 同时收集热力数据(同一坐标多条岗位 = 多个点,热力自然叠加)
      const fallback = new Map<string, number>();
      const heatData: { lng: number; lat: number; count: number }[] = [];
      let placed = 0;

      for (const job of jobs) {
        const pos = await geocodeJob(job);
        if (pos) {
          placed++;
          heatData.push({ lng: pos[0], lat: pos[1], count: 1 });
          const [lng, lat] = pos;
          const marker = new AMap.Marker({
            position: [lng, lat],
            content: companyPin(job.company),
            offset: new AMap.Pixel(0, -12),
            zIndex: 100,
          });
          marker.on("click", () => {
            const info = new AMap.InfoWindow({
              content: `<div style="color:#0f172a;font-size:13px;padding:2px 8px;max-width:280px;"><b>${esc(job.title)}</b><br/>${esc(job.company)} · ${esc(job.city)}${job.location ? " · " + esc(job.location) : ""}<br/>${esc(job.salary)}</div>`,
              offset: new AMap.Pixel(0, -20),
            });
            info.open(map, [lng, lat]);
          });
          map.add(marker);
        } else {
          const city = matchCity(job.city);
          if (city) {
            heatData.push({ lng: CITY_COORDS[city][0], lat: CITY_COORDS[city][1], count: 1 });
            fallback.set(city, (fallback.get(city) ?? 0) + 1);
          }
        }
      }
      heatDataRef.current = heatData;

      // 兜底:未定位的岗位按城市聚合计数(气泡样式与旧版一致)
      for (const [name, count] of fallback) {
        const [lng, lat] = CITY_COORDS[name];
        const content = `<div class="jm-pin"><span class="jm-dot">${count}</span><span class="jm-city">${esc(name)}</span></div>`;
        const marker = new AMap.Marker({
          position: [lng, lat],
          content,
          offset: new AMap.Pixel(0, -16),
          zIndex: 95,
        });
        marker.on("click", () => {
          const info = new AMap.InfoWindow({
            content: `<div style="color:#0f172a;font-size:13px;padding:2px 8px;"><b>${esc(name)}</b> · ${count} 个岗位(未定位到公司地址)</div>`,
            offset: new AMap.Pixel(0, -32),
          });
          info.open(map, [lng, lat]);
        });
        map.add(marker);
      }

      // 自动缩放到覆盖全部标记
      map.setFitView(null, false, [80, 80, 80, 80]);
      setStatus("ok");
    };

    // StrictMode 下 effect 双跑:render 的 initedRef 守卫保证同一容器只建一个实例;
    // 模块级 loadAmapScript 保证 <script> 只 append 一次(否则 onload 会触发两次 render)
    loadAmapScript()
      .then(() => render())
      .catch(() => {
        setStatus("fail");
        setErr("高德地图脚本加载失败(请检查 Key 与网络)");
      });

    return () => {
      cancelled = true;
    };
  }, [jobs]);

  // 热力视图:自绘热力层(AMap.HeatMap 插件在 JS API 2.0 本版实测失效——
  // 构造不抛错但 canvas 从不创建;改用 DOM 径向渐变点叠加,地图事件驱动重绘)
  // 青 → 琥珀 → 红 渐变,与页面语义色协调;同一坐标多条岗位 = 多点半透明叠加,自然增强
  useEffect(() => {
    if (view !== "heat" || status !== "ok") {
      if (heatLayerRef.current) heatLayerRef.current.el.style.display = "none";
      return;
    }
    const map = mapRef.current;
    if (!map || heatDataRef.current.length === 0) return;

    const redraw = () => {
      const el = heatLayerRef.current?.el;
      if (!el) return;
      el.innerHTML = "";
      for (const p of heatDataRef.current) {
        const c = map.lngLatToContainer([p.lng, p.lat]);
        if (!c) continue;
        const dot = document.createElement("span");
        dot.style.cssText =
          `position:absolute;left:${c.x}px;top:${c.y}px;width:76px;height:76px;` +
          `transform:translate(-50%,-50%);border-radius:50%;pointer-events:none;` +
          `background:radial-gradient(circle,rgba(239,68,68,0.72) 0%,rgba(245,158,11,0.5) 32%,rgba(34,211,238,0.28) 58%,rgba(34,211,238,0) 74%);` +
          `filter:blur(3px);`;
        el.appendChild(dot);
      }
    };

    if (!heatLayerRef.current) {
      const el = document.createElement("div");
      el.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:2;";
      map.getContainer().appendChild(el);
      const onMove = () => redraw();
      map.on("zoomchange", onMove);
      map.on("moveend", onMove);
      heatLayerRef.current = { el, onMove };
    }
    heatLayerRef.current.el.style.display = "";
    redraw();
    setHeatErr("");
  }, [view, status]);

  return (
    <div className="relative">
      <div ref={boxRef} className="h-[420px] w-full overflow-hidden rounded-xl border border-white/5" />

      {/* 视图切换:公司定位 / 岗位热力 */}
      {status === "ok" && (
        <div className="absolute right-3 top-3 z-10 flex gap-1.5">
          <button
            onClick={() => setView("company")}
            className={
              "rounded-[3px] border px-2.5 py-1 text-xs transition-colors " +
              (view === "company"
                ? "chip-on border-cyan-400/60"
                : "border-white/10 bg-[#0a1018]/80 text-slate-400 hover:text-slate-200")
            }
          >
            公司定位
          </button>
          <button
            onClick={() => setView("heat")}
            className={
              "rounded-[3px] border px-2.5 py-1 text-xs transition-colors " +
              (view === "heat"
                ? "chip-on border-cyan-400/60"
                : "border-white/10 bg-[#0a1018]/80 text-slate-400 hover:text-slate-200")
            }
          >
            岗位热力
          </button>
        </div>
      )}

      {view === "heat" && heatErr && (
        <div className="absolute left-3 top-14 z-10 max-w-[60%] rounded-[3px] border border-rose-400/30 bg-[#0a1018]/90 px-3 py-1.5 text-xs text-rose-200">
          热力图层失败:{heatErr}
        </div>
      )}

      {status !== "ok" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-xl border border-white/5 bg-[#0a1018] text-sm text-slate-400">
          {status === "loading" ? "正在定位各公司地址…" : `地图加载失败:${err}`}
        </div>
      )}
    </div>
  );
}
