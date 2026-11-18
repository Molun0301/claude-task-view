import type { On, SessionMessage } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const PROPS = {
  title: '任务',
  isFocused: false,
  bodyColumns: 80,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const

const LIST = {
  plugin: 'task-view',
  component: 'Pane',
  requestId: 'task-view',
  surface: 'terminal',
  props: PROPS,
} as const

const DETAIL = { ...LIST, requestId: 'task-view-detail', props: { ...PROPS, title: '详情' } } as const

const MESSAGES: SessionMessage[] = [
  { role: 'user', text: '<system-reminder>x</system-reminder>\n请调研插件接口', toolUses: [] },
  {
    role: 'assistant',
    text: '先看看目录结构。',
    toolUses: [
      {
        tool_use_id: 't1',
        tool: 'Bash',
        input: { command: 'ls -la /home/user/project', description: '列目录' },
        text: 'total 8\nfile-a\nfile-b',
      },
      { tool_use_id: 't2', tool: 'Read', input: { file_path: '/home/user/project/README.md' } },
    ],
  },
]

// 详情标签的开关由引擎回答：这里记下打开过哪些面板
function panes(on: On): string[] {
  const opened: string[] = []
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => ({ value: undefined }))
  return opened
}

test('后台 shell：登记完整命令，输出去掉控制符，点击进入详情，收到通知后更新状态', async ($, on) => {
  mock.clock(on)
  const opened = panes(on)
  on('agent.list', () => ({ value: [] }))
  on('tool.call', () => ({
    result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b123' },
    text: 'Command running in background with ID: b123. Output is being written to: /tmp/claude-1000/-home-ml/s1/tasks/b123.output. You will be notified when it completes',
  }))
  on('process.run', () => ({
    value: {
      exitCode: 0,
      stdout: 'step 1\n\x1b[32mok\x1b[0m\n10%\r50%\r100%\r\n',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))

  await $.tool.call({
    tool: 'Bash',
    command: 'npm run build && npm test -- --watch=false',
    description: '构建并测试',
    run_in_background: true,
  })

  const list = await $.ui.mount(LIST)
  expect(await list.find({ type: 'Button', text: /● 运行中 {2}构建并测试/ })).toBeDefined()
  expect(await list.find({ type: 'Text', text: /^ok$/ })).toBeDefined()
  await list.press({ key: 'shell-b123' })
  expect(opened).toContain('task-view-detail')
  await list.unmount()

  const detail = await $.ui.mount(DETAIL)
  expect(await detail.find({ type: 'Text', text: '$ npm run build && npm test -- --watch=false' })).toBeDefined()
  expect(await detail.find({ type: 'Text', text: 'step 1\nok\n100%' })).toBeDefined()
  expect(await detail.find({ type: 'Button', key: 'back' })).toBeDefined()
  expect(await detail.find({ type: 'Button', key: 'stop' })).toBeDefined()
  await detail.unmount()

  await $.session.append({
    door: 'delivery',
    origin: { kind: 'task-notification' },
    uuid: 'u1',
    message: {
      type: 'user',
      content: [
        {
          type: 'text',
          text: '<task-notification>\n<task-id>b123</task-id>\n<status>completed</status>\n<summary>Background command "构建并测试" completed (exit code 0)</summary>\n</task-notification>',
        },
      ],
    },
  })

  const after = await $.ui.mount(LIST)
  expect(await after.find({ type: 'Button', text: /✓ 已完成/ })).toBeDefined()
  await after.unmount()
})

test('点击子代理进入详情标签：提示词、文字、完整命令、结果末尾和返回按钮', async ($, on) => {
  mock.clock(on)
  const opened = panes(on)
  on('agent.list', () => ({
    value: [{ id: 'a1', description: '调研接口', type: 'Explore', status: 'running' }],
  }))
  on('session.messages', () => ({ value: MESSAGES }))

  const list = await $.ui.mount(LIST)
  expect(await list.find({ type: 'Text', text: /↳ 正在 Read/ })).toBeDefined()
  await list.press({ key: 'agent-a1' })
  expect(opened).toContain('task-view-detail')
  await list.unmount()

  const ui = await $.ui.mount(DETAIL)
  expect(await ui.find({ type: 'Text', text: /请调研插件接口/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /先看看目录结构/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '$ ls -la /home/user/project' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '│ file-b' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '… 运行中' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'back' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'back-bottom' })).toBeDefined()
  await ui.unmount()
})

test('补登记插件加载前启动的后台 shell：主对话和子代理里的都找回，按通知和输出文件定状态', async ($, on) => {
  const clock = mock.clock(on)
  const main: SessionMessage[] = [
    { role: 'user', text: '跑构建', toolUses: [] },
    {
      role: 'assistant',
      text: '',
      toolUses: [
        {
          tool_use_id: 't1',
          tool: 'Bash',
          input: { command: 'npm run build', description: '构建', run_in_background: true },
          text: 'Command running in background with ID: b1. Output is being written to: /tmp/x/tasks/b1.output.',
        },
      ],
    },
    {
      role: 'user',
      text: '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command "构建" completed (exit code 0)</summary>\n</task-notification>',
      toolUses: [],
    },
  ]
  const sub: SessionMessage[] = [
    { role: 'user', text: '子任务', toolUses: [] },
    {
      role: 'assistant',
      text: '',
      toolUses: [
        {
          tool_use_id: 't2',
          tool: 'Bash',
          input: { command: 'S=/home/x/companion.mjs; node "$S" task', description: '调用 codex' },
          text: 'Command was manually backgrounded by user with ID: b2. Output is being written to: /tmp/x/tasks/b2.output.',
        },
      ],
    },
  ]
  on('command.register', () => ({ value: { command: 'task-view' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.list', () => ({
    value: [{ id: 'a1', description: '子任务', type: 'general-purpose', status: 'running' }],
  }))
  on('session.messages', (_, e) => ({ value: e?.agentId === 'a1' ? sub : main }))
  on('fs.exists', () => ({ value: true }))
  on('process.run', (_, e) => ({
    value: {
      exitCode: 0,
      stdout: e.argv[0] === 'stat' ? '1700000000 1700000100' : 'working...\n',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount(LIST)
  expect(await ui.find({ type: 'Button', text: /✓ 已完成 {2}构建/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /● 运行中 {2}调用 codex/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /子任务 · b2/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '$ S=/home/x/companion.mjs; node "$S" task' })).toBeDefined()
  await ui.unmount()
})
