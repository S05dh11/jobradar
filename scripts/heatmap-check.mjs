// 热力视图零配额验证:headless Edge 打开 /dev-report(假数据夹具页)
// 截「公司定位」视图 → 点「岗位热力」→ 截热力视图 → PowerShell 像素判定
// 判定:热力截图地图区域出现暖色(琥珀/红)渐变像素 = AMap.HeatMap 渲染成功
// 用法:node scripts/heatmap-check.mjs(需 dev server 在 localhost:3000)
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "scripts", "out");
const COMPANY_PNG = join(OUT_DIR, "heatmap-company.png");
const HEAT_PNG = join(OUT_DIR, "heatmap-heatmap.png");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9225;
const PAGE_URL = process.argv[2] ?? "http://localhost:3000/dev-report";

mkdirSync(OUT_DIR, { recursive: true });

const edge = spawn(
  EDGE,
  [
    "--headless=new",
    "--disable-gpu",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${process.env.TEMP}\\jobradar-heatmap-check`,
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
    this.logs = []; // console / 异常收集
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
      } else if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params.exceptionDetails;
        const stack = d?.stackTrace?.callFrames?.slice(0, 8).map((f) => `${f.functionName ?? "?"}@${f.url?.split("/").pop()}:${f.lineNumber}`).join(" <- ");
        this.logs.push("EXC: " + (d?.exception?.description ?? d?.text ?? "?").slice(0, 200) + " | " + stack);
      } else if (msg.method === "Runtime.consoleAPICalled") {
        const args = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? "?").join(" ");
        this.logs.push(`CONSOLE[${msg.params.type}]: ` + args.slice(0, 300));
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

console.log("→ 打开夹具页:", PAGE_URL);
await cdp.send("Page.navigate", { url: PAGE_URL });
await sleep(12000); // 等地图 + geocode 完成

// 确认切换按钮已渲染(JobMap status=ok 后出现)
const btns = await cdp.eval(
  `[...document.querySelectorAll("button")].map(b => b.textContent.trim())`
);
console.log("  页面按钮:", JSON.stringify(btns));
if (!btns.includes("岗位热力")) {
  console.error("FAIL: 未找到「岗位热力」按钮(地图可能未就绪)");
  cdp.close();
  edge.kill();
  process.exitCode = 1;
  await sleep(300);
  throw new Error("按钮缺失");
}

// 截「公司定位」视图
let shot = await cdp.send("Page.captureScreenshot", { format: "png" });
writeFileSync(COMPANY_PNG, Buffer.from(shot.data, "base64"));
console.log("✓ 公司定位视图截图:", COMPANY_PNG);

// 切到「岗位热力」
console.log("→ 点击「岗位热力」");
await cdp.eval(
  `[...document.querySelectorAll("button")].find(b => b.textContent.trim() === "岗位热力").click()`
);
await sleep(6000); // 等热力层渲染 + 瓦片

const heatDiag = await cdp.eval(`(() => ({
  heatType: typeof window.AMap?.HeatMap,
  canvas: document.querySelectorAll("canvas").length,
}))()`);
console.log(`  AMap.HeatMap 类型:${heatDiag.heatType} | 页面 canvas 数:${heatDiag.canvas}`);
const errUi = await cdp.eval(
  `(() => { const t = document.body.innerText; const i = t.indexOf("热力图层失败"); return i < 0 ? "(无)" : t.slice(i, i + 120); })()`
);
console.log("  热力错误 UI:", errUi);
const heatDiagState = await cdp.eval(
  `(() => JSON.stringify({ d1: window.__heatDiag ?? null, d2: window.__heatDiag2 ?? null, d3: window.__heatDiag3 ?? null, canvas: document.querySelectorAll("canvas").length }))()`
);
console.log("  组件内诊断:", heatDiagState);
console.log("  页面日志/异常:");
for (const l of cdp.logs.slice(-10)) console.log("    " + l);

// 独立探针:在页面里新建 map + HeatMap 复现构造过程,定位失败环节
// 对比组:无 mapStyle vs 带 darkblue(JobMap 实图样式)
const probe = await cdp.eval(
  `(async () => {
    const run = async (label, mapOpts, afterCreate) => {
      try {
        const div = document.createElement("div");
        div.style.cssText = "position:fixed;left:-3000px;top:0;width:600px;height:600px;";
        document.body.appendChild(div);
        const m = new AMap.Map(div, { zoom: 4, center: [108.5, 34.5], viewMode: "2D", ...mapOpts });
        if (afterCreate) await afterCreate(m);
        // 动态加载插件(对比 &plugin= 预加载的类是否有效)
        await new Promise((res, rej) => {
          AMap.plugin("AMap.HeatMap", () => res());
          setTimeout(() => rej(new Error("plugin 加载超时")), 8000);
        });
        const h = new AMap.HeatMap(m, {
          radius: 18, opacity: [0, 0.7], zooms: [3, 12],
          gradient: { 0.2: "#22d3ee", 0.55: "#f59e0b", 1: "#ef4444" },
        });
        h.setDataSet({ data: [{ lng: 116.4, lat: 39.9, count: 3 }, { lng: 120.15, lat: 30.27, count: 5 }], max: 10 });
        h.show();
        await new Promise((r) => setTimeout(r, 1200));
        return { label, ok: true, canvasAfter: document.querySelectorAll("canvas").length };
      } catch (e) {
        return { label, ok: false, error: String(e?.stack ?? e).slice(0, 300) };
      }
    };
    const a = await run("无样式", {});
    const b = await run("darkblue", { mapStyle: "amap://styles/darkblue" });
    // 复刻组件 map 状态:resizeEnable + marker + setFitView
    const c = await run("组件同款", { mapStyle: "amap://styles/darkblue", resizeEnable: true }, async (m) => {
      await new Promise((r) => setTimeout(r, 800));
      m.add(new AMap.Marker({ position: [116.4, 39.9], content: "<span>x</span>" }));
      m.setFitView(null, false, [80, 80, 80, 80]);
      await new Promise((r) => setTimeout(r, 800));
    });
    // 读最后一个 canvas(HeatMap 层)的非透明像素数
    let nonzero = -1; let lastW = 0; let lastH = 0;
    try {
      const cs = [...document.querySelectorAll("canvas")];
      const hc = cs[cs.length - 1];
      lastW = hc.width; lastH = hc.height;
      const d = hc.getContext("2d").getImageData(0, 0, hc.width, hc.height).data;
      nonzero = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) nonzero++;
    } catch {}
    return [a, b, c, { heatCanvasW: lastW, heatCanvasH: lastH, nonzeroPixels: nonzero, totalCanvas: document.querySelectorAll("canvas").length }];
  })()`,
  true
);
console.log("  独立探针:", JSON.stringify(probe, null, 2));

shot = await cdp.send("Page.captureScreenshot", { format: "png" });
writeFileSync(HEAT_PNG, Buffer.from(shot.data, "base64"));
console.log("✓ 热力视图截图:", HEAT_PNG);

cdp.close();
edge.kill();

// ---- 像素判定:暖色渐变像素(琥珀/红) = HeatMap 渲染的证据 ----
function warmPixels(file) {
  const ps = `
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile("${file.replace(/\\/g, "\\\\")}")
$bmp = New-Object System.Drawing.Bitmap $img
$warm = 0; $cyan = 0; $total = 0
for ($x = 0; $x -lt $bmp.Width; $x += 4) {
  for ($y = 200; $y -lt [Math]::Min(1150, $bmp.Height); $y += 4) {
    $total++
    $c = $bmp.GetPixel($x, $y)
    if ($c.R -gt 190 -and $c.G -lt 110 -and $c.B -lt 110) { $warm++ }
    elseif ($c.R -gt 190 -and $c.G -ge 110 -and $c.G -le 210 -and $c.B -lt 130) { $warm++ }
    if ($c.G -gt 120 -and $c.B -gt 120 -and $c.R -lt 160) { $cyan++ }
  }
}
$bmp.Dispose(); $img.Dispose()
Write-Output "$warm $cyan $total"
`;
  const out = execFileSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" });
  const [warm, cyan, total] = out.trim().split(/\s+/).map(Number);
  return { warm, cyan, total };
}

const company = warmPixels(COMPANY_PNG);
const heat = warmPixels(HEAT_PNG);
console.log(`\n像素判定(采样区域 200~1150px 高度):`);
console.log(`  公司定位视图: 暖色=${company.warm} 青色=${company.cyan} 采样=${company.total}`);
console.log(`  热力视图:     暖色=${heat.warm} 青色=${heat.cyan} 采样=${heat.total}`);

if (heat.warm > 30 && heat.warm > company.warm * 2) {
  console.log("✓ 判定通过:热力视图出现暖色渐变像素(青→琥珀→红梯度),HeatMap 已渲染");
} else {
  console.error("✗ 判定失败:热力视图未见明显暖色渐变像素");
  process.exitCode = 1;
}

await sleep(300);
console.log("\n检查完成");
