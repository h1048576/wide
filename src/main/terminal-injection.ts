import type { ApplicationSettings } from '../shared/types'

// 支持的应用使用 xterm 绘制终端；必须更新实例选项并重新 fit，CSS 无法同步字符网格。
function installTerminalFollow(settings: { key: string; enabled: boolean; fontFamily: string; fontSize: number; fontWeight: number }) {
  const scope = window as any
  const key = settings.key
  if (scope[key]) { scope[key].update(settings); return true }
  const entries = new Map<HTMLElement, { terminal: any; fit: any; original: Record<string, unknown> }>()
  let current = settings
  let scheduled = false
  function apply(entry: { terminal: any; fit: any; original: Record<string, unknown> }) {
    const next = current.enabled ? { fontFamily: current.fontFamily, fontSize: current.fontSize, fontWeight: current.fontWeight } : entry.original
    let changed = false
    for (const [name, value] of Object.entries(next)) {
      if (entry.terminal.options[name] !== value) { entry.terminal.options[name] = value; changed = true }
    }
    if (changed || entry.terminal.element?.getClientRects().length) entry.fit?.fit()
  }
  function scan() {
    scheduled = false
    for (const [element] of entries) if (!element.isConnected) { resize.unobserve(element); entries.delete(element) }
    for (const element of document.querySelectorAll<HTMLElement>('.xterm')) {
      if (entries.has(element)) continue
      // React 函数组件的 ref 保存着 xterm 和 FitAddon，仅检查终端所在的祖先链。
      let terminal: any, fit: any
      for (let node: HTMLElement | null = element; node && !terminal; node = node.parentElement) {
        const fiberKey = Object.keys(node).find(name => name.startsWith('__reactFiber$'))
        let fiber = fiberKey ? (node as any)[fiberKey] : null
        for (let depth = 0; fiber && depth < 32; depth++, fiber = fiber.return) {
          let hook = fiber.memoizedState
          for (let count = 0; hook && count < 80; count++, hook = hook.next) {
            const value = hook.memoizedState?.current
            if (value?.element === element && value.options && typeof value.resize === 'function') terminal = value
            if (typeof value?.fit === 'function' && typeof value?.proposeDimensions === 'function') fit = value
          }
          if (terminal) break
        }
      }
      // Qoder 未将 FitAddon 保存在 React ref 中，从已加载的终端插件获取。
      if (terminal && !fit) fit = terminal._addonManager?._addons?.find((addon: any) => !addon.isDisposed && typeof addon.instance?.fit === 'function' && typeof addon.instance?.proposeDimensions === 'function')?.instance
      if (!terminal || !fit) continue
      const original = { fontFamily: terminal.options.fontFamily, fontSize: terminal.options.fontSize, fontWeight: terminal.options.fontWeight }
      const entry = { terminal, fit, original }
      entries.set(element, entry)
      resize.observe(element)
      try { apply(entry) } catch { entries.delete(element); resize.unobserve(element) }
    }
  }
  function schedule() { if (!scheduled) { scheduled = true; setTimeout(scan, 0) } }
  const resize = new ResizeObserver(records => {
    for (const record of records) {
      const entry = entries.get(record.target as HTMLElement)
      if (entry && record.contentRect.width && record.contentRect.height) { try { apply(entry) } catch { /* 终端可能正在卸载。 */ } }
    }
  })
  const observer = new MutationObserver(records => {
    if (records.some(record => [...record.addedNodes, ...record.removedNodes].some(node => node instanceof Element && (node.matches('.xterm') || node.querySelector('.xterm'))))) schedule()
  })
  observer.observe(document.documentElement, { childList: true, subtree: true })
  scope[key] = {
    update(next: typeof settings) {
      current = next
      for (const entry of entries.values()) { try { apply(entry) } catch { /* 忽略已释放的实例。 */ } }
      schedule()
    }
  }
  document.fonts.ready.then(() => { for (const entry of entries.values()) { try { apply(entry) } catch { /* 终端可能已释放。 */ } } })
  scan()
  return true
}

export function terminalInjection(id: 'droid' | 'zcode' | 'dsh' | 'qoder', settings: ApplicationSettings) {
  const keys = { droid: '__wideDroidTerminalFollow', zcode: '__wideZcodeTerminalFollow', dsh: '__wideDshTerminalFollow', qoder: '__wideQoderTerminalFollow' }
  const key = keys[id]
  return `(${installTerminalFollow.toString()})(${JSON.stringify({ key, enabled: settings.terminalFollow, fontFamily: settings.fontFamily, fontSize: settings.fontSize, fontWeight: settings.fontWeight })})`
}
