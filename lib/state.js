/**
 * dsh-kickstart — 工作区内的持久状态。
 *
 * 设计照搬 Agent Kickstart 的核心：状态只由代码写，模型只能通过插件工具间接
 * 推进；每次问问题之前先落一个 checkpoint，所以任何一步断掉都能从存下的阶段
 * 续跑，不重来。所有文件都写在工作区的 `.kickstart/` 下，用户可读、可改、可删。
 * @module dsh-kickstart/state
 */

import fs from 'node:fs'
import path from 'node:path'

/** 状态根目录名（工作区内）。 */
export const STATE_ROOT = '.kickstart'

/** 引导阶段。顺序即流程顺序。 */
export const STAGES = [
  'welcome',
  'awaiting_safety',
  'awaiting_self_description',
  'awaiting_followup_1',
  'awaiting_followup_2',
  'awaiting_followup_3',
  'awaiting_portrait_confirmation',
  'awaiting_possibility',
  'first_action',
]

/** 阶段的中文名，用于状态行和提示词。 */
export const STAGE_LABELS = {
  welcome: '开场',
  awaiting_safety: '确认动手尺度',
  awaiting_self_description: '听你聊聊自己',
  awaiting_followup_1: '澄清一',
  awaiting_followup_2: '澄清二',
  awaiting_followup_3: '澄清三（可选）',
  awaiting_portrait_confirmation: '两栏确认',
  awaiting_possibility: '给小项目建议',
  first_action: '一起开工',
}

/** 动手尺度：改文件前有多谨慎。 */
export const SAFETY_LEVELS = ['conservative', 'moderate', 'letting-go']

/** 动手尺度的中文名。 */
export const SAFETY_LABELS = {
  conservative: '保守',
  moderate: '适中',
  'letting-go': '放手做',
}

/** 渐进等级的中文名（0 到 4）。 */
export const LEARNING_LABELS = [
  '被引导的乘客',
  '主动的选择者',
  '协作掌舵者',
  '能干的构建者',
  '独立使用者',
]

/** 可记录的行为证据类型。 */
export const EVIDENCE_TYPES = [
  'modified_suggestion',
  'corrected_assumption',
  'understood_file_change',
  'chose_scope',
  'requested_control',
  'recovered_from_error',
  'asked_underlying_mechanism',
]

const ONBOARDING_STATES = new Set(['not_started', 'in_progress', 'interrupted', 'complete'])
const MODES = new Set(['active', 'inactive'])
const PREFERENCES = new Set(['adaptive', 'simpler', 'advanced'])

const PORTRAIT_TEMPLATE = `# 用户画像

这份文件属于用户本人：本地保存，可以随时查看、修改、删除。

## 我听到的事实

_还没记录。_

## 我暂时推断的东西

_还没有。推断必须标明是推断，用户不同意时立刻改。_
`

const NOTES_TEMPLATE = `# 引导笔记

记录用户的原话和当前待问的问题，用来中断后续跑。用户可以随时查看、修改、删除。
`

const HISTORY_TEMPLATE = `# 建议历史

记录生成过、选中、改动、组合、否掉的方向。这是工作记忆，不是可选范围的白名单。
`

/** 把工作区目录解析成全部状态路径。 */
export function workspacePaths(cwd) {
  if (!cwd) throw new Error('无法确定当前工作区目录（会话缺少 cwd），无法读写引导状态。')
  const root = path.join(cwd, STATE_ROOT)
  const stateDir = path.join(root, 'state')
  return {
    root,
    stateDir,
    creationsDir: path.join(root, 'creations'),
    statusFile: path.join(stateDir, 'status.json'),
    learningFile: path.join(stateDir, 'learning-state.json'),
    portraitFile: path.join(stateDir, 'user-portrait.md'),
    notesFile: path.join(stateDir, 'onboarding-notes.md'),
    historyFile: path.join(stateDir, 'possibility-history.md'),
  }
}

function nowIso() {
  return new Date().toISOString()
}

function stamp() {
  return nowIso().replaceAll(':', '-').replaceAll('.', '-')
}

/** 原子写：先写临时文件再改名，避免半截文件。 */
function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`,
  )
  fs.writeFileSync(temporary, content, { encoding: 'utf8' })
  fs.renameSync(temporary, file)
}

function writeJson(file, value) {
  atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`)
}

function ensureFile(file, content) {
  if (!fs.existsSync(file)) atomicWrite(file, content)
}

export function defaultStatus() {
  return {
    schema_version: 1,
    mode: 'inactive',
    onboarding_status: 'not_started',
    stage: 'welcome',
    safety: null,
    selected_direction: null,
    interruption_count: 0,
    last_event: 'initialized',
    last_updated: null,
  }
}

