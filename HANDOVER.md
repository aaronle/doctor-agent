# Doctor Agent 项目交接手册

更新时间：2026-09-01（Asia/Shanghai）
项目目录：`/Users/leying/Documents/北大医疗/AI Native Systems/projects/doctor-agent`
远程仓库：`https://github.com/aaronle/doctor-agent`（**私有**）
项目状态：一期七功能已按 V4.3 界面基准实现完毕，六个岗位接真实 Claude Haiku。
界面还原度门禁覆盖 **146 个元素，零差异零缺失**；另有类名覆盖率检查（`npm run coverage`）八页零缺失。
**已上线公网：<https://da.aaronhealth.cn>**（2026-08-31）。证书 Let's Encrypt，有效期至
2026-11-29，`certbot.timer` 自动续期，续期演练已通过。公网实测：真实模型端到端 17.8s
零降级，五个入口与控制台全部 200，两个 SSE 端点真流式（块间隔 11.9ms / 20.9ms，与服务端
节流的 12ms / 20ms 吻合），密钥无泄露，同机另外三个站点未受影响。
**2026-09-01 增加移动端**：≤768px 走另一套信息架构（落地即对话、对话/分析/记录三档、
**不写 HIS/EMR**），见 [`docs/product/12-移动端需求规格说明书.md`](docs/product/12-移动端需求规格说明书.md)。

本文件是 Doctor Agent 项目的当前接手入口。

## 1. 接手顺序

1. 阅读本文件。
2. 阅读 [`docs/product/10-V4.3反向需求规格说明书.md`](docs/product/10-V4.3反向需求规格说明书.md)
   —— **从 V4.3 逐屏倒推的完整需求书**，覆盖五个页面、八个标签页、对话框清单、
   数据契约、功能增强清单与遗留缺口。每条都标了【原件】/【增强】/【缺口】。
   从下一次开始，流程按「需求 Markdown → UI/UX → 测试用例 → 编码 → 测试 → 部署」
   正向走，这份文档是起点。
3. 阅读 [`docs/product/12-移动端需求规格说明书.md`](docs/product/12-移动端需求规格说明书.md)
   —— ≤768px 下是**另一套信息架构**（落地即对话、三档切换、**不写 HIS/EMR**），
   不是响应式重排。改任何页面前先确认移动端分支要不要跟着改。
   **控制台也有移动端**（`MobileAdminConsole.vue`），它保留写入动作。
   **登录页已移除**：一期无 SSO，那道门形同虚设，根路径直接进候诊列表。
4. 阅读 [`docs/product/14-桌面端问诊流程与分析门禁.md`](docs/product/14-桌面端问诊流程与分析门禁.md)
   —— **桌面端一进来只有医生智能体**，模型推断的四页问诊后才解锁；
   硬规则红线与 HIS 客观数据不锁。**未生成分析不得写回**。
5. 排障前读 [`docs/product/13-日志与可观测性说明.md`](docs/product/13-日志与可观测性说明.md)
   —— 四层日志各管一段，以及「正文绝不进日志」这条硬约束。
6. 阅读 [`docs/product/09-一期需求规划说明书.md`](docs/product/09-一期需求规划说明书.md) —— 一期的执行契约。
7. 阅读 [`docs/product/08-V4.3界面基准与后端API契约.md`](docs/product/08-V4.3界面基准与后端API契约.md) —— 界面与 API 的唯一事实源。
8. 根据任务所属条线阅读对应详细 Markdown。

```sh
cd "/Users/leying/Documents/北大医疗/AI Native Systems/projects/doctor-agent"
git status -sb && git log -5 --oneline
```

## 2. 本地开发

```sh
# 一次起前后端（API :8000，Vite :4173，Vite 代理 /api 到 API）
npm run dev
```

模型通道需要 `.env`（已 gitignore，权限 600）。密钥从 `projects/ts-it-service/.env.runtime`
同步 —— 两个项目共用同一个第三方网关和同一组变量名。

```env
AI_API_KEY=            # 从 ts-it-service 同步，不要写进任何文档
AI_BASE_URL=https://www.meatdc.com/v1
AI_FAST_MODEL=claude-sonnet-5    # 2026-09-02 由 Haiku 4.5 换过来
AI_TIMEOUT_MS=90000              # Sonnet 更慢，45s 会让岗位擦边超时后降级
AI_TEST_MODE=          # 置为 rules 时全部岗位走本地规则，不调模型
```

