@echo off
cd /d "%~dp0"
echo ============================================
echo  JobRadar 岗位雷达 启动脚本
echo  启动后浏览器访问: http://localhost:3000
echo  关闭本窗口即停止服务
echo ============================================
echo.
if not exist .env.local (
  echo [错误] 缺少 .env.local,请复制 .env.example 并填入 ARK_API_KEY
  pause
  exit /b 1
)
if not exist node_modules (
  echo [首次运行] 安装依赖...
  call npm install
)
call npm run dev
pause
