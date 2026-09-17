"use client";

// 运行页雷达地图:agent 调研过程可视化。
// - search 事件:镜头飞向对应城市 + 雷达波纹扩散动画(数秒后消失),已搜城市留痕迹点
// - job 事件:岗位标到「公司所在位置」——用高德 Geocoder 插件把「城市+具体地点+公司名」
//   转坐标(同一把 JS API Key);转不出的回退到城市坐标。
// 城市坐标内置(config.ts),零服务端 API 调用。

import { useEffect, useRef, useState } from "react";
import type { AgentEvent, JobRecord } from "./lib/types";
import { CITIES, CITY_COORDS } from "./lib/config";

const AMAP_KEY = process.env.NEXT_PUBLIC_AMAP_KEY ?? "";
const AMAP_SRC = `https://webapi.amap.com/maps?v=2.0&key=${AMAP_KEY}`;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface Window {
    AMap: any;
  }
}

// 从文本(搜索词 / 岗位城市字段)提取命中的内置城市名
function cityFromText(text: string): string | null {
  for (const name of CITIES) {
    if (text.includes(name)) return name;
  }
  return null;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// 雷达波纹 marker(纯 CSS 动画,数秒后自动移除)
function addRadarPing(map: any, AMap: any, lng: number, lat: number) {
  const content =
    '<div class="jm-radar">' +
    '<span class="jm-radar-ring"></span>' +
    '<span class="jm-radar-ring jm-radar-ring2"></span>' +
    '<span class="jm-radar-core"></span>' +
    "</div>";
  const m = new AMap.Marker({
    position: [lng, lat],
    content,
    offset: new AMap.Pixel(-32, -32),
    zIndex: 120,
  });
  map.add(m);
  setTimeout(() => {
    try {
      map.remove(m);
    } catch {}
  }, 3200);
}

// 已搜城市痕迹点:空心青圈 + 城市名(比之前的淡点明显,画面不空)
function addSearchedMark(map: any, AMap: any, lng: number, lat: number, city: string) {
  const m = new AMap.Marker({
    position: [lng, lat],
    content: `<div class="jm-pin"><span class="jm-searched"></span><span class="jm-city jm-city-dim">${esc(city)}</span></div>`,
    offset: new AMap.Pixel(0, -12),
    zIndex: 90,
  });
  map.add(m);
}

// ---------- 地理编码(公司地址 → 坐标,带缓存) ----------
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
    // 回退:城市中心坐标
    const city = cityFromText(job.city);
    const fallback = city ? CITY_COORDS[city] : null;
    geoCache.set(key, fallback ?? null);
    return fallback ?? null;
  }
}

// ---------- 高德脚本加载(模块级,防止 <script> 被追加两次) ----------
let amapScriptPromise: Promise<void> | null = null;

function loadAmapScript(): Promise<void> {
  if (window.AMap) return Promise.resolve();
  if (!amapScriptPromise) {
    amapScriptPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = AMAP_SRC;
      s.onload = () => resolve();
      s.onerror = () => {
        // 失败的 promise 不能留在模块缓存里,否则重试会永久拿到 rejected
        amapScriptPromise = null;
        reject(new Error("高德地图脚本加载失败"));
      };
      document.head.appendChild(s);
    });
  }
  return amapScriptPromise;
}

// 公司点 marker:青点 + 公司名(截断 8 字)
function companyPin(company: string): string {
  const short = company.length > 8 ? company.slice(0, 8) + "…" : company;
  return `<div class="jm-pin"><span class="jm-dot jm-dot-comp"></span><span class="jm-city">${esc(short)}</span></div>`;
}

