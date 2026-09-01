# Doctor Agent 广州 MVP 部署

## 目标架构

`da.aaronhealth.cn` 由宿主机 Nginx 终止 HTTPS，反向代理到只监听回环地址的
`doctor-agent-mvp` 单容器。容器同时提供 Vue 构建产物、FastAPI 产品 API、
六个接真实 Claude Haiku 的智能体，以及 SQLite 持久化。

```text
公网 443 -> 宿主机 Nginx -> 127.0.0.1:3400 -> doctor-agent-mvp:8000
                                                -> /app/data/doctor-agent.db
                                                -> https://www.meatdc.com/v1（模型网关，出网）
```

本 MVP 不运行 AgentScope、本地大模型、PostgreSQL、Redis、向量数据库或
Langfuse，且不允许使用真实患者数据。

## 服务器目录

```text
/opt/doctor-agent/
├── source/
├── config/.env.runtime
└── data/doctor-agent.db
```

`.env.runtime` 以 `env.runtime.example` 为模板，权限必须为 `600`，其中包含
`AI_API_KEY`。该文件不进 Git、不进日志、不下发前端、不出现在健康接口。

## 部署前必读：这台机器的四个坑

实测踩到，写下来避免重犯。

**1. Docker Hub 拉不动，用腾讯云内网镜像源**

`registry-1.docker.io` 超时。可用源是 `mirror.ccs.tencentyun.com`（同机既有镜像
就是从它拉的）。基础镜像先拉再打标签：

```sh
docker pull mirror.ccs.tencentyun.com/library/python:3.12-slim
docker tag  mirror.ccs.tencentyun.com/library/python:3.12-slim python:3.12-slim
docker pull mirror.ccs.tencentyun.com/library/node:22-bookworm-slim
docker tag  mirror.ccs.tencentyun.com/library/node:22-bookworm-slim node:22-bookworm-slim
```

pypi 与 npm registry 都直连可达，构建期不用换源。

**2. 宿主机 curl 访问模型网关会被 TLS reset，但容器内正常**

```sh
curl https://www.meatdc.com/v1/models          # 宿主机：Connection reset by peer
docker run --rm python:3.12-slim python -c ... # 容器内：HTTP 401，269ms
```

差别在 TLS 客户端指纹，不在网络路由。**用宿主机 curl 判断出网会得出错误结论** ——
必须用真实技术栈（容器 + httpx）验证。同机 aits-app 用的是同一个网关。

**3. `cap_drop: ALL` 与数据目录属主必须配套**

容器默认以 root 运行，平时靠 `CAP_DAC_OVERRIDE` 越权写入非自己所有的目录。
`cap_drop: ALL` 摘掉该能力后，root 反而写不进 `/opt/doctor-agent/data`，
SQLite 报 `unable to open database file`。

正解是让容器以数据目录属主的 uid 运行（compose 里的 `user: "1000:1000"`），
并把目录 chown 成同一 uid —— 比 chmod 777 或加回 CAP_DAC_OVERRIDE 都干净。

**4. `--exclude 'data'` 会连源码里的 `apps/api/app/data/` 一起排掉**

2026-09-01 发布移动端时实测踩到：本意是排掉运行时数据目录，但 rsync 的
`--exclude 'data'` 是**不锚定**的，任何层级的 `data` 目录都会命中，包括
源码里的 `apps/api/app/data/`（`assessment_catalog.json`、`knowledge_base.json`）。

第一段 rsync 把它排在了 `/tmp/da-src/` 之外，第二段
`sudo rsync -a --delete /tmp/da-src/ /opt/doctor-agent/source/` 没有任何 exclude，
于是把它从服务器源码树里删了。镜像重建后 `/api/emr/assessment-catalog` 返回 500：

```
FileNotFoundError: '/app/apps/api/app/data/assessment_catalog.json'
```

**排除模式一律加前导斜杠锚定到根**：

```sh
rsync -az --delete \
  --exclude '/.git' --exclude 'node_modules' --exclude '/.venv' \
  --exclude '/apps/web/dist' --exclude '/.env' --exclude '/data' \
  -e "ssh -i ~/.ssh/id_ed25519" ./ ubuntu@81.71.155.220:/tmp/da-src/
```

（`node_modules` 是有意不锚定的 —— 它在每个 workspace 下都有。）

持久化的 SQLite 在 `/opt/doctor-agent/data/`，**不在 `source/` 里**，
所以这次没被波及。但这正说明第二段 rsync 的 `--delete` 作用域必须只有
`source/`，绝不能指向 `/opt/doctor-agent/`。

