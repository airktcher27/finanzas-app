// Service worker: la app abre sin internet.
// Con conexión siempre pide la versión más reciente; sin conexión usa la copia guardada.
const CACHE = 'finanzas-v0.11.3';
const ASSETS = [
  './', './index.html', './style.css', './app.js', './comun/store.js', './comun/crypto.js', './comun/merge.js',
  './comun/github.js', './comun/sync.js', './comun/errors.js', './money.js', './ledger.js', './defaults.js', './charts.js', './invest.js', './prices.js', './trash.js', './importer.js', './portfolio.js', './vendor/xlsx.full.min.js',
  './manifest.webmanifest', './icon-192.png', './icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

// Todas tus apps comparten el mismo origen (airktcher27.github.io): solo se borran las cachés viejas de ESTA app.
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k.startsWith('finanzas-')).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Solo archivos de la propia app; las llamadas a api.github.com van directo a la red.
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
