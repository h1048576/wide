export function droidSidebarInjection(sidebarWidth: string) {
  const width = sidebarWidth.endsWith('%') ? `${Number.parseFloat(sidebarWidth)}vw` : sidebarWidth
  const css = `
    [data-wide-droid-sidebar-frame] > [data-testid="window-sidebar"] {
      width: ${width} !important; min-width: 0 !important;
    }
    [data-wide-droid-sidebar-frame] {
      --window-history-inset: calc(var(--wide-droid-native-history-inset) + ${width} - var(--wide-droid-native-sidebar-width)) !important;
    }
    [data-wide-droid-sidebar-layout] > .split-view-container > .split-view-view:first-child {
      width: ${width} !important;
    }
    [data-wide-droid-sidebar-main] {
      left: calc(var(--wide-droid-native-main-left) + ${width} - var(--wide-droid-native-sidebar-width)) !important;
      width: max(0px, calc(var(--wide-droid-native-main-width) + var(--wide-droid-native-sidebar-width) - ${width})) !important;
    }
    [data-wide-droid-sidebar-sash] {
      left: calc(var(--wide-droid-native-sash-left) + ${width} - var(--wide-droid-native-sidebar-width)) !important;
    }`
  return `(() => {
    const apply = () => {
      window.__wideDroidSidebarGuard?.dispose();
      let style = document.getElementById('droid-wide-sidebar-override');
      if (!style) { style = document.createElement('style'); style.id = 'droid-wide-sidebar-override'; (document.head || document.documentElement).appendChild(style); }
      const css = ${JSON.stringify(css)};
      if (style.textContent !== css) style.textContent = css;
      const setLength = (el, name, value) => {
        const next = value + 'px';
        if (el.style.getPropertyValue(name) !== next) el.style.setProperty(name, next);
      };
      const scan = () => {
        for (const sidebar of document.querySelectorAll('[data-testid="window-sidebar"]')) {
          const frame = sidebar.parentElement;
          const panes = frame?.querySelector('[data-window-sidebar-panes] > .split-view');
          const views = panes?.querySelector(':scope > .split-view-container');
          const first = views?.firstElementChild, main = first?.nextElementSibling;
          const nativeWidth = Number.parseFloat(first?.style.width);
          const mainLeft = Number.parseFloat(main?.style.left), mainWidth = Number.parseFloat(main?.style.width);
          const active = sidebar.getAttribute('data-sidebar-visible') === 'true' && nativeWidth > 0 && [mainLeft, mainWidth].every(Number.isFinite);
          frame?.toggleAttribute('data-wide-droid-sidebar-frame', active);
          panes?.toggleAttribute('data-wide-droid-sidebar-layout', active);
          main?.toggleAttribute('data-wide-droid-sidebar-main', active);
          if (!panes) continue;
          for (const sash of panes.querySelectorAll(':scope > .sash-container > .sash')) {
            const sashLeft = Number.parseFloat(sash.style.left);
            const boundary = active && Math.abs(sashLeft - nativeWidth) <= 4;
            sash.toggleAttribute('data-wide-droid-sidebar-sash', boundary);
            if (boundary) setLength(sash, '--wide-droid-native-sash-left', sashLeft);
          }
          if (!active) continue;
          setLength(frame, '--wide-droid-native-sidebar-width', nativeWidth);
          setLength(main, '--wide-droid-native-main-left', mainLeft);
          setLength(main, '--wide-droid-native-main-width', mainWidth);
          const history = Number.parseFloat(frame.style.getPropertyValue('--window-history-inset'));
          setLength(frame, '--wide-droid-native-history-inset', Number.isFinite(history) ? history : nativeWidth);
        }
      };
      let animationFrame = 0;
      const selector = '[data-testid="window-sidebar"], [data-window-sidebar-panes], [data-wide-droid-sidebar-frame], [data-wide-droid-sidebar-layout], [data-wide-droid-sidebar-main], [data-wide-droid-sidebar-sash]';
      const relevant = node => node instanceof Element && (node.matches(selector) || !!node.querySelector(selector));
      const observer = new MutationObserver(records => {
        if (!records.some(record => record.type === 'attributes'
          ? record.target.matches(selector) || record.target.matches('.split-view-view, .sash') && !!record.target.closest('[data-window-sidebar-panes]')
          : [...record.addedNodes, ...record.removedNodes].some(relevant))) return;
        if (!animationFrame) animationFrame = requestAnimationFrame(() => { animationFrame = 0; scan(); });
      });
      observer.observe(document.documentElement, {subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'data-sidebar-visible']});
      window.__wideDroidSidebarGuard = {dispose: () => { observer.disconnect(); cancelAnimationFrame(animationFrame); }};
      scan(); return true;
    };
    if (document.documentElement) return apply();
    document.addEventListener('DOMContentLoaded', apply, {once: true}); return true;
  })()`
}
