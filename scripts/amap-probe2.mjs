// setZoomAndCenter 参数顺序对照探针(零搜索配额)
// 每个探针页截两张:换图前(t+2.5s,确认初始瓦片)与加 marker 后(t+8s)
// 用法:node scripts/amap-probe2.mjs
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9226;

mkdirSync("scripts/out", { recursive: true });

const edge = spawn(
  EDGE,
  [
    "--headless=new",
    "--disable-gpu",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${process.env.TEMP}\\jobradar-cdp-probe2`,
    "--window-size=1200,800",
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
    this.console = [];
  }
  async open() {
    await new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = rej;
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method === "Runtime.consoleAPICalled") {
        const text = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ");
        this.console.push(`[${msg.params.type}] ${text}`.slice(0, 260));
      }
      if (msg.method === "Runtime.exceptionThrown") {
        this.console.push(`[exception] ${msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text ?? ""}`.slice(0, 260));
      }
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
  close() {
    try { this.ws.close(); } catch {}
  }
  async shot(name) {
    const s = await this.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(`scripts/out/${name}.png`, Buffer.from(s.data, "base64"));
    console.log(`  ✓ scripts/out/${name}.png`);
  }
}

const target = await getPageTarget();
const cdp = new Cdp(target.webSocketDebuggerUrl);
await cdp.open();
await cdp.send("Page.enable");
await cdp.send("Runtime.enable");

for (const name of ["probe-swap", "probe-correct"]) {
  cdp.console.length = 0;
  console.log(`→ 打开 ${name}`);
  await cdp.send("Page.navigate", { url: `http://localhost:3000/${name}.html` });
  await sleep(2500);
  await cdp.shot(`${name}-early`); // t+2.5s:换图前,初始 zoom4 瓦片应已在
  await sleep(5500); // 等 t+3s 的 setZoomAndCenter 与 t+4.5s 的 marker
  await cdp.shot(`${name}-late`);
  const state = await cdp.send("Runtime.evaluate", {
    expression: `document.getElementById("tag").textContent`,
    returnByValue: true,
  });
  console.log(`  tag: ${state.result.value}`);
  console.log(`  控制台 ${cdp.console.length} 条:`);
  for (const line of cdp.console.slice(0, 10)) console.log("    " + line);
}

cdp.close();
edge.kill();
console.log("探针完成");
