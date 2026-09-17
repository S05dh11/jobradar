// 高德 Geocoder 插件连通性检查(不需要 Next.js,直接测 JS API Key 能否地理编码)
// 用法:node scripts/amap-geocode-check.mjs
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9223;
const KEY = "your-amap-key";

const edge = spawn(
  EDGE,
  [
    "--headless=new",
    "--disable-gpu",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${process.env.TEMP}\\jobradar-geo-check`,
    "about:blank",
  ],
  { stdio: "ignore" }
);

async function getPageTarget() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === "page");
      if (page) return page;
    } catch {}
    await sleep(500);
  }
  throw new Error("Edge CDP 未就绪");
}

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
  }
  async open() {
    await new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = rej;
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression, awaitPromise = false) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(`页面 JS 异常: ${r.exceptionDetails.text}`);
    }
    return r.result?.value;
  }
  close() {
    try { this.ws.close(); } catch {}
  }
}

const target = await getPageTarget();
const cdp = new Cdp(target.webSocketDebuggerUrl);
await cdp.open();
await cdp.send("Page.enable");
await cdp.send("Runtime.enable");

// 1) 加载 JS API 脚本
console.log("→ 加载高德 JS API 脚本 ...");
const loadResult = await cdp.eval(
  `(async () => {
    const s = document.createElement("script");
    s.src = "https://webapi.amap.com/maps?v=2.0&key=${KEY}";
    document.head.appendChild(s);
    await new Promise((res, rej) => { s.onload = res; s.onerror = () => rej(new Error("script onerror")); });
    return { hasAMap: !!window.AMap, amapVersion: window.AMap?.version ?? null };
  })()`,
  true
);
console.log("  脚本加载:", JSON.stringify(loadResult));

// 2) 加载 Geocoder 插件
console.log("→ 加载 AMap.Geocoder 插件 ...");
const pluginResult = await cdp.eval(
  `(async () => {
    try {
      await new Promise((res, rej) => {
        AMap.plugin("AMap.Geocoder", res);
        setTimeout(() => rej(new Error("plugin 10s 超时")), 10000);
      });
      return { pluginOk: true };
    } catch (e) {
      return { pluginOk: false, error: String(e?.message ?? e) };
    }
  })()`,
  true
);
console.log("  插件:", JSON.stringify(pluginResult));

// 3) 地理编码一次
if (pluginResult.pluginOk) {
  console.log("→ geocode「杭州 滨江区 阿里巴巴」 ...");
  const geoResult = await cdp.eval(
    `(async () => {
      const g = new AMap.Geocoder({});
      try {
        const r = await new Promise((resolve) => {
          g.getLocation("杭州 滨江区 阿里巴巴", (status, result) => resolve({ status, result }));
        });
        const gc = r.result?.geocodes?.[0];
        return {
          status: r.status,
          info: r.result?.info ?? null,
          count: r.result?.geocodes?.length ?? 0,
          first: gc ? { lng: gc.location.lng, lat: gc.location.lat, formatted: gc.formattedAddress?.slice(0, 60), level: gc.level } : null,
        };
      } catch (e) {
        return { status: "exception", error: String(e?.message ?? e) };
      }
    })()`,
    true
  );
  console.log("  结果:", JSON.stringify(geoResult, null, 2));
}

cdp.close();
edge.kill();
console.log("\n检查完成");
