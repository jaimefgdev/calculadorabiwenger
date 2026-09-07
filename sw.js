/* Service worker de la Calculadora.
 *
 * Solo se ocupa de los archivos de la propia app —el HTML, el CSS, el JS y las
 * tipografías— para que arranque al instante y siga abriendo sin cobertura.
 *
 * NO toca los datos. Ni el proxy, ni Biwenger, ni SofaScore, ni ESPN pasan por
 * aquí: esas respuestas cambian a cada rato y guardarlas sería justo lo que
 * llevamos semanas evitando, enseñar números viejos como si fueran de ahora.
 * Para eso la app ya tiene su propia caché, que sabe cuándo caducan.
 */

/* Se sube en cada publicación: al cambiar, el navegador tira lo guardado y se
   baja los archivos nuevos. Sin esto, un cambio en app.js podría no llegar. */
const VERSION = 'calc-v5';

/* Lo que hace falta para pintar la app aunque no haya red. */
const BASICOS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './biwenger.svg',
  './icono-192.png',
  './icono-512.png',
  './icono-splash.png',
  './GoogleSans-Regular.woff2',
  './GoogleSans-Bold.woff2'
];

self.addEventListener('install', function (evento) {
  evento.waitUntil(
    caches.open(VERSION).then(function (cache) {
      /* `reload` para saltarse la caché del navegador: si no, al instalar se
         podría guardar la versión vieja que tuviera ahí. */
      return cache.addAll(BASICOS.map(function (u) {
        return new Request(u, { cache: 'reload' });
      })).catch(function () {
        /* Si alguno falla no se aborta la instalación entera: con el resto la
           app ya arranca. */
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function (evento) {
  evento.waitUntil(
    caches.keys().then(function (nombres) {
      return Promise.all(nombres.map(function (n) {
        return n === VERSION ? null : caches.delete(n);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (evento) {
  const peticion = evento.request;
  if (peticion.method !== 'GET') return;

  const url = new URL(peticion.url);

  /* Todo lo que no sea de esta app se deja pasar tal cual: los datos del proxy,
     las fotos de Biwenger, SofaScore, las banderas… Que vayan a la red siempre. */
  if (url.origin !== self.location.origin) return;

  const esNuestro = BASICOS.some(function (b) {
    const limpio = b.replace('./', '');
    return url.pathname.endsWith('/' + limpio) ||
      (limpio === '' && url.pathname.endsWith('/'));
  });
  if (!esNuestro) return;

  /* Primero la red, y lo guardado como red de seguridad. Al revés —caché
     primero— una publicación nueva podía tardar días en llegar, que es
     exactamente el lío del `?v=` pero peor, porque ni recargando se arregla. */
  /* `reload` a propósito: sin esto, `fetch` pasa por la caché HTTP del
     navegador, y si Chrome tiene guardado el index.html viejo nos lo da a
     nosotros y nosotros se lo servimos a la página tan contentos. Publicabas y
     en el PC no cambiaba nada ni recargando, mientras que en el móvil —sin ese
     index.html guardado— sí. Así la petición sale siempre a la red de verdad. */
  const aLaRed = new Request(peticion.url, {
    cache: 'reload', credentials: 'same-origin', mode: 'same-origin'
  });

  evento.respondWith(
    fetch(aLaRed).then(function (respuesta) {
      if (respuesta && respuesta.ok) {
        const copia = respuesta.clone();
        caches.open(VERSION).then(function (cache) { cache.put(peticion, copia); });
      }
      return respuesta;
    }).catch(function () {
      return caches.match(peticion).then(function (guardada) {
        return guardada || caches.match('./index.html');
      });
    })
  );
});
