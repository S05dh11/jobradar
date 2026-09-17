"use client";

// 开发夹具页(dev fixture):假岗位数据渲染报告页组件,用于零配额 UI/截图验证。
// 不进文章、不进生产;正式页面没有任何链接入口,仅直达 URL /dev-report 可访问。
// 公司名为公开知名公司(仅供地图定位用),岗位数据全部虚构。

import JobMap from "../JobMap";
import { ResumeDiagnose } from "../page";
import type { JobRecord } from "../lib/types";

const FAKE_JOBS: JobRecord[] = [
  {
    title: "后端开发工程师(Java)",
    company: "阿里巴巴(中国)有限公司",
    city: "杭州",
    salary: "30-50k",
    skills: ["Java", "Spring Boot", "MySQL", "Redis", "微服务"],
    sourceUrl: "https://example.com/job/1",
    sourceName: "夹具数据",
    publishedAt: "2026-09-01",
    credibility: "high",
  },
  {
    title: "Golang 后端工程师",
    company: "字节跳动有限公司",
    city: "北京",
    salary: "35-60k",
    skills: ["Go", "Kafka", "Redis", "Kubernetes", "微服务"],
    sourceUrl: "https://example.com/job/2",
    sourceName: "夹具数据",
    publishedAt: "2026-09-01",
    credibility: "high",
  },
  {
    title: "Python 后端开发工程师",
    company: "腾讯科技有限公司",
    city: "深圳",
    salary: "30-55k",
    skills: ["Python", "FastAPI", "MySQL", "Redis"],
    sourceUrl: "https://example.com/job/3",
    sourceName: "夹具数据",
    publishedAt: "2026-09-02",
    credibility: "high",
  },
  {
    title: "Java 高级开发工程师",
    company: "美团科技有限公司",
    city: "北京",
    salary: "25-45k",
    skills: ["Java", "MySQL", "Redis", "Kafka"],
    sourceUrl: "https://example.com/job/4",
    sourceName: "夹具数据",
    publishedAt: "2026-09-02",
    credibility: "medium",
  },
  {
    title: "大模型应用开发工程师",
    company: "网易(杭州)网络有限公司",
    city: "杭州",
    salary: "28-50k",
    skills: ["Python", "LangChain", "RAG", "FastAPI"],
    sourceUrl: "https://example.com/job/5",
    sourceName: "夹具数据",
    publishedAt: "2026-09-03",
    credibility: "high",
  },
  {
    title: "云原生开发工程师",
    company: "华为技术有限公司",
    city: "深圳",
    salary: "30-55k",
    skills: ["Go", "Kubernetes", "Docker", "gRPC"],
    sourceUrl: "https://example.com/job/6",
    sourceName: "夹具数据",
    publishedAt: "2026-09-03",
    credibility: "high",
  },
  {
    title: "后端研发工程师",
    company: "百度在线网络技术有限公司",
    city: "北京",
    salary: "25-50k",
    skills: ["C++", "Python", "MySQL", "分布式"],
    sourceUrl: "https://example.com/job/7",
    sourceName: "夹具数据",
    publishedAt: "2026-09-04",
    credibility: "medium",
  },
  {
    title: "Java 开发工程师",
    company: "携程计算机技术有限公司",
    city: "上海",
    salary: "22-40k",
    skills: ["Java", "Spring Cloud", "MySQL", "Redis"],
    sourceUrl: "https://example.com/job/8",
    sourceName: "夹具数据",
    publishedAt: "2026-09-04",
    credibility: "medium",
  },
  {
    title: "测试开发工程师",
    company: "京东科技有限公司",
    city: "北京",
    salary: "20-35k",
    skills: ["Python", "pytest", "Selenium", "Java"],
    sourceUrl: "https://example.com/job/9",
    sourceName: "夹具数据",
    publishedAt: "2026-09-05",
    credibility: "medium",
  },
  {
    title: "前端工程师(React)",
    company: "蚂蚁科技集团股份有限公司",
    city: "杭州",
    salary: "25-45k",
    skills: ["React", "TypeScript", "Node.js", "小程序"],
    sourceUrl: "https://example.com/job/10",
    sourceName: "夹具数据",
    publishedAt: "2026-09-05",
    credibility: "medium",
  },
];

export default function DevReportPage() {
  return (
    <div
      className="min-h-screen p-6"
      style={{ background: "#05080f", color: "#e8f2ff", fontFamily: "sans-serif" }}
    >
      <div className="mx-auto max-w-4xl space-y-6">
        <header>
          <h1 className="text-lg font-bold text-cyan-300">开发夹具:报告页组件预览</h1>
          <p className="mt-1 text-xs text-slate-500">
            假数据(10 岗位 / 5 城),仅用于零配额 UI 与截图验证;不进文章、不进生产
          </p>
        </header>

        <section className="panel p-5">
          <h2 className="mb-3 text-sm font-semibold text-cyan-300">岗位分布地图(双视图)</h2>
          <JobMap jobs={FAKE_JOBS} />
        </section>

        <ResumeDiagnose jobs={FAKE_JOBS} />
      </div>
    </div>
  );
}
