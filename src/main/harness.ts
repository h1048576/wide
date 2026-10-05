import { shell } from 'electron'
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { HARNESSES, type HarnessDocument, type HarnessFolder, type HarnessId, type HarnessInventory, type HarnessOperationResult, type HarnessSkill } from '../shared/types'

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error)
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
const skillOrder = (a: HarnessSkill, b: HarnessSkill) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base', numeric: true }) || a.id.localeCompare(b.id, 'en')

export class HarnessManager {
  private mutating = false
  constructor(private readonly home = homedir(), private readonly trash = (path: string) => shell.trashItem(path)) {}

  private folder(id: unknown) {
    const harness = HARNESSES.find(item => item.id === id)
    if (!harness) throw new Error('Harness 无效')
    const path = join(this.home, harness.directory)
    return { ...harness, path, skillsPath: join(path, 'skills') }
  }

  private async info(path: string) {
    try { return await lstat(path) } catch (error) { if (isMissing(error)) return null; throw error }
  }

  private sourcePath() { return join(this.folder('claude').path, 'CLAUDE.md') }

  async inventory(includeSkills = true): Promise<HarnessInventory> {
    const sourcePath = this.sourcePath()
    const source = await stat(sourcePath).catch(() => null)
    return { agentsSource: { path: sourcePath, exists: !!source?.isFile() }, harnesses: includeSkills ? await this.skillsInventory() : [] }
  }

  async skillsInventory(): Promise<HarnessFolder[]> {
    return Promise.all(HARNESSES.map(async item => {
      const folder = this.folder(item.id)
      const result: HarnessFolder = { id: item.id, name: item.name, path: folder.path, skillsPath: folder.skillsPath, exists: false, skills: [] }
      try {
        result.exists = !!await this.info(folder.path)
        result.skills = await this.skills(item.id)
      } catch (error) { result.error = errorMessage(error) }
      return result
    }))
  }

  private async readAgents(): Promise<Buffer> {
    const path = this.sourcePath()
    try {
      const info = await stat(path)
      if (!info.isFile()) throw new Error('CLAUDE.md 不是文件')
      if (info.size > 4 * 1024 * 1024) throw new Error('CLAUDE.md 超过 4 MB，无法读取')
      return await readFile(path)
    } catch (error) {
      if (isMissing(error)) throw new Error(`未找到 ${path}`)
      throw error
    }
  }

  async previewAgents(): Promise<HarnessDocument> {
    return { path: this.sourcePath(), content: (await this.readAgents()).toString('utf8').replace(/^\uFEFF/, '') }
  }

