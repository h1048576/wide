// WorkBuddy 的 Grid 用绝对定位分配列宽；保留原生右侧面板边界，仅在左栏与主区之间重新分配空间。
export function workbuddySidebarInjection(value: string) {
  const width = value.endsWith('%') ? `${Number.parseFloat(value)}vw` : value
  const css = `
    [data-wide-wb-grid="expanded"] > [data-view-id="sidebar"] {
      width: ${width} !important;
    }
    [data-wide-wb-grid="expanded"] > [data-view-id="sidebar"] > .conversation-sidebar,
    [data-wide-wb-grid="expanded"] > [data-view-id="sidebar"] > .conversation-sidebar > :first-child {
      width: 100% !important;
    }
    [data-wide-wb-grid="expanded"] > [data-wide-wb-main] {
      left: calc(var(--wide-wb-native-main-left) + ${width} - var(--wide-wb-native-sidebar-width)) !important;
      width: max(0px, calc(var(--wide-wb-native-main-width) + var(--wide-wb-native-sidebar-width) - ${width})) !important;
    }
    [data-wide-wb-grid="expanded"] > [data-wide-wb-sidebar-sash] {
      left: calc(var(--wide-wb-native-sidebar-left) + ${width} - 2px) !important;
    }
    .teams-container [class*="gridViewDrawerItemOpen"]:has(> .conversation-sidebar) {
      width: ${width} !important;
    }
    .teams-container [class*="gridViewDrawerItemOpen"] > .conversation-sidebar,
    .teams-container [class*="gridViewDrawerItemOpen"] > .conversation-sidebar > :first-child {
      width: 100% !important;
    }
  `
  return `(() => {
    const apply = () => {
      let style = document.getElementById('workbuddy-wide-sidebar-override');
      if (!style) {
        style = document.createElement('style');
        style.id = 'workbuddy-wide-sidebar-override';
        (document.head || document.documentElement).appendChild(style);
      }
      style.textContent = ${JSON.stringify(css)};
      const setLength = (element, name, value) => {
        const length = value + 'px';
        if (element.style.getPropertyValue(name) !== length) element.style.setProperty(name, length);
      };
      const syncLayout = () => {
        for (const grid of document.querySelectorAll('[data-wide-wb-grid]')) grid.removeAttribute('data-wide-wb-grid');
        for (const sidebar of document.querySelectorAll('.teams-container .teams-grid-scroll-content [data-view-id="sidebar"]')) {
          const grid = sidebar.parentElement;
          const container = sidebar.closest('.teams-container');
          const main = grid?.querySelector(':scope > [data-view-id="main-content"], :scope > [data-view-id="login-view"]');
          const nativeWidth = Number.parseFloat(sidebar.style.width);
          if (!grid || !main || container.classList.contains('sidebar-collapsed') || !(nativeWidth > 0)) continue;
          const mainLeft = Number.parseFloat(main.style.left);
          const mainWidth = Number.parseFloat(main.style.width);
          const sidebarLeft = Number.parseFloat(sidebar.style.left);
          if (![mainLeft, mainWidth, sidebarLeft].every(Number.isFinite) || mainWidth <= 0) continue;
          grid.setAttribute('data-wide-wb-grid', 'expanded');
          main.setAttribute('data-wide-wb-main', '');
          setLength(grid, '--wide-wb-native-sidebar-width', nativeWidth);
          setLength(grid, '--wide-wb-native-sidebar-left', sidebarLeft);
          setLength(grid, '--wide-wb-native-main-left', mainLeft);
          setLength(grid, '--wide-wb-native-main-width', mainWidth);
          for (const sash of grid.querySelectorAll(':scope > [class*="sash"]')) {
            const isBoundary = Math.abs(Number.parseFloat(sash.style.left) - (sidebarLeft + nativeWidth - 2)) < 1;
            sash.toggleAttribute('data-wide-wb-sidebar-sash', isBoundary);
          }
        }
      };
      window.__wideWorkbuddySidebarObserver?.disconnect();
      const selector = '.teams-container, [data-view-id], .conversation-sidebar';
      const observer = new MutationObserver(records => {
        const changed = records.some(record => record.type === 'attributes'
          ? record.target.matches(selector + ', [data-wide-wb-grid], [data-wide-wb-sidebar-sash]')
          : [...record.addedNodes, ...record.removedNodes].some(node => node instanceof Element &&
            (node.matches(selector) || node.querySelector(selector))));
        if (changed) syncLayout();
      });
      observer.observe(document.documentElement, {subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'class']});
      window.__wideWorkbuddySidebarObserver = observer;
      syncLayout();
      return true;
    };
    if (document.documentElement) return apply();
    document.addEventListener('DOMContentLoaded', apply, {once: true});
    return true;
  })()`
}
