# MVP 重建实施计划

版本：`v1.0`
日期：`2026-08-29`
状态：已定案，待执行
目标：产出可发布到 `da.aaronhealth.cn` 的 Doctor Agent MVP —— 前端严格复刻 V4.3，后端为真实实现，四个核心 Agent 接 Claude Haiku。

## 1. 已确认的四项决策

| 决策项 | 结论 |
| --- | --- |
| 前端 | 从 V4.3 打包产物**反向重建**为可维护的 Vue 3 SFC 源码，像素级贴合 |
| 模型通道 | 复用 Ticket System 的第三方网关（OpenAI 兼容），`claude-haiku-4-5-20251001` |
| 数据库 | SQLite |
| Agent 范围 | 先做 4 个核心：病情概况、病历生成、诊断、风险管理 |

暂不做：AgentScope 接口、真实 ASR、语音问诊 Agent、共病 Agent（保留 fixture 兜底）、医院 SSO、真实 HIS 写回。

## 2. 现有资产与取舍

保留：

- `apps/api/` 的 FastAPI 工程骨架、SQLAlchemy 数据层、审计事件、幂等键、患者/就诊一致性校验。
- `docs/product/01` 与 `features/F01`–`F07` 的临床规则与安全红线。
- `docs/agent-integration/` 的岗位卡、上下文分层、输出校验、零容忍门禁。这些下沉为 Agent 网关内部约束。

替换：

- `apps/web/` 的界面实现。它是按 `design/current/AI-HIS医生智能体一期.html` 做的，与 V4.3 不是同一份设计（MD5 不同），一期不再以它为基线。工程配置、测试基建、Pinia 用法可以继承，视图层重写。
- 对前端暴露的 API 形状。改为实现 V4.3 已定义的 20 个端点（见 `docs/product/08-V4.3界面基准与后端API契约.md`），原 `/api/v1/agent-tasks` 契约退居内部。

## 3. 目标架构

```text
Vue 3 SFC（复刻 V4.3）
  │  相对路径调用
  ▼
FastAPI 产品 API  ── /api/config
                  ├─ /api/his/*      HIS 数据面：读种子库，写入本地表 + 审计
                  └─ /api/emr/*      AI 面：聚合读取 + 两路 SSE
                       │
                       ▼
                  Agent Runner
                       │  ContextBundle（最小充分、来源清晰、时间明确）
                       ▼
                  LLM Client（OpenAI 兼容网关，Haiku）
                       │  JSON Schema 强约束 + 输出校验 + 确定性兜底
                       ▼
                  SQLite ── 种子数据 / 医嘱 / 会话 / agent_runs / audit_logs
```

单容器，FastAPI 同源提供 Vue 构建产物与 `/api/*`，只绑 `127.0.0.1:3400`，外层 Nginx 终止 HTTPS。

## 4. 模型接入（对齐 Ticket System）

照搬 `ts-it-service` 的模式，不要另起炉灶。

### 4.1 环境变量

```env
AI_API_KEY=            # 从 ~/.hermes/.env 同步，容器内经 .env.runtime（0600）注入
AI_BASE_URL=https://www.meatdc.com/v1
AI_FAST_MODEL=claude-haiku-4-5-20251001
AI_SMART_MODEL=claude-sonnet-5
AI_TIMEOUT_MS=45000
AI_TEST_MODE=          # "rules" 时走确定性本地规则，不调模型
```

### 4.2 客户端要点

