# Doctor Agent 项目交接手册

更新时间：2026-09-06（Asia/Shanghai）
项目目录：`/Users/leying/Documents/北大医疗/AI Native Systems/projects/doctor-agent`
远程仓库：`https://github.com/aaronle/doctor-agent`（**私有**）
当前分支：`feat/delivery-platform`
线上：**<https://da.aaronhealth.cn>**，`0.3.0-mvp`，2026-08-31 上线

本文件是 Doctor Agent 的当前接手入口。**2026-09-06 全量重写**，修正了此前六处口径漂移（详见
[`docs/19-系统审计报告.md`](docs/19-系统审计报告.md) §5）。此前版本里凡与本文件冲突的表述一律作废。

## 0. 三十秒版本

一期七功能已按 V4.3 界面基准实现完毕并上线公网，六个岗位接真实模型，界面还原度门禁
146 个元素零差异。**但这是一个演示级系统，不是可以接真实患者的系统。**

差距不在功能，在守护：`/api/admin/*` 在公网上零鉴权（任何人可改临床岗位提示词并立即生效）、
写回门禁可被一条 curl 绕过、六个岗位的模型调用其实没有超时。这三条是 P0，
动任何新功能之前应该先关掉它们。完整清单见 [`docs/19-系统审计报告.md`](docs/19-系统审计报告.md)。

## 1. 接手顺序

1. 阅读本文件。
2. [`docs/19-系统审计报告.md`](docs/19-系统审计报告.md) —— **当前所有已知缺口与风险**，
   按严重度排序，每条带可执行修法。接手后第一件事应该从这里挑活，而不是加新功能。
3. [`docs/product/10-V4.3反向需求规格说明书.md`](docs/product/10-V4.3反向需求规格说明书.md)
   —— 从 V4.3 逐屏倒推的完整需求书，覆盖五个页面、八个标签页、对话框清单、数据契约。
   每条标了【原件】/【增强】/【缺口】。**注意 §6 与 §10 对对话框实现状态自相矛盾，以 §6 为准。**
4. [`docs/product/12-移动端需求规格说明书.md`](docs/product/12-移动端需求规格说明书.md)
   —— ≤768px 是**另一套信息架构**（落地即对话、三档切换、**不写 HIS/EMR**），不是响应式重排。
   改任何页面前先确认移动端分支要不要跟着改。控制台也有移动端（`MobileAdminConsole.vue`），
   它保留写入动作。**登录页已移除**：一期无 SSO，那道门形同虚设，根路径直接进候诊列表。
5. [`docs/product/14-桌面端问诊流程与分析门禁.md`](docs/product/14-桌面端问诊流程与分析门禁.md)
   —— 桌面端一进来只有医生智能体，模型推断的四页问诊后才解锁；硬规则红线与 HIS 客观数据不锁。
6. 排障前读 [`docs/product/13-日志与可观测性说明.md`](docs/product/13-日志与可观测性说明.md)。
7. [`docs/product/09-一期需求规划说明书.md`](docs/product/09-一期需求规划说明书.md) —— 一期执行契约。
8. [`docs/product/08-V4.3界面基准与后端API契约.md`](docs/product/08-V4.3界面基准与后端API契约.md) —— 界面与 API 的唯一事实源。

```sh
cd "/Users/leying/Documents/北大医疗/AI Native Systems/projects/doctor-agent"
git status -sb && git log -5 --oneline
curl -fsS https://da.aaronhealth.cn/api/health
```

## 2. 本地开发

```sh
npm run dev    # API :8000，Vite :4173，Vite 代理 /api 到 API
```

模型通道需要 `.env`（已 gitignore，权限 600）。密钥从 `projects/ts-it-service/.env.runtime`
同步 —— 两个项目共用同一个第三方网关、同一组变量名、**同一把 key**。

```env
AI_API_KEY=            # 从 ts-it-service 同步，不要写进任何文档
AI_BASE_URL=https://www.meatdc.com/v1
AI_FAST_MODEL=claude-sonnet-5    # 只管不走档位的调用（Copilot 对话等）
AI_TIMEOUT_MS=90000              # ⚠️ 见下方警告：这个值对六个岗位无效
AI_TEST_MODE=          # 置为 rules 时全部岗位走本地规则，不调模型
```

