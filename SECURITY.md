# 安全政策

## 报告漏洞

请使用仓库的 [私密漏洞报告](https://github.com/lorvanto/flow-lite/security/advisories/new) 提交复现步骤、影响范围和修复建议。不要在公开 Issue、日志或截图中暴露凭据、初始化令牌、数据目录或可用于攻击真实服务器的信息。

目前维护 `main` 分支。安全修复会合入该分支，请在升级前备份数据并阅读变更说明。

## 使用边界

Flow Lite 面向可信管理员管理自己的项目。平台允许执行仓库构建脚本、本机命令和 SSH 命令，管理员及具备这些入口访问权限的人可以使用运行账号的实际权限。

- 使用 HTTPS、独立运行账号和可信 Git 仓库；Docker 组成员拥有控制宿主机的权限。
- 构建容器设置资源上限，但不作为不可信代码的强安全隔离边界。
- PHP / 自定义命令直接在本机或目标机执行，不受构建容器的 CPU、内存限额约束。
- SSH 主机公钥必须核实；静态发布目录与平台私有数据目录应分开。
- `.env`、数据库、`master.key` 和备份需限制读取权限。凭据及配置的环境变量加密保存，日志对已配置的秘密值进行脱敏；脚本本身的外部输出及操作仍由管理员负责。

## HTTPS Git 凭据

HTTPS 仓库的账号与密码 / 访问令牌加密保存在凭据中，API 不回显这些字段。使用独立的仓库凭据，不把账号、密码或令牌写入克隆 URL；SSH 部署继续使用 SSH 凭据。

该认证模式要求 Git 2.32+，不兼容的旧版本会明确拒绝执行，不降级绕过检出进程配置和认证隔离。SSH 与不使用凭据的公开 HTTPS 仓库不受该新增版本限制影响。

认证仅作用于检出阶段的 Git 进程：通过 `0600` 临时文件和专用 credential helper 提供凭据，重置其他 helper，并按 HTTPS 主机、端口及仓库路径限制匹配范围。helper 不保存持久化凭据；clone / fetch 完成后、checkout 与构建前清理临时认证目录，异常时同样清理。构建容器、包管理器和原地命令不会继承此仓库认证。helper 的路径匹配与重置语义见 [Git 官方凭据文档](https://git-scm.com/docs/gitcredentials)。

TLS 证书校验保持开启，认证检出不自动跟随 HTTP 重定向。私有 Git 服务的证书需被执行机信任；地址迁移时改用最终的 HTTPS 克隆地址。

GitHub 的 HTTPS Git 操作不支持账户密码，应使用拥有目标仓库权限的访问令牌；其他 Git 服务器是否接受原密码由其认证策略决定。[GitHub 官方说明](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/about-authentication-to-github#https)。

部署与备份操作见 [部署说明](docs/deployment.md) 和 [运维说明](docs/operations.md)。
