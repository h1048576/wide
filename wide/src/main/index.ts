import { app, BrowserWindow, dialog, ipcMain, nativeTheme } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { detectApplication, disposeApplications, runApplication, quitApplication } from './applications'
import { Store } from './store'
import { runAllApplications } from './application-batch'
import { HarnessManager } from './harness'
import { StartupManager } from './startup'
import { APPLICATIONS, parseAppearance, parseHarnessSettings, parseFeatureId, parseMenuOrder, parseSettings, parseStartupMode, type FeatureId, type OperationLevel, type Theme } from '../shared/types'

let window: BrowserWindow | null = null
let busy = false
let quitting = false
let closingAfterSave = false
const store = new Store()
const startup = new StartupManager()
const harness = new HarnessManager()
let models: Promise<import('./models').ModelsManager> | undefined
let mcps: Promise<import('./mcps').McpsManager> | undefined
function getModels() {
  return models ??= import('./models').then(({ ModelsManager }) => new ModelsManager(undefined, join(app.getPath('userData'), 'model-backups'))).catch(error => { models = undefined; throw error })
}
function getMcps() {
  return mcps ??= import('./mcps').then(({ McpsManager }) => new McpsManager(undefined, join(app.getPath('userData'), 'mcp-backups'), {
    ...(process.env.CLAUDE_CONFIG_DIR ? { claude: join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') } : {}),
    ...(process.env.CODEX_HOME ? { codex: join(process.env.CODEX_HOME, 'config.toml') } : {})
  })).catch(error => { mcps = undefined; throw error })
}
const isDev = !app.isPackaged && !!process.env.ELECTRON_RENDERER_URL
const rendererFile = join(__dirname, '../renderer/index.html')
const rendererUrl = isDev ? process.env.ELECTRON_RENDERER_URL! : pathToFileURL(rendererFile).href

function registerIPC() {
  const handle = (channel: string, callback: (...args: any[]) => unknown) => {
    ipcMain.handle(channel, (event, ...args) => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('请求来源无效')
      return callback(...args)
    })
  }
  handle('wide:bootstrap', () => ({ preferences: store.preferences, platform: process.platform, version: app.getVersion(), windowMaximized: window?.isMaximized() ?? false, openAtLogin: startup.enabled, startupAvailable: startup.available, configWarning: store.warning }))
  handle('wide:open-at-login', (enabled: unknown) => startup.set(enabled))
  handle('wide:harness-inventory', (includeSkills: unknown = true) => {
    if (typeof includeSkills !== 'boolean') throw new Error('读取参数无效')
    return harness.inventory(includeSkills)
  })
  handle('wide:harness-skills-inventory', () => harness.skillsInventory())
  handle('wide:harness-preview-agents', () => harness.previewAgents())
  const harnessMutation = async (task: () => Promise<unknown>) => {
    if (busy) throw new Error('操作正在执行，请稍后再试。')
    busy = true
    try { return await task() } finally { busy = false; if (quitting) app.quit() }
  }
  handle('wide:harness-sync-agents', () => harnessMutation(() => harness.syncAgents()))
  handle('wide:harness-sync-skills', (source: unknown, skillId: unknown) => harnessMutation(() => harness.syncSkills(source, skillId)))
  handle('wide:harness-delete-skills', (id: unknown, skillId: unknown) => harnessMutation(() => harness.deleteSkills(id, skillId)))
  handle('wide:models-inventory', async () => (await getModels()).inventory())
  handle('wide:model-detail', async (target: unknown) => (await getModels()).detail(target))
  handle('wide:model-preview', async (sourceId: unknown) => (await getModels()).preview(sourceId))
  handle('wide:model-save', (change: unknown) => harnessMutation(async () => (await getModels()).save(change)))
  handle('wide:model-delete', (target: unknown) => harnessMutation(async () => (await getModels()).delete(target)))
  handle('wide:model-reorder', (order: unknown) => harnessMutation(async () => (await getModels()).reorder(order)))
  handle('wide:model-batch', (change: unknown) => harnessMutation(async () => (await getModels()).batch(change)))
  handle('wide:mcps-inventory', async () => (await getMcps()).inventory())
  handle('wide:mcps-refresh', async (id: unknown) => (await getMcps()).source(id))
  handle('wide:mcp-detail', async (target: unknown) => (await getMcps()).detail(target))
  handle('wide:mcp-preview', async (id: unknown) => (await getMcps()).preview(id))
  handle('wide:mcp-save', (change: unknown) => harnessMutation(async () => (await getMcps()).save(change)))
  handle('wide:mcp-delete', (target: unknown) => harnessMutation(async () => (await getMcps()).delete(target)))
  handle('wide:save', async (feature: unknown, input: unknown) => {
    const id = parseFeatureId(feature)
    const settings = parseSettings(input, id)
    await store.update(current => ({ ...current, applications: { ...current.applications, [id]: settings } }))
    return settings
  })
  handle('wide:theme', async (theme: Theme) => {
    if (!['system', 'light', 'dark'].includes(theme)) throw new Error('主题无效')
    await store.update(current => ({ ...current, theme }))
    nativeTheme.themeSource = theme
  })
  handle('wide:appearance', async (input: unknown) => {
    const appearance = parseAppearance(input)
    await store.update(current => ({ ...current, appearance }))
    return appearance
  })
  handle('wide:harness-settings', async (input: unknown) => {
    const harness = parseHarnessSettings(input)
    await store.update(current => ({ ...current, harness }))
    return harness
  })
  handle('wide:startup-mode', async (input: unknown) => {
    const startupMode = parseStartupMode(input)
    await store.update(current => ({ ...current, startupMode }))
  })
  handle('wide:menu-order', async (input: unknown) => {
    const menuOrder = parseMenuOrder(input)
    await store.update(current => ({ ...current, menuOrder }))
    return menuOrder
  })
  handle('wide:detect', (feature: unknown, path: unknown, force: unknown = false) => {
    const id = parseFeatureId(feature)
    if (typeof path !== 'string' || path.length > 4096 || /[\0\r\n]/.test(path)) throw new Error('应用路径无效')
    if (typeof force !== 'boolean') throw new Error('检测参数无效')
    return detectApplication(id, path, force)
  })
  handle('wide:choose', async (feature: unknown) => {
    const id = parseFeatureId(feature)
    const result = await dialog.showOpenDialog(window!, {
      title: `选择 ${id === 'droid' ? 'Droid / Factory' : APPLICATIONS[id].name} 桌面应用`,
      properties: ['openFile'],
      ...(process.platform === 'win32' ? { filters: [{ name: '桌面应用', extensions: ['exe'] }] } : process.platform === 'darwin' ? { filters: [{ name: '应用程序', extensions: ['app'] }] } : {})
    })
    return result.canceled ? null : result.filePaths[0]
  })
  handle('wide:run', async (feature: unknown, action: unknown, input: unknown) => {
    const id = parseFeatureId(feature)
    const name = APPLICATIONS[id].name
    if (action !== 'apply' && action !== 'normal') throw new Error('操作无效')
    if (busy) throw new Error('应用操作正在执行，请稍后再试。')
    const settings = parseSettings(input, id)
    let failureDetail = ''
    let operationRunning = true
    const report = (message: string, level: OperationLevel = 'info') => {
      if (level !== 'error') return
      if (operationRunning) failureDetail = message.replace(/^失败：/, '')
      else if (window && !window.isDestroyed()) window.webContents.send('wide:notice', { success: false, message })
    }
    busy = true
    try {
      await store.update(current => ({ ...current, applications: { ...current.applications, [id]: settings } }))
      await runApplication(id, action, settings, report, store.preferences.startupMode)
      const message = action === 'normal' ? `${name} 已以默认界面重新启动。` : `${name} 界面设置已生效。`
      return { success: true, message }
    } catch (error) {
      const message = failureDetail || (error instanceof Error ? error.message : String(error))
      return { success: false, message }
    } finally {
      operationRunning = false
      busy = false
      if (quitting) app.quit()
    }
  })
  handle('wide:window', (action: unknown) => {
    if (action === 'minimize') window?.minimize()
    if (action === 'maximize') window?.isMaximized() ? window.unmaximize() : window?.maximize()
    if (action === 'close') window?.close()
  })
  handle('wide:quit', async (feature: unknown, path: unknown) => {
    const id = parseFeatureId(feature)
    if (typeof path !== 'string' || path.length > 4096 || /[\0\r\n]/.test(path)) throw new Error('应用路径无效')
    if (busy) throw new Error('应用操作正在执行，请稍后再试。')
    busy = true
    try {
      await quitApplication(id, path)
      return { success: true, message: `${APPLICATIONS[id].name} 已完全退出。` }
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : String(error) }
    } finally {
      busy = false
      if (quitting) app.quit()
    }
  })
  handle('wide:run-all', async (action: unknown, input: unknown) => {
    if (action !== 'start' && action !== 'restart' && action !== 'exit') throw new Error('全局操作无效')
    let ids: FeatureId[] | undefined
    if (input !== undefined) {
      if (!Array.isArray(input) || !input.length) throw new Error('请选择要操作的应用')
      ids = input.map(parseFeatureId)
    }
    if (busy) throw new Error('应用操作正在执行，请稍后再试。')
    busy = true
    // 其他应用启动时会遮住 wide，批量进度仍需及时绘制。
    window?.webContents.setBackgroundThrottling(false)
    try {
      // 退出仍使用最后成功保存的设置，避免字体等设置保存失败时无法退出应用。
      await store.flush().catch(error => { if (action !== 'exit') throw error })
      return await runAllApplications(action, store.preferences,
        progress => { if (window && !window.isDestroyed()) window.webContents.send('wide:batch-progress', progress) }, ids)
    } finally {
      busy = false
      if (window && !window.isDestroyed()) window.webContents.setBackgroundThrottling(true)
      if (quitting) app.quit()
    }
  })
}
function createWindow() {
  window = new BrowserWindow({
    width: 1260, height: 880, minWidth: 960, minHeight: 680,
    title: 'wide', backgroundColor: nativeTheme.shouldUseDarkColors ? '#101010' : '#ffffff',
    icon: join(app.getAppPath(), 'build/icon.png'),
    frame: false, titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 18, y: 18 }, show: false,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false }
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => { if (url !== rendererUrl) event.preventDefault() })
  window.once('ready-to-show', () => window?.show())
  const publishMaximized = () => {
    if (window && !window.isDestroyed()) window.webContents.send('wide:window-maximized', window.isMaximized())
  }
  window.on('maximize', publishMaximized)
  window.on('unmaximize', publishMaximized)
  window.on('close', event => {
    if (busy) {
      event.preventDefault()
      dialog.showMessageBox(window!, { type: 'info', title: '应用正在执行操作', message: '请等待当前操作完成后再关闭窗口。', buttons: ['知道了'] })
    } else if (store.isSaving) {
      event.preventDefault()
      if (closingAfterSave) return
      closingAfterSave = true
      void store.flush().then(() => {
        closingAfterSave = false
        if (window && !window.isDestroyed()) window.close()
      }).catch(error => {
        closingAfterSave = false
        if (window && !window.isDestroyed()) void dialog.showMessageBox(window, { type: 'error', title: '自动保存失败', message: error.message, buttons: ['知道了'] })
      })
    }
  })
  window.on('closed', () => { window = null })
  if (isDev) void window.loadURL(rendererUrl)
  else void window.loadFile(rendererFile)
}
app.setName('wide')
if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.focus() })
  app.whenReady().then(async () => {
    await store.load()
    nativeTheme.themeSource = store.preferences.theme
    registerIPC(); createWindow()
    app.on('activate', () => { if (!window) createWindow() })
  })
  app.on('before-quit', event => { if (busy) { event.preventDefault(); quitting = true } else disposeApplications() })
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
}
