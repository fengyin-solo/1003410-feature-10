import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

function formatNow(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}

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

export function runAction(
  key: string,
  id: number,
  action: string,
  payload: Record<string, string | number> = {},
): ActionResult {
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
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  // 终态只进不出：完成与中止互斥，先到的终态生效，后到的动作一律拒绝。
  if (meta.terminalStatuses?.includes(current)) {
    return { ok: false, message: `${meta.entity}已是终态「${current}」，不得再切换状态` }
  }
  // 状态按方向推进：动作只允许从登记过的来源状态发起，不许跳步或回退。
  const sources = meta.actionSources?.[action]
  if (sources && !sources.includes(current)) {
    return { ok: false, message: `${meta.entity}当前状态「${current}」不能执行「${action}」` }
  }
  // 没配 terminalStatuses 的模块沿用旧约定：状态列表最后一项视为终态。
  const terminals = meta.terminalStatuses ?? [meta.statuses[meta.statuses.length - 1]]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: !terminals.includes(target),
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  if (key === 'drone') {
    const failure = applyDroneRules(rows[index], target, updated, payload)
    if (failure) {
      return failure
    }
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  let message = `${meta.entity}已${action}，当前状态「${target}」`
  if (key === 'drone' && target === '已完成' && Number(updated['发现异常数']) > 0) {
    appendDroneFirereport(updated)
    message += '，已联动火情报告登记 1 条待核实项'
  }
  return { ok: true, message }
}

// 无人机巡查的专属规则：起飞前必须有飞行路线，确认完成前必须落实降落时间和发现异常数。
function applyDroneRules(
  row: EntryRow,
  target: string,
  updated: EntryRow,
  payload: Record<string, string | number>,
): ActionResult | null {
  if (target === '飞行中') {
    const route = String(row['飞行路线'] ?? '').trim()
    if (route === '' || route === '—') {
      return { ok: false, message: '无人机巡查任务缺少飞行路线，不得起飞' }
    }
  }
  if (target === '已完成') {
    const raw = String(payload['发现异常数'] ?? '').trim()
    const count = Number(raw)
    if (raw === '' || !Number.isInteger(count) || count < 0) {
      return { ok: false, message: '确认完成前必须写入发现异常数（非负整数）' }
    }
    updated['降落时间'] = formatNow()
    updated['发现异常数'] = count
  }
  return null
}

// 无人机发现异常后，联动火情报告模块写一条待核实项，火情报告页会同步看到。
function appendDroneFirereport(droneRow: EntryRow): void {
  const count = Number(droneRow['发现异常数']) || 0
  if (count <= 0) {
    return
  }
  const reports = listRows('firereport')
  const id = reports.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1
  const report: EntryRow = {
    id,
    status: '待核实',
    pending: true,
    abnormal: false,
    报告编号: `FIRE-${String(id).padStart(4, '0')}`,
    起火地点: String(droneRow['飞行区域'] ?? ''),
    起火时间: formatNow(),
    火势等级: '待核实',
    过火面积: '待核实',
    扑救情况: `无人机巡查发现异常 ${count} 处，待现场核实`,
    报告人: `无人机巡查任务 ${droneRow['任务编号'] ?? ''}`,
    报告状态: '待核实',
  }
  saveRows('firereport', [...reports, report])
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
