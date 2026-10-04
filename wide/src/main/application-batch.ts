import { detectApplication, isApplicationRunning, quitApplication, runApplication } from './applications'
import { normalizeMenuOrder, type BatchAction, type BatchApplicationResult, type BatchProgress, type BatchResult, type BatchStage, type FeatureId, type OperationLevel, type Preferences } from '../shared/types'

let batchRevision = 0
const BATCH_CONCURRENCY = 5

export async function runAllApplications(action: BatchAction, preferences: Preferences, onProgress: (progress: BatchProgress) => void, ids?: FeatureId[]): Promise<BatchResult> {
  const revision = ++batchRevision
  const snapshot = structuredClone(preferences)
  const order = normalizeMenuOrder(snapshot.menuOrder).filter(id => !ids || ids.includes(id))
  const resultsById = new Map<FeatureId, BatchApplicationResult>()
  const activeIds = new Set<FeatureId>()
  const stages: Partial<Record<FeatureId, BatchStage>> = Object.fromEntries(order.map(id => [id, 'queued']))
  const orderedResults = () => order.flatMap(id => {
    const result = resultsById.get(id)
    return result ? [{ ...result }] : []
  })
  const publish = () => {
    onProgress({ action, applicationIds: [...order], stages: { ...stages }, currentIds: order.filter(id => activeIds.has(id)), completed: resultsById.size, total: order.length, results: orderedResults() })
  }

  const completedText = { start: '已启动', restart: '已重启', exit: '已退出' }[action]

  // 按菜单顺序分配任务；不同应用并发，同一应用的退出、启动仍顺序执行。
  const processApplication = async (id: FeatureId) => {
    activeIds.add(id)
    const stage = (value: BatchStage) => {
      if (stages[id] === value) return
      stages[id] = value; publish()
    }
    stage('detecting')
    const settings = snapshot.applications[id]
    let failureDetail = ''
    let operationRunning = true
    const report = (message: string, level: OperationLevel = 'info') => {
      if (level !== 'error') return
      if (operationRunning) failureDetail = message.replace(/^失败：/, '')
      else if (revision === batchRevision) {
        // 后台连接的错误也更新页面内结果，批量操作不发送弹出通知。
        const result = resultsById.get(id)
        if (result) { result.status = 'error'; result.message = message; publish() }
      }
    }
    try {
      // 启动复用短期安装缓存；运行状态仍实时查询，重启和退出仍重新识别安装。
      const installation = await detectApplication(id, settings.executablePath, action !== 'start')
      if (!installation) {
        resultsById.set(id, { id, status: 'skipped', skipReason: 'not-installed', message: '未安装，已跳过' })
      } else {
        if (action === 'start') {
          stage('checking')
          if (await isApplicationRunning(id, installation)) {
            resultsById.set(id, { id, status: 'skipped', skipReason: 'already-running', message: '已运行，已跳过' })
            return
          }
        }
        if (action === 'restart' || action === 'exit') {
          stage('stopping')
          await quitApplication(id, settings.executablePath, installation)
        }
        if (action !== 'exit') {
          stage('starting')
          await runApplication(id, 'apply', settings, report, snapshot.startupMode, stage)
        }
        resultsById.set(id, { id, status: 'success', message: completedText })
      }
    } catch (error) {
      resultsById.set(id, { id, status: 'error', message: failureDetail || (error instanceof Error ? error.message : String(error)) })
    } finally { operationRunning = false; activeIds.delete(id); delete stages[id]; publish() }
  }
  const queue = [...order]
  await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const id = queue.shift()
      if (!id) return
      await processApplication(id)
    }
  }))
  publish()
  const results = orderedResults()
  const succeeded = results.filter(result => result.status === 'success').length
  const alreadyRunning = results.filter(result => result.skipReason === 'already-running').length
  const notInstalled = results.filter(result => result.skipReason === 'not-installed').length
  const failed = results.filter(result => result.status === 'error').length
  const details = [succeeded ? `${completedText} ${succeeded} 个应用` : '', alreadyRunning ? `${alreadyRunning} 个已运行，已跳过` : '', notInstalled ? `${notInstalled} 个未安装，已跳过` : '', failed ? `${failed} 个失败` : ''].filter(Boolean)
  return { action, results, success: failed === 0 && (action === 'exit' || succeeded > 0 || alreadyRunning > 0), message: details.join('；') + '。' }
}
