// JobRadar 前端 UI 端到端测试(零依赖,CDP 驱动本机 Edge headless)
// 流程:打开页面 → 清空选择 → 勾选「后端 + 杭州」→ 点击开始调研
//       → 轮询 SSE 时间线渲染 → 等待报告页 → 截图
// 用法:node scripts/ui-test.mjs
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9222;
const PAGE_URL = process.argv[2] ?? "http://localhost:3000";
const TIMEOUT_MS = Number(process.argv[3] ?? 10 * 60 * 1000); // 单城调研实测可达 7-8 分钟,预算 10 分钟

mkdirSync("scripts/out", { recursive: true });

// ---------- 启动 headless Edge ----------
const edge = spawn(
  EDGE,
  [
    "--headless=new",
    "--disable-gpu",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${process.env.TEMP}\\jobradar-cdp-profile`,
    "--window-size=1440,2200",
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

// ---------- CDP 客户端 ----------
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
      throw new Error(`页面 JS 异常: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ""}`);
    }
    return r.result?.value;
  }
  close() {
    try { this.ws.close(); } catch {}
  }
}

// ---------- 主流程 ----------
const target = await getPageTarget();
const cdp = new Cdp(target.webSocketDebuggerUrl);
await cdp.open();
await cdp.send("Page.enable");
await cdp.send("Runtime.enable");

console.log("→ 打开页面:", PAGE_URL);
await cdp.send("Page.navigate", { url: PAGE_URL });
await sleep(6000); // 等 Next.js 编译 + React hydration

// 确认配置页渲染
const ready = await cdp.eval(`(() => {
  const btns = [...document.querySelectorAll("button")].map(b => b.textContent.trim());
  return {
    hasTitle: document.body.innerText.includes("JobRadar"),
    hasStart: btns.some(t => t.includes("开始调研")),
    btnCount: btns.length,
  };
})()`);
console.log("配置页:", JSON.stringify(ready));
if (!ready.hasStart) {
  console.error("FAIL: 配置页未渲染出「开始调研」按钮");
  process.exit(1);
}

// 反选其余 4 个类别(只留「后端」)→ 清空城市 → 勾选「杭州」
// 注意:页面上“清空”按钮只清空城市,类别没有全选/清空,需逐个反选
console.log("→ 只留「后端 + 杭州」");
await cdp.eval(
  `(async () => {
    const clickBtn = (label) => {
      const b = [...document.querySelectorAll("button")].find(x => x.textContent.trim() === label);
      if (b) { b.click(); return true; }
      return false;
    };
    for (const label of ["AI/算法", "前端", "全栈", "测试"]) {
      clickBtn(label);
      await new Promise(r => setTimeout(r, 300));
    }
    clickBtn("清空");
    await new Promise(r => setTimeout(r, 400));
    clickBtn("杭州");
    await new Promise(r => setTimeout(r, 400));
    const sel = [...document.querySelectorAll("button")]
      .filter(b => b.className.includes("border-cyan"))
      .map(b => b.textContent.trim());
    return { selected: sel };
  })()`,
  true
).then((r) => console.log("  勾选结果:", JSON.stringify(r.selected)));

// 点击开始调研
console.log("→ 点击「开始调研」");
await cdp.eval(`[...document.querySelectorAll("button")].find(b => b.textContent.includes("开始调研")).click()`);
await sleep(3000);

// 轮询:收集时间线事件 + 等报告页(直接读时间线 DOM 文本)
const t0 = Date.now();
let lastLine = "";
let runningShot = false;
while (Date.now() - t0 < TIMEOUT_MS) {
  const state = await cdp.eval(`(() => {
    const text = document.body.innerText;
    // 严格判定:报告页专属标志(运行页/配置页都不会出现「技能要求词频」)
    const isDone = text.includes("技能要求词频");
    const isError = /任务超时|缺少 ARK_API_KEY/.test(text);
    // 时间线:找含事件图标的行
    const lines = text.split("\\n").filter(l => /搜索|抓取|登记|完成|✓|✗|错误|超时/.test(l));
    return { isDone, isError, last: lines.slice(-3).join(" | "), text };
  })()`);
  if (state.last && state.last !== lastLine) {
    lastLine = state.last;
    console.log(`  [${Math.round((Date.now() - t0) / 1000)}s] ${state.last.slice(-160)}`);
    // 第一次看到「带时刻戳的搜索事件」时截雷达地图(波纹动画约 3s,此刻大概率可见)
    // 时间线事件行都带 mm:ss 时刻;状态栏/图例也含"搜索"二字但没有时刻,以此区分
    if (!runningShot && /搜索/.test(lastLine) && /\d{2}:\d{2}/.test(lastLine)) {
      runningShot = true;
      await sleep(2500); // 等高德瓦片上屏 + 波纹进行到中段(波纹生命 3.2s,此刻必在画内)
      const s1 = await cdp.send("Page.captureScreenshot", { format: "png" });
      writeFileSync("scripts/out/ui-running.png", Buffer.from(s1.data, "base64"));
      console.log("✓ 运行中截图(雷达地图): scripts/out/ui-running.png");
    }
  }
  if (state.isError) {
    console.error("FAIL: 页面出现错误:", state.text.match(/任务超时.*|缺少.*|接口返回.*/)?.[0]);
    process.exit(1);
  }
  if (state.isDone) {
    console.log(`\\n✓ 报告页出现,总耗时 ${Math.round((Date.now() - t0) / 1000)}s`);
    break;
  }
  await sleep(4000);
}

// 轮询超时 = 调研还没跑完,不再继续提取(否则会把运行页误当报告页验证)
const stillRunning = await cdp.eval(`document.body.innerText.includes("Agent 正在调研中")`);
if (stillRunning) {
  console.error("FAIL: 轮询超时,调研仍未完成(单城调研可能需 7-8 分钟)。");
  cdp.close();
  edge.kill();
  process.exit(1);
}

// 等地图脚本加载 + 瓦片渲染(高德 JS API 异步加载)
console.log("→ 等待地图渲染(8s)");
await sleep(8000);

// 提取报告页数据(含地图验证)
const report = await cdp.eval(`(() => {
  const text = document.body.innerText;
  const cards = document.querySelectorAll("article").length;
  const mapDots = document.querySelectorAll(".jm-dot").length;
  const mapLabels = document.querySelectorAll(".jm-city").length;
  const mapCanvas = document.querySelectorAll("canvas").length;
  const skillBlock = [...text.split("\\n")].filter(l => /词频/.test(l));
  return {
    jobCards: cards,
    mapDots,
    mapLabels,
    mapCanvas,
    hasSkillRanking: text.includes("词频"),
    hasCredBadge: ["高可信","中可信","低可信"].some(t => text.includes(t)),
    hasLocationPin: text.includes("📍"),
    hasReqBadge: text.includes("必须:"),
    skillHead: skillBlock[0] ?? "",
    textHead: text.slice(0, 1200),
    sample: text.slice(0, 1500),
  };
})()`);
console.log("报告页:", JSON.stringify({ jobCards: report.jobCards, mapDots: report.mapDots, mapLabels: report.mapLabels, mapCanvas: report.mapCanvas, hasSkillRanking: report.hasSkillRanking, hasCredBadge: report.hasCredBadge, hasLocationPin: report.hasLocationPin, hasReqBadge: report.hasReqBadge, skillHead: report.skillHead }));
if (report.jobCards === 0) {
  console.error("FAIL: 报告页无岗位卡片。页面文本前 1200 字:");
  console.error(report.textHead);
}
if (report.mapDots === 0 && report.mapCanvas === 0) {
  console.error("FAIL: 地图未渲染(marker 与 canvas 均为 0)");
} else {
  console.log(`✓ 地图已渲染:${report.mapDots} 个城市标记,${report.mapLabels} 个城市标签,${report.mapCanvas} 个 canvas`);
}
if (report.hasSkillRanking) {
  const skills = await cdp.eval(`(() => {
    const idx = document.body.innerText.indexOf("词频");
    return document.body.innerText.slice(idx, idx + 300);
  })()`);
  console.log("技能排行区:\n" + skills.split("\n").slice(0, 12).join("\n"));
}

// 截图(整页,包含地图/技能排行/岗位卡片)
const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
writeFileSync("scripts/out/ui-report.png", Buffer.from(shot.data, "base64"));
console.log("✓ 截图已保存: scripts/out/ui-report.png (" + Buffer.from(shot.data, "base64").length + " 字节)");

cdp.close();
edge.kill();
console.log("\nUI 测试完成 ✅");
