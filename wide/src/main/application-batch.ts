import { detectApplication, isApplicationRunning, quitApplication, runApplication } from './applications'
import { normalizeMenuOrder, type BatchAction, type BatchApplicationResult, type BatchProgress, type BatchResult, type OperationLevel, type Preferences } from '../shared/types'

let batchRevision = 0

export async function runAllApplications(action: BatchAction, preferences: Preferences, onProgress: (progress: BatchProgress) => void): Promise<BatchResult> {
  const revision = ++batchRevision
  const snapshot = structuredClone(preferences)
  const order = normalizeMenuOrder(snapshot.menuOrder)
  const results: BatchApplicationResult[] = []
  let currentId: BatchProgress['currentId'] = null
  const publish = (id = currentId) => {
    currentId = id
    onProgress({ action, currentId, completed: results.length, total: order.length, results: results.map(result => ({ ...result })) })
  }

  const completedText = { start: '已启动', restart: '已重启', exit: '已退出' }[action]

  // 按菜单顺序逐个执行，单个应用失败后仍继续处理其余应用。
  for (const id of order) {
    publish(id)
    const settings = snapshot.applications[id]
    let failureDetail = ''
    let operationRunning = true
    const report = (message: string, level: OperationLevel = 'info') => {
      if (level !== 'error') return
      if (operationRunning) failureDetail = message.replace(/^失败：/, '')
      else if (revision === batchRevision) {
        // 后台连接的错误也更新页面内结果，批量操作不发送弹出通知。
        const result = results.find(item => item.id === id)
        if (result) { result.status = 'error'; result.message = message; publish() }
      }
    }
    try {
      const installation = await detectApplication(id, settings.executablePath, true)
      if (!installation) {
        results.push({ id, status: 'skipped', skipReason: 'not-installed', message: '未安装，已跳过' })
      } else if (action === 'start' && await isApplicationRunning(id, installation)) {
        results.push({ id, status: 'skipped', skipReason: 'already-running', message: '已运行，已跳过' })
      } else {
        if (action === 'restart' || action === 'exit') await quitApplication(id, settings.executablePath)
        if (action !== 'exit') await runApplication(id, 'apply', settings, report, snapshot.startupMode)
        results.push({ id, status: 'success', message: completedText })
      }
    } catch (error) {
      results.push({ id, status: 'error', message: failureDetail || (error instanceof Error ? error.message : String(error)) })
    } finally { operationRunning = false }
  }
  publish(null)
  const succeeded = results.filter(result => result.status === 'success').length
  const alreadyRunning = results.filter(result => result.skipReason === 'already-running').length
  const notInstalled = results.filter(result => result.skipReason === 'not-installed').length
  const failed = results.filter(result => result.status === 'error').length
  const details = [succeeded ? `${completedText} ${succeeded} 个应用` : '', alreadyRunning ? `${alreadyRunning} 个已运行，已跳过` : '', notInstalled ? `${notInstalled} 个未安装，已跳过` : '', failed ? `${failed} 个失败` : ''].filter(Boolean)
  return { action, results, success: failed === 0 && (action === 'exit' || succeeded > 0 || alreadyRunning > 0), message: details.join('；') + '。' }
}
