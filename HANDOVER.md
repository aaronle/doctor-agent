# Doctor Agent 项目交接手册

更新时间：2026-08-29（Asia/Shanghai）
项目目录：`/Users/leying/Documents/北大医疗/AI Native Systems/projects/doctor-agent`  
项目状态：一期七功能、六个版本化 Mock Agent 和广州单容器部署定义已完成；尚未发布到 `da.aaronhealth.cn`

本文件是 Doctor Agent 项目的当前接手入口。正式需求、接口、评测标准和发布规则应保存在本仓库，并随项目决策及时更新。

## 1. 接手顺序

1. 阅读本文件。
2. 阅读 `docs/00-一期研发总纲.md`。
3. 阅读 `docs/product/AI-HIS医生智能体一期产品设计与工作界面方案.docx`。
4. 根据任务所属条线阅读对应详细 Markdown。
5. 检查当前 Git 状态和最近提交。
6. 不跨线隐式改变职责边界。

```sh
cd "/Users/leying/Documents/北大医疗/AI Native Systems/projects/doctor-agent"
git status -sb
git log -3 --oneline
```

## 2. 三条工作线

1. **产品功能开发条线**：负责医生端 7 个核心功能、用户流程、UI/UX、状态反馈和业务验收。
2. **Agent 集成条线**：负责产品调用阶段、AgentScope 执行阶段、结果返回阶段，以及 Skills、MCP、数据上下文、卡片交互和展现形式的接口边界。
3. **Agent 岗位定义和调优条线**：负责 6 个智能体的岗位职责、调用条件、输出规则、准确性、上下文管理、评测数据集和持续调优。

## 3. 一期范围

### 产品功能

1. 语音问诊
2. 病情概况
3. 病历生成
4. 鉴别诊断
5. 诊断管理
6. 风险管理
7. 共病管理

### 智能体

1. 语音问诊智能体
2. 病情概况智能体
3. 病历生成智能体
4. 诊断智能体，同时承载鉴别诊断和诊断管理
5. 风险管理智能体
6. 共病管理智能体

### 专科范围

首期拟覆盖内科、骨科、妇科，既作为应用范围，也作为评测范围。亚专科、专病包和准入门槛仍需通过会议与临床专家确认。

## 4. 当前明确的边界

- 当前执行策略：产品功能开发条线尽快实现真实产品；Agent 集成和 Agent 岗位/调优两条线先以正式契约上的 Mock 支撑开发。
- 产品研发与 Agent 调优并行，不等待产品全部完成后再开始调优。
- Agent 托管于北大国际医院搭建的阿里 AgentScope 框架；本项目负责定义向上对产品、向下对 AgentScope 的集成契约。
- 卡片、产品交互和结果展现属于 Agent 集成条线。
- Worker、智能体岗位与 Sub-agent 的关系和拆分方式均为建议稿，统一标记为“待讨论”，不能视为已决策架构。
- 高风险临床输出必须保留证据来源、不确定性和人工确认机制。

## 5. 目录约定

```text
doctor-agent/
├── AGENTS.md
├── HANDOVER.md
├── README.md
├── apps/
│   ├── web/                    # Vue 3 医生工作站
│   └── api/                    # FastAPI 产品 API 与 Agent Gateway
├── packages/contracts/        # OpenAPI 与 JSON Schema
├── scripts/                   # 契约生成等项目脚本
└── docs/
    ├── 00-一期研发总纲.md
    ├── README.md
    ├── product/
    ├── agent-integration/
    ├── agent-roles-and-evaluation/
    └── implementation/
```

