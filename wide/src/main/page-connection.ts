import WebSocket from 'ws'
import type { OperationLevel } from '../shared/types'
type WriteLog = (message: string, level?: OperationLevel) => void

interface Target { type: string; url: string; webSocketDebuggerUrl: string }
class Cdp {
  private socket: WebSocket
  private id = 0
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private listeners = new Map<string, () => void>()
  constructor(url: string) {
    const parsed = new URL(url)
    if (parsed.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) throw new Error('应用调试地址不是本机地址')
    this.socket = new WebSocket(url, { handshakeTimeout: 5000, maxPayload: 2 * 1024 * 1024 })
    this.socket.on('message', raw => {
      try {
        const data = JSON.parse(raw.toString())
        if (data.method) { this.listeners.get(data.method)?.(); return }
        const entry = this.pending.get(data.id)
        if (!entry) return
        this.pending.delete(data.id); clearTimeout(entry.timer)
        data.error ? entry.reject(new Error(data.error.message)) : entry.resolve(data.result)
      } catch { this.close() }
    })
    this.socket.on('close', () => this.fail(new Error('应用调试连接已关闭')))
    this.socket.on('error', error => this.fail(error))
  }
  private fail(error: Error) {
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error) }
    this.pending.clear()
  }
  async connect() {
    if (this.socket.readyState === WebSocket.OPEN) return
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => { cleanup(); resolve() }
      const onError = (error: Error) => { cleanup(); reject(error) }
      const onClose = () => onError(new Error('应用调试连接已关闭'))
      const cleanup = () => { this.socket.off('open', onOpen); this.socket.off('error', onError); this.socket.off('close', onClose) }
      this.socket.once('open', onOpen); this.socket.once('error', onError); this.socket.once('close', onClose)
    })
  }
  command(method: string, params: Record<string, unknown>) {
    return new Promise<any>((resolve, reject) => {
      const id = ++this.id
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`应用命令超时：${method}`)) }, 5000)
      this.pending.set(id, { resolve, reject, timer })
      this.socket.send(JSON.stringify({ id, method, params }), error => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(error) }
      })
    })
  }
  close() { this.fail(new Error('调试连接已结束')); this.socket.terminate() }
  get connected() { return this.socket.readyState === WebSocket.OPEN }
  on(method: string, callback: () => void) { this.listeners.set(method, callback) }
}

