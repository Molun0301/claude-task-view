import { atom, read, update } from 'claude-code'
import type {
  AgentInfo,
  EngineInterface,
  Register,
  RenderChildren,
  SessionMessage,
} from 'claude-code'

import type { DetailTarget, SeenAgent, Shell } from '../types'

// 总览面板只放列表；详情面板是第二个标签，两个都打开时引擎画出不随内容滚动的标签行
const PANE = 'task-view'
const DETAIL = 'task-view-detail'
const TITLE = '任务'

// 会话级状态：插件重载后仍保留
const shells = atom({ plugin: 'task-view', key: 'shells' } as const, [] as Shell[], {
  shape: 'shells-1',
})
const agents = atom(
  { plugin: 'task-view', key: 'agents' } as const,
  {} as Record<string, SeenAgent>,
  { shape: 'agents-1' },
)
// 详情标签当前显示的子代理或 shell
const detail = atom({ plugin: 'task-view', key: 'detail' } as const, null as DetailTarget | null)
// 进入子代理视图时是否自动打开面板；用户手动关闭后置为 false
const autoOpen = atom({ plugin: 'task-view', key: 'autoOpen' } as const, true)

const ACTIVE = new Set(['pending', 'running', 'waiting'])

// 状态的图标、颜色和文字，子代理与 shell 共用
const LOOK: Record<string, { icon: string; color: string; label: string }> = {
  pending: { icon: '◌', color: 'warning', label: '启动中' },
  running: { icon: '●', color: 'warning', label: '运行中' },
  waiting: { icon: '◐', color: 'suggestion', label: '等待中' },
  idle: { icon: '○', color: 'inactive', label: '空闲' },
  completed: { icon: '✓', color: 'success', label: '已完成' },
  failed: { icon: '✗', color: 'error', label: '失败' },
  killed: { icon: '■', color: 'inactive', label: '已停止' },
  stopped: { icon: '■', color: 'inactive', label: '已中止' },
  ended: { icon: '■', color: 'inactive', label: '已结束' },
}

function look(status: string): { icon: string; color: string; label: string } {
  return LOOK[status] ?? { icon: '·', color: 'inactive', label: status }
}

// 不同类型的工具用不同颜色，便于扫一眼分辨
function toolColor(tool: string): string {
  if (tool === 'Bash') return 'bashBorder'
  if (['Read', 'Grep', 'Glob', 'LS'].includes(tool)) return 'suggestion'
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) return 'autoAccept'
  if (tool === 'Agent' || tool === 'Task') return 'claude'
  if (tool.startsWith('Web')) return 'planMode'
  return 'permission'
}

// 后台命令的返回文字都带 “ID: <id>” 和 “Output is being written to: <路径>”
const BACKGROUND_RE = /ID: ([\w-]+)[\s\S]*?Output is being written to: (\S+?\.output)/

type Step =
  | { kind: 'prompt' | 'text' | 'user'; text: string }
  | {
      kind: 'tool'
      tool: string
      summary: string
      note?: string
      result?: string
      isError: boolean
      isRunning: boolean
    }

