// JobRadar 跨层共享类型:lib 产出、SSE 传输、UI 渲染、脚本复用都依赖这里的字段名

// 豆包搜索归一化后的单条结果
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  siteName: string;
  publishTime?: string;
  // 上游接口字段 AuthInfoLevel 的归一化结果(权威性等级)
  authLevel?: number;
}

// 一条登记进报告的岗位:全部字段必须可溯源到搜索/抓取返回
export interface JobRecord {
  title: string;
  company: string;
  city: string;
  salary: string;
  skills: string[];
  // 具体工作地点(区/园区/路名),JD 未写明则无
  location?: string;
  // 硬性要求(学历/经验年限/证书等),JD 未写明则无
  requirements?: string[];
  sourceUrl: string;
  sourceName: string;
  publishedAt: string;
  credibility: "high" | "medium" | "low";
  credibilityNote?: string;
}

// 技能词频榜的一项
export interface SkillCount {
  skill: string;
  count: number;
}

// 调研最终报告
export interface RadarReport {
  jobs: JobRecord[];
  skillRanking: SkillCount[];
  searchCount: number;
  fetchCount: number;
  cityCoverage: string[];
  summary: string;
}

// SSE 事件:agent 每走一步就推一个给前端时间线/地图
export type AgentEvent =
  | { type: "plan"; text: string }
  | {
      type: "search";
      query: string;
      timeRange?: string;
      count: number;
      results: SearchResult[];
    }
  | {
      type: "fetch";
      url: string;
      ok: boolean;
      title?: string;
      length?: number;
      error?: string;
    }
  | { type: "job"; job: JobRecord }
  | { type: "done"; report: RadarReport }
  | { type: "error"; message: string };
