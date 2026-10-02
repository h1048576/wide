import type { ReactNode } from 'react'
import { ChevronDown, ChevronsDownUp, ChevronsUpDown } from 'lucide-react'

export default function HarnessSectionHeading({ title, expanded, contentId, onToggle, onExpandAll, onCollapseAll, disabled = false, children }: {
  title: 'Skills' | 'Models'
  expanded: boolean
  contentId: string
  onToggle: () => void
  onExpandAll: () => void
  onCollapseAll: () => void
  disabled?: boolean
  children: ReactNode
}) {
  return <div className="harness-section-heading">
    <h2><button className="harness-disclosure harness-section-disclosure" aria-label={`${expanded ? '折叠' : '展开'} ${title} 区域`} title={`${expanded ? '折叠' : '展开'} ${title}`} aria-expanded={expanded} aria-controls={contentId} disabled={disabled} onClick={onToggle}><ChevronDown size={15} className={expanded ? 'open' : ''} /><span>{title}</span></button></h2>
    <div className="harness-actions">
      <button className="icon-button" aria-label={`展开所有 ${title}`} title="展开所有" disabled={disabled} onClick={onExpandAll}><ChevronsUpDown size={15} /></button>
      <button className="icon-button" aria-label={`折叠所有 ${title}`} title="折叠所有" disabled={disabled} onClick={onCollapseAll}><ChevronsDownUp size={15} /></button>
      {children}
    </div>
  </div>
}
