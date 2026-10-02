import { app } from 'electron'

type StartupApp = Pick<Electron.App, 'isPackaged' | 'getLoginItemSettings' | 'setLoginItemSettings'>

export class StartupManager {
  constructor(private readonly application: StartupApp = app, private readonly platform = process.platform, private readonly executable = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath) {}

  get available() { return this.application.isPackaged && this.platform === 'win32' }

  private get options() {
    // 便携版运行在临时解压目录，开机启动必须指向用户原始的 exe。
    return { name: 'wide', path: this.executable, args: [] as string[] }
  }

  get enabled() {
    if (!this.available) return false
    const settings = this.application.getLoginItemSettings(this.options)
    // openAtLogin 只检查 AppUserModelId 对应的项；这里使用固定名称，按实际启动项读回。
    return settings.launchItems.some(item => item.name === this.options.name && item.scope === 'user' && item.enabled && item.args.length === 0)
  }

  set(input: unknown) {
    if (typeof input !== 'boolean') throw new Error('开机启动设置无效')
    if (!this.available) throw new Error('开机启动仅支持 Windows 桌面发布版')
    const previous = this.enabled
    try {
      this.application.setLoginItemSettings({ ...this.options, openAtLogin: input, enabled: input })
      const enabled = this.enabled
      if (enabled !== input) throw new Error('无法更新 Windows 开机启动设置，请重试')
      return enabled
    } catch (error) {
      this.application.setLoginItemSettings({ ...this.options, openAtLogin: previous, enabled: previous })
      throw error
    }
  }
}
