# token-gateway

多上游 LLM 网关：给本机各 AI 编程工具（pi / claude-code / codex / opencode…）提供统一 base_url，
在转发的同时**逐请求计量 token 用量、折算人民币成本、采集性能指标**，浏览器查看聚合仪表盘。

```
AI 工具 ──http──▶ token-gateway(127.0.0.1:8386) ──https──▶ 上游(bigmodel/dashscope/deepseek/x99…)
                     │
                     ├─ data/YYYY-MM-DD.jsonl   逐请求明细(NDJSON 追加, 含 TTFT/流式标记)
                     ├─ GET /api/perf           5/15/60 分钟性能窗口(tok/s、TTFT、缓存命中)
                     ├─ GET /api/x99/metrics    x99 vLLM 服务端 Prometheus 指标代理
                     └─ GET /                    仪表盘(用量比价 + 实时性能 + x99 服务端状态)
```

## 性能监控（2026-08-30 增）

**采集**（写入 NDJSON 逐请求记录）：
- `stream`：响应是否 SSE；`ttftMs`：网关发出→上游首字节（仅流式，客户端体感口径）

**网关侧窗口聚合**（`/api/perf?minutes=5|15|60`）：
- TTFT avg/p50/p90；decode tok/s（加权 = ΣtokOut/Σdecode 期，请求级中位数双口径）
- 缓存命中率 = ΣcacheRead/ΣtokIn；错误率；req/min；平均入/出上下文规模
- 注：tok/s 仅统计 decode 期>50ms 的流式请求（TTFT 不算 decode）

**x99 vLLM 服务端面板**（`/api/x99/metrics`，4s 超时保护）：
- 运行/排队请求数、KV 池占用、prefix 缓存命中率（次数级+token 级）
- 投机接受率（DFlash2 draft 被采纳比例，方案 B 特有；方案 A 为 null）
- 服务端 TTFT/ITL/e2e/prefill/decode 累计均值、preemptions（>0 = KV 池出现过抢占）
- 上游登记 `config.json` 的 `upstreams.*.metricsUrl` 即可获得同款面板（当前仅 x99）

**GPU 硬件探针**（`/api/x99/hardware`，2026-08-30 增）：
- 上游登记 `"hardware": {"sshHost": "x99"}` 后，网关经 ssh 在 GPU 主机上跑 nvidia-smi（BatchMode 免密），采集双卡温度/SM 频率/功耗/风扇/显存/利用率 + 降频原因（SW 功率墙 / SW·HW 热降频）
- 15s TTL 缓存 + 6s 超时；页面温度 ≥85°C 标红、有降频原因时红字警示
- 引擎挂死判别：`generationTokensTotal` 连续两次采样不增长 + running≥1

仪表盘每 30s 自动刷新；性能窗口与天窗口独立切换。

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


## pi footer 集成（可选）

`extensions/pi-footer.ts` 拷贝到 `~/.pi/agent/extensions/` 后，pi 状态栏会出现
`🔸TG 今日 Nreq ↑in ↓out c缓存 R推理 ¥成本` 行（全天累计，直读 NDJSON，不依赖网关进程存活；
message_end 即时刷新 + 60s 兜底）。附 `/gw-stats`（今日+近7天弹窗）、`/gw-refresh`。

## Roadmap

- [x] P1 多上游转发 + SSE usage 截获 + NDJSON 明细 + 仪表盘（GLM/DashScope 两路真机验证）
- [ ] P2 全量接入其余 CLI 工具（claude-code 经 cc-switch、codex、opencode）；tool 归因全覆盖
- [ ] P3 账单拉取（阿里云 BSS QueryInstanceBill 自动对账；人工录入兜底），偏差 >±10% 高亮
- [ ] P4 mitmdump addon 捕获不可配置的桌面应用流量（可选）

## 单价核对须知

prices.json 中 `"unverified": true` 的行是占位估计，页面上对应模型会带 ⚠ 标记。
请到各平台控制台核实后更新数值并删除该标记，否则成本估算可能失真。
