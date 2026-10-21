// Minimal service worker — exists only so browsers consider this site
// "installable" (Add to Home Screen / desktop install). It does not cache
// anything, and it has no fetch handler: every request goes straight to the
// network as if there were no service worker at all (a pass-through handler
// only slowed each request down). install/activate stay so existing
// installs pick this version up right away.
self.addEventListener('install', function(event){
  self.skipWaiting();
});

self.addEventListener('activate', function(event){
  event.waitUntil(self.clients.claim());
});
