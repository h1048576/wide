import { app, BrowserWindow, dialog, ipcMain, nativeTheme } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { detectApplication, disposeApplications, runApplication } from './applications'
import { Store } from './store'
import { APPLICATIONS, parseAppearance, parseFeatureId, parseMenuOrder, parseSettings, type OperationLevel, type Theme } from '../shared/types'

let window: BrowserWindow | null = null
let busy = false
let quitting = false
let closingAfterSave = false
const store = new Store()
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
  handle('wide:bootstrap', () => ({ preferences: store.preferences, platform: process.platform, version: app.getVersion(), configWarning: store.warning }))
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
  handle('wide:menu-order', async (input: unknown) => {
    const menuOrder = parseMenuOrder(input)
    await store.update(current => ({ ...current, menuOrder }))
    return menuOrder
  })
  handle('wide:detect', (feature: unknown, path: unknown, mode: unknown, force: unknown = false) => {
    const id = parseFeatureId(feature)
    if (mode !== 'desktop' && mode !== 'codexhost') throw new Error('启动方式无效')
    if (typeof path !== 'string' || path.length > 4096 || /[\0\r\n]/.test(path)) throw new Error('应用路径无效')
    if (typeof force !== 'boolean') throw new Error('检测参数无效')
    return detectApplication(id, path, mode, force)
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
      await runApplication(id, action, settings, report)
      const message = action === 'normal' ? `${name} 已以默认界面重新启动。` : settings.launchMode === 'codexhost' ? 'CodexHost 已在后台启动，页面设置由 Renderer 自动应用。' : `${name} 界面设置已生效。`
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
