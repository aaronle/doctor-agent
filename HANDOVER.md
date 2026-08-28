# Doctor Agent 项目交接手册

更新时间：2026-08-28（Asia/Shanghai）  
项目目录：`/Users/leying/Documents/北大医疗/AI Native Systems/projects/doctor-agent`  
项目状态：一期产品定义与技术准备

本文件是 Doctor Agent 项目的当前接手入口。正式需求、接口、评测标准和发布规则应保存在本仓库，并随项目决策及时更新。

## 1. 接手顺序

1. 阅读本文件。
2. 阅读 `docs/product/AI-HIS医生智能体一期产品设计与工作界面方案.docx`。
3. 检查当前 Git 状态和最近提交。
4. 根据任务所属条线进入对应文档目录，不跨线隐式改变职责边界。

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
└── docs/
    ├── README.md
    ├── product/
    ├── agent-integration/
    └── agent-roles-and-evaluation/
```

- `docs/product/`：产品范围、用户流程、UI/UX、功能验收。
- `docs/agent-integration/`：AgentScope、Skills、MCP、数据上下文、接口协议、卡片和展现协议。
- `docs/agent-roles-and-evaluation/`：岗位定义、调用规则、输出规范、评测集、指标和调优记录。

后续增加源码、自动化测试和部署文件时，再按实际技术栈创建 `src/`、`tests/`、`deploy/` 等目录，不预设空架构。

## 6. 当前待决策事项

1. 产品技术栈以及与现有 AI-HIS Demo 的继承方式。
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