function fmtDur(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

function span(t: { startedAt?: number; endedAt?: number } | undefined, now: number): string {
  if (!t?.startedAt) return ''
  return fmtDur((t.endedAt ?? now) - t.startedAt)
}

// 去掉终端控制符：颜色、光标移动，以及 \r 覆盖掉的进度条旧内容
function cleanLines(raw: string): string[] {
  const lines = raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    .split('\n')
    .map(line => {
      const parts = line.split('\r')
      let last = parts.pop() ?? ''
      while (last === '' && parts.length > 0) last = parts.pop() ?? ''
      return last
        .replace(/\t/g, '    ')
        .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
        .trimEnd()
    })
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

async function tailLines(
  $: EngineInterface,
  path: string,
  count: number,
  bytes = 131072,
): Promise<string[]> {
  try {
    const r = await $.process.run(['tail', '-c', String(bytes), path], { timeoutMs: 3000 })
    if (r.exitCode !== 0) return [`（读取输出失败：${r.stderr.trim()}）`]
    return cleanLines(r.stdout).slice(-count)
  } catch (err) {
    // 渲染中抛错会让引擎关闭面板，这里把错误显示出来
    return [`（读取输出失败：${String(err)}）`]
  }
}

function stripReminders(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
}

function clip(text: string, max: number): string {
  const lines = text.split('\n')
  if (lines.length <= max) return text
  return [...lines.slice(0, max), `……（还有 ${lines.length - max} 行）`].join('\n')
}

function lastLines(text: string, count: number): string[] {
  return cleanLines(text)
    .filter(line => line.trim() !== '')
    .slice(-count)
}

function summarize(tool: string, input: Record<string, unknown>): string {
  const s = (k: string): string | undefined =>
    typeof input[k] === 'string' ? (input[k] as string) : undefined
  switch (tool) {
    case 'Bash':
      return s('command') ?? ''
    case 'Read':
    case 'Write':
    case 'Edit':
      return s('file_path') ?? ''
    case 'NotebookEdit':
      return s('notebook_path') ?? ''
    case 'Grep':
    case 'Glob':
      return [s('pattern'), s('path'), s('glob')].filter(Boolean).join('  ')
    case 'WebFetch':
      return s('url') ?? ''
    case 'WebSearch':
      return s('query') ?? ''
    case 'Agent':
      return [s('subagent_type'), s('description')].filter(Boolean).join(' · ')
    case 'Skill':
      return s('skill') ?? ''
    default: {
      const json = JSON.stringify(input)
      return json.length > 400 ? `${json.slice(0, 400)}…` : json
    }
  }
}

function toSteps(messages: readonly SessionMessage[], isActive: boolean): Step[] {
  const steps: Step[] = []
  let hasPrompt = false
  for (const m of messages) {
    if (m.role === 'user') {
      const text = stripReminders(m.text)
      if (!text) continue
      steps.push({ kind: hasPrompt ? 'user' : 'prompt', text })
      hasPrompt = true
      continue
    }
    const text = m.text.trim()
    if (text) steps.push({ kind: 'text', text })
    for (const use of m.toolUses) {
      const note = use.tool === 'Bash' ? use.input.description : undefined
      steps.push({
        kind: 'tool',
        tool: use.tool,
        summary: summarize(use.tool, use.input),
        ...(typeof note === 'string' ? { note } : {}),
        ...(use.text !== undefined ? { result: use.text } : {}),
        isError: use.isError === true,
        isRunning: use.text === undefined && isActive,
      })
    }
  }
  return steps
}

type Notice = { id: string; status: string; exitCode?: number }

// 解析 <task-notification>：任务 id、结束状态、退出码
function parseNotices(text: string): Notice[] {
  if (!text.includes('<task-notification>')) return []
  const notices: Notice[] = []
  for (const block of text.split('<task-notification>').slice(1)) {
    const id = block.match(/<task-id>([^<]+)<\/task-id>/)?.[1]?.trim()
    const status = block.match(/<status>([^<]+)<\/status>/)?.[1]?.trim()
    if (!id || !status) continue
    const code = block.match(/exit code (-?\d+)/)?.[1]
    notices.push({ id, status, ...(code ? { exitCode: Number(code) } : {}) })
  }
  return notices
}

async function finishShell(
  $: EngineInterface,
  id: string,
  patch: { status: string; exitCode?: number },
  endedAt?: number,
): Promise<void> {
  const at = endedAt ?? (await $.clock.now())
  await update($, shells, list =>
    list.map(s => (s.id === id && s.status === 'running' ? { ...s, ...patch, endedAt: at } : s)),
  )
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(b => (b && typeof b === 'object' && typeof b.text === 'string' ? b.text : ''))
    .join('\n')
}

// 渲染时记下 CC 主界面当前显示的子代理，定时器据此打开或关闭它的详情标签
let viewedAgent: string | undefined
let lastView: string | undefined
// 详情标签是否因为进入 CC 自带的子代理视图而自动打开
let detailFromView = false
// 详情已滚到末尾的条目；换条目或重新打开时再滚
let scrolledFor = ''
// 刚打开的标签可能还没排好版或还没切到前面，滚动要在接下来几次定时器里重复
let scrollTries = 0
let ticking = false
let discovering = false

function merge(old: SeenAgent | undefined, a: AgentInfo): SeenAgent {
  return {
    ...old,
    id: a.id,
    type: a.type,
    description: a.description,
    status: a.status,
    ...(a.name ? { name: a.name } : {}),
    ...(a.parentId ? { parentId: a.parentId } : {}),
  }
}

// 把 $.agent.list() 的变化写进子代理记录，顺带记下结束时间
async function syncAgents($: EngineInterface): Promise<AgentInfo[]> {
  const live = await $.agent.list()
  const seen = await read($, agents)
  const now = await $.clock.now()
  const patch: Record<string, SeenAgent> = {}
  for (const a of live) {
    const old = seen[a.id]
    if (old && old.status === a.status && old.description === a.description) continue
    const next = merge(old, a)
    if (!ACTIVE.has(a.status) && next.startedAt && !next.endedAt) next.endedAt = now
    patch[a.id] = next
  }
  // 运行中却已不在列表里：CC 已移除它的任务
  for (const old of Object.values(seen)) {
    if ((old.status === 'running' || old.status === 'waiting') && !live.some(a => a.id === old.id)) {
      patch[old.id] = { ...old, status: 'ended', ...(old.endedAt ? {} : { endedAt: now }) }
    }
  }
  if (Object.keys(patch).length > 0) await update($, agents, cur => ({ ...cur, ...patch }))
  return live
}

// 输出文件的创建时间和最后写入时间（毫秒）；文件系统不记录创建时间时 born 为 0
async function fileTimes($: EngineInterface, path: string): Promise<{ born: number; mtime: number }> {
  const r = await $.process.run(['stat', '-c', '%W %Y', path], { timeoutMs: 3000 })
  const [born = 0, mtime = 0] = r.stdout.trim().split(' ').map(Number)
  return { born: born * 1000, mtime: mtime * 1000 }
}

// CC 在 shell 结束时往输出文件末尾写 [exited with code N] 或 [killed]
async function endMark(
  $: EngineInterface,
  path: string,
): Promise<{ status: string; exitCode?: number } | undefined> {
  const last = (await tailLines($, path, 3, 512)).filter(l => l.trim()).pop() ?? ''
  const exited = last.match(/^\[exited with code (-?\d+)\]$/)
  if (exited) {
    const code = Number(exited[1])
    return { status: code === 0 ? 'completed' : 'failed', exitCode: code }
  }
  return last === '[killed]' ? { status: 'killed' } : undefined
}

// 从原版对话框停止等情况不一定有结束通知，以输出文件末尾为准补上状态
async function syncShellEnds($: EngineInterface): Promise<void> {
  const running = (await read($, shells)).filter(s => s.status === 'running')
  for (const s of running) {
    if (!s.outputPath) continue
    const end = await endMark($, s.outputPath)
    if (end) await finishShell($, s.id, end, (await fileTimes($, s.outputPath)).mtime)
  }
}

// 补登记插件加载前启动的后台 shell：CC 没有列出后台 shell 的接口，
// 从主对话和各子代理的记录里找后台 Bash 的返回文字
async function discoverShells($: EngineInterface): Promise<void> {
  const known = new Set((await read($, shells)).map(s => s.id))
  const ids = new Set([...(await $.agent.list()).map(a => a.id), ...Object.keys(await read($, agents))])
  const sources: { agentId?: string; msgs: readonly SessionMessage[] }[] = [
    { msgs: await $.session.messages() },
  ]
  for (const agentId of ids) {
    const msgs = await $.session.messages({ agentId })
    if (Array.isArray(msgs)) sources.push({ agentId, msgs })
  }

  const notices = new Map<string, Notice>()
  const found: Shell[] = []
  for (const { agentId, msgs } of sources) {
    for (const m of msgs) {
      for (const n of parseNotices(m.text)) notices.set(n.id, n)
      for (const use of m.toolUses) {
        const hit = use.tool === 'Bash' ? use.text?.match(BACKGROUND_RE) : undefined
        if (!hit?.[1] || !hit[2] || known.has(hit[1]) || found.some(s => s.id === hit[1])) continue
        const description = use.input.description
        found.push({
          id: hit[1],
          command: typeof use.input.command === 'string' ? use.input.command : '',
          status: 'running',
          outputPath: hit[2],
          ...(typeof description === 'string' ? { description } : {}),
          ...(agentId ? { agentId } : {}),
        })
      }
    }
  }

  for (const s of found) {
    const path = s.outputPath ?? ''
    if (!(await $.fs.exists(path))) {
      // 输出文件已不在：上一个进程留下的任务
      Object.assign(s, notices.get(s.id) ?? { status: 'stopped' })
      continue
    }
    const { born, mtime } = await fileTimes($, path)
    if (born > 0) s.startedAt = born
    const end = notices.get(s.id) ?? (await endMark($, path))
    if (end) Object.assign(s, { status: end.status, endedAt: mtime }, end.exitCode !== undefined ? { exitCode: end.exitCode } : {})
  }
  if (found.length > 0) await update($, shells, list => [...list, ...found].slice(-50))

  // 已登记但漏掉结束通知的，也按记录里的通知补上
  for (const n of notices.values()) {
    if (known.has(n.id)) await finishShell($, n.id, n)
  }
}

function startDiscover($: EngineInterface): void {
  if (discovering) return
  discovering = true
  discoverShells($)
    .catch(err => $.ui.log(`task-view: 补登记 shell 失败：${String(err)}`, { to: 'debug' }))
    .finally(() => {
      discovering = false
    })
}

// 停止后台 shell 或后台子代理，与原版任务对话框的 x 相同
async function stopTask($: EngineInterface, id: string): Promise<void> {
  const r = await $.tool.call({ tool: 'TaskStop', task_id: id })
  if (r.deny !== undefined) $.ui.toast(`停止失败：${r.deny}`)
  else if (r.isError) $.ui.toast(`停止失败：${r.text ?? ''}`)
  else await finishShell($, id, { status: 'killed' })
}

function shortTitle(text: string): string {
  const line = text.split('\n')[0] ?? ''
  return line.length > 14 ? `${line.slice(0, 14)}…` : line
}

async function detailTitle($: EngineInterface, t: DetailTarget): Promise<string> {
  if (t.kind === 'agent') {
    const a = (await read($, agents))[t.id] ?? (await $.agent.list()).find(x => x.id === t.id)
    return `子代理 · ${shortTitle(a ? (a.name ? `@${a.name}` : a.description) : t.id)}`
  }
  const sh = (await read($, shells)).find(x => x.id === t.id)
  return `Shell · ${shortTitle(sh ? (sh.description ?? sh.command) : t.id)}`
}

// 打开某个条目的详情标签。新开的面板只有在没有面板拿着键盘时才会显示在最前面，
// 所以先关掉旧的详情；任务列表拿着键盘时也关掉重开，把键盘还给输入框
async function showDetail($: EngineInterface, target: DetailTarget, focus: boolean): Promise<void> {
  const panes = await $.ui.panes()
  if (panes.some(p => p.id === DETAIL)) await $.ui.close({ id: DETAIL })
  if (panes.find(p => p.id === PANE)?.isFocused) {
    await $.ui.close({ id: PANE })
    await $.ui.open({ id: PANE, title: TITLE })
  }
  await update($, detail, () => target)
  const title = await detailTitle($, target)
  await $.ui.open(focus ? { id: DETAIL, title, focus: true } : { id: DETAIL, title })
}

// 回到任务列表：确保总览打开，再关掉详情标签
async function backToList($: EngineInterface): Promise<void> {
  await $.ui.open({ id: PANE, title: TITLE })
  await $.ui.close({ id: DETAIL })
}

// /tasks 与 /bashes 改为打开任务列表，并把键盘焦点交给面板
async function openForTasks($: EngineInterface): Promise<{ text?: string }> {
  await update($, autoOpen, () => true)
  if ((await $.ui.panes()).some(p => p.id === DETAIL)) await $.ui.close({ id: DETAIL })
  const opened = await $.ui.open({ id: PANE, title: TITLE, focus: true })
  startDiscover($)
  // 打开了面板就不输出文字，避免在对话里留下一行
  return opened.isPlaced ? {} : { text: `任务面板暂未显示：${opened.reason}` }
}

async function tick($: EngineInterface): Promise<void> {
  const live = await syncAgents($)
  const panes = await $.ui.panes()
  const hasList = panes.some(p => p.id === PANE)
  const hasDetail = panes.some(p => p.id === DETAIL)

  // 跟随 CC 自带的子代理视图：进入时打开它的详情，回到主对话时关掉自动打开的那个
  if (viewedAgent !== lastView) {
    lastView = viewedAgent
    if (viewedAgent && (hasList || hasDetail || (await read($, autoOpen)))) {
      await showDetail($, { kind: 'agent', id: viewedAgent }, false)
      detailFromView = true
    } else if (!viewedAgent && detailFromView && hasDetail) {
      await $.ui.close({ id: DETAIL })
    }
    return
  }
  if (!panes.some(p => p.isShown)) return

  await syncShellEnds($)
  const list = await read($, shells)
  if (live.some(a => ACTIVE.has(a.status)) || list.some(s => s.status === 'running')) {
    $.ui.invalidate('ui.render')
  }

  // 详情换了条目时滚到最新，之后由引擎跟随末尾；标签切到前面并滚动成功才算数
  const target = await read($, detail)
  const key = target ? `${target.kind}:${target.id}` : ''
  const detailPane = panes.find(p => p.id === DETAIL)
  if (detailPane && key !== scrolledFor) {
    scrolledFor = key
    scrollTries = 2
  }
  if (detailPane?.isShown && scrollTries > 0) {
    // 面板拿着键盘时，终端会把焦点所在的元素保持在可见范围；先把焦点移到底部的返回按钮
    if (detailPane.isFocused) await $.ui.focus({ requestId: DETAIL, key: 'back-bottom' })
    const r = await $.ui.scroll({ in: DETAIL, to: 'end' })
    if (!r.deny) scrollTries -= 1
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'task-view',
      description: '打开或关闭任务面板：子代理完整过程、后台 shell 完整命令与输出',
    })
    $.clock.every(1000, () => {
      if (ticking) return
      ticking = true
      tick($)
        .catch(err => $.ui.log(`task-view: ${String(err)}`, { to: 'debug' }))
        .finally(() => {
          ticking = false
        })
    })
    // 插件重载或恢复会话时，补登记之前已启动的后台 shell
    startDiscover($)
    return next(e)
  })

  on('command.run', { command: 'task-view' }, async $ => {
    const open = (await $.ui.panes()).filter(p => p.id === PANE || p.id === DETAIL)
    if (open.length > 0) {
      await update($, autoOpen, () => false)
      for (const pane of open) await $.ui.close({ id: pane.id })
      return {}
    }
    await update($, autoOpen, () => true)
    const opened = await $.ui.open({ id: PANE, title: TITLE })
    startDiscover($)
    return opened.isPlaced ? {} : { text: `任务面板暂未显示：${opened.reason}` }
  })

  // 接管原版入口；/tasks raw 仍打开原版对话框
  on('command.run', { command: 'tasks' }, async ($, e, next) =>
    e.args.trim() === 'raw' ? next({ ...e, args: '' }) : openForTasks($),
  ).catch(($, e, next) => next(e))
  on('command.run', { command: 'bashes' }, async ($, e, next) =>
    e.args.trim() === 'raw' ? next({ ...e, args: '' }) : openForTasks($),
  ).catch(($, e, next) => next(e))

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') await update($, autoOpen, () => false)
    if (e.id === DETAIL) {
      detailFromView = false
      scrolledFor = ''
      await update($, detail, () => null)
    }
    return next(e)
  })

  // 记录子代理开始时间
  on('agent.spawn', async ($, e, next) => {
    const startedAt = await $.clock.now()
    const r = await next(e)
    if (r.agentId) {
      const record: SeenAgent = {
        id: r.agentId,
        type: e.subagentType || 'general-purpose',
        description: e.description,
        status: 'pending',
        ...(e.parentAgentId ? { parentId: e.parentAgentId } : {}),
        startedAt,
      }
      await update($, agents, cur => ({ ...cur, [record.id]: { ...cur[record.id], ...record } }))
    }
    return r
  }).catch(($, e, next) => next(e))

  // 登记后台 shell：模型直接后台运行、用户按 ctrl+b、超时转后台都会带 backgroundTaskId
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const startedAt = await $.clock.now()
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    const id = ran.result.backgroundTaskId
    if (!id) return ran

    const outputPath = ran.text?.match(BACKGROUND_RE)?.[2]
    const shell: Shell = {
      id,
      command: e.command,
      startedAt,
      status: 'running',
      ...(e.description ? { description: e.description } : {}),
      ...(e.agentId ? { agentId: e.agentId } : {}),
      ...(outputPath ? { outputPath } : {}),
    }
    await update($, shells, list => [...list.filter(s => s.id !== id), shell].slice(-50))
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TaskStop' }, async ($, e, next) => {
    const ran = await next(e)
    const id = e.task_id ?? e.shell_id
    if (id && ran.deny === undefined && !ran.isError) await finishShell($, id, { status: 'killed' })
    return ran
  }).catch(($, e, next) => next(e))

  // 后台任务结束时会追加一条 <task-notification>，从中取状态和退出码
  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    for (const n of parseNotices(textOf(e.message.content))) await finishShell($, n.id, n)
    return stored
  })

  // 只用来得知当前视图（主对话或某个子代理），横条本身照原样绘制
  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    viewedAgent = e.props.view.agentId
    return next(e)
  })


  // ---- 任务列表：子代理 + 后台 shell，点击条目打开详情标签 ----
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    viewedAgent = e.props.view.agentId
    const now = await $.clock.now()
    const live = await $.agent.list()
    const seen = await read($, agents)
    const all: SeenAgent[] = [
      ...live.map(a => merge(seen[a.id], a)),
      ...Object.values(seen).filter(s => !live.some(a => a.id === s.id)),
    ]
    const current = await read($, detail)
    const isCurrent = (kind: DetailTarget['kind'], id: string) =>
      current?.kind === kind && current.id === id

    const heading = (title: string, summary: string) => (
      <Box marginBottom={1}>
        <Text>
          <Text color="claude" bold>
            ▍{title}
          </Text>
          <Text color="inactive">  {summary}</Text>
        </Text>
      </Box>
    )
    // “1 运行中 · 2 空闲” 这样的计数
    const countBy = (statuses: string[]): string => {
      const counts = new Map<string, number>()
      for (const s of statuses) counts.set(look(s).label, (counts.get(look(s).label) ?? 0) + 1)
      return [...counts].map(([label, n]) => `${n} ${label}`).join(' · ') || '暂无'
    }

    const order = (status: string) => (ACTIVE.has(status) ? 0 : 1)
    const agentList = [...all]
      .sort((a, b) => order(a.status) - order(b.status) || (b.startedAt ?? 0) - (a.startedAt ?? 0))
      .slice(0, 30)
    const latest = new Map<string, Step>()
    for (const a of agentList.filter(x => ACTIVE.has(x.status))) {
      const msgs = await $.session.messages({ agentId: a.id })
      const step = Array.isArray(msgs) ? toSteps(msgs, true).pop() : undefined
      if (step) latest.set(a.id, step)
    }
    const depthOf = (a: SeenAgent): number => {
      let depth = 0
      let parent = a.parentId
      while (parent && depth < 4) {
        depth += 1
        parent = all.find(x => x.id === parent)?.parentId
      }
      return depth
    }
    const agentTitle = (id: string): string => {
      const a = all.find(x => x.id === id)
      if (!a) return `子代理 ${id}`
      return a.name ? `@${a.name}` : a.description
    }

    const shellList = [...(await read($, shells))]
      .sort(
        (a, b) =>
          (a.status === 'running' ? 0 : 1) - (b.status === 'running' ? 0 : 1) ||
          (b.startedAt ?? 0) - (a.startedAt ?? 0),
      )
      .slice(0, 12)
    const previews = new Map<string, string[]>()
    for (const s of shellList) {
      if (!s.outputPath) continue
      const lines = await tailLines($, s.outputPath, 30)
      previews.set(
        s.id,
        lines.filter(line => line.trim() !== '').slice(s.status === 'running' ? -4 : -2),
      )
    }

    const latestLine = (step: Step) =>
      step.kind === 'tool' ? (
        <Text wrap="truncate-end">
          <Text color="inactive">{step.isRunning ? '↳ 正在 ' : '↳ 刚完成 '}</Text>
          <Text color={toolColor(step.tool)}>{step.tool}</Text>
          <Text color="inactive">  {step.summary.split('\n')[0]}</Text>
        </Text>
      ) : (
        <Text color="inactive" wrap="truncate-end">
          ↳ {step.text.split('\n')[0]}
        </Text>
      )

    return (
      <Box flexDirection="column">
        {heading('子代理', countBy(all.map(a => a.status)))}
        {agentList.map(a => {
          const st = look(a.status)
          const step = latest.get(a.id)
          const meta = [a.name ? `@${a.name}` : '', a.type, span(a, now)].filter(Boolean).join(' · ')
          return (
            <Box flexDirection="column" paddingLeft={depthOf(a) * 2} marginBottom={1}>
              <Box gap={2}>
                <Button
                  key={`agent-${a.id}`}
                  plain
                  onPress={() => showDetail($, { kind: 'agent', id: a.id }, true)}
                >
                  <Text color={st.color}>
                    {st.icon} {st.label}
                  </Text>
                  {'  '}
                  <Text bold color={isCurrent('agent', a.id) ? 'suggestion' : 'text'}>
                    {a.description}
                  </Text>
                  <Text color="suggestion">  ›</Text>
                </Button>
                {ACTIVE.has(a.status) ? (
                  <Button key={`stop-${a.id}`} plain onPress={() => stopTask($, a.id)}>
                    <Text color="error">■ 停止</Text>
                  </Button>
                ) : null}
              </Box>
              <Text color="inactive">  {meta}</Text>
              {step ? <Box paddingLeft={2}>{latestLine(step)}</Box> : null}
            </Box>
          )
        })}

        {heading('后台 Shell', countBy(shellList.map(s => s.status)))}
        {shellList.map(s => {
          const st = look(s.status)
          const lines = previews.get(s.id) ?? []
          const owner = s.agentId ? agentTitle(s.agentId) : '主对话'
          const meta = [span(s, now), owner, s.id].filter(Boolean).join(' · ')
          return (
            <Box flexDirection="column" marginBottom={1}>
              <Box gap={2}>
                <Button
                  key={`shell-${s.id}`}
                  plain
                  onPress={() => showDetail($, { kind: 'shell', id: s.id }, true)}
                >
                  <Text color={st.color}>
                    {st.icon} {st.label}
                    {s.exitCode !== undefined && s.exitCode !== 0 ? `（退出码 ${s.exitCode}）` : ''}
                  </Text>
                  {'  '}
                  <Text bold color={isCurrent('shell', s.id) ? 'suggestion' : 'text'}>
                    {s.description ?? s.command.split('\n')[0]}
                  </Text>
                  <Text color="suggestion">  ›</Text>
                </Button>
                {s.status === 'running' ? (
                  <Button key={`stop-${s.id}`} plain onPress={() => stopTask($, s.id)}>
                    <Text color="error">■ 停止</Text>
                  </Button>
                ) : null}
              </Box>
              <Text color="inactive">  {meta}</Text>
              <Box paddingLeft={2}>
                <Text wrap="truncate-end">
                  <Text color="bashBorder">$ </Text>
                  {s.command.split('\n')[0]}
                </Text>
              </Box>
              {lines.length > 0 ? (
                <Box paddingLeft={2} flexDirection="column">
                  {lines.map(line => (
                    <Text wrap="truncate-end">
                      <Text color="subtle">│ </Text>
                      <Text color="inactive">{line}</Text>
                    </Text>
                  ))}
                </Box>
              ) : null}
            </Box>
          )
        })}

        <Text color="inactive">
          点条目进入详情，点顶部「任务」标签或 ✕ 返回 · <Text color="suggestion">ctrl+x tab</Text>{' '}
          用键盘操作 · <Text color="suggestion">/tasks raw</Text> 原版
        </Text>
      </Box>
    )
  })

  // ---- 详情标签：一个子代理的完整过程，或一个 shell 的完整命令与输出 ----
  on('ui.render', { component: 'Pane', requestId: DETAIL }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    viewedAgent = e.props.view.agentId
    const now = await $.clock.now()
    const target = await read($, detail)

    // 顶部和底部各一个返回按钮；标签行由引擎绘制，始终可见
    // 顶部和底部各一组，按钮 key 用后缀区分
    const nav = (suffix: string, extra?: RenderChildren) => (
      <Box gap={3}>
        <Button key={`back${suffix}`} plain hotkey="b" onPress={() => backToList($)}>
          <Text color="suggestion" bold>
            ‹ 返回任务列表
          </Text>
        </Button>
        {extra}
      </Box>
    )
    const stopButton = (id: string, suffix: string) => (
      <Button key={`stop${suffix}`} plain onPress={() => stopTask($, id)}>
        <Text color="error">■ 停止</Text>
      </Button>
    )
    const card = (color: string, title: string, line: RenderChildren) => (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={color}
        paddingX={1}
        marginTop={1}
        marginBottom={1}
      >
        <Text bold>{title}</Text>
        {line}
      </Box>
    )

    if (!target) {
      return (
        <Box flexDirection="column">
          {nav('')}
          <Text color="inactive">没有选中的条目。</Text>
        </Box>
      )
    }

    // ---- shell 详情 ----
    if (target.kind === 'shell') {
      const s = (await read($, shells)).find(x => x.id === target.id)
      if (!s) {
        return (
          <Box flexDirection="column">
            {nav('')}
            <Text color="inactive">找不到 shell {target.id}。</Text>
          </Box>
        )
      }
      const st = look(s.status)
      const isRunning = s.status === 'running'
      const lines = s.outputPath ? await tailLines($, s.outputPath, 200) : []
      const agentsSeen = await read($, agents)
      const owner = s.agentId
        ? (agentsSeen[s.agentId]?.description ?? `子代理 ${s.agentId}`)
        : '主对话'
      const meta = [span(s, now), owner, s.id].filter(Boolean).join(' · ')
      return (
        <Box flexDirection="column">
          {nav('', isRunning ? stopButton(s.id, '') : null)}
          {card(
            st.color,
            s.description ?? `Shell ${s.id}`,
            <Text>
              <Text color={st.color}>
                {st.icon} {st.label}
                {s.exitCode !== undefined ? `（退出码 ${s.exitCode}）` : ''}
              </Text>
              <Text color="inactive">  {meta}</Text>
            </Text>,
          )}
          <Text color="permission" bold>
            ▍命令
          </Text>
          <Box paddingLeft={2} marginBottom={1}>
            <Text>
              <Text color="bashBorder">$ </Text>
              {s.command}
            </Text>
          </Box>
          <Text>
            <Text color="permission" bold>
              ▍输出
            </Text>
            <Text color="inactive">
              {'  '}最近 {lines.length} 行{s.outputPath ? ` · ${s.outputPath}` : ''}
            </Text>
          </Text>
          <Box borderStyle="round" borderColor="subtle" paddingX={1} marginBottom={1}>
            <Text color="inactive">
              {s.outputPath ? lines.join('\n') || '（还没有输出）' : '（未找到输出文件）'}
            </Text>
          </Box>
          {isRunning ? <Text color="warning">● 仍在运行，每秒刷新</Text> : null}
          <Box marginTop={1}>{nav('-bottom', isRunning ? stopButton(s.id, '-bottom') : null)}</Box>
        </Box>
      )
    }

    // ---- 子代理详情 ----
    const live = await $.agent.list()
    const seen = await read($, agents)
    const liveInfo = live.find(a => a.id === target.id)
    const info = liveInfo ? merge(seen[target.id], liveInfo) : seen[target.id]
    const isActive = info ? ACTIVE.has(info.status) : false
    const st = look(info?.status ?? 'ended')
    const msgs = await $.session.messages({ agentId: target.id })
    const steps = Array.isArray(msgs) ? toSteps(msgs, isActive) : []
    const toolCount = steps.filter(s => s.kind === 'tool').length
    const shown = steps.slice(-150)
    // CC 主界面正显示这个子代理时，输入框发给它；给一个回主对话的按钮
    const inView = e.props.view.agentId === target.id
    const extra = (suffix: string) => (
      <Box gap={3}>
        {isActive ? stopButton(target.id, suffix) : null}
        {inView ? (
          <Button key={`main${suffix}`} plain onPress={() => $.ui.view({})}>
            <Text color="suggestion">主界面回到主对话</Text>
          </Button>
        ) : info ? (
          <Button
            key={`open${suffix}`}
            plain
            onPress={async () => {
              const r = await $.ui.view({ agentId: target.id })
              if (r.deny) $.ui.toast(r.deny)
            }}
          >
            <Text color="suggestion">在主界面打开 ›</Text>
          </Button>
        ) : null}
      </Box>
    )

    const stepView = (s: Step) => {
      if (s.kind === 'text') {
        return (
          <Box marginBottom={1}>
            <Text>
              <Text color="claude">◆ </Text>
              {clip(s.text, 30)}
            </Text>
          </Box>
        )
      }
      if (s.kind !== 'tool') {
        return (
          <Box flexDirection="column" marginBottom={1}>
            <Text color="permission" bold>
              {s.kind === 'prompt' ? '▍任务提示词' : '▍收到消息'}
            </Text>
            <Text color="inactive">{clip(s.text, 8)}</Text>
          </Box>
        )
      }
      const mark = s.isRunning
        ? { icon: '●', color: 'warning' }
        : s.isError
          ? { icon: '✗', color: 'error' }
          : s.result === undefined
            ? { icon: '○', color: 'inactive' }
            : { icon: '✓', color: 'success' }
      const tail = s.result ? lastLines(s.result, 3) : []
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text>
            <Text color={mark.color}>{mark.icon} </Text>
            <Text color={toolColor(s.tool)} bold>
              {s.tool}
            </Text>
            {s.note ? <Text color="inactive">  {s.note}</Text> : null}
          </Text>
          {s.summary ? (
            <Box paddingLeft={2}>
              <Text>
                {s.tool === 'Bash' ? <Text color="bashBorder">$ </Text> : null}
                {clip(s.summary, 20)}
              </Text>
            </Box>
          ) : null}
          {s.isRunning ? (
            <Box paddingLeft={2}>
              <Text color="warning">… 运行中</Text>
            </Box>
          ) : null}
          {tail.length > 0 ? (
            <Box paddingLeft={2} flexDirection="column">
              {tail.map(line => (
                <Text wrap="truncate-end">
                  <Text color="subtle">│ </Text>
                  <Text color={s.isError ? 'error' : 'inactive'}>{line}</Text>
                </Text>
              ))}
            </Box>
          ) : null}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {nav('', extra(''))}
        {card(
          st.color,
          info ? info.description : target.id,
          <Text>
            <Text color={st.color}>
              {st.icon} {info ? st.label : '已结束'}
            </Text>
            <Text color="inactive">
              {'  '}
              {[info?.name ? `@${info.name}` : info?.type, span(info, now), `${toolCount} 次调用`]
                .filter(Boolean)
                .join(' · ')}
            </Text>
          </Text>,
        )}
        {Array.isArray(msgs) ? null : <Text color="error">无法读取记录：{msgs.deny}</Text>}
        {steps.length > shown.length ? (
          <Text color="inactive">（前面还有 {steps.length - shown.length} 步未显示）</Text>
        ) : null}
        {shown.map(stepView)}
        {isActive ? <Text color="warning">● 仍在运行，每秒刷新</Text> : null}
        <Box marginTop={1}>{nav('-bottom', extra('-bottom'))}</Box>
      </Box>
    )
  })
}
