// 配置页启动序列验证(零配额,CDP 驱动 headless Edge)
// 1) ~500ms 截 boot-early.png:应捕捉到扫描线或未全点亮的面板
// 2) 5s 后截 boot-final.png:全部点亮,「开始调研」按钮存在
// 3) Emulation.setEmulatedMedia 模拟 prefers-reduced-motion: reduce → reload → 截 boot-reduced.png:直接最终态
// 判定:early 与 final 有像素差异(动画在播);reduced 与 final 几乎一致(无动画中间帧)
// 用法:node scripts/boot-check.mjs(需 dev server 在 localhost:3000)
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "scripts", "out");
const EARLY = join(OUT_DIR, "boot-early.png");
const FINAL = join(OUT_DIR, "boot-final.png");
const REDUCED = join(OUT_DIR, "boot-reduced.png");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9226;
const PAGE_URL = process.argv[2] ?? "http://localhost:3000";

mkdirSync(OUT_DIR, { recursive: true });

const edge = spawn(
  EDGE,
  [
    "--headless=new",
    "--disable-gpu",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${process.env.TEMP}\\jobradar-boot-check`,
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

// ---- 1) 早期帧(约 500ms:扫描线进行中,面板 2-4 尚未点亮) ----
console.log("→ 打开页面:", PAGE_URL);
await cdp.send("Page.navigate", { url: PAGE_URL });
await sleep(500);
let shot = await cdp.send("Page.captureScreenshot", { format: "png" });
writeFileSync(EARLY, Buffer.from(shot.data, "base64"));
console.log("✓ 早期帧截图:", EARLY);

// ---- 2) 最终态(5s,动画全部结束) ----
await sleep(4500);
const finalState = await cdp.eval(`(() => ({
  hasStart: document.body.innerText.includes("开始调研"),
  panels: document.querySelectorAll(".boot-panel").length,
  scanline: !!document.querySelector(".boot-scanline"),
}))()`);
console.log("  最终态 DOM:", JSON.stringify(finalState));
if (!finalState.hasStart) {
  console.error("FAIL: 「开始调研」按钮不存在");
  cdp.close();
  edge.kill();
  process.exitCode = 1;
  await sleep(300);
  throw new Error("开始调研缺失");
}
shot = await cdp.send("Page.captureScreenshot", { format: "png" });
writeFileSync(FINAL, Buffer.from(shot.data, "base64"));
console.log("✓ 最终态截图:", FINAL);

// ---- 3) reduced-motion 模拟 ----
console.log("→ 模拟 prefers-reduced-motion: reduce 并重载");
await cdp.send("Emulation.setEmulatedMedia", {
  features: [{ name: "prefers-reduced-motion", value: "reduce" }],
});
await cdp.send("Page.reload");
await sleep(1500);
const reducedState = await cdp.eval(`(() => ({
  hasStart: document.body.innerText.includes("开始调研"),
  scanline: !!document.querySelector(".boot-scanline"),
  scanVisible: (() => {
    const s = document.querySelector(".boot-scanline");
    return s ? getComputedStyle(s).display !== "none" : false;
  })(),
}))()`);
console.log("  reduce 态 DOM:", JSON.stringify(reducedState));
shot = await cdp.send("Page.captureScreenshot", { format: "png" });
writeFileSync(REDUCED, Buffer.from(shot.data, "base64"));
console.log("✓ reduce 态截图:", REDUCED);

cdp.close();
edge.kill();

// ---- 像素判定 ----
function diffCount(a, b) {
  const ps = `
Add-Type -AssemblyName System.Drawing
$ia = [System.Drawing.Image]::FromFile("${a.replace(/\\/g, "\\\\")}")
$ib = [System.Drawing.Image]::FromFile("${b.replace(/\\/g, "\\\\")}")
$ba = New-Object System.Drawing.Bitmap $ia
$bb = New-Object System.Drawing.Bitmap $ib
$diff = 0; $total = 0
$w = [Math]::Min($ba.Width, $bb.Width)
$h = [Math]::Min($ba.Height, $bb.Height)
for ($x = 0; $x -lt $w; $x += 5) {
  for ($y = 0; $y -lt $h; $y += 5) {
    $total++
    $ca = $ba.GetPixel($x, $y); $cb = $bb.GetPixel($x, $y)
    if ([Math]::Abs($ca.R - $cb.R) -gt 12 -or [Math]::Abs($ca.G - $cb.G) -gt 12 -or [Math]::Abs($ca.B - $cb.B) -gt 12) { $diff++ }
  }
}
$ba.Dispose(); $bb.Dispose(); $ia.Dispose(); $ib.Dispose()
Write-Output "$diff $total"
`;
  const out = execFileSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" });
  const [diff, total] = out.trim().split(/\s+/).map(Number);
  return { diff, total };
}

const earlyVsFinal = diffCount(EARLY, FINAL);
const reducedVsFinal = diffCount(REDUCED, FINAL);
console.log(`\n像素对比(5px 采样):`);
console.log(`  early vs final: 差异 ${earlyVsFinal.diff}/${earlyVsFinal.total}`);
console.log(`  reduced vs final: 差异 ${reducedVsFinal.diff}/${reducedVsFinal.total}`);

let fail = false;
if (earlyVsFinal.diff < 100) {
  console.error("✗ early 与 final 几乎无差异:启动动画可能没在播");
  fail = true;
} else {
  console.log("✓ early 与 final 有明显差异:启动序列确实在播放");
}
if (reducedVsFinal.diff > earlyVsFinal.diff * 0.3) {
  console.error("✗ reduced 与 final 差异过大:reduce 态可能不是最终态");
  fail = true;
} else {
  console.log("✓ reduced 与 final 基本一致:减弱动效偏好下直接呈现最终态");
}

await sleep(300);
if (fail) process.exitCode = 1;
console.log("\n检查完成");