export function defaultLearning() {
  return {
    schema_version: 1,
    stage: 0,
    label: LEARNING_LABELS[0],
    guidance_preference: 'adaptive',
    evidence: [],
    last_updated: null,
  }
}

function validateStatus(value) {
  if (!value || value.schema_version !== 1) throw new Error('状态文件版本不支持')
  if (!MODES.has(value.mode)) throw new Error(`mode 非法：${value.mode}`)
  if (!ONBOARDING_STATES.has(value.onboarding_status)) throw new Error(`onboarding_status 非法：${value.onboarding_status}`)
  if (!STAGES.includes(value.stage)) throw new Error(`stage 非法：${value.stage}`)
  if (value.safety === undefined) value.safety = null
  if (value.safety !== null && !SAFETY_LEVELS.includes(value.safety)) throw new Error(`safety 非法：${value.safety}`)
  if (!Number.isInteger(value.interruption_count) || value.interruption_count < 0) throw new Error('interruption_count 非法')
  return value
}

function validateLearning(value) {
  if (!value || value.schema_version !== 1) throw new Error('学习状态文件版本不支持')
  if (!Number.isInteger(value.stage) || value.stage < 0 || value.stage > 4) throw new Error('学习等级必须是 0 到 4 的整数')
  if (!PREFERENCES.has(value.guidance_preference)) throw new Error(`guidance_preference 非法：${value.guidance_preference}`)
  if (!Array.isArray(value.evidence)) throw new Error('evidence 必须是数组')
  value.label = LEARNING_LABELS[value.stage]
  return value
}

/** 读 JSON；损坏就备份改名后重建，不让用户卡在坏文件上。 */
function loadJson(file, factory, validator) {
  if (!fs.existsSync(file)) {
    const value = factory()
    writeJson(file, value)
    return validator(value)
  }
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    throw new Error(`读不到状态文件：${path.basename(file)}`)
  }
  try {
    return validator(JSON.parse(raw))
  } catch {
    const backup = `${file}.corrupt-${stamp()}.bak`
    fs.renameSync(file, backup)
    const value = factory()
    writeJson(file, value)
    return validator(value)
  }
}

/** 首次使用（或缺失文件时）补齐目录与模板文件。 */
export function ensureState(cwd) {
  const paths = workspacePaths(cwd)
  fs.mkdirSync(paths.stateDir, { recursive: true })
  fs.mkdirSync(paths.creationsDir, { recursive: true })
  ensureFile(paths.statusFile, `${JSON.stringify(defaultStatus(), null, 2)}\n`)
  ensureFile(paths.learningFile, `${JSON.stringify(defaultLearning(), null, 2)}\n`)
  ensureFile(paths.portraitFile, PORTRAIT_TEMPLATE)
  ensureFile(paths.notesFile, NOTES_TEMPLATE)
  ensureFile(paths.historyFile, HISTORY_TEMPLATE)
  return paths
}

export function loadStatus(cwd) {
  const paths = ensureState(cwd)
  return loadJson(paths.statusFile, defaultStatus, validateStatus)
}

export function loadLearning(cwd) {
  const paths = ensureState(cwd)
  return loadJson(paths.learningFile, defaultLearning, validateLearning)
}

function saveStatus(cwd, status, event) {
  const paths = workspacePaths(cwd)
  status.last_event = event
  status.last_updated = nowIso()
  validateStatus(status)
  writeJson(paths.statusFile, status)
  return status
}

function saveLearning(cwd, learning) {
  const paths = workspacePaths(cwd)
  learning.label = LEARNING_LABELS[learning.stage]
  learning.last_updated = nowIso()
  validateLearning(learning)
  writeJson(paths.learningFile, learning)
  return learning
}

function appendNotes(cwd, text) {
  const paths = workspacePaths(cwd)
  fs.appendFileSync(paths.notesFile, `\n${text}\n`, 'utf8')
}

/** 列出产物目录下的文件（最多 40 条，跳过 .gitkeep；不创建目录）。 */
function listCreations(creationsDir) {
  const found = []
  const walk = (directory) => {
    if (found.length >= 40 || !fs.existsSync(directory)) return
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (found.length >= 40) break
      if (entry.isSymbolicLink()) continue
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(absolute)
      else if (entry.isFile() && entry.name !== '.gitkeep') {
        found.push(path.relative(creationsDir, absolute).replaceAll('\\', '/'))
      }
    }
  }
  walk(creationsDir)
  return found
}

/** 列出 creations/ 下已有的产物（必要时先补齐目录）。 */
export function creationFiles(cwd) {
  const paths = ensureState(cwd)
  return listCreations(paths.creationsDir)
}

