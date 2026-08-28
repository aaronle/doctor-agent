# Doctor Agent（医生智能体）

Doctor Agent 是 AI-HIS 门诊场景的医生智能体产品项目。当前处于一期产品定义与技术准备阶段，采用三条工作线并行推进：

1. 产品功能开发条线
2. Agent 集成条线
3. Agent 岗位定义和调优条线

## 一期范围

一期按“7 个产品功能、6 个智能体”组织：

- 7 个产品功能：语音问诊、病情概况、病历生成、鉴别诊断、诊断管理、风险管理、共病管理。
- 6 个智能体：语音问诊智能体、病情概况智能体、病历生成智能体、诊断智能体、风险管理智能体、共病管理智能体。
- 首期应用与评测范围：内科、骨科、妇科；具体亚专科与病种边界仍需进一步确认。

Worker、智能体岗位与 Sub-agent 的最终拆分方案尚未定稿，现阶段均作为“待讨论”事项管理。

## 当前文档

- [一期研发总纲](docs/00-一期研发总纲.md)
- [产品功能详细规格](docs/product/01-产品功能详细规格.md)
- [UI/UX 详细规格与页面 Mockup](docs/product/02-UIUX详细规格与页面Mockup.md)
- [Agent 集成与 Mockup 详细规格](docs/agent-integration/01-Agent集成与Mockup详细规格.md)
- [Agent 岗位与调优 Mockup 详细规格](docs/agent-roles-and-evaluation/01-Agent岗位与调优Mockup详细规格.md)
- [快速开发准备与迭代计划](docs/implementation/01-快速开发准备与迭代计划.md)
- [一期产品设计与工作界面方案](docs/product/AI-HIS医生智能体一期产品设计与工作界面方案.docx)
- [文档目录说明](docs/README.md)
- [项目交接入口](HANDOVER.md)

## 当前状态

- 已完成一期产品理念、范围、界面、集成边界和调优框架的首版整理，并形成三条线的详细 Markdown 规格。
- 当前执行口径为：产品功能开发条线快速实现；Agent 集成和 Agent 岗位/调优条线先使用正式契约上的 Mock。
- 尚未确定技术栈、AgentScope 接口协议、数据接入清单、评测数据集版本及发布环境。
- 尚未配置远程 Git 仓库和部署环境。

进入项目后，请先阅读 [`HANDOVER.md`](HANDOVER.md)，再开展需求、设计、开发、测试或部署工作。
