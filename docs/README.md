# Doctor Agent 文档目录

本目录按三条工作线组织长期文档：

| 目录 | 工作线 | 主要内容 |
| --- | --- | --- |
| `product/` | 产品功能开发条线 | 功能范围、用户流程、UI/UX、产品验收 |
| `agent-integration/` | Agent 集成条线 | AgentScope、Skills、MCP、数据、接口、卡片和展现形式 |
| `agent-roles-and-evaluation/` | Agent 岗位定义和调优条线 | 岗位职责、调用规则、输出规范、评测数据集、指标和调优记录 |

跨条线文档必须明确主责目录，并用链接引用，避免维护多份相互冲突的副本。

## 一期详细规格入口

- [`00-一期研发总纲.md`](00-一期研发总纲.md)
- [`product/01-产品功能详细规格.md`](product/01-产品功能详细规格.md)
- [`product/02-UIUX详细规格与页面Mockup.md`](product/02-UIUX详细规格与页面Mockup.md)
- [`product/03-Demo审视与北大医疗UIUX优化方案.md`](product/03-Demo审视与北大医疗UIUX优化方案.md)（当前为沿用最早 HTML 的决策记录）
- [`product/04-UIUX原型与需求追踪说明.md`](product/04-UIUX原型与需求追踪说明.md)
- [`product/05-第一期Figma勾画稿清单.md`](product/05-第一期Figma勾画稿清单.md)
- [`product/06-F01-F03语音问诊与病历生成UI需求规格.md`](product/06-F01-F03语音问诊与病历生成UI需求规格.md)（当前高保真状态、交互、字段、Agent 契约与验收基线）
- [`product/07-专项评估技能组UIUX需求规格.md`](product/07-专项评估技能组UIUX需求规格.md)（五类“小秘书”方向、33 项专项能力、集成边界与测试要求）
- [`testing/01-一期UIUX与功能测试用例.md`](testing/01-一期UIUX与功能测试用例.md)
- [`testing/02-一期七功能Mock产品测试报告.md`](testing/02-一期七功能Mock产品测试报告.md)
- [`agent-integration/01-Agent集成与Mockup详细规格.md`](agent-integration/01-Agent集成与Mockup详细规格.md)
- [`agent-integration/02-Agent配置与运行控制台需求规格.md`](agent-integration/02-Agent配置与运行控制台需求规格.md)（六个 Agent 的 Prompt、Haiku、数据接口、Skills/MCP、评测、发布与回滚后台）
- [`agent-roles-and-evaluation/01-Agent岗位与调优Mockup详细规格.md`](agent-roles-and-evaluation/01-Agent岗位与调优Mockup详细规格.md)
- [`implementation/01-快速开发准备与迭代计划.md`](implementation/01-快速开发准备与迭代计划.md)
- [`implementation/02-本地开发与架构说明.md`](implementation/02-本地开发与架构说明.md)

## 参考材料

- [`product/AI-HIS医生智能体一期产品设计与工作界面方案.docx`](product/AI-HIS医生智能体一期产品设计与工作界面方案.docx)
- [`../references/ui-demo/AI-HIS门诊模块V4.3.html`](../references/ui-demo/AI-HIS门诊模块V4.3.html)（不可修改的最早 HTML 原件）
- [`../references/ui-demo/README.md`](../references/ui-demo/README.md)（来源、校验值和不可覆盖规则）
- [`../design/current/AI-HIS医生智能体一期.html`](../design/current/AI-HIS医生智能体一期.html)（当前直接实现基线）
- [`product/10-V4.3反向需求规格说明书.md`](product/10-V4.3反向需求规格说明书.md)：从 V4.3 逐屏倒推的完整需求书，正向流程的起点
