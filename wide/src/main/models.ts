import { readFile, writeFile, mkdir, rename, unlink, lstat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser'
import { parseDocument, isNode, isSeq } from 'yaml'
import { DEFAULT_MODEL_BASE_URL, type ModelBatchChange, type ModelBatchResult, type ModelChange, type ModelDetail, type ModelDocument, type ModelFields, type ModelOrder, type ModelsInventory, type ModelSource, type ModelTarget } from '../shared/types'

const mapModelId = Symbol('opencode model ID')
type ObjectValue = Record<string, any> & { [mapModelId]?: string }
type SourceConfig = { id: string; harness: ModelSource['harness']; path: string; label: string; provider?: string }
type FileChange = { source: SourceConfig; file: Awaited<ReturnType<ModelsManager['load']>>; entries: ObjectValue[]; index?: number; deleting?: boolean; order?: number[]; baseUrl?: string; replace?: boolean }
const object = (value: unknown): value is ObjectValue => !!value && typeof value === 'object' && !Array.isArray(value)
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const entryRevision = (value: ObjectValue) => hash(JSON.stringify([value[mapModelId], value]))
// 固定为当前配置的字段顺序；未知字段接在其后，并保留原顺序。
const modelKeyOrder: Record<ModelSource['harness'], string[]> = {
  claude: ['model', 'label', 'description'],
  droid: ['model', 'id', 'baseUrl', 'apiKey', 'provider', 'displayName'],
  dsh: ['id', 'name', 'reasoningEfforts'],
  pi: ['id', 'name', 'reasoning', 'contextWindow'],
  opencode: ['name']
}
const modelId = (harness: ModelSource['harness'], item: ObjectValue) => String(harness === 'opencode' ? item[mapModelId] : harness === 'dsh' || harness === 'pi' ? item.id ?? '' : item.model ?? '')
const modelName = (id: string) => id.split('/').at(-1)!.replace(/\[1m\]/gi, '').trim()
const plainModelId = (id: string) => id.replace(/\[1m\]/gi, '')

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

  private async sources(read = (path: string) => this.read(path), parseYaml = (text: string) => this.yaml(text)): Promise<SourceConfig[]> {
    const json = await Promise.all([this.jsonSource('claude'), this.jsonSource('droid')])
    const extra: SourceConfig[] = [
      { id: 'pi', harness: 'pi', path: join(this.home, '.pi', 'agent', 'models.json'), label: 'proxy', provider: 'proxy' },
      { id: 'opencode', harness: 'opencode', path: join(this.home, '.config', 'opencode', 'opencode.json'), label: 'proxy', provider: 'proxy' }
    ]
    const path = this.dshPath('desktop')
    try {
      const { providers } = parseYaml((await read(path)).text)
      const names = Object.keys(providers).filter(key => object(providers[key]))
      if (!names.length) throw new Error('尚未配置模型提供商')
      return [...json, ...names.map(provider => ({ id: `dsh:${provider}`, harness: 'dsh' as const, path, label: provider, provider })), ...extra]
    } catch { return [...json, { id: 'dsh', harness: 'dsh', path, label: 'dsh' }, ...extra] }
  }

  private dshPath(profile: 'desktop' | 'web') { return join(this.home, '.dsh', 'profiles', profile, 'cordis.patch.yml') }

  private async source(id: unknown) {
    if (typeof id !== 'string') throw new Error('模型配置标识无效')
    const found = (await this.sources()).find(item => item.id === id)
    if (!found) throw new Error('模型配置已变化，请刷新后重试')
    return found
  }

  private async load(source: SourceConfig) {
    const file = await this.read(source.path, source.harness === 'claude' || source.harness === 'droid')
    return this.parseFile(source, file)
  }

  private parseFile(source: SourceConfig, file: Awaited<ReturnType<ModelsManager['read']>>, parseYaml = (text: string) => this.yaml(text)) {
    if (source.harness === 'dsh') {
      const yaml = parseYaml(file.text)
      if (!source.provider || !object(yaml.providers[source.provider])) throw new Error('尚未配置模型提供商')
      const provider = yaml.providers[source.provider]
      if (provider.modelOverrides !== undefined) throw new Error('此提供商使用 modelOverrides，请先改为 models 后再管理自定义模型')
      const entries = provider.models ?? []
      if (!Array.isArray(entries) || entries.some(item => !object(item))) throw new Error('models 格式无效，须为模型对象列表')
      return { ...file, entries: entries as ObjectValue[], location: [yaml.index, 'config', 'providers', source.provider, 'models'], yaml, baseUrl: typeof provider.baseURL === 'string' ? provider.baseURL : DEFAULT_MODEL_BASE_URL }
    }
    const json = this.json(file.text)
    if (source.harness === 'pi' || source.harness === 'opencode') {
      const location = source.harness === 'pi' ? ['providers', 'proxy', 'models'] : ['provider', 'proxy', 'models']
      const provider = source.harness === 'pi' ? json.providers?.proxy : json.provider?.proxy
      if (!object(provider)) throw new Error('尚未配置 proxy 模型提供商')
      const models = provider.models ?? (source.harness === 'pi' ? [] : {})
      if (source.harness === 'pi' && (!Array.isArray(models) || models.some(item => !object(item)))) throw new Error('pi models 须为模型对象列表')
      if (source.harness === 'opencode' && (!object(models) || Object.values(models).some(item => !object(item)))) throw new Error('opencode models 须为以模型 ID 为键的对象')
      const entries: ObjectValue[] = source.harness === 'pi' ? models : Object.entries(models).map(([id, value]) => ({ ...(value as ObjectValue), [mapModelId]: id }))
      return { ...file, entries, location, yaml: undefined, baseUrl: source.harness === 'pi' ? provider.baseUrl ?? DEFAULT_MODEL_BASE_URL : provider.options?.baseURL ?? DEFAULT_MODEL_BASE_URL }
    }
    if (source.harness === 'claude' && json.modelPicker !== undefined && !object(json.modelPicker)) throw new Error('modelPicker 须为对象')
    const entries = source.harness === 'claude' ? json.modelPicker?.options ?? [] : json.customModels ?? []
    if (!Array.isArray(entries) || entries.some(item => !object(item))) throw new Error('自定义模型配置须为模型对象列表')
    return { ...file, entries: entries as ObjectValue[], location: source.harness === 'claude' ? ['modelPicker', 'options'] : ['customModels'], yaml: undefined, baseUrl: undefined }
  }

  async inventory(): Promise<ModelsInventory> {
    const files = new Map<string, Promise<Awaited<ReturnType<ModelsManager['read']>>>>()
    const documents = new Map<string, ReturnType<ModelsManager['yaml']>>()
    const read = (path: string, allowMissing = false) => {
      let file = files.get(path)
      if (!file) { file = this.read(path, allowMissing); files.set(path, file) }
      return file
    }
    const parseYaml = (text: string) => {
      let document = documents.get(text)
      if (!document) { document = this.yaml(text); documents.set(text, document) }
      return document
    }
    const sources = await this.sources(read, parseYaml)
    return { sources: await Promise.all(sources.map(async source => {
      try {
        const { entries, baseUrl } = this.parseFile(source, await read(source.path, source.harness === 'claude' || source.harness === 'droid'), parseYaml)
        if (source.harness === 'dsh') this.parseFile(source, await read(this.dshPath('web')), parseYaml)
        return { ...source, baseUrl, editable: true, models: entries.map((item, index) => ({ index, model: modelId(source.harness, item), name: String(item.label ?? item.displayName ?? item.name ?? modelId(source.harness, item) ?? '未命名模型'), revision: entryRevision(item) })) }
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
    const fields: ModelFields = { model: modelId(source.harness, item), name: String(item.label ?? item.displayName ?? item.name ?? ''), description: item.description }
    if (source.harness === 'droid') Object.assign(fields, { baseUrl: item.baseUrl ?? DEFAULT_MODEL_BASE_URL, provider: item.provider })
    if (source.harness === 'dsh') Object.assign(fields, { baseUrl: file.baseUrl, reasoningEfforts: item.reasoningEfforts })
    if (source.harness === 'pi' || source.harness === 'opencode') fields.baseUrl = file.baseUrl
    return { fields, ...(source.harness === 'droid' ? { apiKey: typeof item.apiKey === 'string' ? item.apiKey : '' } : {}) }
  }

  async preview(id: unknown): Promise<ModelDocument> {
    const source = await this.source(id)
    const file = await this.load(source)
    const paths = source.harness === 'dsh' ? [source.path, this.dshPath('web')] : [source.path]
    if (file.yaml) {
      // 预览完整模型插件，保留 YAML 层级、提供商顺序和注释。
      const document = file.yaml.document.clone()
      if (isSeq(document.contents)) document.contents.items = [document.contents.items[file.yaml.index]]
      return { paths, content: document.toString({ lineWidth: 0 }) }
    }
    const value = source.harness === 'claude' ? { modelPicker: { options: file.entries } } : source.harness === 'droid' ? { customModels: file.entries } : source.harness === 'pi' ? { providers: { proxy: { models: file.entries } } } : { provider: { proxy: { models: Object.fromEntries(file.entries.map(item => [item[mapModelId]!, item])) } } }
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
      // 补齐新增或复制模型的 ID；已有自动生成的 ID 随模型 ID 更新。
      if (typeof old.id !== 'string' || !old.id.trim() || old.id === `custom:${old.model}`) next.id = `custom:${next.model}`
    } else if (harness === 'dsh' || harness === 'pi') {
      next.id = fields.model.trim(); set('name', fields.name.trim())
      if (harness === 'dsh') {
        if (fields.reasoningEfforts !== undefined && fields.reasoningEfforts !== false && (!object(fields.reasoningEfforts) || Object.entries(fields.reasoningEfforts).some(([key, value]) => !key.trim() || ['__proto__', 'constructor', 'prototype'].includes(key) || value !== null && typeof value !== 'string'))) throw new Error('请填写有效的思考级别 key、value')
        set('reasoningEfforts', fields.reasoningEfforts)
      }
    } else {
      next[mapModelId] = fields.model.trim(); set('name', fields.name.trim())
      if (typeof old.id === 'string' && old.id === old[mapModelId]) next.id = next[mapModelId]
    }
    return next
  }

  private ordered(harness: SourceConfig['harness'], item: ObjectValue) {
    const keys = [...new Set([...modelKeyOrder[harness], ...Object.keys(item)])]
    const next = Object.fromEntries(keys.filter(key => Object.hasOwn(item, key)).map(key => [key, item[key]])) as ObjectValue
    if (item[mapModelId] !== undefined) next[mapModelId] = item[mapModelId]
    return next
  }

  private apiAddress(input: unknown) {
    if (typeof input !== 'string' || !input.trim()) throw new Error('请填写 API 地址')
    try { const url = new URL(input); if (!['https:', 'http:'].includes(url.protocol)) throw new Error() } catch { throw new Error('API 地址须以 http:// 或 https:// 开头') }
    return input.trim()
  }

  private async exclusive<T>(task: () => Promise<T>): Promise<T> {
    if (this.mutating) throw new Error('正在写入模型配置，请稍后再试')
    this.mutating = true
    try { return await task() } finally { this.mutating = false }
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
      const old = target || copyFrom ? { ...this.entry(file.entries, (target ?? copyFrom)!) } : source.harness === 'pi' || source.harness === 'opencode' ? { ...file.entries.at(-1) } : {}
      if (copyFrom && source.harness === 'droid') { delete old.index; delete old.id }
      const model = this.model(source.harness, change.fields, old, change.apiKey)
      const next = this.ordered(source.harness, model)
      if (file.entries.some((item, index) => index !== target?.index && modelId(source.harness, item) === modelId(source.harness, next))) throw new Error('此配置中已存在相同的模型 ID')
      const entries = [...file.entries]
      if (target) entries[target.index] = next
      else entries.push(next)
      await this.commit(source, file, entries, target?.index, false, undefined, source.harness === 'dsh' || source.harness === 'pi' || source.harness === 'opencode' ? this.apiAddress(change.fields.baseUrl) : undefined)
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

  async batch(input: unknown): Promise<ModelBatchResult> {
    if (!object(input) || !['replace', 'add', 'delete'].includes(input.action)) throw new Error('批量模型参数无效')
    const change = input as ModelBatchChange
    const validId = (value: unknown): value is string => typeof value === 'string' && !!plainModelId(value.trim()) && value.length <= 1024 && !/[\0\r\n]/.test(value)
    if (!validId(change.model) || change.action === 'replace' && !validId(change.originalModel)) throw new Error('请输入有效的模型 ID')
    const requested = plainModelId(change.model.trim())
    const original = change.originalModel ? plainModelId(change.originalModel.trim()) : ''
    if (change.action === 'replace' && requested === original) throw new Error('原模型与新模型不能相同')
    return this.exclusive(async () => {
      const changes: FileChange[] = []
      const harnesses = new Set<ModelSource['harness']>()
      let changed = 0, skipped = 0
      for (const source of await this.sources()) {
        let file: Awaited<ReturnType<ModelsManager['load']>>
        try { file = await this.load(source) } catch (error) { throw new Error(`${source.harness}：${missing(error) ? '未找到配置文件' : error instanceof Error ? error.message : '读取配置失败'}`) }
        const matchedId = change.action === 'replace' ? original : requested
        const matched = change.action !== 'add' ? file.entries.map((item, index) => plainModelId(modelId(source.harness, item)) === matchedId ? index : -1).filter(index => index >= 0) : []
        const alreadyExists = file.entries.some(item => plainModelId(modelId(source.harness, item)) === requested)
        if (change.action === 'add' && alreadyExists || change.action !== 'add' && !matched.length) { skipped++; continue }
        if (change.action === 'replace' && alreadyExists) throw new Error(`${source.harness} 已存在新模型，无法替换；本次未写入配置`)
        const entries = [...file.entries]
        const retarget = (item: ObjectValue) => {
          const oldId = modelId(source.harness, item)
          const nextId = source.harness === 'claude' && /\[1m\]/i.test(oldId) ? `${requested}[1m]` : requested
          const name = modelName(nextId)
          const previousName = String(item.label ?? item.displayName ?? item.name ?? modelName(oldId))
          const replacements = new Map<string, string>([[oldId, nextId], [previousName, name]])
          const pattern = [...replacements.keys()].filter(Boolean).sort((a, b) => b.length - a.length).map(key => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
          const description = typeof item.description === 'string' && pattern ? item.description.replace(new RegExp(pattern, 'g'), match => replacements.get(match)!) : item.description
          const old = { ...item }
          if (source.harness === 'droid') { old.id = `custom:${old.model}`; if (change.action === 'add') delete old.index }
          if (source.harness === 'opencode' && typeof old.id === 'string') old.id = nextId
          const fields: ModelFields = { model: nextId, name, description, provider: item.provider, baseUrl: item.baseUrl, reasoningEfforts: item.reasoningEfforts }
          const next = this.model(source.harness, fields, old, undefined)
          return this.ordered(source.harness, next)
        }
        if (change.action === 'delete') {
          const remaining = entries.filter((_, index) => !matched.includes(index))
          // 从后向前删除，保持后续索引有效，并保留其他模型的顺序和注释。
          for (const index of [...matched].reverse()) changes.push(...await this.prepare(source, file, remaining, index, true))
          changed += matched.length
        } else if (change.action === 'add') {
          const last = file.entries.at(-1)
          if (!last) throw new Error(`${source.harness} 没有可复制的最后一条模型配置；本次未写入配置`)
          entries.push(retarget(last))
          changes.push(...await this.prepare(source, file, entries))
          changed++
        } else {
          for (const index of matched) entries[index] = retarget(file.entries[index])
          for (const index of matched) changes.push(...await this.prepare(source, file, entries, index))
          changed += matched.length
        }
        harnesses.add(source.harness)
      }
      if (change.action === 'replace' && !changed) throw new Error('未找到原模型，请检查完整模型 ID')
      if (change.action === 'delete' && !changed) throw new Error('未找到对应模型，请检查完整模型 ID')
      await this.commitAll(changes)
      return { changed, skipped, harnesses: [...harnesses] }
    })
  }

  private async prepare(source: SourceConfig, file: Awaited<ReturnType<ModelsManager['load']>>, entries: ObjectValue[], index?: number, deleting = false, order?: number[], baseUrl?: string): Promise<FileChange[]> {
    const changes: FileChange[] = [{ source, file, entries, index, deleting, order, baseUrl, replace: false }]
    if (source.harness === 'dsh') {
      const mirror = { ...source, path: this.dshPath('web') }
      const other = await this.load(mirror)
      changes.push({ source: mirror, file: other, entries, index, deleting, order, baseUrl, replace: JSON.stringify(other.entries) !== JSON.stringify(file.entries) })
    }
    return changes
  }

  private async commit(source: SourceConfig, file: Awaited<ReturnType<ModelsManager['load']>>, entries: ObjectValue[], index?: number, deleting = false, order?: number[], baseUrl?: string) {
    await this.commitAll(await this.prepare(source, file, entries, index, deleting, order, baseUrl))
  }

  private async commitAll(changes: FileChange[]) {
    const grouped = new Map<string, { source: SourceConfig; file: FileChange['file']; text: string }>()
    for (const change of changes) {
      const previous = grouped.get(change.source.path)
      if (previous && previous.file.original !== change.file.original) throw new Error('配置文件已被其他程序修改，本次未写入，请刷新后重试')
      const current = previous ? this.parseFile(change.source, { ...previous.file, text: previous.text.replace(/^\uFEFF/, '') }) : change.file
      const text = this.render(change.source, current, change.entries, change.index, change.deleting, change.order, change.baseUrl, change.replace)
      grouped.set(change.source.path, { source: change.source, file: previous?.file ?? change.file, text })
    }
    const files = [...grouped.values()]
    const plans = files.filter(item => item.text !== item.file.original)
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
      // 所有配置通过检查并备份后再替换，失败时按相反顺序恢复。
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
      if (source.harness === 'opencode') {
        const renamed = index !== undefined && !deleting && file.entries[index][mapModelId] !== entries[index][mapModelId]
        const replaceMap = !!order || renamed || !object(root.provider?.proxy?.models)
        const item = index === undefined ? entries.at(-1)! : deleting ? file.entries[index] : entries[index]
        const location = replaceMap ? file.location : [...file.location, item[mapModelId]!]
        const value = replaceMap ? Object.fromEntries(entries.map(entry => [entry[mapModelId]!, entry])) : deleting ? undefined : item
        text = applyEdits(file.text, modify(file.text, location, value, { formattingOptions }))
      } else {
        const hasArray = source.harness === 'claude' ? Array.isArray(root.modelPicker?.options) : source.harness === 'pi' ? Array.isArray(root.providers?.proxy?.models) : Array.isArray(root.customModels)
        const location = order || !hasArray ? file.location : [...file.location, index ?? file.entries.length]
        const value = order || !hasArray ? entries : deleting ? undefined : index === undefined ? entries.at(-1) : entries[index]
        text = applyEdits(file.text, modify(file.text, location, value, { formattingOptions, isArrayInsertion: !order && hasArray && index === undefined }))
      }
      if (baseUrl !== undefined) {
        const location = source.harness === 'pi' ? ['providers', 'proxy', 'baseUrl'] : ['provider', 'proxy', 'options', 'baseURL']
        text = applyEdits(text, modify(text, location, baseUrl, { formattingOptions }))
      }
      // 每次 JSON 写入都规范模型字段，包括后补字段和此前保存的旧顺序。
      // 逐个替换需要调整的模型，保留模型列表顺序及模型配置之外的内容。
      const rendered = this.parseFile(source, { ...file, text })
      for (const [position, item] of rendered.entries.entries()) {
        const ordered = this.ordered(source.harness, item)
        if (JSON.stringify(Object.keys(item)) === JSON.stringify(Object.keys(ordered))) continue
        const location = [...rendered.location, source.harness === 'opencode' ? item[mapModelId]! : position]
        text = applyEdits(text, modify(text, location, ordered, { formattingOptions }))
      }
      this.json(text)
    }
    if (file.bom) text = `\uFEFF${text}`
    return text
  }
}