> **换模型要同时改代码缺省与部署 env，以 `/api/health` 的实际回值为准。**
> 上一次只改了 `app/config.py`，服务器的 `.env.runtime` 还压着 Haiku ——
> 编排层（不读这个变量）换成了 Sonnet，产品路径六个岗位还在跑 Haiku。
> 健康接口一直如实报着 `aiModels.fast: haiku`，只是没人去看。

发布门禁 —— 一条命令跑完测试、构建、契约导出与两道界面闸：

```sh
npm run verify
```

跑 `verify` 前要先起 `npm run dev`（还原度比对需要访问运行中的前端）。

配了这两个环境变量，门禁与部署的结果会上报到交付平台（`/delivery`）；
不配就只在终端打印，行为不变：

```sh
export DELIVERY_API=https://da.aaronhealth.cn
export DELIVERY_INGEST_TOKEN=...   # 服务器 /opt/doctor-agent/config/.env.runtime 里那一个
```

其他常用命令：

```sh
npm run deploy        # 部署到广州并上报每个阶段（凭据在本机，平台没有）
npm run fidelity      # 只跑还原度比对（比「做了的长得对不对」）
npm run coverage      # 类名覆盖率（比「有没有整块漏做」）——两者互补，缺一不可
npm run verify:legacy # 原来那串 && 的门禁链，怀疑是新 runner 自身出问题时用它对照
npm run extract       # 重跑全部 V4.3 抽取（静态资源 + 渲染态 DOM + CSS 拆分）
```

## 2.1 改动纪律（重要）

界面、规格、测试三者必须在**同一个提交**里保持一致，不允许脱节：

| 改了什么 | 必须同步改 |
| --- | --- |
| UI/UX | `docs/product/09-一期需求规划说明书.md` 对应功能段 + 该行为的测试 + 跑 `npm run fidelity` |
| **移动端 UI/UX** | `docs/product/12-移动端需求规格说明书.md` + `apps/web/src/mobile/*.spec.ts`。移动端是另一套 IA，桌面改了它不会自动跟着改 |
| **新增埋点** | `docs/product/13-日志与可观测性说明.md` 的埋点表；新字段若可能含正文，必须加进 `obs.py` 的 `_REDACTED` |
| **新增界面** | 还要给 `extract-v43-dom.mjs` 加采集态、给 `compare-v43-fidelity.mjs` 加场景 —— 否则它落在门禁外。**例外**：`/admin` 与 `/delivery` 不在 V4.3 原件里，两道界面闸不比它们，靠单测守 |
| **交付平台** | `docs/product/16-交付平台-CICD需求规格说明书.md` + `apps/web/src/views/DeliveryView.spec.ts` + `apps/api/tests/test_delivery.py` |
| **标志 / 分享卡片** | 改 `design/logo/logo.mjs` 后跑 `npm run logo`；文案改 `app/seo.py` + `apps/api/tests/test_seo.py`。**不要手改 `apps/web/public/` 下的产物** |
| API 形状 | `docs/product/08-V4.3界面基准与后端API契约.md` + `apps/api/tests/test_api.py` + 重跑 `contracts:export` |
| Agent 输出结构 | 规格里该岗位的输出约束 + 对应校验测试 |
| 安全红线 | 规格第 7 节 + 一条能失败的测试（红线没有测试等于没有红线） |

判断标准很简单：**如果一个人只读规格 Markdown 就能预期到界面的样子和行为，规格就是同步的。**

## 3. 一期范围与实现状态

七个产品功能全部实现，六个岗位全部接真实 `claude-sonnet-5`：

| 功能 | 岗位 | 状态 |
| --- | --- | --- |
| 语音问诊 | `voice` | 对齐 V4.3：点一下自动播放对话脚本，播放中浮出「AI 追问提示」与「补充观察」。脚本是演示数据，清单与观察项是真实模型输出 |
| 病情概况 | `summary` | 真实模型。矛盾信息并列不合并，不以治疗建议收尾 |
| 病历生成 | `record` | 真实模型。七段 SSE 流式；未提及不写「否认」，不编造查体 |
| 鉴别诊断 | `diagnosis` | 真实模型。支持/反对/缺失三类证据，无反对证据写「未获得」 |
| 诊断管理 | `diagnosis` | 勾选、主诊断标记、回写门禁 |
| 风险管理 | `risk` | 硬规则纯代码实现，独立于模型；模型不得压低硬规则判定的红色风险 |
| 共病管理 | `comorbidity` | 真实模型。推荐科室取自闭集字典；营养提醒为纯阈值规则 |

