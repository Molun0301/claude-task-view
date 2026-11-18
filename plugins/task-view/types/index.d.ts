// 后台 shell 记录：由 Bash 调用结果登记，由任务完成通知更新
export type Shell = {
  id: string
  command: string
  description?: string
  // 由子代理启动时为该子代理的 id
  agentId?: string
  outputPath?: string
  // 从对话记录补登记的 shell 取输出文件创建时间，取不到时没有
  startedAt?: number
  endedAt?: number
  // running，或通知里写的 completed / failed / killed / stopped
  status: string
  exitCode?: number
}

// 见过的子代理。CC 会在子代理结束一段时间后把它移出 $.agent.list()，这里留存一份
export type SeenAgent = {
  id: string
  type: string
  description: string
  // AgentStatus；运行中被移出列表的记为 ended
  status: string
  // SendMessage 用的名字，团队成员显示为 @名字
  name?: string
  parentId?: string
  // 插件加载前就已启动的子代理没有起止时间
  startedAt?: number
  endedAt?: number
}

// 详情标签当前显示的条目
export type DetailTarget = { kind: 'agent' | 'shell'; id: string }

declare module 'claude-code' {
  interface PluginState {
    'task-view': {
      shells: Shaped<Shell[]>
      agents: Shaped<Record<string, SeenAgent>>
      detail: DetailTarget | null
      autoOpen: boolean
    }
  }
}
