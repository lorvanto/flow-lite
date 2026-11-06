# 使用指南

## 首次初始化

API 首次启动时，未指定 `FLOW_SETUP_TOKEN` 会在 `FLOW_DATA_DIR/setup-token` 生成初始化令牌。只在受控终端读取它，然后在页面创建管理员。管理员密码长度为 12～256 位；初始化令牌不代替日常登录密码。

平台供可信管理员管理自有项目。执行命令和构建脚本都需要使用实际的系统权限，因此不要向不受信任的用户开放执行能力。

## Node.js 静态网站

以 Vite 项目为例：

| 配置         | 示例                                                  |
| ------------ | ----------------------------------------------------- |
| 项目类型     | Node.js                                               |
| 名称         | `demo-web`                                            |
| Git 地址     | `git@git.example.com:team/demo-web.git` 或 HTTPS 地址 |
| 分支         | `main`                                                |
| Node.js 版本 | `24`，或自动读取 `.nvmrc`                             |
| 包管理器     | npm                                                   |
| 安装命令     | `npm ci`                                              |
| 构建命令     | `npm run build`                                       |
| 工作目录     | `.`，或仓库中的项目相对路径                           |
| 产物目录     | `dist`，相对于工作目录                                |
| 部署类型     | 本机或 SSH                                            |
| 发布根目录   | `/srv/sites/demo`，不包含 `current`                   |

使用 `npm ci` 时应提交匹配的 `package-lock.json`。其他包管理器使用对应锁文件和安装命令。产物必须为静态文件目录，并包含 `index.html`；符号链接和特殊文件不能作为发布产物。

执行过程为：拉取代码、安装依赖、构建、归档产物、部署。页面显示各阶段状态和实时日志，保存实际 commit、Node.js 版本和包管理器版本。

发布目录结构如下：

```text
/srv/sites/demo/
  releases/
    <运行 ID>/
      index.html
  current -> releases/<当前运行 ID>
```

Web 服务器的根目录指向 `/srv/sites/demo/current`。本机发布和 SSH 发布均先准备版本目录，再原子切换符号链接；SSH 目标机预先安装 `sh`、`tar` 等基础工具，不需要运行 Node.js 构建。

## 仓库与部署凭据

| 用途                | 凭据类型            |
| ------------------- | ------------------- |
| 私有 HTTPS Git 仓库 | Git HTTPS 账号密码  |
| SSH Git 仓库        | SSH 私钥或 SSH 密码 |
| SSH 发布和远程命令  | SSH 私钥或 SSH 密码 |
| 公开 HTTPS Git 仓库 | 可以不选择凭据      |

仓库凭据与部署凭据分别配置。HTTPS Git 凭据只供仓库拉取使用，不能用于 SSH 发布；已有 SSH 项目和凭据继续使用原配置。

### Git HTTPS 账号密码

此认证模式需要执行机安装 **Git 2.32 或以上版本**，可通过 `git --version` 检查。SSH 仓库和不选择凭据的公开 HTTPS 仓库继续沿用原有要求。

1. 在凭据管理中添加凭据，选择 **Git HTTPS 账号密码**，填写凭据名称、Git 用户名，以及密码或访问令牌。
2. 在 Node.js 流水线中填写规范的 HTTPS 克隆地址，例如 `https://git.example.com/team/demo-web.git`。URL 中不要夹带用户名、密码或令牌。
3. 在仓库凭据中选择刚创建的 HTTPS 凭据。若同时使用 SSH 发布，另选对应 SSH 部署凭据。
4. 运行流水线，查看检出阶段和后续构建结果。凭据保存后不回显账号、密码或令牌，使用名称区分不同凭据。

