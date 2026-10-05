import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'
import { DEFAULT_DROID } from '../../shared/types'

type Option = { value: string; label: string; disabled?: boolean }
const FONT_OPTIONS: Option[] = [DEFAULT_DROID.fontFamily, 'LXGW WenKai Mono', 'Cascadia Mono', 'Microsoft YaHei', 'Segoe UI', 'PingFang SC', 'Noto Sans CJK SC', 'Arial'].map(font => ({ value: font, label: font }))
const SYSTEM_FONT_OPTIONS = [{ value: '系统默认', label: '系统默认' }, ...FONT_OPTIONS]

function useDropdown(options: Option[], value: string, disabled: boolean, onChange: (value: string) => void) {
  const anchor = useRef<HTMLDivElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' })
  const enabled = options.map((option, index) => option.disabled ? -1 : index).filter(index => index !== -1)

  function show(last = false) {
    if (disabled) return
    const selected = options.findIndex(option => option.value === value && !option.disabled)
    setActive(selected >= 0 ? selected : (last ? enabled.at(-1) : enabled[0]) ?? -1)
    setOpen(true)
  }
  function choose(index: number) {
    const option = options[index]
    if (disabled || !option || option.disabled) return
    onChange(option.value)
    setOpen(false)
    anchor.current?.querySelector<HTMLInputElement | HTMLButtonElement>('input, button')?.focus()
  }
  function onKeyDown(event: KeyboardEvent, editable = false) {
    if (disabled || event.nativeEvent.isComposing) return
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); return }
    if (event.key === 'Tab') { setOpen(false); return }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) { show(event.key === 'ArrowUp'); return }
      const current = enabled.indexOf(active)
      const next = (current + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length
      setActive(enabled[next] ?? -1)
    } else if (open && (event.key === 'Home' || event.key === 'End')) {
      event.preventDefault(); setActive((event.key === 'Home' ? enabled[0] : enabled.at(-1)) ?? -1)
    } else if (event.key === 'Enter' || !editable && event.key === ' ') {
      if (open) { event.preventDefault(); choose(active) }
      else if (!editable) { event.preventDefault(); show() }
    }
  }

  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  useEffect(() => {
    if (!open) return
    const dismiss = (event: Event) => {
      const target = event.target
      if (target instanceof Node && !anchor.current?.contains(target) && !menu.current?.contains(target)) setOpen(false)
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('focusin', dismiss)
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('focusin', dismiss) }
  }, [open])
  useLayoutEffect(() => {
    if (!open) return
    function place() {
      const bounds = anchor.current?.getBoundingClientRect()
      if (!bounds) return
      if (bounds.bottom < 8 || bounds.top > window.innerHeight - 8) { setOpen(false); return }
      const margin = 8
      const gap = 4
      const below = window.innerHeight - bounds.bottom - gap - margin
      const above = bounds.top - gap - margin
      const desired = Math.min(400, options.length * 42 + 14)
      const upwards = below < desired && above > below
      const maxHeight = Math.max(0, Math.min(400, upwards ? above : below))
      const width = Math.min(bounds.width, window.innerWidth - margin * 2)
      const left = Math.max(margin, Math.min(bounds.left, window.innerWidth - width - margin))
      setPosition({ left, width, maxHeight, ...(upwards ? { bottom: window.innerHeight - bounds.top + gap } : { top: bounds.bottom + gap }) })
    }
    place()
    const observer = new ResizeObserver(place)
    if (anchor.current) observer.observe(anchor.current)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => { observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [open, options])
  useEffect(() => { if (open) menu.current?.children[active]?.scrollIntoView({ block: 'nearest' }) }, [active, open])

  return { anchor, menu, open, active, position, setActive, setOpen, show, choose, onKeyDown }
}

function OptionMenu({ id, label, value, options, dropdown }: { id: string; label: string; value: string; options: Option[]; dropdown: ReturnType<typeof useDropdown> }) {
  if (!dropdown.open) return null
  const compact = typeof dropdown.position.width === 'number' && dropdown.position.width < 120
  return createPortal(<div ref={dropdown.menu} id={`${id}-options`} className={`dropdown-menu${compact ? ' dropdown-menu-compact' : ''}`} role="listbox" aria-label={label} style={dropdown.position}>
    {options.map((option, index) => <div key={option.value} id={`${id}-option-${index}`} role="option" aria-selected={option.value === value} aria-disabled={option.disabled || undefined} className={`dropdown-option ${index === dropdown.active ? 'active' : ''} ${option.disabled ? 'disabled' : ''}`} onPointerMove={() => { if (!option.disabled) dropdown.setActive(index) }} onPointerDown={event => event.preventDefault()} onClick={() => dropdown.choose(index)}>
      <span>{option.label}</span>{option.value === value && <Check size={16} aria-hidden="true" />}
    </div>)}
  </div>, document.body)
}

export function SelectControl({ id, label, value, disabled = false, onChange, options }: { id: string; label: string; value: string; disabled?: boolean; onChange: (value: string) => void; options: Option[] }) {
  const dropdown = useDropdown(options, value, disabled, onChange)
  return <div ref={dropdown.anchor} className="select-control">
    <button id={id} className="dropdown-trigger" type="button" role="combobox" aria-label={label} aria-expanded={dropdown.open} aria-haspopup="listbox" aria-controls={dropdown.open ? `${id}-options` : undefined} aria-activedescendant={dropdown.open && dropdown.active >= 0 ? `${id}-option-${dropdown.active}` : undefined} disabled={disabled} onClick={() => dropdown.open ? dropdown.setOpen(false) : dropdown.show()} onKeyDown={event => dropdown.onKeyDown(event)}>
      <span>{options.find(option => option.value === value)?.label ?? value}</span><ChevronDown size={15} className="dropdown-chevron" aria-hidden="true" />
    </button>
    <OptionMenu id={id} label={label} value={value} options={options} dropdown={dropdown} />
  </div>
}

export function EditableSelectControl({ id, label, value, disabled = false, options, onChange }: { id: string; label: string; value: string; disabled?: boolean; options: Option[]; onChange: (value: string) => void }) {
  const dropdown = useDropdown(options, value, disabled, onChange)
  return <div ref={dropdown.anchor} className="editable-select-control">
    <input id={id} className="field-input" role="combobox" value={value} disabled={disabled} aria-label={label} aria-autocomplete="list" aria-expanded={dropdown.open} aria-haspopup="listbox" aria-controls={dropdown.open ? `${id}-options` : undefined} aria-activedescendant={dropdown.open && dropdown.active >= 0 ? `${id}-option-${dropdown.active}` : undefined} onChange={event => onChange(event.target.value)} onKeyDown={event => dropdown.onKeyDown(event, true)} autoComplete="off" spellCheck={false} />
    <button className="font-dropdown-button" type="button" aria-label={`选择${label}`} aria-expanded={dropdown.open} aria-haspopup="listbox" aria-controls={dropdown.open ? `${id}-options` : undefined} disabled={disabled} onKeyDown={event => dropdown.onKeyDown(event)} onClick={() => { if (dropdown.open) dropdown.setOpen(false); else dropdown.show(); dropdown.anchor.current?.querySelector('input')?.focus() }}><ChevronDown size={15} aria-hidden="true" /></button>
    <OptionMenu id={id} label={label} value={value} options={options} dropdown={dropdown} />
  </div>
}

export function FontControl({ id, value, disabled, error, onChange, systemOption = false, label: customLabel }: { id: string; value: string; disabled: boolean; error?: string; onChange: (value: string) => void; systemOption?: boolean; label?: string }) {
  const options = systemOption ? SYSTEM_FONT_OPTIONS : FONT_OPTIONS
  const label = customLabel ?? (systemOption ? '应用字体' : 'Droid 字体')
  const dropdown = useDropdown(options, value, disabled, onChange)
  return <div ref={dropdown.anchor} className="font-control">
    <input id={id} role="combobox" value={value} disabled={disabled} aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined} aria-label={label} aria-autocomplete="list" aria-expanded={dropdown.open} aria-haspopup="listbox" aria-controls={dropdown.open ? `${id}-options` : undefined} aria-activedescendant={dropdown.open && dropdown.active >= 0 ? `${id}-option-${dropdown.active}` : undefined} onChange={event => onChange(event.target.value)} onKeyDown={event => dropdown.onKeyDown(event, true)} autoComplete="off" spellCheck={false} />
    <button className="font-dropdown-button" type="button" aria-label={`选择${label}`} aria-expanded={dropdown.open} aria-haspopup="listbox" aria-controls={dropdown.open ? `${id}-options` : undefined} disabled={disabled} onKeyDown={event => dropdown.onKeyDown(event)} onClick={() => { if (dropdown.open) dropdown.setOpen(false); else dropdown.show(); dropdown.anchor.current?.querySelector('input')?.focus() }}><ChevronDown size={15} aria-hidden="true" /></button>
    <OptionMenu id={id} label={label} value={value} options={options} dropdown={dropdown} />
  </div>
}
