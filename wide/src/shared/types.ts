export type FeatureId = 'codex' | 'droid' | 'paseo' | 'qoder' | 'workbuddy' | 'zcode'
export type Theme = 'system' | 'light' | 'dark'
export type AppearanceMode = 'normal' | 'compact'
export type StartupMode = 'default' | 'maximized'
export function parseStartupMode(input: unknown): StartupMode {
  if (input !== 'default' && input !== 'maximized') throw new Error('启动方式无效')
  return input
}
export interface DroidSettings {
  width: string
  maxWidth: string
  chatHeight: string
  fontFamily: string
  fontSize: number
  fontWeight: number
  hideLocalMerge: boolean
  hideGitDiff: boolean
  port: number
  executablePath: string
  hideChanges: boolean
  preventSummary: boolean
}
export interface AppearanceSettings { fontFamily: string; fontSize: number; mode: AppearanceMode }
export interface HarnessSettings { skillsCollapsed: boolean; modelsCollapsed: boolean; mcpsCollapsed: boolean }
export const DEFAULT_HARNESS_SETTINGS: HarnessSettings = { skillsCollapsed: true, modelsCollapsed: true, mcpsCollapsed: true }
export function parseHarnessSettings(input: unknown): HarnessSettings {
  if (!input || typeof input !== 'object') throw new Error('Harness 设置格式无效')
  const value = input as HarnessSettings
  if (Object.keys(DEFAULT_HARNESS_SETTINGS).some(key => typeof value[key as keyof HarnessSettings] !== 'boolean')) throw new Error('Harness 折叠设置无效')
  return { skillsCollapsed: value.skillsCollapsed, modelsCollapsed: value.modelsCollapsed, mcpsCollapsed: value.mcpsCollapsed }
}
export type ApplicationSettings = DroidSettings
export type ApplicationPreferences = Record<FeatureId, ApplicationSettings>
export interface Preferences { applications: ApplicationPreferences; theme: Theme; appearance: AppearanceSettings; harness: HarnessSettings; startupMode: StartupMode; menuOrder: FeatureId[]; menuOrderVersion: number }
export interface DroidInstallation { name: string; path: string; version: string }
export type OperationLevel = 'info' | 'success' | 'error'
export interface JobResult { success: boolean; message: string }
export type BatchAction = 'start' | 'restart' | 'exit'
export interface BatchApplicationResult { id: FeatureId; status: 'success' | 'skipped' | 'error'; message: string; skipReason?: 'not-installed' | 'already-running' }
export interface BatchProgress { action: BatchAction; currentId: FeatureId | null; completed: number; total: number; results: BatchApplicationResult[] }
export interface BatchResult extends JobResult { action: BatchAction; results: BatchApplicationResult[] }
export type HarnessId = 'claude' | 'agents' | 'droid' | 'codex'
export const HARNESSES: { id: HarnessId; name: string; directory: string }[] = [
  { id: 'claude', name: 'Claude', directory: '.claude' },
  { id: 'agents', name: 'Agents', directory: '.agents' },
  { id: 'droid', name: 'Droid', directory: '.factory' },
  { id: 'codex', name: 'Codex', directory: '.codex' }
]
export interface HarnessSkill { id: string; name: string; path: string; linked: boolean; available: boolean }
export interface HarnessFolder { id: HarnessId; name: string; path: string; skillsPath: string; exists: boolean; skills: HarnessSkill[]; error?: string }
export interface HarnessInventory { agentsSource: { path: string; exists: boolean }; harnesses: HarnessFolder[] }
export interface HarnessDocument { path: string; content: string }
export interface HarnessOperationResult extends JobResult { completed: number; failed: number }
export type ModelHarnessId = 'claude' | 'droid' | 'dsh' | 'pi' | 'opencode'
export interface CustomModel { index: number; model: string; name: string; revision: string }
export interface ModelSource { id: string; harness: ModelHarnessId; path: string; label: string; models: CustomModel[]; editable: boolean; baseUrl?: string; error?: string }
export interface ModelsInventory { sources: ModelSource[] }
export interface ModelFields {
  model: string; name: string; description?: string; baseUrl?: string; provider?: string
  reasoningEfforts?: Record<string, string | null> | false
}
export interface ModelTarget { sourceId: string; index: number; revision: string }
export interface ModelDetail { fields: ModelFields; apiKey?: string }
export interface ModelChange { sourceId: string; target?: ModelTarget; copyFrom?: ModelTarget; fields: ModelFields; apiKey?: string }
export interface ModelDocument { paths: string[]; content: string }
export interface ModelOrder { sourceId: string; models: ModelTarget[] }
export interface ModelBatchChange { action: 'replace' | 'add' | 'delete'; model: string; originalModel?: string }
export interface ModelBatchResult { changed: number; skipped: number; harnesses: ModelHarnessId[] }
export const DEFAULT_MODEL_BASE_URL = 'http://127.0.0.1:20128'
export type McpHarnessId = 'claude' | 'codex'
export type McpTransport = 'stdio' | 'http' | 'sse' | 'ws'
export interface McpServer { name: string; transport: string; description: string; revision: string }
export interface McpSource { harness: McpHarnessId; path: string; servers: McpServer[]; editable: boolean; error?: string }
export interface McpsInventory { sources: McpSource[] }
export interface McpTarget { harness: McpHarnessId; name: string; revision: string }
export interface McpFields {
  name: string; transport: McpTransport; command: string; args: string[]; env: Record<string, string>
  url: string; headers: Record<string, string>; cwd: string; bearerTokenEnvVar: string; envHeaders: Record<string, string>
}
export interface McpChange { harness: McpHarnessId; target?: McpTarget; copyFrom?: McpTarget; fields: McpFields }
export interface McpDocument { path: string; content: string; format: 'json' | 'toml' }
export interface Bootstrap { preferences: Preferences; platform: string; version: string; windowMaximized: boolean; openAtLogin: boolean; startupAvailable: boolean; configWarning?: string }
export interface WideApi {
  bootstrap(): Promise<Bootstrap>
  save(id: FeatureId, settings: ApplicationSettings): Promise<ApplicationSettings>
  setTheme(theme: Theme): Promise<void>
  setStartupMode(mode: StartupMode): Promise<void>
  setOpenAtLogin(enabled: boolean): Promise<boolean>
  setAppearance(settings: AppearanceSettings): Promise<AppearanceSettings>
  setHarnessSettings(settings: HarnessSettings): Promise<HarnessSettings>
  setMenuOrder(order: FeatureId[]): Promise<FeatureId[]>
  detect(id: FeatureId, path: string, force?: boolean): Promise<DroidInstallation | null>
  chooseExecutable(id: FeatureId): Promise<string | null>
  run(id: FeatureId, action: 'apply' | 'normal', settings: ApplicationSettings): Promise<JobResult>
  quit(id: FeatureId, path: string): Promise<JobResult>
  runAll(action: BatchAction): Promise<BatchResult>
  harnessInventory(): Promise<HarnessInventory>
  harnessSkillsInventory(): Promise<HarnessFolder[]>
  harnessPreviewAgents(): Promise<HarnessDocument>
  harnessSyncAgents(): Promise<HarnessOperationResult>
  harnessSyncSkills(source: 'claude' | 'agents', skillId?: string): Promise<HarnessOperationResult>
  harnessDeleteSkills(id: HarnessId, skillId: string): Promise<HarnessOperationResult>
  modelsInventory(): Promise<ModelsInventory>
  modelDetail(target: ModelTarget): Promise<ModelDetail>
  modelPreview(sourceId: string): Promise<ModelDocument>
  modelSave(change: ModelChange): Promise<void>
  modelDelete(target: ModelTarget): Promise<void>
  modelReorder(order: ModelOrder): Promise<void>
  modelBatch(change: ModelBatchChange): Promise<ModelBatchResult>
  mcpsInventory(): Promise<McpsInventory>
  mcpsRefresh(harness: McpHarnessId): Promise<McpSource>
  mcpDetail(target: McpTarget): Promise<McpFields>
  mcpPreview(harness: McpHarnessId): Promise<McpDocument>
  mcpSave(change: McpChange): Promise<void>
  mcpDelete(target: McpTarget): Promise<void>
  onBatchProgress(callback: (progress: BatchProgress) => void): () => void
  onNotice(callback: (result: JobResult) => void): () => void
  onWindowMaximized(callback: (maximized: boolean) => void): () => void
  windowAction(action: 'minimize' | 'maximize' | 'close'): void
}
export const DEFAULT_APPEARANCE: AppearanceSettings = { fontFamily: 'Cascadia Mono, LXGW WenKai Mono', fontSize: 17, mode: 'compact' }
export const DEFAULT_MENU_ORDER: FeatureId[] = ['codex', 'droid', 'zcode', 'workbuddy', 'qoder', 'paseo']
export const MENU_ORDER_VERSION = 2
export function normalizeMenuOrder(input: unknown): FeatureId[] {
  const saved = Array.isArray(input) ? input.filter((id): id is FeatureId => DEFAULT_MENU_ORDER.includes(id)) : []
  return [...new Set([...saved, ...DEFAULT_MENU_ORDER])]
}
export function parseMenuOrder(input: unknown): FeatureId[] {
  if (!Array.isArray(input) || input.length !== DEFAULT_MENU_ORDER.length || new Set(input).size !== input.length || input.some(id => !DEFAULT_MENU_ORDER.includes(id))) throw new Error('应用菜单顺序无效')
  return [...input] as FeatureId[]
}
export const SYSTEM_FONT = '"Segoe UI", "Microsoft YaHei", -apple-system, BlinkMacSystemFont, sans-serif'
export function appearanceErrors(value: AppearanceSettings): Partial<Record<keyof AppearanceSettings, string>> {
  const errors: Partial<Record<keyof AppearanceSettings, string>> = {}
  if (typeof value.fontFamily !== 'string' || !value.fontFamily.trim() || value.fontFamily.length > 300 || /[;{}<>\r\n]/.test(value.fontFamily)) errors.fontFamily = '请输入有效的字体名称'
  if (!Number.isInteger(value.fontSize) || value.fontSize < 10 || value.fontSize > 24) errors.fontSize = '字号须为 10–24 的整数'
  if (value.mode !== 'normal' && value.mode !== 'compact') errors.mode = '界面模式无效'
  return errors
}
export function parseAppearance(input: unknown): AppearanceSettings {
  if (!input || typeof input !== 'object') throw new Error('应用字体设置格式无效')
  const saved = input as AppearanceSettings
  const value = { ...saved, mode: saved.mode === undefined ? DEFAULT_APPEARANCE.mode : saved.mode }
  const errors = Object.values(appearanceErrors(value))
  if (errors.length) throw new Error(errors[0])
  return { fontFamily: value.fontFamily, fontSize: value.fontSize, mode: value.mode }
}
export const DEFAULT_DROID: DroidSettings = {
  width: '70vw', maxWidth: '90rem', chatHeight: '80px',
  fontFamily: 'Cascadia Mono, LXGW WenKai Mono', fontSize: 17, fontWeight: 300,
  hideLocalMerge: false, hideGitDiff: false, hideChanges: false, preventSummary: false, port: 9335, executablePath: ''
}
export const APPLICATIONS = {
  codex: { name: 'Codex', maxWidth: false, chatHeight: false, fontFamily: true, fontSize: true, merge: false, diff: false, changes: false, summary: true },
  droid: { name: 'Droid', maxWidth: true, chatHeight: true, fontFamily: true, fontSize: true, merge: false, diff: false, changes: false, summary: false },
  zcode: { name: 'ZCode', maxWidth: false, chatHeight: false, fontFamily: true, fontSize: false, merge: false, diff: false, changes: true, summary: false },
  workbuddy: { name: 'WorkBuddy', maxWidth: true, chatHeight: false, fontFamily: true, fontSize: true, merge: false, diff: false, changes: false, summary: false },
  qoder: { name: 'Qoder', maxWidth: true, chatHeight: false, fontFamily: true, fontSize: true, merge: false, diff: false, changes: false, summary: false },
  paseo: { name: 'Paseo', maxWidth: false, chatHeight: false, fontFamily: false, fontSize: false, merge: true, diff: true, changes: false, summary: false }
} satisfies Record<FeatureId, object>
export const DEFAULT_APPLICATIONS: ApplicationPreferences = {
  codex: { ...DEFAULT_DROID, fontWeight: 100, preventSummary: true, port: 9331 },
  droid: { ...DEFAULT_DROID },
  zcode: { ...DEFAULT_DROID, hideChanges: true, port: 9332 },
  workbuddy: { ...DEFAULT_DROID, fontWeight: 200, port: 9333 },
  qoder: { ...DEFAULT_DROID, port: 9334 },
  paseo: { ...DEFAULT_DROID, hideLocalMerge: true, hideGitDiff: true, port: 9336 }
}
export function parseFeatureId(input: unknown): FeatureId {
  if (typeof input !== 'string' || !DEFAULT_MENU_ORDER.includes(input as FeatureId)) throw new Error('应用标识无效')
  return input as FeatureId
}
const size = '(?:0|[1-9][0-9]{0,3})(?:\\.[0-9]+)?'
const widthPattern = new RegExp(`^(?:auto|fit-content|${size}(?:px|rem|em|vw|vh|%))$`)
const maxPattern = new RegExp(`^(?:none|${size}(?:px|rem|em|vw|vh|%))$`)
const heightPattern = new RegExp(`^(?:auto|${size}(?:px|rem|em|vh|%))$`)
export function settingsErrors(value: DroidSettings): Partial<Record<keyof DroidSettings, string>> {
  const errors: Partial<Record<keyof DroidSettings, string>> = {}
  if (!widthPattern.test(value.width)) errors.width = '请输入有效宽度，例如 70vw、80% 或 1200px'
  if (!maxPattern.test(value.maxWidth)) errors.maxWidth = '请输入有效最大宽度，例如 90rem 或 1200px'
  if (!heightPattern.test(value.chatHeight)) errors.chatHeight = '请输入有效高度，例如 80px'
  if (!Number.isInteger(value.fontSize) || value.fontSize < 8 || value.fontSize > 72) errors.fontSize = '字号须为 8–72 的整数'
  if (!Number.isInteger(value.fontWeight) || value.fontWeight < 100 || value.fontWeight > 1000) errors.fontWeight = '字重须为 100–1000 的整数'
  if (!value.fontFamily.trim() || value.fontFamily.length > 300 || /[;{}<>\r\n]/.test(value.fontFamily)) errors.fontFamily = '请填写字体名称，不能包含 CSS 控制字符'
  if (!Number.isInteger(value.port) || value.port < 1024 || value.port > 65535) errors.port = '端口须为 1024–65535 的整数'
  if (typeof value.executablePath !== 'string' || /[\r\n\0]/.test(value.executablePath)) errors.executablePath = '应用路径无效'
  if (typeof value.hideLocalMerge !== 'boolean' || typeof value.hideGitDiff !== 'boolean') errors.hideLocalMerge = '隐藏选项无效'
  if (typeof value.hideChanges !== 'boolean' || typeof value.preventSummary !== 'boolean') errors.hideChanges = '界面选项无效'
  return errors
}
export function parseSettings(input: unknown, id: FeatureId = 'droid'): DroidSettings {
  if (!input || typeof input !== 'object') throw new Error('设置格式无效')
  const value = input as Record<string, unknown>
  for (const [key, fallback] of Object.entries(DEFAULT_DROID)) {
    if (typeof value[key] !== typeof fallback) throw new Error(`设置 ${key} 的类型无效`)
  }
  const clean = Object.fromEntries(Object.keys(DEFAULT_DROID).map(key => [key, value[key]])) as unknown as DroidSettings
  const errors = Object.values(settingsErrors(clean))
  if (errors.length) throw new Error(errors[0])
  const capability = APPLICATIONS[id]
  return { ...clean, hideLocalMerge: capability.merge && clean.hideLocalMerge, hideGitDiff: capability.diff && clean.hideGitDiff,
    hideChanges: capability.changes && clean.hideChanges, preventSummary: capability.summary && clean.preventSummary }
}
