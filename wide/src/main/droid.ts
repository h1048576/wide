import { terminalInjection } from './terminal-injection'
import { app } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { access, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, basename, dirname, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { createServer } from 'node:net'
import { StringDecoder } from 'node:string_decoder'
import { createPageConnection } from './page-connection'
import type { DroidInstallation, DroidSettings, OperationLevel } from '../shared/types'

const exec = promisify(execFile)
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
type WriteLog = (message: string, level?: OperationLevel) => void
const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const psQuote = (value: string) => `'${value.replaceAll("'", "''")}'`
const psCommand = (command: string) => ['-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(`$ProgressPreference = 'SilentlyContinue'; [Console]::OutputEncoding = [Text.UTF8Encoding]::new(); $OutputEncoding = [Console]::OutputEncoding; ${command}`, 'utf16le').toString('base64')]
function scriptPath() {
  const root = app.isPackaged ? process.resourcesPath : app.getAppPath()
  return join(root, 'scripts', 'droid-wide', 'droid.ps1')
}

export async function detectDroid(customPath: string): Promise<DroidInstallation | null> {
  if (process.platform === 'win32') {
    try {
      const { stdout } = await exec(powershell, psCommand(`& ${psQuote(scriptPath())} -DetectOnly ${customPath ? `-ExecutablePath ${psQuote(customPath)}` : ''}`), { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 })
      const data = JSON.parse(stdout.trim())
      return { name: data.ApplicationName, path: data.Executable, version: data.Version }
    } catch (error) {
      if (customPath) throw new Error('无法识别指定路径，请选择 Droid/Factory 桌面应用的可执行文件。')
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('系统 PowerShell 不可用，无法检测 Droid。')
      return null
    }
  }
  const candidates = customPath ? [customPath] : process.platform === 'darwin'
    ? ['/Applications/Factory.app', '/Applications/Droid.app', join(homedir(), 'Applications/Factory.app'), join(homedir(), 'Applications/Droid.app')]
    : ['/opt/Factory/factory-desktop', '/opt/factory/factory-desktop', '/opt/Droid/droid-desktop', '/usr/bin/factory-desktop', '/usr/bin/droid-desktop', join(homedir(), '.local/bin/factory-desktop')]
  for (let candidate of candidates) {
    try {
      let version = '未知版本'
      if (process.platform === 'darwin' && candidate.endsWith('.app')) {
        const plist = join(candidate, 'Contents/Info.plist')
        const { stdout } = await exec('/usr/bin/plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', plist])
        const binary = stdout.trim()
        if (basename(binary) !== binary) throw new Error('应用程序包路径无效')
        const result = await exec('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist]).catch(() => null)
        version = result?.stdout.trim() || version
        candidate = join(candidate, 'Contents/MacOS', binary)
      }
      if (!isAbsolute(candidate) || !(await stat(candidate)).isFile()) continue
      if (!/^(?:factory-desktop|droid-desktop|factory|droid)(?:[-.][0-9][0-9A-Za-z._-]*)?(?:\.AppImage)?$/i.test(basename(candidate))) throw new Error('请选择 Droid/Factory 桌面应用')
      await access(candidate, constants.X_OK)
      const path = await realpath(candidate)
      return { name: /factory/i.test(path) ? 'Factory' : 'Droid', path, version }
    } catch { /* 继续检查下一个标准安装路径。 */ }
  }
  if (customPath) throw new Error('指定路径不存在或没有执行权限，请选择桌面应用程序。')
  return null
}

function runWindows(action: 'apply' | 'normal', settings: DroidSettings, log: WriteLog) {
  const args = [`& ${psQuote(scriptPath())}`, '-Width', psQuote(settings.width), '-MaxWidth', psQuote(settings.maxWidth), '-ChatHeight', psQuote(settings.chatHeight), '-FontFamily', psQuote(settings.fontFamily), '-FontSize', String(settings.fontSize), '-FontWeight', String(settings.fontWeight), '-Port', String(settings.port), '-HideLocalMerge', settings.hideLocalMerge ? '1' : '0', '-HideGitDiff', settings.hideGitDiff ? '1' : '0']
  if (settings.executablePath) args.push('-ExecutablePath', psQuote(settings.executablePath))
  if (action === 'normal') args.push('-Normal')
  return new Promise<number | undefined>((resolve, reject) => {
    const child = spawn(powershell, psCommand(args.join(' ')), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const decoder = new StringDecoder('utf8')
    let remainder = ''
    let selectedPort: number | undefined
    const consume = (text: string) => {
      remainder += text
      const lines = remainder.split(/\r?\n/)
      remainder = lines.pop() || ''
      for (const line of lines) {
        const portMatch = /CDP 端口 (\d+)/.exec(line)
        if (portMatch) selectedPort = Number(portMatch[1])
        if (line.trim()) log(line.replace(/\x1b\[[0-9;]*m/g, '').replace(/^\[Droid Wide\]\s*/, ''), /失败|错误/.test(line) ? 'error' : 'info')
      }
    }
    child.stdout.on('data', chunk => consume(decoder.write(chunk)))
    const errorDecoder = new StringDecoder('utf8')
    child.stderr.on('data', chunk => consume(errorDecoder.write(chunk)))
    const timer = setTimeout(() => { child.kill(); reject(new Error('操作超过 90 秒，请检查 Droid 是否正常启动。')) }, 90000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => {
      clearTimeout(timer)
      consume(decoder.end() + errorDecoder.end() + '\n')
      code === 0 ? resolve(selectedPort) : reject(new Error(`Droid 操作失败（退出码 ${code ?? '未知'}），请检查应用路径后重试。`))
    })
  })
}

export function injectionSource(settings: DroidSettings) {
  const width = ['auto', 'fit-content'].includes(settings.width) ? settings.width : `min(100%, ${settings.width})`
  const maxWidth = settings.maxWidth === 'none' ? '100%' : `min(100%, ${settings.maxWidth})`
  const css = `:root,body,body *:not(.xterm, .xterm *) { font-family:${settings.fontFamily} !important;font-size:${settings.fontSize}px !important;font-weight:${settings.fontWeight} !important; }
    [data-droid-wide-content],[data-new-session-composer-v2="true"] { box-sizing:border-box !important;min-width:0 !important;width:${width} !important;max-width:${maxWidth} !important; }
    [data-testid="chat-composer-wrapper"] > [data-direction="row"][data-flex-row="true"]:first-child,
    [data-testid="chat-composer-wrapper"] [contenteditable="true"][role="textbox"] { box-sizing:border-box !important;height:${settings.chatHeight} !important;min-height:${settings.chatHeight} !important;max-height:${settings.chatHeight} !important; }
    ${settings.hideLocalMerge ? '[data-testid="changes-primary-cta"],[data-testid="changes-primary-cta-caret"] {display:none !important;}' : ''}
    ${settings.hideGitDiff ? '[data-testid="composer-diff-stat-pill"] {display:none !important;}' : ''}`
  return `(() => {
    const apply = () => {
      let style = document.getElementById('droid-wide-ui-override');
      if (!style) { style = document.createElement('style'); style.id = 'droid-wide-ui-override'; (document.head || document.documentElement).appendChild(style); }
      style.textContent = ${JSON.stringify(css)};
      ${terminalInjection('droid', settings)};
      if (window.__droidWideContentGuard) { window.__droidWideContentGuard.scan(); return true; }
      const roots = new Set(); let scheduled = false;
      const mark = root => { if (!(root instanceof Element)) return; [root, ...root.querySelectorAll('*')].forEach(el => { if (!el.hasAttribute('data-droid-wide-content') && getComputedStyle(el).maxWidth === '768px') el.setAttribute('data-droid-wide-content', ''); }); };
      const scan = (root = document.documentElement) => { if (!(root instanceof Element)) return; roots.add(root); if (scheduled) return; scheduled = true; requestAnimationFrame(() => { scheduled = false; const batch = [...roots]; roots.clear(); batch.forEach(root => { if (root.isConnected) mark(root); }); }); };
      const observer = new MutationObserver(records => records.forEach(record => { if (record.type === 'attributes') scan(record.target); record.addedNodes.forEach(scan); }));
      observer.observe(document.documentElement, {attributes:true, attributeFilter:['class','style'], childList:true, subtree:true});
      window.__droidWideContentGuard = {observer, scan}; scan(); [250,1000,3000].forEach(delay => setTimeout(() => scan(), delay)); return true;
    };
    if (document.documentElement) return apply();
    document.addEventListener('DOMContentLoaded', apply, {once:true}); return true;
  })()`
}

const pageConnection = createPageConnection('Droid', 'droid-wide-ui-override')
export function disposeDroidConnections() { pageConnection.dispose() }
export function connectDroidPages(port: number, settings: DroidSettings, log: WriteLog) {
  return pageConnection.connect(port, injectionSource(settings), log)
}

async function selectPort(preferred: number) {
  for (let port = preferred; port <= Math.min(preferred + 50, 65535); port++) {
    const available = await new Promise<boolean>(resolve => {
      const server = createServer()
      server.once('error', () => resolve(false))
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
    })
    if (available) return port
  }
  throw new Error('指定端口及其后 50 个端口均被占用，请修改调试端口。')
}

async function stopUnix(installation: DroidInstallation, log: WriteLog) {
  const find = async () => {
    const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,command='], { maxBuffer: 8 * 1024 * 1024, timeout: 5000 })
    return stdout.split('\n').flatMap(line => {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line)
      return match && (match[2] === installation.path || match[2].startsWith(installation.path + ' ')) ? [Number(match[1])] : []
    })
  }
  const running = await find()
  if (!running.length) return
  log(`正在关闭已运行的 ${installation.name}…`)
  const terminate = (pid: number, signal: NodeJS.Signals) => { try { process.kill(pid, signal) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error } }
  running.forEach(pid => terminate(pid, 'SIGTERM'))
  const deadline = Date.now() + 6000
  while (Date.now() < deadline && (await find()).length) await sleep(250)
  for (const pid of await find()) terminate(pid, 'SIGKILL')
  await sleep(500)
}

async function runUnix(action: 'apply' | 'normal', settings: DroidSettings, log: WriteLog) {
  const installation = await detectDroid(settings.executablePath)
  if (!installation) throw new Error('没有找到 Droid/Factory 桌面应用，请在高级设置中选择安装路径。')
  log(`检测到 ${installation.name} ${installation.version}`)
  await stopUnix(installation, log)
  const port = action === 'apply' ? await selectPort(settings.port) : undefined
  const args = port ? ['--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`, '--start-maximized'] : ['--start-maximized']
  log(action === 'apply' ? `正在启动 ${installation.name}，本地调试端口 ${port}…` : `正在以默认界面启动 ${installation.name}…`)
  await new Promise<void>((resolve, reject) => {
    const child = spawn(installation.path, args, { cwd: dirname(installation.path), detached: true, stdio: 'ignore' })
    child.once('error', reject)
    child.once('spawn', () => { child.unref(); resolve() })
  })
  if (action === 'normal') return
  const deadline = Date.now() + 20000
  let failure: unknown
  do {
    try { await connectDroidPages(port!, settings, log); return }
    catch (error) { failure = error; await sleep(500) }
  } while (Date.now() < deadline)
  throw failure instanceof Error ? failure : new Error('Droid 未提供可用的调试页面。')
}

export async function runDroid(action: 'apply' | 'normal', settings: DroidSettings, log: WriteLog) {
  // 先确认安装路径，避免路径无效时中断已有的界面守护连接。
  const installation = await detectDroid(settings.executablePath)
  if (!installation) throw new Error('没有找到 Droid/Factory 桌面应用，请在高级设置中选择安装路径。')
  disposeDroidConnections()
  if (process.platform === 'win32') {
    const port = await runWindows(action, settings, log)
    if (action === 'apply') {
      if (!port) throw new Error('无法确认 Droid 的实际调试端口，请重新检测应用后重试。')
      await connectDroidPages(port, settings, log)
      log('页面守护已连接，刷新或打开新窗口时会自动应用设置。')
    }
  }
  else if (process.platform === 'darwin' || process.platform === 'linux') await runUnix(action, settings, log)
  else throw new Error('当前操作系统暂不支持 Droid 启动。')
}
