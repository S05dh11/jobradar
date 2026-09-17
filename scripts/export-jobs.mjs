// 从 run-full.log 提取 done 事件里的岗位明细,导出为可直接粘贴给豆包工作的纯文本
// 用法:node scripts/export-jobs.mjs [run-full.log] → 岗位数据-全量.txt
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const file = process.argv[2] || join(ROOT, "run-full.log");
const out = join(ROOT, "岗位数据-全量.txt");

const evs = readFileSync(file, "utf8")
  .split(/\r?\n/)
  .filter((l) => l.startsWith("data: "))
  .map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } })
  .filter(Boolean);

const done = evs.find((e) => e.type === "done");
if (!done) {
  console.error("没有 done 事件,无法导出。最后事件类型:", evs[evs.length - 1]?.type);
  process.exit(1);
}
const r = done.report;
const lines = [];
lines.push(`# JobRadar 岗位调研数据(${new Date().toISOString().slice(0, 10)} 全量运行)`);
lines.push("");
lines.push(`调研范围:${(done.meta?.categories ?? r.categories ?? []).join("/") || "5 类岗位"} × 36 城 × 正式社招`);
lines.push(`搜索 ${r.searchCount} 次,抓取 ${r.fetchCount} 次,登记 ${r.jobs.length} 个岗位,覆盖 ${r.cityCoverage?.length ?? "?"} 城`);
lines.push("");
lines.push("## 岗位明细");
r.jobs.forEach((j, i) => {
  lines.push(`${i + 1}. ${j.company ?? "?"} · ${j.title ?? "?"}`);
  lines.push(`   城市:${j.city ?? "?"}${j.location ? `(${j.location})` : ""} | 薪资:${j.salary ?? "未披露"} | 可信度:${j.credibility ?? "?"}${j.credibilityNote ? `(${j.credibilityNote})` : ""}`);
  if (Array.isArray(j.skills) && j.skills.length) lines.push(`   技能要求:${j.skills.join("、")}`);
  if (j.requirements) lines.push(`   硬性要求:${j.requirements}`);
  if (j.sourceUrl) lines.push(`   来源:${j.sourceUrl}`);
  lines.push("");
});
lines.push("## 调研小结");
lines.push(r.summary ?? "");
writeFileSync(out, lines.join("\r\n"), "utf8");
console.log(`导出 ${r.jobs.length} 个岗位 → ${out}`);
