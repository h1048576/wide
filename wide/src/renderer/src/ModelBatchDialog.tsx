import { useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { ModelDialog } from './ModelDialog'
import type { ModelBatchChange } from '../../shared/types'

export default function ModelBatchDialog({ action, disabled, returnFocus, onCancel, onSubmit }: {
  action: ModelBatchChange['action']; disabled: boolean; returnFocus: HTMLElement | null; onCancel: () => void; onSubmit: (change: ModelBatchChange) => Promise<void>
}) {
  const [originalModel, setOriginalModel] = useState('')
  const [model, setModel] = useState('')
  const [error, setError] = useState('')
  const submitting = useRef(false)
  const title = action === 'replace' ? '一键修改模型' : '一键添加模型'
  const row = (label: string, id: string, value: string, onChange: (value: string) => void) => <div className="setting-row model-editor-row"><label className="setting-label" htmlFor={id}>{label}</label><div className="setting-value"><input id={id} className="field-input model-text-input" value={value} required disabled={disabled} autoComplete="off" spellCheck={false} onChange={event => onChange(event.target.value)} /></div></div>
  return <ModelDialog title={title} subtitle="Models" disabled={disabled} returnFocus={returnFocus} onCancel={onCancel}>
    <form className="model-editor" aria-label={title} onSubmit={event => {
      event.preventDefault()
      if (disabled || submitting.current) return
      submitting.current = true; setError('')
      void onSubmit({ action, model, ...(action === 'replace' ? { originalModel } : {}) }).catch(error => setError(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(error))).finally(() => { submitting.current = false })
    }}><div className="model-editor-fields">
      {action === 'replace' && row('原模型', 'batch-original-model', originalModel, setOriginalModel)}
      {row('新模型', 'batch-new-model', model, setModel)}
      {error && <p className="field-error model-error" role="alert">{error}</p>}
    </div><div className="harness-actions model-editor-actions"><button className="button secondary" type="button" disabled={disabled} onClick={onCancel}>取消</button><button className="button primary" type="submit" disabled={disabled}>{disabled && <RefreshCw size={14} className="spin" />}确定</button></div></form>
  </ModelDialog>
}
