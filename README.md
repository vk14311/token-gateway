# token-gateway

多上游 LLM 网关：给本机各 AI 编程工具（pi / claude-code / codex / opencode…）提供统一 base_url，
在转发的同时**逐请求计量 token 用量并折算人民币成本**，浏览器查看聚合仪表盘。

```
AI 工具 ──http──▶ token-gateway(127.0.0.1:8386) ──https──▶ 上游(bigmodel/dashscope/deepseek…)
                     │
                     ├─ data/YYYY-MM-DD.jsonl   逐请求明细(NDJSON 追加)
                     └─ GET /                    仪表盘(按天/按模型/按工具/账单比对)
```

## 路由形态

```
http://127.0.0.1:8386/{tool}/{upstream}/…
     tool      发起方标识(pi / cc / codex …)，仅用于归因统计，透传时剥除
     upstream  config.json 里登记的上游别名(bigmodel / dashscope / deepseek …)
```

例如 pi 使用 GLM：base_url = `http://127.0.0.1:8386/pi/bigmodel`，
pi 的 OpenAI 客户端拼上 `/chat/completions` 后实际打到
`open.bigmodel.cn/api/paas/v4/chat/completions`。

## 计量方式

- 流式请求自动注入 `stream_options.include_usage`（SSE 尾帧取 usage；字节原样透传，不影响客户端）。
- 非流式直接读响应 JSON 的 `usage`。
- 归一化各家字段差异（prompt/input tokens、cached_tokens、reasoning_tokens、Anthropic 风格 cache_*_input_tokens 等）。
- 计费 = Σ(tokens ÷ 1e6 × prices.json 单价)，provider+model 匹配规则：精确 → 最长 `*` 前缀通配。

## 密钥策略（双载）

默认**透传客户端 Authorization**（客户端 auth 体系不变，如 pi 的 auth.json、余额扩展均不受影响）；
需要由网关接管某上游密钥时再设 `TG_KEY_<UPSTREAM>=sk-…` 环境变量或 config.json 的 `upstreams.*.key`
（两者优先级：env > client > config.key）。

## 运行

```bash
npm start                 # 监听 config.json 的 host/port（默认 127.0.0.1:8386）
npm test                  # mock 上游自测（无网络依赖）
open http://127.0.0.1:8386/
```

launchd 常驻（macOS）：见 `deploy/com.token-gateway.plist`（`~/Library/LaunchAgents/` 后 `launchctl bootstrap gui/$UID …`）。

## 环境变量

| 变量 | 说明 |
|---|---|
| `TG_PORT` / `TG_HOST` | 覆盖监听端口/地址 |
| `TG_DATA_DIR` | 明细存储目录（默认 `<repo>/data`，已被 gitignore） |
| `TG_CONFIG_FILE` | 自定义配置路径 |
| `TG_KEY_BIGMODEL` 等 | 网关侧覆盖某上游的 API key |

## 数据与隐私

- 只落盘元信息：时间、tool/upstream/model、状态码、延迟、usage 数字、成本。**不落消息正文与 API key**。
- `.gitignore` 排除 `data/`（真实请求数据不入库）。

## Roadmap

- [x] P1 多上游转发 + SSE usage 截获 + NDJSON 明细 + 仪表盘（GLM/DashScope 两路真机验证）
- [ ] P2 全量接入其余 CLI 工具（claude-code 经 cc-switch、codex、opencode）；tool 归因全覆盖
- [ ] P3 账单拉取（阿里云 BSS QueryInstanceBill 自动对账；人工录入兜底），偏差 >±10% 高亮
- [ ] P4 mitmdump addon 捕获不可配置的桌面应用流量（可选）

## 单价核对须知

prices.json 中 `"unverified": true` 的行是占位估计，页面上对应模型会带 ⚠ 标记。
请到各平台控制台核实后更新数值并删除该标记，否则成本估算可能失真。
