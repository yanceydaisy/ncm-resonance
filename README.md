# NCM Resonance

> **0.6.0 — NCM Resonance｜网易云共振，2026-11-20**
>
> 不搬 AI，给 AI 修路。

**NCM Resonance（网易云共振）** 是面向 NetEase Cloud Music「一起听」的 ChatGPT / Codex 桥接项目。它接通聊天室消息、播放状态、歌词、音乐控制和沿原房间返回的回复。

首个适配器支持网易云「一起听」：听见聊天室消息、知道正在播什么、读歌词、控制播放，再把回复沿原路送回去。

## 0.6.0 更新

项目正式命名为 **NCM Resonance（网易云共振）**，保留原名的 Resonance，并用 NCM 明确指向 NetEase Cloud Music。官端 Listener、Codex 后端、npm 包、部署示例与工具说明已统一。

新的桥接工具前缀为 `ncm_resonance_`，官端打开工具为 `open_ncm_resonance`。网易云工具使用当前连接的账号，不预设助手姓名或身份。

服务仍接受旧版客户端的工具调用与 Widget 资源请求，公开发现接口只展示新名称。旧版队列上下文、Listener 本地确认记录与 Codex 轮次标记均保留升级兼容。升级继续使用原来的数据库、Docker 数据卷和 Codex 数据目录即可，详见 [升级说明](docs/UPGRADING.zh-CN.md)。

## 0.5.0 更新

- 移除项目和网易云工具中的私人助手命名。
- 建立工具、Widget、本地确认记录与 Codex 历史标记的改名兼容层。

## 0.4.0 更新

新增可独立部署的 Codex 后端，直接连接 `codex app-server`。

- 网易云文字消息自动触发 Codex，最终回复沿原房间回传。
- 以账号与聊天对象绑定持久 thread，重新开一起听房间后延续同一会话。
- 切歌、暂停和继续播放触发状态唤醒。快速变化合并，人类消息优先，状态反应可以选择安静陪听。
- 复用网易云 MCP 工具与 SQLite 逐气泡回执，保存生成结果并恢复发送进度。
- 原生轮次中断后查询历史，找回已经完成的结果。无法确认的轮次需要显式重试。
- 提供状态、失败任务重试与发送回执恢复入口。

| `BRIDGE_AI_BACKEND` | 处理方式 |
| --- | --- |
| `chatgpt` | 默认模式，由官端 Widget 或 Long-wait 消费事件 |
| `codex` | Bridge 自动调度本机 Codex App Server |

部署步骤、登录、配置与验证范围见 [Codex 后端说明](docs/CODEX.zh-CN.md)。

## 0.3.0 更新

- 默认使用 SQLite 保存事件、投递确认、回复正文、逐气泡回执与去重记录。
- 重启后恢复待处理消息与回复进度，Long-wait 可以继续处理原事件。
- 发送前写入日志，收到 NIM 回执后提交进度。回执不确定时保留现场，核实后继续。
- 网易云消息使用稳定事件 ID，重连重放与重启后的重复消息都会经过持久化去重。
- 回复绑定原一起听房间，发送前校验目标。
- 同步连接停止、重启、旧异步回调过滤与 native runtime 清理修复。

部署需要 Node.js 22.16 或更新的 22.x。数据库默认保存在 `./data/bridge.sqlite`，可通过 `BRIDGE_DB_PATH` 配置。Docker 部署需要挂载数据目录。

升级与恢复操作见 [持久化说明](docs/PERSISTENCE.zh-CN.md)。

## V2 更新

这里的 V2 是相对最初公开版本 **`v1-public-preview`** 而言。

这一版主要完成了：

