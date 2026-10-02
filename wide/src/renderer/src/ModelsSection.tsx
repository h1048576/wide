import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Eye, Pencil, Plus, RefreshCw } from 'lucide-react'
import ModelEditor, { ModelDialog, type Editor } from './ModelDialog'
import ModelBatchDialog from './ModelBatchDialog'
import ModelList from './ModelList'
import HarnessSectionHeading from './HarnessSectionHeading'
import { displayHarnessPath } from './harnessPath'
import { DEFAULT_MODEL_BASE_URL, type CustomModel, type ModelBatchChange, type ModelDocument, type ModelFields, type ModelHarnessId, type ModelSource, type ModelTarget, type ModelsInventory } from '../../shared/types'

const harnesses: ModelHarnessId[] = ['claude', 'droid', 'dsh', 'pi', 'opencode']
const paths: Record<ModelHarnessId, string> = { claude: '~/.claude/settings.json', droid: '~/.factory/settings.json', dsh: '~/.dsh/profiles/{desktop,web}/cordis.patch.yml', pi: '~/.pi/agent/models.json', opencode: '~/.config/opencode/opencode.json' }
const messageOf = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(error)
export default function ModelsSection({ disabled, onBusyChange }: { disabled: boolean; onBusyChange: (busy: boolean) => void }) {
  const [inventory, setInventory] = useState<ModelsInventory>({ sources: [] })
  const [loading, setLoading] = useState(!!window.wide)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState<Partial<Record<ModelHarnessId, boolean>>>({})
  const [sectionOpen, setSectionOpen] = useState(true)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [batch, setBatch] = useState<{ action: ModelBatchChange['action']; returnFocus: HTMLElement | null } | null>(null)
  const [result, setResult] = useState('')
  const [preview, setPreview] = useState<{ harness: ModelHarnessId; document: ModelDocument; returnFocus: HTMLElement | null } | null>(null)
  const [operation, setOperation] = useState('')
  const mounted = useRef(true)
  const lock = useRef(false)
  const disabledRef = useRef(disabled)
  disabledRef.current = disabled
  const desktop = !!window.wide
  const locked = disabled || loading || !!operation
  const dialogOpen = !!editor || !!preview || !!batch

  async function refresh() {
    if (!window.wide) return
    try { const next = await window.wide.modelsInventory(); if (mounted.current) { setInventory(next); setError('') } }
    catch (error) { if (mounted.current) setError(messageOf(error)) }
    finally { if (mounted.current) setLoading(false) }
  }
  useEffect(() => {
    mounted.current = true; void refresh()
    const focus = () => { if (!lock.current && !disabledRef.current) void refresh() }
    window.addEventListener('focus', focus)
    return () => { mounted.current = false; window.removeEventListener('focus', focus) }
  }, [])

  function expandModels(open: boolean) {
    setExpanded(Object.fromEntries(harnesses.map(harness => [harness, open])))
    if (open) setSectionOpen(true)
  }

  async function edit(source: ModelSource, item?: CustomModel, copying = false) {
    if (locked || lock.current || dialogOpen || !source.editable) return
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setError('')
    if (!item) {
      setEditor({ source, returnFocus, detail: { fields: { model: '', name: '', ...(source.harness === 'droid' ? { provider: 'generic-chat-completion-api', baseUrl: DEFAULT_MODEL_BASE_URL } : {}), ...(source.harness === 'dsh' ? { baseUrl: source.baseUrl ?? DEFAULT_MODEL_BASE_URL, reasoningEfforts: { xhigh: 'high' } } : {}), ...(source.harness === 'pi' || source.harness === 'opencode' ? { baseUrl: source.baseUrl ?? DEFAULT_MODEL_BASE_URL } : {}) } } })
      return
    }
    const target: ModelTarget = { sourceId: source.id, index: item.index, revision: item.revision }
    lock.current = true; setOperation(`${copying ? 'copy' : 'edit'}:${source.id}:${item.index}`)
    try { const detail = await window.wide!.modelDetail(target); if (mounted.current) setEditor({ source, ...(copying ? { copyFrom: target } : { target }), detail, returnFocus }) }
    catch (error) { if (mounted.current) { await refresh(); setError(messageOf(error)) } }
    finally { lock.current = false; if (mounted.current) setOperation('') }
  }

  async function view(harness: ModelHarnessId, sources: ModelSource[]) {
    if (locked || lock.current || dialogOpen) return
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    lock.current = true; setOperation(`view:${harness}`); setError('')
    try {
      const previewSources = harness === 'dsh' ? [sources.find(source => source.editable) ?? sources[0]] : sources
      const documents = await Promise.all(previewSources.map(source => window.wide!.modelPreview(source.id)))
      const document = { paths: harness === 'dsh' ? [paths.dsh] : [...new Set(documents.flatMap(item => item.paths))], content: documents.map(item => item.content).join('\n\n') }
      if (mounted.current) setPreview({ harness, document, returnFocus })
    } catch (error) { if (mounted.current) setError(messageOf(error)) }
    finally { lock.current = false; if (mounted.current) setOperation('') }
  }

  async function save(fields: ModelFields, apiKey?: string) {
    if (!editor || locked || lock.current) throw new Error('操作正在执行，请稍后再试')
    lock.current = true; setOperation('save'); onBusyChange(true)
    let saved = false
    try {
      await window.wide!.modelSave({ sourceId: editor.source.id, target: editor.target, copyFrom: editor.copyFrom, fields, apiKey })
      await refresh()
      saved = true
    } finally {
      lock.current = false
      if (mounted.current) { setOperation(''); if (saved) setEditor(null) }
      onBusyChange(false)
    }
  }

  async function remove(source: ModelSource, item: CustomModel) {
    if (locked || lock.current || dialogOpen) return
    lock.current = true; setOperation(`delete:${source.id}:${item.index}`); setError(''); onBusyChange(true)
    try { await window.wide!.modelDelete({ sourceId: source.id, index: item.index, revision: item.revision }); await refresh() }
    catch (error) { if (mounted.current) setError(messageOf(error)) }
    finally { lock.current = false; if (mounted.current) setOperation(''); onBusyChange(false) }
  }

  function openBatch(action: ModelBatchChange['action']) {
    if (!desktop || locked || lock.current || dialogOpen) return
    setError(''); setResult('')
    setBatch({ action, returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null })
  }

  async function saveBatch(change: ModelBatchChange) {
    if (!batch || locked || lock.current) throw new Error('操作正在执行，请稍后再试')
    lock.current = true; setOperation('batch'); onBusyChange(true)
    try {
      const next = await window.wide!.modelBatch(change)
      await refresh()
      if (mounted.current) {
        setBatch(null)
        setResult(next.changed ? `已在 ${next.harnesses.join('、')} ${change.action === 'replace' ? '修改' : '添加'} ${next.changed} 个模型${next.skipped ? `，跳过 ${next.skipped} 个${change.action === 'add' ? '已包含该模型' : '未包含原模型'}的配置` : ''}。` : '所有配置均已包含该模型。')
      }
    } finally {
      lock.current = false
      if (mounted.current) setOperation('')
      onBusyChange(false)
    }
  }

  async function reorder(source: ModelSource, items: CustomModel[]) {
    if (locked || lock.current || dialogOpen) return
    lock.current = true; setOperation('reorder'); setError(''); onBusyChange(true)
    setInventory(current => ({ sources: current.sources.map(item => item.id === source.id ? { ...item, models: items } : item) }))
    let failure = ''
    try { await window.wide!.modelReorder({ sourceId: source.id, models: items.map(item => ({ sourceId: source.id, index: item.index, revision: item.revision })) }) }
    catch (error) { failure = messageOf(error); if (mounted.current) setInventory(current => ({ sources: current.sources.map(item => item.id === source.id ? source : item) })) }
    finally {
      await refresh(); lock.current = false
      if (mounted.current) { setOperation(''); if (failure) setError(failure) }
      onBusyChange(false)
    }
  }

  return <div className="harness-models">
    <HarnessSectionHeading title="Models" expanded={sectionOpen} contentId="harness-models-content" onToggle={() => setSectionOpen(current => !current)} onExpandAll={() => expandModels(true)} onCollapseAll={() => expandModels(false)} disabled={dialogOpen}>
      <button className="icon-button" aria-label="一键修改模型" title="一键修改模型" disabled={!desktop || locked || dialogOpen} onClick={() => openBatch('replace')}><Pencil size={15} /></button><button className="icon-button" aria-label="一键添加模型" title="一键添加模型" disabled={!desktop || locked || dialogOpen} onClick={() => openBatch('add')}><Plus size={15} /></button><button className="icon-button" aria-label="刷新 Models" title="刷新" disabled={!desktop || locked || dialogOpen} onClick={() => { setLoading(true); setResult(''); void refresh() }}><RefreshCw size={15} className={loading ? 'spin' : ''} /></button>
    </HarnessSectionHeading>
    {error && <p className="field-error model-error" role="alert">{error}</p>}
    {result && <p className="model-result" role="status">{result}</p>}
    <div id="harness-models-content" hidden={!sectionOpen}>
    {harnesses.map(harness => {
      const sources = inventory.sources.filter(source => source.harness === harness)
      const source = sources.find(item => item.editable) ?? sources[0]
      const pathLabel = harness === 'dsh' ? paths.dsh : displayHarnessPath(source?.path ?? paths[harness])
      const isOpen = !!expanded[harness]
      const count = sources.reduce((sum, item) => sum + item.models.length, 0)
      return <section key={harness} className="settings-group harness-models-group" aria-label={`${harness} models`}><div className="settings-list">
        <div className="setting-row harness-skills-header"><div className="harness-folder-label"><button className="harness-disclosure" aria-label={`${harness}，${count} 个模型`} aria-expanded={isOpen} aria-controls={`models-${harness}`} onClick={() => setExpanded(current => ({ ...current, [harness]: !current[harness] }))}><ChevronDown size={16} className={isOpen ? 'open' : ''} /><span>{harness}</span><span className="harness-count">{loading ? '…' : count}</span></button><p className="harness-path" title={pathLabel}>{pathLabel}</p></div>
          <div className="harness-actions"><button className="button secondary harness-action" aria-label={`${harness} 查看模型配置`} disabled={!desktop || locked || !source?.editable || dialogOpen} onClick={() => { void view(harness, sources) }}>{operation === `view:${harness}` ? <RefreshCw size={14} className="spin" /> : <Eye size={14} />}查看</button><button className="button secondary harness-action" aria-label={`${harness} 新增模型`} disabled={!desktop || locked || !source?.editable || dialogOpen} onClick={() => { if (source) void edit(source) }}><Plus size={14} />新增</button></div>
        </div>
        {isOpen && <div id={`models-${harness}`} className="harness-skill-list">
          {sources.map(item => <div key={item.id}>{sources.length > 1 && <p className="model-provider-label">{item.label}</p>}{item.error && <p className="field-error model-error" role="alert">{item.label}：{item.error}</p>}{item.models.length ? <ModelList source={item} disabled={locked || dialogOpen} operation={operation} onCopy={model => { void edit(item, model, true) }} onEdit={model => { void edit(item, model) }} onDelete={model => { void remove(item, model) }} onReorder={models => { void reorder(item, models) }} /> : <p className="harness-empty">{loading ? '正在读取模型…' : '暂无模型'}</p>}</div>)}
          {!sources.length && <p className="harness-empty">{loading ? '正在读取模型…' : '暂无模型'}</p>}
        </div>}
      </div></section>
    })}
    </div>
    {editor && <ModelEditor key={`${editor.source.id}:${editor.target?.revision ?? editor.copyFrom?.revision ?? 'new'}`} editor={editor} disabled={locked} onCancel={() => setEditor(null)} onSubmit={save} />}
    {batch && <ModelBatchDialog action={batch.action} disabled={locked} returnFocus={batch.returnFocus} onCancel={() => setBatch(null)} onSubmit={saveBatch} />}
    {preview && <ModelDialog title="查看模型配置" subtitle={preview.harness} disabled={false} returnFocus={preview.returnFocus} onCancel={() => setPreview(null)} className="model-config-preview"><div className="model-preview-paths">{preview.document.paths.map(path => <p key={path}>{displayHarnessPath(path)}</p>)}</div><pre tabIndex={0}>{preview.document.content}</pre><div className="harness-actions model-editor-actions"><button className="button primary" onClick={() => setPreview(null)}>确定</button></div></ModelDialog>}
  </div>
}
