# NCM Resonance｜网易云共振

把 ChatGPT 或 Codex 接进网易云音乐「一起听」。在网易云聊天室里说一句「下一首想听郭顶的《水星记》」，AI 就能搜索歌曲、把它排到下一首，再回到聊天室告诉你排好了。你切歌或暂停时，它也能收到播放状态，结合当前进度和可用歌词接着聊。

> 不搬 AI，给 AI 修路。

[查看 v2.1.0 Release](https://github.com/yanceydaisy/ncm-resonance/releases/tag/v2.1.0) · [更新日志](#更新日志)

## 选官端还是 Codex？

同一套桥接服务提供两种运行模式。网易云账号、音乐工具和 SQLite 队列的用法相同；区别在于**谁接收房间事件、在哪里生成回复**。每个运行实例通过 `BRIDGE_AI_BACKEND` 选择一种模式。

| | ChatGPT 官端（默认） | Codex 版 |
| --- | --- | --- |
| 回复在哪里生成 | 你选定的 ChatGPT 对话 | 运行服务的机器上，由 Bridge 调用官方 `codex app-server` |
| 怎么开始 | 在 ChatGPT 接入 MCP，再开启 Long-wait 或 Widget | 在服务机器上登录 Codex CLI，启动 Bridge；收到房间消息后自动处理 |
| 会话如何延续 | 由正在监听的 ChatGPT 对话承接 | 按网易云账号和聊天对象绑定 Codex thread，同一对听友换房后可接着聊 |
| 适合谁 | 想在 ChatGPT 网页、桌面或手机端使用的人 | 想直接在网易云里聊天、让服务自动接歌和回消息的人 |

## 两版都能做什么

- **一起听与聊天**：识别并接受邀请、进入房间、收发聊天室文字。回复绑定发出消息的房间，退出后会再次核实房间状态。
- **同步播放与歌词**：从网易云实时消息获取曲目、进度、暂停和继续状态，HTTP 用于校准和断线兜底。模型可读取可用的整首歌词及当前位置附近的歌词，音乐上下文来自元数据和歌词。
- **控制播放与队列**：暂停、继续、下一首、切到队内指定歌曲，或把歌曲插到下一首。播放操作等待实时状态确认；插歌后重新读取队列核对位置。
- **网易云账号工具**：搜索歌曲、查看和编辑歌单、喜欢或取消喜欢、查询听歌历史和每日推荐。

## 部署

使用 **Node.js 22.16 或更高的 22.x 版本**。下面的准备步骤两版通用。Docker 部署可直接参考对应模式的教程。

```bash
git clone https://github.com/yanceydaisy/ncm-resonance.git
cd ncm-resonance
cp .env.example .env
chmod 600 .env
npm ci
npm run build
```

在 `.env` 中填入用于一起听的 `NETEASE_COOKIE`（含 `MUSIC_U`），保留 `TOGETHER_ENABLED=true`，并将 `BRIDGE_INGEST_TOKEN` 的示例值换成长随机值。只接受指定账号的邀请时，填入对方的 `NETEASE_INVITER_UID`。Cookie、登录配置和包含聊天内容的数据库都应保存在部署者自己的机器上。

### ChatGPT 官端

1. 在 `.env` 设置 `BRIDGE_AI_BACKEND=chatgpt`，将 `BRIDGE_PUBLIC_ORIGIN` 填为 ChatGPT 能访问的 HTTPS 域名，例如 `https://bridge.example.com`。域名后不带 `/mcp`。
2. 配好 HTTPS 反向代理，在仓库目录运行 `node --env-file=.env dist/src/server.js`。在 ChatGPT 的 MCP 连接设置中填入 `https://bridge.example.com/mcp/music`；已有的通用入口 `/mcp` 也可用。对外提供 MCP 时，应在部署层限制访问；上述 token 保护事件写入和 Codex 管理接口。
3. 在目标对话中选择下列一种监听方式。同一个队列只运行一个监听器。

| 监听方式 | 在 ChatGPT 里怎么用 | 使用边界 |
| --- | --- | --- |
| **Long-wait MCP** | 说「开始持续监听网易云一起听，有消息就在原房间回复」。模型调用 `ncm_resonance_wait`，收到事件后确认，并在需要时回传。 | 需要一个正在运行的模型轮次。单次最多等 45 秒，超时后可按用户要求继续等待。 |
| **Widget Listener** | 请 ChatGPT 调用 `open_ncm_resonance` 打开组件，再点「开始监听」。 | 组件在挂载的对话中接收事件；投递行为取决于客户端。 |

**2026-10-07 重新实测**时，Widget Listener 已完成外部消息唤醒 ChatGPT、生成回复并沿原路回传的完整闭环，先前反复出现的 `ui/message` 人工确认不再复现。后续实测中，Widget Listener 和 Long-wait MCP 均可在 ChatGPT 网页端、桌面端和 iOS 端使用。详细配置见[官端部署教程](docs/GETTING_STARTED.zh-CN.md)。

### Codex 版

1. 用**运行 Bridge 的同一系统用户**安装并登录 Codex CLI。项目已验证的 CLI 版本为 `0.165.0`。

   ```bash
   npm install -g @openai/codex@0.165.0
   codex login --device-auth
   codex login status
   ```

2. 在 `.env` 设置 `BRIDGE_AI_BACKEND=codex`。`CODEX_MODEL` 留空时沿用 CLI 的模型配置；自定义指令可通过 `CODEX_INSTRUCTIONS_FILE` 指向本机文件。
3. 在仓库目录运行 `node --env-file=.env dist/src/server.js`。进入一起听房间后，直接从网易云发一条文字。Bridge 会启动 Codex 轮次，保存最终回复，再逐条发回原房间。

Codex 自己消费队列，无需打开 ChatGPT 或启动 Listener。连续切歌会合并，人类文字优先；单纯的播放状态变化允许安静陪听。可用 `GET /codex/status` 检查任务阶段和具体错误。项目已用真实 CLI 验证工具调用、重启续接和历史结果找回；公开版与真实网易云房间的完整联调仍待部署验收。Docker 挂载、状态查询与恢复命令见 [Codex 部署说明](docs/CODEX.zh-CN.md)。

## 数据与升级

两版默认都将事件、去重记录、回复正文和逐条发送回执写入 **SQLite**（`BRIDGE_DB_PATH`，默认 `./data/bridge.sqlite`）。运行用户需要对数据目录有写权限。回复中途重启时，已确认送达的部分保留进度；某条回执不确定时，先到网易云核实，再使用恢复工具记录结果。

已有部署升级请沿用**原数据库路径和 Docker 数据卷**。Codex 版还需保留原生 Codex 数据目录（含登录配置和 thread 历史）。改名后服务兼容旧工具调用和 Widget 资源地址，官端刷新工具列表即可看到新名称。[升级说明](docs/UPGRADING.zh-CN.md) · [备份与回复恢复](docs/PERSISTENCE.zh-CN.md)

## 更新日志

按公开发布标签倒序整理。

| 发布版本 | 主要变化 |
| --- | --- |
| [v2.1.0](https://github.com/yanceydaisy/ncm-resonance/releases/tag/v2.1.0) | 增加独立 Codex 后端、按聊天对象续接的 thread、播放状态自动处理；两版共用 SQLite 持久队列与逐条回复恢复。项目由「海湾共振」更名为「网易云共振」，公开桥接工具统一为 `ncm_resonance_` 前缀，兼容旧客户端与已有数据。 |
| [v2.0.0](https://github.com/yanceydaisy/ncm-resonance/releases/tag/v2.0.0) | 网易云实时消息成为播放状态的主要来源；加入带确认的播放与插歌操作、退出房间复核、音乐专用 `/mcp/music` 入口，以及官端 Long-wait 监听。[V2 验收记录](docs/V2.zh-CN.md) |
| [v1-public-preview](https://github.com/yanceydaisy/ncm-resonance/releases/tag/v1-public-preview) | 首次公开官端 Widget 链路：接受一起听邀请、双向聊天室、播放状态、歌词和账号工具。 |

## 实现与致谢

事件队列、监听确认与原房间回复的设计见[架构说明](docs/ARCHITECTURE_FOR_AGENTS.zh-CN.md)。

本项目参考了 [mcp-app-message-bridge](https://github.com/wynsyl1014/mcp-app-message-bridge)、[ncm-listen-together](https://github.com/wuxiandudang-hash/ncm-listen-together)、[galatea-garden-wake-bridge](https://github.com/WenXiaoWendy/galatea-garden-wake-bridge) 和 [netease-music-mcp](https://github.com/Vael-KY/netease-music-mcp)。

由 [Yancey](https://github.com/yanceydaisy) 维护，采用 [MIT License](LICENSE)。

