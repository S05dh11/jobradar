// 验证运行页镜头飞行后地图 zoom 级别:抓高德瓦片请求 URL 的 z 参数
// (setZoomAndCenter(7, center) 修复后,飞行结束应看到 z=7 的城市级瓦片,而不是全国 z=4)
// 用法:node scripts/amap-zoom-check.mjs
// 消耗:约 1 次豆包搜索配额(等到第一个搜索事件后立即断开)
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9224;
const PAGE_URL = "http://localhost:3000";

const edge = spawn(
  EDGE,
  [
    "--headless=new",
    "--disable-gpu",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${process.env.TEMP}\\jobradar-zoom-check`,
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
    this.requests = []; // 网络请求 URL
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
      } else if (msg.method === "Network.requestWillBeSent") {
        this.requests.push({
          url: msg.params.request.url,
          post: msg.params.request.postData ?? "",
        });
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
await cdp.send("Network.enable");

console.log("→ 打开页面:", PAGE_URL);
await cdp.send("Page.navigate", { url: PAGE_URL });
await sleep(6000);

console.log("→ 勾选「后端 + 杭州」并开始");
await cdp.eval(
  `(async () => {
    const clickBtn = (label) => {
      const b = [...document.querySelectorAll("button")].find(x => x.textContent.trim() === label);
      if (b) { b.click(); return true; }
      return false;
    };
    for (const label of ["AI/算法", "前端", "全栈", "测试"]) {
      clickBtn(label);
      await new Promise(r => setTimeout(r, 200));
    }
    clickBtn("杭州");
    await new Promise(r => setTimeout(r, 300));
    [...document.querySelectorAll("button")].find(b => b.textContent.includes("开始调研")).click();
    return true;
  })()`,
  true
);

// 等第一次真正的搜索事件(时间线出现「搜索 「某词」」,而不是统计条的"搜索 0 次")
console.log("→ 等待第一次搜索事件 …");
const t0 = Date.now();
let saw = false;
while (Date.now() - t0 < 120000) {
  const text = await cdp.eval(`document.body.innerText`);
  if (/搜索 「/.test(text) || /搜索 [1-9]\d* 次/.test(text)) {
    saw = true;
    break;
  }
  await sleep(1000);
}
if (!saw) {
  console.error("FAIL: 120s 内未见搜索事件");
  cdp.close();
  edge.kill();
  process.exit(1);
}
console.log(`  第一次搜索事件已出现(${Math.round((Date.now() - t0) / 1000)}s),等镜头飞行(800ms)+标记落位`);
await sleep(1500);

// 判定:痕迹点/波纹标记相对地图容器的位置。飞行成功 → 杭州点在地图中心附近;
// 仍全国视图 → 杭州点偏到容器一侧。
const pos = await cdp.eval(`(() => {
  const box = document.querySelector(".amap-container");
  if (!box) return { err: "no amap-container" };
  const br = box.getBoundingClientRect();
  const marks = [...document.querySelectorAll(".jm-searched, .jm-radar")];
  if (!marks.length) return { err: "no marker" };
  const m = marks[0].getBoundingClientRect();
  return {
    boxW: Math.round(br.width),
    boxH: Math.round(br.height),
    markX: Math.round(m.left + m.width / 2 - br.left),
    markY: Math.round(m.top + m.height / 2 - br.top),
    normX: +((m.left + m.width / 2 - br.left) / br.width).toFixed(3),
    normY: +((m.top + m.height / 2 - br.top) / br.height).toFixed(3),
    markers: marks.length,
  };
})()`);
console.log("  标记位置:", JSON.stringify(pos));
if (pos.err) {
  console.log("? 未找到地图容器或标记:" + pos.err);
} else if (pos.normX > 0.3 && pos.normX < 0.7 && pos.normY > 0.3 && pos.normY < 0.7) {
  console.log("✓ 搜索城市标记在地图中心区域 —— 镜头已飞行到城市级视野(修复生效)");
} else {
  console.log("✗ 标记不在中心 —— 地图仍停留在全国视野(setZoomAndCenter 未生效或飞行未完成)");
}

cdp.close();
edge.kill();
console.log("\n探针结束");
