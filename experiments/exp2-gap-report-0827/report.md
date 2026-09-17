信息已收集充分。以下是基于你的简历和当前真实招聘信息整理的差距报告。

---

# 「我与市场的差距」报告：Go 后端 → AI/大模型方向

> 简历对象：陈默（化名），3.5 年 Go 后端工程师（电商订单/秒杀，8 万 QPS）
> 数据来源：猎聘、BOSS 直聘、上海人工智能实验室官网、中光电信等 2026 年 8–9 月在招 JD

---

## 一、市场要求概览（来自真实 JD）

当前市场上与"转 AI"相关的岗位主要分两条路径，门槛差异很大：

### 路径 A：大模型应用开发 / AI 应用工程师（✅ 与你最匹配，后端可平移）

| 岗位（城市/薪资） | 核心要求 | 来源 |
|---|---|---|
| Agent 开发（上海，25–40k·15薪） | Agent 工作流、工具调用、记忆模块、多轮规划；Prompt 工程、Function Call | [猎聘](https://m.liepin.com/a/79434499.shtml) |
| 大模型应用工程师 PythonAI（深圳，16–28k·18薪，3–5年本科） | 基于 LLM 的业务工作流编排；**深入使用 LangChain / LangGraph** 构建状态机 | [猎聘](https://m.liepin.com/a/78327117.shtml) |
| AI 应用开发工程师 J17122（北京，18–22k，3年以上本科） | AI 产品前后端研发、接口/数据库/部署；构建 **Agent、智能助手、知识库（RAG）** | [猎聘](https://m.liepin.com/job/1984537431.shtml) |
| 大模型应用开发（西安，10–20k，本科） | Agent 目标拆解、任务规划、工具调用、记忆机制、多轮决策 | [猎聘](https://m.liepin.com/job/1980158291.shtml) |
| 大模型应用研发（AI Agent/角色对话，北京，40–60k·15薪） | 上下文管理、**RAG**、工具调用、流式响应 | [猎聘](https://m.liepin.com/a/77452219.shtml) |
| LLM Application Engineer（北京/上海，30–60k·16薪） | 构建 LLM 智能层（英文 JD） | [猎聘](https://m.liepin.com/a/77786033.shtml) |
| Agent 开发工程师（中光电信） | 基于 GPT/通义/文心/Llama/Qwen/DeepSeek 独立开发 Agent；**ReAct、AutoGPT、Plan-and-Execute**、反思闭环 | [中光电信](https://www.10isp.com/news/content/251.html) |

从这些 JD 和岗位能力分析中提炼出的**应用岗通用技能栈**：

1. **Python 工程能力**：FastAPI、asyncio 异步、pydantic——"很多 AI 项目基于 Python FastAPI"（[转型路线分析](https://blog.csdn.net/m0_37865510/article/details/163432320)）；深圳岗直接标"PythonAI"。
2. **模型 API 接入与封装**：对接 OpenAI、通义、智谱、DeepSeek 等，封装统一调用层，支持流式输出、重试、限流、降级（[能力模型](https://blog.csdn.net/shuige515/article/details/159695472)）。
3. **RAG（检索增强生成）**：Embedding 模型 + 向量数据库（Milvus 等）+ 文档切分/检索，是知识库类应用的标配（[腾讯云 RAG 实践](https://cloud.tencent.com/developer/article/2726739)、[阿里云 Milvus+LangChain](https://help.aliyun.com/zh/milvus/use-cases/use-milvus-and-langchain-to-build-the-llm-question-answering-system)）。
4. **Agent 开发**：LangChain / LangGraph、Function Calling、Memory、Planning（ReAct / Plan-and-Execute）、多 Agent 协作（[面试 JD 整理](https://blog.csdn.net/weixin_44463519/article/details/163139702)）。
5. **Prompt 工程**：几乎每份 JD 的必备项。
6. **工程化/部署**：推理服务封装、容器化部署、稳定性与扩缩容（[技能图谱](https://blog.csdn.net/qq_44866828/article/details/159516001)）；vLLM 等推理框架开始出现（[vLLM 实践](https://blog.csdn.net/weixin_44262492/article/details/162603327)）。
7. 语言要求上，百度等 JD 明确"**C++/Go/Python 至少一种精通**"（[50+ JD 分析](https://blog.csdn.net/2301_80630163/article/details/161491117)）——你的 Go 背景是被认可的。

### 路径 B：大模型算法工程师（❌ 现阶段不建议直接冲）

- 上海人工智能实验室：负责 CPT（增量预训练）、**SFT、RLHF/DPO**、语料清洗配比，基于 GPU/昇腾使用 **Megatron-LM** 训练（[官网 JD](https://www.shlab.org.cn/joinus/detail/7615234376275773734?mode=social)）。
- 具身智能算法岗：VLA 端到端大模型、LLM/VLM 微调、分布式训练，22–40k，**要求硕士**（[猎聘](https://m.liepin.com/a/78877039.shtml)）。
- 经纬恒润应用岗也要求"掌握 PyTorch、深度学习算法原理"，且学历要求硕士（[校招 JD](https://career.hebut.edu.cn/home/correcruit/content/id/79573.html)）。

**结论**：算法岗普遍要求硕士、PyTorch、深度学习/数学功底、训练框架经验——与你简历现状差距过大；应用岗本科即可、3–5 年经验档与你吻合，且高度看重后端工程能力，是正确的切入口。

---

## 二、我的现状（严格依据简历）

**可直接迁移的优势：**
- 3.5 年后端，Go 精通；做过 8 万 QPS 秒杀、全链路压测、慢 SQL 治理、库存最终一致性
- 分布式：Kafka、gRPC、分布式事务/最终一致性方案
- 基础设施：Kubernetes、Docker、Linux、MySQL、Redis
- 有自研工具经历（Go 压测工具替代 locust），说明有独立做项目的能力

**明确的短板（简历原文）：**
- Python 仅"会写脚本，用 pandas 处理过日志"——远未达到工程化服务开发水平
- "没做过深度学习，没用过 PyTorch"
- "数学基础一般"
- 简历中**零** LLM / RAG / Agent / Prompt / 向量数据库 / 模型 API 相关内容
- 无 AI 相关项目可展示

---

## 三、差距清单（按优先级）

| 优先级 | 差距项 | 市场要求 | 你的现状 | 缺口程度 |
|---|---|---|---|---|
| 🔴 P0 | **Python 工程化** | FastAPI、asyncio、pydantic，能写 AI 后端服务 | 仅脚本 + pandas | 大，但有编程基础，补起来快 |
| 🔴 P0 | **LLM API 应用开发** | 对接 OpenAI/DeepSeek/通义等，流式输出、Function Call、重试限流降级 | 无 | 大，属全新知识 |
| 🔴 P0 | **RAG 全链路** | 文档切分、Embedding、向量库（Milvus/Chroma）、检索+生成、效果评估 | 无 | 大，但是应用岗最高频考点 |
| 🔴 P0 | **Agent 框架** | LangChain / LangGraph、ReAct、Memory、工具调用、任务规划 | 无 | 大，JD 出现率最高 |
| 🟡 P1 | **Prompt 工程** | 提示词设计、结构化输出、推理链优化 | 无 | 中，入门快、精通难 |
| 🟡 P1 | **可展示的 AI 项目** | 面试几乎必问"做过什么 AI 项目" | 无 | 大，需动手做 1–2 个 |
| 🟢 P2 | **模型推理部署** | vLLM、模型服务化、GPU 基础 | 有 Docker/K8s，缺模型侧 | 中，你的 K8s 经验是加分项 |
| 🟢 P2 | **微调（LoRA/SFT）** | 部分应用岗写"了解微调优先"，算法岗硬性要求 | 无 | 中，应用岗只需了解层面 |
| ⚪ P3 | **PyTorch / 深度学习 / 数学** | 算法岗硬性；应用岗少数要求 | 无 | 大，但**应用岗可不补或浅补** |

---

## 四、接下来 3–6 个月补强建议

**总策略：走"路径 A 应用开发"，把 Go 后端的工程优势作为差异化卖点，不硬刚算法岗。**

### 第 1 个月：Python 工程 + LLM API 入门
- 把 Python 从"脚本水平"补到"服务水平"：重点学 **asyncio 异步、FastAPI、pydantic**（参考[后端转 AI 路线](https://blog.csdn.net/m0_37865510/article/details/163432320)）。
- 注册 DeepSeek / 通义千问（国内便宜易得）API，用 Python 实现：统一模型调用层、流式输出（SSE）、重试/限流/超时、多模型切换——这正好是 JD 里"封装模型能力"的要求。
- 同步系统学 Prompt 工程：结构化输出（JSON mode）、Few-shot、Function Calling。

### 第 2–2.5 个月：死磕 RAG（最高性价比）
- 跑通完整 RAG 链路：文档加载与切分 → Embedding → 向量数据库（建议 **Milvus**，阿里云有官方教程）→ 检索 + 重排 → 生成回答。
- **结合你的老本行做项目**：做一个"电商订单/售后知识库问答系统"，用你熟悉的业务场景（订单状态、秒杀规则、库存问题），这是面试时"后端经验 + AI"的独特故事。
- 关注 RAG 效果评估（召回率、幻觉率），这是区分"调包侠"和工程师的点。

### 第 3–4 个月：Agent 开发
- 学 **LangChain 和 LangGraph**（深圳 16–28k 岗明确要求），理解 ReAct、Plan-and-Execute、Memory、Tool Calling。
- 做第二个项目：一个能调用工具的 Agent，例如"运维/压测助手"——让 Agent 调用你用 Go 写的压测工具或查询 Redis/MySQL 的接口，把你的分布式背景变成 Agent 的"工具生态"。

### 第 5 个月：工程化部署（你的主场）
- 用 **Docker + K8s** 部署 RAG/Agent 服务（你已会，直接复用）。
- 了解 vLLM 推理部署、模型服务的并发与显存基础概念即可，不必深入训练。
- 了解 LoRA 微调的概念和流程（能说清 SFT/LoRA 是什么、什么场景用），不需要手搓训练。

### 第 6 个月：包装与求职
- 简历改写：技能栏加 Python/FastAPI/LangChain/RAG/向量库/Agent；项目栏放上述 2 个项目，**突出"高并发后端 + AI 应用"的复合能力**——多数纯 AI 候选人缺的正是工程化能力。
- 目标岗位：搜"大模型应用开发工程师""AI 应用工程师""Agent 开发工程师"，本科、3–5 年档（如深圳 16–28k、北京 18–22k 这类），避开明确要求硕士/PyTorch/训练的算法岗。
- PyTorch 和数学：**暂不系统补**，等入职应用岗后、若想往算法/模型侧深入再补，现在投入产出比低。

---

### 一句话总结
你的**地基（高并发、分布式、K8s）比大多数转行者好**，差距集中在"Python 工程化 + LLM/RAG/Agent 应用层"这一层——这层恰好不要求数学和深度学习，3–6 个月的项目实战完全可以补上；关键是尽快做出 1–2 个能演示的 AI 项目，而不是停留在看教程。