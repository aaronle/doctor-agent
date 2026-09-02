# Agent 架构重构：Master / Worker / Skill / Tool

2026-09-02。把一期六个岗位从「六个手写的 Agent 类」重构成
**声明式的 Master–Worker–Skill 四层**，跑在 AgentScope 上。

参考实现：`reference/patient-full-stack/patient-agents`（AgentScope 1.x，
Router + 7 个 Skill 子 Agent）。**skill 的格式与它完全一致**，两边可以互相搬运。

---

## 1. 四层是什么

```
Master Agent  ── 医生本人。有人格、记忆、执业规则；决定叫谁、要不要采纳
   └── Worker ── 一期的六个岗位。一份通用工厂组装，代码里没有 if/elif
          └── Skill ── SKILL.md，正文即 system prompt
                 └── Tool ── 临床工具（一期是进程内函数，将来是 MCP）
```

| 层 | 落在哪 | 加一个要改什么 |
| --- | --- | --- |
| Master | `agent_configs/doctor.yaml` + `prompts/doctor-persona.md` | —— |
| Worker | `agent_configs/<name>.yaml` | 加一个 YAML |
| Skill | `skills/<name>/SKILL.md` | 加一份 markdown |
| Tool | `app/orchestration/tools.py` | 加一个函数并注册 |

**加 worker 或 skill 都不需要改 Python。** 改到了 `worker_factory.py` 就说明抽象错了。

## 2. Master 不是路由器

参考实现里那一层叫 router，只做意图分发。这里它是**这位医生**：

1. **有记忆。** `InMemoryMemory` 按 session 保留，记得这一场就诊里已经让谁做过什么。
2. **有规则。** `doctor-persona.md` 写的是执业口径（先看危急值、没问诊不下结论、
   冲突要当场处理），不是分发规则。
3. **有取舍。** worker 的回答对他是**建议**。prompt 明确要求他在冲突时作判断，
   而不是把两种说法并列丢回去。

实测（P001，三个 worker，103.8s）它是这么用的：

> 「ST-T 改变…硬规则未触发危急值，**但我不认为可以按低优先级处理**。」
> 「既往病历写『偶服』，但医嘱记录是规律频次 —— 这两者矛盾，本次问诊没做，
> **我不会替患者认领『依从性差』这个结论**。」

这两句就是「医生」与「路由器」的差别。

### 为什么 worker 包成工具而不是写死流水线

医生看诊不是固定流程：同一个主诉，有人先问诊再看检验，有人先看危急值再决定问什么。
把 worker 做成可调用的工具、由 Master 决定叫谁，比写死顺序更贴近真实。

但**顺序建议**仍写进 prompt（`doctor.yaml` 的 `workflow`），
避免它每次从头摸索 —— 建议不是死规矩，prompt 里也这么说了。

## 3. 一份工厂，六个 worker

`worker_factory.build_worker(profile, manifests, patient_id)` 是唯一的组装入口。

system prompt 的拼装顺序（**顺序即优先级**）：

```
[平台安全层]              ← 不可编辑，随代码发布
[Worker 自身 prompt]      ← agent_configs/<name>.yaml
[各 skill 的 SKILL.md 正文] ← 按 skills 声明顺序
[系统信息：日期、就诊人]
```

安全层排最前，后面的内容不得覆盖它的红线。有测试盯着这个顺序
（`test_safety_layer_comes_first_and_is_not_editable`）—— 它一旦坏了，
「不得自行确诊」「未问诊不写否认」就成了摆设。

## 4. 工具层：一期没有真实 HIS

`app/orchestration/tools.py` 注册 11 个工具，每个 docstring 都标了数据来源：

| 标记 | 含义 | 例 |
| --- | --- | --- |
| 【真实】 | 本地 SQLite + 种子档案（虚构病例，结构与真实 HIS 一致） | `get_patient`、`get_lab_results` |
| 【规则】 | 纯代码判定，不调模型 | `run_hard_rule_risk_scan` |
| 【Mock】 | 暂无接口，闭集字典兜住 | `search_department` |

### 三条硬约束

