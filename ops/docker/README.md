# 生产部署说明

本目录保存可选的旧版 Docker/FastAPI 自托管方案；当前公开站点使用 GitHub + Cloudflare Pages。以下命令均从本目录执行：

```bash
cd ops/docker
```

部署采用两个容器：`web`负责Vue静态文件和Nginx反向代理，`backend`负责FastAPI、定时任务和SQLite。数据库、管理员密钥与预览缓存保存在命名卷`henan_reservoir_backend_data`中，更新镜像不会覆盖这些数据。

## 前提

- Linux服务器，建议至少2核CPU、4 GB内存、30 GB可用磁盘。
- Docker Engine与Docker Compose v2。
- HTTPS部署还需要一个解析到服务器公网IP的域名，并开放TCP 80和443端口。

## 1. HTTP内网或本机部署

复制环境模板：

```bash
cp .env.production.example .env.production
```

启动：

```bash
docker compose --env-file .env.production -f compose.yml -f compose.http.yml up -d --build
docker compose --env-file .env.production -f compose.yml -f compose.http.yml ps
```

访问`http://服务器IP:8080/`。查看自动生成的管理员密钥：

```bash
docker compose --env-file .env.production -f compose.yml -f compose.http.yml exec backend \
  sh -c 'cat /app/backend/data/admin-api-key.txt'
```

不要把该输出放入聊天、截图、代码仓库或部署日志。

## 2. HTTPS公网部署

先把`.env.production`中的`DOMAIN_NAME`改为实际域名，并确认DNS A/AAAA记录已生效。

首次签发证书可在Linux宿主机安装Certbot，并暂时停止占用80端口的服务：

```bash
sudo certbot certonly --standalone -d example.com --email you@example.com --agree-tos
```

把命令中的域名和邮箱替换为真实值。证书应出现在`/etc/letsencrypt/live/实际域名/`。然后启动HTTPS组合：

```bash
docker compose --env-file .env.production -f compose.yml -f compose.https.yml up -d --build
docker compose --env-file .env.production -f compose.yml -f compose.https.yml ps
curl -fsS https://实际域名/healthz
curl -fsS https://实际域名/api/v1/health
```

证书续期后重新加载Nginx：

```bash
sudo certbot renew
docker compose --env-file .env.production -f compose.yml -f compose.https.yml exec web nginx -s reload
```

## 3. 更新程序

将新源码同步到服务器后执行：

```bash
docker compose --env-file .env.production -f compose.yml -f compose.https.yml build
docker compose --env-file .env.production -f compose.yml -f compose.https.yml up -d
docker compose --env-file .env.production -f compose.yml -f compose.https.yml ps
```

后端容器每次启动都会执行`alembic upgrade head`。命名卷不会因重新构建或`docker compose down`而删除；不要执行`docker compose down -v`，该参数会删除持久化数据库卷。

## 4. 诊断

```bash
docker compose --env-file .env.production -f compose.yml -f compose.https.yml logs --tail=200 backend
docker compose --env-file .env.production -f compose.yml -f compose.https.yml logs --tail=200 web
docker compose --env-file .env.production -f compose.yml -f compose.https.yml exec backend \
  python -m alembic current
```

若尚无域名，先使用HTTP 8080模式验收功能，取得域名和服务器后再切换HTTPS配置。