> **⚠️ `AI_TIMEOUT_MS` 目前只作用于流式路径。** 六个岗位走 `model_gateway.build_chat_model()`，
> 它的 `client_kwargs` 里没有 `timeout`，openai SDK 默认 600s。所以岗位**永远不会因超时降级**，
> 真正切断的是 Nginx 的 180s，医生看到空白 504 而不是「已降级」。这是 P0-3，
> `env.runtime.example` 里那句注释是错的。修法见审计报告。

### 岗位用什么模型看「档位」，不看 `AI_FAST_MODEL`

档位在各岗位类里声明（`agents/base.py:137` 是缺省，子类覆盖）：

| 档位 | 模型 | 岗位 | 依据 |
| --- | --- | --- | --- |
| `clinical_fast` | Haiku 4.5 | `record` | 实测两模型回归集都 10/10，45.8s → 5.0s |
| `clinical_reasoning` | Sonnet 5 | `summary` / `diagnosis` / `comorbidity` / `voice` | 无 A/B 数据，留强的一侧 |
| `clinical_safety` | Sonnet 5 | `risk` | 只有 1 条用例，且漏报有临床后果 |

**所以「六个岗位全接 Sonnet」是错的说法** —— record 走 Haiku。旧版 HANDOVER 在同一份文件里
两处打架，这次统一以本表为准。

`report-summary` 里那四个是**并发**的，耗时等于最慢的 risk（52.2s）—— 动另外三个一秒都省不下来。
详见 `15-Agent架构重构…md` §15。

> **换模型要同时改代码缺省与部署 env，以 `/api/health` 的实际回值为准。**
> 上一次只改了 `app/config.py`，服务器 `.env.runtime` 还压着 Haiku ——
> 编排层（不读这个变量）换成了 Sonnet，产品路径六个岗位还在跑 Haiku。
> 健康接口一直如实报着，只是没人去看。**同类问题要用测试守，不能靠纪律。**

### 门禁与常用命令

```sh
npm run verify        # 发布门禁：typecheck → test:web → test:api → build → contracts → fidelity → coverage
npm run deploy        # 部署到广州并上报每个阶段（凭据在本机，平台没有）
npm run fidelity      # 只跑还原度比对（「做了的长得对不对」）
npm run coverage      # 类名覆盖率（「有没有整块漏做」）—— 两者互补，缺一不可
npm run verify:legacy # 原来那串 && 的门禁链，怀疑新 runner 自身出问题时用它对照
npm run extract       # 重跑全部 V4.3 抽取
npm run themes        # 主题收敛：把品牌色收成 var(--t-xxx, #原值) 并生成两套主题
npm run themes:check  # 只报告不写（verify 的第一关）
node scripts/build-themes.mjs --revert   # 无损退回收敛前，改分类规则时先退再重跑
```

> **主题收敛动的是全仓 CSS。** 默认主题不定义任何 `--t-*` 变量，靠回退值生效，
> 因此默认态与收敛前逐字节相同、`fidelity` 不受影响 —— 这是结构性保证，
> `styles/themes.spec.ts` 有六条不变量钉住它。
> **状态色（红/橙/绿）绝不纳入主题**：医生换成护眼后危急值也变绿，那是会出人命的。

跑 `verify` 前要先起 `npm run dev`（还原度比对需要访问运行中的前端）。

配了这两个环境变量，门禁与部署结果会上报到交付平台（`/delivery`）；不配就只在终端打印：

```sh
export DELIVERY_API=https://da.aaronhealth.cn
export DELIVERY_INGEST_TOKEN=...   # 服务器 /opt/doctor-agent/config/.env.runtime 里那一个
```

> **门禁目前有两个洞**：`verify.mjs` 七关**没有一关校验临床安全**，红线测试被 `@pytest.mark.skip`
> 掉门禁不会知道；`demo-check.mjs` 缺 `process.exit`，在任何串联里恒为通过。见审计报告 §3。

## 2.1 改动纪律

界面、规格、测试三者必须在**同一个提交**里保持一致：

