// Windows PowerShell 的 Write-Host 信息流有时仍会输出 CLIXML，不能把序列化对象展示给用户。
export function createPowerShellOutput(consume: (line: string) => void) {
  let buffer = ''
  const decode = (value: string) => value
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/_x([\da-f]{4})_/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
  const emit = (value: string) => {
    for (const line of value.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/)) if (line.trim()) consume(line)
  }
  function drain(final = false) {
    while (buffer) {
      buffer = buffer.replace(/^#< CLIXML\s*/, '')
      const start = buffer.indexOf('<Objs')
      if (start >= 0) {
        if (start > 0) { emit(buffer.slice(0, start)); buffer = buffer.slice(start) }
        const end = buffer.indexOf('</Objs>')
        if (end < 0) { if (final) buffer = ''; return }
        const xml = buffer.slice(0, end + 7)
        // 只读取用户消息，忽略 ToString、副本、颜色和进程元数据。
        for (const match of xml.matchAll(/<S\b([^>]*)>([\s\S]*?)<\/S>/g)) {
          if (/\bN="Message"|\bS="(?:Error|Warning|Information)"/i.test(match[1])) emit(decode(match[2]))
        }
        buffer = buffer.slice(end + 7)
        continue
      }
      const newline = buffer.indexOf('\n')
      if (newline < 0) { if (final) { emit(buffer); buffer = '' }; return }
      emit(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1)
    }
  }
  return { write(value: string) { buffer += value; drain() }, end() { drain(true) } }
}
