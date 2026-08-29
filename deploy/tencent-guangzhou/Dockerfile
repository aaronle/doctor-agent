FROM node:22-bookworm-slim AS web-build

WORKDIR /build
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
RUN npm ci

COPY apps/web apps/web
RUN npm run build --workspace @doctor-agent/web

FROM python:3.12-slim

LABEL com.aaronhealth.service="doctor-agent-mvp"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY apps/api/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

COPY apps/api/app /app/apps/api/app

# 临床种子。启动时由 app/seed.py 导入，路径按 apps/api/app 上溯三层解析，
# 因此镜像内必须保持与仓库一致的相对位置，否则启动建库后无数据。
COPY references/ui-demo/extracted/fixtures /app/references/ui-demo/extracted/fixtures

COPY --from=web-build /build/apps/web/dist /app/apps/web/dist

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--app-dir", "apps/api", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips=127.0.0.1"]
