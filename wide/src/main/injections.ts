import templates from './injection-templates.json'
import type { ApplicationSettings, FeatureId } from '../shared/types'

// 模板沿用原脚本的选择器和页面守护，跨平台启动共用相同规则。
export function applicationInjection(id: Exclude<FeatureId, 'droid'>, settings: ApplicationSettings) {
  const template = templates[id]
  const font = settings.fontFamily.split(',').map(name => {
    const value = name.trim().replace(/^['"]|['"]$/g, '')
    return /^(serif|sans-serif|monospace|system-ui|ui-[a-z-]+|cursive|fantasy)$/i.test(value) ? value : JSON.stringify(value)
  }).join(', ') + ', monospace'
  const values: Record<string, string> = {
    safeWidth: id === 'qoder' && !['auto', 'fit-content'].includes(settings.width) ? `min(100%, ${settings.width})` : settings.width,
    safeMaxWidth: id === 'qoder' ? settings.maxWidth === 'none' ? '100%' : `min(100%, ${settings.maxWidth})` : settings.maxWidth,
    safeFontFamily: font, cssFontFamily: font,
    ContentFontSize: String(settings.fontSize), ContentFontWeight: String(settings.fontWeight),
    hiddenUiCss: [settings.hideLocalMerge ? '[data-testid="changes-primary-cta"],[data-testid="changes-primary-cta-caret"]{display:none !important;}' : '', settings.hideGitDiff ? '[data-testid="composer-diff-stat-pill"]{display:none !important;}' : ''].join('\n'),
    hiddenChangesCss: settings.hideChanges ? '[data-testid="chat-summary-panel"]{display:none !important;}' : ''
  }
  const css = template.css.replace(/\$\{(\w+)\}|\$(\w+)/g, (_match, braced, plain) => {
    const key = braced ?? plain
    if (!(key in values)) throw new Error(`未知注入参数：${key}`)
    return values[key]
  })
  return template.source.replaceAll('$cssJson', JSON.stringify(css)).replaceAll('$PreventSummary', settings.preventSummary ? '1' : '0')
}
