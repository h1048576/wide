import { readFile, writeFile, mkdir, rename, unlink, lstat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { applyEdits, modify, parse as parseJson, type ParseError } from 'jsonc-parser'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { getStaticTOMLValue, parseTOML } from 'toml-eslint-parser'
import type { McpChange, McpDocument, McpFields, McpHarnessId, McpSource, McpTarget, McpsInventory } from '../shared/types'

type Value = Record<string, any>
const object = (value: unknown): value is Value => !!value && typeof value === 'object' && !Array.isArray(value)
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
const revision = (entry: Value) => createHash('sha256').update(JSON.stringify(entry)).digest('hex')
// TOML 解析器使用无原型对象；按字段和值比较，避免把原型差异当成配置变更。
const plain = (value: any): any => Array.isArray(value) ? value.map(plain) : object(value) && !(value instanceof Date) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)])) : value
const transport = (id: McpHarnessId, entry: Value) => id === 'claude' ? entry.type ?? 'stdio' : entry.url !== undefined ? 'http' : 'stdio'
// 仅过滤展示内容，读写仍使用完整配置，保留 Codex 的内置 node_repl。
const visibleServers = (id: McpHarnessId, servers: Record<string, Value>) => Object.entries(servers).filter(([name]) => id !== 'codex' || name !== 'node_repl')
const stringMap = (input: unknown, label: string): Record<string, string> => {
  if (!object(input) || Object.entries(input).some(([key, value]) => !key.trim() || typeof value !== 'string' || /[\0\r\n]/.test(key))) throw new Error(`${label}须为名称和文本值`)
  return Object.fromEntries(Object.entries(input))
}

export class McpsManager {
  private mutating = false
  constructor(private readonly home = homedir(), private readonly backups = join(home, '.wide', 'mcp-backups'), private readonly paths: Partial<Record<McpHarnessId, string>> = {}) {}

