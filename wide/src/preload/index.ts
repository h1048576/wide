import { contextBridge, ipcRenderer } from 'electron'
import type { WideApi, JobResult, BatchProgress } from '../shared/types'

const api: WideApi = {
  bootstrap: () => ipcRenderer.invoke('wide:bootstrap'),
  save: (id, settings) => ipcRenderer.invoke('wide:save', id, settings),
  setTheme: theme => ipcRenderer.invoke('wide:theme', theme),
  setStartupMode: mode => ipcRenderer.invoke('wide:startup-mode', mode),
  setOpenAtLogin: enabled => ipcRenderer.invoke('wide:open-at-login', enabled),
  setAppearance: settings => ipcRenderer.invoke('wide:appearance', settings),
  setMenuOrder: order => ipcRenderer.invoke('wide:menu-order', order),
  detect: (id, path, force = false) => ipcRenderer.invoke('wide:detect', id, path, force),
  chooseExecutable: id => ipcRenderer.invoke('wide:choose', id),
  run: (id, action, settings) => ipcRenderer.invoke('wide:run', id, action, settings),
  quit: (id, path) => ipcRenderer.invoke('wide:quit', id, path),
  runAll: action => ipcRenderer.invoke('wide:run-all', action),
  harnessInventory: () => ipcRenderer.invoke('wide:harness-inventory'),
  harnessSkillsInventory: () => ipcRenderer.invoke('wide:harness-skills-inventory'),
  harnessPreviewAgents: () => ipcRenderer.invoke('wide:harness-preview-agents'),
  harnessSyncAgents: () => ipcRenderer.invoke('wide:harness-sync-agents'),
  harnessSyncSkills: (source, skillId) => ipcRenderer.invoke('wide:harness-sync-skills', source, skillId),
  harnessDeleteSkills: (id, skillId) => ipcRenderer.invoke('wide:harness-delete-skills', id, skillId),
  modelsInventory: () => ipcRenderer.invoke('wide:models-inventory'),
  modelDetail: target => ipcRenderer.invoke('wide:model-detail', target),
  modelPreview: sourceId => ipcRenderer.invoke('wide:model-preview', sourceId),
  modelSave: change => ipcRenderer.invoke('wide:model-save', change),
  modelDelete: target => ipcRenderer.invoke('wide:model-delete', target),
  modelReorder: order => ipcRenderer.invoke('wide:model-reorder', order),
  modelBatch: change => ipcRenderer.invoke('wide:model-batch', change),
  onBatchProgress: callback => {
    const handler = (_event: Electron.IpcRendererEvent, progress: BatchProgress) => callback(progress)
    ipcRenderer.on('wide:batch-progress', handler)
    return () => ipcRenderer.removeListener('wide:batch-progress', handler)
  },
  onNotice: callback => {
    const handler = (_event: Electron.IpcRendererEvent, result: JobResult) => callback(result)
    ipcRenderer.on('wide:notice', handler)
    return () => ipcRenderer.removeListener('wide:notice', handler)
  },
  onWindowMaximized: callback => {
    const handler = (_event: Electron.IpcRendererEvent, maximized: boolean) => callback(maximized)
    ipcRenderer.on('wide:window-maximized', handler)
    return () => ipcRenderer.removeListener('wide:window-maximized', handler)
  },
  windowAction: action => { void ipcRenderer.invoke('wide:window', action) }
}
contextBridge.exposeInMainWorld('wide', api)
