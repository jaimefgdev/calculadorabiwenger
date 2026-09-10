# Proxy Biwenger (Cloudflare Worker)

La calculadora no puede llamar a la API de Biwenger directamente: Biwenger no
devuelve cabeceras CORS, así que el navegador bloquea la petición venga de donde
venga (GitHub Pages, `file://`, localhost…). Este Worker es el intermediario.

```
GitHub Pages (calculadora)  →  Worker (esta carpeta)  →  api.biwenger
```

## Desplegarlo (5 minutos, sin instalar nada)

1. Entra en <https://dash.cloudflare.com> → **Workers & Pages** → **Create** →
   **Start with Hello World!** → ponle un nombre, p. ej. `biwenger-calc`.
2. **Deploy**, y luego **Edit code**. Borra lo que haya y pega entero el
   contenido de `biwenger-proxy.js`. **Deploy** otra vez.
3. Ve a **Settings → Variables and Secrets** y añade los *secrets* (tipo
   `Secret`, no `Text`, para que queden cifrados). Siempre este:

   | Nombre     | Valor                                           |
   |------------|-------------------------------------------------|
   | `CALC_KEY` | una clave que te inventes, larga y sin espacios |

   Y luego, según cómo entres en Biwenger:

   **a) Entras con Google** (no tienes contraseña de Biwenger)

   | Nombre           | Valor                          |
   |------------------|--------------------------------|
   | `BIWENGER_TOKEN` | tu token de sesión (ver abajo) |

   **b) Tienes usuario y contraseña propios**

   | Nombre              | Valor                     |
   |---------------------|---------------------------|
   | `BIWENGER_EMAIL`    | tu correo de Biwenger     |
   | `BIWENGER_PASSWORD` | tu contraseña de Biwenger |

   Con la opción (b) el Worker renueva la sesión solo y no vuelves a tocar nada.
   Con la (a) hay que actualizar el token cuando caduque.

### Sacar el token (opción a)

Con Biwenger abierto en el navegador y la sesión iniciada, pulsa `F12`, ve a la
pestaña **Console** y pega esto:

```js
Object.entries(localStorage)
  .map(([k, v]) => [k, (String(v).match(/eyJ[\w-]+\.[\w-]+\.[\w-]+/) || [])[0]])
  .filter(x => x[1])
```

Te devuelve el token (la cadena larga que empieza por `eyJ`). Ese es el valor de
`BIWENGER_TOKEN`. Para saber cuándo caduca, pégalo aquí entre comillas:

```js
new Date(JSON.parse(atob("PEGA_AQUI_EL_TOKEN".split('.')[1])).exp * 1000)
```

4. Opcional pero recomendable: añade una variable normal `ALLOWED_ORIGIN` con la
   URL de tu GitHub Pages (`https://usuario.github.io`). Sin ella el Worker
   acepta peticiones desde cualquier origen, protegido solo por `CALC_KEY`.

Te queda una URL del tipo `https://biwenger-calc.<tu-cuenta>.workers.dev`.

## Comprobar que va

```
https://biwenger-calc.<tu-cuenta>.workers.dev/?key=TU_CALC_KEY
```

Debería devolver un JSON con `managers` y `movements`. Si algo falla, añade
`&debug=1` y te incluye la respuesta cruda de Biwenger para ajustar el mapeo.

## Qué hace exactamente

- Hace login con tu email y contraseña **solo cuando hace falta**, y guarda el
  token en memoria. Cuando caduca, vuelve a entrar solo: tú no tocas nada nunca.
- Lee `/account` (liga y usuario), `/league?include=all` (valor de equipo y
  tamaño de plantilla de cada mánager, que son públicos) y `/board` (los
  movimientos: fichajes y ventas de todo el mundo).
- **El saldo de los demás no lo publica Biwenger**, solo el tuyo. Por eso la
  calculadora sigue deduciéndolo igual para todos: 20.000.000 € menos fichajes
  más ventas. Si tu saldo real no cuadra con el calculado, la tabla te lo marca
  con un `≠` y el detalle al pasar el ratón.
- Los nombres de los jugadores salen del endpoint público de LaLiga, porque el
  tablón solo trae identificadores numéricos.
- Solo lee. No hace pujas, ni ventas, ni cambios de ningún tipo en tu cuenta.

## Lo que conviene que sepas

- **Tu credencial queda guardada como secreto cifrado en Cloudflare** (la
  contraseña en el modo b, el token en el modo a). No viaja a la calculadora ni
  sale del Worker, pero está ahí.
- El token del modo (a) da acceso a tu cuenta mientras siga vivo: trátalo como
  una contraseña y no lo pegues en sitios públicos.
- **Quien tenga la URL y la `CALC_KEY` puede leer los datos de tu liga.** No
  puede tocar nada, pero trátala como una contraseña: no la publiques en el
  repositorio ni en capturas.
- Si algún día quieres cortar el acceso, cambia `CALC_KEY` en Cloudflare y
  vuelve a introducirla en la calculadora.
- El plan gratuito da 100.000 peticiones al día. Tú vas a hacer unas pocas
  decenas: no vas a ver un cobro.

## Guardar las jornadas para todos los dispositivos (opcional)

La calculadora guarda cada jornada en el navegador, así que el PC y el móvil
llevan copias distintas. Para que compartan memoria hay que darle al Worker un
almacén KV; sin él todo sigue funcionando igual, solo que por separado.

En el panel de Cloudflare:

1. **Storage & Databases → KV → Create a namespace**. Nombre: `jornadas`.
2. Entra en el Worker `biwenger-calc` → **Settings → Bindings → Add → KV namespace**.
3. **Variable name**: `JORNADAS` (en mayúsculas, tal cual). **KV namespace**: el
   `jornadas` que acabas de crear.
4. **Deploy**.

A partir de ahí, la alineación y el banquillo que capture cualquier dispositivo
quedan guardados en el Worker, y el resto los recibe al sincronizar. El Worker
nunca sustituye lo guardado por una respuesta más pobre: si Biwenger ya no da el
banquillo de una jornada pasada, se devuelve el que se guardó en su día.