**GitHub 不接受账户密码用于 HTTPS Git 操作。** 填写 GitHub 用户名，在密码 / 访问令牌字段填入拥有目标仓库读取权限的个人访问令牌。其他明确允许密码认证的 Git 服务器可填写原密码，是否接受令牌、所需权限和组织授权由对应服务决定。[GitHub 官方认证说明](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/about-authentication-to-github#https)、[个人访问令牌说明](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)。

账号与密码 / 令牌加密保存在平台数据库中。HTTPS 证书仍须被执行机信任，平台不会自动关闭 TLS 校验；认证检出不自动跟随重定向，仓库迁移后请更新为服务提供的最终克隆地址。此凭据用于检出阶段的 Git 拉取，不传给依赖安装、构建容器或原地命令中的 Git 操作；如果项目在安装依赖时还需访问其他私有仓库，应单独配置相应认证。

兼容例外仅适用于 `http://git.yin-duo.com/mini-program/<项目>.git`，项目限定为 baking、campsite、coffee、course、evse、flower、manhe、milktea、studyroom、tattoo、venue、vipcard、yanxi、yshop、yshopbbc。必须显式选择 Git 账号密码凭据；其他 HTTP 地址、端口、查询参数和 URL 内的账号密码均不接受。HTTP 传输未加密，请仅在接受该仓库连接方式时使用。凭据仍加密保存在平台数据库中，检出时仅通过进程内存交给限定协议、主机和仓库路径的 helper，不创建 HTTP 明文凭据文件、不持久化 Git 凭据，也不跟随重定向。

### SSH 私钥与密码

SSH 凭据不包含登录用户名：在 SSH 目标中填写用户名，仓库连接则从 SSH Git 地址取得用户名。SSH 代码仓库和 SSH 部署目标分别选择凭据，也可以复用同一个 SSH 凭据。

私钥与密码使用 AES-256-GCM 加密保存，保存后不能从页面再次查看。密码经任务私有的临时文件和 OpenSSH ASKPASS 交给客户端，不写入进程参数或环境变量值；任务结束后清理临时文件。目标 SSH 服务必须允许所选账号与认证方式。

填写经过核实的 `known_hosts` 内容，主机和端口应匹配实际连接。留空时使用运行账号已有的可信主机配置。执行器保持 `StrictHostKeyChecking=yes`；不要通过关闭校验绕过首次连接错误。

部署账号需要能够写入所选项目目录。平台不会自动获得额外权限，也不会更改其他项目的目录属主。

## PHP / 命令发布

选择 PHP / 命令发布，填写已有项目的绝对目录、执行位置和多行命令。此类型不需要 Git 地址、Node.js 版本或静态产物配置。

| 配置     | 示例                                 |
| -------- | ------------------------------------ |
| 名称     | `php-demo`                           |
| 执行位置 | 本机或 SSH 远程服务器                |
| 执行目录 | `/srv/www/php-demo`，必须已存在      |
| SSH 连接 | 远程执行时填写主机、端口、用户和凭据 |
| 命令     | 按项目需要填写 Shell 脚本            |

例如，一个已配置好运行环境的 Laravel 项目可以执行：

```sh
git pull --ff-only
composer install --no-dev --prefer-dist --no-interaction --optimize-autoloader
php artisan config:cache
```

普通 PHP 项目可只保留 Git 更新，或换成自己的操作。平台不安装或切换 PHP 版本，也不会自动执行未填写的框架命令。Git、PHP、Composer 等工具需要在执行账号的非交互环境中可找到，必要时使用绝对路径。

脚本默认通过 `sh -e` 执行，普通命令失败即停止；管道、条件语句等遵循 Shell 自身的退出规则。如果需要 Bash 特性，显式调用目标机已安装的 `bash`。

命令直接修改指定目录。本机执行使用平台运行账号，远端执行使用配置的 SSH 账号。此类型不创建 `current` / `releases`，不保存静态产物，也不提供自动回滚。

目标机上 `git pull` 的 Git 认证需要单独配置。平台的 SSH 凭据负责登录服务器，仓库凭据负责 Node.js 检出阶段；二者都不会自动转交给命令中的 Git 客户端。不要把密码或令牌直接写入命令文本，使用项目环境变量引用。

## 取消、重试与回滚

- 排队任务可直接取消；运行中的任务由执行器中止相关进程。远端命令会通过另一次 SSH 连接尝试终止进程组，网络断开时仍需检查目标机。
- Node.js 重新运行使用原任务配置和已记录的 commit。PHP / 命令重新运行使用原命令配置，但命令会读取执行时的实际状态，例如 `git pull` 获取当时最新提交。
- Node.js 回滚使用保留的成功构建产物，不重新拉代码或构建。默认保留最近 5 个版本，并保护当前版本和排队回滚需要的产物。
- 修改项目类型或执行 / 发布目标前，先结束或取消活动任务。类型或目标改变后，旧任务不能直接重试到新目标；当前版本标记会清空。

失败、取消、重启和重新运行均不会撤销已经完成的文件修改、数据库操作或远程操作。Node.js 静态产物回滚也不包含数据库、上传文件或外部服务的状态恢复。
