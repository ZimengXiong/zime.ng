(() => {
  const connection = navigator.connection;
  if (connection?.saveData || /(^|-)2g$/.test(connection?.effectiveType || '')) return;
  const pages = [...new Set([...document.querySelectorAll('a[href]')].map(link => {
    const url = new URL(link.href);
    return url.origin === location.origin && url.pathname.endsWith('/') && url.pathname !== location.pathname ? url.pathname : null;
  }).filter(Boolean))];
  if (HTMLScriptElement.supports?.('speculationrules')) {
    const rules = document.createElement('script');
    rules.type = 'speculationrules';
    rules.textContent = JSON.stringify({
      prefetch: [{ urls: pages }],
      prerender: [{ where: { and: [{ selector_matches: 'a[href^="/"][href$="/"]' }, { not: { href_matches: location.pathname } }] }, eagerness: 'moderate' }]
    });
    document.head.append(rules);
    return;
  }
  const fetched = new Set();
  const prefetch = event => {
    const link = event.target.closest?.('a[href]');
    if (!link) return;
    const url = new URL(link.href);
    if (url.origin !== location.origin || !pages.includes(url.pathname) || fetched.has(url.pathname)) return;
    fetched.add(url.pathname);
    fetch(url.pathname, { priority: 'low', credentials: 'same-origin' }).catch(() => fetched.delete(url.pathname));
  };
  for (const event of ['pointerover', 'focusin', 'touchstart']) document.addEventListener(event, prefetch, { passive: true });
})();