/** 一次读全，供状态类工具和命令使用。 */
export function statusView(cwd) {
  const paths = ensureState(cwd)
  const status = loadStatus(cwd)
  const learning = loadLearning(cwd)
  const portrait = fs.readFileSync(paths.portraitFile, 'utf8')
  return {
    status,
    learning,
    portrait,
    portraitConfirmed: status.stage === 'first_action' || status.stage === 'awaiting_possibility' || status.stage === 'awaiting_orientation',
    notes: fs.readFileSync(paths.notesFile, 'utf8'),
    history: fs.readFileSync(paths.historyFile, 'utf8'),
    creations: creationFiles(cwd),
    root: paths.root,
  }
}

/**
 * 进入或恢复引导。
 * @returns {{route: string, status: object}}
 */
export function enter(cwd) {
  ensureState(cwd)
  const status = loadStatus(cwd)
  let route
  if (status.onboarding_status === 'not_started') {
    route = 'first_run'
    status.onboarding_status = 'in_progress'
    status.stage = 'welcome'
  } else if (status.onboarding_status === 'in_progress' || status.onboarding_status === 'interrupted') {
    route = 'resume_onboarding'
    if (status.onboarding_status === 'interrupted') status.interruption_count += 1
    status.onboarding_status = 'in_progress'
  } else {
    route = status.mode === 'active' ? 'already_active' : 'returning_user'
  }
  status.mode = 'active'
  return { route, status: saveStatus(cwd, status, route) }
}

/**
 * 把进度推进到某个阶段（问问题之前调用），可选把这一轮的材料记进笔记，
 * 也可以顺手记下用户选的动手尺度。
 */
export function checkpoint(cwd, stage, note, safety) {
  if (!STAGES.includes(stage)) throw new Error(`未知阶段：${stage}`)
  if (stage === 'first_action') throw new Error('first_action 是结束引导才会到的阶段，请改用 kickstart_finish')
  const status = loadStatus(cwd)
  if (status.mode !== 'active') throw new Error('引导模式未开启，先调用 kickstart_start 进入')
  if (safety !== undefined && safety !== null && !SAFETY_LEVELS.includes(safety)) {
    throw new Error(`未知的动手尺度：${safety}（可选 conservative / moderate / letting-go）`)
  }
  status.onboarding_status = 'in_progress'
  status.stage = stage
  if (safety) status.safety = safety
  if (note && String(note).trim()) appendNotes(cwd, `## ${nowIso()} → ${stage}\n\n${String(note).trim()}`)
  return saveStatus(cwd, status, `checkpoint:${stage}`)
}

