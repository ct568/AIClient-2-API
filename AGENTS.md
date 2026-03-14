# Repository Guidelines

## 项目结构与模块组织
`src/` 是 Node.js 主代码目录。`src/core/` 负责主进程与配置流转，`src/services/` 提供 HTTP 服务，`src/handlers/` 处理请求，`src/providers/` 放各模型提供商适配实现，`src/converters/` 负责协议转换，`src/auth/` 管理 OAuth 与鉴权，`src/utils/` 存放共享工具。Web UI 资源位于 `static/` 与 `src/ui-modules/`。示例配置文件放在 `configs/*.example`，测试文件集中在 `tests/`。`tls-sidecar/` 是独立的 Go TLS 辅助模块。

## 构建、测试与开发命令
先执行 `npm install` 安装依赖。

- `npm start`：通过 `src/core/master.js` 启动主进程模式。
- `npm run start:dev`：以开发模式启动服务。
- `npm run start:standalone`：仅启动 API 服务，不启用主进程管理。
- `npm test`：运行匹配 `tests/**/*.test.js` 的 Jest 测试。
- `npm run test:watch`：监听文件变化并重复执行测试。
- `npm run test:coverage`：生成覆盖率报告到 `coverage/`。
- `install-and-run.ps1`、`install-and-run.sh`：本地一键安装并启动。

## 代码风格与命名约定
项目使用 ESM JavaScript，统一采用 `import`/`export`、分号结尾和 4 空格缩进。修改文件时优先遵循现有风格。文件名通常使用小写 kebab-case，例如 `request-handler.js`、`openai-strategy.js`；仅在既有模式下保留 PascalCase，例如 `src/converters/BaseConverter.js`。新增提供商逻辑应放入对应的 `src/providers/<provider>/` 目录。仓库当前未提交 ESLint 或 Prettier 配置，因此以“与周边代码保持一致”为准。

## 测试规范
Jest 配置位于 `jest.config.js`，覆盖率默认统计 `src/**/*.js`。新增测试请放在 `tests/` 下，并使用 `*.test.js` 命名。单元测试应尽量避免真实网络依赖；`tests/api-integration.test.js` 属于真实 HTTP 集成测试，需要已运行的服务和有效凭据，提交前应在 PR 中说明依赖条件。涉及非简单改动时，至少运行 `npm test`，必要时补充 `npm run test:coverage`。

## 提交与 Pull Request 规范
最近提交历史采用 Conventional Commits，例如 `feat(update): ...`、`fix(grok): ...`、`chore: ...`。推荐使用 `type(scope): summary` 格式，scope 明确时不要省略。Pull Request 应包含变更说明、关联 issue、实际执行过的测试命令；若修改了 `static/` 或 UI 相关模块，附上截图。不要提交真实密钥、OAuth 凭据或本地配置，只提交 `configs/` 下的示例文件。