| 改了什么 | 必须同步改 |
| --- | --- |
| UI/UX | `09-一期需求规划说明书.md` 对应功能段 + 该行为的测试 + 跑 `npm run fidelity` |
| **移动端 UI/UX** | `12-移动端需求规格说明书.md` + `apps/web/src/mobile/*.spec.ts`。移动端是另一套 IA，桌面改了它不会自动跟着改 |
| **新增埋点** | `13-日志与可观测性说明.md` 的埋点表；新字段若可能含正文，必须加进 `obs.py` 的 `_REDACTED` |
| **新增界面** | 还要给 `extract-v43-dom.mjs` 加采集态、给 `compare-v43-fidelity.mjs` 加场景。**例外**：`/admin` 与 `/delivery` 不在 V4.3 原件里，两道界面闸不比它们，靠单测守 |
| **交付平台** | `16-交付平台-CICD需求规格说明书.md` + `DeliveryView.spec.ts` + `test_delivery.py` |
| **个人配置项** | `app/preferences.py` 的白名单（**取值的代码事实源**）+ `20-个人配置需求规格说明书.md` 的取值表 + `test_preferences.py`。前端不要硬编码枚举，从 `/api/preferences/options` 拉 |
| **任何 CSS 颜色** | 品牌色系必须走 `npm run themes` 生成的 `var(--t-*, #原值)`，不手改产物；状态色（红/橙/绿）**禁止**纳入主题变量 —— 红色风险在任何主题下都必须是红色 |
| **标志 / 分享卡片** | 改 `design/logo/logo.mjs` 后跑 `npm run logo`；文案改 `app/seo.py` + `test_seo.py`。**不要手改 `apps/web/public/` 下的产物** |
| API 形状 | `08-V4.3界面基准与后端API契约.md` + `test_api.py` + 重跑 `contracts:export` |
| Agent 输出结构 | 规格里该岗位的输出约束 + 对应校验测试 |
| 安全红线 | 规格第 7 节 + **一条能失败的测试**（红线没有测试等于没有红线） |

判断标准：**如果一个人只读规格 Markdown 就能预期到界面的样子和行为，规格就是同步的。**

## 3. 一期范围与实现状态

七个产品功能全部实现，六个岗位接真实模型（档位见 §2）：

| 功能 | 岗位 | 状态 |
| --- | --- | --- |
| 语音问诊 | `voice` | 对齐 V4.3：点一下自动播放对话脚本，播放中浮出「AI 追问提示」与「补充观察」。**⚠️ 见下方说明** |
| 病情概况 | `summary` | 真实模型。矛盾信息并列不合并，不以治疗建议收尾 |
| 病历生成 | `record` | 真实模型（Haiku）。七段 SSE 流式；未提及不写「否认」，不编造查体 |
| 鉴别诊断 | `diagnosis` | 真实模型。支持/反对/缺失三类证据，无反对证据写「未获得」 |
| 诊断管理 | `diagnosis` | 勾选、主诊断标记、回写门禁 |
| 风险管理 | `risk` | **硬规则纯代码实现，独立于模型**；模型不得压低硬规则判定的红色风险 |
| 共病管理 | `comorbidity` | 真实模型。推荐科室取自闭集字典；营养提醒为纯阈值规则 |

> **⚠️ 语音问诊没有语音。** 全仓零行语音识别代码（无 `SpeechRecognition`、`MediaRecorder`、
> `getUserMedia`），对话是播放种子脚本。且「追问清单」与「补充观察」**当前前端有意不消费**
> （`useInterview.ts:28-33`），后端 `emr.py:824-838` 让这两个字段恒为空数组。
> 旧版 HANDOVER 说它们「是真实模型输出」是错的。

医生端之外还有两个面向研发与调优的页面，**不占用 V4.3 定义的五个医生端页面**：

| 路由 | 是什么 | 规格 | 状态 |
| --- | --- | --- | --- |
| `/admin` | Agent 配置与运行控制台 | `11-Agent控制台需求规格说明书.md` | 已上线，**零鉴权（P0-1）** |
| `/delivery` | 交付平台 CI/CD，功能线与智能体线并排 | `16-交付平台-CICD需求规格说明书.md` | **已实现并上线**（09-02） |
| `/settings` | 个人配置：色调、字号、AI 追问初始状态、浮窗布局记忆 | `20-个人配置需求规格说明书.md` | **已实现，未提交未发布**（09-07，见 `docs/22`） |

