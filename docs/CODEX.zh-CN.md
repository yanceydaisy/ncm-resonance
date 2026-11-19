# Codex 后端

0.4.0 提供独立的 Codex Host Adapter。Bridge 接收网易云事件、管理 SQLite 队列，并通过官方 `codex app-server` 启动模型轮次。模型使用音乐工具，最终回复由 Bridge 保存并发回原一起听房间。

## 本机部署

先按 [部署教程](GETTING_STARTED.zh-CN.md) 安装项目与配置网易云。Codex CLI 应由运行 Bridge 的同一系统用户完成登录。

本次真实协议验收使用 Codex CLI 0.165.0，可以按该版本安装。

```bash
npm install -g @openai/codex@0.165.0
codex login --device-auth
codex login status
```

在环境文件中选择后端与模型配置。

```dotenv
BRIDGE_AI_BACKEND=codex
BRIDGE_DB_PATH=./data/bridge.sqlite
CODEX_BIN=codex
CODEX_MODEL=
CODEX_REASONING_EFFORT=medium
CODEX_WORKSPACE=./data/codex-workspace
CODEX_INSTRUCTIONS_FILE=
```

`CODEX_MODEL` 留空时使用 CLI 的模型配置。`CODEX_INSTRUCTIONS_FILE` 可以指向部署者自己的 UTF-8 指令文件，用来定义称呼、语言和交流方式。

按部署教程加载环境变量后启动。

```bash
npm test
npm run build
npm start
```

收到聊天后会自动建立会话。正常接受一起听邀请时，邀请者身份会用于会话绑定。服务重启并回到原房间时使用保存的房间绑定。首次接入一个已经存在的陌生房间时，收到第一条对方文字后可以建立绑定，或通过现有 `NETEASE_INVITER_UID` 配置指定聊天对象。

## Docker

构建带有 Codex CLI 的镜像，并保留 Bridge 与 Codex 两份数据目录。

```bash
docker build --build-arg INSTALL_CODEX=true -t ncm-resonance .
docker volume create ncm-resonance-data
docker volume create ncm-resonance-codex

docker run -d --name ncm-resonance --env-file .env \
  -e BRIDGE_AI_BACKEND=codex \
  -e BRIDGE_DB_PATH=/app/data/bridge.sqlite \
  -e CODEX_WORKSPACE=/app/data/codex-workspace \
  -v ncm-resonance-data:/app/data \
  -v ncm-resonance-codex:/root/.codex \
  -p 8787:8787 ncm-resonance

docker exec -it ncm-resonance codex login --device-auth
```

如果指令文件位于容器外，挂载该文件并将 `CODEX_INSTRUCTIONS_FILE` 指向容器中的路径。

## 数据与会话

SQLite 共用 `BRIDGE_DB_PATH`，新增的 `codex_conversations`、`codex_routes`、`codex_states`、`codex_jobs` 表保存聊天对象与 thread 绑定、生成进度、原生 turn ID、生成结果与播放状态去重记录。原有事件与逐气泡发送日志继续使用同一数据库。

Codex 自身保存原生历史。备份时同时保存 Bridge 数据库与 Codex 数据目录。线程恢复依赖原来的 Codex 数据与登录配置。

同一账号与聊天对象在新的一起听房间中复用同一个 thread。物理房间身份仍单独保存，用于检查回复的实际发送目标。

## 音乐唤醒与工具

人类文字按队列顺序处理。音乐状态有 1.5 秒合并窗口，快速切歌保留最新状态，重新连接时已经处理的相同状态会被去重。状态轮次可以返回空回复，表示安静陪听。人类消息到达时会中断正在生成的音乐状态反应。

每轮输入包含最新播放快照与可获得的歌词。音乐理解目前依赖元数据与歌词。

Codex 的动态工具复用网易云 MCP 的 schema、校验与实现。包括歌曲搜索、歌单、喜欢、当前播放信息与已确认的播放控制。最终回复由应用统一回传，工具过程留在运行时。

选择 Codex 模式后，公开 `/mcp` 与 `/mcp/music` 提供音乐控制及 `ncm_resonance_recover_reply`。事件由自动调度器消费。

## 状态与失败恢复

`GET /codex/status` 返回任务阶段、数量与具体错误。它使用 `BRIDGE_INGEST_TOKEN` 的 Bearer 认证。

```bash
curl -H "Authorization: Bearer $BRIDGE_INGEST_TOKEN" \
  http://127.0.0.1:8787/codex/status
```

生成结果会在发送前保存。原生连接中断后，Bridge 先按保存的 thread、turn ID 和事件标记读取原生历史。找到已完成结果后直接进入发送阶段。

未能确认先前轮次结果时，任务进入失败状态。先检查状态与可能已经执行的工具，再明确重新开始该轮。

```bash
curl -X POST -H "Authorization: Bearer $BRIDGE_INGEST_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"confirmRestart":true}' \
  http://127.0.0.1:8787/codex/jobs/EVENT_ID/retry
```

如果失败发生在轮次开始之前，重试请求可以使用空 JSON 对象。已有缓存回复时，重试继续发送阶段。

回执不确定的气泡需要先在网易云核实。可以调用 MCP 恢复工具，或通过 HTTP 记录核实结果。

```bash
curl -X POST -H "Authorization: Bearer $BRIDGE_INGEST_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"lastBubbleDelivered":true}' \
  http://127.0.0.1:8787/codex/jobs/EVENT_ID/recover
```

`true` 表示已确认最后一条到达，`false` 表示已确认没有到达。之后由调度器从保存的发送进度继续。完整逐气泡日志说明见 [持久化说明](PERSISTENCE.zh-CN.md)。

## 验证范围

自动测试覆盖真实子进程 stdio、工具回传、轮次身份、主动中断、原生结果找回、持久 thread 绑定、消息与状态调度、断线等待、原房间检查、长文本分气泡、逐气泡恢复与错误可见性。

真实 Codex CLI 0.165.0 已验证一次工具调用、停止并重启进程后延续原 thread、读取历史结果。该适配器使用官方文档中的实验性动态工具接口。

新版自动后端与真实网易云房间的完整联调仍需要部署环境验收。

官方协议参考见 [Codex App Server](https://developers.openai.com/codex/app-server/)。
