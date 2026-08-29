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

一期 UI/UX 已确认沿用最早的 `references/ui-demo/AI-HIS门诊模块V4.3.html`，不重新设计布局、视觉和主体交互。当前本地演示入口不显示登录页，打开系统直接进入 `/outpatient/list` 候诊列表；点击患者卡后进入 `/outpatient`，自动展开医生智能体和该患者的智慧诊疗结果。正式环境仍保留医院 SSO 接入边界。

Worker、智能体岗位与 Sub-agent 的最终拆分方案尚未定稿，现阶段均作为“待讨论”事项管理。

## 当前文档

- [一期研发总纲](docs/00-一期研发总纲.md)
- [产品功能详细规格](docs/product/01-产品功能详细规格.md)
- [UI/UX 详细规格与页面 Mockup](docs/product/02-UIUX详细规格与页面Mockup.md)
- [UI/UX 原型与需求追踪说明](docs/product/04-UIUX原型与需求追踪说明.md)
- [一期 UI/UX 与功能测试用例](docs/testing/01-一期UIUX与功能测试用例.md)
- [一期七功能 Mock 产品测试报告](docs/testing/02-一期七功能Mock产品测试报告.md)
- [Agent 集成与 Mockup 详细规格](docs/agent-integration/01-Agent集成与Mockup详细规格.md)
- [Agent 岗位与调优 Mockup 详细规格](docs/agent-roles-and-evaluation/01-Agent岗位与调优Mockup详细规格.md)
- [快速开发准备与迭代计划](docs/implementation/01-快速开发准备与迭代计划.md)
- [一期产品设计与工作界面方案](docs/product/AI-HIS医生智能体一期产品设计与工作界面方案.docx)
- [文档目录说明](docs/README.md)
- [项目交接入口](HANDOVER.md)

## 当前状态

- 已完成一期产品理念、范围、界面、集成边界和调优框架的首版整理，并形成三条线的详细 Markdown 规格。
- 已确认一期 UI/UX 沿用最早 HTML；当前直接实现基线为 `design/current/AI-HIS医生智能体一期.html`，不采用后续重设计方案。
- 已生成医生智能体、七功能关键状态及“红黄风险 + 五类专项评估”Figma 高保真画面，并建立需求—界面—测试追踪说明和三专科 Mock Fixture。
- 已建立 Vue 3 + TypeScript + Vite 前端、FastAPI 产品 API/Agent Gateway、SQLite/PostgreSQL 兼容数据层、OpenAPI/JSON Schema 契约和自动化测试。
- 已实现候诊列表直达、点击患者进入医生智能体，以及一期七功能的可操作演示产品闭环；Agent 集成和岗位/调优能力当前使用正式契约上的 Mock。
- 已通过前端类型检查、19 条前端自动化测试、21 条 API 自动化测试、生产构建和契约导出，并在本机浏览器逐功能验证关键路径及异常效果。
- 当前完成的是“七功能 Mock 产品版”，不是正式临床生产版；所有写回、随访和处置均明确为模拟或审计记录，不会连接真实 HIS。
- 七类任务已收敛为六个版本化 `mvp-0.2.0` Mock Agent，任务结果和审计事件会记录 Agent ID、名称和版本。
- 已增加面向 `da.aaronhealth.cn` 的广州单容器部署定义，详见 [`deploy/tencent-guangzhou/README.md`](deploy/tencent-guangzhou/README.md)；当前尚未发布。
- AgentScope 接口协议、真实数据接入、评测集正式版本、医院 SSO 和发布环境仍待确认。
- 尚未配置远程 Git 仓库；广州部署定义已准备，DNS、HTTPS 和服务器候选发布尚未执行。

本地开发与架构说明见 [`docs/implementation/02-本地开发与架构说明.md`](docs/implementation/02-本地开发与架构说明.md)。

## 项目级 Skill

- `$grill-me`：来自 `mattpocock/skills` 的显式入口，用多轮追问打磨计划、设计或产品决策。
- 该入口调用同仓库的 `grilling` 主 Skill，因此两者均作为当前项目的 Codex Skill 安装。

进入项目后，请先阅读 [`HANDOVER.md`](HANDOVER.md)，再开展需求、设计、开发、测试或部署工作。
