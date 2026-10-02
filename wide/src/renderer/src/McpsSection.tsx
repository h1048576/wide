import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Copy, Eye, Pencil, Plus, Plug, RefreshCw, Trash2 } from 'lucide-react'
import HarnessSectionHeading, { HarnessExpandToggle } from './HarnessSectionHeading'
import { ModelDialog } from './ModelDialog'
import McpEditorDialog, { type McpEditor } from './McpDialog'
import { displayHarnessPath } from './harnessPath'
import type { McpDocument, McpFields, McpHarnessId, McpServer, McpSource, McpTarget, McpsInventory } from '../../shared/types'

const ids: McpHarnessId[] = ['claude', 'codex']
const paths: Record<McpHarnessId, string> = { claude: '~/.claude.json', codex: '~/.codex/config.toml' }
const messageOf = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(error)
export default function McpsSection({ defaultCollapsed, disabled, onBusyChange }: { defaultCollapsed: boolean; disabled: boolean; onBusyChange: (busy: boolean) => void }) {
  const [inventory, setInventory] = useState<McpsInventory>({ sources: [] })
  const [loading, setLoading] = useState(!!window.wide)
  const [error, setError] = useState('')
  const [sectionOpen, setSectionOpen] = useState(!defaultCollapsed)
  const [expanded, setExpanded] = useState<Partial<Record<McpHarnessId, boolean>>>({})
  const [editor, setEditor] = useState<McpEditor | null>(null)
  const [preview, setPreview] = useState<{ harness: McpHarnessId; document: McpDocument; returnFocus: HTMLElement | null } | null>(null)
  const [operation, setOperation] = useState('')
  const mounted = useRef(true)
  const lock = useRef(false)
  const disabledRef = useRef(disabled)
  disabledRef.current = disabled
  const desktop = !!window.wide
  const locked = disabled || loading || !!operation
  const dialogOpen = !!editor || !!preview
  const dialogRef = useRef(dialogOpen)
  dialogRef.current = dialogOpen
  const allExpanded = sectionOpen && ids.every(id => expanded[id])
  async function refresh(id?: McpHarnessId) {
    if (!window.wide) return
    try {
      if (id) {
        const source = await window.wide.mcpsRefresh(id)
        if (mounted.current) setInventory(current => ({ sources: ids.map(harness => harness === id ? source : current.sources.find(item => item.harness === harness)!).filter(Boolean) }))
      } else {
        const next = await window.wide.mcpsInventory()
        if (mounted.current) setInventory(next)
      }
      if (mounted.current) setError('')
    } catch (error) { if (mounted.current) setError(messageOf(error)) }
    finally { if (mounted.current) setLoading(false) }
  }
  useEffect(() => {
    mounted.current = true; void refresh()
    const focus = () => { if (!lock.current && !disabledRef.current && !dialogRef.current) void refresh() }
    window.addEventListener('focus', focus)
    return () => { mounted.current = false; window.removeEventListener('focus', focus) }
  }, [])
  function expandAll(open: boolean) { setExpanded(Object.fromEntries(ids.map(id => [id, open]))); if (open) setSectionOpen(true) }
  const focusBack = () => document.activeElement instanceof HTMLElement ? document.activeElement : null
  const targetOf = (source: McpSource, item: McpServer): McpTarget => ({ harness: source.harness, name: item.name, revision: item.revision })
  async function edit(source: McpSource, item?: McpServer, copying = false) {
    if (locked || lock.current || dialogOpen || !source.editable) return
    const returnFocus = focusBack()
    setError('')
    if (!item) {
      setEditor({ source, returnFocus, fields: { name: '', transport: 'stdio', command: '', args: [], env: {}, url: '', headers: {}, cwd: '', bearerTokenEnvVar: '', envHeaders: {} } }); return
    }
    const target = targetOf(source, item)
    lock.current = true; setOperation(`${copying ? 'copy' : 'edit'}:${source.harness}:${item.name}`)
    try {
      const fields = await window.wide!.mcpDetail(target)
      if (mounted.current) setEditor({ source, fields: copying ? { ...fields, name: `${fields.name}-copy` } : fields, returnFocus, ...(copying ? { copyFrom: target } : { target }) })
    } catch (error) { if (mounted.current) { await refresh(); setError(messageOf(error)) } }
    finally { lock.current = false; if (mounted.current) setOperation('') }
  }
  async function view(source: McpSource) {
    if (locked || lock.current || dialogOpen) return
    const returnFocus = focusBack()
    lock.current = true; setOperation(`view:${source.harness}`); setError('')
    try { const document = await window.wide!.mcpPreview(source.harness); if (mounted.current) setPreview({ harness: source.harness, document, returnFocus }) }
    catch (error) { if (mounted.current) setError(messageOf(error)) }
    finally { lock.current = false; if (mounted.current) setOperation('') }
  }
  async function save(fields: McpFields) {
    if (!editor || locked || lock.current) throw new Error('操作正在执行，请稍后再试')
    lock.current = true; setOperation('save'); onBusyChange(true)
    let saved = false
    try { await window.wide!.mcpSave({ harness: editor.source.harness, target: editor.target, copyFrom: editor.copyFrom, fields }); await refresh(); saved = true }
    finally { lock.current = false; if (mounted.current) { setOperation(''); if (saved) setEditor(null) } onBusyChange(false) }
  }
  async function remove(source: McpSource, item: McpServer) {
    if (locked || lock.current || dialogOpen) return
    lock.current = true; setOperation(`delete:${source.harness}:${item.name}`); setError(''); onBusyChange(true)
    try { await window.wide!.mcpDelete(targetOf(source, item)); await refresh() }
    catch (error) { if (mounted.current) setError(messageOf(error)) }
    finally { lock.current = false; if (mounted.current) setOperation(''); onBusyChange(false) }
  }
  return <div className="harness-mcps">
    <HarnessSectionHeading title="MCPs" expanded={sectionOpen} contentId="harness-mcps-content" onToggle={() => setSectionOpen(current => !current)} disabled={dialogOpen}>
      <HarnessExpandToggle title="MCPs" expanded={allExpanded} disabled={dialogOpen} onToggle={() => expandAll(!allExpanded)} />
      <button className="icon-button" aria-label="刷新 MCPs" title="刷新" disabled={!desktop || locked || dialogOpen} onClick={() => { setLoading(true); void refresh() }}><RefreshCw size={15} className={loading ? 'spin' : ''} /></button>
    </HarnessSectionHeading>
    {error && <p className="field-error model-error" role="alert">{error}</p>}
    <div id="harness-mcps-content" hidden={!sectionOpen}>
      {ids.map(id => {
        const source = inventory.sources.find(item => item.harness === id)
        const servers = source?.servers ?? [], path = displayHarnessPath(source?.path ?? paths[id]), open = !!expanded[id]
        return <section key={id} className="settings-group harness-mcps-group" aria-label={`${id} mcps`}><div className="settings-list">
          <div className="setting-row harness-skills-header"><div className="harness-folder-label"><button className="harness-disclosure" aria-label={`${id}，${servers.length} 个 MCP`} aria-expanded={open} aria-controls={`mcps-${id}`} onClick={() => setExpanded(current => ({ ...current, [id]: !current[id] }))}><ChevronDown size={16} className={open ? 'open' : ''} /><span>{id}</span><span className="harness-count">{loading ? '…' : servers.length}</span></button><p className="harness-path" title={path}>{path}</p></div>
            <div className="harness-actions"><button className="button secondary harness-action" aria-label={`${id} 查看 MCP 配置`} disabled={!desktop || locked || !source?.editable || dialogOpen} onClick={() => { if (source) void view(source) }}><Eye size={14} />查看</button><button className="button secondary harness-action" aria-label={`${id} 新增 MCP`} disabled={!desktop || locked || !source?.editable || dialogOpen} onClick={() => { if (source) void edit(source) }}><Plus size={14} />新增</button><button className="icon-button" aria-label={`${id} 刷新 MCPs`} title="刷新" disabled={!desktop || locked || dialogOpen} onClick={() => { setLoading(true); void refresh(id) }}><RefreshCw size={15} /></button></div>
          </div>
          {open && <div id={`mcps-${id}`} className="harness-skill-list">{servers.length ? servers.map(item => <div key={item.name} className="setting-row harness-skill-row"><div className="harness-skill-name"><Plug size={15} /><div><span>{item.name}</span><small>{item.transport.toUpperCase()}{item.description ? ` · ${item.description}` : ''}</small></div></div><div className="harness-actions"><button className="button secondary harness-action" disabled={locked || dialogOpen} aria-label={`${id} ${item.name} 修改 MCP`} onClick={() => { if (source) void edit(source, item) }}><Pencil size={14} />修改</button><button className="button secondary harness-action" disabled={locked || dialogOpen} aria-label={`${id} ${item.name} 复制 MCP`} onClick={() => { if (source) void edit(source, item, true) }}><Copy size={14} />复制</button><button className="button secondary harness-action harness-delete" disabled={locked || dialogOpen} aria-label={`${id} ${item.name} 删除 MCP`} onClick={() => { if (source) void remove(source, item) }}><Trash2 size={14} />删除</button></div></div>) : <p className="harness-empty">{loading ? '正在读取 MCP…' : '暂无 MCP'}</p>}</div>}
        </div>{source?.error && <p className="field-error model-error" role="alert">{source.error}</p>}</section>
      })}
    </div>
    {editor && <McpEditorDialog editor={editor} disabled={locked} onCancel={() => setEditor(null)} onSubmit={save} />}
    {preview && <ModelDialog title="查看 MCP 配置" subtitle={preview.harness} disabled={false} returnFocus={preview.returnFocus} onCancel={() => setPreview(null)} closeLabel="关闭 MCP 预览" className="model-config-preview"><div className="model-preview-paths"><p>{displayHarnessPath(preview.document.path)}</p></div><pre tabIndex={0} data-format={preview.document.format}>{preview.document.content}</pre><div className="harness-actions model-editor-actions"><button className="button primary" onClick={() => setPreview(null)}>确定</button></div></ModelDialog>}
  </div>
}
