import { app } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { access, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, basename, dirname, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { createServer } from 'node:net'
import { StringDecoder } from 'node:string_decoder'
import { APPLICATIONS, INSTALLATION_CACHE_MS, MISSING_INSTALLATION_CACHE_MS, type ApplicationSettings, type BatchStage, type DroidInstallation, type FeatureId, type OperationLevel, type StartupMode } from '../shared/types'
import { detectDroid, disposeDroidConnections, runDroid } from './droid'
import { applicationInjection } from './injections'
import { createPageConnection } from './page-connection'
import { createPowerShellOutput } from './powershell-output'

const exec = promisify(execFile)
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
type Report = (message: string, level?: OperationLevel) => void
const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
const psArgs = (command: string) => ['-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(`$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new(); $OutputEncoding=[Console]::OutputEncoding; ${command}`, 'utf16le').toString('base64')]
const script = (id: FeatureId) => join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'scripts', `${id}-wide`, `${id}.ps1`)
const connections = new Map<FeatureId, ReturnType<typeof createPageConnection>>()
function connection(id: FeatureId) {
  let value = connections.get(id)
  if (!value) {
    value = createPageConnection(APPLICATIONS[id].name, `${id}-wide-${id === 'codex' || id === 'paseo' ? 'width' : 'ui'}-override`,
      id === 'qoder' ? url => /^qoder(?:-cn)?-app:\/\/renderer\//.test(url) : id === 'dsh' ? url => url.startsWith('dsh-app://app/') : undefined)
    connections.set(id, value)
  }
  return value
}
export function disposeApplications() {
  disposeDroidConnections()
  for (const value of connections.values()) value.dispose()
  connections.clear()
}

const installationCache = new Map<string, { value: DroidInstallation | null; expires: number }>()
const installationRequests = new Map<string, Promise<DroidInstallation | null>>()
export function detectApplication(id: FeatureId, path: string, force = false): Promise<DroidInstallation | null> {
  const key = JSON.stringify([id, path])
  const cached = installationCache.get(key)
  if (!force && cached && cached.expires > Date.now()) {
    // 安装更新可能移除旧路径；缓存只省去扫描，不能跳过路径有效性检查。
    if (!cached.value) return Promise.resolve(null)
    return stat(cached.value.path).then(info => info.isFile() ? cached.value : detectApplication(id, path, true), () => detectApplication(id, path, true))
  }
  const pending = installationRequests.get(key)
  if (pending) return pending
  const request = resolveApplication(id, path).then(value => {
    installationCache.set(key, { value, expires: Date.now() + (value ? INSTALLATION_CACHE_MS : MISSING_INSTALLATION_CACHE_MS) })
    return value
  }).finally(() => installationRequests.delete(key))
  installationRequests.set(key, request)
  return request
}
async function resolveApplication(id: FeatureId, path: string): Promise<DroidInstallation | null> {
  if (id === 'droid') return detectDroid(path)
  const name = APPLICATIONS[id].name
  if (process.platform === 'win32') {
    try {
      const { stdout } = await exec(powershell, psArgs(`& ${quote(script(id))} -DetectOnly ${path ? `-ExecutablePath ${quote(path)}` : ''}`), { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 })
      const data = JSON.parse(stdout.trim())
      return { name: data.ApplicationName || name, path: data.Executable, version: data.Version || '未知版本' }
    } catch (error) {
      if (path) throw new Error(`无法识别指定路径，请选择 ${name} 的可执行文件。`)
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('系统 PowerShell 不可用。')
      return null
    }
  }
  const appNames = id === 'qoder' ? ['Qoder', 'Qoder CN'] : id === 'dsh' ? ['DeepSeek Harness'] : [name]
  const binaries = id === 'dsh' ? ['DeepSeek Harness', 'deepseek-harness', 'deepseek-harness-desktop'] : appNames.flatMap(value => [value, value.toLowerCase(), `${value.toLowerCase()}-desktop`])
  const candidates = path ? [path] : process.platform === 'darwin'
    ? appNames.flatMap(value => [`/Applications/${value}.app`, join(homedir(), `Applications/${value}.app`)])
    : binaries.flatMap(value => [join('/opt', name, value), join('/opt', id, value), join('/usr/bin', value), join('/usr/local/bin', value), join(homedir(), '.local/bin', value), ...(process.env.PATH || '').split(':').filter(Boolean).map(directory => join(directory, value))])
  for (let candidate of [...new Set(candidates)]) {
    try {
      let version = '未知版本'
      let fromBundle = false
      if (!isAbsolute(candidate)) continue
      if (process.platform === 'darwin' && candidate.endsWith('.app')) {
        if (!appNames.some(value => basename(candidate).toLowerCase() === `${value}.app`.toLowerCase())) continue
        const plist = join(candidate, 'Contents/Info.plist')
        const { stdout } = await exec('/usr/bin/plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', plist])
        const binary = stdout.trim()
        if (!binary || basename(binary) !== binary) continue
        const info = await exec('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist]).catch(() => null)
        version = info?.stdout.trim() || version
        candidate = join(candidate, 'Contents/MacOS', binary); fromBundle = true
      }
      const filename = basename(candidate).replace(/(?:[-._]\d[\w.-]*)?\.AppImage$/i, '').toLowerCase()
      if (!fromBundle && !binaries.some(value => value.toLowerCase() === filename)) continue
      if (!(await stat(candidate)).isFile()) continue
      await access(candidate, constants.X_OK)
      return { name, path: await realpath(candidate), version }
    } catch { /* 继续检查标准安装位置。 */ }
  }
  if (path) throw new Error(`指定路径不可用，请选择 ${name} 应用程序。`)
  return null
}

export async function isApplicationRunning(id: FeatureId, installation: DroidInstallation): Promise<boolean> {
  if (process.platform === 'win32') {
    const helper = join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'scripts', 'application-processes.ps1')
    const { stdout } = await exec(powershell, psArgs(`$ErrorActionPreference='Stop'; . ${quote(helper)}; Test-WideApplicationRunning ${quote(installation.path)} ${quote(id)} | ConvertTo-Json -Compress`), { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 })
    const running: unknown = JSON.parse(stdout.trim())
    if (typeof running !== 'boolean') throw new Error(`无法确认 ${APPLICATIONS[id].name} 的运行状态。`)
    return running
  }
  if (process.platform === 'darwin' || process.platform === 'linux') {
    const { stdout } = await exec('/bin/ps', ['-axo', 'command='], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 })
    return stdout.split('\n').some(line => {
      const command = line.trimStart()
      return command === installation.path || command.startsWith(installation.path + ' ')
    })
  }
  throw new Error('当前操作系统暂不支持检测应用运行状态。')
}

