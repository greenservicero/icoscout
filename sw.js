/* =====================================================================
   Service worker: tiene in cache il guscio dell'app (pagina, script,
   icone) cosi' l'app si apre anche se il PC che la serve e' spento.
   I DATI non vengono mai messi in cache: arrivano in tempo reale dal
   broker MQTT e non passano di qui.

   Quando modifichi index.html o app.js, alza il numero di VERSIONE:
   altrimenti il telefono continua a mostrare la copia vecchia.
   ===================================================================== */
var VERSIONE = "cruscotto-fv-v39";   // 08/10/2026: wss con percorso /mqtt (EMQX)
var GUSCIO = [
  "./",
  "index.html",
  "app.js",
  "mqtt.min.js",
  "manifest.webmanifest",
  "icona-192.png",
  "icona-512.png",
  "icona-maskable-512.png"
];

self.addEventListener("install", function (ev) {
  ev.waitUntil(
    caches.open(VERSIONE).then(function (c) { return c.addAll(GUSCIO); })
          .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (ev) {
  ev.waitUntil(
    caches.keys().then(function (chiavi) {
      return Promise.all(chiavi.map(function (k) {
        if (k !== VERSIONE) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (ev) {
  var r = ev.request;
  if (r.method !== "GET") return;
  var u = new URL(r.url);
  if (u.origin !== self.location.origin) return;   /* il broker non passa di qui */

  /* Rete per prima, cache come rete di salvataggio: cosi' una modifica al
     file sul PC si vede subito, ma con il PC spento l'app parte lo stesso. */
  ev.respondWith(
    fetch(r).then(function (risp) {
      var copia = risp.clone();
      caches.open(VERSIONE).then(function (c) { c.put(r, copia); }).catch(function () {});
      return risp;
    }).catch(function () {
      return caches.match(r).then(function (hit) {
        return hit || caches.match("index.html");
      });
    })
  );
});