export function createPageConnection(name: string, styleId: string, acceptsPage: (url: string) => boolean = () => true) {
  const sessions = new Map<string, Cdp>()
  let watchTimer: ReturnType<typeof setInterval> | undefined
  let watchGeneration = 0
  function dispose() {
    watchGeneration++
    if (watchTimer) clearInterval(watchTimer)
    watchTimer = undefined
    for (const session of sessions.values()) session.close()
    sessions.clear()
  }
  async function readTargets(port: number): Promise<Target[]> {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) })
    if (!response.ok) throw new Error('无法读取 应用调试页面')
    const data = await response.json()
    if (!Array.isArray(data)) throw new Error('应用调试响应格式无效')
    return data.filter((target: Target) => target.type === 'page' && typeof target.webSocketDebuggerUrl === 'string' && typeof target.url === 'string' && !target.url.startsWith('devtools://') && target.url !== 'about:blank' && acceptsPage(target.url))
  }
  async function attachTarget(target: Target, source: string, log: WriteLog, generation: number) {
    const cdp = new Cdp(target.webSocketDebuggerUrl)
    try {
      await cdp.connect()
      await cdp.command('Page.enable', {})
      const ready = await cdp.command('Runtime.evaluate', { expression: '!!document.documentElement && document.readyState !== "loading"', returnByValue: true })
      if (ready.exceptionDetails || ready.result?.value !== true) throw new Error('主页面尚未完成加载。')
      const result = await cdp.command('Runtime.evaluate', { expression: source, returnByValue: true })
      if (result.exceptionDetails) {
        const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text || '未知脚本错误'
        throw new Error(`应用界面注入失败：${detail}`)
      }
      if (result.result?.value !== true) throw new Error('应用界面尚未就绪，设置未生效。')
      await cdp.command('Page.addScriptToEvaluateOnNewDocument', { source })
      cdp.on('Page.domContentEventFired', () => {
        if (generation !== watchGeneration) return
        void cdp.command('Runtime.evaluate', { expression: source, returnByValue: true }).then(result => {
          if (result.exceptionDetails) log('应用页面刷新后应用设置失败，请再次应用。', 'error')
        }).catch(() => { /* 页面重载时执行上下文可能暂时消失，由定时检查重试。 */ })
      })
      if (generation !== watchGeneration) { cdp.close(); return }
      sessions.set(target.webSocketDebuggerUrl, cdp)
      // 此会话持续保留，以确保页面刷新时注入规则仍然有效。
      if (process.platform !== 'win32') {
        try {
          const { windowId } = await cdp.command('Browser.getWindowForTarget', {})
          await cdp.command('Browser.setWindowBounds', { windowId, bounds: { windowState: 'maximized' } })
        } catch { log('界面设置已生效；当前平台未提供窗口最大化接口。') }
      }
    } catch (error) { cdp.close(); throw error }
  }
  async function connect(port: number, source: string, log: WriteLog) {
    dispose()
    const generation = watchGeneration
    try {
      const targets = await readTargets(port)
      if (!targets.length) throw new Error('应用没有可用的调试页面')
      const results = await Promise.allSettled(targets.map(target => attachTarget(target, source, log, generation)))
      if (!results.some(result => result.status === 'fulfilled')) {
        const failure = results.find(result => result.status === 'rejected')
        const detail = failure?.status === 'rejected' ? String(failure.reason instanceof Error ? failure.reason.message : failure.reason) : '主页面尚未就绪'
        throw new Error(`${name} 应用设置失败：${detail}`)
      }
    } catch (error) { dispose(); throw error }
    let checking = false
    let unavailable = 0
    const reported = new Set<string>()
    const failingSince = new Map<string, number>()
    watchTimer = setInterval(async () => {
      if (checking || generation !== watchGeneration) return
      checking = true
      try {
        const targets = await readTargets(port)
        if (generation !== watchGeneration) return
        unavailable = 0
        const urls = new Set(targets.map(target => target.webSocketDebuggerUrl))
        for (const url of failingSince.keys()) if (!urls.has(url)) { failingSince.delete(url); reported.delete(url) }
        for (const [url, cdp] of sessions) if (!urls.has(url) || !cdp.connected) { cdp.close(); sessions.delete(url) }
        for (const target of targets) {
          const existing = sessions.get(target.webSocketDebuggerUrl)
          if (existing) {
            // 页面加载事件之外，再检查一次守护状态，兼容应用内部替换页面。
            try {
              const result = await existing.command('Runtime.evaluate', { expression: `!!document.getElementById(${JSON.stringify(styleId)})`, returnByValue: true })
              if (!result.result?.value) await existing.command('Runtime.evaluate', { expression: source, returnByValue: true })
            } catch { /* 页面导航结束后会在下一轮重试。 */ }
            continue
          }
          try { await attachTarget(target, source, log, generation); reported.delete(target.webSocketDebuggerUrl); failingSince.delete(target.webSocketDebuggerUrl) }
          catch (error) {
            if (generation !== watchGeneration) return
            const since = failingSince.get(target.webSocketDebuggerUrl) ?? Date.now()
            failingSince.set(target.webSocketDebuggerUrl, since)
            // 新窗口和导航期间持续重试，避免瞬时失败把整次批量启动改成失败。
            if (Date.now() - since >= 60000 && !reported.has(target.webSocketDebuggerUrl)) {
              reported.add(target.webSocketDebuggerUrl)
              log(`${name} 新页面应用设置失败：${error instanceof Error ? error.message : String(error)}`, 'error')
            }
          }
        }
      } catch {
        if (++unavailable >= 5 && generation === watchGeneration) {
          dispose()
          log('应用调试连接已结束。下次启动时请再次应用设置。')
        }
      } finally { checking = false }
    }, 2000)
    watchTimer.unref()
  }


  return { connect, dispose }
}
