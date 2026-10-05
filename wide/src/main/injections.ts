import { terminalInjection } from './terminal-injection'
import templates from './injection-templates.json'
import type { ApplicationSettings, FeatureId } from '../shared/types'
import { dshInjection } from './dsh-injection'
import { workbuddySidebarInjection } from './workbuddy-sidebar-injection'
import { sidebarInjection } from './sidebar-injection'

// 模板沿用原脚本的选择器和页面守护，跨平台启动共用相同规则。
export function applicationInjection(id: Exclude<FeatureId, 'droid'>, settings: ApplicationSettings) {
  if (id === 'dsh') return dshInjection(settings)
  const template = templates[id]
  const font = settings.fontFamily.split(',').map(name => {
    const value = name.trim().replace(/^['"]|['"]$/g, '')
    return /^(serif|sans-serif|monospace|system-ui|ui-[a-z-]+|cursive|fantasy)$/i.test(value) ? value : JSON.stringify(value)
  }).join(', ') + ', monospace'
  const values: Record<string, string> = {
    safeWidth: (id === 'qoder' || id === 'workbuddy') && !['auto', 'fit-content'].includes(settings.width) ? `min(100%, ${settings.width})` : settings.width,
    safeMaxWidth: id === 'qoder' || id === 'workbuddy' ? settings.maxWidth === 'none' ? '100%' : `min(100%, ${settings.maxWidth})` : settings.maxWidth,
    // WorkBuddy 首页左右各有 24px 内边距，容器宽度需包含这部分空间。
    homePageWidth: ['auto', 'fit-content'].includes(settings.width) ? '100%' : `min(100%, calc(${settings.width} + 48px))`,
    homePageMaxWidth: settings.maxWidth === 'none' ? '100%' : `min(100%, calc(${settings.maxWidth} + 48px))`,
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
  const source = template.source.replaceAll('$cssJson', JSON.stringify(css)).replaceAll('$PreventSummary', settings.preventSummary ? '1' : '0')
  const sidebar = id === 'workbuddy' ? workbuddySidebarInjection(settings.sidebarWidth) : sidebarInjection(id, settings.sidebarWidth)
  const layoutSource = source.trim().replace(/;$/, '')
  return id === 'zcode' || id === 'qoder'
    ? `${layoutSource} && ${terminalInjection(id, settings)} && ${sidebar}`
    : `${layoutSource} && ${sidebar}`
}
