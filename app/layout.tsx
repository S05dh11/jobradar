import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

// 展示字体自托管(latin 子集,各 10KB),构建时不访问 Google——国内服务器 next build 不会被墙卡住
const chakra = localFont({
  src: [
    { path: "./fonts/chakra-petch-600.woff2", weight: "600", style: "normal" },
    { path: "./fonts/chakra-petch-700.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-chakra",
  display: "swap",
});

export const metadata: Metadata = {
  title: "JobRadar 岗位雷达",
  description: "由 doubao-seed-evolving 驱动的招聘调研 Demo:模型自主搜索、抓取、交叉核实,报告逐条可溯源",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN" className={`${chakra.variable} h-full antialiased`}>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
