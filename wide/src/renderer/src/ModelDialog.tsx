import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { EditableSelectControl, SelectControl } from './DropdownControl'
import { DEFAULT_MODEL_BASE_URL, type ModelDetail, type ModelFields, type ModelSource, type ModelTarget } from '../../shared/types'

export type Editor = { source: ModelSource; target?: ModelTarget; copyFrom?: ModelTarget; detail: ModelDetail; returnFocus: HTMLElement | null }
const apiOptions = [DEFAULT_MODEL_BASE_URL, `${DEFAULT_MODEL_BASE_URL}/v1`].map(value => ({ value, label: value }))
const messageOf = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(error)

export function ModelDialog({ title, subtitle, disabled, returnFocus, onCancel, children, className = '', closeLabel = '关闭模型弹窗', descriptionId = 'model-modal-source' }: {
  title: string; subtitle: string; disabled: boolean; returnFocus: HTMLElement | null; onCancel: () => void; children: ReactNode; className?: string; closeLabel?: string; descriptionId?: string
}) {
  const dialog = useRef<HTMLElement>(null)
  const focusBack = useRef(returnFocus)
  useEffect(() => {
    const root = document.getElementById('root'), previouslyInert = root?.inert ?? false
    if (root) root.inert = true
    const first = dialog.current?.querySelector<HTMLElement>('[data-dialog-initial-focus="true"]:not(:disabled)') ?? dialog.current?.querySelector<HTMLElement>('input:not(:disabled)') ?? dialog.current?.querySelector<HTMLElement>('button:not(:disabled)')
    first?.focus()
    return () => { if (root) root.inert = previouslyInert; focusBack.current?.focus() }
  }, [])
  return createPortal(<div className="model-modal-backdrop" onClick={event => { if (event.target === event.currentTarget && !disabled) onCancel() }} onKeyDown={event => {
    if (event.key === 'Escape' && !event.defaultPrevented && !event.nativeEvent.isComposing && !disabled) { event.preventDefault(); onCancel(); return }
    if (event.key !== 'Tab') return
    const focusable = [...dialog.current!.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]')].filter(element => element.getClientRects().length > 0)
    const first = focusable[0], last = focusable.at(-1)
    if (event.shiftKey && document.activeElement === first || !event.shiftKey && document.activeElement === last) { event.preventDefault(); (event.shiftKey ? last : first)?.focus() }
  }}><section ref={dialog} className={`model-modal ${className}`} role="dialog" aria-modal="true" aria-labelledby="model-modal-title" aria-describedby={descriptionId}>
    <header className="model-modal-header"><div><h2 id="model-modal-title">{title}</h2><p id="model-modal-source">{subtitle}</p></div><button className="icon-button" type="button" aria-label={closeLabel} disabled={disabled} onClick={onCancel}><X size={18} /></button></header>{children}
  </section></div>, document.body)
}

