# 参与贡献

感谢帮助改进 Flow Lite。提交较大的功能前，请先通过 [Issue](https://github.com/lorvanto/flow-lite/issues) 说明使用场景和预期行为。

## 开发环境

使用 Node.js 24+，在仓库根目录运行：

```sh
npm ci
cp .env.example .env
npm run dev
```

前端地址为 `http://127.0.0.1:5173`。Node.js 构建任务默认需要 Docker；开发环境与部署说明见 [README](README.md) 和 [配置说明](docs/configuration.md)。测试会自行创建临时目录，不需要生产数据库、真实 SSH 凭据或运行中的 Docker。

## 代码组织与验证

- `server/`：API、执行器、存储与发布逻辑。
- `web/src/`：Vue 界面、组件、composables 与客户端工具。
- `tests/`：Node.js 测试；涉及执行、权限、取消、加密或发布行为的修改，应补充相应的行为测试。
- `deploy/`：通用部署模板；文档放在 `docs/`。

提交前执行：

```sh
npm run format
npm run verify
```

`verify` 会检查 JavaScript 语法、格式、运行测试并构建前端。CI 在 Linux、Node.js 24 环境运行相同检查。只修改文档时，验证链接、命令和格式即可。

## 提交 Pull Request

说明解决的问题、用户可见的变化和验证方式。保持改动集中，变更配置或行为时同步更新文档。不要提交 `.env`、`data/`、SSH 凭据、数据库、真实服务器配置或包含个人信息的截图。本地部署记录可以放在已忽略的 `.local/` 下。

安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。贡献代码将按仓库的 [MIT 许可](LICENSE) 发布。