- `docs/product/`：产品范围、用户流程、UI/UX、功能验收。
- `docs/agent-integration/`：AgentScope、Skills、MCP、数据上下文、接口协议、卡片和展现协议。
- `docs/agent-roles-and-evaluation/`：岗位定义、调用规则、输出规范、评测集、指标和调优记录。
- `docs/implementation/`：快速开发、纵向薄切、环境、测试和迭代计划。
- `references/ui-demo/AI-HIS门诊模块V4.3.html`：不可修改的最早 HTML 原件。
- `design/current/AI-HIS医生智能体一期.html`：视觉与主体交互参考基线。当前代码的入口流程已按最新确认调整为：本地演示无需登录，默认进入 `/outpatient/list`；点击患者后进入 `/outpatient` 并自动展开医生智能体。正式环境仍须接入医院 SSO。

当前源码、自动化测试和契约已按实际技术栈建立；运行和测试方式见 `docs/implementation/02-本地开发与架构说明.md`。

一期七功能均已具备可操作的产品级演示数据和交互效果：语音录制/转写校正、病情概况、段落级病历草稿、鉴别诊断决策、诊断管理与演示写回、风险处置闭环、共病分组与随访草稿。医生界面默认生成正常结果，不显示运行场景选择器或“Mock 效果”标签；需要澄清、数据冲突、降级、运行失败和 Schema 拒绝仍通过测试接口注入验证。F06 已按红色“必须处置并阻断”、黄色“处理或留痕”实现分级；智慧诊疗必须排除项提供“风险预警/查看详细”入口，风险详情逐项折叠并展示证据、来源、阈值与不确定性。中间区域增加五类助手、33 项专项能力的技能目录，五个分组默认折叠，具体 Worker/Sub-Agent 拆分待讨论，不改变一期七功能、六 Agent 范围。当前基线已通过 21 条前端测试、21 条 API 测试、类型检查、生产构建和九个页面入口的本机浏览器验收；详见 `docs/testing/02-一期七功能Mock产品测试报告.md`。

2026-08-29 参考 Ticket System 广州生产 1.33.1 的服务端 Agent、审计、健康指纹、回环端口、Docker 健康检查和日志滚动方式，将七类任务收敛为六个 `mvp-0.2.0` Mock Agent。广州部署定义位于 `deploy/tencent-guangzhou/`，采用 Vue 静态产物 + FastAPI + SQLite 的单容器架构，计划只绑定 `127.0.0.1:3400`。本地最新验证通过 21 条前端测试、21 条 API 测试、类型检查、生产构建和 FastAPI 同源静态服务；本机未安装 Docker CLI，镜像构建须在广州候选环境验证。

## 6. 当前待决策事项

1. 医院是否要求替换当前 Vue 3/FastAPI/PostgreSQL 兼容技术栈；无新要求时按当前实现继续。
2. AgentScope 的调用协议、鉴权、超时、重试、流式输出和审计机制。
3. Skills、MCP 与临床数据源清单及最小权限。
4. Worker、智能体岗位与 Sub-agent 的定义和运行边界（待讨论）。
5. 内科、骨科、妇科的亚专科和首批病种。
6. 金标准病例、评测集结构、准确性指标和零容忍安全门禁。
7. 负责人、项目节奏、环境和发布路径。

## 7. Git 与安全

- 本目录是独立 Git 仓库，默认分支为 `main`。
- 当前未配置远程仓库；不得自行创建或推送 GitHub 仓库。
- 密钥、真实患者数据、生产导出、访问令牌和运行时环境文件不得提交 Git。
- 引入临床数据前必须明确脱敏、授权、审计、留存和删除规则。

## 8. 项目级 Skill

- `.agents/skills/grill-me/`：来源为 `mattpocock/skills` 的 `skills/productivity/grill-me`，是仅显式调用的 `$grill-me` 入口。
- `.agents/skills/grilling/`：同源的主实现，由 `$grill-me` 转交调用，按设计树的当前前沿分轮追问。
- 本次安装对应的上游修订为 `6654f6b60cd9d5be8b54c6fafe44346dabeb3b76`。
- Codex 兼容处理：入口移除 Codex 不支持的 `disable-model-invocation` 字段，并将其 `Skill tool` 转交改为对本地 `grilling/SKILL.md` 的引用；主实现保持上游原文。