医生端之外还有两个面向研发与调优的页面，**不占用 V4.3 定义的五个医生端页面**：

| 路由 | 是什么 | 规格 |
| --- | --- | --- |
| `/admin` | Agent 配置与运行控制台 | `11-Agent控制台需求规格说明书.md` |
| `/delivery` | 交付平台（CI/CD），功能线与智能体线并排 | `16-交付平台-CICD需求规格说明书.md` |

明确不做：医院 SSO、真实 HIS 写回、真实患者数据。
（AgentScope 已于 2026-09-02 接入，见 `15-Agent架构重构-Master-Worker-Skill.md`。）

## 4. 技术栈与目录

```text
doctor-agent/
├── apps/
│   ├── web/            Vue 3 + Element Plus + Pinia，五路由六组件
│   │   ├── src/mobile/    移动端组件（≤768px 才挂载，类名一律 m- 前缀）
│   │   └── src/logging.ts 前端结构化日志，挂 window.__da
│   └── api/            FastAPI + SQLAlchemy + SQLite
│       └── app/
│           ├── agents/     六个岗位 + 上下文装配 + 提示词分层
│           ├── routers/    his / emr / config
│           ├── llm.py      OpenAI 兼容网关客户端
│           ├── obs.py      结构化事件日志（正文不入日志）
│           ├── cache.py    聚合结果缓存
│           ├── eval_datasets.py       评测数据集加载与启停
│           └── data/eval_datasets/    数据集本体（JSON，可开可关）
├── references/ui-demo/
│   ├── AI-HIS门诊模块V4.3.html   不可修改的原件（MD5 df95a09b…）
│   └── extracted/               全部抽取产物，脚本可复现
├── scripts/
│   ├── extract-v43-assets.mjs   静态抽取：CSS / 令牌 / fixture
│   ├── extract-v43-dom.mjs      动态抽取：30 个界面状态的渲染 DOM
│   ├── split-v43-css.mjs        按组件作用域拆分 CSS
│   └── compare-v43-fidelity.mjs 还原度数值比对
└── deploy/tencent-guangzhou/    广州单容器部署定义
```

### 界面还原的三条硬约束

1. **CSS 必须按作用域拆分后放进各 SFC 的 `<style scoped>`**，不能扁平化成全局。
   同名类在不同组件里声明并不相同 —— `.his-header` 在工作站是 46px 高、
   候诊列表是 56px 高，扁平化会互相覆盖。
2. **`app-overrides.css` 必须全局引入**。V4.3 在所有 scoped 规则之后还有一层
   不带作用域的 `!important` 覆盖（表头白底、标题深色），漏掉它整个表头会走样。
3. **`--el-font-size-base: 12px`** 不是 Element Plus 默认的 14px。改回去所有间距和行高全部走样。
4. **动态状态要按原件的时序采集**。语音问诊浮层约 7 秒后随播放结束消失，抽取脚本等太久就会采到空状态 —— 一期就因此整块漏做过。

改动界面后跑 `node scripts/compare-v43-fidelity.mjs` 做数值回归（需先起 `npm run dev`）。

## 4.1 标志与分享卡片

标志方案 **F1「气泡里的听诊器」**：对话气泡是这个产品「落地即对话」的前提，
听诊器是临床，两件事合成一个形，且避开了满大街的医疗十字。

**唯一定义源是 `design/logo/logo.mjs`。** 改它，然后：

```sh
npm run logo    # 重新生成 apps/web/public/ 下的全部图标与分享图
```

`apps/web/public/` 下的 PNG 全是产物，**手改会在下次重跑时丢失**，
而且会和 SVG 悄悄不一致。

选型时试过六个方向，成图之后砍掉了四个（记在 `design/logo/png/全部候选对照.png`）：
「白大褂领口」读成了钥匙孔，「医字几何化」读成了字母 E，
「十字+心电波」的心电波在成图里根本看不见。**描述里成立不等于渲出来成立。**

