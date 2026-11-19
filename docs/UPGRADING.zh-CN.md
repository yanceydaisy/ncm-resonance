# 升级到 NCM Resonance 0.6.0

0.6.0 将项目、官端组件与 Codex 客户端正式命名为 NCM Resonance。桥接工具现在使用 `ncm_resonance_` 前缀，打开官端组件使用 `open_ncm_resonance`。网易云工具名称保持 `netease_` 前缀。

## 数据目录

升级时保留现有 `BRIDGE_DB_PATH` 指向的数据库、Docker 挂载的数据卷、Codex 原生数据目录与登录配置。仓库名称、容器名称和数据库内容彼此独立；沿用原来的卷名与绝对数据路径即可。

文档中的新数据卷名称用于全新部署。已有部署不要创建空卷来替换当前数据卷。更新镜像时继续挂载原来的卷，原队列、会话绑定、生成结果与逐气泡回执就会继续使用。

本次没有重命名 SQLite 表，也不需要导出再导入数据库。数据库内原始消息与回复正文保持原样。

## 已连接的官端客户端

服务接收 `cove_bridge_` 与 `resonance_bridge_` 两代工具调用和 Widget 资源 URI，并在内部映射到新名称。工具与资源列表只展示新名称；新的模型上下文也使用新工具名。

重新挂载 Listener 后，浏览器会合并旧版与新版的已投递、待确认及待取消记录，写入新的本地键名。确认记录不会因更换名称而清空。

建议刷新 MCP 工具列表并重新挂载组件，使官端尽快显示新标题。升级期间仍应保持单一事件消费者。

## Codex 与 VPS Listener

已有 Codex thread 和生成任务继续使用，历史找回兼容旧版事件标记。部署者设置的指令文件与模型配置保持独立。

VPS 浏览器辅助文件改名为 `ncm-resonance-listener-host` 和 `ncm-resonance-listener.service`。已有浏览器配置目录可以通过 `NCM_RESONANCE_LISTENER_DIR` 或旧的 `RESONANCE_LISTENER_DIR` 指向原位置；同时把服务的 `ReadWritePaths` 设置为该位置。迁移服务名称前先停止原服务，避免两个浏览器进程同时打开同一配置目录。

GitHub 仓库改名不会清除提交历史。已有 checkout 可以更新远端地址。

```bash
git remote set-url origin https://github.com/yanceydaisy/ncm-resonance.git
```
