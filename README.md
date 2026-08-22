# Proxy en Deno Deploy

Es el mismo proxy que había en Cloudflare Workers. Se mueve porque las
operadoras españolas bloquean rangos enteros de Cloudflare durante los partidos
de LaLiga, y justo los días de jornada el Worker se quedaba inalcanzable.
Deno Deploy sirve desde Google Cloud, que no entra en esos bloqueos.

El proxy es el mismo archivo de siempre; lo único nuevo es la capa de arriba,
que le da lo que antes le daba Cloudflare (los secretos y el almacén).

## Publicarlo la primera vez

1. Entra en **console.deno.com** con tu cuenta de GitHub.
2. **New App** → conecta el repositorio de la calculadora.
3. Configura:
   - **Entrypoint**: `deno/biwenger-proxy.js`
   - **Install/Build**: nada, se deja vacío
4. En **Settings → Environment Variables**, crea las mismas que tenías en
   Cloudflare:

   | Nombre | Valor |
   |---|---|
   | `CALC_KEY` | la misma clave de siempre |
   | `BIWENGER_TOKEN` | el token, si entras con Google |
   | `ALLOWED_ORIGIN` | `https://jaimefgdev.com` |

   Si en vez de token usas contraseña, crea `BIWENGER_EMAIL` y
   `BIWENGER_PASSWORD` en lugar de `BIWENGER_TOKEN`.

5. Despliega. Te dará una dirección tipo `https://<algo>.deno.dev`.

## Comprobar que va

    https://<algo>.deno.dev/?version=1&key=TU_CLAVE

Tiene que contestar `{"version":"2026-08-22 · deno 1"}`.

## Decírselo a la web

En la calculadora: **⚙ Ajustes** → cambia la URL del proxy por la de
`.deno.dev` (sin barra al final) → **Guardar** → recargar.

## Lo que cambia respecto a Cloudflare

- **El almacén.** Deno KV no admite valores de más de 64 KiB y la respuesta de
  sincronización pasa de 80 KB, así que la capa de arriba parte los valores
  grandes en trozos y los recompone al leerlos. El resto del código no se
  entera: sigue llamando a `env.JORNADAS.get/put/delete/list` igual que antes.
- **Los secretos** salen de las variables de entorno en vez del objeto `env`
  que pasaba Cloudflare.
- **El arranque** es `Deno.serve()` en vez de `export default`.

Nada más. Las ~2.900 líneas del proxy están sin tocar.

## Volver a Cloudflare

El archivo `worker/biwenger-proxy.js` sigue ahí y funciona: si algún día
levantan los bloqueos, basta con volver a apuntar la web a la URL del Worker.