明确不做：医院 SSO、真实 HIS 写回、真实患者数据。
AgentScope 编排层已于 2026-09-02 接入，见 `15-Agent架构重构-Master-Worker-Skill.md`。

## 4. 技术栈与目录

```text
doctor-agent/
├── apps/
│   ├── web/            Vue 3 + Element Plus + Pinia
│   │   ├── src/mobile/    移动端组件（≤768px 才挂载，类名一律 m- 前缀）
│   │   └── src/logging.ts 前端结构化日志，挂 window.__da
│   └── api/            FastAPI + SQLAlchemy + SQLite
│       └── app/
│           ├── agents/     六个岗位 + 上下文装配 + 提示词分层 + safety.py
│           ├── orchestration/  AgentScope Master–Worker–Skill 四层
│           ├── routers/    his / emr / config / admin / delivery / data / telemetry
│           ├── llm.py      OpenAI 兼容网关客户端（**只剩流式路径**）
│           ├── model_gateway.py  岗位用的模型构建（**缺 timeout，P0-3**）
│           ├── obs.py      结构化事件日志（正文不入日志，但 _REDACTED 不够全）
│           ├── cache.py    聚合结果缓存（进程内，30 分钟 TTL，重启即空）
│           └── data/eval_datasets/    评测数据集本体（JSON，可开可关）
├── references/ui-demo/
│   ├── AI-HIS门诊模块V4.3.html   不可修改的原件（MD5 df95a09b…）
│   └── extracted/               全部抽取产物，脚本可复现
├── scripts/            抽取、还原度比对、门禁、部署、演示走查
└── deploy/tencent-guangzhou/    广州单容器部署定义
```

### 界面还原的四条硬约束

1. **CSS 必须按作用域拆分后放进各 SFC 的 `<style scoped>`**，不能扁平化成全局。
   同名类在不同组件里并不相同 —— `.his-header` 在工作站是 46px 高、候诊列表是 56px 高。
2. **`app-overrides.css` 必须全局引入**。V4.3 在所有 scoped 规则之后还有一层不带作用域的
   `!important` 覆盖（表头白底、标题深色），漏掉它整个表头会走样。
3. **`--el-font-size-base: 12px`**，不是 Element Plus 默认的 14px。改回去所有间距行高全部走样。
4. **动态状态要按原件的时序采集**。语音问诊浮层约 7 秒后随播放结束消失，抽取脚本等太久
   就会采到空状态 —— 一期就因此整块漏做过。

改动界面后跑 `npm run fidelity` 做数值回归（需先起 `npm run dev`）。

## 4.1 标志与分享卡片

标志方案 **F1「气泡里的听诊器」**。**唯一定义源是 `design/logo/logo.mjs`**，改它然后 `npm run logo`。
`apps/web/public/` 下的 PNG 全是产物，手改会在下次重跑时丢失。

选型时试过六个方向，成图后砍掉四个：「白大褂领口」读成钥匙孔，「医字几何化」读成字母 E，
「十字+心电波」的心电波在成图里根本看不见。**描述里成立不等于渲出来成立。**

分享卡片按路由变：`app/seo.py` 在下发 index.html 时按路由替换 `<!--SEO:START-->` 到
`<!--SEO:END-->` 之间的整块。**必须在服务端做** —— 微信爬虫不执行 JavaScript。
两个坑：`og:image` **给方图不给横图**（微信裁正方形，1200×630 会被拦腰切）；
标记被删不会报错，只会退化成所有页面共用一张卡片，所以部署脚本会实打实比对线上
`/` 与 `/admin` 的 `<title>` 是否不同。

能保证「按规范把该给的都给全」，**不能保证微信一定照着显示** —— 那需要公众号 + JS-SDK 签名。

## 4.2 设计资产

Figma：**AI 门诊工作站 · 一期设计系统** `https://www.figma.com/design/c79Yrkq4MOgwjN3dulIvO7`