function executeScript(command: string, name: string, report: Report, onStage?: (stage: BatchStage) => void): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const child = spawn(powershell, psArgs(command), { windowsHide: true, env: { ...process.env, WIDE_PROGRESS_STREAM: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
    const output = new StringDecoder('utf8'), errorOutput = new StringDecoder('utf8')
    let selectedPort: number | undefined, failure = '', settled = false
    const consume = (line: string) => {
        const match = /CDP 端口 (\d+)/.exec(line)
        if (match) { selectedPort = Number(match[1]); onStage?.('waiting') }
        if (/失败：/.test(line)) { failure = line.replace(/^.*?失败：/, ''); report(failure, 'error') }
    }
    const stdout = createPowerShellOutput(consume), stderr = createPowerShellOutput(consume)
    child.stdout.on('data', chunk => stdout.write(output.write(chunk)))
    child.stderr.on('data', chunk => stderr.write(errorOutput.write(chunk)))
    let exitTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (code: number | null, error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer); clearTimeout(exitTimer)
      stdout.write(output.end()); stdout.end()
      stderr.write(errorOutput.end()); stderr.end()
      // Electron 子进程可能继承管道；启动脚本退出后不再等待应用关闭管道。
      child.stdout.destroy(); child.stderr.destroy()
      if (error) { reject(error); return }
      code === 0 ? resolve(selectedPort) : reject(new Error(failure || `${name} 操作失败（退出码 ${code ?? '未知'}），请检查安装路径。`))
    }
    const timer = setTimeout(() => { child.kill(); finish(null, new Error(`${name} 操作超过 120 秒，请检查应用后重试。`)) }, 120000)
    child.once('error', error => finish(null, error))
    child.once('exit', code => { exitTimer = setTimeout(() => finish(code), 100) })
    child.once('close', code => finish(code))
  })
}
async function connectPages(id: Exclude<FeatureId, 'droid'>, port: number, settings: ApplicationSettings, report: Report) {
  const source = applicationInjection(id, settings)
  const deadline = Date.now() + 60000
  let error: unknown
  do {
    try { await connection(id).connect(port, source, report); return }
    catch (failure) { error = failure; await sleep(500) }
  } while (Date.now() < deadline)
  throw error instanceof Error ? error : new Error('应用没有提供可用的调试页面。')
}
async function runWindows(id: Exclude<FeatureId, 'droid'>, action: 'apply' | 'normal', settings: ApplicationSettings, report: Report, onStage?: (stage: BatchStage) => void) {
  const capability = APPLICATIONS[id]
  const args = [`& ${quote(script(id))}`, '-Width', quote(settings.width), '-FontWeight', String(settings.fontWeight), '-Port', String(settings.port)]
  if (capability.fontFamily) args.push('-FontFamily', quote(settings.fontFamily))
  if (capability.fontSize) args.push('-FontSize', String(settings.fontSize))
  if (capability.maxWidth) args.push('-MaxWidth', quote(settings.maxWidth))
  if (capability.chatHeight) args.push('-ChatHeight', quote(settings.chatHeight))
  if (capability.merge) args.push('-HideLocalMerge', String(Number(settings.hideLocalMerge)))
  if (capability.diff) args.push('-HideGitDiff', String(Number(settings.hideGitDiff)))
  if (capability.changes) args.push('-HideChanges', String(Number(settings.hideChanges)))
  if (capability.summary) args.push('-PreventSummary', String(Number(settings.preventSummary)))
  if (settings.executablePath) args.push('-ExecutablePath', quote(settings.executablePath))
  if (action === 'normal') args.push('-Normal')
  else if (id === 'zcode' || id === 'qoder' || id === 'paseo') args.push('-LaunchOnly')
  const port = await executeScript(args.join(' '), capability.name, report, onStage)
  if (action === 'apply') {
    if (!port) throw new Error(`${capability.name} 实际调试端口未返回，请重新启动。`)
    onStage?.('applying')
    await connectPages(id, port, settings, report)
  }
}
async function selectPort(preferred: number) {
  for (let port = preferred; port <= Math.min(preferred + 50, 65535); port++) {
    const free = await new Promise<boolean>(resolve => {
      const server = createServer()
      server.once('error', () => resolve(false))
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
    })
    if (free) return port
  }
  throw new Error('调试端口及后续 50 个端口均被占用，请修改端口。')
}
async function stopUnix(installation: DroidInstallation) {
  const find = async () => {
    const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,command='], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 })
    return stdout.split('\n').flatMap(line => {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line)
      return match && (match[2] === installation.path || match[2].startsWith(installation.path + ' ')) ? [Number(match[1])] : []
    })
  }
  const signal = (pid: number, kind: NodeJS.Signals) => { try { process.kill(pid, kind) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error } }
  const running = await find()
  if (!running.length) return
  running.forEach(pid => signal(pid, 'SIGTERM'))
  const deadline = Date.now() + 6000
  while (Date.now() < deadline && (await find()).length) await sleep(250)
  for (const pid of await find()) signal(pid, 'SIGKILL')
  await sleep(500)
}
async function runUnix(id: Exclude<FeatureId, 'droid'>, action: 'apply' | 'normal', settings: ApplicationSettings, installation: DroidInstallation, report: Report) {
  await stopUnix(installation)
  const port = action === 'apply' ? await selectPort(settings.port) : undefined
  const args = port ? ['--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`, '--start-maximized'] : ['--start-maximized']
  const env = { ...process.env }
  if (id === 'paseo') {
    const previous = (env.PASEO_ELECTRON_FLAGS || '').split(/\s+/).filter(value => value && !/^--remote-debugging-(address|port)=/.test(value))
    env.PASEO_ELECTRON_FLAGS = [...previous, ...args].join(' ')
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(installation.path, args, { env, cwd: dirname(installation.path), detached: true, stdio: 'ignore' })
    child.once('error', reject); child.once('spawn', () => { child.unref(); resolve() })
  })
  if (port) await connectPages(id, port, settings, report)
}
export async function runApplication(id: FeatureId, action: 'apply' | 'normal', settings: ApplicationSettings, report: Report, startupMode: StartupMode = 'default', onStage?: (stage: BatchStage) => void) {
  if (id === 'droid' && startupMode === 'default') return runDroid(action, settings, report, onStage)
  const installation = await detectApplication(id, settings.executablePath)
  if (!installation) throw new Error(`没有找到 ${APPLICATIONS[id].name}，请在高级设置中选择安装路径。`)
  if (id !== 'droid') connection(id).dispose()
  if (id === 'droid') await runDroid(action, settings, report, onStage)
  else if (process.platform === 'win32') await runWindows(id, action, settings, report, onStage)
  else if (process.platform === 'darwin' || process.platform === 'linux') await runUnix(id, action, settings, installation, report)
  else throw new Error('当前操作系统暂不支持启动。')
  if (startupMode === 'maximized' && process.platform === 'win32') {
    onStage?.('maximizing')
    const helper = join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'scripts', 'maximize-window.ps1')
    try {
      await exec(powershell, psArgs(`& ${quote(helper)} -ExecutablePath ${quote(installation.path)} -ApplicationId ${quote(id)}`), { windowsHide: true, timeout: 55000, maxBuffer: 1024 * 1024 })
    } catch { throw new Error(`${APPLICATIONS[id].name} 已启动，但未能最大化主窗口，请确认主窗口已打开。`) }
  }
}