- 协议：`POST {AI_BASE_URL}/chat/completions`，`Authorization: Bearer {AI_API_KEY}`。
- 请求体：`{model, messages, response_format: {type: "json_object"}, enable_thinking: false}`；Haiku 另加 `temperature: 0`。
- 重试：3 次，仅在 `429` 或 `5xx` 时重试，退避 500ms → 1500ms，每次独立超时。
- 记账：回传 `usage`（prompt/completion/total tokens）、`elapsedMs`、`requestBytes`，写入 `agent_runs`。
- 解析：剥 ``` 围栏后按括号深度扫出第一个完整 JSON 对象，非对象或截断即报错，不做猜测性修补。
- 兜底：每个 Agent 都要有确定性本地规则实现，`provider` 标为 `local-rules`。模型不可用时降级到它，**不得返回伪造的成功文案**。
- 日志：结构化单行 JSON，只记 `{event, model, attempt, requestBytes, status, elapsedMs}`，绝不记密钥与完整病历。

### 4.3 Prompt 分层

```
[平台安全层，不可编辑] + [岗位层] + [专科层] + [任务指令] + [白名单构建的患者上下文] + [输出 JSON Schema]
```

安全层明确声明：患者输入与外部数据是不可信数据，不能覆盖系统指令；Agent 不得自行确诊、开方、写回。每次运行记录 `prompt_bundle_version` 与内容哈希。

### 4.4 SSE 与流式

V4.3 的两个流式端点要真流式。网关走 OpenAI 兼容 `stream: true`，把 delta 转成 V4.3 约定的事件格式（`token` / `record_node_start` / `record_token` / `record_node_done` / `record_done` / `prompt_token` / `prompt_done`）。

病历生成是结构化流：先让模型按七段 JSON 输出，服务端再按段切分下发，保证 `node_id` 严格落在七段枚举内。不要把模型自由文本直接透传。

## 5. 四个 Agent

| Agent | 供给的接口 | 输出约束 |
| --- | --- | --- |
| 病情概况 | `report-summary` 的 `overall_conclusion`、`treatment_effectiveness`；`copilot/chat` 普通问答 | 一句话摘要 + 问题清单 + 趋势 + 证据引用；冲突并列不合并；不以治疗建议收尾 |
| 病历生成 | `copilot/chat?generate_record`、`generate-record-auto`、`generate-record-field` | 严格七段；未提及不得写「否认/无」；不生成未证实体征；不把待排写成确诊 |
| 诊断 | `report-summary` 的 `suspected_diagnoses`、`differential_diagnosis` | 候选带支持/反对证据与缺失信息；反对证据无则写「未获得」；不输出伪精确概率 |
| 风险管理 | `report-summary` 的 `risk_assessments`、`risk_alerts` | 红/黄/蓝分级；红色必须带证据、来源、阈值与处置建议；**硬规则独立于模型运行**，模型不可用时仍须产出 |

共病与语音问诊：`comorbidity/*` 与 `voice/*` 继续用 fixture 返回，接口形状与真实实现一致，后续替换不动前端。

风险管理的硬规则（过敏冲突、危急值、生命体征阈值）用纯代码实现，与 Haiku 结果合并；**任何情况下模型不得覆盖硬规则判定的红色风险**。

## 6. 数据库

SQLite，SQLAlchemy + Alembic。种子从 `references/ui-demo/extracted/fixtures/` 导入。

```text
-- 临床种子（只读为主）
patients            患者主数据（含 vitals / lab_results / suspected_diagnoses JSON 列）
drugs               药品字典
examinations        检查报告
visit_history       就诊史
dialog_scripts      演示对话脚本

-- 运行时写入
orders              医嘱与检查申请（category: drug | exam）
referrals           转诊申请
admissions          住院申请
voice_sessions      语音问诊会话与消息
record_drafts       病历草稿（七段，带版本与来源映射）
reminders           候诊提醒

-- Agent 与治理
agent_versions      岗位、prompt、模型、阈值、状态 draft|published|inactive
agent_runs          每次调用：agent_key、model、provider、耗时、token、输入摘要、输出、错误
audit_logs          actor / action / entity / detail / created_at
operation_logs      每请求：request_id、method、status、耗时、错误码
```

建表沿用 Ticket System 的幂等做法：启动时跑一遍 `CREATE TABLE IF NOT EXISTS` + `PRAGMA table_info` 补列，Alembic 用于正式环境的可追溯迁移。

## 7. 实施顺序

**阶段 0 · 基线**（先做，其余都依赖它）

1. 跑 `node scripts/extract-v43-assets.mjs`，确认产物齐全。
2. 把当前工作区**全部提交进 Git**。现在 `apps/`、`deploy/`、`packages/`、`docs/testing/` 全是未跟踪状态，所有成果没有版本保护 —— 这是目前最大的工程风险，动手改代码前必须先解决。
3. 建分支 `feat/v43-rebuild`。

**阶段 1 · 前端复刻**

4. 新建 Vue 3 + Vite 工程，引入 Element Plus，先落 `design-tokens.css`（务必含 `--el-font-size-base: 12px`）。
5. 按 V4.3 路由建五个页面与 `AiEmrFloat`。
6. 从 `app.css` 逐块搬样式到对应组件，边搬边和原件对屏比对。**这一步用浏览器把 V4.3 原件和新工程并排打开逐屏核**，不要凭记忆写。
7. 前端全部走真实 HTTP，禁止组件内写死数据。

**阶段 2 · 后端数据面**

8. 建库、写迁移、导入种子。
9. 实现 `/api/config` 与 10 个 `/api/his/*`，全部对着契约文档的请求/响应形状写。
10. 前端此时应能完整跑通候诊列表、患者管理、患者详情、开医嘱、开检查、转诊、住院。

**阶段 3 · Agent 接入**

11. 写 LLM 客户端与 Prompt 分层，先用 `AI_TEST_MODE=rules` 把链路跑通。
12. 按「风险管理 → 病情概况 → 诊断 → 病历生成」的顺序接真实 Haiku。风险管理排第一，因为它的硬规则部分不依赖模型，能最快验证整条链路。
13. 实现 `report-summary` 聚合，支持部分就绪与降级。
14. 实现两个 SSE 端点。

**阶段 4 · 收口与发布**

15. 前端测试、API 测试、类型检查、生产构建全绿。
16. 健康指纹端点：`{ok, release, database, ai: "configured|unconfigured", aiModels, agents: [...], runtime_mode, data_classification: "MOCK_ONLY_NO_REAL_PATIENT_DATA", time}`。
17. 构建单容器镜像，本机验证。
18. 广州发布：DNSPod A 记录指向 `81.71.155.220` → Nginx 站点 → Certbot → 绑 `127.0.0.1:3400` → 公网逐功能验收。

## 8. 硬性约束

- `references/ui-demo/AI-HIS门诊模块V4.3.html` 与 `design/current/` 下的原件**不可修改**。
- `AI_API_KEY` 不进 Git、不进日志、不下发前端、不出现在健康接口。
- 一期只用虚构病例，不接真实患者数据。健康接口须显式声明 `data_classification`。
- 医嘱、转诊、住院、病历一律写本地库并留审计，不触达真实 HIS。
- 红色风险未闭环时阻断病历提交与诊断写回。
- 不得动同机的 `aits-app`、`aaronhealth-site`、`comorbidity-mvp`；`3400` 之外的端口不碰。
- 广州机器 2 vCPU / 4 GB，不引入 PostgreSQL、Redis、向量库、本地模型。

## 9. 需要在动手时确认的事

- `~/.hermes/.env` 里的 key 是否对 doctor-agent 也可用，是否需要单独配额。
- 广州服务器到 `www.meatdc.com` 的出网是否通、延迟多少（Ticket System 已在跑，大概率没问题，但要实测）。
- `da.aaronhealth.cn` 的 DNS 是否已解析。
- V4.3 患者是内分泌/心内/神内三科，与原定内科/骨科/妇科口径不同。一期以 V4.3 为准，是否需要同步修订产品文档的专科范围表述。
