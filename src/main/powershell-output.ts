// Windows PowerShell 的 Write-Host 信息流有时仍会输出 CLIXML，不能把序列化对象展示给用户。
export function createPowerShellOutput(consume: (line: string) => void) {
  let buffer = ''
  let readingXml = false
  const decode = (value: string) => value
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/_x([\da-f]{4})_/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
  const emit = (value: string) => {
    for (const line of value.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/)) if (line.trim()) consume(line)
  }
  function drain(final = false) {
    while (buffer) {
      buffer = buffer.replace(/^#< CLIXML\s*/, '')
      const start = readingXml ? 0 : buffer.indexOf('<Objs')
      if (start >= 0) {
        if (start > 0) { emit(buffer.slice(0, start)); buffer = buffer.slice(start) }
        readingXml = true
        const end = buffer.indexOf('</Objs>')
        const match = /<S\b([^>]*)>([\s\S]*?)<\/S>/.exec(buffer)
        // 信息流可能一直到进程退出才闭合；完整消息到达即交付，不等整个 XML 文档。
        if (match && (end < 0 || match.index < end)) {
          if (/\bN="Message"|\bS="(?:Error|Warning|Information)"/i.test(match[1])) emit(decode(match[2]))
          buffer = buffer.slice(match.index + match[0].length)
          continue
        }
        if (end < 0) { if (final) buffer = ''; return }
        buffer = buffer.slice(end + 7)
        readingXml = false
        continue
      }
      const newline = buffer.indexOf('\n')
      if (newline < 0) { if (final) { emit(buffer); buffer = '' }; return }
      emit(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1)
    }
  }
  return { write(value: string) { buffer += value; drain() }, end() { drain(true) } }
}
