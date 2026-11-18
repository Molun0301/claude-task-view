# claude-task-view

Claude Code 侧边任务面板插件：查看子代理的完整执行过程，以及后台 shell 的完整命令和实时输出。

## 功能

- 总览列出本会话的子代理和后台 shell，状态用颜色区分（运行中、等待中、空闲、完成、失败、停止）。
- 点击子代理查看全部步骤；子代理结束并移出 Claude 自带列表后，仍可查看完整过程。
- 点击 shell 查看状态、完整命令、最近输出、退出码，可直接停止。
- 进入子代理视图时自动打开面板，回到主对话时自动关闭；手动关闭后本会话不再自动打开。
- 接管 `/tasks` 与 `/bashes`；`/task-view` 打开或关闭面板。

## 安装

需要支持插件面板的 Claude Code（已在 2.1.322 验证）。

```bash
claude plugin marketplace add Molun0301/claude-task-view
claude plugin install task-view@task-view
```

运行中的会话执行 `/reload-plugins` 生效。

## 开发检查

```bash
claude plugin validate .
claude plugin validate plugins/task-view
claude plugin test plugins/task-view
```

## 许可

MIT