export async function quitApplication(id: FeatureId, path: string, detectedInstallation?: DroidInstallation) {
  // 退出前重新识别安装，兼容运行期间切换到新版本的桌面应用。
  const installation = detectedInstallation ?? await detectApplication(id, path, true)
  if (!installation) throw new Error(`没有找到 ${APPLICATIONS[id].name}，请先选择正确的安装路径。`)
  if (id === 'droid') disposeDroidConnections()
  else connections.get(id)?.dispose()
  if (process.platform === 'win32') {
    const helper = join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'scripts', 'quit-application.ps1')
    const timeout = 45000
    try {
      // 用 JSON 传回原始异常，避免 PowerShell 的 CLIXML 和定位信息遮蔽实际原因。
      const command = `try { & ${quote(helper)} -ExecutablePath ${quote(installation.path)} -ApplicationId ${quote(id)} -ProtectedProcessId ${process.pid} } catch { [Console]::Error.WriteLine('WIDE_QUIT_ERROR:' + (ConvertTo-Json -InputObject $_.Exception.Message -Compress)); exit 1 }`
      await exec(powershell, psArgs(command), { windowsHide: true, timeout, maxBuffer: 1024 * 1024 })
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string; stderr?: string }
      const name = APPLICATIONS[id].name
      if (failure.killed && failure.signal) throw new Error(`退出 ${name} 超过 ${timeout / 1000} 秒，请检查应用是否仍在运行后重试。`)
      if (failure.code === 'ENOENT') throw new Error('系统 PowerShell 不可用。')
      const match = /(?:^|\r?\n)WIDE_QUIT_ERROR:([^\r\n]+)/.exec(failure.stderr || '')
      let detail = ''
      if (match) {
        try { const message: unknown = JSON.parse(match[1]); if (typeof message === 'string') detail = message }
        catch { /* 无法解析时保留原始执行错误。 */ }
      }
      throw new Error(`未能完整退出 ${name}：${detail || failure.message || String(error)}`)
    }
  } else if (process.platform === 'darwin' || process.platform === 'linux') await quitUnix(installation)
  else throw new Error('当前操作系统暂不支持退出应用。')
}

