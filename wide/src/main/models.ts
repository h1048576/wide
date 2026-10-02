import { readFile, writeFile, mkdir, rename, unlink, lstat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser'
import { parseDocument, isNode, isSeq } from 'yaml'
import { DEFAULT_MODEL_BASE_URL, type ModelChange, type ModelDetail, type ModelDocument, type ModelFields, type ModelOrder, type ModelsInventory, type ModelSource, type ModelTarget } from '../shared/types'

type ObjectValue = Record<string, any>
type SourceConfig = { id: string; harness: ModelSource['harness']; path: string; label: string; provider?: string }
const object = (value: unknown): value is ObjectValue => !!value && typeof value === 'object' && !Array.isArray(value)
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const entryRevision = (value: unknown) => hash(JSON.stringify(value))

export class ModelsManager {
  private mutating = false
  constructor(private readonly home = homedir(), private readonly backups = join(home, '.wide', 'model-backups')) {}

  private async jsonSource(harness: 'claude' | 'droid'): Promise<SourceConfig> {
    const folder = join(this.home, harness === 'claude' ? '.claude' : '.factory')
    let path = join(folder, 'settings.json')
    try { await lstat(path) } catch (error) {
      if (!missing(error)) throw error
      const alternative = join(folder, 'setting.json')
      try { await lstat(alternative); path = alternative } catch (other) { if (!missing(other)) throw other }
    }
    return { id: harness, harness, path, label: harness }
  }

  private async read(path: string, allowMissing = false) {
    const info = await lstat(path).catch(error => { if (allowMissing && missing(error)) return null; throw error })
    if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error('模型配置须为普通文件，暂不支持符号链接')
    if (info && info.size > 8 * 1024 * 1024) throw new Error('模型配置超过 8 MB，无法读取')
    const original = info ? await readFile(path, 'utf8') : null
    const bom = original?.startsWith('\uFEFF') ?? false
    return { original, text: original === null ? '{}\n' : original.replace(/^\uFEFF/, ''), bom, mode: info?.mode }
  }

  private json(text: string) {
    const errors: ParseError[] = []
    const data = parse(text, errors, { allowTrailingComma: true })
    if (errors.length || !object(data)) throw new Error('JSON 配置格式无效，请先修复配置文件')
    return data
  }

  private yaml(text: string) {
    const document = parseDocument(text, { uniqueKeys: true })
    if (document.errors.length || !isSeq(document.contents)) throw new Error('DSH YAML 配置格式无效，根节点须为列表')
    const data = document.toJS() as unknown[]
    const indices = data.map((item, index) => object(item) && item.id === 'llm-pi-ai' ? index : -1).filter(index => index >= 0)
    if (indices.length !== 1) throw new Error('DSH 配置须包含一个 id 为 llm-pi-ai 的插件')
    const plugin = data[indices[0]] as ObjectValue
    if (!object(plugin.config?.providers)) throw new Error('llm-pi-ai 尚未配置 providers')
    return { document, providers: plugin.config.providers as ObjectValue, index: indices[0] }
  }

  private async sources(): Promise<SourceConfig[]> {
    const json = await Promise.all([this.jsonSource('claude'), this.jsonSource('droid')])
    const path = this.dshPath('desktop')
    try {
      const { providers } = this.yaml((await this.read(path)).text)
      const names = Object.keys(providers).filter(key => object(providers[key]))
      if (!names.length) throw new Error('尚未配置模型提供商')
      return [...json, ...names.map(provider => ({ id: `dsh:${provider}`, harness: 'dsh' as const, path, label: provider, provider }))]
    } catch { return [...json, { id: 'dsh', harness: 'dsh', path, label: 'dsh' }] }
  }

  private dshPath(profile: 'desktop' | 'web') { return join(this.home, '.dsh', 'profiles', profile, 'cordis.patch.yml') }

  private async source(id: unknown) {
    if (typeof id !== 'string') throw new Error('模型配置标识无效')
    const found = (await this.sources()).find(item => item.id === id)
    if (!found) throw new Error('模型配置已变化，请刷新后重试')
    return found
  }

  private async load(source: SourceConfig) {
    const file = await this.read(source.path, source.harness !== 'dsh')
    if (source.harness === 'dsh') {
      const yaml = this.yaml(file.text)
      if (!source.provider || !object(yaml.providers[source.provider])) throw new Error('尚未配置模型提供商')
      const provider = yaml.providers[source.provider]
      if (provider.modelOverrides !== undefined) throw new Error('此提供商使用 modelOverrides，请先改为 models 后再管理自定义模型')
      const entries = provider.models ?? []
      if (!Array.isArray(entries) || entries.some(item => !object(item))) throw new Error('models 格式无效，须为模型对象列表')
      return { ...file, entries: entries as ObjectValue[], location: [yaml.index, 'config', 'providers', source.provider, 'models'], yaml, baseUrl: typeof provider.baseURL === 'string' ? provider.baseURL : DEFAULT_MODEL_BASE_URL }
    }
    const json = this.json(file.text)
    if (source.harness === 'claude' && json.modelPicker !== undefined && !object(json.modelPicker)) throw new Error('modelPicker 须为对象')
    const entries = source.harness === 'claude' ? json.modelPicker?.options ?? [] : json.customModels ?? []
    if (!Array.isArray(entries) || entries.some(item => !object(item))) throw new Error('自定义模型配置须为模型对象列表')
    return { ...file, entries: entries as ObjectValue[], location: source.harness === 'claude' ? ['modelPicker', 'options'] : ['customModels'], yaml: undefined, baseUrl: undefined }
  }

  async inventory(): Promise<ModelsInventory> {
    const sources = await this.sources()
    return { sources: await Promise.all(sources.map(async source => {
      try {
        const { entries, baseUrl } = await this.load(source)
        if (source.harness === 'dsh') await this.load({ ...source, path: this.dshPath('web') })
        return { ...source, baseUrl, editable: true, models: entries.map((item, index) => ({ index, model: String(source.harness === 'dsh' ? item.id ?? '' : item.model ?? ''), name: String(item.label ?? item.displayName ?? item.name ?? item.model ?? item.id ?? '未命名模型'), revision: entryRevision(item) })) }
      } catch (error) {
        return { ...source, editable: false, models: [], error: missing(error) ? '未找到配置文件' : error instanceof Error ? error.message : '读取模型失败' }
      }
    })) }
  }

  private target(input: unknown): ModelTarget {
    if (!object(input) || typeof input.sourceId !== 'string' || !Number.isInteger(input.index) || input.index < 0 || typeof input.revision !== 'string') throw new Error('模型标识无效')
    return input as ModelTarget
  }

  private entry(entries: ObjectValue[], target: ModelTarget) {
    const entry = entries[target.index]
    if (!entry || entryRevision(entry) !== target.revision) throw new Error('模型已被其他程序修改，请刷新后重试')
    return entry
  }

  async detail(input: unknown): Promise<ModelDetail> {
    const target = this.target(input)
    const source = await this.source(target.sourceId)
    const file = await this.load(source)
    const item = this.entry(file.entries, target)
    const fields: ModelFields = { model: String(source.harness === 'dsh' ? item.id ?? '' : item.model ?? ''), name: String(item.label ?? item.displayName ?? item.name ?? ''), description: item.description }
    if (source.harness === 'droid') Object.assign(fields, { baseUrl: item.baseUrl ?? DEFAULT_MODEL_BASE_URL, provider: item.provider })
    if (source.harness === 'dsh') Object.assign(fields, { baseUrl: file.baseUrl, reasoningEfforts: item.reasoningEfforts })
    return { fields, ...(source.harness === 'droid' ? { apiKey: typeof item.apiKey === 'string' ? item.apiKey : '' } : {}) }
  }

  async preview(id: unknown): Promise<ModelDocument> {
    const source = await this.source(id)
    const file = await this.load(source)
    const paths = source.harness === 'dsh' ? [source.path, this.dshPath('web')] : [source.path]
    const value = source.harness === 'claude' ? { modelPicker: { options: file.entries } } : source.harness === 'droid' ? { customModels: file.entries } : { provider: source.provider, baseURL: file.baseUrl, models: file.entries }
    return { paths, content: JSON.stringify(value, null, 2) }
  }

  private model(harness: SourceConfig['harness'], fields: ModelFields, old: ObjectValue, apiKey: unknown) {
    if (!object(fields) || typeof fields.model !== 'string' || !fields.model.trim() || /[\0\r\n]/.test(fields.model) || fields.model.length > 1024) throw new Error('请输入有效的模型 ID')
    if (typeof fields.name !== 'string' || fields.name.length > 1024) throw new Error('模型名称无效')
    const next = { ...old }
    const set = (key: string, value: unknown) => { if (value === undefined || value === '') delete next[key]; else next[key] = value }
    if (harness === 'claude') {
      next.model = fields.model.trim(); set('label', fields.name.trim()); set('description', fields.description?.trim())
    } else if (harness === 'droid') {
      next.model = fields.model.trim(); set('displayName', fields.name.trim())
      if (!['openai', 'anthropic', 'generic-chat-completion-api'].includes(fields.provider ?? '')) throw new Error('请选择有效的 Provider')
      next.provider = fields.provider
      set('baseUrl', this.apiAddress(fields.baseUrl))
      if (apiKey !== undefined) { if (typeof apiKey !== 'string' || /[\0\r\n]/.test(apiKey)) throw new Error('API Key 无效'); set('apiKey', apiKey.trim()) }
      // Factory 自带的索引和自定义 ID 保留；自动生成的 ID 随模型 ID 更新。
      if (typeof old.id === 'string' && old.id === `custom:${old.model}`) next.id = `custom:${next.model}`
    } else {
      next.id = fields.model.trim(); set('name', fields.name.trim())
      if (fields.reasoningEfforts !== undefined && fields.reasoningEfforts !== false && (!object(fields.reasoningEfforts) || Object.entries(fields.reasoningEfforts).some(([key, value]) => !key.trim() || ['__proto__', 'constructor', 'prototype'].includes(key) || value !== null && typeof value !== 'string'))) throw new Error('请填写有效的思考级别 key、value')
      set('reasoningEfforts', fields.reasoningEfforts)
    }
    return next
  }

  private apiAddress(input: unknown) {
    if (typeof input !== 'string' || !input.trim()) throw new Error('请填写 API 地址')
    try { const url = new URL(input); if (!['https:', 'http:'].includes(url.protocol)) throw new Error() } catch { throw new Error('API 地址须以 http:// 或 https:// 开头') }
    return input.trim()
  }

  private async exclusive(task: () => Promise<void>) {
    if (this.mutating) throw new Error('正在写入模型配置，请稍后再试')
    this.mutating = true
    try { await task() } finally { this.mutating = false }
  }

  async save(input: unknown) {
    if (!object(input)) throw new Error('模型参数无效')
    const change = input as ModelChange
    await this.exclusive(async () => {
      const source = await this.source(change.sourceId)
      const file = await this.load(source)
      const target = change.target === undefined ? undefined : this.target(change.target)
      const copyFrom = change.copyFrom === undefined ? undefined : this.target(change.copyFrom)
      if (target && copyFrom || [target, copyFrom].some(item => item && item.sourceId !== source.id)) throw new Error('模型所属配置无效')
      const old = target || copyFrom ? { ...this.entry(file.entries, (target ?? copyFrom)!) } : {}
      if (copyFrom && source.harness === 'droid') { delete old.index; delete old.id }
      const next = this.model(source.harness, change.fields, old, change.apiKey)
      const key = source.harness === 'dsh' ? 'id' : 'model'
      if (file.entries.some((item, index) => index !== target?.index && item[key] === next[key])) throw new Error('此配置中已存在相同的模型 ID')
      const entries = [...file.entries]
      if (target) entries[target.index] = next
      else entries.push(next)
      await this.commit(source, file, entries, target?.index, false, undefined, source.harness === 'dsh' ? this.apiAddress(change.fields.baseUrl) : undefined)
    })
  }

  async delete(input: unknown) {
    const target = this.target(input)
    await this.exclusive(async () => {
      const source = await this.source(target.sourceId)
      const file = await this.load(source)
      this.entry(file.entries, target)
      const entries = file.entries.filter((_, index) => index !== target.index)
      await this.commit(source, file, entries, target.index, true)
    })
  }

  async reorder(input: unknown) {
    if (!object(input) || typeof input.sourceId !== 'string' || !Array.isArray(input.models)) throw new Error('模型顺序参数无效')
    const change = input as ModelOrder
    await this.exclusive(async () => {
      const source = await this.source(change.sourceId)
      const file = await this.load(source)
      const targets = change.models.map(item => this.target(item))
      if (targets.length !== file.entries.length || new Set(targets.map(item => item.index)).size !== file.entries.length || targets.some(item => item.sourceId !== source.id)) throw new Error('模型列表已变化，请刷新后重新排序')
      const entries = targets.map(item => this.entry(file.entries, item))
      if (source.harness !== 'dsh' && targets.every((item, index) => item.index === index)) return
      await this.commit(source, file, entries, undefined, false, targets.map(item => item.index))
    })
  }

  private async commit(source: SourceConfig, file: Awaited<ReturnType<ModelsManager['load']>>, entries: ObjectValue[], index?: number, deleting = false, order?: number[], baseUrl?: string) {
    const files = [{ source, file, replace: false }]
    if (source.harness === 'dsh') {
      const mirror = { ...source, path: this.dshPath('web') }
      const other = await this.load(mirror)
      files.push({ source: mirror, file: other, replace: JSON.stringify(other.entries) !== JSON.stringify(file.entries) })
    }
    const plans = files.map(item => ({ ...item, text: this.render(item.source, item.file, entries, index, deleting, order, baseUrl, item.replace) }))
      .filter(item => item.text !== item.file.original)
    const staged: { path: string; temporary: string; original: string | null; mode?: number; written: boolean }[] = []
    try {
      for (const { source: config, file: original, text } of plans) {
        await mkdir(dirname(config.path), { recursive: true })
        const temporary = join(dirname(config.path), `.wide-models-${randomUUID()}.tmp`)
        const stage = { path: config.path, temporary, original: original.original, mode: original.mode, written: false }
        staged.push(stage)
        await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx', mode: original.mode ?? 0o600 })
        if (original.original !== null) {
          await mkdir(this.backups, { recursive: true })
          const profile = config.harness === 'dsh' ? config.path === this.dshPath('web') ? '-web' : '-desktop' : ''
          await writeFile(join(this.backups, `${config.id.replace(/[^a-z0-9-]/gi, '_')}${profile}-${Date.now()}-${randomUUID()}.${config.harness === 'dsh' ? 'yml' : 'json'}`), original.original, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
        }
      }
      // 两份 DSH 配置都通过检查后再替换，未改写的文件也需通过外部变化检查。
      for (const item of files) {
        if ((await this.read(item.source.path, true)).original !== item.file.original) throw new Error('配置文件已被其他程序修改，本次未写入，请刷新后重试')
      }
      for (const stage of staged) { await rename(stage.temporary, stage.path); stage.written = true }
    } catch (error) {
      let rollbackFailed = false
      for (const stage of staged.filter(item => item.written).reverse()) {
        try {
          if (stage.original === null) await unlink(stage.path)
          else {
            await writeFile(stage.temporary, stage.original, { encoding: 'utf8', flag: 'wx', mode: stage.mode ?? 0o600 })
            await rename(stage.temporary, stage.path)
          }
        } catch { rollbackFailed = true }
      }
      if (rollbackFailed) throw new Error('写入配置失败，部分文件未能恢复，请从 wide 的 model-backups 目录恢复')
      throw error
    } finally {
      for (const stage of staged) await unlink(stage.temporary).catch(error => { if (!missing(error)) throw error })
    }
  }

  private render(source: SourceConfig, file: Awaited<ReturnType<ModelsManager['load']>>, entries: ObjectValue[], index?: number, deleting = false, order?: number[], baseUrl?: string, replace = false) {
    const eol = file.text.includes('\r\n') ? '\r\n' : '\n'
    let text: string
    if (file.yaml) {
      // 只改目标模型的 AST 节点，保留其他插件和模型的 YAML 注释。
      if (replace) file.yaml.document.setIn(file.location, entries)
      else if (order) {
        const sequence = file.yaml.document.getIn(file.location, true)
        if (!isSeq(sequence)) throw new Error('模型列表已变化，请刷新后重新排序')
        const nodes = [...sequence.items]
        // YAML 将首个模型上方的注释附在列表节点上；排序时将它带回首个模型。
        if (sequence.commentBefore && isNode(nodes[0])) {
          nodes[0].commentBefore = [sequence.commentBefore, nodes[0].commentBefore].filter(Boolean).join('\n')
          sequence.commentBefore = undefined
        }
        sequence.items = order.map(position => nodes[position])
      } else if (index === undefined) {
        const sequence = file.yaml.document.getIn(file.location, true)
        if (isSeq(sequence)) sequence.add(entries.at(-1))
        else file.yaml.document.setIn(file.location, entries)
      } else if (deleting) file.yaml.document.deleteIn([...file.location, index])
      else {
        const old = file.entries[index], next = entries[index]
        for (const key of Object.keys(old)) if (!(key in next)) file.yaml.document.deleteIn([...file.location, index, key])
        for (const [key, value] of Object.entries(next)) if (JSON.stringify(value) !== JSON.stringify(old[key])) file.yaml.document.setIn([...file.location, index, key], value)
      }
      if (baseUrl !== undefined) file.yaml.document.setIn([...file.location.slice(0, -1), 'baseURL'], baseUrl)
      text = file.yaml.document.toString({ lineWidth: 0 }).replace(/\r?\n/g, eol)
      this.yaml(text)
    } else {
      const indentation = file.text.match(/\n([ \t]+)\S/)?.[1] ?? '  '
      const formattingOptions = { insertSpaces: !indentation.includes('\t'), tabSize: indentation.length, eol }
      const root = this.json(file.text)
      const hasArray = source.harness === 'claude' ? Array.isArray(root.modelPicker?.options) : Array.isArray(root.customModels)
      const location = order || !hasArray ? file.location : [...file.location, index ?? file.entries.length]
      const value = order || !hasArray ? entries : deleting ? undefined : index === undefined ? entries.at(-1) : entries[index]
      text = applyEdits(file.text, modify(file.text, location, value, { formattingOptions, isArrayInsertion: !order && hasArray && index === undefined }))
      this.json(text)
    }
    if (file.bom) text = `\uFEFF${text}`
    return text
  }
}
