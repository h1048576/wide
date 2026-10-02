import { useEffect, useRef, useState, type ComponentType, type PointerEvent, type ReactNode } from 'react'
import { Check, ChevronDown, ChevronRight, CircleAlert, FolderOpen, GripVertical, Maximize2, Minus, Monitor, PanelLeft, Play, RefreshCw, RotateCcw, Search, Settings2, X } from 'lucide-react'
import { DEFAULT_APPEARANCE, DEFAULT_APPLICATIONS, APPLICATIONS, DEFAULT_MENU_ORDER, SYSTEM_FONT, appearanceErrors, normalizeMenuOrder, settingsErrors, type ApplicationPreferences, type AppearanceSettings, type DroidInstallation, type DroidSettings, type FeatureId, type Theme } from '../../shared/types'
import codexIcon from './assets/icons/codex.png'
import droidIcon from './assets/icons/droid.svg'
import paseoIcon from './assets/icons/paseo.png'
import qoderIcon from './assets/icons/qoder.png'
import workbuddyIcon from './assets/icons/workbuddy.png'
import zcodeIcon from './assets/icons/zcode.png'
import { FontControl, SelectControl } from './DropdownControl'

type MenuId = FeatureId | 'settings'
type SaveDomain = FeatureId | 'appearance' | 'theme' | 'menuOrder'
type Detection = { installation: DroidInstallation | null; error: string; checking: boolean; checked: boolean }
const detectionKey = (id: FeatureId, settings: DroidSettings) => JSON.stringify([id, settings.executablePath, settings.launchMode])
type AppIconProps = { size?: number; strokeWidth?: number }
function applicationIcon(id: FeatureId, src: string): ComponentType<AppIconProps> {
  return function ApplicationIcon({ size = 20 }) {
    return <img className={`app-icon app-icon-${id}`} src={src} width={size} height={size} alt="" aria-hidden="true" draggable={false} />
  }
}
const FEATURES: { id: FeatureId; name: string; icon: ComponentType<AppIconProps> }[] = [
  { id: 'codex', name: 'Codex', icon: applicationIcon('codex', codexIcon) }, { id: 'droid', name: 'Droid', icon: applicationIcon('droid', droidIcon) },
  { id: 'paseo', name: 'Paseo', icon: applicationIcon('paseo', paseoIcon) }, { id: 'qoder', name: 'Qoder', icon: applicationIcon('qoder', qoderIcon) },
  { id: 'workbuddy', name: 'WorkBuddy', icon: applicationIcon('workbuddy', workbuddyIcon) }, { id: 'zcode', name: 'ZCode', icon: applicationIcon('zcode', zcodeIcon) }
]
const SIZE_UNITS = ['%', 'vw', 'rem', 'px'] as const
const platformName: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }
const messageOf = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(error)

function SettingRow({ label, htmlFor, error, children }: { label: string; htmlFor?: string; error?: string; children: ReactNode }) {
  return <div className={`setting-row ${error ? 'has-error' : ''}`}><label className="setting-label" htmlFor={htmlFor}>{label}</label><div className="setting-value">{children}{error && <p className="field-error" id={`${htmlFor}-error`}>{error}</p>}</div></div>
}
function DimensionControl({ id, label, value, fallback, disabled, error, onChange }: { id: string; label: string; value: string; fallback: string; disabled: boolean; error?: string; onChange: (value: string) => void }) {
  const match = /^([0-9]*(?:\.[0-9]*)?)(%|vw|rem|px)$/.exec(value)
  const fallbackMatch = /^([0-9]+)(%|vw|rem|px)$/.exec(fallback)!
  const number = match?.[1] ?? ''
  const unit = match?.[2] ?? fallbackMatch[2]
  const legacy = !match && !!value
  return <SettingRow label={label} htmlFor={id} error={error}><div className="dimension-control">
      <input id={id} type="number" className="field-input dimension-number" min="0" max="9999" step="5" value={number} disabled={disabled} aria-label={`${label}数值`} aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined} placeholder={legacy ? value : undefined} onChange={event => onChange(`${event.target.value}${unit}`)} />
      <SelectControl id={`${id}-unit`} label={`${label}单位`} value={legacy ? 'legacy' : unit} disabled={disabled} onChange={next => onChange(`${number || fallbackMatch[1]}${next}`)} options={[...(legacy ? [{ value: 'legacy', label: value, disabled: true }] : []), ...SIZE_UNITS.map(sizeUnit => ({ value: sizeUnit, label: sizeUnit }))]} />
  </div></SettingRow>
}
function Switch({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled: boolean; onChange: (value: boolean) => void }) {
  return <button className={`switch ${checked ? 'on' : ''}`} type="button" role="switch" aria-label={label} aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}><span /></button>
}

