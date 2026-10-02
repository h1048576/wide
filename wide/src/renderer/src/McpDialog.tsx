import { useRef, useState, type ReactNode } from 'react'
import { Plus, RefreshCw, Trash2 } from 'lucide-react'
import { ModelDialog } from './ModelDialog'
import { SelectControl } from './DropdownControl'
import type { McpFields, McpSource, McpTarget, McpTransport } from '../../shared/types'

export type McpEditor = { source: McpSource; fields: McpFields; target?: McpTarget; copyFrom?: McpTarget; returnFocus: HTMLElement | null }
type Pair = { key: string; value: string }
const messageOf = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(error)
function pairsMap(pairs: Pair[], label: string) {
  const entries = pairs.filter(item => item.key || item.value)
  if (entries.some(item => !item.key.trim())) throw new Error(`请填写${label}的名称`)
  if (new Set(entries.map(item => item.key)).size !== entries.length) throw new Error(`${label}的名称不能重复`)
  return Object.fromEntries(entries.map(item => [item.key, item.value]))
}
function PairFields({ label, pairs, disabled, onChange }: { label: string; pairs: Pair[]; disabled: boolean; onChange: (pairs: Pair[]) => void }) {
  return <section className="model-reasoning mcp-pairs" aria-label={label}><div className="model-reasoning-header"><span>{label}</span><button className="icon-button" type="button" aria-label={`增加${label}`} title={`增加${label}`} disabled={disabled} onClick={() => onChange([...pairs, { key: '', value: '' }])}><Plus size={14} /></button></div><div className="model-reasoning-rows">
    {pairs.map((pair, index) => <div className="model-reasoning-row" key={index}><div className="model-reasoning-key"><input className="field-input" aria-label={`${label}名称 ${index + 1}`} value={pair.key} disabled={disabled} autoComplete="off" spellCheck={false} onChange={event => onChange(pairs.map((item, i) => i === index ? { ...item, key: event.target.value } : item))} /><span className="model-reasoning-arrow" aria-hidden="true">{'->'}</span></div><div className="model-reasoning-value"><input className="field-input" aria-label={`${label}值 ${index + 1}`} value={pair.value} disabled={disabled} autoComplete="off" spellCheck={false} onChange={event => onChange(pairs.map((item, i) => i === index ? { ...item, value: event.target.value } : item))} /><button className="icon-button" type="button" aria-label={`删除${label} ${index + 1}`} disabled={disabled} onClick={() => onChange(pairs.filter((_, i) => i !== index))}><Trash2 size={14} /></button></div></div>)}
  </div></section>
}

export default function McpEditorDialog({ editor, disabled, onCancel, onSubmit }: { editor: McpEditor; disabled: boolean; onCancel: () => void; onSubmit: (fields: McpFields) => Promise<void> }) {
  const [fields, setFields] = useState(editor.fields)
  const [env, setEnv] = useState(() => Object.entries(fields.env).map(([key, value]) => ({ key, value })))
  const [headers, setHeaders] = useState(() => Object.entries(fields.headers).map(([key, value]) => ({ key, value })))
  const [envHeaders, setEnvHeaders] = useState(() => Object.entries(fields.envHeaders).map(([key, value]) => ({ key, value })))
  const [error, setError] = useState('')
  const submitting = useRef(false)
  const title = editor.target ? '修改 MCP' : editor.copyFrom ? '复制 MCP' : '新增 MCP'
  const prefix = `mcp-editor-${editor.source.harness}`
  const update = <K extends keyof McpFields>(key: K, value: McpFields[K]) => setFields(current => ({ ...current, [key]: value }))
  const row = (label: string, key: string, control: ReactNode) => <div className="setting-row model-editor-row"><label className="setting-label" htmlFor={`${prefix}-${key}`}>{label}</label><div className="setting-value">{control}</div></div>
  const text = (key: 'name' | 'command' | 'url' | 'cwd' | 'bearerTokenEnvVar', label: string, required = false) => row(label, key, <input id={`${prefix}-${key}`} className="field-input model-text-input" value={fields[key]} disabled={disabled} required={required} autoComplete="off" spellCheck={false} onChange={event => update(key, event.target.value)} />)
  return <ModelDialog title={title} subtitle={editor.source.harness} disabled={disabled} returnFocus={editor.returnFocus} onCancel={onCancel} closeLabel="关闭 MCP 弹窗" className="mcp-modal">
    <form className="model-editor" aria-label={`${editor.source.harness} ${title}`} onSubmit={event => {
      event.preventDefault()
      if (disabled || submitting.current) return
      let next: McpFields
      try { next = { ...fields, env: pairsMap(env, '环境变量'), headers: pairsMap(headers, '请求头'), envHeaders: pairsMap(envHeaders, '请求头环境变量') } }
      catch (error) { setError(messageOf(error)); return }
      submitting.current = true; setError('')
      void onSubmit(next).catch(error => setError(messageOf(error))).finally(() => { submitting.current = false })
    }}><div className="model-editor-fields">
      {text('name', '名称', true)}
      {row('传输方式', 'transport', <SelectControl id={`${prefix}-transport`} label="MCP 传输方式" value={fields.transport} disabled={disabled} onChange={value => update('transport', value as McpTransport)} options={[
        { value: 'stdio', label: 'STDIO' }, { value: 'http', label: 'HTTP' }, ...(editor.source.harness === 'claude' ? [{ value: 'sse', label: 'SSE' }, { value: 'ws', label: 'WebSocket' }] : [])
      ]} />)}
      {fields.transport === 'stdio' ? <>
        {text('command', '启动命令', true)}
        {editor.source.harness === 'codex' && text('cwd', '工作目录')}
        <section className="model-reasoning" aria-label="启动参数"><div className="model-reasoning-header"><span>启动参数</span><button className="icon-button" type="button" aria-label="增加启动参数" title="增加启动参数" disabled={disabled} onClick={() => update('args', [...fields.args, ''])}><Plus size={14} /></button></div><div className="model-reasoning-rows">
          {fields.args.map((arg, index) => <div className="mcp-arg-row" key={index}><input className="field-input model-text-input" aria-label={`启动参数 ${index + 1}`} value={arg} disabled={disabled} autoComplete="off" spellCheck={false} onChange={event => update('args', fields.args.map((value, i) => i === index ? event.target.value : value))} /><button className="icon-button" type="button" aria-label={`删除启动参数 ${index + 1}`} disabled={disabled} onClick={() => update('args', fields.args.filter((_, i) => i !== index))}><Trash2 size={14} /></button></div>)}
        </div></section>
        <PairFields label="环境变量" pairs={env} disabled={disabled} onChange={setEnv} />
      </> : <>
        {text('url', '地址', true)}
        {editor.source.harness === 'codex' && text('bearerTokenEnvVar', 'Token 环境变量')}
        <PairFields label="请求头" pairs={headers} disabled={disabled} onChange={setHeaders} />
        {editor.source.harness === 'codex' && <PairFields label="请求头环境变量" pairs={envHeaders} disabled={disabled} onChange={setEnvHeaders} />}
      </>}
      {error && <p className="field-error model-error" role="alert">{error}</p>}
    </div><div className="harness-actions model-editor-actions"><button className="button secondary" type="button" disabled={disabled} onClick={onCancel}>取消</button><button className="button primary" type="submit" disabled={disabled}>{disabled && <RefreshCw size={14} className="spin" />}确定</button></div></form>
  </ModelDialog>
}
