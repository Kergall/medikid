// Service Worker — rappel quotidien pour le DCA

const TAG = 'daily-dca-reminder';

self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// Periodic Background Sync (Android Chrome, app installée en PWA)
self.addEventListener('periodicsync', (event) => {
  if (event.tag === TAG) {
    event.waitUntil(sendReminder());
  }
});

async function sendReminder() {
  // Lit la date du dernier DCA depuis IndexedDB
  const lastDate = await idbGet('last_dca_date');
  const today = new Date().toISOString().slice(0, 10);
  if (lastDate === today) return; // déjà fait aujourd'hui

  // Vérifie si une fenêtre est déjà ouverte
  const clients = await self.clients.matchAll({ type: 'window' });
  if (clients.length > 0) {
    // App déjà ouverte → on la focus, elle gère l'exécution auto
    clients[0].focus();
    return;
  }

  // Envoie une notification locale
  await self.registration.showNotification('SOL DCA Bot', {
    body: 'Ouvre l\'app pour exécuter le DCA du jour 📈',
    icon: './icon-192.png',
    badge: './icon-192.png',
    tag: 'dca-reminder',
    renotify: true,
    data: { url: self.registration.scope },
  });
}

// Clic sur la notification → ouvre l'app
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.openWindow(event.notification.data?.url ?? self.registration.scope),
  );
});

// ─── Mini IndexedDB helper (pas d'import possible dans le SW) ────────────────

function idbGet(key) {
  return new Promise((resolve) => {
    const req = indexedDB.open('sol_dca_secure', 1);
    req.onerror = () => resolve(null);
    req.onsuccess = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('kv')) { resolve(null); return; }
      const tx  = db.transaction('kv', 'readonly');
      const get = tx.objectStore('kv').get(key);
      get.onsuccess = () => resolve(get.result ?? null);
      get.onerror   = () => resolve(null);
    };
  });
}
