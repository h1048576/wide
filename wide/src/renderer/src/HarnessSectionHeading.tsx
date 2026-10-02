import type { ReactNode } from 'react'
import { ChevronDown, ChevronsDownUp, ChevronsUpDown } from 'lucide-react'

export function HarnessExpandToggle({ title, expanded, onToggle, disabled = false }: {
  title: 'Skills' | 'Models'
  expanded: boolean
  onToggle: () => void
  disabled?: boolean
}) {
  const action = expanded ? '折叠所有' : '展开所有'
  return <button className="icon-button" aria-label={`${action} ${title}`} title={action} aria-expanded={expanded} disabled={disabled} onClick={onToggle}>{expanded ? <ChevronsDownUp size={15} /> : <ChevronsUpDown size={15} />}</button>
}

export default function HarnessSectionHeading({ title, expanded, contentId, onToggle, disabled = false, children }: {
  title: 'Skills' | 'Models'
  expanded: boolean
  contentId: string
  onToggle: () => void
  disabled?: boolean
  children: ReactNode
}) {
  return <div className="harness-section-heading">
    <h2><button className="harness-disclosure harness-section-disclosure" aria-label={`${expanded ? '折叠' : '展开'} ${title} 区域`} title={`${expanded ? '折叠' : '展开'} ${title}`} aria-expanded={expanded} aria-controls={contentId} disabled={disabled} onClick={onToggle}><ChevronDown size={15} className={expanded ? 'open' : ''} /><span>{title}</span></button></h2>
    <div className="harness-actions">
      {children}
    </div>
  </div>
}
