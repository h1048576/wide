import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { Copy, Cpu, GripVertical, Pencil, RefreshCw, Trash2 } from 'lucide-react'
import type { CustomModel, ModelSource } from '../../shared/types'

type Drop = { index: number; after: boolean }
type Drag = { index: number; pointerId: number; startX: number; startY: number; active: boolean }

export default function ModelList({ source, disabled, operation, onCopy, onEdit, onDelete, onReorder }: {
  source: ModelSource; disabled: boolean; operation: string
  onCopy: (item: CustomModel) => void; onEdit: (item: CustomModel) => void; onDelete: (item: CustomModel) => void; onReorder: (items: CustomModel[]) => void
}) {
  const list = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  const [dragging, setDragging] = useState<number | null>(null)
  const [drop, setDrop] = useState<Drop | null>(null)
  const blockClick = useRef(false)
  const scrollFrame = useRef<number | null>(null)
  const pointer = useRef({ x: 0, y: 0 })
  const [announcement, setAnnouncement] = useState('')

  function clear() {
    drag.current = null; setDragging(null); setDrop(null)
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current)
    scrollFrame.current = null
  }
  useEffect(() => { if (disabled) clear() }, [disabled])
  useEffect(() => () => { if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current) }, [])

  function targetAt(x: number, y: number): Drop | null {
    const root = list.current
    if (!root) return null
    const bounds = root.getBoundingClientRect()
    const viewport = root.closest('.main-content')?.getBoundingClientRect()
    if (x < bounds.left || x > bounds.right || y < Math.max(bounds.top, viewport?.top ?? 0) || y > Math.min(bounds.bottom, viewport?.bottom ?? window.innerHeight)) return null
    const rows = [...root.querySelectorAll<HTMLDivElement>('[data-model-index]')]
    const before = rows.find(row => { const rect = row.getBoundingClientRect(); return y < rect.top + rect.height / 2 })
    const target = before ?? rows.at(-1)
    return target ? { index: Number(target.dataset.modelIndex), after: !before } : null
  }
  function updateDrop() {
    const target = targetAt(pointer.current.x, pointer.current.y)
    setDrop(target?.index === drag.current?.index ? null : target)
  }
  function autoScroll() {
    if (!drag.current?.active) { scrollFrame.current = null; return }
    const container = list.current?.closest('.main-content')
    if (container) {
      const bounds = container.getBoundingClientRect(), { x, y } = pointer.current
      if (x >= bounds.left && x <= bounds.right) {
        const speed = y < bounds.top + 40 ? -10 : y > bounds.bottom - 40 ? 10 : 0
        if (speed) { container.scrollTop += speed; updateDrop() }
      }
    }
    scrollFrame.current = requestAnimationFrame(autoScroll)
  }
  function start(event: PointerEvent<HTMLButtonElement>, index: number) {
    if (disabled || source.models.length < 2 || event.button !== 0) return
    blockClick.current = false
    drag.current = { index, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, active: false }
    pointer.current = { x: event.clientX, y: event.clientY }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  function move(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    pointer.current = { x: event.clientX, y: event.clientY }
    if (!current.active) {
      if (Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < 6) return
      current.active = true; blockClick.current = true; setDragging(current.index)
      scrollFrame.current = requestAnimationFrame(autoScroll)
    }
    updateDrop()
  }
  function reorder(index: number, target: Drop) {
    if (index === target.index) return
    const moved = source.models.find(item => item.index === index)
    const items = source.models.filter(item => item.index !== index)
    const position = items.findIndex(item => item.index === target.index)
    if (!moved || position < 0) return
    items.splice(position + (target.after ? 1 : 0), 0, moved)
    if (items.every((item, i) => item.index === source.models[i].index)) return
    setAnnouncement(`${moved.name} 已移至第 ${items.findIndex(item => item.index === index) + 1} 位`)
    onReorder(items)
  }
  function finish(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    const target = current.active ? targetAt(event.clientX, event.clientY) : null
    clear()
    if (target && !disabled) reorder(current.index, target)
  }

  return <div ref={list} className={`model-list${dragging !== null ? ' model-list-dragging' : ''}`}>
    <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
    {source.models.map((item, position) => <div className={`setting-row harness-skill-row model-row${dragging === item.index ? ' model-drag-source' : ''}${drop?.index === item.index ? drop.after ? ' model-drop-after' : ' model-drop-before' : ''}`} key={`${source.id}:${item.index}`} data-model-index={item.index}>
      <div className="harness-skill-name model-name"><button className="icon-button model-drag-handle" type="button" aria-label={`${source.harness} ${item.name}，拖动排序`} title="按住拖动排序；Alt + ↑/↓ 移动" disabled={disabled || source.models.length < 2} onPointerDown={event => start(event, item.index)} onPointerMove={move} onPointerUp={finish} onPointerCancel={clear} onLostPointerCapture={clear} onClick={event => { if (blockClick.current) { event.preventDefault(); event.stopPropagation() } }} onKeyDown={event => {
        if (event.key === 'Escape' && drag.current) { event.preventDefault(); clear(); return }
        if (disabled || !event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return
        event.preventDefault()
        const target = source.models[position + (event.key === 'ArrowUp' ? -1 : 1)]
        if (target) reorder(item.index, { index: target.index, after: event.key === 'ArrowDown' })
      }}><GripVertical size={14} /></button><Cpu size={15} /><div><span>{item.name}</span>{item.model !== item.name && <small>{item.model}</small>}</div></div>
      <div className="harness-actions">
        <button className="button secondary harness-action" aria-label={`${source.harness} ${item.name}，修改`} disabled={disabled} onClick={() => onEdit(item)}>{operation === `edit:${source.id}:${item.index}` ? <RefreshCw size={14} className="spin" /> : <Pencil size={14} />}修改</button>
        <button className="button secondary harness-action" aria-label={`${source.harness} ${item.name}，复制`} disabled={disabled} onClick={() => onCopy(item)}>{operation === `copy:${source.id}:${item.index}` ? <RefreshCw size={14} className="spin" /> : <Copy size={14} />}复制</button>
        <button className="button secondary harness-action harness-delete" aria-label={`${source.harness} ${item.name}，删除`} disabled={disabled} onClick={() => onDelete(item)}>{operation === `delete:${source.id}:${item.index}` ? <RefreshCw size={14} className="spin" /> : <Trash2 size={14} />}删除</button>
      </div>
    </div>)}
  </div>
}
