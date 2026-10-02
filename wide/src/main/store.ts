import { app } from 'electron'
import { readFile, mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DEFAULT_APPEARANCE, DEFAULT_APPLICATIONS, DEFAULT_MENU_ORDER, MENU_ORDER_VERSION, normalizeMenuOrder, parseAppearance, parseSettings, type Preferences, type ApplicationPreferences } from '../shared/types'

export class Store {
  preferences: Preferences = { applications: structuredClone(DEFAULT_APPLICATIONS), theme: 'system', appearance: { ...DEFAULT_APPEARANCE }, menuOrder: [...DEFAULT_MENU_ORDER], menuOrderVersion: MENU_ORDER_VERSION }
  warning?: string
  private queue: Promise<void> = Promise.resolve()
  private pending = 0
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
        applications: Object.fromEntries(DEFAULT_MENU_ORDER.map(id => [id, parseSettings({ ...DEFAULT_APPLICATIONS[id], ...(data.applications?.[id] ?? (id === 'droid' ? data.droid : undefined)) }, id)])) as ApplicationPreferences,
        theme: ['system', 'light', 'dark'].includes(data.theme) ? data.theme : 'system',
        appearance: data.appearance === undefined ? { ...DEFAULT_APPEARANCE } : parseAppearance(data.appearance),
        menuOrder: data.menuOrderVersion === MENU_ORDER_VERSION ? normalizeMenuOrder(data.menuOrder) : [...DEFAULT_MENU_ORDER], menuOrderVersion: MENU_ORDER_VERSION
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.warning = '本机设置文件无法读取，已暂用默认值。原文件会保留。'
      }
    }
  }
  update(change: (current: Preferences) => Preferences) {
    this.pending++
    const task = this.queue.then(async () => {
      const preferences = change(this.preferences)
      const snapshot = JSON.stringify(preferences, null, 2)
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
    const tracked = task.then(() => { this.saveError = undefined }, error => {
      this.saveError = error instanceof Error ? error : new Error(String(error))
      throw error
    }).finally(() => { this.pending-- })
    this.queue = tracked.catch(() => {})
    return tracked
  }
  async flush() {
    while (this.isSaving) await this.queue
    if (this.saveError) throw this.saveError
  }
}
