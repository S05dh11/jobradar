// 全链路验证脚本(2026-09-16):实习池小跑(AI/算法+后端 × 6城 × 实习) → 报告页 → 复制按钮 → 打码真简历诊断
// 真实调用模型与搜索(约 8-11 次调研搜索 + 1 次视觉 + 0-3 次补搜),产出:
//   scripts/out/verify-running.png / verify-report.png / verify-diagnose.png / verify-report.txt / verify-diagnose.txt
// 用法:先起 dev server,再 node scripts/verify-case.mjs
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9333; // 避开 ui-test 的 9222
const PAGE_URL = process.argv[2] ?? "http://localhost:3000";
const RESUME = resolve("experiments", "简历-打码版.png"); // 仓库内打码样例,在仓库根目录运行
const RUN_TIMEOUT = 18 * 60 * 1000; // 实习池 12 组合,预算内 6-12 分钟
const DIAG_TIMEOUT = 6 * 60 * 1000; // 诊断三段实测 0.5-3 分钟,留富余
const CITIES = ["北京", "上海", "深圳", "杭州", "成都", "西安"];

mkdirSync("scripts/out", { recursive: true });
const edge = spawn(
  EDGE,
  [
    "--headless=new",
    "--disable-gpu",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${process.env.TEMP}\\jobradar-verify-profile`,
    "--window-size=1440,2200",
    "about:blank",
  ],
  { stdio: "ignore" }
);

async function getPageTarget() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json`);
      const page = (await res.json()).find((t) => t.type === "page");
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
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error(`页面 JS 异常: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ""}`);
    }
    return r.result?.value;
  }
  close() {
    try { this.ws.close(); } catch {}
  }
}

const fail = (m) => {
  console.error("FAIL: " + m);
  try { cdp?.close(); } catch {}
  try { edge.kill(); } catch {}
  process.exit(1);
};

const target = await getPageTarget();
const cdp = new Cdp(target.webSocketDebuggerUrl);
await cdp.open();
await cdp.send("Page.enable");
await cdp.send("Runtime.enable");

// ---------- 1. 配置页:AI/算法+后端 × 6城 × 实习 ----------
console.log("→ 打开:", PAGE_URL);
await cdp.send("Page.navigate", { url: PAGE_URL });
await sleep(6000);
if (!(await cdp.eval(`document.body.innerText.includes("开始调研")`))) fail("配置页未渲染");

console.log("→ 配置:AI/算法+后端 × " + CITIES.join("/") + " × 实习");
const conf = await cdp.eval(
  `(async () => {
    const clickBtn = (pred, label) => {
      const b = [...document.querySelectorAll("button")].find(pred);
      if (b) { b.click(); return true; }
      console.error("找不到按钮:" + label);
      return false;
    };
    for (const label of ["前端", "全栈", "测试"]) {
      clickBtn(b => b.textContent.trim() === label, label);
      await new Promise(r => setTimeout(r, 250));
    }
    clickBtn(b => b.textContent.trim() === "清空", "清空");
    await new Promise(r => setTimeout(r, 400));
    for (const c of ${JSON.stringify(CITIES)}) {
      clickBtn(b => b.textContent.trim() === c, c);
      await new Promise(r => setTimeout(r, 200));
    }
    clickBtn(b => b.textContent.trim().startsWith("实习"), "实习");
    await new Promise(r => setTimeout(r, 400));
    return {
      cats: [...document.querySelectorAll("button")].filter(b => b.className.includes("border-cyan")).map(b => b.textContent.trim()),
    };
  })()`,
  true
);
console.log("  勾选结果:", JSON.stringify(conf));

// ---------- 2. 开跑 + 轮询 ----------
console.log("→ 点击「开始调研」");
await cdp.eval(`[...document.querySelectorAll("button")].find(b => b.textContent.includes("开始调研")).click()`);
await sleep(3000);

const t0 = Date.now();
let lastLine = "";
let runningShot = false;
while (Date.now() - t0 < RUN_TIMEOUT) {
  const state = await cdp.eval(`(() => {
    const text = document.body.innerText;
    const isDone = text.includes("技能要求词频");
    const isError = /任务超时|缺少 ARK_API_KEY/.test(text);
    const lines = text.split("\\n").filter(l => /搜索|抓取|登记|完成|错误|超时/.test(l));
    return { isDone, isError, last: lines.slice(-3).join(" | ") };
  })()`);
  if (state.last && state.last !== lastLine) {
    lastLine = state.last;
    console.log(`  [${Math.round((Date.now() - t0) / 1000)}s] ${state.last.slice(-150)}`);
    if (!runningShot && /搜索/.test(lastLine) && /\d{2}:\d{2}/.test(lastLine)) {
      runningShot = true;
      await sleep(2500);
      const s = await cdp.send("Page.captureScreenshot", { format: "png" });
      writeFileSync("scripts/out/verify-running.png", Buffer.from(s.data, "base64"));
      console.log("✓ 运行页截图: scripts/out/verify-running.png");
    }
  }
  if (state.isError) fail("页面出现错误: " + state.last);
  if (state.isDone) {
    console.log(`✓ 报告页出现,调研耗时 ${Math.round((Date.now() - t0) / 1000)}s`);
    break;
  }
  await sleep(4000);
}
if (await cdp.eval(`document.body.innerText.includes("Agent 正在调研中")`)) fail("调研轮询超时未完成");