/** 写入画像全文（模型自己组织 Markdown，代码只负责原子落盘）。 */
export function writePortrait(cwd, markdown) {
  const text = String(markdown ?? '').trim()
  if (!text) throw new Error('画像内容为空')
  const status = loadStatus(cwd)
  if (status.mode !== 'active') throw new Error('引导模式未开启，先调用 kickstart_start 进入')
  const paths = workspacePaths(cwd)
  atomicWrite(paths.portraitFile, `${text}\n`)
  const sections = (text.match(/^##\s+(.+)$/gm) ?? []).map((line) => line.replace(/^##\s+/, '').trim())
  return { sections, bytes: Buffer.byteLength(text, 'utf8') }
}

/** 记录用户选定的方向（含改动、组合），并追加到建议历史。 */
export function recordChoice(cwd, direction, notes) {
  const clean = String(direction ?? '').trim()
  if (!clean) throw new Error('选定的方向不能为空')
  const status = loadStatus(cwd)
  if (status.mode !== 'active') throw new Error('引导模式未开启，先调用 kickstart_start 进入')
  status.selected_direction = clean
  const paths = workspacePaths(cwd)
  const reaction = String(notes ?? '').trim()
  fs.appendFileSync(
    paths.historyFile,
    `\n## 选定 — ${nowIso()}\n\n${clean}\n${reaction ? `\n用户补充：${reaction}\n` : ''}`,
    'utf8',
  )
  return saveStatus(cwd, status, 'direction_selected')
}

/** 结束引导：必须已经选过方向。 */
export function completeOnboarding(cwd) {
  const status = loadStatus(cwd)
  if (status.mode !== 'active') throw new Error('引导模式未开启，先调用 kickstart_start 进入')
  if (!status.selected_direction) throw new Error('还没记录选定的方向，先调用 kickstart_choose')
  status.onboarding_status = 'complete'
  status.stage = 'first_action'
  return saveStatus(cwd, status, 'onboarding_complete')
}

/**
 * 记录行为证据并据此调渐进等级；用户显式设置的偏好覆盖自动升级。
 */
export function updateLearning(cwd, { preference, level, evidenceType, evidenceNote } = {}) {
  const learning = loadLearning(cwd)
  if (evidenceType) {
    if (!EVIDENCE_TYPES.includes(evidenceType)) throw new Error(`未知证据类型：${evidenceType}`)
    learning.evidence.push({ type: evidenceType, note: String(evidenceNote ?? '').trim(), observed_at: nowIso() })
    learning.evidence = learning.evidence.slice(-50)
    const unique = new Set(learning.evidence.map((item) => item.type))
    let recommendation = 0
    if (unique.size >= 1) recommendation = 1
    if (unique.size >= 2) recommendation = 2
    if (unique.size >= 4 && (unique.has('requested_control') || unique.has('recovered_from_error'))) recommendation = 3
    if (unique.size >= 6 && unique.has('asked_underlying_mechanism')) recommendation = 4
    if (learning.guidance_preference === 'adaptive') learning.stage = Math.max(learning.stage, recommendation)
  }
  if (preference) {
    if (!PREFERENCES.has(preference)) throw new Error(`未知偏好：${preference}`)
    learning.guidance_preference = preference
    if (preference === 'simpler') learning.stage = Math.max(0, learning.stage - 1)
    if (preference === 'advanced') learning.stage = Math.min(4, learning.stage + 1)
  }
  if (Number.isInteger(level)) {
    if (level < 0 || level > 4) throw new Error('学习等级必须是 0 到 4 的整数')
    learning.stage = level
  }
  return saveLearning(cwd, learning)
}

/** 退出引导模式（保留全部数据）或重置（保留 creations/）。 */
export function controlAction(cwd, action, confirm) {
  const paths = ensureState(cwd)
  const status = loadStatus(cwd)
  if (action === 'leave') {
    if (status.onboarding_status === 'in_progress') status.onboarding_status = 'interrupted'
    status.mode = 'inactive'
    saveStatus(cwd, status, 'left_guided_mode')
    return {
      action: 'leave',
      preserved: ['state/user-portrait.md', 'state/possibility-history.md', 'creations/'],
      re_entry: '再想继续时，说一声让模型调用 kickstart_start 即可从保存的阶段接着走。',
    }
  }
  if (action === 'reset') {
    if (confirm !== true) throw new Error('重置会清空画像、笔记和建议历史（creations/ 保留），必须带 confirm: true 才会执行')
    const preservedCount = creationFiles(cwd).length
    const fresh = defaultStatus()
    fresh.interruption_count = status.interruption_count
    fresh.last_event = 'reset_completed'
    fresh.last_updated = nowIso()
    writeJson(paths.statusFile, fresh)
    writeJson(paths.learningFile, defaultLearning())
    atomicWrite(paths.portraitFile, PORTRAIT_TEMPLATE)
    atomicWrite(paths.notesFile, NOTES_TEMPLATE)
    atomicWrite(paths.historyFile, HISTORY_TEMPLATE)
    return { action: 'reset', preserved: ['creations/'], preserved_files: preservedCount }
  }
  throw new Error(`未知操作：${action}`)
}

/** 只读的当前阶段视图，供提示词注入和工具返回使用。 */
export function readView(cwd) {
  const view = statusView(cwd)
  return {
    mode: view.status.mode,
    stage: view.status.stage,
    stageLabel: STAGE_LABELS[view.status.stage] ?? view.status.stage,
    onboarding: view.status.onboarding_status,
    direction: view.status.selected_direction,
    safety: view.status.safety,
    safetyLabel: SAFETY_LABELS[view.status.safety] ?? '还没选',
    level: view.learning.stage,
    levelLabel: view.learning.label,
    preference: view.learning.guidance_preference,
    creations: view.creations,
    portrait: view.portrait,
  }
}

/**
 * 不创建任何文件的只读快照：没初始化过引导的工作区返回 null。
 * 提示词注入每轮都会调用它，不能顺手把 .kickstart 目录建出来。
 */
export function peekView(cwd) {
  const paths = workspacePaths(cwd)
  if (!fs.existsSync(paths.statusFile)) return null
  try {
    const status = validateStatus(JSON.parse(fs.readFileSync(paths.statusFile, 'utf8')))
    const learning = fs.existsSync(paths.learningFile)
      ? validateLearning(JSON.parse(fs.readFileSync(paths.learningFile, 'utf8')))
      : defaultLearning()
    return {
      mode: status.mode,
      stage: status.stage,
      stageLabel: STAGE_LABELS[status.stage] ?? status.stage,
      onboarding: status.onboarding_status,
      direction: status.selected_direction,
      safety: status.safety,
      safetyLabel: SAFETY_LABELS[status.safety] ?? '还没选',
      level: learning.stage,
      levelLabel: learning.label,
      preference: learning.guidance_preference,
      creations: listCreations(paths.creationsDir),
    }
  } catch {
    return null
  }
}