  private harness(input: unknown): McpHarnessId {
    if (input !== 'claude' && input !== 'codex') throw new Error('MCP Harness 无效')
    return input
  }
  private path(id: McpHarnessId) { return this.paths[id] ?? (id === 'claude' ? join(this.home, '.claude.json') : join(this.home, '.codex', 'config.toml')) }
  private key(id: McpHarnessId) { return id === 'claude' ? 'mcpServers' : 'mcp_servers' }
  private async read(id: McpHarnessId) {
    const path = this.path(id)
    const info = await lstat(path).catch(error => { if (missing(error)) return null; throw error })
    if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error('MCP 配置须为普通文件，暂不支持符号链接')
    if (info && info.size > 16 * 1024 * 1024) throw new Error('MCP 配置超过 16 MB，无法读取')
    const original = info ? await readFile(path, 'utf8') : null
    const text = original?.replace(/^\uFEFF/, '') ?? (id === 'claude' ? '{}\n' : '')
    return { path, original, text, bom: original?.startsWith('\uFEFF') ?? false, mode: info?.mode }
  }
  private parse(id: McpHarnessId, text: string) {
    let root: Value
    try {
      if (id === 'claude') {
        const errors: ParseError[] = []
        root = parseJson(text, errors, { allowTrailingComma: true })
        if (errors.length || !object(root)) throw new Error()
      } else root = parseToml(text)
    } catch { throw new Error(`${id === 'claude' ? 'JSON' : 'TOML'} 配置格式无效，请先修复配置文件`) }
    const servers = root[this.key(id)] ?? {}
    if (!object(servers) || Object.values(servers).some(entry => !object(entry))) throw new Error(`${this.key(id)} 须为以 MCP 名称为键的配置对象`)
    return { root, servers: servers as Record<string, Value> }
  }
  async source(input: unknown): Promise<McpSource> {
    const id = this.harness(input)
    try {
      const file = await this.read(id), { servers } = this.parse(id, file.text)
      return { harness: id, path: file.path, editable: true, servers: visibleServers(id, servers).map(([name, entry]) => ({ name, transport: transport(id, entry), description: String(entry.url ?? entry.command ?? ''), revision: revision(entry) })) }
    } catch (error) { return { harness: id, path: this.path(id), editable: false, servers: [], error: error instanceof Error ? error.message : String(error) } }
  }
  async inventory(): Promise<McpsInventory> { return { sources: await Promise.all(['claude', 'codex'].map(id => this.source(id))) } }
  private target(input: unknown, id?: McpHarnessId): McpTarget {
    if (!object(input) || typeof input.name !== 'string' || !input.name || typeof input.revision !== 'string') throw new Error('MCP 标识无效')
    const harness = this.harness(input.harness)
    if (id && id !== harness) throw new Error('MCP 所属 Harness 不一致')
    return { harness, name: input.name, revision: input.revision }
  }
  private entry(servers: Record<string, Value>, target: McpTarget) {
    if (!Object.hasOwn(servers, target.name) || revision(servers[target.name]) !== target.revision) throw new Error('MCP 已被其他程序修改，请刷新后重试')
    return servers[target.name]
  }
  async detail(input: unknown): Promise<McpFields> {
    const target = this.target(input), file = await this.read(target.harness)
    const entry = this.entry(this.parse(target.harness, file.text).servers, target)
    const type = transport(target.harness, entry)
    if (!['stdio', 'http', 'sse', 'ws'].includes(type)) throw new Error('此 MCP 传输方式暂不支持编辑')
    if (entry.args !== undefined && (!Array.isArray(entry.args) || entry.args.some((item: unknown) => typeof item !== 'string'))) throw new Error('MCP args 须为文本列表')
    return {
      name: target.name, transport: type, command: entry.command ?? '', args: entry.args ?? [], env: stringMap(entry.env ?? {}, '环境变量'),
      url: entry.url ?? '', headers: stringMap((target.harness === 'claude' ? entry.headers : entry.http_headers) ?? {}, '请求头'),
      cwd: entry.cwd ?? '', bearerTokenEnvVar: entry.bearer_token_env_var ?? '', envHeaders: stringMap(entry.env_http_headers ?? {}, '请求头环境变量')
    }
  }
  async preview(input: unknown): Promise<McpDocument> {
    const id = this.harness(input), file = await this.read(id), { servers } = this.parse(id, file.text)
    const visible = Object.fromEntries(visibleServers(id, servers))
    return { path: file.path, format: id === 'claude' ? 'json' : 'toml', content: id === 'claude' ? JSON.stringify({ mcpServers: visible }, null, 2) : stringifyToml({ mcp_servers: visible }) }
  }
  private fields(input: unknown, id: McpHarnessId): McpFields {
    if (!object(input)) throw new Error('MCP 配置无效')
    const fields = input as McpFields
    if (typeof fields.name !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(fields.name) || ['__proto__', 'constructor', 'prototype'].includes(fields.name)) throw new Error('MCP 名称仅支持字母、数字、下划线和连字符')
    if (!(id === 'claude' ? ['stdio', 'http', 'sse', 'ws'] : ['stdio', 'http']).includes(fields.transport)) throw new Error('MCP 传输方式无效')
    for (const key of ['command', 'url', 'cwd', 'bearerTokenEnvVar'] as const) if (typeof fields[key] !== 'string' || fields[key].length > 8192 || fields[key].includes('\0')) throw new Error('MCP 字段格式无效')
    if (!Array.isArray(fields.args) || fields.args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('启动参数须为文本列表')
    if (fields.transport === 'stdio' && !fields.command.trim()) throw new Error('请填写启动命令')
    if (fields.transport !== 'stdio') {
      // 保留 Claude 支持的环境变量引用，不展开也不发送请求。
      const address = fields.url.replace(/\$\{[^}]+\}/g, 'value')
      try { if (!(fields.transport === 'ws' ? ['ws:', 'wss:'] : ['http:', 'https:']).includes(new URL(address).protocol)) throw new Error() }
      catch { throw new Error('请填写有效的 MCP 地址') }
    }
    return { ...fields, env: stringMap(fields.env, '环境变量'), headers: stringMap(fields.headers, '请求头'), envHeaders: stringMap(fields.envHeaders, '请求头环境变量') }
  }
  private updateEntry(id: McpHarnessId, fields: McpFields, original: Value = {}) {
    const next = { ...original }
    const previousTransport = transport(id, original)
    if (fields.transport !== previousTransport) {
      for (const key of ['type', 'command', 'args', 'env', 'env_vars', 'cwd', 'url', 'headers', 'headersHelper', 'http_headers', 'env_http_headers', 'http_headers_helper', 'bearer_token_env_var', 'oauth', 'auth', 'scopes', 'oauth_resource']) delete next[key]
    }
    const optional = (key: string, value: unknown, present: boolean) => { if (present) next[key] = value; else delete next[key] }
    if (id === 'claude') next.type = fields.transport
    if (fields.transport === 'stdio') {
      next.command = fields.command
      optional('args', fields.args, !!fields.args.length)
      optional('env', fields.env, !!Object.keys(fields.env).length)
      if (id === 'codex') optional('cwd', fields.cwd, !!fields.cwd)
    } else {
      next.url = fields.url
      optional(id === 'claude' ? 'headers' : 'http_headers', fields.headers, !!Object.keys(fields.headers).length)
      if (id === 'codex') {
        optional('bearer_token_env_var', fields.bearerTokenEnvVar, !!fields.bearerTokenEnvVar)
        optional('env_http_headers', fields.envHeaders, !!Object.keys(fields.envHeaders).length)
      }
    }
    return next
  }
  private renderToml(text: string, servers: Record<string, Value>, oldName?: string, newName?: string) {
    const ast = parseTOML(text, { tomlVersion: '1.1' })
    const nodes = ast.body[0].body
    // 标准表只替换当前 MCP 及其子表；其他 MCP 的文本、注释和顺序保持原样。
    const tables = nodes.filter(node => node.type === 'TOMLTable' && node.resolvedKey[0] === 'mcp_servers')
    const simple = nodes.every(node => node.type !== 'TOMLKeyValue' || getStaticTOMLValue(node.key)[0] !== 'mcp_servers') && tables.every(node => node.type === 'TOMLTable' && node.resolvedKey.length >= 2)
    if (simple) {
      const selected = tables.filter(node => node.type === 'TOMLTable' && node.resolvedKey[1] === oldName)
      const block = newName ? stringifyToml({ mcp_servers: { [newName]: servers[newName] } }).trimEnd() : ''
      let rendered = text
      for (const node of [...selected].reverse()) rendered = rendered.slice(0, node.range[0]) + (node === selected[0] ? block : '') + rendered.slice(node.range[1])
      if (!selected.length && block) rendered = rendered.trimEnd() + '\n\n' + block + '\n'
      return rendered
    }
    // 内联表、点分键等合法 TOML 写法统一为官方的 [mcp_servers.<name>] 形式。
    const ranges = nodes.filter(node => node.type === 'TOMLTable' ? node.resolvedKey[0] === 'mcp_servers' : getStaticTOMLValue(node.key)[0] === 'mcp_servers').map(node => node.range)
    let rendered = text
    for (const [start, end] of ranges.reverse()) rendered = rendered.slice(0, start) + rendered.slice(end)
    return rendered.trimEnd() + '\n\n' + stringifyToml({ mcp_servers: servers })
  }
  private render(id: McpHarnessId, file: Awaited<ReturnType<McpsManager['read']>>, servers: Record<string, Value>, oldName?: string, newName?: string) {
    const { root } = this.parse(id, file.text)
    const eol = file.text.includes('\r\n') ? '\r\n' : '\n'
    let text = id === 'claude' ? applyEdits(file.text, modify(file.text, ['mcpServers'], servers, { formattingOptions: { insertSpaces: true, tabSize: 2, eol } })) : this.renderToml(file.text, servers, oldName, newName)
    if (id === 'codex') text = text.replace(/\r?\n/g, eol)
    const checked = this.parse(id, text)
    if (!isDeepStrictEqual(plain(checked.servers), plain(servers)) || !isDeepStrictEqual(plain({ ...root, [this.key(id)]: undefined }), plain({ ...checked.root, [this.key(id)]: undefined }))) throw new Error('MCP 配置写入校验失败，本次未写入')
    return (file.bom ? '\uFEFF' : '') + text
  }
  private async commit(id: McpHarnessId, file: Awaited<ReturnType<McpsManager['read']>>, text: string) {
    if (text === file.original) return
    await mkdir(dirname(file.path), { recursive: true })
    const temporary = join(dirname(file.path), `.wide-mcps-${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx', mode: file.mode ?? 0o600 })
      if (file.original !== null) {
        await mkdir(this.backups, { recursive: true })
        await writeFile(join(this.backups, `${id}-${Date.now()}-${randomUUID()}.${id === 'claude' ? 'json' : 'toml'}`), file.original, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      }
      if ((await this.read(id)).original !== file.original) throw new Error('配置文件已被其他程序修改，本次未写入，请刷新后重试')
      await rename(temporary, file.path)
    } finally { await unlink(temporary).catch(error => { if (!missing(error)) throw error }) }
  }
  async save(input: unknown) {
    if (this.mutating) throw new Error('MCP 操作正在执行，请稍后再试')
    this.mutating = true
    try {
      if (!object(input)) throw new Error('MCP 修改无效')
      const change = input as McpChange, id = this.harness(change.harness), fields = this.fields(change.fields, id)
      if (change.target && change.copyFrom) throw new Error('MCP 修改方式无效')
      const target = change.target ? this.target(change.target, id) : undefined, copy = change.copyFrom ? this.target(change.copyFrom, id) : undefined
      const file = await this.read(id), { servers } = this.parse(id, file.text)
      const original = target || copy ? this.entry(servers, (target ?? copy)!) : undefined
      if (Object.hasOwn(servers, fields.name) && fields.name !== target?.name) throw new Error('已有同名 MCP，请更换名称')
      const updated = this.updateEntry(id, fields, original)
      const entries = Object.entries(servers).map(([name, entry]) => name === target?.name ? [fields.name, updated] : [name, entry])
      if (!target) entries.push([fields.name, updated])
      const next = Object.fromEntries(entries)
      await this.commit(id, file, this.render(id, file, next, target?.name, fields.name))
    } finally { this.mutating = false }
  }
  async delete(input: unknown) {
    if (this.mutating) throw new Error('MCP 操作正在执行，请稍后再试')
    this.mutating = true
    try {
      const target = this.target(input), file = await this.read(target.harness), { servers } = this.parse(target.harness, file.text)
      this.entry(servers, target)
      const next = Object.fromEntries(Object.entries(servers).filter(([name]) => name !== target.name))
      await this.commit(target.harness, file, this.render(target.harness, file, next, target.name))
    } finally { this.mutating = false }
  }
}