await sleep(8000); // 地图瓦片
const report = await cdp.eval(`(() => {
  const text = document.body.innerText;
  return {
    jobCards: document.querySelectorAll("article").length,
    mapDots: document.querySelectorAll(".jm-dot").length,
    mapCanvas: document.querySelectorAll("canvas").length,
    hasCredBadge: ["高可信","中可信","低可信"].some(t => text.includes(t)),
    fullText: text,
  };
})()`);
writeFileSync("scripts/out/verify-report.txt", report.fullText);
console.log(`报告页: 岗位卡片 ${report.jobCards} · 地图点 ${report.mapDots} · canvas ${report.mapCanvas} · 可信度徽章 ${report.hasCredBadge}`);
if (report.jobCards === 0) fail("报告页无岗位卡片(全文见 verify-report.txt)");
if (report.mapDots === 0 && report.mapCanvas === 0) fail("地图未渲染");
const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
writeFileSync("scripts/out/verify-report.png", Buffer.from(shot.data, "base64"));
console.log("✓ 报告页整页截图: scripts/out/verify-report.png");

// ---------- 3. 复制岗位表格按钮 ----------
console.log("→ 测试复制按钮");
await cdp.eval(`(() => {
  window.__copied = null;
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    const orig = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = (t) => { window.__copied = t; return orig(t).catch(() => {}); };
  }
})()`);
await cdp.eval(`[...document.querySelectorAll("button")].find(b => b.textContent.trim() === "复制岗位表格")?.click()`);
if (!(await cdp.eval(`[...document.querySelectorAll("button")].some(b => /已复制 \\d+ 个岗位/.test(b.textContent))`))) {
  fail("复制按钮点击后未出现「已复制 N 个岗位」反馈");
}
await sleep(400);
const copied = await cdp.eval(`window.__copied`);
if (!copied) fail("剪贴板 spy 未捕获到表格文本(headless 下无 clipboard API 且兜底路径不可观测)");
const rows = copied.split("\n").filter((l) => l.startsWith("|"));
const dataRows = rows.length - 2; // 表头 + 分隔线
const colOk = rows.every((r) => r.split("|").filter((c) => c.trim() !== "").length === 8);
console.log(`✓ 复制按钮: 表格 ${dataRows} 行数据(卡片 ${report.jobCards}) · 8 列 ${colOk ? "完整" : "不完整!"} · 首行: ${rows[0]?.slice(0, 80)}`);
if (dataRows !== report.jobCards) fail(`复制行数 ${dataRows} ≠ 卡片数 ${report.jobCards}`);
if (!colOk) fail("表格列数不为 8");
if (!copied.includes("来源URL")) fail("表格缺「来源URL」列");

// ---------- 4. 简历诊断(打码真简历) ----------
console.log("→ 上传打码简历做诊断");
const doc = await cdp.send("DOM.getDocument", { depth: -1 });
const node = await cdp.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "input[type=file]" });
if (!node.nodeId) fail("找不到 file input");
await cdp.send("DOM.setFileInputFiles", { files: [RESUME], nodeId: node.nodeId });
await cdp.eval(`document.querySelector("input[type=file]").dispatchEvent(new Event("change", { bubbles: true }))`);

const d0 = Date.now();
let phaseSeen = "";
while (Date.now() - d0 < DIAG_TIMEOUT) {
  const d = await cdp.eval(`(() => {
    const text = document.body.innerText;
    return {
      extracting: text.includes("提取简历中"),
      analyzing: text.includes("分析中"),
      searching: /补搜 \\d+ 次/.exec(text)?.[0] ?? "",
      done: text.includes("一句话结论"),
      error: text.includes("诊断失败:"),
    };
  })()`);
  const ph = `${d.extracting ? "提取中" : ""}${d.analyzing ? "分析中" : ""}${d.searching}`;
  if (ph && ph !== phaseSeen) {
    phaseSeen = ph;
    console.log(`  [${Math.round((Date.now() - d0) / 1000)}s] ${ph}`);
  }
  if (d.error) {
    const msg = await cdp.eval(`document.body.innerText.match(/诊断失败:[^\\n]{0,200}/)?.[0] ?? "?"`);
    fail("诊断失败: " + msg);
  }
  if (d.done) {
    console.log(`✓ 诊断完成,耗时 ${Math.round((Date.now() - d0) / 1000)}s`);
    break;
  }
  await sleep(5000);
}
if (!(await cdp.eval(`document.body.innerText.includes("一句话结论")`))) fail("诊断轮询超时");

const diag = await cdp.eval(`(() => {
  const text = document.body.innerText;
  const i = text.indexOf("简历诊断");
  return { block: text.slice(i, i + 4000), evidence: {
    resume: text.includes("📷图"), pool: text.includes("📊岗位池"), search: text.includes("🔍搜索"),
  }};
})()`);
writeFileSync("scripts/out/verify-diagnose.txt", diag.block);
console.log("证据标签出现: 📷图=" + diag.evidence.resume + " 📊岗位池=" + diag.evidence.pool + " 🔍搜索=" + diag.evidence.search);
if (!diag.evidence.resume || !diag.evidence.pool) fail("证据标签缺失(📷图/📊岗位池 必现)");
const sshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
writeFileSync("scripts/out/verify-diagnose.png", Buffer.from(sshot.data, "base64"));
console.log("✓ 诊断后整页截图: scripts/out/verify-diagnose.png");
console.log("\n===== 诊断区块文本 =====\n" + diag.block.split("\n").slice(0, 40).join("\n"));

cdp.close();
edge.kill();
console.log("\n全链路验证完成 ✅ (调研 " + Math.round((Date.now() - t0) / 1000) + "s + 诊断 " + Math.round((Date.now() - d0) / 1000) + "s)");