async function quitUnix(installation: DroidInstallation) {
  const tracked = new Map<number, string>()
  const discover = async () => {
    const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,ppid=,command='], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 })
    const snapshot = stdout.split('\n').flatMap(line => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line)
      return match ? [{ pid: Number(match[1]), parent: Number(match[2]), command: match[3] }] : []
    })
    const owned = new Set(snapshot.filter(value => value.command === installation.path || value.command.startsWith(installation.path + ' ') || tracked.get(value.pid) === value.command).map(value => value.pid))
    let changed: boolean
    do {
      changed = false
      for (const value of snapshot) if (value.pid !== process.pid && !owned.has(value.pid) && owned.has(value.parent)) { owned.add(value.pid); changed = true }
    } while (changed)
    const running = snapshot.filter(value => owned.has(value.pid))
    for (const value of running) tracked.set(value.pid, value.command)
    return running
  }
  const signal = (pid: number, kind: NodeJS.Signals) => { try { process.kill(pid, kind) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error } }
  const running = await discover()
  if (!running.length) return
  running.forEach(value => signal(value.pid, 'SIGTERM'))
  const deadline = Date.now() + 6000
  while (Date.now() < deadline) {
    await sleep(250)
    if (!(await discover()).length) return
  }
  for (const value of await discover()) signal(value.pid, 'SIGKILL')
  await sleep(250)
  if ((await discover()).length) throw new Error(`${installation.name} 仍有后台进程未退出。`)
}
