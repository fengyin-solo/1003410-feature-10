import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionPayload, ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

const DRONE_TERMINAL_STATUSES = ['已完成', '因故中止']
const DRONE_AVAILABLE_ACTIONS: Record<string, string[]> = {
  待执行: ['开始飞行', '中止任务'],
  飞行中: ['确认完成', '中止任务'],
  已完成: [],
  因故中止: [],
}

function nowText(): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  const time = new Date()
  return `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())} ${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}`
}

function hasText(value: string | number | boolean | undefined): boolean {
  return String(value ?? '').trim() !== ''
}

function parseAnomalyCount(value: string | number | boolean | undefined): number | null {
  if (!hasText(value)) {
    return null
  }
  const count = Number(value)
  return Number.isInteger(count) && count >= 0 ? count : null
}

function nextEntryId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function createPendingFireReport(droneTask: EntryRow): EntryRow {
  const fireReports = listRows('firereport')
  const linkedTaskId = String(droneTask.id)
  const found = fireReports.find((row) => String(row['关联无人机巡查任务'] ?? '') === linkedTaskId)
  if (found) {
    return found
  }

  const nextId = nextEntryId(fireReports)
  const report: EntryRow = {
    id: nextId,
    status: '待核实',
    pending: true,
    abnormal: false,
    报告编号: `FIRE-AUTO-${String(nextId).padStart(4, '0')}`,
    起火地点: String(droneTask['飞行区域'] ?? ''),
    起火时间: nowText(),
    火势等级: '待核实',
    过火面积: '待核实',
    扑救情况: '待核实',
    报告人: '无人机巡查',
    报告状态: '待核实',
    关联无人机巡查任务: linkedTaskId,
  }
  saveRows('firereport', [...fireReports, report])
  return report
}

function runDroneAction(action: string, row: EntryRow, actionData: ActionPayload): ActionResult {
  const current = String(row.status)

  if (current === '已完成' && action === '确认完成') {
    return { ok: true, message: '无人机巡查任务已完成，重复提交完成只记录一次' }
  }
  if (current === '因故中止' && action === '中止任务') {
    return { ok: true, message: '无人机巡查任务已中止，重复中止只记录一次' }
  }
  if (DRONE_TERMINAL_STATUSES.includes(current)) {
    return { ok: false, message: `无人机巡查任务已进入终态「${current}」，不能再切换状态` }
  }

  if (action === '开始飞行') {
    if (current !== '待执行') {
      return { ok: false, message: '只有待执行的无人机巡查任务才能起飞' }
    }
    if (!hasText(row['飞行路线'] as string | undefined)) {
      return { ok: false, message: '飞行路线缺失，无人机巡查任务不能起飞' }
    }
    const updated: EntryRow = {
      ...row,
      status: '飞行中',
      pending: true,
      abnormal: false,
      起飞时间: hasText(row['起飞时间'] as string | undefined) ? row['起飞时间'] : nowText(),
    }
    saveDroneRow(Number(row.id), updated)
    return { ok: true, message: '无人机巡查任务已开始飞行，当前状态「飞行中」' }
  }

  if (action === '中止任务') {
    if (!['待执行', '飞行中'].includes(current)) {
      return { ok: false, message: `无人机巡查任务当前为「${current}」，不能执行「${action}」` }
    }
    const updated: EntryRow = {
      ...row,
      status: '因故中止',
      pending: false,
      abnormal: true,
    }
    saveDroneRow(Number(row.id), updated)
    return { ok: true, message: '无人机巡查任务已中止，当前状态「因故中止」' }
  }

  if (current !== '飞行中') {
    return { ok: false, message: `无人机巡查任务当前为「${current}」，不能执行「${action}」` }
  }

  if (action === '确认完成') {
    const anomalyCount = parseAnomalyCount(
      actionData['发现异常数'] ?? String(row['发现异常数'] ?? ''),
    )
    if (anomalyCount === null) {
      return { ok: false, message: '确认完成前必须填写发现异常数' }
    }
    const landingTime = nowText()
    const updated: EntryRow = {
      ...row,
      status: '已完成',
      pending: false,
      abnormal: anomalyCount > 0,
      降落时间: landingTime,
      发现异常数: anomalyCount,
    }
    saveDroneRow(Number(row.id), updated)
    if (anomalyCount > 0) {
      createPendingFireReport(updated)
    }
    return { ok: true, message: '无人机巡查任务已完成，降落时间和发现异常数已记录' }
  }

  return { ok: false, message: `无人机巡查任务没有登记「${action}」这个动作` }
}

function saveDroneRow(id: number, updated: EntryRow): void {
  const rows = listRows('drone')
  const next = rows.map((row) => (Number(row.id) === Number(id) ? updated : row))
  saveRows('drone', next)
}

export function availableActions(key: string, status: string): string[] {
  if (key === 'drone') {
    return DRONE_AVAILABLE_ACTIONS[status] ?? []
  }
  return moduleMeta(key).actions
}

export function runAction(key: string, id: number, action: string, actionData: ActionPayload = {}): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }

  if (key === 'drone') {
    return runDroneAction(action, rows[index], actionData)
  }

  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
