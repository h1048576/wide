import { contextBridge, ipcRenderer } from 'electron'
import type { WideApi, JobResult } from '../shared/types'

const api: WideApi = {
  bootstrap: () => ipcRenderer.invoke('wide:bootstrap'),
  save: (id, settings) => ipcRenderer.invoke('wide:save', id, settings),
  setTheme: theme => ipcRenderer.invoke('wide:theme', theme),
  setAppearance: settings => ipcRenderer.invoke('wide:appearance', settings),
  setMenuOrder: order => ipcRenderer.invoke('wide:menu-order', order),
  detect: (id, path, mode, force = false) => ipcRenderer.invoke('wide:detect', id, path, mode, force),
  chooseExecutable: id => ipcRenderer.invoke('wide:choose', id),
  run: (id, action, settings) => ipcRenderer.invoke('wide:run', id, action, settings),
  onNotice: callback => {
    const handler = (_event: Electron.IpcRendererEvent, result: JobResult) => callback(result)
    ipcRenderer.on('wide:notice', handler)
    return () => ipcRenderer.removeListener('wide:notice', handler)
  },
  windowAction: action => { void ipcRenderer.invoke('wide:window', action) }
}
contextBridge.exposeInMainWorld('wide', api)