| 页面 | 内容 | 状态 |
| --- | --- | --- |
| 00 · 设计令牌 | 23 个颜色 + 13 个尺寸/字号令牌，均为 Figma Variables | 已建 |
| 01 · 组件库 / 02 · 页面骨架 | —— | 待建 |
| 04 · 移动端 | 六屏 390×844 | 已建，已实现 |
| 05 · 控制台移动端 | 五屏 390×844 | 已建，已实现 |
| 06 · 桌面端问诊流程 | 四态 1600×1000 + 状态机 | 已建，已实现 |
| 07 · CI/CD 平台 | 桌面四屏 + 移动三屏 | 已建，**已实现并上线**（旧版写「尚未实现」是过期的） |
| 08 · 去 HIS 背景 + 助手可展开 | 三屏 | 已建，已实现 |
| 09 · 数据看板 | 四屏 1440×900 | 已建，已实现 |
| 10 · 个人配置 | 桌面两屏 1440 + 移动两屏 390×844 | 已建，**规格见 `20-个人配置需求规格说明书.md`，尚未实现** |

令牌取值**全部来自 V4.3 编译产物**，不是取色器估的。

**Figma 的定位是「设计语言的沉淀」，不是 V4.3 的像素级重绘。** 原件就在仓库里，
`npm run fidelity` 已逐元素比对到零差异，再画一遍只会引入偏差。价值在后续新增界面。

当前 Figma 席位是 `View`（student 层级），建文件与写入实测可用，多人协作编辑可能要升级。

## 5. 安全红线

零容忍门禁，任一不为 0 即阻断发布：伪造事实、未确认写回、红色风险漏报、越权、非法 Schema。

`agents/safety.py` 的 `SAFETY_LAYER` 是全仓唯一一份红线，产品路径与编排路径共用且都排第一。
有测试钉住它的唯一性与不可编辑性。

**当前实际守护状态**（对账见审计报告 §3）：

| 红线 | 测试 |
| --- | --- |
| 伪造事实 | 覆盖最好，6 条正向 + 2 条反向锚定 |
| 未确认写回 | 6 条，但漏了伪造请求体那条路径（P0-2） |
| 红色风险漏报 | 6 条 |
| 越权 | **零** —— 产品里根本没有授权（P0-1） |
| 非法 Schema | 只覆盖入站；`SummaryOut` 与 interview 岗位出站零用例 |

其余硬性约束：

- `AI_API_KEY` 不进 Git、不进日志、不下发前端、不出现在健康接口。**已核实无泄露路径。**
- 一期只用虚构病例（P001–P008）；健康接口声明 `data_classification: MOCK_ONLY_NO_REAL_PATIENT_DATA`。
- 医嘱、转诊、住院、病历一律写本地库并留审计，不触达真实 HIS。
- 红色风险未逐条处置时阻断病历提交与诊断回写；本次就诊未生成 AI 分析时同样阻断。暂存不受门禁。
- V4.3 原件与 `design/current/` 下原件不可修改。

## 6. 已知的运行特性

- **首屏不再等分析**：一进来只拉硬规则红线与就诊状态（毫秒级）。`report-summary` 那
  18–63 秒的四岗位并发挪到问诊结束（或跳过）之后，藏在医生说话的时间里。
  结果按「患者 + 上下文哈希」缓存，复访 3.7ms。
- **降级是正常路径**：网关抖动时岗位降级为确定性本地规则，界面显式标注，不返回伪造的成功文案。
  降级结果不入缓存。八个岗位全部实现了 `fallback()`，基类声明为 `NotImplementedError`，漏写会炸。
  **但桌面端只显示降级计数不显示岗位名**，且 `useInterview` / `useFollowUp` 降级时把结果
  清空成空数组 —— 界面上「没有待补问」和「问诊很完整」长得一样（P1-3）。
- 模型网关偶发 502。重试窗口已从 2 秒放宽到约 6 秒（4 次，退避 500/1500/4000ms）。
- **Sonnet 5 上 `temperature` 已废弃，压不住抖动。** 同一份上下文两次生成的病历会有措辞差异。
  确定性的事实（既往史、硬规则风险）一律由代码兜底 —— 见 `agents/record.py` 的 `_archived_history`。
- **换 Sonnet 后的耗时**：`report-summary` 19.5s → 63.2s；还原度门禁 252s → 479s；
  编排层 Master 一次 126s。凡是有超时的地方都要按这个量级重新看一遍。
- **`interview_agent` 曾从上线起 100% 降级**，没有告警、没有测试失败、界面看不出来，
  是做别的功能时顺手量出来的。提示词已修好，但**下一次同类静默降级仍然靠运气发现**。

## 7. 当前缺口与风险

