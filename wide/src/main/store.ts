import { app } from 'electron'
import { readFile, mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DEFAULT_APPEARANCE, DEFAULT_APPLICATIONS, DEFAULT_HARNESS_SETTINGS, DEFAULT_MENU_ORDER, MENU_ORDER_VERSION, APPLICATION_PORTS_VERSION, normalizeMenuOrder, parseAppearance, parseHarnessSettings, parseSettings, type Preferences, type ApplicationPreferences, type FeatureId } from '../shared/types'

const LEGACY_APPLICATION_PORTS: Record<Exclude<FeatureId, 'codex'>, number> = { droid: 9335, zcode: 9332, workbuddy: 9333, dsh: 9337, qoder: 9334, paseo: 9336 }

export class Store {
  preferences: Preferences = { applications: structuredClone(DEFAULT_APPLICATIONS), theme: 'system', appearance: { ...DEFAULT_APPEARANCE }, harness: { ...DEFAULT_HARNESS_SETTINGS }, startupMode: 'default', menuOrder: [...DEFAULT_MENU_ORDER], menuOrderVersion: MENU_ORDER_VERSION, applicationPortsVersion: APPLICATION_PORTS_VERSION }
  warning?: string
  private queue: Promise<void> = Promise.resolve()
  private pending = 0
  private changes: { change: (current: Preferences) => Preferences; resolve: () => void; reject: (error: unknown) => void }[] = []
  private timer?: ReturnType<typeof setTimeout>
  private queuedAt = 0
  private saveError?: Error
  get isSaving() { return this.pending > 0 }
  private get root() { return app.getPath('userData') }
  async load() {
    try {
      let text: string
      try { text = await readFile(join(this.root, 'settings.json'), 'utf8') }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        // 应用改名后继续读取旧版配置，下一次自动保存会写入新目录。
        text = await readFile(join(app.getPath('appData'), 'Wide Desktop', 'settings.json'), 'utf8')
      }
      const data = JSON.parse(text)
      this.preferences = {
        applications: Object.fromEntries(DEFAULT_MENU_ORDER.map(id => {
          const saved = data.applications?.[id] ?? (id === 'droid' ? data.droid : undefined)
          const settings = { ...DEFAULT_APPLICATIONS[id], ...saved }
          // 旧版 ZCode 的字号未开放，保存的 17 是通用占位值。
          if (id === 'zcode' && saved?.terminalFollow === undefined) settings.fontSize = DEFAULT_APPLICATIONS.zcode.fontSize
          // 只迁移旧预设端口；Codex 和自定义端口保持原值。保存版本标记后不再重复迁移。
          if (data.applicationPortsVersion !== APPLICATION_PORTS_VERSION && id !== 'codex' && saved?.port === LEGACY_APPLICATION_PORTS[id]) settings.port = DEFAULT_APPLICATIONS[id].port
          return [id, parseSettings(settings, id)]
        })) as ApplicationPreferences,
        theme: ['system', 'light', 'dark'].includes(data.theme) ? data.theme : 'system',
        startupMode: data.startupMode === 'maximized' ? 'maximized' : 'default',
        appearance: data.appearance === undefined ? { ...DEFAULT_APPEARANCE } : parseAppearance(data.appearance),
        harness: data.harness === undefined ? { ...DEFAULT_HARNESS_SETTINGS } : parseHarnessSettings({ ...DEFAULT_HARNESS_SETTINGS, ...data.harness }),
        menuOrder: data.menuOrderVersion === MENU_ORDER_VERSION ? normalizeMenuOrder(data.menuOrder) : [...DEFAULT_MENU_ORDER], menuOrderVersion: MENU_ORDER_VERSION,
        applicationPortsVersion: APPLICATION_PORTS_VERSION
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.warning = '本机设置文件无法读取，已暂用默认值。原文件会保留。'
      }
    }
  }
  update(change: (current: Preferences) => Preferences) {
    this.pending++
    const result = new Promise<void>((resolve, reject) => { this.changes.push({ change, resolve, reject }) })
    if (!this.queuedAt) this.queuedAt = Date.now()
    clearTimeout(this.timer)
    // 连续输入合并保存，持续输入时最多等待 600 毫秒；执行操作和关闭时立即刷盘。
    this.timer = setTimeout(() => this.flushBatch(), Math.max(0, Math.min(150, 600 - (Date.now() - this.queuedAt))))
    return result
  }
  private flushBatch() {
    clearTimeout(this.timer); this.timer = undefined; this.queuedAt = 0
    const changes = this.changes.splice(0)
    if (!changes.length) return
    const task = this.queue.then(async () => {
      const preferences = changes.reduce((current, item) => item.change(current), this.preferences)
      const snapshot = JSON.stringify(preferences, null, 2)
      if (!this.warning && snapshot === JSON.stringify(this.preferences, null, 2)) return
      await mkdir(this.root, { recursive: true })
      if (this.warning) {
        await rename(join(this.root, 'settings.json'), join(this.root, `settings.backup-${Date.now()}.json`)).catch(error => {
          if (error.code !== 'ENOENT') throw error
        })
        this.warning = undefined
      }
      const file = join(this.root, 'settings.json')
      await writeFile(file + '.tmp', snapshot, 'utf8')
      await rename(file + '.tmp', file)
      this.preferences = preferences
    })
    const tracked = task.then(() => {
      this.saveError = undefined
      changes.forEach(item => item.resolve())
    }, error => {
      this.saveError = error instanceof Error ? error : new Error(String(error))
      changes.forEach(item => item.reject(this.saveError))
    }).finally(() => { this.pending -= changes.length })
    this.queue = tracked
  }
  async flush() {
    while (this.isSaving) { this.flushBatch(); await this.queue }
    if (this.saveError) throw this.saveError
  }
}