export default function RadarMap({ events, jobs }: { events: AgentEvent[]; jobs: JobRecord[] }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const initedRef = useRef(false); // 同一容器只 new 一次(StrictMode 双跑守卫)
  const lastIdxRef = useRef(0);
  const searchedRef = useRef<Set<string>>(new Set());
  const placedRef = useRef<Set<string>>(new Set()); // 已标点的岗位(sourceUrl)
  const [mapReady, setMapReady] = useState(false); // init 完成后触发事件 effect 补画积压事件
  const [status, setStatus] = useState<"loading" | "ok" | "fail">("loading"); // 加载/初始化状态
  const [attempt, setAttempt] = useState(0); // 重试计数:变化时重跑初始化 effect

  // 初始化地图
  // StrictMode(dev)下 effect 会跑「挂载→清理→再挂载」:cleanup 销毁实例并重置守卫,
  // 第二轮重建,保证同一容器永远只有一个活的地图实例(否则会叠两个 AMap.Map,
  // 空壳盖在上层 = 白板 + marker 被压底,且时好时坏全看加载时序)。
  useEffect(() => {
    const el = boxRef.current;
    if (!el || initedRef.current) return;
    let cancelled = false;

    const init = () => {
      if (cancelled || initedRef.current || !boxRef.current || !window.AMap) return;
      try {
        mapRef.current = new window.AMap.Map(boxRef.current, {
          center: [108.5, 34.5],
          zoom: 4,
          mapStyle: "amap://styles/darkblue",
          viewMode: "2D",
          resizeEnable: true,
        });
        initedRef.current = true;
        setMapReady(true);
        setStatus("ok");
      } catch {
        setStatus("fail");
      }
    };

    setStatus(initedRef.current ? "ok" : "loading");
    if (window.AMap) {
      init();
    } else {
      loadAmapScript()
        .then(() => init())
        .catch(() => {
          setStatus("fail"); // 加载失败:时间线仍可用,地图区域显示离线态 + 重试
        });
    }

    return () => {
      cancelled = true;
      if (initedRef.current) {
        initedRef.current = false;
        try {
          mapRef.current?.destroy();
        } catch {}
        mapRef.current = null;
        setMapReady(false);
      }
    };
  }, [attempt]);

  // 增量处理新事件:search 雷达飞行;job 公司级标点(异步 geocode)
  // mapReady 纳入依赖:地图初始化完成时重跑一次,补画脚本加载期间到达的积压事件
  useEffect(() => {
    if (!mapReady) return;
    const map = mapRef.current;
    const AMap = window.AMap;
    if (!map || !AMap) return;

    for (let i = lastIdxRef.current; i < events.length; i++) {
      const ev = events[i];
      if (ev.type === "search") {
        const city = cityFromText(ev.query);
        if (city && CITY_COORDS[city]) {
          const [lng, lat] = CITY_COORDS[city];
          // 镜头飞向搜索城市(zoom 7:能看到城市周边,不会"空无一物")
          // 注意:JS API 2.0 签名为 setZoomAndCenter(zoom, center, ...),zoom 在前——
          // 传反会静默打死渲染管线(瓦片不再绘制、marker 不显示,且不抛错)
          map.setZoomAndCenter(7, [lng, lat], false, 800);
          addRadarPing(map, AMap, lng, lat);
          if (!searchedRef.current.has(city)) {
            searchedRef.current.add(city);
            addSearchedMark(map, AMap, lng, lat, city);
          }
        }
      } else if (ev.type === "job") {
        const job = ev.job;
        if (placedRef.current.has(job.sourceUrl)) continue;
        placedRef.current.add(job.sourceUrl);
        // 异步:公司地址转坐标后标点(失败回退城市坐标)
        geocodeJob(job).then((pos) => {
          if (!pos || !mapRef.current) return;
          const [lng, lat] = pos;
          const marker = new AMap.Marker({
            position: [lng, lat],
            content: companyPin(job.company),
            offset: new AMap.Pixel(0, -12),
            zIndex: 100,
          });
          marker.on("click", () => {
            const info = new AMap.InfoWindow({
              content: `<div style="color:#0f172a;font-size:13px;padding:2px 8px;max-width:260px;"><b>${esc(job.title)}</b><br/>${esc(job.company)} · ${esc(job.city)}${job.location ? " · " + esc(job.location) : ""}<br/>${esc(job.salary)}</div>`,
              offset: new AMap.Pixel(0, -20),
            });
            info.open(mapRef.current, [lng, lat]);
          });
          mapRef.current.add(marker);
        });
      }
    }
    lastIdxRef.current = events.length;
  }, [events, mapReady]);

  return (
    <div className="relative h-full min-h-[420px] w-full">
      <div ref={boxRef} className="h-full w-full" />

      {/* 加载/失败状态遮罩 */}
      {status === "loading" && (
        <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl border border-white/5 bg-[#0a1018] text-sm text-slate-400">
          雷达启动中…
        </div>
      )}
      {status === "fail" && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 rounded-xl border border-white/5 bg-[#0a1018] text-sm text-slate-400">
          <p>雷达离线:高德地图加载失败</p>
          <button
            onClick={() => {
              setStatus("loading");
              setAttempt((a) => a + 1);
            }}
            className="rounded-lg border border-white/10 px-3 py-1 text-xs text-slate-400 transition-colors hover:border-white/25 hover:text-slate-200"
          >
            重试
          </button>
        </div>
      )}

      <div className="pointer-events-none absolute left-3 top-3 rounded-lg border border-white/10 bg-[#0a1018]/80 px-3 py-1.5 text-xs text-slate-400">
        雷达扫描中:每次搜索飞向目标城市 · 圆点 = 已登记岗位所在公司
      </div>
    </div>
  );
}
