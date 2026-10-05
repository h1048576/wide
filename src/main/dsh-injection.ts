import type { ApplicationSettings } from '../shared/types'
import { terminalInjection } from './terminal-injection'

// 官方桌面版以插件渲染对话；使用公开的布局变量和 data 标记，避免依赖构建后的类名。
export function dshInjection(settings: ApplicationSettings) {
  const font = settings.fontFamily.split(',').map(name => {
    const value = name.trim().replace(/^['"]|['"]$/g, '')
    return /^(serif|sans-serif|monospace|system-ui|ui-[a-z-]+|cursive|fantasy)$/i.test(value) ? value : JSON.stringify(value)
  }).join(', ') + ', monospace'
  // 原生布局在消息列、居中的输入卡片等不同层级消费同一变量。
  // 将百分比换算为对话容器的长度，避免每一层重复缩窄。
  const length = (value: string) => value.endsWith('%')
    ? `calc(var(--dsh-conversation-column-width, 100vw) * ${Number.parseFloat(value) / 100})` : value
  const width = length(['auto', 'fit-content'].includes(settings.width) ? '100%' : settings.width)
  const contentWidth = settings.maxWidth === 'none' ? width : `min(${width}, ${length(settings.maxWidth)})`
  // 主框架铺满视口；百分比换成 vw，保证标题栏变量和绝对定位的分隔条使用相同长度。
  const sidebarWidth = settings.sidebarWidth.endsWith('%') ? `${Number.parseFloat(settings.sidebarWidth)}vw` : settings.sidebarWidth
  const css = `
    [data-wide-dsh-frame]:not([data-sidebar-collapsed="true"]) {
      --dsh-windows-sidebar-width: ${sidebarWidth} !important;
      grid-template-columns: ${sidebarWidth} var(--wide-dsh-layout-tail, minmax(0px, 1fr) minmax(0px, 0px)) !important;
    }
    [data-wide-dsh-frame]:not([data-sidebar-collapsed="true"]) > :first-child > [data-slot="sidebar"] > :first-child {
      box-sizing: border-box !important;
      width: 100% !important;
      min-width: 0 !important;
      max-width: 100% !important;
    }
    [data-wide-dsh-frame]:not([data-sidebar-collapsed="true"]) > [data-side="sidebar"] {
      left: ${sidebarWidth} !important;
    }
    :root, body {
      --dsw-font-family: ${font} !important;
      --ds-font-family-code: ${font} !important;
      --dsh-content-font-size: ${settings.fontSize}px !important;
      --dsh-content-font-size-secondary: ${settings.fontSize}px !important;
      --dsh-content-font-delta: ${settings.fontSize - 14}px !important;
      --dsh-content-font-delta-secondary: ${settings.fontSize - 13}px !important;
    }
    :root, body, body *:not(.xterm, .xterm *) {
      font-family: ${font} !important;
      font-size: ${settings.fontSize}px !important;
      font-weight: ${settings.fontWeight} !important;
    }
    [data-conversation-content] {
      --dsh-chat-content-width: ${contentWidth} !important;
      --dsh-composer-card-max-width: calc(${contentWidth} + 32px) !important;
    }
    [data-composer-seat] {
      --dsh-composer-text-max-height: ${settings.chatHeight} !important;
    }
    [data-composer-input] {
      box-sizing: border-box !important;
      height: ${settings.chatHeight} !important;
      min-height: ${settings.chatHeight} !important;
      max-height: ${settings.chatHeight} !important;
      overflow-y: auto !important;
    }
  `
  return `(() => {
    if (location.protocol !== 'dsh-app:' || location.hostname !== 'app') return false;
    const apply = () => {
      let style = document.getElementById('dsh-wide-ui-override');
      if (!style) {
        style = document.createElement('style');
        style.id = 'dsh-wide-ui-override';
        (document.head || document.documentElement).appendChild(style);
      }
      style.textContent = ${JSON.stringify(css)};
      ${terminalInjection('dsh', settings)};
      // 原生框架将三列宽度写到内联样式；只替换左列，随原生渲染同步中列和右列。
      const syncLayout = () => {
        for (const rightbar of document.querySelectorAll('[data-rightbar-col]')) {
          const frame = rightbar.parentElement;
          if (!frame) continue;
          const columns = /^[0-9.]+px\\s+(.+)$/.exec(frame.style.gridTemplateColumns);
          if (!columns) continue;
          frame.setAttribute('data-wide-dsh-frame', '');
          if (frame.style.getPropertyValue('--wide-dsh-layout-tail') !== columns[1]) {
            frame.style.setProperty('--wide-dsh-layout-tail', columns[1]);
          }
        }
      };
      window.__wideDshLayoutObserver?.disconnect();
      const observer = new MutationObserver(records => {
        const layoutChanged = records.some(record => {
          if (record.type === 'attributes') return record.target.hasAttribute('data-wide-dsh-frame');
          return Array.from(record.addedNodes).some(node => node instanceof Element &&
            (node.matches('[data-rightbar-col]') || node.querySelector('[data-rightbar-col]')));
        });
        if (layoutChanged) syncLayout();
      });
      observer.observe(document.documentElement, {subtree: true, childList: true, attributes: true, attributeFilter: ['style']});
      window.__wideDshLayoutObserver = observer;
      syncLayout();
      return true;
    };
    if (document.documentElement) return apply();
    document.addEventListener('DOMContentLoaded', apply, {once: true});
    return true;
  })()`
}