1. **只读，不写。** 一期不给 Agent 自主写入的能力 —— Agent 能改病历 = 未确认写回，
   那是零容忍红线。有测试按**动词前缀**盯着注册表
   （`get_/search_/run_` 是读，`create_/submit_/write_` 一律不许出现）。
   > 按子串判会把 `get_current_orders` 这类读工具误伤，然后有人为了让测试过而放宽它 ——
   > 那时这条测试就废了。
2. **返回结构化数据，不返回自然语言。** 措辞是 skill 的事，工具只负责事实。
3. **查不到就说查不到。** 返回 `{"found": false, "reason": ...}` 而不是空壳，
   让模型能区分「没有这项检查」和「这项检查全正常」。

### `tools` 与 `mcp-tools` 为什么都留着

一期的工具是进程内 Python 函数。等 HIS 的 MCP server 就位，
同名工具从 SKILL.md 的 `tools` 迁到 `mcp-tools` 即可，**正文一个字不用改**。
现在就把两个字段都认下来，是为了那次迁移不必改加载器。

## 5. 与既有 `/api/emr/*` 并存，不替换

| 路径 | 定位 | 门禁 |
| --- | --- | --- |
| `/api/emr/*` | 产品路径，形状由 V4.3 界面倒推 | 还原度 + 类名覆盖率 |
| `/api/orchestration/*` | Agent 路径，形状由 AgentScope 决定 | 单元测试 |

一次性把产品路径切过来，等于同时改「界面契约」和「Agent 架构」两件事，
出问题时分不清是谁的锅。先并存，等编排层在真实使用中站住了再谈迁移。

### 契约

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/orchestration/topology` | 四层装配。CI/CD 平台「智能体」侧的数据源 |
| POST | `/api/orchestration/ask` | 问主诊医生。`workers` 可限定只装哪几个 |
| POST | `/api/orchestration/workers/{name}/run` | 单独跑一个 worker，绕过 Master |

**`/ask` 不做流式**：Master 的价值在于对多个 worker 结果的取舍，
那个判断只有在全部 worker 回来之后才成立。中途吐字会让使用者看到
尚未被取舍的中间结论，那比等一会儿更糟。

**校验顺序**：先判请求本身（worker 名、就诊人），再判服务可用性。
worker 名字打错返回 404 比 503 有用 —— 后者会让人以为是模型挂了，去查错方向。

## 6. 模型换到 Sonnet 5

一期六个岗位与编排层统一用 `claude-sonnet-5`（网关上最高的 Sonnet）。

**为什么换**：这些岗位做的是「读证据 → 下结论 → 标依据」，Haiku 在这类任务上
更早停手、更容易漏掉该查的工具，产出常是「血糖控制不佳」这种没有数值的空话。
换了之后同一个病例的风险评估从「四条空话」变成带数值、阈值、可执行建议与来源标注。
临床上「少查一次」的代价高于多花的那几秒。

档位抽象（`clinical_fast` / `clinical_reasoning` / `clinical_safety`）**保留**：
三个当前都落到同一个模型，但它让「换模型」是改一处映射的事，
而不是去六个岗位配置里逐个改 model ID。

### 换模型挖出三个真 bug

`llm.py` 原本写的是：

```python
if "haiku" in model:
    body["temperature"] = 0
```

**把模型名当成了判据。** 换到 Sonnet 后这个分支再也不触发，温度悄悄变成网关默认值 ——
同一份上下文两次生成的病历会不一样，临床上无法复核。

判据应该是模型的真实属性，而不是它叫什么。

**② 改成「无条件固定为 0」之后，三个岗位直接挂了。**

`claude-sonnet-5` **已废弃 `temperature`**，带上就是 400：
`temperature is deprecated for this model`。risk / diagnosis / comorbidity
三个岗位同时降级到本地规则。

正确的判据是**这个模型收不收 temperature**（`MODELS_WITHOUT_TEMPERATURE` 显式清单）。
代价要说清楚：这些模型上**无法固定温度**，可复现性依赖模型自身；
病历复核时若发现两次输出不一致，先想到这一条。

**③ 400 被重试了四次。**

`RETRYABLE_STATUS` 白名单写着「4xx 参数错误重试只会重复失败」，
但 `raise_for_status()` 抛的 `HTTPStatusError` 落进了下面的通用
`except httpx.HTTPError` —— 白名单被自己下面的处理器架空了。三个岗位各白等 8 秒。

而且错误只报了一句 `HTTPStatusError`，网关那句 `temperature is deprecated`
被丢掉了，只能手工二分才找到原因。现在不在白名单的 4xx **快速失败并带上网关原话**。

三条都补了测试。

## 7. 依赖

```
agentscope==1.0.20   # 锁 1.x：2.x 是破坏性重写（ReActAgent 被移除），
                     # 且 1.x 是参考项目在跑的版本，两边可互相搬 skill
