/**
 * dsh-kickstart — 工具集。
 *
 * 模型只通过这 8 个工具推进状态：状态机在代码里，模型改不到 JSON，也不需要
 * 被允许执行任何 shell 命令（这是相对 Agent Kickstart 简化掉的最大一块复杂度）。
 * @module dsh-kickstart/tools
 */

import {
  SAFETY_LABELS,
  STAGES,
  STAGE_LABELS,
  controlAction,
  checkpoint,
  completeOnboarding,
  creationFiles,
  enter,
  loadLearning,
  loadStatus,
  recordChoice,
  updateLearning,
  writePortrait,
  workspacePaths,
} from './state.js'
import { openingLine, stageScript } from './flow.js'

/** 从工具调用上下文里取会话工作区目录。 */
function cwdOf(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  if (!cwd) throw new Error('无法确定当前工作区目录（会话缺少 cwd），引导状态无法读写。')
  return cwd
}

function fail(error) {
  return { ok: false, message: error instanceof Error ? error.message : String(error) }
}

function stateLine(cwd) {
  const status = loadStatus(cwd)
  const learning = loadLearning(cwd)
  const creations = creationFiles(cwd)
  return [
    `阶段：${status.stage}（${STAGE_LABELS[status.stage] ?? status.stage}）`,
    `引导状态：${status.onboarding_status}；模式：${status.mode}`,
    `动手尺度：${status.safety ? SAFETY_LABELS[status.safety] : '还没选'}`,
    `已选方向：${status.selected_direction ?? '还没有'}`,
    `讲解深度：${learning.stage}/4 ${learning.label}（偏好 ${learning.guidance_preference}）`,
    `已有产物：${creations.length > 0 ? creations.join('、') : '还没有'}`,
  ].join('\n')
}

/** 统一包装：任何阶段的工具都返回 message + 该阶段的执行脚本。 */
function advanceResult(cwd, { route, message } = {}) {
  const status = loadStatus(cwd)
  const learning = loadLearning(cwd)
  const creations = creationFiles(cwd)
  const instruction = stageScript(status.stage, {
    level: learning.stage,
    creations,
    safety: status.safety,
  })
  const head = message ?? stateLine(cwd)
  return {
    ok: true,
    route: route ?? '',
    stage: status.stage,
    stageLabel: STAGE_LABELS[status.stage] ?? status.stage,
    level: learning.stage,
    message: [head, '', instruction].join('\n'),
  }
}

const resultSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    route: { type: 'string' },
    stage: { type: 'string' },
    stageLabel: { type: 'string' },
    level: { type: 'integer' },
    message: { type: 'string' },
  },
  required: ['ok', 'message'],
}

const render = (_args, value) => [{ type: 'text', text: value.message ?? '' }]

/** kickstart_start：进入或恢复引导。 */
function startTool() {
  return {
    name: 'kickstart_start',
    description:
      '（中文名「起个头」）开启或恢复引导式构建：先了解用户，再给两三个一两个小时内能做出雏形的小项目，选定后立刻陪他开工。用户说「我不知道做什么」「不知道从哪开始」「起个头」「帮我找个能上手的小项目」「从头带我做一个东西」「我想做点东西但没想法」时调用。返回当前阶段和下一步该做什么。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: resultSchema, render },
    async execute(_args, exec) {
      try {
        const cwd = cwdOf(exec)
        const { route, status } = enter(cwd)
        const routeText = {
          first_run: '首次进入。按下面的脚本开场。',
          resume_onboarding: '恢复上一次没有做完的引导：先用一句话说明哪些东西保留着，然后从当前阶段继续，不要从头再来。',
          returning_user: '你是回头用户：先读画像，用一句贴合他的话打个招呼，再问要不要按新方向重新给建议。',
          already_active: '引导已经在进行中，从当前状态自然继续，不要重复开场。',
        }[route]
        return advanceResult(cwd, {
          route,
          message: `${routeText}\n（引导状态模式：${status.mode}）\n\n开场白参考：${openingLine()}`,
        })
      } catch (error) {
        return fail(error)
      }
    },
  }
}

