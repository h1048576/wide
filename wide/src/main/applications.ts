import { app } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { access, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, basename, dirname, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { createServer } from 'node:net'
import { StringDecoder } from 'node:string_decoder'
import { APPLICATIONS, type ApplicationSettings, type DroidInstallation, type FeatureId, type OperationLevel } from '../shared/types'
import { detectDroid, disposeDroidConnections, runDroid } from './droid'
import { applicationInjection } from './injections'
import { createPageConnection } from './page-connection'

const exec = promisify(execFile)
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
type Report = (message: string, level?: OperationLevel) => void
const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
const psArgs = (command: string) => ['-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(`$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new(); $OutputEncoding=[Console]::OutputEncoding; ${command}`, 'utf16le').toString('base64')]
const script = (id: FeatureId, host = false) => join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'scripts', `${id}-wide`, host ? 'codexhost-wide.ps1' : `${id}.ps1`)
const connections = new Map<FeatureId, ReturnType<typeof createPageConnection>>()
function connection(id: FeatureId) {
  let value = connections.get(id)
  if (!value) {
    value = createPageConnection(APPLICATIONS[id].name, `${id}-wide-${id === 'codex' || id === 'paseo' ? 'width' : 'ui'}-override`)
    connections.set(id, value)
  }
  return value
}
export function disposeApplications() {
  disposeDroidConnections()
  for (const value of connections.values()) value.dispose()
  connections.clear()
}

async function detectHost(): Promise<DroidInstallation> {
  const { stdout } = await exec(powershell, psArgs(`$command=Get-Command codexhost.ps1 -CommandType ExternalScript -ErrorAction Stop | Select-Object -First 1; $root=Split-Path -Parent $command.Path; $package=Join-Path $root 'node_modules\\@codexhost\\cli'; $arch=if ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() -eq 'Arm64') { 'arm64' } else { 'x64' }; $renderer=Join-Path $package "node_modules\\@codexhost\\cli-win32-$arch\\app\\renderer-extension.js"; if (-not (Test-Path -LiteralPath $renderer)) { throw '没有找到 CodexHost Renderer' }; $version=(Get-Content -LiteralPath (Join-Path $package 'package.json') -Raw | ConvertFrom-Json).version; @{path=$command.Path;version=$version} | ConvertTo-Json -Compress`), { windowsHide: true, timeout: 20000 })
  const data = JSON.parse(stdout.trim())
  return { name: 'CodexHost', path: data.path, version: data.version || '未知版本' }
}
export async function detectApplication(id: FeatureId, path: string, mode: ApplicationSettings['launchMode'] = 'desktop'): Promise<DroidInstallation | null> {
  if (id === 'droid') return detectDroid(path)
  const name = APPLICATIONS[id].name
  if (process.platform === 'win32') {
    try {
      // 先检查桌面安装；CodexHost 仍依赖 Store 版 Codex。
      const { stdout } = await exec(powershell, psArgs(`& ${quote(script(id))} -DetectOnly ${path && mode !== 'codexhost' ? `-ExecutablePath ${quote(path)}` : ''}`), { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 })
      const data = JSON.parse(stdout.trim())
      if (id === 'codex' && mode === 'codexhost') return await detectHost()
      return { name: data.ApplicationName || name, path: data.Executable, version: data.Version || '未知版本' }
    } catch (error) {
      if (id === 'codex' && mode === 'codexhost') throw new Error('请安装 Store 版 Codex 和 npm 版 CodexHost，并确认 codexhost.ps1 在 PATH 中。')
      if (path) throw new Error(`无法识别指定路径，请选择 ${name} 的可执行文件。`)
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('系统 PowerShell 不可用。')
      return null
    }
  }
  if (mode === 'codexhost') throw new Error('CodexHost 启动脚本目前仅适用于 Windows。')
  const appNames = id === 'qoder' ? ['Qoder', 'Qoder CN'] : [name]
  const binaries = appNames.flatMap(value => [value, value.toLowerCase(), `${value.toLowerCase()}-desktop`])
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

function executeScript(command: string, name: string, report: Report): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const child = spawn(powershell, psArgs(command), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const output = new StringDecoder('utf8'), errorOutput = new StringDecoder('utf8')
    let buffer = '', selectedPort: number | undefined, failure = ''
    const consume = (chunk: string) => {
      buffer += chunk
      const lines = buffer.split(/\r?\n/); buffer = lines.pop() || ''
      for (const line of lines) {
        const match = /CDP 端口 (\d+)/.exec(line)
        if (match) selectedPort = Number(match[1])
        if (/失败：/.test(line)) { failure = line.replace(/^.*?失败：/, ''); report(failure, 'error') }
      }
    }
    child.stdout.on('data', chunk => consume(output.write(chunk)))
    child.stderr.on('data', chunk => consume(errorOutput.write(chunk)))
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${name} 操作超过 120 秒，请检查应用后重试。`)) }, 120000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => {
      clearTimeout(timer); consume(output.end() + errorOutput.end() + '\n')
      code === 0 ? resolve(selectedPort) : reject(new Error(failure || `${name} 操作失败（退出码 ${code ?? '未知'}），请检查安装路径。`))
    })
  })
}
async function connectPages(id: Exclude<FeatureId, 'droid'>, port: number, settings: ApplicationSettings, report: Report) {
  const source = applicationInjection(id, settings)
  const deadline = Date.now() + 20000
  let error: unknown
  do {
    try { await connection(id).connect(port, source, report); return }
    catch (failure) { error = failure; await sleep(500) }
  } while (Date.now() < deadline)
  throw error instanceof Error ? error : new Error('应用没有提供可用的调试页面。')
}
async function runWindows(id: Exclude<FeatureId, 'droid'>, action: 'apply' | 'normal', settings: ApplicationSettings, report: Report) {
  const capability = APPLICATIONS[id]
  if (id === 'codex' && settings.launchMode === 'codexhost' && action === 'apply') {
    await executeScript(`& ${quote(script(id, true))} -Width ${quote(settings.width)} -FontFamily ${quote(settings.fontFamily)} -FontSize ${settings.fontSize} -FontWeight ${settings.fontWeight} -PreventSummary ${Number(settings.preventSummary)} -OutputDirectory ${quote(join(app.getPath('userData'), 'codexhost'))} -Detach -Restart`, capability.name, report)
    return
  }
  const args = [`& ${quote(script(id))}`, '-Width', quote(settings.width), '-FontWeight', String(settings.fontWeight), '-Port', String(settings.port)]
  if (capability.fontFamily) args.push('-FontFamily', quote(settings.fontFamily))
  if (capability.fontSize) args.push('-FontSize', String(settings.fontSize))
  if (capability.maxWidth) args.push('-MaxWidth', quote(settings.maxWidth))
  if (capability.merge) args.push('-HideLocalMerge', String(Number(settings.hideLocalMerge)))
  if (capability.diff) args.push('-HideGitDiff', String(Number(settings.hideGitDiff)))
  if (capability.changes) args.push('-HideChanges', String(Number(settings.hideChanges)))
  if (capability.summary) args.push('-PreventSummary', String(Number(settings.preventSummary)))
  if (settings.executablePath && settings.launchMode !== 'codexhost') args.push('-ExecutablePath', quote(settings.executablePath))
  if (action === 'normal') args.push('-Normal')
  const port = await executeScript(args.join(' '), capability.name, report)
  if (action === 'apply') {
    if (!port) throw new Error(`${capability.name} 实际调试端口未返回，请重新启动。`)
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
export async function runApplication(id: FeatureId, action: 'apply' | 'normal', settings: ApplicationSettings, report: Report) {
  if (id === 'droid') return runDroid(action, settings, report)
  const installation = await detectApplication(id, settings.executablePath, settings.launchMode)
  if (!installation) throw new Error(`没有找到 ${APPLICATIONS[id].name}，请在高级设置中选择安装路径。`)
  connection(id).dispose()
  if (process.platform === 'win32') await runWindows(id, action, settings, report)
  else if (process.platform === 'darwin' || process.platform === 'linux') await runUnix(id, action, settings, installation, report)
  else throw new Error('当前操作系统暂不支持启动。')
}
