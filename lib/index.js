/**
 * dsh-kickstart — 引导式构建 Agent。
 *
 * 三块拼起来就是一个引导体验：
 *   1. 工具（kickstart_*）：把状态机的推进权交给模型，但状态本身只由代码写；
 *   2. 系统提示词注入：只有引导模式开着时才注入当前阶段的脚本，平时零污染；
 *   3. 命令 /kickstart：一句话进入或恢复引导。
 *
 * 纯插件：只用公开的 tools / systemPrompt / commands 三个 seam，不改 dsh 核心。
 * @module dsh-kickstart
 */

import { randomUUID } from 'node:crypto'
import { coreRules, openingLine, stageScript } from './flow.js'
import { enter, peekView } from './state.js'
import { defineKickstartTools } from './tools.js'

export const name = 'dsh-kickstart'

// tools：注册 kickstart_* 工具；systemPrompt：按状态注入阶段脚本。
// commands 是可选的，用 ctx.inject 局部取，headless 环境没有也不影响引导。
export const inject = ['tools', 'systemPrompt']

/** 注入内容的顺序号（记忆类注入通常在 10 到 30 之间，这里放在后面）。 */
const PROMPT_ORDER = 40

/** 构造一条用户消息，等价替用户发一句话（id 必须唯一，dsh 靠它追踪）。 */
function userMessage(text) {
  return {
    role: 'user',
    id: randomUUID(),
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

/** 当前阶段脚本 + 状态头，拼成交给模型的注入文本。 */
function buildGuidance(view) {
  const lines = [
    '【dsh-kickstart 引导模式已开启】',
    coreRules(),
    '',
    `阶段：${view.stage}（${view.stageLabel}）`,
    `动手尺度：${view.safetyLabel}`,
    `讲解深度：${view.level}/4 ${view.levelLabel}（偏好 ${view.preference}）`,
    `已选方向：${view.direction ?? '还没有'}`,
    `已有产物：${view.creations.length > 0 ? view.creations.join('、') : '还没有'}`,
    '状态和对话对不上时，先调用 kickstart_status 读真实状态，不要凭印象往下走。',
    '',
    stageScript(view.stage, {
      level: view.level,
      creations: view.creations,
      safety: view.safety,
    }),
  ]
  return lines.join('\n')
}

export function apply(ctx) {
  // 1. 工具：批量注册，卸载时全部撤销。
  ctx.effect(() => {
    const disposers = defineKickstartTools().map((tool) => ctx.tools.register(tool))
    return () => {
      for (const dispose of disposers) {
        try {
          if (typeof dispose === 'function') dispose()
        } catch {
          // 单个工具卸载失败不影响其余工具，插件卸载流程继续。
        }
      }
    }
  }, 'dsh-kickstart: tools')

  // 2. 提示词注入：只在 mode=active 时给内容，未初始化的工作区连目录都不创建。
  ctx.effect(
    () =>
      ctx.systemPrompt.context({
        name: 'kickstart:guidance',
        order: PROMPT_ORDER,
        text: (context) => {
          try {
            const cwd = context?.agent?.session?.header?.cwd
            if (!cwd) return ''
            const view = peekView(cwd)
            if (!view || view.mode !== 'active') return ''
            return buildGuidance(view)
          } catch {
            // 注入文本取不到就当没有引导，绝不让一次读取失败打断整轮对话。
            return ''
          }
        },
      }),
    'dsh-kickstart: guidance prompt',
  )

  // 3. 命令：/kickstart 进入或恢复，并直接唤起一轮对话。
  //    dsh 的命令结果只是「给界面的直接产物」，本身不会产生模型回合；所以这里
  //    除了返回文本，还替用户给当前会话发一句话（agent.followup），引导才会真的开始。
  ctx.inject(['commands'], (cmdCtx) => {
    cmdCtx.commands.register({
      name: 'kickstart',
      description: '「起个头」：问几句了解你，给两三个一小时就能做出雏形的小项目，挑一个陪你立刻做。',
      input: {
        hint: '直接回车开始；也可以加 status 看进度',
      },
      handler(invocation) {
        const cwd = invocation?.agent?.session?.header?.cwd
        if (!cwd) return { kind: 'error', text: '当前会话没有工作区目录，引导状态无法定位。' }
        const op = String(invocation.rawInput ?? '').trim().toLowerCase() || 'start'
        try {
          if (op === 'status') {
            const view = peekView(cwd)
            if (!view) return { kind: 'success', text: '这个工作区还没开始引导。发送 /kickstart 就能开始。' }
            return {
              kind: 'success',
              text: [
                `阶段：${view.stage}（${view.stageLabel}）`,
                `模式：${view.mode === 'active' ? '引导进行中' : '已退出（数据保留）'}`,
                `动手尺度：${view.safetyLabel}`,
                `已选方向：${view.direction ?? '还没有'}`,
                `讲解深度：${view.level}/4 ${view.levelLabel}`,
                `已有产物：${view.creations.length > 0 ? view.creations.join('、') : '还没有'}`,
              ].join('\n'),
            }
          }
          if (op === 'leave') {
            return { kind: 'success', text: '退出的动作请让模型调用 kickstart_control（action: leave），它会一并说明保留了哪些数据。' }
          }
          if (op === 'reset') {
            return { kind: 'success', text: '重置会清空画像、笔记和建议历史（产物保留）。确认后让模型调用 kickstart_control（action: reset, confirm: true）。' }
          }
          const { route, status } = enter(cwd)
          const routeText =
            route === 'first_run'
              ? '首次进入'
              : route === 'resume_onboarding'
                ? `从上次中断的地方继续（阶段 ${status.stage}）`
                : '回到引导模式'
          // 命令本身不产生模型回合，这里替用户发一句话把引导真正启动。
          const agent = invocation?.agent
          if (!agent || typeof agent.followup !== 'function') {
            return { kind: 'error', text: '这个会话不支持从命令唤起对话，请直接说「开始引导」让模型调用 kickstart_start。' }
          }
          agent.followup(userMessage('开始引导吧。'))
          return { kind: 'success', text: `${openingLine()}\n\n${routeText}，正在开始。` }
        } catch (error) {
          return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
        }
      },
    })
  })
}