完整清单与修法见 [`docs/19-系统审计报告.md`](docs/19-系统审计报告.md)。摘要：

**P0 —— 动新功能之前先关掉**

1. `/api/admin/*` 公网零鉴权，任何人可改临床岗位提示词并立即生效；审计 `actor` 恒为 `DEMO_ACTOR`，篡改无法归因。
2. 写回门禁的 `handled_alerts` 取自请求体，服务端不与库比对 —— 一条 curl 即可绕过。
3. 六个岗位的模型调用没有 timeout，永远不会因超时降级，真正切断的是 Nginx 的空白 504。
4. 零限流；`StrictIn` 无 `max_length`；与 `ts-it-service` 共用同一把 key，刷穿会连累工单系统。

**P1 —— 可靠性**

5. SQLite 无备份、无 Alembic（`database.py` 的 docstring 说有，实际没有）、无 WAL（并发写会 `database is locked` → 500）。
6. 63 秒等待且四岗位原子返回；前端只有一个布尔量，医生无从判断是否卡死。建议改 SSE 增量返回。
7. 静默降级无人察觉；无告警、无巡检、结构化日志只留几天。
8. `obs._REDACTED` 不够全，真实数据下病历碎片会进 `docker logs`。
9. `copilot/chat` 是安全层的唯一缺口，不含 `SAFETY_LAYER`。

**功能缺口**

10. 33 项专项评估里 **31 项 `desc` 为空**，医生点开是空白框；且全部零执行，只做目录展示。
11. 转诊、住院两条后端路径**界面上完全不可达**（`createReferral` / `createAdmission` 无调用方）。
12. 九个处置类对话框缺八个；「发起共病会诊」一点即提交，无确认弹层。
13. 推荐医嘱是种子不是模型输出，界面无标识区分。
14. F07 `control_status` 未实现。

**长期待决策**

15. Worker / Skill / Sub-agent 边界；AgentScope 协议、鉴权、超时、审计机制。
16. 九类临床数据源清单与最小权限（全部标「待确认」）。
17. **专科口径冲突**：V4.3 患者是内分泌／心内／神内，既有文档写内科／骨科／妇科。一期以 V4.3 为准，产品文档是否同步修订待确认。
18. 模型配额是否与 Ticket System 分开计。
19. 评测集扩量：已落地可管理数据集 + 首个规范倒推数据集（22 个 case），但 **summary 与 interview 两个岗位是零**。下一步用 Synthea 造中文虚构病例。

**上真实患者数据前的硬门禁**：P0 全部关闭 + 医生端 SSO + `actor` 落真实工号 +
`agent_runs.output` 加保留期与脱敏 + SQLite 落盘加密或迁 PostgreSQL。

## 8. 上线状态

已上线并稳定运行，历史步骤见 [`deploy/tencent-guangzhou/GO-LIVE.md`](deploy/tencent-guangzhou/GO-LIVE.md)。

| 项 | 值 |
| --- | --- |
| 域名 | `da.aaronhealth.cn` → `81.71.155.220`（DNSPod A，TTL 600） |
| 回环端口 | `127.0.0.1:3400` |
| 容器 / 镜像 | `doctor-agent-mvp` / `doctor-agent:0.3.0-mvp` |
| 证书 | Let's Encrypt，至 **2026-11-29**，`certbot.timer` 自动续期，演练已通过 |
| 同机勿动 | `aits-app`（3100）、`aaronhealth-site`（3200）、`comorbidity-mvp` |
| 备案 | `粤ICP备2026119734号`，主体乐颖；`da` 作为子域名沿用主域名备案 |

已完成的关键修补（按时间）：

- 09-01 移动端发布并公网复验：390×844 零元素溢出、零控制台报错，对话往返 2.3s，三个面板零可点写入动作。
- 09-01 撤下 AI 处置单后重新发布复验：五个入口全 200，两条 SSE 均真流式（病历 104 块中位间隔 8.9ms）。
- 09-02 AgentScope 编排层发布：`/api/orchestration/topology` 200，六 worker 全部装配。
- 09-02 **补 Nginx `/api/orchestration/` 的 `proxy_read_timeout 320s`**。这条路径原先继承
  `location /` 的 60s，编排层调用一律 504，应用侧 `CALL_TIMEOUT_S=300` 根本没机会生效。
  给 320s 是为了让应用先超时，使用者拿到「已中止」而不是 Nginx 的空白 504。
  **换 Sonnet 的延迟代价第一次露头** —— 这个缺口一直在，Haiku 时代没被触发过。