- **实时播放状态升级为主链路**：暂停、继续、切歌和播放进度优先由网易云实时消息驱动，HTTP 只负责房间状态、低频校准和断线兜底；
- 新增 **暂停、继续播放、切到指定歌曲、播放下一首、把歌曲插到下一首** 等一起听控制；
- 控制不会“请求发出去就算成功”，而是等待网易云实时回执；修改播放队列后也会重新读取一次，确认真的生效；
- **修复假切歌**：切到指定歌曲前先确认它确实在当前一起听队列里，避免出现“系统说切了，但手机其实没切”的情况；
- 新增独立 **`/mcp/music`** profile，同时保留 `/mcp` 兼容；
- 加固 Widget / Host 人工确认与事件终态处理；
- 新增并真实验收 **Long-wait MCP Listener**：`wait → ACK → reply → next wait`；
- 新增 **可靠退出一起听**：发出退出后再次确认房间状态，确保真的已经离开；
- 公开候选版 **78/78 tests passed，TypeScript build passed**。

完整 V2 变化、验收记录和 Roadmap：

**[docs/V2.zh-CN.md](docs/V2.zh-CN.md)**

Listener / Long-wait 的技术细节：

**[docs/ARCHITECTURE_FOR_AGENTS.zh-CN.md](docs/ARCHITECTURE_FOR_AGENTS.zh-CN.md)**

## 已实现

### Bridge

- Conversation / State 事件；
- Queue、reserve / release / ACK；
- required reply backpressure；
- routed reply、去重；
- poll / SSE / Widget / Long-wait Listener。

### 网易云一起听

- 邀请识别与自动接受；
- 自动进入房间，并能可靠退出一起听；
- ChatRoom 双向聊天；
- 实时感知暂停、继续、切歌和播放进度；
- 可以暂停、继续播放、切到指定歌曲、播放下一首、把歌曲插到下一首；
- 播放控制会等待网易云实时回执确认；
- 切歌前检查目标歌曲是否真的在当前队列里，避免假成功；
- 整首歌词 + 当前歌词上下文。

### 网易云账号

- 搜索歌曲；
- 歌单查看 / 创建 / 增删歌曲；
- 喜欢 / 取消喜欢；
- 听歌历史；
- 每日推荐；
- 账号基本信息。

### MCP

```text
/mcp
/mcp/music
```

公开版范围是 **Bridge + NetEase + default/music profiles**。

## 部署

V2 有两种正式监听方式，**二选一，不要同时开启**：

- **Widget Listener**：手机端可用；网页端实测会出现人工确认；桌面端当前不可用；
- **Long-wait MCP**：网页 / 桌面 / 手机均已实测可用，当前更适合多端使用。

完整教程：

**[docs/GETTING_STARTED.zh-CN.md](docs/GETTING_STARTED.zh-CN.md)**

架构与实现说明：

**[docs/ARCHITECTURE_FOR_AGENTS.zh-CN.md](docs/ARCHITECTURE_FOR_AGENTS.zh-CN.md)**

```bash
git clone https://github.com/yanceydaisy/ncm-resonance.git
cd ncm-resonance

cp .env.example .env
npm install
npm test
npm run build
```

## 下一步

当前可继续完善 Listener watchdog、多 Listener ownership、可观测性与部署体验。

历史 V2 路线图保存在 [V2 文档](docs/V2.zh-CN.md)，其中 SQLite 与回复日志已在 0.3.0 实现。

## 安全

- 不要提交网易云 Cookie 或 `BRIDGE_INGEST_TOKEN`；
- NIM credentials 不进入 Widget、模型上下文或日志；
- 发布前继续跑 test、build、diff / secret check。

## Credits

参考过：

- [wynsyl1014/mcp-app-message-bridge](https://github.com/wynsyl1014/mcp-app-message-bridge)
- [wuxiandudang-hash/ncm-listen-together](https://github.com/wuxiandudang-hash/ncm-listen-together)
- [WenXiaoWendy/galatea-garden-wake-bridge](https://github.com/WenXiaoWendy/galatea-garden-wake-bridge)
- [Vael-KY/netease-music-mcp](https://github.com/Vael-KY/netease-music-mcp)

## License

Licensed under the **MIT License**. See [LICENSE](LICENSE).

> **不搬 AI，给 AI 修路。**

Maintained by [Yancey](https://github.com/yanceydaisy).

