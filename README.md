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
- Anthropic Messages Provider 支持直转，避免 OpenAI/Anthropic 格式互转带来的额外处理。
- 上游请求使用 keep-alive 连接池，减少重复 DNS/TLS/建连波动。
- 代理请求统计异步批量写入 SQLite，降低多并发流式请求的事件循环阻塞。

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

## Tauri 桌面版

使用 Tauri 打包 macOS 桌面应用：

```bash
npm run tauri:build
```

构建产物：

```text
src-tauri/target/release/bundle/macos/Node Claude Code.app
src-tauri/target/release/bundle/dmg/Node Claude Code_0.0.0_aarch64.dmg
```

桌面版会在启动时自动拉起内嵌的本地服务，前端直接连接这个本地服务。

macOS 下配置和数据默认存放到：

```text
/Users/<用户名>/.node-claude-code
```

其中包括：

- `settings.json`
- `node-claude-code.db`
- `logs/`
- `backups/`

## 延迟压测

可以用 `bench:latency` 对比直连上游、Claude Code 直转、OpenAI 转 Anthropic 三类路径的响应耗时：
脚本会按轮次交错执行不同用例，例如 `direct#1 -> router#1 -> direct#2 -> router#2`，减少时间片波动带来的偏差。
建议先用 `BENCH_CONCURRENCY=1` 做基准测试，避免并发排队、Provider 限速或多 Key 负载策略影响判断。

```bash
BENCH_ROUTER_API_KEY="local-router-token" \
BENCH_ROUTER_FORWARD_MODEL="claude-opus-4-7" \
BENCH_ROUTER_CONVERT_MODEL="claude-sonnet-4-6" \
BENCH_DIRECT_URL="https://example.com/v1/messages" \
BENCH_DIRECT_MODEL="claude-opus-4-7" \
BENCH_DIRECT_API_KEY="sk-xxx" \
npm run bench:latency
```

常用参数：

- `BENCH_ITERATIONS`：每个用例请求次数，默认 `3`。
- `BENCH_CONCURRENCY`：并发数，默认 `1`。
- `BENCH_STREAM`：是否使用流式请求，默认 `true`。
- `BENCH_PROMPT`：测试提示词。
- `BENCH_DIRECT_URL`：直连上游地址；Anthropic 协议可填写 Base URL，脚本会按 Router 规则补全 `/v1/messages`。
- `BENCH_CASES`：JSON 数组，自定义多个测试用例。

如果 Router 明显慢于直连，优先看最近请求里的耗时拆分：

- `排队` 接近 0，但 `发起上游`/`首包` 很高：主要是上游网络或模型首包。
- `排队` 高：调大并发控制或检查 Provider 限速。
- `总耗时` 明显高于首包：主要是模型生成或客户端读取速度。
- OpenAI Provider 比 Anthropic Provider 慢：优先把真实 Provider 配成 `Anthropic Messages` 协议直转。

## 数据文件

```text
data/
├── backups/
├── logs/
├── settings.json
└── node-claude-code.db
```

`settings.json` 适合人工导入导出；`node-claude-code.db` 保存配置快照和请求统计。
