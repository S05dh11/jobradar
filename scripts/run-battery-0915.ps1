# 0915 重跑实验流水线:exp1×4 → exp2 → diag-test → 全量调研 → parse-log
# 前置:dev server 已在 localhost:3000 运行(由外部启动,本脚本不管启停)
# 用法:由主会话以脱离进程方式启动,进度看 battery-run.log
$ErrorActionPreference = 'Continue'
Set-Location (Join-Path $PSScriptRoot '..')
$log = "battery-run.log"
Remove-Item $log -ErrorAction SilentlyContinue
function Log($m) { Add-Content $log "$(Get-Date -Format 'HH:mm:ss') $m" }
Log "BATTERY START (model: doubao-seed-evolving / Seed-2.1-pro-0915 口径)"

Log "=== [1/5] exp1 真实性陷阱(4 题) ==="
node scripts/exp1-truth-trap.mjs *>> $log
Log "exp1 exit=$LASTEXITCODE"

Log "=== [2/5] exp2 多工具协同 ==="
node scripts/exp2-gap-report.mjs *>> $log
Log "exp2 exit=$LASTEXITCODE"

Log "=== [3/5] diag-test 简历诊断 ==="
if (-not (Test-Path "scripts\out\test-resume.png")) { node scripts/make-test-resume.mjs *>> $log }
node scripts/diag-test.mjs *>> $log
Log "diag exit=$LASTEXITCODE"

Log "=== [4/5] 全量调研 curl(最长 16 分钟) ==="
curl.exe -s -N -m 960 -X POST http://localhost:3000/api/radar -H "Content-Type: application/json" --data-binary "@body-full.json" -o run-full.log
Log "curl exit=$LASTEXITCODE (0=正常结束;28=超时被截,数据可能仍在)"

Log "=== [5/5] parse-log ==="
node scripts/parse-log.js run-full.log *>> $log
Log "parse exit=$LASTEXITCODE"

$ok = (Select-String -Path $log -Pattern 'exit=0$').Count
if ($ok -ge 5) { Log "BATTERY DONE" } else { Log "BATTERY FAILED (exit=0 的步骤只有 $ok/5)" }