/** kickstart_stage：推进阶段，并在提问前把这一轮材料记进笔记。 */
function stageTool() {
  return {
    name: 'kickstart_stage',
    description:
      '把引导推进到指定阶段，并可选地把这一轮的问题、用户原话、选择题答案记进笔记。每个面向用户的问题之前都要先调用一次，这样中断后能从这个问题续跑。',
    parameters: {
      type: 'object',
      properties: {
        stage: {
          type: 'string',
          enum: STAGES,
          description: '要推进到的阶段。正常顺序是 welcome → awaiting_safety → awaiting_self_description → awaiting_followup_1/2/3 → awaiting_portrait_confirmation → awaiting_possibility，最后由 kickstart_finish 进入 first_action。',
        },
        note: {
          type: 'string',
          description: '可选：这一轮要记下来的材料（问题、用户原话、他的选择）。',
        },
        safety: {
          type: 'string',
          enum: ['conservative', 'moderate', 'letting-go'],
          description: '可选：用户选的动手尺度。保守=每次改文件前都问；适中=项目内直接改、项目外先问；放手做=项目内自己动手。',
        },
      },
      required: ['stage'],
      additionalProperties: false,
    },
    output: { schema: resultSchema, render },
    async execute(args, exec) {
      try {
        const cwd = cwdOf(exec)
        checkpoint(cwd, String(args.stage ?? ''), args.note, args.safety)
        return advanceResult(cwd, { message: `已记录进度。\n\n${stateLine(cwd)}` })
      } catch (error) {
        return fail(error)
      }
    },
  }
}

/** kickstart_portrait：写入画像全文。 */
function portraitTool() {
  return {
    name: 'kickstart_portrait',
    description:
      '把用户画像写入工作区（覆盖全文）。用于确认阶段把听到的内容整理成六节 Markdown；事实和推测必须分节，推测只能写在「暂定的推测」里。',
    parameters: {
      type: 'object',
      properties: {
        markdown: {
          type: 'string',
          description: '画像全文 Markdown，六节标题：你明确说过的／兴趣和反复出现的主题／想要的结果和卡点／学习与沟通偏好／明确的边界／暂定的推测。',
        },
      },
      required: ['markdown'],
      additionalProperties: false,
    },
    output: { schema: resultSchema, render },
    async execute(args, exec) {
      try {
        const cwd = cwdOf(exec)
        const { sections, bytes } = writePortrait(cwd, args.markdown)
        return {
          ok: true,
          message: `画像已写入（${bytes} 字节，识别到 ${sections.length} 节：${sections.join('、')}）。\n\n下一步：在对话里用「你说过的」和「我暂时推测的」两个小标题复述，请用户改删增，改完再推进到 awaiting_orientation。`,
        }
      } catch (error) {
        return fail(error)
      }
    },
  }
}

/** kickstart_choose：记录用户选定的方向。 */
function chooseTool() {
  return {
    name: 'kickstart_choose',
    description:
      '记录用户选定的方向（含组合、改动）。用户说完想要哪个之后调用，然后调用 kickstart_finish 结束引导并当场开工。',
    parameters: {
      type: 'object',
      properties: {
        direction: { type: 'string', description: '用户最终选定的方向，用大白话写清楚，可以是他自己组合或改写过的版本。' },
        notes: { type: 'string', description: '可选：改动了什么、否掉了哪些、为什么，会写进建议历史供下次参考。' },
      },
      required: ['direction'],
      additionalProperties: false,
    },
    output: { schema: resultSchema, render },
    async execute(args, exec) {
      try {
        const cwd = cwdOf(exec)
        recordChoice(cwd, args.direction, args.notes)
        return { ok: true, message: `已记录方向：${String(args.direction).trim()}\n\n下一步：调用 kickstart_finish 结束引导，然后立刻开始做。` }
      } catch (error) {
        return fail(error)
      }
    },
  }
}

/** kickstart_finish：结束引导。 */
function finishTool() {
  return {
    name: 'kickstart_finish',
    description: '结束引导（必须已经用 kickstart_choose 记录过方向）。之后不要再问问题，直接开始做第一件事。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: resultSchema, render },
    async execute(_args, exec) {
      try {
        const cwd = cwdOf(exec)
        const status = completeOnboarding(cwd)
        return advanceResult(cwd, { message: `引导已结束，进入执行阶段。已选方向：${status.selected_direction}` })
      } catch (error) {
        return fail(error)
      }
    },
  }
}

