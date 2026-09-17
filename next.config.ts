import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 关掉 dev 模式左下角的「N」指示徽章,避免截图入镜(不影响错误弹窗)
  devIndicators: false,
};

export default nextConfig;
