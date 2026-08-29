# Doctor Agent 配置与运行控制台需求规格

版本：`v0.1-draft`  
日期：`2026-08-29`  
状态：一期后台产品与技术基线；AgentScope 正式接口、模型供应商和生产数据源待院方确认

## 1. 产品定位

Doctor Agent 由两类产品界面组成：

1. **医生工作站**：面向临床医生，承载一期七个核心用户功能。
2. **Agent 配置与运行控制台**：面向产品管理员、Agent 调优人员、数据接口人员和医院安全管理员，配置六个 Agent 的岗位、调用条件、Prompt、模型、数据、Skills/MCP、输出契约、评测与发布版本。

控制台属于 Agent 集成与调优基础设施，不是医生端第八个核心功能。专项评估中的 33 项能力可以引用控制台内注册的 Skills、MCP、规则或现有 Agent，但是否拆分为 Worker/Sub-Agent 仍标记为**待讨论**。

## 2. Ticket System 参考结论

Ticket System 已验证的模式可以复用：

- 每个 Agent 独立配置 Prompt、运行模式、阈值、模型、数据范围和工具清单；
- 配置以版本保存，支持草稿、真实模型单条测试、发布、历史版本和回滚；
- 生产运行绑定已发布版本，运行日志保存实际模型、耗时、Token、输入摘要、结构化输出和错误；
- 医院级配置隔离，管理员不能跨医院修改；
- Prompt 负责理解和结构化，平台负责权限、候选校验、执行、幂等与审计；
- 模型输出必须通过平台 Schema 和业务规则校验，模型布尔值不能推翻平台安全门禁。

Doctor Agent 不能原样复制 Ticket System。医疗场景必须补充字段级数据授权、患者/就诊绑定、数据新鲜度、脱敏、临床输出 Schema、红色风险门禁、评测集发布门禁和双重审计。

## 3. 一期管理对象

| Agent | 承载任务 | 默认模型档位 | 一期默认策略 |
| --- | --- | --- | --- |
| 语音问诊智能体 | 问诊转写、结构化采集、漏问提示、补充观察 | `clinical_fast` | 可绑定 Haiku；短上下文、结构化输出 |
| 病情概况智能体 | 综合病情摘要、问题、趋势、缺失与冲突 | `clinical_fast` | 可绑定 Haiku；必须引用数据来源 |
| 病历生成智能体 | 八类病历草稿、完整性和质控 | `clinical_fast` | 可绑定 Haiku；按字段输出并保护医生编辑 |
| 诊断智能体 | 鉴别诊断、诊断管理 | `clinical_reasoning` | 一期可先绑定 Haiku 形成基线；是否升级强模型由评测决定 |
| 风险管理智能体 | 风险分层、证据、处置建议 | `clinical_safety` | 可绑定 Haiku，但硬规则和红色风险门禁由平台执行 |
| 共病管理智能体 | 共病分组、相互影响、照护缺口 | `clinical_reasoning` | 一期可先绑定 Haiku；复杂病例允许后续模型路由 |

模型档位是稳定别名，不把具体模型名称散落在业务代码中。初始可配置：

```text
clinical_fast      -> claude-haiku-4-5-20251001
clinical_reasoning -> claude-haiku-4-5-20251001（一期基线）
clinical_safety    -> claude-haiku-4-5-20251001 + 平台硬规则
```

发布版本和每次运行必须同时记录档位别名与实际解析后的 Provider/Model ID。未来更换 Haiku 版本或接入院内模型时，不修改医生端调用协议。

## 4. 配置层级

```text
医院/机构
  └─ 环境：开发 / 测试 / 候选 / 生产
      └─ Agent 定义
          └─ Agent 配置版本
              ├─ 岗位与调用条件
              ├─ Prompt 组合
              ├─ 模型档位与参数
              ├─ 数据包与接口绑定
              ├─ Skills / MCP / 规则绑定
              ├─ 输出 Schema 与卡片映射
              ├─ 安全门禁与降级
              └─ 评测集与发布门禁
```

同一医院同一环境、同一 Agent 同时只能存在一个生产版本。生产配置不能直接覆盖，只能创建新草稿并发布为新版本。

