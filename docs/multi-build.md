# 多代码源、多构建任务

Node.js 流水线可选择“单任务构建”或“多任务构建”。已有单任务项目、历史产物和 PHP / 命令发布继续使用原来的方式。

在“多任务构建”中，添加代码源，再为 admin、H5、PC 等添加构建任务。每个代码源单独配置 Git 地址、分支与仓库凭据；多个任务可引用同一代码源，每次运行只检出一次。各任务分别配置工作目录、Node.js 版本、包管理器、安装命令、构建命令、产物目录、发布子目录及环境变量。

## 发布目录

一条流水线配置一个发布目标和根目录。任务的发布子目录相对于此根目录下的 `current`，不是服务器绝对路径。

| 任务  | 工作目录 | 产物目录        | 发布子目录     | 发布后位置                      |
| ----- | -------- | --------------- | -------------- | ------------------------------- |
| admin | `admin`  | `dist`          | `static/admin` | `<发布根>/current/static/admin` |
| H5    | `mobile` | `dist/build/h5` | `h5`           | `<发布根>/current/h5`           |
| PC    | `pc`     | `dist/build/h5` | `pc`           | `<发布根>/current/pc`           |

代码源可相同，也可不同。比如 admin 与 H5 共用商城仓库，PC 引用独立 PC 仓库。

发布子目录必须互不重叠：`h5` 和 `pc` 可以；`h5` 和 `h5/admin` 不可以。单任务允许填 `.` 以保留根目录布局。每个任务的产物需包含普通文件 `index.html`。合并产物没有根入口时，Flow 自动生成一个通向各任务子目录的入口页。

网站服务指向 `current` 或其对应子目录。程序本身的资源基址、路由前缀和 API 地址仍需正确配置；Flow 不自动修改业务源码中的路径。

## 执行、重试与回滚

1. 锁定本次配置，分别拉取代码源并记录每个提交。
2. 按任务顺序执行安装和构建。任务使用自己的 Node / 包管理器环境；Docker 模式每个任务独立创建容器。宿主机模式仍只接受与实际宿主机相符的 Node 版本。
3. 每个任务成功后校验并暂存产物；全部成功后合并成一个发布版本。
4. 上传完成后一次切换 `current`。任务失败、取消或超时会停止后续任务，构建失败不会切换现有版本。
5. 历史“重试”使用原配置和各代码源已经记录的提交；“新构建”读取当前分支。尚未成功解析的代码源，在重试时才确定其提交。
6. 回滚使用整套历史产物，一次恢复全部任务输出，不重新拉 Git 或编译。

运行详情展示各代码源提交、各任务的进度、实际 Node 版本及发布子目录。代码源最多 8 个、任务最多 12 个，按顺序运行；超时限制作用于整条流水线。

公共环境变量应用于所有任务，同名任务变量覆盖公共值。任务变量与项目配置一起加密保存，并纳入日志脱敏。仓库凭据只参与对应代码源检出，不注入构建环境；SSH 发布凭据继续独立选择。

## 同一业务统一发布 Vue 3 前端与 PHP 8.5 API

现有演示业务可在一条多任务流水线中启用 PHP API 阶段。同一业务的 admin、H5（商城另有 PC）和 API 共用一个官方仓库、一个提交及一份发布记录。API 工作目录为 `api`，目标 PHP 为 `8.5`；前端任务的 `targetVueMajor: 3` 会检查源码声明及构建实际使用的 Vue、模板编译器版本。

这项配置目前限定为 `git.yin-duo.com/mini-program/` 下已管理的 15 个演示仓库，发布到 `47.118.69.157` 对应的现有业务目录。每个项目在 Flow 构建服务器上构建前端并打包 API，再用既有 SSH 凭据上传。API 使用独立私有归档，不会混入可公开访问的前端产物。

配置示例（加入现有多任务项目）：

```json
{
  "backend": {
    "enabled": true,
    "type": "php",
    "sourceId": "official",
    "workdir": "api",
    "phpVersion": "8.5",
    "application": "coffee"
  }
}
```

前端的受管安装命令为 `node /flow-tools/frontend-v3.cjs install coffee admin`，构建命令为 `node /flow-tools/frontend-v3.cjs build coffee admin`。其他任务替换业务名和 `admin` / `h5` / `pc` 即可；任务产物目录统一为 `.flow-vue3-dist`。此工具由服务器管理员安装到 Flow 的只读 `build-tools`，不应复制到业务仓库或环境变量中。

执行流程：

1. 检出本次提交，在任何 npm 执行前检查所有 Vue 3 声明并保存 API Git 文件快照。
2. 使用各任务的 Node 22.18.0 构建前端，校验真实 Vue 3 依赖、静态产物和发布路径。
3. 在 Flow 的 PHP 8.5 检查容器中检查 API 语法，再上传至目标服务器的独立候选目录。目标服务器使用 PHP 8.5 检查语法、Composer 锁定依赖、扩展和框架初始化。
4. 全部检查通过后发布前端，再激活同一提交的 API。API 切换会先固定旧版目录并排空旧 Nginx worker，避免旧 PHP 进程读取新版代码。
5. 激活失败时确认 API 恢复后再恢复前端。若网络中断导致结果无法确认，运行显示“需核实恢复”，保留两份归档，不自动猜测线上状态。