### 分享卡片按路由变

`apps/api/app/seo.py` 在下发 index.html 时按路由替换 `<!--SEO:START-->`
到 `<!--SEO:END-->` 之间的整块，让 `/`、`/admin`、`/delivery` 各是一张卡片。

**必须在服务端做**：微信这类爬虫不执行 JavaScript，Vue 注入的 title/og 它们读不到。

两个容易踩的点：

- **`og:image` 给方图不给横图。** 微信把卡片图裁成正方形，1200×630 会被拦腰切掉。
  横版 `og-cover.png` 留给别的平台，不进 og:image。
- **标记被删不会报错**，只会退化成所有页面共用一张卡片。所以除了单测，
  部署脚本还会实打实地比对线上 `/` 与 `/admin` 的 `<title>` 是否不同。

能保证的是「按规范把该给的都给全」；**不能保证微信一定照着显示** ——
那需要公众号 + JS-SDK 签名，这套凭据项目里没有。

## 4.2 设计资产

Figma：**AI 门诊工作站 · 一期设计系统**
`https://www.figma.com/design/c79Yrkq4MOgwjN3dulIvO7`

| 页面 | 内容 |
| --- | --- |
| 00 · 设计令牌 | 23 个颜色令牌 + 13 个尺寸/字号令牌，均为 Figma Variables |
| 01 · 组件库 | 待建 |
| 02 · 页面骨架 | 待建 |
| 04 · 移动端 | 六屏 390×844：对话 / ＋菜单 / 分析 / 记录 / 候诊 / 患者管理 |
| 05 · 控制台移动端 | 五屏 390×844：配置 / 岗位切换 / 回归集·数据集管理 / 回归集·结果 / 运行日志 |
| 06 · 桌面端问诊流程 | 四态 1600×1000：进入 / 问诊中 / 问诊结束 / 跳过确认 + 状态机 |
| 07 · CI/CD 平台 | 桌面四屏 1600×1050 + 移动三屏 390×844。规格见 `docs/product/16-交付平台-CICD需求规格说明书.md`，**尚未实现，待评审** |

令牌取值**全部来自 V4.3 编译产物**（`scripts/extract-v43-assets.mjs`），不是取色器估的。
其中 `字号/base = 12` 标了重点：那是 `--el-font-size-base`，不是 Element Plus 默认的 14px。

**Figma 的定位是「设计语言的沉淀」，不是 V4.3 的像素级重绘。** 原件就在仓库里，
`npm run fidelity` 已经逐元素比对到零差异，再画一遍只会引入偏差。Figma 的价值在
后续新增界面 —— 一期是复刻已有设计，二期开始才是设计新界面。

注意：当前 Figma 席位是 `View`（student 层级）。建文件与写入实测可用，
但如需多人协作编辑可能要升级席位。

## 5. 安全红线

零容忍门禁，任一不为 0 即阻断发布：伪造事实、未确认写回、红色风险漏报、越权、非法 Schema。

其余硬性约束：

- `AI_API_KEY` 不进 Git、不进日志、不下发前端、不出现在健康接口。
- 一期只用虚构病例；健康接口声明 `data_classification: MOCK_ONLY_NO_REAL_PATIENT_DATA`。
- 医嘱、转诊、住院、病历一律写本地库并留审计，不触达真实 HIS。
- 红色风险未逐条处置时，阻断病历提交与诊断回写。
- **本次就诊未生成 AI 分析时，同样阻断**（风险未经评估）。暂存不受此门禁。
- V4.3 原件与 `design/current/` 下原件不可修改。

## 6. 已知的运行特性

- **首屏不再等分析**：一进来只拉硬规则红线与就诊状态（毫秒级）。
  `report-summary` 那 18–20 秒的四岗位并发挪到问诊结束（或跳过）之后，
  藏在医生说话的时间里。结果按「患者 + 上下文哈希」缓存，复访 3.7ms。
- **降级是正常路径**：网关抖动时岗位降级为确定性本地规则，界面显式标注，
  不返回伪造的成功文案。降级结果不入缓存。
