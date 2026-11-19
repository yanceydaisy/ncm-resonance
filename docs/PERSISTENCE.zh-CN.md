# SQLite 持久化与升级

0.3.0 默认使用 SQLite 保存 Bridge 事件与回复发送日志。部署使用 Node.js 22.16 或更新的 22.x，数据库路径通过 `BRIDGE_DB_PATH` 指定，默认 `./data/bridge.sqlite`。SQLite 使用 Node 内置驱动。

## 部署

常规部署保持启动命令 `npm start`，并让运行用户可以写入数据目录。数据库会自动建表。此前内存队列中的内容只能在旧进程仍运行时处理，升级前应完成当前回复。

Docker 需要保留数据目录，例如使用命名卷。

```bash
docker volume create ncm-resonance-data
docker run --env-file .env \
  -e BRIDGE_DB_PATH=/app/data/bridge.sqlite \
  -v ncm-resonance-data:/app/data \
  -p 8787:8787 ncm-resonance
```

数据库包含聊天与模型上下文，应按私人数据保存。备份时可以先停止服务再复制数据库，或通过 SQLite 在线备份接口生成一致快照。WAL 模式下，运行中的数据库可能同时使用 `-wal` 与 `-shm` 文件。

## 重启行为

- 待处理 Conversation 保持顺序，网易云来源消息按稳定 ID 去重。
- State 按 key 保留最新待处理值。新状态覆盖后，旧 reservation 会在恢复取数时被跳过。
- 已交给 Host 的 delivered 事件保留确认状态。
- Widget 重试 ACK 时使用原 eventId，本地投递记录继续拦截重复显示。
- Long-wait 返回 outstanding 事件的上下文、已保存回复与发送进度，模型继续处理原事件。
- 已收到 NIM 确认的气泡保留发送进度。
- 回复保存原房间身份，发送前校验当前连接。

同一队列继续沿用单活跃 Listener 的部署方式。Widget 与 Long-wait 各自使用既有确认工具。

## 发送回执不确定时

发送前先提交 `sendingIndex`。收到 NIM 回执后，在事务中保存回执、增加 `sentCount` 并清除发送标记。进程退出或网络断开后仍保留发送标记时，系统返回具体错误与恢复工具名。

人类先在网易云核实最后一条气泡，然后调用恢复工具记录结果。

```json
{
  "name": "ncm_resonance_recover_reply",
  "arguments": {
    "eventId": "原事件 ID",
    "lastBubbleDelivered": true
  }
}
```

`true` 表示已确认最后一条到达，会推进发送进度。`false` 表示已确认该条没有到达，会允许继续发送该条。该工具只记录核实结果。

恢复结果返回保存的 `messages`。之后将同一组文字传给 `ncm_resonance_reply`，系统会从确认后的进度继续。Long-wait 的 `awaitingReply` 结果也包含 `replyMessages`、`sentCount` 和 `deliveryUncertain`。

## 验证范围

自动测试覆盖真实 HTTP 服务进程被强制终止后的恢复、稳定事件身份、已完成去重、投递 ACK、部分回复进度、回执不确定、事务回滚与原房间校验。连接生命周期修复保留原有播放控制和主动退出测试。

SQLite 恢复通过本地自动测试验收。升级后的完整官端与真实网易云房间交互需要部署环境继续验收。
