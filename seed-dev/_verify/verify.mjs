// 逐字校验:SYSTEM_PROMPT 与城市/坐标表
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { CITIES, CITY_COORDS } from "./expected.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = "F:/——文章撰写——/火山/jobradar";
let failures = 0;
const ok = (cond, name, extra = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : " " + extra}`);
  if (!cond) failures++;
};

// ---- SYSTEM_PROMPT ----
const agentSrc = readFileSync(join(ROOT, "app/lib/agent.ts"), "utf8");
const m = agentSrc.match(/const SYSTEM_PROMPT = `([\s\S]*?)`;\n\n\/\/ ---------- 预算与开场/);
ok(!!m, "提取到 SYSTEM_PROMPT 模板");
if (m) {
  const expectedPrompt = readFileSync(join(here, "prompt.txt"), "utf8").replace(/\r\n/g, "\n");
  const actual = m[1].replace(/\r\n/g, "\n");
  ok(actual === expectedPrompt, "SYSTEM_PROMPT 与参考逐字一致", `len ${actual.length} vs ${expectedPrompt.length}`);
  if (actual !== expectedPrompt) {
    for (let i = 0; i < Math.max(actual.length, expectedPrompt.length); i++) {
      if (actual[i] !== expectedPrompt[i]) {
        console.log("  首个差异 @", i, JSON.stringify(actual.slice(i - 20, i + 20)), "!!", JSON.stringify(expectedPrompt.slice(i - 20, i + 20)));
        break;
      }
    }
  }
}

// ---- config 数据表 ----
const cfg = await import(pathToFileURL(join(ROOT, "app/lib/config.ts")).href);
ok(cfg.CITIES.length === 36, `CITIES 36 城(实际 ${cfg.CITIES.length})`);
ok(
  JSON.stringify([...cfg.CITIES]) === JSON.stringify(CITIES),
  "CITIES 名单逐字一致(顺序同)"
);
const actualKeys = Object.keys(cfg.CITY_COORDS);
ok(actualKeys.length === 36, `CITY_COORDS 36 条(实际 ${actualKeys.length})`);
ok(JSON.stringify(actualKeys) === JSON.stringify(CITIES), "CITY_COORDS 键集合/顺序与 CITIES 一致");
let coordMismatch = [];
for (const city of CITIES) {
  const a = cfg.CITY_COORDS[city];
  const e = CITY_COORDS[city];
  if (!Array.isArray(a) || a[0] !== e[0] || a[1] !== e[1]) coordMismatch.push([city, a, e]);
}
ok(coordMismatch.length === 0, "36 城坐标逐值一致", JSON.stringify(coordMismatch));

// ---- 其余常量 ----
ok(cfg.MAX_ITERATIONS === 30 && cfg.MAX_SEARCHES === 18 && cfg.MAX_FETCHES === 12, "预算常量 30/18/12");
ok(cfg.TARGET_JOBS_MIN === 18 && cfg.TARGET_JOBS_MAX === 30, "目标岗位 18/30");
ok(JSON.stringify(cfg.JOB_CATEGORIES) === JSON.stringify(["AI/算法", "后端", "前端", "全栈", "测试"]), "JOB_CATEGORIES");
ok(cfg.JOB_TYPES.map((t) => t.value).join(",") === "fulltime,intern,campus", "JOB_TYPES value");
ok(cfg.CREDIBILITY_LABEL.high === "高可信" && cfg.CREDIBILITY_COLOR.low === "zinc", "可信度标签/配色");

process.exit(failures ? 1 : 0);
