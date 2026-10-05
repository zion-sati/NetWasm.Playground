(() => {
  if (!window.isSecureContext || !('serviceWorker' in navigator)) return;
  const script = document.currentScript;
  if (!(script instanceof HTMLScriptElement)) return;
  const root = new URL('.', script.src);
  const reloadKey = 'netwasm-coi-reload-v1';
  if (crossOriginIsolated) sessionStorage.removeItem(reloadKey);

  void navigator.serviceWorker.register(new URL('coi-service-worker.js', root), {
    scope: root.pathname,
    updateViaCache: 'none',
  }).then(registration => {
    // WebKit can reject this best-effort freshness check while the activating
    // worker takes control. Registration itself still succeeded.
    void registration.update().catch(() => {});
    if (crossOriginIsolated || sessionStorage.getItem(reloadKey)) return;
    let reloading = false;
    const reload = () => {
      if (reloading) return;
      reloading = true;
      sessionStorage.setItem(reloadKey, '1');
      location.reload();
    };
    navigator.serviceWorker.addEventListener('controllerchange', reload, { once: true });
    if (navigator.serviceWorker.controller || registration.active) reload();
  }).catch(() => {
    // The Playground remains usable through its single-threaded tool path.
  });
})();
