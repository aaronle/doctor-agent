# Doctor Agent 广州 MVP 部署

## 目标架构

`da.aaronhealth.cn` 由宿主机 Nginx 终止 HTTPS，并反向代理到只监听回环地址的
`doctor-agent-mvp` 单容器。容器同时提供 Vue 构建产物、FastAPI 产品 API、六个版本化
Mock Agent 和 SQLite 持久化。

```text
公网 443 -> 宿主机 Nginx -> 127.0.0.1:3400 -> doctor-agent-mvp:8000
                                                -> /app/data/doctor-agent.db
```

本 MVP 不运行 AgentScope、本地大模型、PostgreSQL、Redis、向量数据库或 Langfuse，且不允许
使用真实患者数据。

## 服务器目录

```text
/opt/doctor-agent/
├── source/
├── config/.env.runtime
└── data/doctor-agent.db
```

`.env.runtime` 以 `env.runtime.example` 为模板，权限必须为 `600`。数据库目录只允许应用
持久化演示任务、任务事件和审计事件。

## 候选验证

```sh
docker compose -f deploy/tencent-guangzhou/docker-compose.yml build
docker compose -f deploy/tencent-guangzhou/docker-compose.yml up -d
curl -fsS http://127.0.0.1:3400/api/v1/health
curl -fsSI http://127.0.0.1:3400/
```

健康接口必须返回：

- `release=0.2.0-mvp`
- `database=ready`
- `runtime_mode=mock`
- 6 个版本化 Mock Agent
- `data_classification=MOCK_ONLY_NO_REAL_PATIENT_DATA`

## 域名和 HTTPS

1. 在 DNSPod 新建 `da.aaronhealth.cn -> 81.71.155.220` A 记录。
2. 将 `nginx-da.aaronhealth.cn.conf.example` 安装为宿主机 Nginx 站点。
3. 执行 `nginx -t` 后重载 Nginx。
4. 用 Certbot 为 `da.aaronhealth.cn` 签发独立证书。
5. 公网验证首页、健康接口、六个演示病例和七类任务。

不得重启或修改同机 `aits-app`、`aaronhealth-site` 或 `comorbidity-mvp`。