/** kickstart_status：读状态。 */
function statusTool() {
  return {
    name: 'kickstart_status',
    description:
      '读取引导的全部状态：当前阶段、讲解深度、已选方向、画像全文、已记笔记、建议历史、已有产物。用户问「现在到哪了」「你都知道我什么」或你不确定下一步时调用。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: resultSchema, render },
    async execute(_args, exec) {
      try {
        const cwd = cwdOf(exec)
        const status = loadStatus(cwd)
        const learning = loadLearning(cwd)
        const paths = workspacePaths(cwd)
        const fs = await import('node:fs')
        const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '')
        const text = [
          stateLine(cwd),
          '',
          `状态目录：${paths.root}`,
          `画像确认前不要给建议；引导完成的标志是：画像确认过、方向选定、第一件事已经开始。`,
          '',
          '--- 画像 ---',
          read(paths.portraitFile).trim(),
          '',
          '--- 建议历史（末尾）---',
          read(paths.historyFile).trim().slice(-1200),
          '',
          '--- 引导笔记（末尾）---',
          read(paths.notesFile).trim().slice(-1200),
          '',
          `讲解等级证据条数：${Array.isArray(learning.evidence) ? learning.evidence.length : 0}`,
        ].join('\n')
        return { ok: true, message: text }
      } catch (error) {
        return fail(error)
      }
    },
  }
}

/** kickstart_guidance：调整讲解深度 / 记行为证据。 */
function guidanceTool() {
  return {
    name: 'kickstart_guidance',
    description:
      '调整讲解深度或记录行为证据。用户说「讲简单点」「让我多自己来」时用 preference；观测到用户改建议、纠正你的推测、主动要更多控制时可以记 evidence，等级会自动上调。',
    parameters: {
      type: 'object',
      properties: {
        preference: {
          type: 'string',
          enum: ['adaptive', 'simpler', 'advanced'],
          description: '引导偏好。simpler 降一级讲解深度，advanced 升一级，adaptive 交回自动判断。',
        },
        level: { type: 'integer', minimum: 0, maximum: 4, description: '直接把等级设成 0 到 4（用户明确要求时用）。' },
        evidence: {
          type: 'string',
          enum: ['modified_suggestion', 'corrected_assumption', 'understood_file_change', 'chose_scope', 'requested_control', 'recovered_from_error', 'asked_underlying_mechanism'],
          description: '观测到的行为证据类型。',
        },
        evidenceNote: { type: 'string', description: '可选：证据的一句话说明。' },
      },
      additionalProperties: false,
    },
    output: { schema: resultSchema, render },
    async execute(args, exec) {
      try {
        const cwd = cwdOf(exec)
        const learning = updateLearning(cwd, {
          preference: args.preference,
          level: args.level,
          evidenceType: args.evidence,
          evidenceNote: args.evidenceNote,
        })
        return {
          ok: true,
          level: learning.stage,
          message: `讲解深度：${learning.stage}/4 ${learning.label}（偏好 ${learning.guidance_preference}）。按这个深度继续说人话。`,
        }
      } catch (error) {
        return fail(error)
      }
    },
  }
}

/** kickstart_control：退出或重置。 */
function controlTool() {
  return {
    name: 'kickstart_control',
    description:
      '退出引导模式（保留全部数据，随时可以再进来）或重置引导（清空画像/笔记/建议历史，保留 creations/）。重置必须带 confirm: true，且只能是用户明确要求之后。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['leave', 'reset'], description: 'leave 退出，reset 重置。' },
        confirm: { type: 'boolean', description: '重置时必须是 true；用户没有明确确认就不要传。' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: { schema: resultSchema, render },
    async execute(args, exec) {
      try {
        const cwd = cwdOf(exec)
        const result = controlAction(cwd, String(args.action ?? ''), args.confirm === true)
        if (result.action === 'leave') {
          return {
            ok: true,
            message: `已退出引导模式，数据都保留着：${result.preserved.join('、')}。${result.re_entry}`,
          }
        }
        return {
          ok: true,
          message: `已重置引导：画像、笔记、建议历史已清空，产物保留 ${result.preserved_files} 个（${result.preserved.join('')}）。`,
        }
      } catch (error) {
        return fail(error)
      }
    },
  }
}

/** 全部工具定义，交给 ctx.tools.register 批量注册。 */
export function defineKickstartTools() {
  return [
    startTool(),
    stageTool(),
    portraitTool(),
    chooseTool(),
    finishTool(),
    statusTool(),
    guidanceTool(),
    controlTool(),
  ]
}