  private async skills(id: HarnessId): Promise<HarnessSkill[]> {
    const root = this.folder(id).skillsPath
    const skills: HarnessSkill[] = []
    const scan = async (directory: string, depth: number) => {
      const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
        if (isMissing(error)) return []
        throw error
      })
      await Promise.all(entries.map(async entry => {
        if (entry.name.startsWith('.wide-') || entry.name === '.git' || entry.name === 'node_modules') return
        if (!entry.isDirectory() && !entry.isSymbolicLink()) return
        const path = join(directory, entry.name)
        const relativeId = relative(root, path).split(sep).join('/')
        const info = await stat(path).catch(error => { if (isMissing(error)) return null; throw error })
        if (!info?.isDirectory()) {
          if (entry.isSymbolicLink() && !info) skills.push({ id: relativeId, name: entry.name, path, linked: true, available: false })
          return
        }
        const manifest = await stat(join(path, 'SKILL.md')).catch(error => { if (isMissing(error)) return null; throw error })
        if (manifest?.isFile()) skills.push({ id: relativeId, name: entry.name, path, linked: entry.isSymbolicLink(), available: true })
        // Codex 的 .system 等分组目录也包含技能；不遍历链接分组，避免循环。
        else if (!entry.isSymbolicLink() && depth < 3) await scan(path, depth + 1)
      }))
    }
    await scan(root, 0)
    return skills.sort(skillOrder)
  }

  private contained(root: string, target: string) {
    const resolved = resolve(target)
    const child = relative(resolve(root), resolved)
    if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error('技能路径超出管理目录')
    return resolved
  }

  private async selected(id: HarnessId, skillId?: unknown) {
    const skills = await this.skills(id)
    if (skillId === undefined) return skills
    if (typeof skillId !== 'string') throw new Error('技能标识无效')
    const skill = skills.find(item => item.id === skillId)
    if (!skill) throw new Error('技能已不存在，请刷新列表')
    this.contained(this.folder(id).skillsPath, skill.path)
    return [skill]
  }

  private async exclusive(task: () => Promise<HarnessOperationResult>) {
    if (this.mutating) throw new Error('Harness 操作正在执行，请稍后再试')
    this.mutating = true
    try { return await task() } finally { this.mutating = false }
  }

  private outcome(completed: number, failures: string[], message: string): HarnessOperationResult {
    return { success: failures.length === 0, completed, failed: failures.length, message: `${message}${failures.length ? `；${failures.length} 项失败：${failures.join('；')}` : '。'}` }
  }

  private async realDirectory(path: string) {
    const info = await this.info(path)
    if (info?.isSymbolicLink()) throw new Error(`${path} 是链接目录，请先改为普通目录再同步`)
    if (info && !info.isDirectory()) throw new Error(`${path} 不是目录`)
    await mkdir(path, { recursive: true })
  }

  async syncAgents(): Promise<HarnessOperationResult> {
    return this.exclusive(async () => {
      // 读取一次原始字节，保留源文件的编码和换行。
      const content = await this.readAgents()
      let completed = 0
      const failures: string[] = []
      const targets = [
        ...(['droid', 'codex', 'agents'] as const).map(id => this.folder(id)),
        { name: 'DSH', path: join(this.home, '.dsh') }
      ]
      for (const folder of targets) {
        const target = join(folder.path, 'AGENTS.md')
        const stage = join(folder.path, `.wide-${randomUUID()}.tmp`)
        try {
          await this.realDirectory(folder.path)
          const existing = await this.info(target)
          if (existing && !existing.isFile() && !existing.isSymbolicLink()) throw new Error('AGENTS.md 不是文件')
          if (existing && !existing.isSymbolicLink() && (await readFile(target)).equals(content)) { completed++; continue }
          await writeFile(stage, content, { flag: 'wx' })
          // 先准备新文件；已有文件进入回收站后，再放入新版本。
          if (existing) await this.trash(target)
          await rename(stage, target)
          completed++
        } catch (error) { failures.push(`${folder.name}：${errorMessage(error)}`) }
        finally { await rm(stage, { force: true }).catch(() => {}) }
      }
      return this.outcome(completed, failures, `已同步 AGENTS.md 到 ${completed} 个目录`)
    })
  }

  async syncSkills(source: unknown, skillId?: unknown): Promise<HarnessOperationResult> {
    if (source !== 'claude' && source !== 'agents') throw new Error('只能在 Claude 与 Agents 之间同步技能')
    return this.exclusive(async () => {
      const targetId = source === 'claude' ? 'agents' : 'claude'
      const targetFolder = this.folder(targetId)
      const selected = await this.selected(source, skillId)
      if (!selected.length) return this.outcome(0, [], '没有可同步的技能')
      await this.realDirectory(targetFolder.path)
      await this.realDirectory(targetFolder.skillsPath)
      const sourceRoot = await realpath(this.folder(source).skillsPath)
      const targetRoot = await realpath(targetFolder.skillsPath)
      const normalizePath = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path
      if (normalizePath(sourceRoot) === normalizePath(targetRoot)) throw new Error('源 skills 与目标 skills 指向同一个目录，无法复制')
      let completed = 0
      const failures: string[] = []
      for (const skill of selected) {
        const target = this.contained(targetFolder.skillsPath, join(targetFolder.skillsPath, skill.id))
        const stage = this.contained(targetFolder.skillsPath, join(targetFolder.skillsPath, `.wide-${randomUUID()}`))
        try {
          if (!skill.available) throw new Error('源技能链接已失效')
          const physicalSource = await realpath(skill.path)
          const destinationRelative = relative(normalizePath(physicalSource), normalizePath(targetRoot))
          if (!destinationRelative || (!isAbsolute(destinationRelative) && destinationRelative !== '..' && !destinationRelative.startsWith(`..${sep}`))) throw new Error('目标 skills 位于源技能内，无法复制')
          // 中间分组必须是实际目录；目标技能本身若为链接，替换其链接而不写入链接目标。
          let parent = targetFolder.skillsPath
          for (const part of relative(targetFolder.skillsPath, dirname(target)).split(sep).filter(Boolean)) {
            parent = join(parent, part)
            await this.realDirectory(parent)
          }
          await cp(skill.path, stage, { recursive: true, dereference: true, errorOnExist: true, force: false })
          if (await this.info(target)) await this.trash(target)
          await rename(stage, target)
          completed++
        } catch (error) { failures.push(`${skill.name}：${errorMessage(error)}`) }
        finally { await rm(stage, { recursive: true, force: true }).catch(() => {}) }
      }
      return this.outcome(completed, failures, `已同步 ${completed} 个技能到 ${targetFolder.name}`)
    })
  }

  async deleteSkills(id: unknown, skillId: unknown): Promise<HarnessOperationResult> {
    if (typeof skillId !== 'string' || !skillId) throw new Error('请选择要删除的技能')
    const folder = this.folder(id)
    return this.exclusive(async () => {
      const selected = await this.selected(folder.id, skillId)
      let completed = 0
      const failures: string[] = []
      for (const skill of selected) {
        try {
          // 不解析符号链接，删除链接只将链接本身移到回收站。
          await this.trash(this.contained(folder.skillsPath, skill.path))
          completed++
        } catch (error) { failures.push(`${skill.name}：${errorMessage(error)}`) }
      }
      return this.outcome(completed, failures, `已将 ${completed} 个技能移到回收站`)
    })
  }
}
