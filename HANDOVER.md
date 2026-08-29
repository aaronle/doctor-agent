# Doctor Agent 项目交接手册

更新时间：2026-08-29（Asia/Shanghai）
项目目录：`/Users/leying/Documents/北大医疗/AI Native Systems/projects/doctor-agent`
远程仓库：`https://github.com/aaronle/doctor-agent`（**私有**）
项目状态：一期七功能已按 V4.3 界面基准实现完毕，六个岗位接真实 Claude Haiku；尚未发布到 `da.aaronhealth.cn`

本文件是 Doctor Agent 项目的当前接手入口。

## 1. 接手顺序

1. 阅读本文件。
2. 阅读 [`docs/product/10-V4.3反向需求规格说明书.md`](docs/product/10-V4.3反向需求规格说明书.md)
   —— **从 V4.3 逐屏倒推的完整需求书**，覆盖五个页面、八个标签页、对话框清单、
   数据契约、功能增强清单与遗留缺口。每条都标了【原件】/【增强】/【缺口】。
   从下一次开始，流程按「需求 Markdown → UI/UX → 测试用例 → 编码 → 测试 → 部署」
   正向走，这份文档是起点。
3. 阅读 [`docs/product/09-一期需求规划说明书.md`](docs/product/09-一期需求规划说明书.md) —— 一期的执行契约。
4. 阅读 [`docs/product/08-V4.3界面基准与后端API契约.md`](docs/product/08-V4.3界面基准与后端API契约.md) —— 界面与 API 的唯一事实源。
5. 根据任务所属条线阅读对应详细 Markdown。

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
AI_FAST_MODEL=claude-haiku-4-5-20251001
AI_TEST_MODE=          # 置为 rules 时全部岗位走本地规则，不调模型
```

发布门禁 —— 一条命令跑完测试、构建、契约导出与还原度比对：

```sh
npm run verify
```

跑 `verify` 前要先起 `npm run dev`（还原度比对需要访问运行中的前端）。

其他常用命令：

```sh
npm run fidelity   # 只跑还原度比对
npm run extract    # 重跑全部 V4.3 抽取（静态资源 + 渲染态 DOM + CSS 拆分）
```

## 2.1 改动纪律（重要）

界面、规格、测试三者必须在**同一个提交**里保持一致，不允许脱节：

| 改了什么 | 必须同步改 |
| --- | --- |
| UI/UX | `docs/product/09-一期需求规划说明书.md` 对应功能段 + 该行为的测试 + 跑 `npm run fidelity` |
| API 形状 | `docs/product/08-V4.3界面基准与后端API契约.md` + `apps/api/tests/test_api.py` + 重跑 `contracts:export` |
| Agent 输出结构 | 规格里该岗位的输出约束 + 对应校验测试 |
| 安全红线 | 规格第 7 节 + 一条能失败的测试（红线没有测试等于没有红线） |

判断标准很简单：**如果一个人只读规格 Markdown 就能预期到界面的样子和行为，规格就是同步的。**

## 3. 一期范围与实现状态

七个产品功能全部实现，六个岗位全部接真实 Haiku：

| 功能 | 岗位 | 状态 |
| --- | --- | --- |
| 语音问诊 | `voice` | 对齐 V4.3：点一下自动播放对话脚本，播放中浮出「AI 追问提示」与「补充观察」。脚本是演示数据，清单与观察项是真实模型输出 |
| 病情概况 | `summary` | 真实模型。矛盾信息并列不合并，不以治疗建议收尾 |
| 病历生成 | `record` | 真实模型。七段 SSE 流式；未提及不写「否认」，不编造查体 |
| 鉴别诊断 | `diagnosis` | 真实模型。支持/反对/缺失三类证据，无反对证据写「未获得」 |
| 诊断管理 | `diagnosis` | 勾选、主诊断标记、回写门禁 |
| 风险管理 | `risk` | 硬规则纯代码实现，独立于模型；模型不得压低硬规则判定的红色风险 |
| 共病管理 | `comorbidity` | 真实模型。推荐科室取自闭集字典；营养提醒为纯阈值规则 |

明确不做：AgentScope 接入、医院 SSO、真实 HIS 写回、真实患者数据。

## 4. 技术栈与目录

```text
doctor-agent/
├── apps/
│   ├── web/            Vue 3 + Element Plus + Pinia，五路由六组件
│   └── api/            FastAPI + SQLAlchemy + SQLite
│       └── app/
│           ├── agents/     六个岗位 + 上下文装配 + 提示词分层
│           ├── routers/    his / emr / config
│           ├── llm.py      OpenAI 兼容网关客户端
│           └── cache.py    聚合结果缓存
├── references/ui-demo/
│   ├── AI-HIS门诊模块V4.3.html   不可修改的原件（MD5 df95a09b…）
│   └── extracted/               全部抽取产物，脚本可复现
├── scripts/
│   ├── extract-v43-assets.mjs   静态抽取：CSS / 令牌 / fixture
│   ├── extract-v43-dom.mjs      动态抽取：20 个界面状态的渲染 DOM
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

