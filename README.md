# JobRadar 岗位雷达

由 **doubao-seed-evolving(Seed-Evolving 第三次更新 250827 版)** 驱动的招聘调研 Demo。

用户在网页勾选岗位类别( AI/算法 · 后端 · 前端 · 全栈 · 测试 )和城市(一线+发达+中发达共 36 城,默认不勾选,**勾哪些查哪些**),后端 agent 循环通过 function calling 自主决定:**搜什么词、抓哪个页面、何时交叉核实、何时收尾**。运行页是一张**雷达扫描地图**:每次搜索镜头飞向目标城市并泛起波纹,已登记岗位的城市实时打点计数;SSE 时间线在侧边同步滚动。最终输出岗位报告:每条岗位附来源链接和可信度徽章,读者可逐条点开验证是否有幻觉,另有**岗位城市分布地图**(高德 JS API,按城市聚合打点)。

## 架构

```
浏览器(勾选 + SSE 时间线 + 报告)
   │  POST /api/radar (SSE)
   ▼
Next.js 路由 → runRadarAgent(agent 循环,最多 30 轮)
   │  每次调用 doubao-seed-evolving(滚动别名,当前对应 Seed-2.1-pro-0915)
   ├── search_jobs → 豆包搜索 API(open.feedcoopapi.com/web_search)
   ├── fetch_page  → 网页抓取(UTF-8/GBK 自适应)
   ├── record_job  → 结构化登记岗位(SSE 推送 + 服务端收集)
   └── finish      → 模型自主收尾,输出小结
```

- 模型端点:`https://ark.cn-beijing.volces.com/api/plan/v3`(Agent Plan 专属 Key)
- 搜索:豆包搜索独立 API,同一把 Key 直调,每月 500 次免费额度
- 岗位数据全部来自工具返回的真实结果,模型只做检索/归纳/评级,不生成岗位内容

## 快速开始

```bash
npm install
cp .env.example .env.local   # 填入 ARK_API_KEY + NEXT_PUBLIC_AMAP_KEY(高德 Key)
npm run dev                  # http://localhost:3000
```

- 全量调研(5 类别 × 20 城市)实测约 12-15 分钟(模型深度思考每轮 20-40 秒,搜索 ≤18 次、抓取 ≤12 页、岗位 18-30 个);小范围调研(1 类别 × 3 城市)约 3-5 分钟
- Key 只放 `.env.local`(已 gitignore),绝不进源码/文章/git

## 代码结构

```
app/
  page.tsx              前端:勾选 → 雷达地图 + SSE 时间线 → 报告(技能词频 + 可信度徽章)
  RadarMap.tsx          运行页雷达扫描地图(搜索飞向城市 + 波纹动画 + 岗位计数打点)
  JobMap.tsx            报告页岗位分布地图(高德 JS API 2.0,城市坐标内置 config,零地理编码调用)
  api/radar/route.ts    SSE 端点(15 分钟超时,断连自动中止)
  lib/
    agent.ts            agent 循环 + 工具定义 + 数据清洗 + 技能统计
    ark.ts              模型调用(chat/completions + function calling)
    search.ts           豆包搜索 API 封装
    fetch-page.ts       网页抓取(编码自适应 + 正文提取)
    config.ts           类别/城市/预算常量
    types.ts            共享类型
scripts/
  smoke-test.mjs        连通性冒烟测试(模型对话 + 豆包搜索各一次)
  parse-log.js          解析 SSE 运行日志,输出报告摘要
  ui-test.mjs           前端 UI 端到端测试(CDP 驱动 headless Edge,零依赖):
                        打开页面 → 勾选 → 开始 → 验证时间线/报告页/地图 → 整页截图
```

## 实测数据(2026-09-07 全量跑通)

- 输入:5 类别 × 20 城市,输出:18 次搜索 + 11 次抓取 → 25 个真实岗位(high 8 / medium 17),覆盖 16 城,模型自主 finish
- 来源抽查:猎聘/上海AI实验室官网/深圳新闻网/广州人才集团均 200 可验证(海康威视官网 curl 403 为反爬,带 UA 抓取正文成功)
- 可靠性设计:模型行为有双层兜底——① 提示词【执行节奏】要求每轮“搜→核→记”闭环,严禁攒着最后统一登记;② 服务端 abort(超时/断连)时已有岗位照常兑底出报告,不丢数据

## 部署(腾讯云国内服务器)

本地跑通后:

```bash
npm run build && npm run start   # 生产模式,自行配 IP:端口 / 反向代理
```

`.env.local` 在服务器上放环境变量(`ARK_API_KEY`),服务端调用,读者无需自带 Key。
