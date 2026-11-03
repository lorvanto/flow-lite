# Linux 部署指南

本指南使用通用示例：源码 `/opt/flow-lite`、数据 `/var/lib/flow-lite`、账号 `flowlite`、面板域名 `flow.example.com`。按实际服务器调整，不覆盖已有项目的数据、配置或服务。

## 准备源码与运行环境

平台需要 Linux 和 Node.js 24+。Node.js Docker 构建需要 Git、Docker 和 `tar`；SSH 功能需要 OpenSSH 客户端。仅执行 PHP / 自定义命令时无需 Docker，所需工具由执行目标提供。

使用 Git HTTPS 账号密码凭据时，平台执行机的 Git 须为 **2.32+**，先以运行账号执行 `git --version` 确认；这不是 SSH 或公开 HTTPS 仓库的新增版本限制。

创建独立非 root 运行账号与目录，例如：

```sh
sudo useradd --system --user-group --create-home --home-dir /var/lib/flowlite-user --shell /bin/bash flowlite
sudo git clone https://github.com/lorvanto/flow-lite.git /opt/flow-lite
sudo chown -R flowlite:flowlite /opt/flow-lite
sudo install -d -o flowlite -g flowlite -m 0700 /var/lib/flow-lite
```

在运行账号下安装和构建：

```sh
sudo -u flowlite -H sh -c 'cd /opt/flow-lite && npm ci && npm run build && cp .env.example .env && chmod 600 .env'
```

编辑 `.env`，设置绝对的数据路径、仅本机监听和 HTTPS Cookie：

```dotenv
FLOW_HOST=127.0.0.1
FLOW_PORT=3210
FLOW_DATA_DIR=/var/lib/flow-lite
FLOW_RUNNER_MODE=docker
FLOW_DOCKER_CPUS=4
FLOW_DOCKER_MEMORY=8g
FLOW_ALLOW_HOST_RUNNER=false
FLOW_ALLOW_LOCAL_REPOSITORIES=false
FLOW_SECURE_COOKIE=true
```

如果需要 Docker 构建，为运行账号配置 Docker 访问权限，再重新建立该账号的会话或重启相关服务：

```sh
sudo usermod -aG docker flowlite
sudo -u flowlite -H docker info
```

Docker 组具有控制宿主机的权限，平台面向可信管理员和仓库使用。构建容器中不挂载 Docker socket。数据目录保持私有，静态发布目录则需要允许 Web 服务账号读取。

## systemd

样例位于 [`deploy/systemd`](../deploy/systemd/)。确认 `ExecStart` 中的 `/usr/bin/node` 实际为 Node.js 24+；如果使用其他位置，同时调整服务中的运行时路径和 `PATH`。

```sh
sudo install -m 0644 deploy/systemd/flow-lite-api.service /etc/systemd/system/flow-lite-api.service
sudo install -m 0644 deploy/systemd/flow-lite-worker.service /etc/systemd/system/flow-lite-worker.service
sudo systemd-analyze verify /etc/systemd/system/flow-lite-api.service /etc/systemd/system/flow-lite-worker.service
sudo systemctl daemon-reload
sudo systemctl enable --now flow-lite-api.service flow-lite-worker.service
sudo systemctl status flow-lite-api.service flow-lite-worker.service --no-pager
```

API 和 worker 各运行一个实例。服务读取 `/opt/flow-lite/.env`，入口分别为 `server/index.mjs` 和 `server/worker.mjs`。worker 对所有任务串行调度，无须额外队列服务。

公开样例没有给 worker 添加进程级 CPU / 内存硬限制；`FLOW_DOCKER_CPUS` 和 `FLOW_DOCKER_MEMORY` 仅限制构建容器。若自行增加 systemd 资源策略，它只作用于本机服务及其相应进程，不会自动约束 SSH 目标机；Docker daemon 管理的构建容器仍单独配置。

## PM2

也可以使用 [`deploy/pm2/ecosystem.config.cjs`](../deploy/pm2/ecosystem.config.cjs)，与 systemd 二选一，避免重复启动执行器。配置中的工作目录为仓库根目录。

在 Node.js 24+ 环境中安装并以运行账号执行 PM2：

```sh
npm install --global pm2
cd /opt/flow-lite
pm2 start deploy/pm2/ecosystem.config.cjs
pm2 save
pm2 startup
```

由管理员按 `pm2 startup` 输出执行与账号、Node.js 路径对应的系统服务命令。更换 Node.js 安装路径后检查启动服务。每个应用只运行一个实例，不使用 cluster 模式。

## Nginx 与 HTTPS

样例位于 [`deploy/nginx`](../deploy/nginx/)：

- `nginx-panel.conf`：面板 `flow.example.com` 反代到 `127.0.0.1:3210`，包含 SSE 无缓存与长连接配置。
- `nginx-static-site.conf`：独立静态业务站点 `app.example.com`，根目录为 `/srv/sites/demo/current`，包含 SPA 路由回退。

替换域名、证书和发布目录后，由管理员先执行 `nginx -t`，通过后再 reload。证书路径只是示例，需要自行通过已有证书管理流程取得并维护证书；复制 PEM 文件不等于启用了自动续期。

前端与 API 使用同一个面板域名，代理保留 `Host` 并传递客户端 IP 和协议。服务仅信任来自 loopback 的代理头。生产环境保留 API 的本机监听地址，通过 HTTPS 域名访问，并设置 `FLOW_SECURE_COOKIE=true`。

业务静态目录每一级都需要允许 Nginx 穿越和读取，平台数据目录不应被 Nginx 公开。已有 PHP 网站继续使用自己的 Web 服务和 PHP-FPM 配置，命令发布不改变站点根目录。

## 已有宝塔或其他面板

复用现有 Nginx、PHP 和数据库，不另外安装一套站点环境。为面板准备单独域名和反代配置，并明确由现有面板还是独立配置流程维护该 vhost，避免双方覆盖同一配置。

证书申请、可信 ACME 账号和续期任务沿用服务器既有流程。使用 HTTP 验证时，确认 `/.well-known/acme-challenge/` 可由公网直接读取，且不会被代理或重定向截走。具体面板接口随版本变化，不应根据通用样例直接修改面板内部数据库、账号文件或订单。

原地命令使用运行账号的实际权限。接入已有项目时只分配对应项目目录所需权限；不要批量修改其他站点属主。宝塔中的多个 PHP 版本可能不在服务的默认 `PATH` 中，可在项目命令中使用经过核实的绝对路径。

## 首次验收

```sh
curl -fsS http://127.0.0.1:3210/api/health
curl -fsS https://flow.example.com/api/health
```

在受控终端读取数据目录中的 `setup-token`，通过 HTTPS 页面创建管理员。随后用测试目录验证一次命令成功、失败和取消；接入 Node.js 时再完成构建、发布和回滚。按目标机实际情况核对 Docker、SSH、目录权限、证书续期与实时日志，不以服务启动成功代替完整验收。