- 模型网关偶发 502。重试窗口已从 2 秒放宽到约 6 秒（4 次，退避 500/1500/4000ms）。
- **Sonnet 5 上 `temperature` 已废弃，压不住抖动。** 同一份上下文两次生成的病历
  会有措辞差异；复核时先想到这一条。确定性的事实（既往史、硬规则风险）
  一律由代码兜底，不交给模型 —— 见 `agents/record.py` 的 `_archived_history`。
- **换 Sonnet 后的耗时**：`report-summary` 19.5s → 63.2s；还原度门禁 252s → 479s；
  编排层 Master 一次 126s。凡是有超时的地方都要按这个量级重新看一遍
  （已修：Nginx 三条 location、Playwright 的遮罩等待）。

## 7. 当前待决策事项

1. AgentScope 的调用协议、鉴权、超时、重试、流式输出和审计机制。
2. Skills、MCP 与临床数据源清单及最小权限。
3. Worker、智能体岗位与 Sub-agent 的定义和运行边界（待讨论）。
4. **专科口径冲突**：V4.3 患者是内分泌／心内／神内，既有文档写的是内科／骨科／妇科。
   一期以 V4.3 为准，产品文档是否同步修订待确认。
5. ~~金标准病例、评测集结构、准确性指标~~ —— 已落地第一步：评测数据集可管理，
   首个规范倒推数据集接入（见 `11-Agent控制台需求规格说明书.md` §3.5–3.6）。
   下一步是用 Synthea 造中文虚构病例扩量。
6. 33 项专项评估的颗粒度与 Agent 化路径（一期只做目录展示）。
7. 负责人、项目节奏、环境和发布路径。

## 8. 上线状态

已全部完成，历史步骤见 [`deploy/tencent-guangzhou/GO-LIVE.md`](deploy/tencent-guangzhou/GO-LIVE.md)。

- [x] `da` A 记录 → `81.71.155.220`（DNSPod，TTL 600）
- [x] Nginx 站点，两个 SSE 端点 `proxy_buffering off`（certbot 重写后已复查仍在）
- [x] Certbot 独立证书，至 2026-11-29，续期演练通过
- [x] 公网逐功能验收
- [x] 2026-09-01 移动端发布并公网复验：390×844 零元素溢出、零控制台报错，
      对话往返 2.3s，三个面板零可点写入动作；桌面 1600px 仍是 `.workstation-page`
      且「提交病历」在位；同机 aits/site/nginx 全部 200
- [x] 2026-09-01 撤下 AI 处置单（`57b0ffa`）后重新发布并公网复验：`release=0.3.0-mvp`、
      `ai=configured`、6 个岗位、`runtime_mode=live`；五个入口全 200；
      **`/api/emr/assessment-catalog` 与 `/api/emr/knowledge` 均 200** —— 健康接口不读这两个
      JSON，是坑之四的专项复查；线上目录 33 项、默认展开 0 项，与本次产品决策一致；
      两条 SSE 都是真流式（病历生成 104 块、中位间隔 8.9ms，对齐 12ms 节流；
      对话 18 块、中位间隔 291ms 为模型实时吐字）；同机 aits(3100)/site(3200) 均 200、
      nginx active、`proxy_buffering off` 仍在第 28 行；证书至 2026-11-29（剩 88 天）
- [x] 2026-09-02 AgentScope 编排层（Master–Worker–Skill 四层）发布并公网复验：
      `/api/orchestration/topology` 200、六个 worker 全部装配、`claude-sonnet-5`；
      `POST /workers/risk/run` 200 · 57.1s；`POST /ask` 200 · 125.9s；
      同机 aits/site 未受影响
- [x] 2026-09-02 **补 Nginx `/api/orchestration/` 的 `proxy_read_timeout 320s`**。
      这条路径原先继承 `location /` 的 60s，编排层调用一律 504 ——
      应用侧 `CALL_TIMEOUT_S=300` 根本没机会生效。给 320s 是为了让应用先超时，
      使用者才能拿到「编排超过 300 秒未完成，已中止」而不是 Nginx 的空白 504。
      **换 Sonnet 5 的延迟代价第一次露头**：Haiku 时代所有调用都在 60s 内，
      这个缺口一直在，只是没被触发过。
      服务器上原配置已备份为 `…/da.aaronhealth.cn.bak-20260902`