- 09-02 **产品路径的模型其实一直没换**。`/topology` 报 Sonnet 就以为换完了，漏了 `/api/emr/*` ——
  服务器 env 的 `AI_FAST_MODEL` 压着 Haiku，优先级高于代码缺省。
- 09-02 **换 Sonnet 把病历岗位从 10/10 打到 3~5/10**，已修回 10/10。提示词一直缺「每段的资料来源」
  这一半，被 Haiku 的习惯盖住了；既往史改由代码兜底回填。
- 09-02 Nginx 再补 `/api/admin/` 的 320s 读超时（控制台的试运行、并排对比、回归集都是模型调用）。

### 证书续期须知（11 月会再遇到）

**Let's Encrypt 签发本域名有概率失败，重试即可，不要改配置。** 首签连挫三次：

| 次 | 报错 | 实质 |
| --- | --- | --- |
| 1 | `query timed out looking up CAA` | 查 CAA 超时 |
| 2 | `During secondary validation: ... timed out looking up A/AAAA` | 多地校验的境外节点超时 |
| 3 | `DNSSEC: DNSKEY Missing ... for cn.` | 连 `cn.` 顶级域的 DNSKEY 都拉不到 |
| 4 | 成功 | —— |

根因：`aaronhealth.cn` 用 DNSPod **免费版**，**全球 Anycast 是付费功能**，境外只能跨国际链路
回中国。LE 自 2020 年起强制多地校验，节点全在境外，撞上丢包就失败。境内查这两台 NS 是
48/48 零丢包 —— **在服务器上 `dig` 得出的结论不适用于 LE**，跟宿主机 curl 测模型网关是同一类陷阱。

排查时别被报错文字带偏：三次错误各不相同且第三次指向 `cn.`，看着像 DNSSEC 配置问题，
实际全是同一条链路在丢包。

LE 限流是**每域名每小时 5 次失败验证**，不要循环重试。零成本探测（不消耗额度）：

```sh
curl -s -H 'accept: application/dns-json' \
  "https://dns.google/resolve?name=cn.&type=DNSKEY&do=1" | grep -o '"Status":[0-9]*'
```

续期由 `certbot.timer` 自动跑，到期前 30 天起每天试两次，正常会自己成功。
**但失败时没有任何东西会通知你** —— 建议加一条 cron 检查剩余天数，<21 天告警。
根治办法是 DNSPod 升级付费版拿 Anycast，或把 NS 换到 Cloudflare（免费且境外解析没问题）。

### 部署环境的三个坑

1. **Docker Hub 拉不动**，用腾讯云内网源 `mirror.ccs.tencentyun.com`，拉完打标签。
2. **宿主机 `curl` 访问模型网关会被 TLS reset，容器内正常。** 差别在 TLS 指纹不在路由 ——
   用宿主机 curl 判断出网会得出错误结论，必须用真实技术栈（容器 + httpx）验证。
3. **`cap_drop: ALL` 与数据目录属主必须配套。** 摘掉 `CAP_DAC_OVERRIDE` 后 root 反而写不进
   `/opt/doctor-agent/data`，SQLite 报 `unable to open database file`。正解是 `user: "1000:1000"`
   并把目录 chown 成同一 uid。

## 9. Git 与远程

- 默认分支 `main`，**当前开发分支 `feat/delivery-platform`**（旧版写 `feat/v43-rebuild` 是过期的）。
- 远程为私有仓库 `aaronle/doctor-agent`，走 HTTPS（`gh` CLI 已登录）。
  SSH 方式当前不可用（`Permission denied (publickey)`）。
- 密钥、真实患者数据、生产导出、访问令牌和运行时环境文件不得提交 Git。

## 10. 项目级 Skill

- `.agents/skills/grill-me/`：来源为 `mattpocock/skills`，仅显式调用的 `$grill-me` 入口。
- `.agents/skills/grilling/`：同源的主实现，由 `$grill-me` 转交调用。
- 本次安装对应的上游修订为 `6654f6b60cd9d5be8b54c6fafe44346dabeb3b76`。