## 5. 后台信息架构

### 5.1 Agent 总览

每张 Agent 卡至少显示：名称、岗位、承载任务、当前生产版本、模型档位、实际模型、运行状态、最近发布时间、最近评测结论和最近 24 小时成功率。

支持按医院、环境、专科、状态和模型档位筛选。诊断 Agent 显示两个任务入口，但只维护一份 Agent 岗位和版本体系。

### 5.2 Agent 配置工作区

每个 Agent 使用以下页签：

1. **基本信息**：名称、岗位目标、职责、非职责、Owner、适用专科。
2. **调用规则**：在哪个产品阶段、由谁、因何事件调用；自动/手动；前置条件；去重和冷却时间。
3. **Prompt**：系统安全层、岗位层、医院层、专科层和任务层。
4. **模型**：模型档位、Provider、实际 Model ID、温度、最大 Token、超时、重试和备用模型。
5. **数据接口**：上下文数据包、数据域、字段白名单、时间范围、权限、脱敏和失败策略。
6. **Skills / MCP / 规则**：可调用能力、读写权限、输入输出 Schema、超时和审计策略。
7. **结果输出**：语义结果 Schema、卡片模板、医生可执行动作、禁止动作和写回边界。
8. **安全与降级**：红色风险、身份错配、数据冲突、非法输出和 Runtime 故障的处理。
9. **测试与评测**：单病例测试、数据集回归、对比版本和失败病例。
10. **版本与发布**：草稿、待评审、候选、生产、历史和回滚。

### 5.3 数据连接中心

集中配置 HIS/EMR、LIS、RIS/PACS、用药、过敏、生命体征、术语、专科规则等连接。Agent 只引用 `data_package_version`，不直接保存接口地址或密钥。

### 5.4 模型连接中心

集中配置 OpenAI-compatible、AgentScope 托管模型或院内模型连接。密钥只保存在 Secret 管理系统，Agent 配置只引用 `model_profile_id`。

### 5.5 评测中心

管理内科、骨科、妇科的金标准病例、边界病例和安全病例。支持按 Agent、Prompt 版本、模型版本和数据包版本比较准确性、完整性、风险漏报、幻觉、Schema 合法率、延迟和成本。

### 5.6 运行与审计中心

按 `trace_id` 查看调用阶段、上下文构建、AgentScope 任务、Skills/MCP 调用、结果校验、卡片映射和医生动作。日志不展示完整敏感病历或模型内部推理链。

## 6. Prompt 配置模型

Prompt 不是一个可任意覆盖的单文本框，应按以下顺序组合：

```text
平台不可变安全规则
  + Agent 岗位 Prompt
  + 医院配置
  + 专科/专病配置
  + 当前任务指令
  + 经字段白名单构建的患者上下文
  + 输出 JSON Schema
```

- 平台不可变安全规则只能随代码/平台安全版本发布，医院管理员不能编辑。
- 岗位、医院、专科和任务 Prompt 分别版本化并显示最终合成预览。
- 患者输入、历史文本和外部数据均视为不可信内容，不能覆盖系统指令。
- Prompt 中不得保存 API Key、接口密码、真实患者数据或固定患者示例。
- 每次运行保存 `prompt_bundle_version` 和内容哈希，不默认保存完整敏感上下文。

## 7. 数据接口配置

每个 Agent 绑定一个或多个版本化数据包。数据包至少配置：

| 字段 | 说明 |
| --- | --- |
| `data_package_id/version` | 稳定标识和版本 |
| `data_domain` | 病历、诊断、检验、检查、用药、过敏等 |
| `connector_id` | 引用数据连接中心，不保存密钥 |
| `patient_scope_required` | 是否必须绑定患者与就诊 |
| `field_allowlist` | 允许进入上下文的字段 |
| `lookback_window` | 历史数据时间范围 |
| `freshness_sla` | 数据新鲜度要求 |
| `transform/template` | 标准化、单位换算、摘要模板 |
| `required_permission` | 所需角色和授权 |
| `deidentification` | 脱敏/去标识化要求 |
| `timeout/retry` | 超时与重试策略 |
| `failure_policy` | 阻断、澄清、跳过或降级 |
| `mock_fixture_set` | Mock 与测试使用的数据集 |

