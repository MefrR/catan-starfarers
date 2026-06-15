// Minimal service worker. Its presence (plus the web manifest) is what makes
// the game installable — Chrome then offers "Install app" in the omnibox/menu
// and it lands in the app drawer / home screen.
//
// We deliberately do NOT cache responses: the game always needs the live
// multiplayer server and we deploy often, so every load should be fresh.
// Offline caching can be layered on later if we want it.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {
  // No custom response → the browser performs its normal network fetch.
});