目标服务器保留原 `.env`、runtime、上传文件、二维码和会话数据，不自动执行数据库迁移、初始化或 Composer update。框架初始化仍可能执行项目自身的启动逻辑，应由业务源码控制其副作用。API 依赖必须已包含在仓库并与 `composer.lock` 一致；源码仍为 Vue 2、缺少 Vue 3 构建配置、API 或其依赖尚未兼容 PHP 8.5 时，流水线会停止发布，需先升级源码。

统一历史回滚要求该历史版本具有匹配的前端来源证明和已激活的 API 记录。启用之前的前端版本不具备 API 归档，不能通过统一回滚伪装成完整业务版本。保存目标配置本身不会触发构建、切换线上 PHP 或升级源码。

### 服务器 Git 工作目录

目标服务器安装兼容的发布助手后，Flow 管理员可在 `/opt/flow-lite/build-tools/git-worktree-projects.json` 填写项目标识数组，例如 `["campsite"]`。该文件由 `root` 持有，构建用户只读。清单中的项目下次构建发布时会生成 Git 工作目录。清单缺失或项目未列入时，继续按原有方式发布。

在演示服务器可通过固定路径进入当前版本。以营地为例：

```bash
cd /data/httpd/www/demo.yunyingbao.net/projects/campsite
git remote -v
git status --short --branch
git rev-parse HEAD
ls api
```

`projects/campsite` 随当前发布切换，直接进入 `api` 即可查看 `app`、`config`、`route`、`public` 和 `vendor`。Git 使用 detached HEAD 固定本次发布的提交，`origin` 指向官方仓库。代码更新通过 Flow 发起，让 API 和前端使用同一个提交。

Flow 使用已有仓库凭据拉取 Git，通过已有 SSH 发布凭据把提交和历史发送给目标服务器。目标机离线建立工作目录，仓库认证信息不会写入线上 Git 配置。`.git` 只允许服务器管理员访问。运行配置、上传、二维码和其他持久数据继续使用已有位置，PHP 仍从 `api/public` 提供服务。

回滚会同时恢复历史前端和 API。回滚到 Git 发布版本时，固定目录会随它切换；回滚到旧的归档版本时，该项目的固定 Git 入口会暂时移除。首次放量前应检查试点的完整运行时间，流水线超时包含拉取 Git 历史、构建、传输和目标检查。

此模式覆盖现有 15 个受管演示项目。`yshop-i18n`、`yshopbbc-i18n` 有独立仓库，需要另行配置流水线和部署环境。

## API 配置示例

`POST /api/projects` 与 `PUT /api/projects/:id` 接收以下模型。示例 HTTPS 仓库未指定凭据；私有仓库需填写已保存的仓库凭据 UUID，SSH 发布另填部署凭据 UUID。

```json
{
  "type": "node",
  "buildMode": "multi",
  "name": "商城三端",
  "group": "商城",
  "timeoutSeconds": 3600,
  "retainReleases": 5,
  "environment": { "NODE_ENV": "production" },
  "sources": [
    {
      "id": "shop",
      "name": "商城仓库",
      "repoUrl": "https://git.example.com/team/shop.git",
      "branch": "main",
      "buildCredentialId": null
    },
    {
      "id": "desktop",
      "name": "PC 仓库",
      "repoUrl": "https://git.example.com/team/desktop.git",
      "branch": "main",
      "buildCredentialId": null
    }
  ],
  "tasks": [
    {
      "id": "admin",
      "name": "管理后台",
      "sourceId": "shop",
      "workdir": "admin",
      "nodeVersion": "22.18.0",
      "packageManager": "npm",
      "packageManagerVersion": "",
      "installCommand": "npm ci",
      "buildCommand": "npm run build",
      "artifactDir": "dist",
      "publishDir": "static/admin",
      "environment": {}
    },
    {
      "id": "h5",
      "name": "H5",
      "sourceId": "shop",
      "workdir": "mobile",
      "nodeVersion": "22.18.0",
      "packageManager": "npm",
      "installCommand": "npm ci",
      "buildCommand": "npm run build:h5",
      "artifactDir": "dist/build/h5",
      "publishDir": "h5",
      "environment": {}
    },
    {
      "id": "pc",
      "name": "PC",
      "sourceId": "desktop",
      "workdir": ".",
      "nodeVersion": "22.18.0",
      "packageManager": "npm",
      "installCommand": "npm ci",
      "buildCommand": "npm run build:h5",
      "artifactDir": "dist/build/h5",
      "publishDir": "pc",
      "environment": {}
    }
  ],
  "deploy": { "type": "local", "root": "/srv/www/shop" }
}
```

省略 `buildMode` 的旧模型继续视为单任务，不需要转换。界面切换为多任务时会保留原仓库、命令和目录，首个任务映射到 `.`；添加更多任务后需为各端填写独立子目录。

## 更新 Flow 服务

此功能同时涉及 API、worker、前端及运行记录。更新前停止接收新任务，等待或取消现有排队 / 运行任务，备份平台源码、`dist` 和平台数据库，再更新整套代码、执行 `npm run build` 并重启 API 与 worker。已有运行记录表会自动补一个可空的 `build_details` 字段，用于保存不含环境变量的代码源提交和任务进度；历史配置与加密快照保持原样。

上线后刷新浏览器，再配置新的多任务项目。不要只替换前端或只替换 worker。

多任务模式处理 Node.js 静态产物。PHP 运行环境、Nginx、数据库与服务器 `.env` 仍由对应部署流程管理；前端统一回滚不回退数据库。