## 4.1 设计资产

Figma：**AI 门诊工作站 · 一期设计系统**
`https://www.figma.com/design/c79Yrkq4MOgwjN3dulIvO7`

| 页面 | 内容 |
| --- | --- |
| 00 · 设计令牌 | 23 个颜色令牌 + 13 个尺寸/字号令牌，均为 Figma Variables |
| 01 · 组件库 | 待建 |
| 02 · 页面骨架 | 待建 |

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
- V4.3 原件与 `design/current/` 下原件不可修改。

## 6. 已知的运行特性

- **首屏约 18–20 秒**：`report-summary` 并发跑四个岗位，受生成速度限制。
  结果按「患者 + 上下文哈希」缓存，复访 3.7ms；数据一变自动失效。
- **降级是正常路径**：网关抖动时岗位降级为确定性本地规则，界面显式标注，
  不返回伪造的成功文案。降级结果不入缓存。
- 模型网关偶发 502。重试窗口已从 2 秒放宽到约 6 秒（4 次，退避 500/1500/4000ms）。

## 7. 当前待决策事项

1. AgentScope 的调用协议、鉴权、超时、重试、流式输出和审计机制。
2. Skills、MCP 与临床数据源清单及最小权限。
3. Worker、智能体岗位与 Sub-agent 的定义和运行边界（待讨论）。
4. **专科口径冲突**：V4.3 患者是内分泌／心内／神内，既有文档写的是内科／骨科／妇科。
   一期以 V4.3 为准，产品文档是否同步修订待确认。
5. 金标准病例、评测集结构、准确性指标。
6. 33 项专项评估的颗粒度与 Agent 化路径（一期只做目录展示）。
7. 负责人、项目节奏、环境和发布路径。

## 8. 发布前必办

- [ ] `da.aaronhealth.cn` 的 DNSPod A 记录指向 `81.71.155.220`（**尚未创建**）
- [ ] 广州服务器到 `www.meatdc.com` 的出网连通性实测
- [ ] 本机未装 Docker CLI，镜像构建须在广州候选环境验证
- [ ] 模型配额是否需要与 Ticket System 分开计

## 9. Git 与远程

- 默认分支 `main`，开发分支 `feat/v43-rebuild`。
- 远程为私有仓库 `aaronle/doctor-agent`，走 HTTPS（`gh` CLI 已登录）。
  注意 SSH 方式当前不可用（`Permission denied (publickey)`）。
- 密钥、真实患者数据、生产导出、访问令牌和运行时环境文件不得提交 Git。

## 10. 项目级 Skill

- `.agents/skills/grill-me/`：来源为 `mattpocock/skills`，仅显式调用的 `$grill-me` 入口。
- `.agents/skills/grilling/`：同源的主实现，由 `$grill-me` 转交调用。
- 本次安装对应的上游修订为 `6654f6b60cd9d5be8b54c6fafe44346dabeb3b76`。