mcp==1.27.1          # agentscope 1.0.20 依赖 streamablehttp_client；
                     # 新版 mcp 改名成 streamable_http_client，不锁会在 import 时崩
tqdm==4.67.1         # agentscope.evaluate 无条件 import 它，但自己没声明
python-frontmatter   # 解析 SKILL.md 的 frontmatter
PyYAML
```

**镜像必须 COPY `skills/` 与 `agent_configs/`**。少了它们服务能起来，
但 `/topology` 会 500，六个 worker 一个都装不出来 —— 与「坑之四」同一类问题：
健康接口检查不到的东西，要单独打一次。

## 8. 测试

| 用例 | 盯什么 |
| --- | --- |
| `test_topology_exposes_all_four_layers` | 四层装配齐全，Master 有 persona |
| `test_every_declared_tool_is_registered` | SKILL.md 打错工具名要在测试里炸 |
| `test_every_worker_skill_exists` | YAML 引用了不存在的 skill |
| `test_exactly_one_master` | 零个或两个 Master 都是配置事故 |
| `test_safety_layer_comes_first_and_is_not_editable` | 顺序即优先级 |
| `test_patient_placeholder_is_substituted` | 占位符没替换 = 工具查不到任何东西 |
| `test_tools_are_read_only` | 按动词前缀盯注册表，防有人加写工具 |
| `test_interview_tool_never_borrows_the_demo_script` | 不拿演示对话当本次问诊 |
| `test_department_tool_is_a_closed_set` | 推荐科室必须来自闭集 |
| `test_clinical_output_temperature_is_pinned_regardless_of_model` | 换模型不得让温度失守 |

## 9. 还没做的

- **MCP server**：工具还是进程内函数。等 HIS 接口就位再拆出去。
- **产品路径迁移**：`/api/emr/*` 仍走旧的六个 Agent 类，未切到编排层。
  **医生工作站上那七个功能，现在跑的全是旧类**；前端对 `/api/orchestration/*`
  是零调用。编排层是并存的、能跑的、但产品用不到的第二套实现。
  并存的理由见 §5，但代价现在具体化了 —— 见下。
- **流式**：`/ask` 是一次性返回，见 §5 的理由。
- **Master 的长期记忆**：现在是 `InMemoryMemory`，进程重启即失忆。
  跨就诊的医生偏好（这位医生习惯先问什么）需要落库，属于二期。


## 10. 门禁脚本的等待判据（2026-09-02 修）

原来三处 `page.goto(..., { waitUntil: 'networkidle' })`。

解锁过的就诊一进场就会拉 `report-summary`，Sonnet 5 下要跑一分钟以上 ——
**网络永远闲不下来，30 秒必然超时**。`networkidle` 的前提是「加载完请求就停」，
这个页面根本不满足。

改成 `domcontentloaded` + 等真正要比的元素出现：判据从「网络安静了」换成
「我要比的东西在场了」，那才是这一步真正在等的东西。

## 11. 上线复验：编排层被 Nginx 的 60 秒切断（2026-09-02）

镜像跑起来了、`/topology` 200，但 `/api/orchestration/*` 全部 504。

`CALL_TIMEOUT_S` 写的是 300 秒，可那是**应用侧**的上限。这条路径在 Nginx 上
没有自己的 location 块，继承 `location /` 的 `proxy_read_timeout 60s`。
单个 worker 实测 57 秒（擦边过），Master 串六个 worker 126 秒（必死）。

**这是换 Sonnet 5 的延迟代价第一次露头。** Haiku 时代所有调用都在 60 秒内，
这个缺口一直存在但从来没被触发过 —— 换模型不只是改一处映射，
还会把原先藏在余量里的配置问题顶出来。

补了 `/api/orchestration/` 的 location，给 320s：**应用的 300s 先到**，
使用者拿到的是「编排超过 300 秒未完成，已中止」，而不是 Nginx 那页不解释任何事的
504 HTML。谁知道得多，谁先超时。

复验（公网）：

| 路径 | 结果 |
| --- | --- |
| `POST /workers/risk/run` | 200 · 57.1s · 硬规则未命中与模型判定分开写，每条标了来源 |
| `POST /ask` | 200 · 125.9s · 六个 worker 全部装配 |

`/ask` 那次的输出值得记一笔 —— Master 主动压住了流程：

> 「问诊补完后再叫病情概要和鉴别诊断，现在信息还不完整，不着急出结论。」
> 「目前对话完全没问胸闷、胸痛、活动后气促，**不能带着「否认」两字写病历**。」

第二句是安全层第 4 条（未问诊不写否认）在真实输出里生效，不是测试桩里生效。

## 12. 生产上其实还在跑 Haiku（2026-09-02）

上线复验只查了 `/api/orchestration/topology`，它报 `claude-sonnet-5`，于是判定
「换完了」。**漏了产品路径。**

`app/config.py` 的代码缺省确实改成了 Sonnet，但服务器
`/opt/doctor-agent/config/.env.runtime` 里压着 `AI_FAST_MODEL=claude-haiku-4-5-20251001`，
**env 优先级高于代码缺省**。编排层不读这个变量，所以它换了；产品路径六个岗位读，
所以它们没换。

`/api/health` 的 `aiModels.fast` 一直如实报着 `haiku`。信息一直在，只是没人去看。

已改为 Sonnet 并同步把 `AI_TIMEOUT_MS` 从 45s 提到 90s（Sonnet 更慢，45s 会让岗位
擦边超时后降级为本地规则）。复验：`aiModels.fast=claude-sonnet-5`，
`report-summary` 从 19.5s 变成 63.2s，`_meta.degraded_agents` 为空。

> **换模型要同时改两处，并以 `/api/health` 的实际回值为准。**
> 这正是交付平台「生产指纹」那一栏存在的理由 —— 把「一直报着但没人看」
> 变成「一眼看见」。

## 13. 换模型把病历岗位从 10/10 打到 3/10

产品路径换到 Sonnet 后，在生产上跑了一次病历岗位的回归集：**5/10**。
本地同一套用例、同一个网关做 A/B：

| 模型 | 通过 |
| --- | --- |
| `claude-haiku-4-5-20251001` | 10 / 10 |
| `claude-sonnet-5` | 3 ~ 5 / 10（temperature 已废弃，压不住抖动） |

两类失败：

1. **既往史写「未采集」**（5–6 条）。主档明明写着「2型糖尿病 5 年」。
2. **写了未经问诊的否认**（2–3 条），以及没有主语的「未见异常」。

### 不是 Sonnet 变差，是提示词一直缺一半

原提示词只有一句「上下文中没有提及的内容一律写「未采集」」，**从没说过每一段的
资料来源是什么**。Haiku 会顺手把主档既往史抄进去，所以一直是满分；Sonnet 较真
「本次问诊没问过既往史」，于是照规则填了「未采集」。

**它一直是错的，只是被上一个模型的习惯盖住了。** 换模型没有制造这个缺陷，
只是撤走了掩盖它的那层东西。

三处修改：

| 改动 | 位置 | 为什么 |
| --- | --- | --- |
| 逐段写明资料来源，既往史明确来自主档 | `agents/record.py` role_prompt | 判据要写在提示词里，不能指望模型替你补 |
| 「不写关于这份病历本身的话」 | 同上 | 模型把提示词里的元语言当内容吐了出来（真实输出：「否认表述均未采集」） |
| 主档有既往史时由代码兜底回填 | `agents/record.py` validate | 确定的事实不该交给概率。**只在模型整段留白时补**，它写了就不动 |

回填绝不产出「否认过敏史」：主档没记过敏就整句不写。那和模型编造否认是同一条红线。

### 顺带修了一条会误判的校验

`check_spec_no_blank_with_evidence` 原来是**整段找子串**：只要「未采集」三个字
出现过就算漏记。于是这样一段被判不合格：

> 高血压10年，血压控制差；2型糖尿病8年，规律服药；**过敏史未采集**。

主档既往史一字不落地记下来了，末尾如实交代过敏史没采集（主档 allergies 确实是空的，
此时写「否认过敏史」才是伪造）—— 完全正确的输出，被判成漏记。

改成**按小句判**：去掉「××未采集」这类交代性小句后，看这一段还剩不剩实质内容。

**这不是把闸放松。** 整段只写「未采集」照样失败，辅助检查有九项异常检验却留白照样失败，
两条都有测试钉着（`test_blank_section_with_evidence_still_fails`、
`test_auxiliary_exam_blank_with_labs_still_fails`）。改的是判据的粒度：
要判的是「这一段有没有记下该记的东西」，不是「这三个字有没有出现过」。

改完连跑四次：**10/10、10/10、10/10、10/10**。

## 14. 并存的代价：临床红线有两份拷贝

§5 决定「先并存、不替换」，理由是一次性切过去会同时改界面契约和 Agent 架构，
出问题分不清是谁的锅。那个理由现在仍然成立，但代价也已经真的发生了一次。

同一个岗位的同一份临床要求，物理上是两个文件：

| 跑在哪 | 提示词在哪 |
| --- | --- |
| 产品路径 `/api/emr/*`（**医生看到的就是这条**） | `app/agents/record.py` 的 `role_prompt` |
| 编排层 `/api/orchestration/*`（前端零调用） | `skills/record-generation/SKILL.md` |

§13 修病历岗位时，只改了前者。**SKILL.md 里同样的缺口原封不动留着** ——
修好的那条路没人走，将来切过去还是坏的。发现它纯属偶然：有人问「到底有没有
按 AgentScope 重构」，去翻代码才看见。

已给 SKILL.md 补齐，并加了一条测试盯着两份不许分家
（`test_record_rules_exist_in_both_copies_of_the_prompt`）。它**不比对措辞** ——
两边的读者不同，本来就该有差异 —— 只要求那几条红线在两份里都找得到。
做过变异验证：把 SKILL.md 里的「主档」换掉，测试确实红。

### 这条测试只是止血，不是治好

它盯得住「谁忘了改另一份」，盯不住「两份慢慢长歪」。真正的解法只有两个：

1. **切过去**，让 SKILL.md 成为唯一真相，删掉 `role_prompt`；
2. 或者**让旧类去读 SKILL.md**，先统一来源、再谈切换。

第 2 条成本低得多，且不动界面契约 —— 如果短期内不打算迁移产品路径，
应该先做它。什么时候迁移是产品决定，但**两份真相不该一直留着**。

## 15. 档位真正分开了（2026-09-02）

§6 说「档位抽象保留，三个当前都落到同一个模型」。那句话的下半句才是实情：
**三个名字、一个模型，抽象在，但没起任何作用。** 而且每个岗位都硬编码成
`clinical_fast`，连声明都没有。

现在每个档位一个环境变量，各自可配；岗位由 `Agent.model_tier` 自己声明。

| 档位 | 模型 | 岗位 | 依据 |
| --- | --- | --- | --- |
| `clinical_fast` | Haiku 4.5 | record | **实测**：两模型回归集都 10/10，45.8s → 5.0s |
| `clinical_reasoning` | Sonnet 5 | summary / diagnosis / comorbidity / voice | 无 A/B 数据，留在强的一侧 |
| `clinical_safety` | Sonnet 5 | risk | 无足够用例，且漏报有临床后果 |

### 先量再分，不是先分再后悔

原计划是「risk / comorbidity / voice 回 Haiku，record / diagnosis / summary 留
Sonnet」。实测把这个分配几乎推翻了：

| 岗位 | Haiku | Sonnet | 差 | 在 report-summary 里 |
| --- | ---: | ---: | ---: | --- |
| summary | 7.9s | 25.5s | +17.6s | ✔ 并发 |
| **record** | **5.0s** | **45.8s** | **+40.8s** | — |
| diagnosis | 16.2s | 38.2s | +22.0s | ✔ 并发 |
| **risk** | 11.9s | **52.2s** | **+40.3s** | ✔ 并发 |
| comorbidity | 12.1s | 31.1s | +19.0s | ✔ 并发 |
| voice | 5.4s | 7.3s | +1.9s | — |
| **report-summary** | **19.1s** | **61.1s** | +42.0s | ← 用户实际等的 |

三条推论：

1. **那 61 秒基本是 risk 一个岗位。** 四个是并发的，总耗时等于最慢的那个。
   只要 risk 留在 Sonnet，把 summary / diagnosis / comorbidity 换成 Haiku
   **一秒都省不下来**，却白担三份质量风险。
2. **record 是唯一「白捡」的**：省 40.8 秒，且质量有实测。它不在
   report-summary 里，省的是病历生成那条流式路径，医生直接感知。
3. **voice 只差 1.9 秒**，换不换都一样，不值得为此做一次没有数据的改动。

### 为什么 risk 没动

它是全部的 61 秒，换成快档收益最大。但它**只有 1 条回归用例** ——
1/1 对 0/1 什么都说明不了。而它同时是当初换 Sonnet 收益最明确的岗位
（从「四条没有数值的空话」变成带数值、阈值、可执行建议与来源标注），
也是漏报有临床后果的那个。

有一条测试专门钉着这件事（`test_risk_is_not_downgraded_while_it_only_has_one_eval_case`）。
补足用例之前，那条测试就是那个「不许」。

> 用例已于 2026-09-03 补足（7 条 / 47 条断言），那条测试连同它的前提一起重写了。
> 结论仍然是不动，但理由完全换了 —— 见 §16。

### 两个防静默降级的设计

- **未知档位回落到推理档，不是快档。** 档位名打错的后果应该是「慢一点」，
  而不是「某个临床岗位被悄悄降级」—— 后者没有任何人会立刻发现。
  `Agent.model_tier` 的缺省同理。
- **存草稿不带档位时沿用当前档位。** 原先 `DraftIn.model_tier` 默认
  `clinical_fast`：在控制台只改 Prompt、没碰档位，存一次就把岗位换成快档了。

### `AI_FAST_MODEL` 不再参与档位解析

它在生产 env 里是 sonnet。让它参与的话，档位拆分会被整体盖掉，而且不报错 ——
和 §12 那次「产品路径以为换了 Sonnet、实际一直跑 Haiku」是同一类事故。

它保留原义：给**不走档位**的调用用（Copilot 对话等）。
`/api/health` 现在同时报 `aiModels` 与 `modelTiers`，两者可以不同，且从这天起就是不同的。

---

## 16. 补 risk 用例，结论反而是「不换」（2026-09-03）

§15 欠着的那件事做完了：risk 从 1 条用例补到 **7 条 / 47 条断言**
（`app/data/eval_datasets/risk-safety-basic.json`）。补它的目的是给
「risk 能不能换回快档、把 61 秒压到 16 秒」一个分母。

结论是**不换**。但过程里翻了两次案，两次都是方法出的问题，不是模型。

### 第一次翻案：校验本身在误报

首轮 Haiku 6/8、4/8，Sonnet 8/8、7/8 —— 看着像「Haiku 会编数」。
逐条看失败原因，**全部**是 `依据里的数字必须来自上下文` 拦下了指南阈值：

| 被拦下的 | 实际是什么 |
| --- | --- |
| `血压控制评估：130；139` | `<130/80`、`<140/90` 血压目标 |
| `颈动脉粥样硬化伴狭窄：70` | `>70%` 重度狭窄标准 |

这些是临床知识，不是伪造患者数据。照那版数据下结论，会因为一个坏掉的仪器
把 risk 永久钉在慢档上，而且理由是假的。修法是 `_THRESHOLD_MARKERS` +
`_looks_like_threshold()`：数字前 10 个字符里有 `<` `≤` `目标` `参考` `指南`
之类标记就放行。

**误报比没有校验更糟** —— 这条本仓库已经写过一次（§13「顺带修了一条会误判的校验」），
这是第二次撞上。红了却不是真问题的校验，人会先学会忽略它，然后它就永远不起作用了。

### 提示词欠一句：不许自己算

修完仪器重测，Haiku 只剩一条不过：`LDL-C 2.8，参考<1.8，超标0.5倍` —— `0.5`
确实不在资料里，是模型自己算的。这不是编造化验值，但医生**没法一眼回溯**：
他得反推你拿哪两个数、怎么算的，而算错了和算对了外表一模一样。

改的是提示词不是校验（**不能因为结论不合意就放宽校验**）：
「evidence 里的每个数字只能是资料中原样出现的值或指南阈值；比较关系用文字表述」。
两个模型一视同仁。改完 Haiku 8/8、8/8，Sonnet 8/8、8/8，26.8s 对 115.2s —— 打平。

### 第二次翻案：我自己的 n=1

打平之后我把两边内容摆开人工看，发现 Haiku 在 P001 漏了
「双眼底照相：异常 · NPDR 轻度」而 Sonnet 写了，据此推翻了速度结论。

**把它写成用例一跑，结论反了**：Sonnet 连着两轮漏、Haiku 连着两轮没漏。
再跑三轮，两边各 3/5。那次人工比对每个模型只采了一个样本，采到的是抖动。

> 「摆开看一眼」和「跑成用例」不是一回事。前者能提出假设，不能下结论 ——
> 尤其在 `claude-sonnet-5` 弃用 `temperature`、本来就没法钉死随机性的前提下。

### 那次比对真正找到的东西：一个产品缺陷

眼底会不会被写进去，跟模型无关，跟措辞也基本无关（加了「阳性检查优先」的
取舍次序仍然是 2/3 会漏）。根子在算术：风险项限 2–4 条，而 P001 有
**7 项异常检验 + 2 项异常检查**，四个位置装不下九个异常，丢谁近乎随机。
影像/检查结论没有数值，天然比化验值「不显眼」，最容易被挤掉 ——
而对医生来说这是最坏的丢法：化验单他自己会看，眼底报告他指望你提醒。

`examinations[].abnormal` 是上下文里的一个布尔字段。**这压根不是判断题。**
于是加成硬规则第 4 条（`abnormal_examination`，中风险），和过敏冲突、危急值、
生命体征越界并列。确定的事情用确定的办法做，模型的 2–4 个位置腾出来
放它真正该做的事。校验也跟着改成查 `merge_risks(硬规则, 模型项)` ——
**查医生实际看到的那张表**，而不是模型输出的那一半。

### 加硬规则撞出来的两个陈年问题

一、`emr.py` 的提交红线判据是 `{a["id"] for a in hard}` —— 不看 level，
默认「硬规则出的都是红的」。这在当时成立（三条硬规则全是高风险），
但它把**巧合**当成了不变量。加一条中风险硬规则，提交立刻被拦，七个测试一起红，
而拦的是「心电图异常」这种该记录、不该阻断就诊的项。零容忍门禁一旦拦错，
医生下一步就是想办法绕过它，那时真正该拦的也拦不住。判据只能是 level，不能是来源。

二、`test_submit_is_blocked_by_open_red_alerts` 的前置是
`if not alerts: return` —— 而**没有任何种子病例命中红线硬规则**（§9 一直记着这个缺口），
所以它每次都在第一行退出。这条测试绿了几个月，一次都没执行过它的断言。
加了检查规则它才第一次真正往下走，然后连撞两个它从没满足过的前置条件
（分析未解锁、unlock 的 reason 不在白名单）。已改成按 level 判、显式解锁、
并断言 unlock 自身成功。

> 空过的测试比没有测试更危险：它在覆盖率和 CI 上都是绿的，
> 只有把它逼着执行一次才会露馅。

### 最终为什么还是不换

| | Haiku | Sonnet |
| --- | --- | --- |
| 47 条断言 | 打平 | 打平 |
| 中位耗时 | ~28s | ~128s |

用例覆盖到的部分打平了。但**打平只说明用例覆盖到的部分打平了**。
剩下那个差别是把散点合成一个临床判断（P004：血压 + 颈动脉斑块 + 头晕头痛
→ 一条脑血管事件风险，而不是三条并列），它没有用例，我也做不出用例。

安全岗在「有差别但测不出来」的不确定下取强的一侧。这不是保守，
是因为**这次已经证明了我的测量能力有多容易出错**：两次翻案，
一次是校验误报，一次是我自己拿 n=1 下结论。在这种测量精度下，
拿「用例打平」去换一个漏报有临床后果的岗位，赌注和把握不匹配。

守这个结论的是两条测试：`test_risk_stays_on_the_reasoning_side_because_content_beat_speed`
（结论）与 `test_risk_eval_set_still_covers_the_two_blind_spots`（依据）。
第二条是必要的 —— 只钉结论的话，谁把用例删了断言照样绿，
结论就退化成一句无法查证的口头传统。