export default function ModelEditor({ editor, disabled, onCancel, onSubmit }: {
  editor: Editor; disabled: boolean; onCancel: () => void; onSubmit: (fields: ModelFields, apiKey?: string) => Promise<void>
}) {
  const [fields, setFields] = useState(editor.detail.fields)
  const [apiKey, setApiKey] = useState(editor.detail.apiKey ?? '')
  const [reasoning, setReasoning] = useState(() => Object.entries(editor.detail.fields.reasoningEfforts || {}).map(([key, value]) => ({ key, value })))
  const [error, setError] = useState('')
  const submitting = useRef(false)
  const harness = editor.source.harness
  const prefix = `model-editor-${harness}`
  const update = <K extends keyof ModelFields>(key: K, value: ModelFields[K]) => setFields(current => ({ ...current, [key]: value }))
  const row = (label: string, id: string, control: ReactNode) => <div className="setting-row model-editor-row"><label className="setting-label" htmlFor={`${prefix}-${id}`}>{label}</label><div className="setting-value">{control}</div></div>
  const text = (key: 'model' | 'description', label: string) => row(label, key, <input id={`${prefix}-${key}`} className="field-input model-text-input" value={fields[key] ?? ''} disabled={disabled} required={key === 'model'} autoComplete="off" spellCheck={false} onChange={event => update(key, event.target.value)} />)
  const title = editor.target ? '修改模型' : editor.copyFrom ? '复制模型' : '新增模型'
  return <ModelDialog title={title} subtitle={harness} disabled={disabled} returnFocus={editor.returnFocus} onCancel={onCancel}>
    <form className="model-editor" aria-label={`${harness} ${title}`} onSubmit={event => {
      event.preventDefault()
      if (disabled || submitting.current) return
      let next = fields
      if (harness === 'dsh') {
        const entries = reasoning.filter(item => item.key.trim() || item.value)
        if (entries.some(item => !item.key.trim() || ['__proto__', 'constructor', 'prototype'].includes(item.key.trim()))) { setError('请填写有效的思考级别 key'); return }
        if (new Set(entries.map(item => item.key.trim())).size !== entries.length) { setError('思考级别的 key 不能重复'); return }
        next = { ...fields, reasoningEfforts: entries.length ? Object.fromEntries(entries.map(item => [item.key.trim(), item.value])) : fields.reasoningEfforts === false ? false : undefined }
      }
      submitting.current = true; setError('')
      void onSubmit(next, harness === 'droid' ? apiKey : undefined).catch(error => setError(messageOf(error))).finally(() => { submitting.current = false })
    }}><div className="model-editor-fields">
      {text('model', '模型 ID')}
      {row('名称', 'name', <div className="model-name-control"><input id={`${prefix}-name`} className="field-input model-text-input" value={fields.name} disabled={disabled} autoComplete="off" spellCheck={false} onChange={event => update('name', event.target.value)} /><button className="icon-button model-name-refresh" type="button" title="从模型 ID 生成名称" aria-label="从模型 ID 生成名称" disabled={disabled || !fields.model.trim()} onClick={() => update('name', fields.model.trim().split('/').at(-1)!.replace(/\[1m\]/gi, '').trim())}><RefreshCw size={15} /></button></div>)}
      {harness === 'claude' && text('description', '描述')}
      {harness === 'droid' && row('Provider', 'provider', <SelectControl id={`${prefix}-provider`} label="模型 Provider" value={fields.provider ?? 'generic-chat-completion-api'} disabled={disabled} onChange={value => update('provider', value)} options={[
        { value: 'generic-chat-completion-api', label: 'OpenAI 兼容' }, { value: 'openai', label: 'OpenAI' }, { value: 'anthropic', label: 'Anthropic' }
      ]} />)}
      {harness !== 'claude' && row('API 地址', 'baseUrl', <EditableSelectControl id={`${prefix}-baseUrl`} label="模型 API 地址" value={fields.baseUrl ?? DEFAULT_MODEL_BASE_URL} disabled={disabled} options={apiOptions} onChange={value => update('baseUrl', value)} />)}
      {harness === 'droid' && row('API Key', 'apiKey', <input id={`${prefix}-apiKey`} type="text" className="field-input model-text-input" value={apiKey} disabled={disabled} autoComplete="off" spellCheck={false} onChange={event => setApiKey(event.target.value)} />)}
      {harness === 'dsh' && <section className="model-reasoning" aria-label="思考级别"><div className="model-reasoning-header"><span>思考级别</span><button className="icon-button" type="button" title="增加思考级别" aria-label="增加思考级别" disabled={disabled} onClick={() => setReasoning(current => [...current, { key: '', value: '' }])}><Plus size={14} /></button></div><div className="model-reasoning-rows">
        {reasoning.map((item, index) => <div className="model-reasoning-row" key={index}>
          <div className="model-reasoning-key"><input className="field-input" aria-label={`思考级别 key ${index + 1}`} value={item.key} disabled={disabled} autoComplete="off" spellCheck={false} onChange={event => setReasoning(current => current.map((entry, i) => i === index ? { ...entry, key: event.target.value } : entry))} /><span className="model-reasoning-arrow" aria-hidden="true">{'->'}</span></div>
          <div className="model-reasoning-value"><input className="field-input" aria-label={`思考级别 value ${index + 1}`} value={item.value ?? ''} disabled={disabled} autoComplete="off" spellCheck={false} onChange={event => setReasoning(current => current.map((entry, i) => i === index ? { ...entry, value: event.target.value } : entry))} /><button className="icon-button" type="button" aria-label={`删除思考级别 ${index + 1}`} disabled={disabled} onClick={() => setReasoning(current => current.filter((_, i) => i !== index))}><Trash2 size={14} /></button></div>
        </div>)}
      </div></section>}
      {error && <p className="field-error model-error" role="alert">{error}</p>}
    </div><div className="harness-actions model-editor-actions"><button className="button secondary" type="button" disabled={disabled} onClick={onCancel}>取消</button><button className="button primary" type="submit" disabled={disabled}>{disabled && <RefreshCw size={14} className="spin" />}确定</button></div></form>
  </ModelDialog>
}