发布后至少要打一次这两个读文件的端点，光看 `/api/health` 发现不了 ——
健康接口不读这两个 JSON：

```sh
curl -fsS -o /dev/null -w "catalog %{http_code}\n" http://127.0.0.1:3400/api/emr/assessment-catalog
curl -fsS -o /dev/null -w "kb      %{http_code}\n" http://127.0.0.1:3400/api/emr/knowledge
```

## 候选验证

```sh
docker compose -f deploy/tencent-guangzhou/docker-compose.yml build
docker compose -f deploy/tencent-guangzhou/docker-compose.yml up -d
curl -fsS http://127.0.0.1:3400/api/health
curl -fsSI http://127.0.0.1:3400/
```

健康接口必须返回：

| 字段 | 期望值 |
| --- | --- |
| `release` | `0.3.0-mvp` |
| `database` | `ready` |
| `ai` | `configured`（未配置密钥时为 `unconfigured`，全部岗位降级为本地规则） |
| `agents` | 6 个岗位 |
| `runtime_mode` | `live` |
| `data_classification` | `MOCK_ONLY_NO_REAL_PATIENT_DATA` |

再逐一验证七个功能：候诊列表 → 进入工作站 → 智慧诊疗聚合 → 预警评估处置 →
病历流式生成 → 诊断勾选与回写门禁 → 共病与营养会诊 → 语音问诊一轮。

## 出网依赖

容器需要访问模型网关 `https://www.meatdc.com/v1`。发布前先在服务器上实测：

```sh
curl -fsS -o /dev/null -w '%{http_code} %{time_total}s\n' https://www.meatdc.com/v1/models
```

不通则全部岗位会降级为本地规则 —— 界面仍可用且会显式标注降级，但不是预期状态。

## 域名和 HTTPS

**已完成**：`https://da.aaronhealth.cn` 于 2026-08-31 上线，证书至 2026-11-29。

当初的步骤，重建时照走：

1. 在 DNSPod 的 `aaronhealth.cn` 下新建 `da` → `81.71.155.220` A 记录（默认线路，TTL 600）。
   **需人工在控制台完成** —— 工作区与服务器上都没有 DNSPod API 凭据。
2. 将 `nginx-da.aaronhealth.cn.conf.example` 安装为宿主机 Nginx 站点。
3. 执行 `nginx -t` 后重载 Nginx。
4. 用 Certbot 为 `da.aaronhealth.cn` 签发独立证书。**可能要试几次**，原因见下。
5. 公网逐功能验收。

Nginx 需要为两个 SSE 端点关闭缓冲（`proxy_buffering off`），否则病历流式
生成与语音追问会积压到结束才一次性吐出。**certbot 会重写站点配置插入 443 块，
签完必须回查这一行还在不在。**

### 坑之四：Let's Encrypt 签发会随机失败，别改配置

首签连挫三次才成，三次报错互不相同（CAA 超时 → 多地校验 A/AAAA 超时 →
`cn.` 顶级域 DNSKEY 拉不到），看着像三个问题，其实是同一条链路在丢包：

本域名用 DNSPod **免费版**，全球 Anycast 是付费功能，境外查询要跨国际链路回中国；
而 LE 强制多地校验，校验节点全在境外。**境内 `dig` 这两台 NS 是 48/48 零丢包，
但那个结论对 LE 不成立** —— 和坑之二（宿主机 curl 测模型网关）是同一类错误。

LE 限流是每域名每小时 5 次失败验证，别循环重试。零成本探测当前链路（不耗额度）：

```sh
curl -s -H 'accept: application/dns-json' \
  "https://dns.google/resolve?name=cn.&type=DNSKEY&do=1" | grep -o '"Status":[0-9]*'
```

### 怎么验 SSE 真的没被缓冲

这两个端点是**先整体生成、再按固定间隔匀速下发**（病历 6 字符/12ms，语音 3 字符/20ms）
做打字机效果，所以首块必然等在模型生成之后。**用「首块来得晚」判断被缓冲会误判** ——
要看首块之后各块是否随时间摊开：

```sh
curl -sS -N https://da.aaronhealth.cn/api/emr/copilot/chat \
  -H 'content-type: application/json' -d '{"patient_id":"P002","generate_record":true}'
```

实测块间隔中位数 11.9ms / 20.9ms，与服务端节流吻合即为真流式；
若被缓冲，所有块会在同一时刻涌到。

## 隔离约束

不得重启或修改同机 `aits-app`、`aaronhealth-site` 或 `comorbidity-mvp`；
`3400` 之外的端口不碰。
