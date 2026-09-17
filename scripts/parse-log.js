// 解析 run-full.log 的 SSE 事件,输出报告摘要
const fs = require("fs");
const file = process.argv[2] || "run-full.log";
const evs = fs
  .readFileSync(file, "utf-8")
  .split(/\r?\n/)
  .filter((l) => l.startsWith("data: "))
  .map((l) => {
    try { return JSON.parse(l.slice(6)); } catch { return null; }
  })
  .filter(Boolean);

const t = {};
evs.forEach((e) => (t[e.type] = (t[e.type] ?? 0) + 1));
console.log("事件统计:", JSON.stringify(t));

const done = evs.find((e) => e.type === "done");
if (done) {
  const r = done.report;
  console.log("岗位数:", r.jobs.length, "| 搜索:", r.searchCount, "| 抓取:", r.fetchCount);
  console.log("城市覆盖:", r.cityCoverage.join("、"));
  console.log("小结:", r.summary.slice(0, 300));
  console.log("--- 技能 TOP12 ---");
  r.skillRanking.slice(0, 12).forEach((s) => console.log("  " + s.skill + ": " + s.count));
} else {
  console.log("没有 done 事件!最后事件类型:", evs[evs.length - 1]?.type);
}
