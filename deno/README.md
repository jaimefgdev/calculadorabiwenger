# Proxy en Deno Deploy

Es el mismo proxy que había en Cloudflare Workers. Se mueve porque las
operadoras españolas bloquean rangos enteros de Cloudflare durante los partidos
de LaLiga, y justo los días de jornada el Worker se quedaba inalcanzable.
Deno Deploy sirve desde Google Cloud, que no entra en esos bloqueos.

El proxy es el mismo archivo de siempre; lo único nuevo es la capa de arriba,
que le da lo que antes le daba Cloudflare (los secretos y el almacén).

---

# REHACER EL PROYECTO DESDE CERO

Todo lo que hace falta. Si se pierde el proyecto de Deno, con esto se levanta
otra vez sin acordarse de nada.

## 1. Crear la aplicación

1. **console.deno.com**, entrando con **GitHub**.
2. **New App** → conecta el repositorio `calculadorabiwenger`.
3. Configura:
   - **Entrypoint**: `deno/biwenger-proxy.js`
   - **Install/Build**: se deja vacío
4. Despliega. Te da una dirección tipo `https://<algo>.deno.net`.

El almacén (Deno KV) se crea solo la primera vez que el proxy escribe. No hay
que darle a nada.

## 2. Las tres variables

En **Settings → Environment Variables** del proyecto:

| Nombre | Valor |
|---|---|
| `CALC_KEY` | `Magic0real18.` |
| `BIWENGER_TOKEN` | el token de Biwenger (ver abajo cómo sacarlo) |
| `ALLOWED_ORIGIN` | `https://jaimefgdev.com` |

Si en vez de token usas correo y contraseña, pon `BIWENGER_EMAIL` y
`BIWENGER_PASSWORD` en lugar de `BIWENGER_TOKEN`. Con esa opción la sesión se
renueva sola y no hay que volver a tocarlo nunca.

### Sacar el token de Biwenger

Con **biwenger.as.com** abierto y la sesión iniciada, `F12` → pestaña
**Console**, pegar esto:

```js
Object.entries(localStorage)
  .map(([k, v]) => [k, (String(v).match(/eyJ[\w-]+\.[\w-]+\.[\w-]+/) || [])[0]])
  .filter(x => x[1])
```

Devuelve una lista; el valor largo que empieza por `eyJ` es el token.

Para saber cuándo caduca:

```js
new Date(JSON.parse(atob("PEGA_AQUI_EL_TOKEN".split('.')[1])).exp * 1000)
```

## 3. Comprobar que va

    https://<algo>.deno.net/?key=Magic0real18.&version=1

Tiene que contestar con la versión, algo como
`{"version":"2026-09-10 · deno 139", ...}`.

Y la sincronización entera:

    https://<algo>.deno.net/?key=Magic0real18.

## 4. Decírselo a la web

En la calculadora: **⚙ Ajustes** → cambiar la URL del proxy por la nueva (sin
barra al final) → **Guardar** → recargar.

O en `app.js`, la constante `PROXY_NUEVO`.

---

## Desplegar sin GitHub

Si la cuenta de Deno no está enlazada a GitHub, se despliega desde la línea de
comandos con el propio Deno:

```
deno deploy --project=<nombre> --entrypoint=deno/biwenger-proxy.js --prod
```

Necesita un token de Deno Deploy (consola → avatar → Account Settings → Access
Tokens) en la variable `DENO_DEPLOY_TOKEN`.

`deployctl` NO vale: es del Deno Deploy antiguo (dash.deno.com) y solo admite
entrar con GitHub.

---

## La cuota, que es lo que tumbó el proyecto una vez

El plan gratuito da **300.000 escrituras de KV al mes** y 600.000 lecturas.
Todo lo demás (peticiones, CPU, tráfico) va sobrado: se usaba el 1-2%.

En septiembre de 2026 se agotó y Deno suspendió la aplicación. La causa fue
que el proxy escribía **diecisiete veces por petición**:

- Deno KV no admite valores de más de 64 KB, así que los grandes se parten en
  trozos de 16 K, **y cada trozo cuenta como una escritura**. El índice de
  futbolistas son 137 KB: diez escrituras cada vez que se guardaba.
- Y se reescribía aunque no hubiera cambiado nada.

Lo que se hizo, y hay que mantener:

- **Comprimir** lo que se guarda (gzip + base64, marcado con `gz:`). El índice
  baja de 137 KB a 32 KB: de diez escrituras a cuatro.
- **No escribir si el valor es idéntico** al guardado. Las lecturas van
  sobradas, así que comparar sale a cuenta.
- Los valores que llevan la hora dentro se comparan por CONTENIDO a mano, que
  si no el sello cambia siempre y se reescriben igual.

Para vigilarlo, `?version=1` devuelve `escrituras` y `borrados` de esa
instancia. Si una petición normal deja eso en más de un puñado, hay algo
escribiendo de más.

---

## Lo que cambia respecto a Cloudflare

- **El almacén.** Deno KV no admite valores de más de 64 KiB, así que la capa
  de arriba parte los valores grandes en trozos y los recompone al leerlos. El
  resto del código no se entera: sigue llamando a
  `env.JORNADAS.get/put/delete/list` igual que antes.
- **Los secretos** salen de las variables de entorno en vez del objeto `env`
  que pasaba Cloudflare.
- **El arranque** es `Deno.serve()` en vez de `export default`.

## Volver a Cloudflare

`worker/biwenger-proxy.js` es el mismo proxy portado, y funciona. Pero **solo
como último recurso**: los días de partido las operadoras bloquean los rangos
de Cloudflare y la web se queda sin datos justo cuando más se usa.
