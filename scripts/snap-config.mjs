// 配置页成品截图(零配额):等启动序列播完后截最终态,供文章/UI 核对
// 用法:node scripts/snap-config.mjs(需 dev server 在 localhost:3000)
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "scripts", "out", "config-snap.png");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9227;
const PAGE_URL = process.argv[2] ?? "http://localhost:3000";

mkdirSync(join(ROOT, "scripts", "out"), { recursive: true });

const edge = spawn(
  EDGE,
  [
    "--headless=new",
    "--disable-gpu",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${process.env.TEMP}\\jobradar-config-snap`,
    "--window-size=1440,1200",
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
    if (r.exceptionDetails) throw new Error(`页面 JS 异常: ${r.exceptionDetails.text}`);
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

console.log("→ 打开页面:", PAGE_URL);
await cdp.send("Page.navigate", { url: PAGE_URL });
await sleep(6000); // 启动序列(约 1s)完全结束

const state = await cdp.eval(`(() => {
  const panels = [...document.querySelectorAll(".boot-panel")];
  return {
    hasStart: document.body.innerText.includes("开始调研"),
    panelOpacities: panels.map((p) => getComputedStyle(p).opacity),
    scanVisible: (() => {
      const s = document.querySelector(".boot-scanline");
      return s ? getComputedStyle(s).opacity !== "0" : false;
    })(),
  };
})()`);
console.log("  状态:", JSON.stringify(state));
if (!state.hasStart) {
  console.error("FAIL: 「开始调研」按钮不存在");
  cdp.close();
  edge.kill();
  process.exitCode = 1;
  await sleep(300);
  throw new Error("配置页异常");
}
if (state.panelOpacities.some((o) => Number(o) < 1)) {
  console.error("FAIL: 有面板未完全点亮(动画残留):", state.panelOpacities.join(","));
  cdp.close();
  edge.kill();
  process.exitCode = 1;
  await sleep(300);
  throw new Error("动画残留");
}
if (state.scanVisible) {
  console.error("FAIL: 扫描线在最终态仍可见");
  process.exitCode = 1;
}

const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
writeFileSync(OUT, Buffer.from(shot.data, "base64"));
console.log("✓ 配置页成品截图(无动画残留):", OUT);

cdp.close();
edge.kill();
await sleep(300);
console.log("\n完成");