必须先构建 `ContextBundleV1`，再调用 AgentScope。Agent 不直接自由查询医院数据库，也不能通过 Prompt 临时扩大数据范围。

## 8. Skills、MCP 与规则绑定

每项绑定记录：能力 ID、版本、允许的 Agent、读写级别、输入/输出 Schema、超时、重试、临床风险等级、权限、Owner 和审计策略。

一期原则：

- 能由确定性规则完成的校验不交给模型；
- 数据读取优先通过受控 MCP/服务或上下文构建器；
- 写操作默认禁止，医生确认后的模拟写回仍由产品 Gateway 执行；
- AgentScope 只负责托管和编排 Agent，不成为权限与审计的唯一权威；
- Worker/Sub-Agent 颗粒度待讨论，但产品调用协议保持稳定。

## 9. 模型连接与 Haiku

每个 Agent 都可以绑定 Haiku 模型，建议一期将 Haiku 作为统一受控基线，而不是把它写死成唯一模型：

- `model_profile_id` 决定 Provider、实际 Model ID 和默认参数；
- Agent 版本保存所引用的 Profile 版本；
- 发布时解析并冻结实际 Model ID；
- 运行日志记录实际 Provider、Model ID、耗时、Token 和重试；
- 诊断、风险和共病等高风险任务必须先通过专项评测，不能因为“已连接 Haiku”就视为临床可用；
- 模型不可用时按 Agent 配置进入规则降级、人工处理或失败，不能返回静态成功文案。

模型密钥不在 Agent 表、Prompt 或前端返回中出现。健康接口只能返回是否已配置、模型别名和实际模型 ID，不返回 Endpoint 密钥。

## 10. 版本发布流程

```text
编辑草稿
  -> 配置静态校验
  -> 单病例真实模型测试
  -> Mock/金标准数据集回归
  -> 安全门禁
  -> 临床/产品评审
  -> 候选发布
  -> 小流量或指定账号验证
  -> 生产发布
  -> 监控或一键回滚
```

发布门禁至少包含：配置 Schema 合法、数据权限合法、输出 Schema 100% 合法、红色风险安全集无零容忍漏报、患者身份错配为 0、必需评测集通过、审批人齐全。

回滚只切换生产版本指针，不删除新版本及其运行日志。正在运行的任务继续绑定启动时的版本，不能中途切换 Prompt、模型或数据包。

## 11. 建议数据表

| 表 | 核心职责 |
| --- | --- |
| `agent_definitions` | 六个 Agent 的稳定身份、岗位和任务映射 |
| `agent_versions` | Prompt、模式、阈值、模型、数据包、工具、输出和安全配置快照 |
| `agent_environment_releases` | 各医院/环境当前生产版本指针 |
| `model_profiles` / `model_profile_versions` | Provider、Model ID、参数和 Secret 引用 |
| `data_connectors` / `data_connector_versions` | 接口协议、Endpoint 元数据、权限和 Secret 引用 |
| `context_packages` / `context_package_versions` | 字段白名单、时间范围、转换和失败策略 |
| `skill_bindings` / `mcp_bindings` | Agent 可调用能力和权限 |
| `prompt_layers` / `prompt_bundle_versions` | 分层 Prompt 及合成快照 |
| `evaluation_suites` / `evaluation_runs` | 数据集、指标、结果和发布门禁 |
| `agent_runs` / `agent_run_steps` | 任务、模型、工具、校验、耗时与结果摘要 |
| `agent_change_audits` | 配置、测试、审批、发布和回滚审计 |

所有核心表必须包含 `organization_id`、环境、创建/修改人、时间、版本和状态；患者运行记录另绑定 `patient_id`、`encounter_id`、`task_id` 和 `trace_id`。

## 12. 建议管理 API

