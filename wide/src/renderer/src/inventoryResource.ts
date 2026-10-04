import { useEffect, useState } from 'react'

type Snapshot<T> = { data: T; loaded: boolean; loading: boolean; error: string; updatedAt: number }
const messageOf = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(error)

// 缓存属于数据资源，切换页面不会丢失；失效后旧请求不能覆盖新数据。
export function createInventoryResource<T>(empty: T, load: (current: T) => Promise<T>) {
  let snapshot: Snapshot<T> = { data: empty, loaded: false, loading: false, error: '', updatedAt: 0 }
  let generation = 0
  let pending: Promise<void> | undefined
  const listeners = new Set<(next: Snapshot<T>) => void>()
  const publish = (next: Snapshot<T>) => { snapshot = next; listeners.forEach(listener => listener(next)) }
  return {
    snapshot: () => snapshot,
    subscribe(listener: (next: Snapshot<T>) => void) {
      listeners.add(listener); listener(snapshot)
      return () => { listeners.delete(listener) }
    },
    invalidate() {
      generation++; pending = undefined
      publish({ ...snapshot, loading: false, updatedAt: 0 })
    },
    update(change: (current: T) => T) { publish({ ...snapshot, data: change(snapshot.data) }) },
    refresh(force = false, loader = load): Promise<void> {
      if (pending) return pending
      if (!force && snapshot.loaded && !snapshot.error && Date.now() - snapshot.updatedAt < 30000) return Promise.resolve()
      const currentGeneration = generation
      publish({ ...snapshot, loading: true })
      const request = Promise.resolve().then(() => loader(snapshot.data)).then(data => {
        if (generation === currentGeneration) publish({ data, loaded: true, loading: false, error: '', updatedAt: Date.now() })
      }).catch(error => {
        if (generation === currentGeneration) publish({ ...snapshot, loading: false, error: messageOf(error) })
      }).finally(() => { if (pending === request) pending = undefined })
      pending = request
      return request
    }
  }
}

export function useInventoryResource<T>(resource: ReturnType<typeof createInventoryResource<T>>, enabled: boolean, blocked = false) {
  const [snapshot, setSnapshot] = useState(resource.snapshot)
  useEffect(() => resource.subscribe(setSnapshot), [resource])
  useEffect(() => {
    if (!enabled || blocked || !window.wide) return
    void resource.refresh()
    let timer: ReturnType<typeof setTimeout> | undefined
    const focus = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        // 回到窗口后检查外部配置变化，合并短时间内连续的聚焦事件。
        if (!document.hidden && Date.now() - resource.snapshot().updatedAt >= 2000) void resource.refresh(true)
      }, 200)
    }
    window.addEventListener('focus', focus)
    return () => { clearTimeout(timer); window.removeEventListener('focus', focus) }
  }, [resource, enabled, blocked])
  return { ...snapshot, loading: !!window.wide && (snapshot.loading || enabled && !snapshot.loaded && !snapshot.error) }
}
