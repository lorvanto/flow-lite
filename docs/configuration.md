# 配置说明

从仓库根目录复制 `.env.example` 为 `.env`。生产环境使用受限权限保存该文件，并在修改后同时重启 API 和 worker。实际配置、数据目录和密钥不应提交到 Git。

## 平台环境变量

| 变量                            | 默认值          | 说明                                                           |
| ------------------------------- | --------------- | -------------------------------------------------------------- |
| `FLOW_HOST`                     | `127.0.0.1`     | API 监听地址，生产建议只监听本机，由反向代理提供 HTTPS         |
| `FLOW_PORT`                     | `3210`          | API 端口                                                       |
| `FLOW_DATA_DIR`                 | 仓库下的 `data` | SQLite、密钥、日志、产物及工作目录；生产建议填写绝对路径       |
| `FLOW_RUNNER_MODE`              | `docker`        | Node.js 构建模式，可选 `docker` 或 `host`                      |
| `FLOW_NODE_IMAGE_PREFIX`        | `node`          | Node.js 镜像仓库名，不包含协议、标签或摘要                     |
| `FLOW_DOCKER_CPUS`              | `4`             | 单次 Node.js 容器构建的 CPU 上限                               |
| `FLOW_DOCKER_MEMORY`            | `8g`            | 单次 Node.js 容器构建的内存上限                                |
| `FLOW_ALLOW_HOST_RUNNER`        | `false`         | 使用 Node.js 的 `host` 模式时必须显式开启                      |
| `FLOW_ALLOW_LOCAL_REPOSITORIES` | `false`         | 是否允许本地 Git 仓库，仅建议用于受控调试                      |
| `FLOW_SECURE_COOKIE`            | `false`         | 通过 HTTPS 访问生产面板时设置为 `true`                         |
| `FLOW_SETUP_TOKEN`              | 自动生成        | 首次创建管理员的初始化令牌；留空时写入数据目录的 `setup-token` |

生产配置示例：

```dotenv
FLOW_HOST=127.0.0.1
FLOW_PORT=3210
FLOW_DATA_DIR=/var/lib/flow-lite
FLOW_RUNNER_MODE=docker
FLOW_NODE_IMAGE_PREFIX=node
FLOW_DOCKER_CPUS=4
FLOW_DOCKER_MEMORY=8g
FLOW_ALLOW_HOST_RUNNER=false
FLOW_ALLOW_LOCAL_REPOSITORIES=false
FLOW_SECURE_COOKIE=true
```

以上是示例路径，目录应由平台运行账号拥有。`.env` 使用明确的 `KEY=value`，不要依赖 Shell 的变量展开；systemd 服务通过 `EnvironmentFile` 读取它，npm 入口通过 Node.js 的环境文件参数读取它。

## Node.js 构建版本与镜像

平台进程需要 Node.js 24+，项目的构建版本单独配置。界面提供常用主版本，也支持完整版本和自动识别；新项目默认使用 24。

自动识别依次读取项目工作目录及仓库根目录中的 `.nvmrc` / `.node-version`。文件使用数字版本，例如 `24`、`v24.13.0`；没有识别文件时回退到 24。Node.js 14 / 18 用于兼容老项目，已结束官方维护，详情见 [Node.js EOL 列表](https://nodejs.org/en/about/eol)。

Node.js 14 / 16 使用 `bullseye` 镜像变体，18 及较新版本使用 `bookworm`，例如：

```text
node:14-bullseye
node:18-bookworm
node:24-bookworm
```

访问 Docker Hub 有困难时，可把 `FLOW_NODE_IMAGE_PREFIX` 设置为 `public.ecr.aws/docker/library/node`，或使用自己的镜像仓库，例如 `registry.example.com:5000/team/node`。版本标签仍由项目配置决定。

平台默认使用镜像自带的 npm；也可以选择 pnpm、Yarn 或指定包管理器版本。版本须与所选 Node.js 兼容，锁文件应提交到仓库，安装命令应与项目的包管理器和版本对应。

## 资源与任务超时

队列同时只执行一个任务。默认 **4 CPU / 8 GB** 只限制 Node.js 的 Docker 构建容器；它不是资源预留，也不会限制 SSH 目标机或原地 PHP / 命令任务。任务的超时配置对各种任务类型均生效。

Docker 不可用时，Node.js 构建保留在队列中，执行器仍可处理自定义命令和已有产物回滚。Docker 恢复后，执行器会重新检查并继续构建。

## 本地开发与 host 模式

`npm run dev` 同时启动 API、worker 和 Vite；按 `Ctrl+C` 关闭全部子进程。页面默认在 `http://127.0.0.1:5173`，开发代理固定指向 `127.0.0.1:3210`，开发时保留默认 API 端口。

本地没有 Docker、且仅测试自己的可信代码时，可显式开启：

```dotenv
FLOW_RUNNER_MODE=host
FLOW_ALLOW_HOST_RUNNER=true
FLOW_ALLOW_LOCAL_REPOSITORIES=true
```

host 模式直接使用平台当前的 Node.js，所选版本必须与实际版本匹配，不会自动安装或切换版本。它不提供容器隔离。生产环境默认使用 Docker，并关闭本地仓库入口。

PHP / 命令发布独立于这两个 host 构建开关，始终使用本机或 SSH 目标机已有的命令环境。

## 项目环境变量

项目配置支持单行字符串环境变量，值不能包含回车、换行或空字符；部分影响命令解析和 SSH 认证的变量由执行器保留。Node.js 构建可通过 `NODE_OPTIONS` 设置构建进程参数，命令发布不接受该保留变量。

项目环境变量与任务快照加密保存，日志对已配置的原始敏感值进行脱敏。脚本自身仍可能把变量写入文件或发送到其他服务；前端构建写入静态产物的变量也应按产物实际公开范围管理。
