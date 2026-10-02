import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, CircleAlert, Copy, Eye, FileText, RefreshCw, Trash2, X } from 'lucide-react'
import { HARNESSES, type HarnessDocument, type HarnessId, type HarnessInventory, type HarnessOperationResult } from '../../shared/types'
import ModelsSection from './ModelsSection'

const messageOf = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(error)
const emptyInventory: HarnessInventory = {
  agentsSource: { path: '~/.claude/CLAUDE.md', exists: false },
  harnesses: HARNESSES.map(harness => ({ id: harness.id, name: harness.name, path: `~/${harness.directory}`, skillsPath: `~/${harness.directory}/skills`, exists: false, skills: [] }))
}

export default function HarnessPage({ disabled, onBusyChange, onNotice }: {
  disabled: boolean
  onBusyChange: (busy: boolean) => void
  onNotice: (text: string, error?: boolean) => void
}) {
  const [inventory, setInventory] = useState<HarnessInventory>(emptyInventory)
  const [loading, setLoading] = useState(!!window.wide)
  const [loadError, setLoadError] = useState('')
  const [expanded, setExpanded] = useState<Partial<Record<HarnessId, boolean>>>({})
  const [operation, setOperation] = useState<string | null>(null)
  const [document, setDocument] = useState<HarnessDocument | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [result, setResult] = useState<HarnessOperationResult | null>(null)
  const mounted = useRef(true)
  const operationLock = useRef(false)
  const closePreview = useRef<HTMLButtonElement>(null)
  const previewButton = useRef<HTMLButtonElement>(null)
  const desktop = !!window.wide
  const locked = disabled || loading || !!operation

  async function refresh() {
    if (!window.wide) return
    try {
      const next = await window.wide.harnessInventory()
      if (mounted.current) { setInventory(next); setLoadError('') }
    } catch (error) { if (mounted.current) setLoadError(messageOf(error)) }
    finally { if (mounted.current) setLoading(false) }
  }
  useEffect(() => {
    mounted.current = true
    void refresh()
    const onFocus = () => { if (!operationLock.current) void refresh() }
    window.addEventListener('focus', onFocus)
    return () => { mounted.current = false; window.removeEventListener('focus', onFocus) }
  }, [])
  useEffect(() => {
    if (!document) return
    closePreview.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setDocument(null); previewButton.current?.focus() }
      // 预览只有一个交互按钮，让键盘焦点留在弹层中。
      if (event.key === 'Tab') { event.preventDefault(); closePreview.current?.focus() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [document])

  async function preview() {
    if (!window.wide || previewing) return
    setPreviewing(true)
    try { const next = await window.wide.harnessPreviewAgents(); if (mounted.current) setDocument(next) }
    catch (error) { onNotice(messageOf(error), true) }
    finally { if (mounted.current) setPreviewing(false) }
  }

  async function run(key: string, action: () => Promise<HarnessOperationResult>, options: { quiet?: boolean } = {}) {
    if (operationLock.current || disabled) return
    operationLock.current = true
    setOperation(key); setResult(null); onBusyChange(true)
    try {
      const next = await action()
      if (mounted.current) setResult(options.quiet && next.success ? null : next)
      if (!options.quiet) onNotice(next.message, !next.success)
    } catch (error) {
      const message = messageOf(error)
      if (mounted.current) setResult({ success: false, completed: 0, failed: 1, message })
      if (!options.quiet) onNotice(message, true)
    } finally {
      await refresh()
      operationLock.current = false
      if (mounted.current) setOperation(null)
      onBusyChange(false)
    }
  }

  function skillActions(id: HarnessId, count: number, skillId?: string, available = true) {
    if (id !== 'claude' && id !== 'agents' && skillId === undefined) return null
    const scope = `${id}:${skillId ?? 'all'}`
    const target = id === 'claude' ? 'agents' : 'claude'
    const name = skillId ? `技能 ${skillId}` : `${HARNESSES.find(item => item.id === id)!.name} 的全部 ${count} 个技能`
    return <div className="harness-actions">
      {(id === 'claude' || id === 'agents') && <button className="button secondary harness-action" disabled={!desktop || locked || !count || !available} title={`将${name}复制到 ${target}，同名技能会替换并将旧版本移到回收站`} aria-label={`${name}，同步${target}`} onClick={() => { void run(`sync:${scope}`, () => window.wide!.harnessSyncSkills(id, skillId)) }}>{operation === `sync:${scope}` ? <RefreshCw size={14} className="spin" /> : <Copy size={14} />}{`同步${target}`}</button>}
      {skillId !== undefined && <button className="button secondary harness-action harness-delete" disabled={!desktop || locked || !count} title={`将${name}移到回收站`} aria-label={`${name}，删除`} onClick={() => { void run(`delete:${scope}`, () => window.wide!.harnessDeleteSkills(id, skillId), { quiet: true }) }}>{operation === `delete:${scope}` ? <RefreshCw size={14} className="spin" /> : <Trash2 size={14} />}删除</button>}
    </div>
  }

  return <div className="settings-page harness-page">
    {loadError && <div className="error-banner" role="alert">读取 Harness 失败：{loadError}</div>}
    <section className="settings-group" aria-label="AGENTS.md 管理"><h2>指令</h2><div className="settings-list">
      <div className="setting-row harness-document-row"><div className="setting-label"><span className="setting-name">AGENTS.md</span><span className="setting-description harness-path" title={inventory.agentsSource.path}>{inventory.agentsSource.path}</span></div><div className="harness-actions">
        <button ref={previewButton} className="button secondary" disabled={!desktop || locked || previewing || !inventory.agentsSource.exists} onClick={() => { void preview() }}>{previewing ? <RefreshCw size={14} className="spin" /> : <Eye size={14} />}预览</button>
        <button className="button primary" disabled={!desktop || locked || !inventory.agentsSource.exists} onClick={() => { void run('agents', () => window.wide!.harnessSyncAgents()) }}>{operation === 'agents' ? <RefreshCw size={14} className="spin" /> : <Copy size={14} />}同步</button>
      </div></div>
    </div><p className="operation-note">以 Claude 的 CLAUDE.md 为源文件，同步为 .factory、.codex、.agents、.dsh 下的 AGENTS.md。{desktop && !loading && !inventory.agentsSource.exists ? '源文件未找到。' : ''}</p></section>
    <div className="harness-section-heading"><h2>Skills</h2><button className="icon-button" aria-label="刷新 Harness" title="刷新" disabled={!desktop || locked} onClick={() => { setLoading(true); void refresh() }}><RefreshCw size={15} className={loading ? 'spin' : ''} /></button></div>
    {inventory.harnesses.map(harness => <section key={harness.id} className="settings-group harness-skills-group" aria-label={`${harness.name} skills`}>
      <div className="settings-list">
        <div className="setting-row harness-skills-header"><div className="harness-folder-label"><button className="harness-disclosure" aria-label={`${harness.name}，${harness.skills.length} 个技能`} aria-expanded={!!expanded[harness.id]} aria-controls={`skills-${harness.id}`} onClick={() => setExpanded(current => ({ ...current, [harness.id]: !current[harness.id] }))}><ChevronDown size={16} className={expanded[harness.id] ? 'open' : ''} /><span>{harness.name}</span><span className="harness-count">{loading ? '…' : harness.skills.length}</span></button><p className="harness-path" title={harness.skillsPath}>{harness.skillsPath}</p></div>{skillActions(harness.id, harness.skills.length)}</div>
        {expanded[harness.id] && <div id={`skills-${harness.id}`} className="harness-skill-list">
          {harness.skills.length ? harness.skills.map(skill => <div className="setting-row harness-skill-row" key={skill.id}><div className="harness-skill-name" title={skill.path}><FileText size={15} /><div><span>{skill.name}</span>{skill.id !== skill.name && <small>{skill.id}</small>}{!skill.available && <small className="harness-broken">链接已失效</small>}</div></div>{skillActions(harness.id, 1, skill.id, skill.available)}</div>) : <p className="harness-empty">{harness.error ? '读取失败，请检查目录权限。' : loading ? '正在读取技能…' : '暂无技能'}</p>}
        </div>}
      </div>{harness.error && <p className="field-error detection-error" role="alert">{harness.error}</p>}
    </section>)}
    <ModelsSection disabled={locked} onBusyChange={onBusyChange} />
    {result && <div className={`harness-result ${result.success ? 'success' : 'error'}`} role="status">{result.success ? <Check size={16} /> : <CircleAlert size={16} />}<span>{result.message}</span></div>}
    {document && <div className="harness-preview-backdrop" onClick={event => { if (event.target === event.currentTarget) { setDocument(null); previewButton.current?.focus() } }}><section className="harness-preview" role="dialog" aria-modal="true" aria-labelledby="harness-preview-title" aria-describedby="harness-preview-path"><header><div><h2 id="harness-preview-title">AGENTS.md 预览</h2><p id="harness-preview-path">{document.path}</p></div><button ref={closePreview} className="icon-button" aria-label="关闭预览" onClick={() => { setDocument(null); previewButton.current?.focus() }}><X size={18} /></button></header><pre>{document.content || '（空文件）'}</pre></section></div>}
  </div>
}