export default function App() {
  const [active, setActive] = useState<MenuId>('codex')
  const activeRef = useRef(active)
  activeRef.current = active
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState(false)
  const [menuOrder, setMenuOrder] = useState<FeatureId[]>(() => [...DEFAULT_MENU_ORDER])
  const [dragging, setDragging] = useState<FeatureId | null>(null)
  const [dropTarget, setDropTarget] = useState<{ id: FeatureId; after: boolean } | null>(null)
  const [dragPreview, setDragPreview] = useState<{ x: number; y: number; width: number } | null>(null)
  const [menuAnnouncement, setMenuAnnouncement] = useState('')
  const [theme, setTheme] = useState<Theme>('system')
  const [systemDark, setSystemDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches)
  const [applications, setApplications] = useState<ApplicationPreferences>(() => structuredClone(DEFAULT_APPLICATIONS))
  const applicationId: FeatureId = active === 'settings' ? 'droid' : active
  const capability = APPLICATIONS[applicationId]
  const defaults = DEFAULT_APPLICATIONS[applicationId]
  const settings = applications[applicationId]
  function setSettings(value: DroidSettings) { setApplications(current => ({ ...current, [applicationId]: value })) }
  const [appearance, setAppearance] = useState<AppearanceSettings>({ ...DEFAULT_APPEARANCE })
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState<{ id: FeatureId; action: 'apply' | 'normal' } | null>(null)
  const [advanced, setAdvanced] = useState(false)
  const [detections, setDetections] = useState<Record<string, Detection>>({})
  const detectionCache = useRef(new Map<string, Detection>())
  const detectionRequests = useRef(new Map<string, Promise<void>>())
  const detection = detections[detectionKey(applicationId, settings)]
  const installation = detection?.installation ?? null
  const detecting = detection?.checking ?? false
  const detectionError = detection?.error ?? ''
  const missingInstallation = detection?.checked && !installation
  const currentOperation = busy?.id === applicationId ? busy.action : null
  const [platform, setPlatform] = useState(navigator.userAgent.includes('Mac') ? 'darwin' : navigator.userAgent.includes('Linux') ? 'linux' : 'win32')
  const [version, setVersion] = useState('0.2.1')
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null)
  const [bootError, setBootError] = useState('')
  const [configWarning, setConfigWarning] = useState('')
  const [saveErrors, setSaveErrors] = useState<Partial<Record<SaveDomain, string>>>({})
  const currentApplications = useRef(applications)
  const validApplications = useRef(structuredClone(applications))
  const currentAppearance = useRef(appearance)
  const validAppearance = useRef(appearance)
  const pending = useRef(new Set<Promise<unknown>>())
  const currentMenuOrder = useRef(menuOrder)
  const menuRef = useRef<HTMLElement>(null)
  const menuDrag = useRef<{ id: FeatureId; pointerId: number; startX: number; startY: number; left: number; top: number; width: number; active: boolean } | null>(null)
  const dragClickBlocked = useRef(false)
  const saveRevisions = useRef<Record<SaveDomain, number>>({ codex: 0, droid: 0, zcode: 0, workbuddy: 0, qoder: 0, paseo: 0, appearance: 0, theme: 0, menuOrder: 0 })
  const saveErrorsRef = useRef<Partial<Record<SaveDomain, string>>>({})
  const desktop = !!window.wide
  const isAppSettings = active === 'settings'
  const feature = FEATURES.find(item => item.id === active)
  const title = isAppSettings ? '设置' : feature!.name
  const PageIcon = isAppSettings ? Settings2 : feature!.icon
  const errors = settingsErrors(settings)
  const appErrors = appearanceErrors(appearance)
  const invalid = Object.keys(errors).length > 0
  const disabled = !!busy || !ready || !!bootError
  const dark = theme === 'dark' || theme === 'system' && systemDark
  const visibleFeatures = menuOrder.map(id => FEATURES.find(item => item.id === id)!).filter(item => collapsed || item.name.toLowerCase().includes(query.toLowerCase()))
  const draggedFeature = FEATURES.find(item => item.id === dragging)

  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)')
    const update = () => setSystemDark(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  useEffect(() => { document.documentElement.dataset.theme = dark ? 'dark' : 'light' }, [dark])
  useEffect(() => {
    const value = validAppearance.current
    document.documentElement.style.fontFamily = value.fontFamily === '系统默认' ? SYSTEM_FONT : `${value.fontFamily}, ${SYSTEM_FONT}`
    document.documentElement.style.fontSize = `${value.fontSize}px`
  }, [appearance])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && menuDrag.current) { event.preventDefault(); endMenuDrag(); return }
      if (!(event.ctrlKey || event.metaKey)) return
      if (/^[1-6]$/.test(event.key)) { event.preventDefault(); setActive(currentMenuOrder.current[Number(event.key) - 1]) }
      if (event.key === ',') { event.preventDefault(); setActive('settings') }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  useEffect(() => {
    let mounted = true
    const unsubscribe = window.wide?.onNotice(result => { if (mounted) setNotice({ text: result.message, error: !result.success }) })
    if (window.wide) {
      window.wide.bootstrap().then(data => {
        if (!mounted) return
        currentApplications.current = data.preferences.applications; validApplications.current = structuredClone(data.preferences.applications)
        currentAppearance.current = validAppearance.current = data.preferences.appearance
        const order = normalizeMenuOrder(data.preferences.menuOrder)
        currentMenuOrder.current = order; setMenuOrder(order)
        setApplications(data.preferences.applications); setAppearance(data.preferences.appearance); setTheme(data.preferences.theme)
        setPlatform(data.platform); setVersion(data.version); setConfigWarning(data.configWarning || ''); setReady(true)
      }).catch(error => { if (mounted) { setBootError(messageOf(error)); setReady(true) } })
    } else setReady(true)
    return () => { mounted = false; unsubscribe?.() }
  }, [])
  useEffect(() => {
    setAdvanced(false)
    if (active === 'settings' || !ready || !desktop || bootError || errors.executablePath) return
    if (detectionCache.current.has(detectionKey(applicationId, settings))) return
    // 路径输入保留防抖，单纯切换应用立即读取各自缓存。
    const timer = setTimeout(() => { void detect(settings.executablePath, false) }, settings.executablePath ? 400 : 0)
    return () => clearTimeout(timer)
  }, [ready, applicationId, active, settings.executablePath, settings.launchMode, bootError])
  useEffect(() => {
    if (!ready || !desktop || bootError) return
    let cancelled = false
    const queue = currentMenuOrder.current.filter(id => id !== activeRef.current)
    const preload = async () => {
      while (!cancelled && queue.length) {
        const id = queue.shift()!
        const value = currentApplications.current[id]
        if (!settingsErrors(value).executablePath) await requestDetection(id, value, false)
      }
    }
    // 后台最多两个检测任务，避免同时创建六个 PowerShell 进程。
    void preload(); void preload()
    return () => { cancelled = true }
  }, [ready, desktop, bootError])
  useEffect(() => {
    if (!notice || notice.error) return
    const timer = setTimeout(() => setNotice(null), 3500)
    return () => clearTimeout(timer)
  }, [notice])

  function persist(domain: SaveDomain, task: () => Promise<unknown>) {
    const revision = ++saveRevisions.current[domain]
    const promise = task().then(() => {
      if (revision !== saveRevisions.current[domain]) return
      const next = { ...saveErrorsRef.current }; delete next[domain]
      saveErrorsRef.current = next; setSaveErrors(next); setConfigWarning('')
    }).catch(error => {
      if (revision !== saveRevisions.current[domain]) return
      const next = { ...saveErrorsRef.current, [domain]: messageOf(error) }
      saveErrorsRef.current = next; setSaveErrors(next)
    }).finally(() => { pending.current.delete(promise) })
    pending.current.add(promise)
  }
  function updateApplication<K extends keyof DroidSettings>(key: K, value: DroidSettings[K]) {
    const next = { ...currentApplications.current[applicationId], [key]: value }
    currentApplications.current[applicationId] = next; setSettings(next)
    const candidate = { ...validApplications.current[applicationId], [key]: value }
    if (Object.keys(settingsErrors(candidate)).length) return
    validApplications.current[applicationId] = candidate
    if (window.wide) persist(applicationId, () => window.wide!.save(applicationId, candidate))
  }
  function updateAppearance<K extends keyof AppearanceSettings>(key: K, value: AppearanceSettings[K]) {
    const next = { ...currentAppearance.current, [key]: value }
    currentAppearance.current = next; setAppearance(next)
    const candidate = { ...validAppearance.current, [key]: value }
    if (Object.keys(appearanceErrors(candidate)).length) return
    validAppearance.current = candidate
    if (window.wide) persist('appearance', () => window.wide!.setAppearance(candidate))
  }
  function changeTheme(next: Theme) {
    setTheme(next)
    if (window.wide) persist('theme', () => window.wide!.setTheme(next))
  }
  function reorderMenu(source: FeatureId, target: FeatureId, after: boolean) {
    const current = currentMenuOrder.current
    if (source === target) return
    const next = current.filter(id => id !== source)
    const targetIndex = next.indexOf(target)
    if (targetIndex === -1) return
    next.splice(targetIndex + (after ? 1 : 0), 0, source)
    if (next.every((id, index) => id === current[index])) return
    currentMenuOrder.current = next; setMenuOrder(next)
    setMenuAnnouncement(`${FEATURES.find(item => item.id === source)!.name} 已移至第 ${next.indexOf(source) + 1} 位`)
    if (window.wide) persist('menuOrder', () => window.wide!.setMenuOrder(next))
  }
  function endMenuDrag() {
    menuDrag.current = null; setDragging(null); setDropTarget(null); setDragPreview(null)
  }
  function startMenuDrag(event: PointerEvent<HTMLButtonElement>, id: FeatureId) {
    dragClickBlocked.current = false
    if (event.button !== 0 || !ready || bootError) return
    const rect = event.currentTarget.getBoundingClientRect()
    menuDrag.current = { id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, left: rect.left, top: rect.top, width: rect.width, active: false }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  function menuTargetAt(x: number, y: number): { id: FeatureId; after: boolean } | null {
    const menu = menuRef.current
    if (!menu) return null
    const bounds = menu.getBoundingClientRect()
    if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return null
    const items = [...menu.querySelectorAll<HTMLButtonElement>('[data-feature-id]')]
    const before = items.find(item => { const rect = item.getBoundingClientRect(); return y < rect.top + rect.height / 2 })
    const target = before || items.at(-1)
    return target ? { id: target.dataset.featureId as FeatureId, after: !before } : null
  }
  function moveMenuDrag(event: PointerEvent<HTMLButtonElement>) {
    const drag = menuDrag.current
    if (!drag || drag.pointerId !== event.pointerId) return
    if (!drag.active) {
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) return
      drag.active = true; dragClickBlocked.current = true; setDragging(drag.id)
    }
    setDragPreview({ x: drag.left + event.clientX - drag.startX, y: drag.top + event.clientY - drag.startY, width: drag.width })
    const target = menuTargetAt(event.clientX, event.clientY)
    setDropTarget(target?.id === drag.id ? null : target)
  }
  function dropMenuDrag(event: PointerEvent<HTMLButtonElement>) {
    const drag = menuDrag.current
    if (!drag || drag.pointerId !== event.pointerId) return
    if (drag.active) {
      const target = menuTargetAt(event.clientX, event.clientY)
      if (target) reorderMenu(drag.id, target.id, target.after)
    }
    endMenuDrag()
  }
  async function windowAction(action: 'minimize' | 'maximize' | 'close') {
    if (action === 'close') {
      await Promise.all([...pending.current])
      if (Object.values(saveErrorsRef.current).length) { setNotice({ text: '自动保存失败，请修正设置后再关闭窗口。', error: true }); return }
    }
    window.wide?.windowAction(action)
  }
  function requestDetection(id: FeatureId, value: DroidSettings, force: boolean): Promise<void> {
    if (!window.wide) return Promise.resolve()
    const key = detectionKey(id, value)
    const existing = detectionRequests.current.get(key)
    if (existing) return existing
    if (!force && detectionCache.current.has(key)) return Promise.resolve()
    const publish = (result: Detection) => {
      detectionCache.current.set(key, result)
      setDetections(current => ({ ...current, [key]: result }))
    }
    publish({ installation: detectionCache.current.get(key)?.installation ?? null, error: '', checking: true, checked: false })
    const request = window.wide.detect(id, value.executablePath, value.launchMode, force).then(installation => {
      publish({ installation, error: '', checking: false, checked: true })
    }).catch(error => {
      publish({ installation: null, error: messageOf(error), checking: false, checked: true })
    }).finally(() => detectionRequests.current.delete(key))
    detectionRequests.current.set(key, request)
    return request
  }
  function detect(path = currentApplications.current[applicationId].executablePath, force = true) {
    return requestDetection(applicationId, { ...currentApplications.current[applicationId], executablePath: path }, force)
  }
  async function choose() {
    try { const path = await window.wide?.chooseExecutable(applicationId); if (path) updateApplication('executablePath', path) }
    catch (error) { setNotice({ text: messageOf(error), error: true }) }
  }
  async function run(action: 'apply' | 'normal') {
    if (!window.wide || invalid || disabled) return
    setBusy({ id: applicationId, action }); setNotice(null)
    try {
      await Promise.all([...pending.current])
      const result = await window.wide.run(applicationId, action, currentApplications.current[applicationId])
      setNotice({ text: result.message, error: !result.success })
      if (result.success) { const next = { ...saveErrorsRef.current }; delete next[applicationId]; saveErrorsRef.current = next; setSaveErrors(next) }
      if (activeRef.current === applicationId) void detect()
    } catch (error) { setNotice({ text: messageOf(error), error: true }) }
    finally { setBusy(null) }
  }
  function resetApplication() {
    const next = { ...defaults }
    currentApplications.current[applicationId] = validApplications.current[applicationId] = next; setSettings(next)
    if (window.wide) persist(applicationId, () => window.wide!.save(applicationId, next))
  }
  function resetAppearance() {
    const next = { ...DEFAULT_APPEARANCE }
    currentAppearance.current = validAppearance.current = next; setAppearance(next)
    if (window.wide) persist('appearance', () => window.wide!.setAppearance(next))
    changeTheme('system')
  }
  const inputProps = (key: keyof DroidSettings) => ({ disabled, 'aria-invalid': !!errors[key], 'aria-describedby': errors[key] ? `${key}-error` : undefined })

  return <div className={`app-shell ${collapsed ? 'sidebar-collapsed' : ''}`}>
    <aside className="sidebar">
      <div className={`brand-bar ${platform === 'darwin' ? 'mac-brand' : ''}`}><Maximize2 size={22} />{!collapsed && <span>wide</span>}<button className="icon-button collapse-toggle" title={collapsed ? '展开菜单' : '收起菜单'} aria-label={collapsed ? '展开菜单' : '收起菜单'} aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}><PanelLeft size={18} strokeWidth={1.6} aria-hidden="true" /></button></div>
      {!collapsed && <div className="sidebar-search"><Search size={15} /><input aria-label="搜索功能" placeholder="搜索功能" value={query} onChange={event => setQuery(event.target.value)} />{query && <button className="icon-button" aria-label="清空搜索" onClick={() => setQuery('')}><X size={12} /></button>}</div>}
      <div className="menu-section-label">应用</div>
      <nav ref={menuRef} aria-label="应用菜单" className={`feature-menu ${dragging ? 'menu-dragging' : ''}`}>
        {visibleFeatures.map(({ id, name, icon: Icon }) => <button key={id}
          className={`feature-item draggable-menu-item ${id === active ? 'selected' : ''} ${dragging === id ? 'drag-source' : ''} ${dropTarget?.id === id ? dropTarget.after ? 'drop-after' : 'drop-before' : ''}`}
          aria-label={name} aria-current={id === active ? 'page' : undefined} data-feature-id={id}
          title={`${name} · Ctrl+${menuOrder.indexOf(id) + 1} · 拖动调整顺序`}
          onPointerDown={event => startMenuDrag(event, id)} onPointerMove={moveMenuDrag} onPointerUp={dropMenuDrag}
          onPointerCancel={endMenuDrag} onLostPointerCapture={endMenuDrag}
          onClick={() => { if (!dragClickBlocked.current) setActive(id) }}
          onKeyDown={event => {
            dragClickBlocked.current = false
            if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key) || !ready || bootError) return
            event.preventDefault()
            const direction = event.key === 'ArrowDown' ? 1 : -1
            const target = visibleFeatures[visibleFeatures.findIndex(item => item.id === id) + direction]
            if (target) reorderMenu(id, target.id, direction === 1)
          }}>
          <div className="menu-icon" aria-hidden="true"><Icon size={20} /><GripVertical size={18} className="menu-grip" /></div>
          {!collapsed && <><span>{name}</span></>}
        </button>)}
        {!collapsed && !visibleFeatures.length && <p className="search-empty">没有匹配的功能</p>}
      </nav>
      <span className="sr-only" role="status" aria-live="polite">{menuAnnouncement}</span>
      <div className="sidebar-bottom"><button className={`feature-item own-settings ${isAppSettings ? 'selected' : ''}`} aria-current={isAppSettings ? 'page' : undefined} title="设置 · Ctrl+," onClick={() => setActive('settings')}><Settings2 size={18} />{!collapsed && <span>设置</span>}</button>{!collapsed && <div className="local-badge"><Monitor size={14} /><span>{platformName[platform] || platform}</span><small>v{version}</small></div>}</div>
    </aside>
    <div className="main-shell">
      <header className="titlebar"><div className="breadcrumb"><span>wide</span><ChevronRight size={13} /><span>{title}</span></div><div className="titlebar-right">{platform !== 'darwin' && <div className="window-controls"><button aria-label="最小化" onClick={() => { void windowAction('minimize') }}><Minus size={15} /></button><button aria-label="最大化或还原" onClick={() => { void windowAction('maximize') }}><Maximize2 size={13} /></button><button className="window-close" aria-label="关闭窗口" onClick={() => { void windowAction('close') }}><X size={16} /></button></div>}</div></header>
      <main className="main-content"><div className="page-container">
        {bootError && <div className="error-banner">初始化失败：{bootError}</div>}
        {configWarning && <div className="info-banner">{configWarning}</div>}
        {Object.values(saveErrors).length > 0 && <div className="error-banner" role="alert">自动保存失败：{Object.values(saveErrors).join('；')}</div>}
        <div className="page-header"><div className="page-title-group"><PageIcon size={26} strokeWidth={1.6} /><h1>{title}</h1></div>{!isAppSettings && <button className="button primary start-button" disabled={!desktop || disabled || invalid || missingInstallation} onClick={() => { void run('apply') }}>{currentOperation === 'apply' ? <RefreshCw size={15} className="spin" /> : <Play size={15} fill="currentColor" />}{currentOperation === 'apply' ? '启动中…' : '启动'}</button>}</div>
        {!isAppSettings ? <div key={applicationId} className="settings-page">
          <section className="settings-group" aria-label="内容布局"><h2>布局</h2><div className="settings-list">
            <DimensionControl id="width" label="内容区宽度" value={settings.width} fallback={defaults.width} disabled={disabled} error={errors.width} onChange={value => updateApplication('width', value)} />
            {capability.maxWidth && <DimensionControl id="maxWidth" label="最大宽度" value={settings.maxWidth} fallback={defaults.maxWidth} disabled={disabled} error={errors.maxWidth} onChange={value => updateApplication('maxWidth', value)} />}
            {capability.chatHeight && <SettingRow label="输入框高度" htmlFor="chatHeight" error={errors.chatHeight}><div className="number-control"><input id="chatHeight" type="number" min="0" max="9999" step="5" value={settings.chatHeight.endsWith('px') ? settings.chatHeight.slice(0, -2) : ''} placeholder={!settings.chatHeight.endsWith('px') ? settings.chatHeight : undefined} {...inputProps('chatHeight')} onChange={event => updateApplication('chatHeight', `${event.target.value}px`)} /><span>px</span></div></SettingRow>}
          </div></section>
          <section className="settings-group" aria-label={`${title} 字体`}><h2>字体</h2><div className="settings-list">
            {capability.fontFamily && <SettingRow label="字体" htmlFor="fontFamily" error={errors.fontFamily}><FontControl label={`${title} 字体`} id="fontFamily" value={settings.fontFamily} disabled={disabled} error={errors.fontFamily} onChange={value => updateApplication('fontFamily', value)} /></SettingRow>}
            {capability.fontSize && <SettingRow label="字号" htmlFor="fontSize" error={errors.fontSize}><div className="number-control"><input id="fontSize" type="number" min="8" max="72" value={settings.fontSize} {...inputProps('fontSize')} onChange={event => updateApplication('fontSize', Number(event.target.value))} /><span>px</span></div></SettingRow>}
            <SettingRow label="字重" htmlFor="fontWeight" error={errors.fontWeight}><input id="fontWeight" className="field-input number-input" type="number" min="100" max="1000" step="100" value={settings.fontWeight} {...inputProps('fontWeight')} onChange={event => updateApplication('fontWeight', Number(event.target.value))} /></SettingRow>
          </div></section>
          {(capability.merge || capability.diff || capability.changes || capability.summary) && <section className="settings-group" aria-label={`${title} 界面`}><h2>界面</h2><div className="settings-list">
            {capability.merge && <SettingRow label="隐藏本地 Merge"><Switch label="隐藏本地 Merge" checked={settings.hideLocalMerge} disabled={disabled} onChange={value => updateApplication('hideLocalMerge', value)} /></SettingRow>}
            {capability.diff && <SettingRow label="隐藏 Git Diff 统计"><Switch label="隐藏 Git Diff 统计" checked={settings.hideGitDiff} disabled={disabled} onChange={value => updateApplication('hideGitDiff', value)} /></SettingRow>}
            {capability.changes && <SettingRow label="隐藏右上角更改控件"><Switch label="隐藏右上角更改控件" checked={settings.hideChanges} disabled={disabled} onChange={value => updateApplication('hideChanges', value)} /></SettingRow>}
            {capability.summary && <SettingRow label="阻止摘要面板自动弹出"><Switch label="阻止摘要面板自动弹出" checked={settings.preventSummary} disabled={disabled} onChange={value => updateApplication('preventSummary', value)} /></SettingRow>}
          </div></section>}
          <section className="settings-group" aria-label={`${title} 应用连接`}><h2>应用</h2><div className="settings-list">
            {applicationId === 'codex' && platform === 'win32' && <SettingRow label="启动方式"><SelectControl id="launchMode" label="Codex 启动方式" value={settings.launchMode} disabled={disabled} onChange={value => updateApplication('launchMode', value as DroidSettings['launchMode'])} options={[{ value: 'desktop', label: '桌面应用' }, { value: 'codexhost', label: 'CodexHost' }]} /></SettingRow>}
            <SettingRow label="安装状态"><div className={`installation-value ${installation ? 'connected' : ''}`}><span>{installation ? `${installation.name} ${installation.version}` : detecting ? '检测中…' : desktop ? `未找到 ${applicationId === 'droid' ? 'Droid / Factory' : title}` : '桌面连接未启用'}</span><button className="icon-button" title="重新检测" aria-label="重新检测" disabled={!desktop || detecting || !!busy} onClick={() => { void detect() }}><RefreshCw size={16} className={detecting ? 'spin' : ''} /></button><button className="icon-button" title="选择应用" aria-label="选择应用" disabled={!desktop || !!busy || settings.launchMode === 'codexhost'} onClick={() => { void choose() }}><FolderOpen size={17} /></button></div></SettingRow>
            <SettingRow label="高级设置"><button className={`disclosure-button ${advanced ? 'open' : ''}`} aria-label="高级设置" aria-expanded={advanced} aria-controls="advanced-content" onClick={() => setAdvanced(!advanced)}><ChevronDown size={17} /></button></SettingRow>
            {advanced && <div id="advanced-content"><SettingRow label="安装路径" htmlFor="executablePath" error={errors.executablePath}><input id="executablePath" className="field-input path-input" placeholder="自动检测" value={settings.executablePath} {...inputProps('executablePath')} disabled={disabled || settings.launchMode === 'codexhost'} title={installation?.path} onChange={event => updateApplication('executablePath', event.target.value)} /></SettingRow>{settings.launchMode !== 'codexhost' && <SettingRow label="调试端口" htmlFor="port" error={errors.port}><input id="port" className="field-input number-input" type="number" min="1024" max="65535" value={settings.port} {...inputProps('port')} onChange={event => updateApplication('port', Number(event.target.value))} /></SettingRow>}</div>}
          </div>{detectionError && <p className="field-error detection-error" role="alert">{detectionError}</p>}</section>
          <div className="settings-actions"><button className="text-button" disabled={disabled} onClick={resetApplication}><RotateCcw size={15} />恢复预设值</button><button className="text-button" disabled={!desktop || disabled || invalid || missingInstallation} onClick={() => { void run('normal') }}>{currentOperation === 'normal' ? <RefreshCw size={15} className="spin" /> : <RotateCcw size={15} />}{currentOperation === 'normal' ? '恢复中…' : '恢复默认界面'}</button></div>
          <p className="operation-note">启动或恢复默认界面会重新启动 {title}，请先保存当前工作。</p>
        </div> : isAppSettings ? <div className="settings-page">
          <section className="settings-group" aria-label="应用外观"><h2>外观</h2><div className="settings-list">
            <SettingRow label="主题" htmlFor="app-theme"><SelectControl id="app-theme" label="应用主题" value={theme} disabled={!ready || !!bootError} onChange={value => changeTheme(value as Theme)} options={[{ value: 'system', label: '跟随系统' }, { value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }]} /></SettingRow>
            <SettingRow label="字体" htmlFor="app-fontFamily" error={appErrors.fontFamily}><FontControl id="app-fontFamily" value={appearance.fontFamily} systemOption disabled={!ready || !!bootError} error={appErrors.fontFamily} onChange={value => updateAppearance('fontFamily', value)} /></SettingRow>
            <SettingRow label="字号" htmlFor="app-fontSize" error={appErrors.fontSize}><div className="number-control"><input id="app-fontSize" type="number" min="10" max="24" value={appearance.fontSize} disabled={!ready || !!bootError} aria-invalid={!!appErrors.fontSize} aria-describedby={appErrors.fontSize ? 'app-fontSize-error' : undefined} onChange={event => updateAppearance('fontSize', Number(event.target.value))} /><span>px</span></div></SettingRow>
          </div></section>
          <div className="settings-actions"><button className="text-button" disabled={!ready || !!bootError} onClick={resetAppearance}><RotateCcw size={15} />恢复预设值</button></div>
        </div> : null}
      </div></main>
    </div>
    {draggedFeature && dragPreview && <div className="feature-item menu-drag-preview" aria-hidden="true" style={{ left: dragPreview.x, top: dragPreview.y, width: dragPreview.width }}><draggedFeature.icon size={20} />{!collapsed && <span>{draggedFeature.name}</span>}</div>}
    {notice && <div className={`toast ${notice.error ? 'error' : ''}`} role={notice.error ? 'alert' : 'status'}>{notice.error ? <CircleAlert size={18} /> : <Check size={18} />}<span>{notice.text}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setNotice(null)}><X size={15} /></button></div>}
  </div>
}