```text
GET    /api/admin/v1/agents
GET    /api/admin/v1/agents/{agent_id}
POST   /api/admin/v1/agents/{agent_id}/versions
PUT    /api/admin/v1/agent-versions/{version_id}
POST   /api/admin/v1/agent-versions/{version_id}/validate
POST   /api/admin/v1/agent-versions/{version_id}/test
POST   /api/admin/v1/agent-versions/{version_id}/evaluate
POST   /api/admin/v1/agent-versions/{version_id}/submit-review
POST   /api/admin/v1/agent-versions/{version_id}/publish
POST   /api/admin/v1/agents/{agent_id}/rollback

GET/POST /api/admin/v1/model-profiles
GET/POST /api/admin/v1/data-connectors
GET/POST /api/admin/v1/context-packages
GET/POST /api/admin/v1/skills
GET/POST /api/admin/v1/mcp-servers
GET      /api/admin/v1/agent-runs
GET      /api/admin/v1/agent-runs/{run_id}
```

医生工作站继续只调用 `/api/v1/agent-tasks`，不感知后台配置表结构。

## 13. 权限建议

| 角色 | 权限 |
| --- | --- |
| 产品管理员 | 岗位、调用规则、输出和页面映射草稿 |
| Agent 调优人员 | Prompt、模型参数、测试和评测，不可配置数据越权 |
| 数据接口管理员 | 数据连接、字段白名单、权限、脱敏和新鲜度 |
| 临床审核人 | 临床结果、风险、安全集和发布审批 |
| 安全/合规管理员 | 权限、审计、科研/教学脱敏和高风险发布门禁 |
| 发布管理员 | 候选/生产发布和回滚，不默认编辑 Prompt |

同一人是否可以同时调优并发布由医院确认；生产建议至少采用调优与审批分离。

## 14. 一期实施范围

一期先实现：

1. 六个 Agent 总览；
2. Prompt 分层编辑与合成预览；
3. Haiku 模型 Profile 引用与实际模型显示；
4. 数据包、Skills/MCP 和输出 Schema 的配置 Mock；
5. 单病例测试、数据集回归 Mock 与结果比较；
6. 草稿、发布、历史版本和回滚；
7. 运行日志、版本指纹和审计；
8. 与现有 `MockRuntimeAdapter` 对接，并为 `AgentScopeRuntimeAdapter` 保留稳定接口。

一期暂不实现真实 HIS 接口自由编排、生产密钥管理、真实临床发布和自动写回。正式环境接入时再替换 Mock Connector、模型 Secret 和 AgentScope Adapter，不改变医生工作站任务契约。

## 15. 验收标准

- `AC-ADMIN-001` 六个 Agent 可独立配置、测试、发布和回滚，诊断 Agent 的两个任务共享同一生产版本。
- `AC-ADMIN-002` 每个 Agent 可绑定 Haiku Profile，并显示档位、实际 Provider/Model ID 和版本。
- `AC-ADMIN-003` 每个 Agent 可绑定版本化数据包、Skills/MCP、输出 Schema 和卡片映射。
- `AC-ADMIN-004` Prompt 编辑不能覆盖平台安全层，患者输入不能改变系统指令。
- `AC-ADMIN-005` 未通过 Schema、权限、安全集或审批门禁的版本不能发布。
- `AC-ADMIN-006` 医生工作站每次运行可追溯到 Agent、Prompt、模型、数据包、工具和规则版本。
- `AC-ADMIN-007` 密钥、完整敏感上下文和模型内部推理链不进入配置页面、普通日志或导出包。
- `AC-ADMIN-008` 回滚不删除历史版本或运行记录，运行中任务不被中途换版。

## 16. 待讨论

- 北大国际院 AgentScope 的 SDK/HTTP 接口、鉴权、服务发现和版本管理能力。
- Haiku 的正式 Provider、Endpoint、配额、数据出境和院内网络接入方式。
- 诊断、风险、共病是否需要 Haiku 之外的强模型路由及触发阈值。
- 六个 Agent 与 33 项专项能力的 Skill、Worker/Sub-Agent 颗粒度。
- 医院、科室、亚专科、专病 Prompt 的继承与覆盖优先级。
- 生产发布所需临床、数据、安全和信息中心审批流程。
