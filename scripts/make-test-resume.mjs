// 生成假简历测试图(纯虚构信息,不放真实个人信息)
// 用 PowerShell System.Drawing 画 PNG:白底 + 中文文字(微软雅黑)
// 用法:node scripts/make-test-resume.mjs → scripts/out/test-resume.png
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "scripts", "out", "test-resume.png");
mkdirSync(join(ROOT, "scripts", "out"), { recursive: true });

const ps = `
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap 1000, 1300
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::White)
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
$title = New-Object System.Drawing.Font("Microsoft YaHei", 44, [System.Drawing.FontStyle]::Bold)
$body  = New-Object System.Drawing.Font("Microsoft YaHei", 30, [System.Drawing.FontStyle]::Regular)
$brush = [System.Drawing.Brushes]::Black
$g.DrawString("简 历", $title, $brush, 60, 50)
$g.DrawString("张三", $body, $brush, 60, 160)
$g.DrawString("本科 · 3年经验", $body, $brush, 60, 230)
$g.DrawString("技能: Java / Spring Boot / MySQL / Redis", $body, $brush, 60, 300)
$g.DrawString("项目: 电商订单系统(高并发秒杀)", $body, $brush, 60, 370)
$g.DrawString("求职方向: 后端开发工程师", $body, $brush, 60, 440)
$bmp.Save("${OUT.replace(/\\/g, "\\\\")}", [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
Write-Output "saved"
`;

const out = execFileSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" });
console.log("PowerShell:", out.trim());
console.log("已生成:", OUT);