- [x] 2026-09-02 **产品路径的模型其实一直没换**。`/topology` 报 Sonnet 就以为换完了，
      漏了 `/api/emr/*` —— 服务器 env 的 `AI_FAST_MODEL` 压着 Haiku，优先级高于代码缺省。
      已改为 `claude-sonnet-5`，`AI_TIMEOUT_MS` 45s → 90s。
      复验 `aiModels.fast=claude-sonnet-5`、`degraded_agents` 为空
- [x] 2026-09-02 **换 Sonnet 把病历岗位从 10/10 打到 3~5/10**，已修回 10/10（连跑四次）。
      提示词一直缺「每段的资料来源」这一半，被 Haiku 的习惯盖住了；
      既往史改由代码兜底回填。详见 `15-Agent架构重构…md` §13
- [x] 2026-09-02 交付平台上线：`/delivery` + `/api/delivery/*`，
      门禁与部署脚本上报，控制台回归自动落智能体线
- [x] 2026-09-02 Nginx 再补两条 location 的 320s 读超时：`/api/orchestration/`、
      `/api/admin/`（控制台的试运行、并排对比、回归集都是模型调用）
- [ ] 模型配额是否需要与 Ticket System 分开计（两者共用同一个网关和同一把 key）

备案不阻塞：`aaronhealth.cn` 已备案（`粤ICP备2026119734号`，主体乐颖，服务器
`81.71.155.220`），`da` 作为子域名沿用主域名备案。

### 续期须知（11 月会再遇到）

**Let's Encrypt 签发本域名有概率失败，重试即可，不要改配置。** 首签连挫三次才成：

| 次 | 报错 | 实质 |
| --- | --- | --- |
| 1 | `query timed out looking up CAA` | 查 CAA 超时 |
| 2 | `During secondary validation: ... timed out looking up A/AAAA` | 多地校验的境外节点超时 |
| 3 | `DNSSEC: DNSKEY Missing ... for cn. [exceeded the maximum number of sends]` | 连 `cn.` 顶级域的 DNSKEY 都拉不到 |
| 4 | 成功 | —— |

根因：`aaronhealth.cn` 用 DNSPod **免费版**，NS 是 `pisces/normal.dnspod.net`，
**全球 Anycast 是付费功能**，境外只能跨国际链路回中国。LE 自 2020 年起强制多地校验，
校验节点全在境外，撞上丢包就失败。境内查这两台 NS 是 48/48 零丢包 —— **在服务器上
`dig` 得出的结论不适用于 LE**，跟宿主机 curl 测模型网关是同一类陷阱。

排查时别被报错文字带偏：三次错误各不相同，且第三次指向 `cn.` 而非本域名，看着像
DNSSEC 配置问题，实际全是同一条链路在丢包。

注意 LE 限流：**每域名每小时 5 次失败验证**，用完锁一小时。所以不要循环重试；
失败后先探测再决定。零成本探测（不消耗额度）：

```sh
curl -s -H 'accept: application/dns-json' \
  "https://dns.google/resolve?name=cn.&type=DNSKEY&do=1" | grep -o '"Status":[0-9]*'
```

续期是 `certbot.timer` 自动跑的，且到期前 30 天就开始每天试两次，
正常情况下会自己成功，不必人工干预。

已完成，不必重做：

- 广州服务器到 `www.meatdc.com` 的出网已实测可达（**必须在容器内测**，
  宿主机 `curl` 会被 TLS reset，那是指纹问题不是路由问题）。
- 镜像已在广州环境构建成功（本机仍未装 Docker CLI）。

## 9. Git 与远程

- 默认分支 `main`，开发分支 `feat/v43-rebuild`。
- 远程为私有仓库 `aaronle/doctor-agent`，走 HTTPS（`gh` CLI 已登录）。
  注意 SSH 方式当前不可用（`Permission denied (publickey)`）。
- 密钥、真实患者数据、生产导出、访问令牌和运行时环境文件不得提交 Git。

## 10. 项目级 Skill

- `.agents/skills/grill-me/`：来源为 `mattpocock/skills`，仅显式调用的 `$grill-me` 入口。
- `.agents/skills/grilling/`：同源的主实现，由 `$grill-me` 转交调用。
- 本次安装对应的上游修订为 `6654f6b60cd9d5be8b54c6fafe44346dabeb3b76`。
