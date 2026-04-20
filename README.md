# Claude Port Router

本项目是一个本地 Claude Code 转发网关。服务启动后同一个端口同时提供：

- 管理后台：`http://127.0.0.1:4568/ui`
- Anthropic/Claude 兼容接口：`http://127.0.0.1:4568/v1/messages`
- OpenAI Chat Completions 兼容接口：`http://127.0.0.1:4568/v1/chat/completions`

## 功能

- Node.js 后端转发 OpenAI 兼容模型服务。
- Vue 3 + Ant Design Vue 管理 Provider、模型、路由策略。
- SQLite 本地数据库保存请求统计，默认路径为 `data/node-claude-code.db`。
- 配置文件同步写入 `data/settings.json`，支持前端导入和导出。
- 统计 provider、模型、请求状态、耗时、输入 token、输出 token。
- 支持 `maxtoken` transformer 的 `max_tokens` 覆盖。
- 支持本地 `APIKEY` 校验，可配合 Claude Code 的 `ANTHROPIC_AUTH_TOKEN`。

## 启动

```bash
npm install
npm run dev
```

默认访问：

```text
http://127.0.0.1:4568/ui
```

## Claude Code 配置

把 Claude Code 指向本地端口：

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:4568"
export ANTHROPIC_AUTH_TOKEN="local-router-token"
```

`ANTHROPIC_AUTH_TOKEN` 需要与管理台里的 `Local API Key` 一致。留空则不校验本地请求。

## 生产构建

```bash
npm run build
npm run start
```

## 数据文件

```text
data/
├── backups/
├── logs/
├── settings.json
└── node-claude-code.db
```

`settings.json` 适合人工导入导出；`node-claude-code.db` 保存配置快照和请求统计。
