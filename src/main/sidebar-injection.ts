type SidebarApplication = 'codex' | 'zcode' | 'qoder' | 'paseo'

// 各应用的侧栏容器和收起状态不同，只标记展开的布局面板。
const layouts: Record<SidebarApplication, { selector: string; scan: string; css?: string }> = {
  codex: {
    selector: '.app-shell-left-panel, [data-app-navigation-rail]',
    scan: `for (const panel of document.querySelectorAll('.app-shell-left-panel')) {
      const rail = panel.querySelector('[data-app-navigation-rail]');
      const railWidth = rail ? Number.parseFloat(getComputedStyle(rail).width) : 0;
      const nativeWidth = Number.parseFloat(panel.style.width);
      panel.toggleAttribute(attribute, nativeWidth > railWidth + 1 && panel.getAttribute('data-slate-sidebar-peeking') !== 'true');
    }`,
    css: `[data-wide-codex-sidebar] > :first-child > :first-child {
      width: 100% !important; min-width: 0 !important;
    }`
  },
  zcode: {
    selector: '[data-workspace-shell], [data-workspace-sidebar-panel], [data-workspace-sidebar-panel] > aside',
    scan: `for (const panel of document.querySelectorAll('[data-workspace-sidebar-panel="true"]')) {
      const content = panel.querySelector('aside');
      panel.toggleAttribute(attribute, !!content && content.getAttribute('aria-hidden') !== 'true');
    }`,
    css: `[data-workspace-shell]:has(> [data-wide-zcode-sidebar]) {
      --workspace-sidebar-panel-width: WIDTH !important;
      --workspace-sidebar-width: WIDTH !important;
    }`
  },
  qoder: {
    selector: '[data-panel][id="sidebar"], [data-layout-region="a"]',
    scan: `for (const panel of document.querySelectorAll('[data-panel][id="sidebar"]')) {
      const content = panel.querySelector('[data-layout-region="a"]');
      panel.toggleAttribute(attribute, !!content && content.getAttribute('aria-hidden') !== 'true' && Number.parseFloat(panel.style.flexGrow) > 0);
    }`,
    css: `[data-wide-qoder-sidebar] [data-layout-sidebar-content] { width: 100% !important; }`
  },
  paseo: {
    selector: '[data-testid="left-sidebar-resize-handle"]',
    scan: `for (const handle of document.querySelectorAll('[data-testid="left-sidebar-resize-handle"]')) {
      const panel = handle.parentElement?.parentElement;
      if (panel) panel.toggleAttribute(attribute, true);
    }`
  }
}

export function sidebarInjection(id: SidebarApplication, sidebarWidth: string) {
  // 百分比按窗口宽度计算，避免嵌套侧栏容器改变百分比的参照。
  const width = sidebarWidth.endsWith('%') ? `${Number.parseFloat(sidebarWidth)}vw` : sidebarWidth
  const layout = layouts[id]
  const attribute = `data-wide-${id}-sidebar`
  const css = `[${attribute}] {
    box-sizing: border-box !important;
    width: ${width} !important;
    min-width: 0 !important;
    max-width: 100% !important;
    flex: 0 0 ${width} !important;
  }
  ${(layout.css || '').replaceAll('WIDTH', width)}`
  return `(() => {
    const apply = () => {
      const key = ${JSON.stringify(`__wide${id}SidebarGuard`)};
      window[key]?.dispose();
      let style = document.getElementById(${JSON.stringify(`${id}-wide-sidebar-override`)});
      if (!style) {
        style = document.createElement('style');
        style.id = ${JSON.stringify(`${id}-wide-sidebar-override`)};
        (document.head || document.documentElement).appendChild(style);
      }
      const css = ${JSON.stringify(css)};
      if (style.textContent !== css) style.textContent = css;
      const attribute = ${JSON.stringify(attribute)};
      const selector = ${JSON.stringify(`${layout.selector}, [${attribute}]`)};
      let frame = 0;
      const scan = () => { ${layout.scan} };
      const schedule = () => {
        if (!frame) frame = requestAnimationFrame(() => { frame = 0; scan(); });
      };
      const relevant = node => node instanceof Element && (node.matches(selector) || !!node.querySelector(selector));
      const observer = new MutationObserver(records => {
        if (records.some(record => record.type === 'attributes'
          ? record.target.matches(selector)
          : [...record.addedNodes, ...record.removedNodes].some(relevant))) schedule();
      });
      observer.observe(document.documentElement, {subtree: true, childList: true, attributes: true,
        attributeFilter: ['class', 'style', 'aria-hidden', 'data-slate-sidebar-peeking']});
      window[key] = {dispose: () => { observer.disconnect(); cancelAnimationFrame(frame); }};
      scan();
      return true;
    };
    if (document.documentElement) return apply();
    document.addEventListener('DOMContentLoaded', apply, {once: true});
    return true;
  })()`
}
