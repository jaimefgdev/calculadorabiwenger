/* ===========================================================
   Proxy Biwenger → Calculadora  ·  Deno Deploy
   -----------------------------------------------------------
   Es el mismo proxy que había en Cloudflare Workers, movido a
   Deno Deploy porque las operadoras españolas tiran rangos
   enteros de Cloudflare durante los partidos de LaLiga y el
   Worker se quedaba inalcanzable justo los días de jornada.

   Deno Deploy sirve desde Google Cloud, que no entra en esos
   bloqueos.

   Debajo va la capa que hace que el resto del archivo —el
   proxy entero, que no se ha tocado— siga funcionando igual:

     · env       · los secretos, que aquí son variables de entorno
     · JORNADAS  · el almacén, con la misma forma que el KV de
                   Cloudflare (get/put/delete/list)

   Secretos que hay que crear en Deno Deploy (Settings → Env vars):
     CALC_KEY           · la misma clave que tenías
     BIWENGER_TOKEN     · si entras con Google
     (o BIWENGER_EMAIL + BIWENGER_PASSWORD)
     ALLOWED_ORIGIN     · https://jaimefgdev.com  (opcional)
   =========================================================== */

const almacen = await Deno.openKv();

/* Deno KV no admite valores de más de 64 KiB, y la respuesta de
   sincronización pasa de 80 KB. Los valores grandes se guardan
   partidos en trozos y se recomponen al leerlos, así que quien
   llama no se entera de nada. */
const TROZO = 40 * 1024;

const JORNADAS = {
  async get(clave) {
    const cabeza = await almacen.get([clave]);
    if (cabeza.value == null) return null;
    /* Valor normal: se devuelve tal cual. */
    if (typeof cabeza.value !== 'object' || !cabeza.value.__partido) {
      return cabeza.value;
    }
    /* Partido en trozos: se juntan en orden. */
    let entero = '';
    for (let i = 0; i < cabeza.value.trozos; i++) {
      const parte = await almacen.get([clave, i]);
      if (parte.value == null) return null;   // falta un trozo: como si no hubiera nada
      entero += parte.value;
    }
    return entero;
  },

  async put(clave, valor) {
    const texto = String(valor);
    await JORNADAS.delete(clave);             // fuera lo que hubiera antes

    if (texto.length <= TROZO) {
      await almacen.set([clave], texto);
      return;
    }

    const trozos = Math.ceil(texto.length / TROZO);
    for (let i = 0; i < trozos; i++) {
      await almacen.set([clave, i], texto.slice(i * TROZO, (i + 1) * TROZO));
    }
    await almacen.set([clave], { __partido: true, trozos: trozos });
  },

  async delete(clave) {
    const cabeza = await almacen.get([clave]);
    if (cabeza.value && typeof cabeza.value === 'object' && cabeza.value.__partido) {
      for (let i = 0; i < cabeza.value.trozos; i++) await almacen.delete([clave, i]);
    }
    await almacen.delete([clave]);
  },

  /* Solo lo usa el diagnóstico ?kv=1. Las claves aquí son el primer
     elemento del array, así que se filtra por su principio. */
  async list(opciones) {
    const prefijo = (opciones || {}).prefix || '';
    const claves = [];
    for await (const entrada of almacen.list({ prefix: [] })) {
      if (entrada.key.length !== 1) continue;          // los trozos no son claves
      const nombre = String(entrada.key[0]);
      if (!prefijo || nombre.indexOf(prefijo) === 0) claves.push({ name: nombre });
    }
    return { keys: claves };
  }
};

/* Los secretos, con la misma forma que tenían en el Worker. */
const ENTORNO = {
  CALC_KEY: Deno.env.get('CALC_KEY'),
  BIWENGER_TOKEN: Deno.env.get('BIWENGER_TOKEN'),
  BIWENGER_EMAIL: Deno.env.get('BIWENGER_EMAIL'),
  BIWENGER_PASSWORD: Deno.env.get('BIWENGER_PASSWORD'),
  ALLOWED_ORIGIN: Deno.env.get('ALLOWED_ORIGIN'),
  JORNADAS: JORNADAS
};


const API = 'https://biwenger.as.com/api/v2';
const CDN = 'https://cf.biwenger.com/api/v2';
/* Un identificador propio es lo primero que se limita: se va con el de un
   navegador normal y las cabeceras que este mandaría. */
/* Marca de versión: se sube en cada cambio y se consulta con ?version=1.
   Sirve para saber desde fuera si el despliegue ha entrado o no. */
const VERSION = '2026-09-01 · deno 64';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
/**
 * Rompe la copia cacheada de Biwenger.
 *
 * Su API dice «no-store», pero el Cloudflare que tienen delante guarda copia
 * igual y a veces nos sirve una de hace horas: con la jornada en juego eso son
 * marcadores viejos, partidos sin jugar y futbolistas sin sus goles. Se le
 * cuelga un parámetro que cambia cada minuto: rompe la copia sin dispararle
 * las peticiones, que si insistimos nos limita.
 */
function fresco(url) {
  return url + (url.indexOf('?') === -1 ? '?' : '&') + '_=' + Math.floor(Date.now() / 60000);
}

/* Esto era para que el Cloudflare nuestro tampoco guardara copia. Aquí ya no
   hace nada —Deno no tiene esa caché y se limita a ignorar la opción—, pero se
   deja puesto: si algún día hubiera que volver a Cloudflare, vuelve a valer.
   Quien de verdad rompe la copia de Biwenger es fresco(), que sigue igual. */
const SIN_CACHE = { cacheTtl: 0, cacheEverything: false };

const NAVEGADOR = {
  'user-agent': UA,
  'accept': 'application/json, text/plain, */*',
  'accept-language': 'es-ES,es;q=0.9',
  'referer': 'https://biwenger.as.com/',
  'origin': 'https://biwenger.as.com'
};

/* El token vive en memoria mientras el isolate siga vivo; si caduca o
   Cloudflare recicla el proceso, se vuelve a hacer login solo. */
let cache = { token: null, account: null, players: null, playersAt: 0, prices: {},
  round: null, roundAt: 0, tv: null, tvAt: 0, calendar: null, calendarAt: 0,
  board: null, boardAt: 0, limitedUntil: 0, lastGood: null, forzar: false,
  primas: null };

const app = {
  async fetch(request, env) {
    /* ALLOWED_ORIGIN admite varios dominios separados por comas: la web puede
       servirse desde github.io y desde el dominio propio a la vez. */
    const allowed = String(env.ALLOWED_ORIGIN || '*').split(',')
      .map(function (value) { return value.trim(); })
      .filter(Boolean);
    const asked = request.headers.get('origin') || '';
    const origin = allowed.indexOf('*') !== -1
      ? '*'
      : (allowed.indexOf(asked) !== -1 ? asked : allowed[0]);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(origin) });
    }

    const url = new URL(request.url);
    const key = url.searchParams.get('key') || request.headers.get('x-calc-key');

    if (!env.CALC_KEY) return fail(500, 'Falta el secreto CALC_KEY en el Worker.', origin);
    if (key !== env.CALC_KEY) return fail(401, 'Clave incorrecta.', origin);

    try {
      /* Modo diagnóstico: ?probe=/ruta devuelve el estado y el principio de la
         respuesta de esa ruta de la API. Sirve para localizar endpoints sin
         desplegar una y otra vez. Protegido por la misma CALC_KEY. */
      const probe = url.searchParams.get('probe');
      if (probe) {
        const result = await rawApi(env, probe);
        return new Response(JSON.stringify(result), {
          headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, cors(origin))
        });
      }

      /* ?history=<idDeUsuario> devuelve el valor de equipo día a día de ese
         mánager. Va aparte porque cada jugador cuesta una petición al CDN. */
      /* ?squads=1 devuelve la plantilla de los ocho mánagers. Va aparte
         porque son ocho consultas más. */
      if (url.searchParams.get('squads')) {
        const who = await account(env);
        const headers = { 'x-league': who.leagueId, 'x-user': who.userId, 'x-version': '628' };
        const data = await allSquads(env, headers, who.leagueId, await players());
        return new Response(JSON.stringify(data), {
          headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, cors(origin))
        });
      }

      /* ?jornada=<id|actual> devuelve la clasificación de esa jornada con la
         alineación de cada mánager, y de paso el calendario completo. */
      const jornada = url.searchParams.get('jornada');
      if (jornada) {
        const who = await account(env);
        const headers = { 'x-league': who.leagueId, 'x-user': who.userId, 'x-version': '628' };
        /* «actual» no se manda tal cual: se resuelve aquí para poder
           adelantar el cambio de jornada cinco horas antes de que empiece. */
        const cual = jornada === 'actual'
          ? (await jornadaActualEfectiva().catch(function () { return null; })) || jornada
          : jornada;
        /* Con el sistema de la liga por delante: sin él, el índice se baja con
           el 1 (Biwenger a secas) y todos los puntos salen de otro sistema. */
        const sistema = await sistemaDeLaLiga(env);
        const data = await roundBoard(env, headers, cual, await players(sistema));
        return new Response(JSON.stringify(data), {
          headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, cors(origin))
        });
      }

      /* ?estadisticas=<id> resume la temporada de un futbolista: partidos,
         goles, asistencias, minutos, tarjetas y puntos dentro y fuera. */
      const ficha = url.searchParams.get('estadisticas');
      if (ficha) {
        const sistema = await sistemaDeLaLiga(env);
        const data = await playerStats(ficha, await players(sistema), sistema, env);
        if (!data) return fail(404, 'No hay ficha de ese futbolista.', origin);
        return new Response(JSON.stringify(data), {
          headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, cors(origin))
        });
      }

      /* ?partidosDe=<id> devuelve los partidos de ese futbolista, jornada a
         jornada, con el rival, el resultado y lo que hizo en cada uno. */
      const suyos = url.searchParams.get('partidosDe');
      if (suyos) {
        const data = await partidosDeJugador(env, suyos);
        return new Response(JSON.stringify(data), {
          headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, cors(origin))
        });
      }

      /* ?partidos=<jornada> devuelve los diez partidos de esa jornada con el
         resultado y, si ya se jugaron, quién jugó y qué hizo cada uno. */
      const partidos = url.searchParams.get('partidos');
      if (partidos) {
        const sistema = await sistemaDeLaLiga(env);
        const data = await matchDay(partidos, sistema, await players(sistema),
          await primasDeLaLiga(env).catch(function () { return null; }));
        if (!data) return fail(502, 'No se ha podido leer esa jornada.', origin);
        return new Response(JSON.stringify(data), {
          headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, cors(origin))
        });
      }

      /* ?recuento=1 devuelve goles, asistencias, tarjetas y demás de toda la
         competición, para los rankings. */
      if (url.searchParams.get('recuento')) {
        /* ?recuento=liga cuenta solo lo hecho estando alineado en la liga. */
        const deLaLiga = String(url.searchParams.get('recuento')) === 'liga';
        const data = await recuentoDeLaTemporada(env, request.headers, deLaLiga);
        return new Response(JSON.stringify(data), {
          headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, cors(origin))
        });
      }

      /* ?jugadores=1 devuelve la lista completa, para el buscador. */
      if (url.searchParams.get('jugadores')) {
        const data = await todosLosJugadores(env);
        return new Response(JSON.stringify(data), {
          headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, cors(origin))
        });
      }

      /* ?ranking=1 devuelve a todos los futbolistas de la competición que ya
         han jugado algo, con sus puntos y sus partidos. Para las tablas de
         quién rinde más y menos en toda LaLiga, no solo entre los ocho. */
      if (url.searchParams.get('ranking')) {
        const data = await globalRanking(env);
        return new Response(JSON.stringify(data), {
          headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, cors(origin))
        });
      }

      /* ?version=1 dice qué código está desplegado. */
      if (url.searchParams.get('version')) {
        return new Response(JSON.stringify({ version: VERSION }), {
          headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, cors(origin))
        });
      }

      /* ?kv=1 comprueba que el almacén compartido está enlazado: escribe un
         valor, lo lee y lo borra. Sirve para no descubrir en la jornada 1 que
         faltaba el binding. */
      if (url.searchParams.get('kv')) {
        const salida = { enlazado: !!env.JORNADAS, escribe: false, lee: false, guardadas: [] };
        if (env.JORNADAS) {
          const sello = 'prueba-' + Date.now();
          try {
            await env.JORNADAS.put('prueba', sello);
            salida.escribe = true;
            salida.lee = (await env.JORNADAS.get('prueba')) === sello;
            await env.JORNADAS.delete('prueba');
            const lista = await env.JORNADAS.list({ prefix: 'jornada-' });
            salida.guardadas = (lista.keys || []).map(function (k) { return k.name; });
          } catch (error) { salida.error = String(error.message || error); }
        }
        return new Response(JSON.stringify(salida), {
          headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, cors(origin))
        });
      }

      /* ?precios=id,id,...&dia=AAAA-MM-DD devuelve lo que valía cada uno ese
         día. Se pide plantilla a plantilla para no pasarse de subpeticiones. */
      const precios = url.searchParams.get('precios');
      if (precios) {
        const dia = url.searchParams.get('dia') || '';
        const data = await pricesOnDay(precios.split(',').slice(0, 40), dia, await players());
        return new Response(JSON.stringify(data), {
          headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, cors(origin))
        });
      }

      /* ?mercado=1: quién está en el mercado, de quién es y cuántas pujas
         lleva. Las pujas son una consulta por jugador, así que va aparte de la
         sincronización normal. */
      if (url.searchParams.get('mercado')) {
        /* Si Biwenger corta —su tregua por consultar de más—, se sirve el
           último mercado bueno marcado como viejo, en vez de dejar la pestaña
           con un error y nada que mirar. Es lo mismo que ya se hacía con la
           sincronización principal. */
        let data;
        try {
          const who = await account(env);
          const headers = { 'x-league': who.leagueId, 'x-user': who.userId, 'x-version': '628' };
          data = await marketBoard(env, headers, who.userId, await players());
          cache.mercado = data;
          await guardarSiCambia(env, 'ultimo-mercado', JSON.stringify(data),
            JSON.stringify(Object.assign({}, data, { updatedAt: null })));
        } catch (error) {
          const guardado = cache.mercado || await (async function () {
            if (!env.JORNADAS) return null;
            try {
              const crudo = await env.JORNADAS.get('ultimo-mercado');
              return crudo ? JSON.parse(crudo) : null;
            } catch (e) { return null; }
          })();

          if (!guardado) throw error;
          data = Object.assign({}, guardado, {
            stale: true,
            warning: String((error && error.message) || error)
          });
        }
        return new Response(JSON.stringify(data), {
          headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, cors(origin))
        });
      }

      /* ?pujas=<jugador>[&de=<vendedor>] dice cuántas pujas lleva ese futbolista
         en el mercado. Es la misma llamada que hace su propia web al pulsar
         «ver pujas»: POST /market/bids. Va aparte y solo cuando se pide desde
         la web, porque puede costar un crédito de la cuenta. */
      const cuantasPujas = url.searchParams.get('pujas');
      if (cuantasPujas) {
        const data = await pujasDeUnJugador(env, cuantasPujas, url.searchParams.get('de'));
        return new Response(JSON.stringify(data), {
          headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, cors(origin))
        });
      }

      /* ?historial=id,id,... devuelve la serie de precios de cada jugador,
         para dibujar su evolución en la ficha de la plantilla. */
      const historial = url.searchParams.get('historial');
      if (historial) {
        /* Con `dias=todo` va la serie entera, desde el primer día que el
           futbolista apareció en el mercado. Si no, el tope que se pida. */
        const pedido = url.searchParams.get('dias');
        const dias = pedido === 'todo' ? Infinity : Math.min(Number(pedido) || 45, 2000);
        const data = await priceSeries(historial.split(',').slice(0, 30), dias, await players());
        return new Response(JSON.stringify(data), {
          headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, cors(origin))
        });
      }

      /* ?raw=/ruta pregunta a Biwenger sin pasar por la tregua interna, para
         poder ver qué contesta de verdad cuando algo falla. */
      const raw = url.searchParams.get('raw');
      if (raw) {
        const token = cache.token || await login(env);
        const respuesta = await fetch(API + raw, {
          headers: Object.assign({}, NAVEGADOR, { 'authorization': 'Bearer ' + token })
        });
        const texto = await respuesta.text();
        return new Response(JSON.stringify({
          ruta: raw,
          status: respuesta.status,
          reintentar: respuesta.headers.get('retry-after'),
          cuerpo: texto.slice(0, 300)
        }), { headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, cors(origin)) });
      }

      /* POST ?guardar=1 con una respuesta buena en el cuerpo: la deja en el KV
         para servirla mientras Biwenger no conteste. */
      if (url.searchParams.get('guardar') && request.method === 'POST') {
        if (!env.JORNADAS) return fail(500, 'No hay almacén KV enlazado.', origin);
        const cuerpo = await request.text();
        await env.JORNADAS.put('ultima-sincronizacion', cuerpo);
        return new Response(JSON.stringify({ guardado: cuerpo.length }), {
          headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, cors(origin))
        });
      }

      /* ?operacion=1 (POST) es lo único que escribe en Biwenger: aceptar o
         rechazar una oferta, devolver al futbolista al mercado y pujar. Va
         siempre con confirmación desde la web; aquí no se hace nada solo. */
      if (url.searchParams.get('operacion')) {
        if (request.method !== 'POST') return fail(405, 'Esta ruta solo acepta POST.', origin);
        const orden = await request.json().catch(function () { return null; });
        if (!orden || !orden.accion) return fail(400, 'Falta qué hacer.', origin);
        const hecho = await operarEnBiwenger(env, orden);
        return new Response(JSON.stringify(hecho), {
          headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, cors(origin))
        });
      }

      /* ?alineacion=1 comparte tu alineación entre el PC y el móvil. En GET la
         devuelve y en POST la guarda; gana siempre la más reciente, así que se
         manda con su hora y aquí solo se pisa si viene más nueva. */
      if (url.searchParams.get('alineacion')) {
        if (!env.JORNADAS) return fail(500, 'No hay almacén KV enlazado.', origin);
        const who = await account(env);
        const clave = 'alineacion-' + who.userId;

        if (request.method === 'POST') {
          const entrante = await request.json().catch(function () { return null; });
          if (!entrante || !entrante.savedAt) return fail(400, 'Alineación sin fecha.', origin);

          const guardada = await env.JORNADAS.get(clave).then(function (raw) {
            try { return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
          });

          if (guardada && guardada.savedAt > entrante.savedAt) {
            return new Response(JSON.stringify({ lineup: guardada, guardado: false }), {
              headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, cors(origin))
            });
          }

          await env.JORNADAS.put(clave, JSON.stringify(entrante));
          return new Response(JSON.stringify({ lineup: entrante, guardado: true }), {
            headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, cors(origin))
          });
        }

        const raw = await env.JORNADAS.get(clave);
        let lineup = null;
        try { lineup = raw ? JSON.parse(raw) : null; } catch (error) { lineup = null; }
        return new Response(JSON.stringify({ lineup: lineup }), {
          headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, cors(origin))
        });
      }

      const history = url.searchParams.get('history');
      if (history) {
        const who = await account(env);
        const headers = { 'x-league': who.leagueId, 'x-user': who.userId, 'x-version': '628' };
        const names = await players();
        const data = await teamValueHistory(env, headers, history, names);
        return new Response(JSON.stringify(data), {
          headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, cors(origin))
        });
      }

      /* Si Biwenger corta, se devuelve la última respuesta buena guardada en el
         KV, marcada como vieja, en vez de dejar la web en blanco. */
      let data;
      try {
        cache.forzar = url.searchParams.get('force') === '1';
        data = await build(env, url.searchParams.get('debug') === '1');
        cache.lastGood = data;
        /* Solo si cambió algo. Esta copia es la red de seguridad para cuando
           Biwenger corta, no un registro: reescribirla en cada visita con lo
           mismo era el mayor gasto del almacén. */
        await guardarSiCambia(env, 'ultima-sincronizacion', JSON.stringify(data),
          JSON.stringify(Object.assign({}, data, { updatedAt: null, generatedAt: null })));
      } catch (error) {
        const guardada = cache.lastGood || await (async function () {
          if (!env.JORNADAS) return null;
          try {
            const raw = await env.JORNADAS.get('ultima-sincronizacion');
            return raw ? JSON.parse(raw) : null;
          } catch (e) { return null; }
        })();

        if (!guardada) throw error;
        guardada.stale = true;
        guardada.warning = 'Biwenger no responde ahora mismo; estos datos son de ' +
          (guardada.updatedAt || 'antes') + '.';
        return new Response(JSON.stringify(guardada), {
          headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, cors(origin))
        });
      }

      return new Response(JSON.stringify(data), {
        headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, cors(origin))
      });
    } catch (error) {
      return fail(502, String(error && error.message || error), origin);
    }
  }
};

export default app;

function cors(origin) {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-headers': 'x-calc-key,content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'vary': 'Origin',
    'cache-control': 'no-store'
  };
}

function fail(status, message, origin) {
  return new Response(JSON.stringify({ error: message }), {
    status: status,
    headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, cors(origin))
  });
}

/* ---------- Autenticación ---------- */

/** ¿Cuentas con contraseña propia, o solo con un token pegado a mano? */
function tokenMode(env) {
  return !!env.BIWENGER_TOKEN && !(env.BIWENGER_EMAIL && env.BIWENGER_PASSWORD);
}

async function login(env) {
  /* Cuenta creada con Google: no hay contraseña que guardar, así que se usa
     el token tal cual. Cuando caduque hay que actualizar el secreto. */
  if (tokenMode(env)) {
    cache.token = env.BIWENGER_TOKEN.replace(/^Bearer\s+/i, '').trim();
    return cache.token;
  }

  if (!env.BIWENGER_EMAIL || !env.BIWENGER_PASSWORD) {
    throw new Error('Falta autenticación: crea BIWENGER_TOKEN, o bien BIWENGER_EMAIL y BIWENGER_PASSWORD.');
  }
  const response = await fetch(API + '/auth/login', {
    method: 'POST',
    headers: Object.assign({}, NAVEGADOR, { 'content-type': 'application/json' }),
    body: JSON.stringify({ email: env.BIWENGER_EMAIL, password: env.BIWENGER_PASSWORD })
  });
  const body = await response.json().catch(function () { return null; });
  if (!response.ok || !body || !body.token) {
    throw new Error('Login rechazado por Biwenger (' + response.status + ').');
  }
  cache.token = body.token;
  cache.account = null;
  return body.token;
}

/** Llama a la API con el token; si responde 401, reintenta una vez tras relogin. */
async function api(env, path, extra) {
  /* Si Biwenger ya nos ha cortado, no se le vuelve a llamar hasta que pase el
     castigo: seguir insistiendo alarga el bloqueo. */
  if (cache.limitedUntil && Date.now() < cache.limitedUntil && !cache.forzar) {
    const quedan = Math.ceil((cache.limitedUntil - Date.now()) / 1000);
    throw new Error('Biwenger ha limitado las consultas. Se reintenta en ' + quedan + ' s.');
  }

  const token = cache.token || await login(env);

  const call = async function (auth) {
    const headers = Object.assign({}, NAVEGADOR, {
      'authorization': 'Bearer ' + auth
    }, extra || {});
    return fetch(API + path, { headers: headers });
  };

  let response = await call(token);

  /* 429 = Biwenger pide calma. Se espera un momento y se reintenta una vez;
     si insiste, se avisa con claridad en vez de soltar un error técnico. */
  if (response.status === 429) {
    await new Promise(function (listo) { setTimeout(listo, 1200); });
    response = await call(token);
    if (response.status === 429) {
      /* Cinco minutos de tregua: durante ese rato no se llama a Biwenger. */
      cache.limitedUntil = Date.now() + 90 * 1000;
      throw new Error('Biwenger ha limitado las consultas. Se reintenta en un minuto y medio.');
    }
  }

  if (response.status === 401 || response.status === 403) {
    if (tokenMode(env)) {
      throw new Error('El token de Biwenger ya no vale (caducado o revocado). ' +
        'Saca uno nuevo del navegador y actualiza el secreto BIWENGER_TOKEN.');
    }
    response = await call(await login(env));
  }
  if (!response.ok) throw new Error('Biwenger ' + response.status + ' en ' + path);

  const body = await response.json();
  return body.data === undefined ? body : body.data;
}

/**
 * Llamada que escribe (POST/PUT/DELETE). Va aparte de api() a propósito: esa
 * solo lee y se puede reintentar a ciegas; esto mueve dinero y plantilla, así
 * que se hace una vez, con el mensaje de Biwenger tal cual si algo falla.
 */
async function apiEscribe(env, metodo, ruta, cuerpo) {
  const who = await account(env);

  const llamada = async function (auth) {
    return fetch(API + ruta, {
      method: metodo,
      headers: Object.assign({}, NAVEGADOR, {
        'authorization': 'Bearer ' + auth,
        'content-type': 'application/json',
        'x-league': who.leagueId,
        'x-user': who.userId,
        'x-version': '628'
      }),
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo)
    });
  };

  let response = await llamada(cache.token || await login(env));
  /* El token caducado se renueva una vez; el resto de errores se cuentan. */
  if ((response.status === 401 || response.status === 403) && !tokenMode(env)) {
    response = await llamada(await login(env));
  }

  const crudo = await response.text();
  let body = null;
  try { body = crudo ? JSON.parse(crudo) : null; } catch (error) { body = null; }

  if (!response.ok) {
    const dicho = body && (body.message ||
      (body.meta && (body.meta.userMessage || body.meta.message)));
    /* El código importa: 400 es un cuerpo mal montado y 409 suele ser «ya no
       puedes tocar esto». Sin él, «Unexpected error» no dice nada. */
    const fallo = new Error((dicho || 'Biwenger ha dicho que no') + ' (' + response.status + ')');
    fallo.estado = response.status;
    fallo.crudo = crudo ? crudo.slice(0, 300) : '';
    throw fallo;
  }
  return body && body.data !== undefined ? body.data : body;
}

/**
 * Las cuatro cosas que se pueden hacer desde la web. Los nombres de campo son
 * los de Biwenger, sacados de su propia aplicación:
 *   · aceptar/rechazar → PUT /offers/<id> {status}
 *   · devolver         → POST /market {type:'sell', rejectOffers:true}, que es
 *                        justo lo que hace su botón de renovar: tumba las
 *                        ofertas recibidas y lo deja en venta al mismo precio
 *   · pujar            → POST /offers {type, amount, to, requestedPlayers}
 *   · retirar          → DELETE /offers/<id>
 */
async function operarEnBiwenger(env, orden) {
  const accion = String(orden.accion);

  if (accion === 'aceptar' || accion === 'rechazar') {
    if (!orden.id) return { hecho: false, error: 'Falta la oferta.' };
    const estado = accion === 'aceptar' ? 'accepted' : 'rejected';
    const respuesta = await apiEscribe(env, 'PUT', '/offers/' + encodeURIComponent(orden.id),
      { status: estado });
    return { hecho: true, accion: accion, estado: (respuesta && respuesta.status) || estado };
  }

  if (accion === 'devolver') {
    const precio = Math.round(Number(orden.price));
    if (!orden.player || !(precio > 0)) return { hecho: false, error: 'Falta el futbolista o el precio.' };
    await apiEscribe(env, 'POST', '/market',
      { type: 'sell', player: Number(orden.player), price: precio, rejectOffers: true });
    return { hecho: true, accion: accion, price: precio };
  }

  if (accion === 'alinear') {
    const once = orden.players || [];
    if (once.length === 0) return { hecho: false, error: 'No hay alineación que mandar.' };

    const who = await account(env);
    const jornada = orden.round != null ? orden.round
      : ((await nextRound().catch(function () { return null; })) || {}).id;
    if (jornada == null) return { hecho: false, error: 'No sé a qué jornada mandarla.' };

    const numero = function (valor) { return valor == null || valor === '' ? null : Number(valor); };
    const titulares = once.map(numero);
    const cabeceras = { 'x-league': who.leagueId, 'x-user': who.userId, 'x-version': '628' };

    /* Los suplentes no se tocan: se leen los que ya tienes puestos y se le
       devuelven igual, porque su API los espera en el cuerpo. */
    const antes = await api(env, '/user?fields=lineup', cabeceras).catch(function () { return null; });
    const suplentes = (((antes || {}).lineup || {}).reserves || [])
      .map(function (suplente) { return suplente && suplente.id != null ? Number(suplente.id) : null; })
      .filter(function (id) { return id != null; });

    const alineacion = { type: orden.type, playersID: titulares, reservesID: suplentes };
    const capitan = numero(orden.captain);
    if (capitan != null && titulares.indexOf(capitan) !== -1) alineacion.captain = capitan;

    /* Esta es la ruta de guardar de siempre, la que usa su propia web:
       PUT /user con la alineación entera. La de /roundLineup es solo para
       tocarla con la jornada en marcha, y contesta 500 si se usa para esto. */
    let respuesta = null;
    let guardada = false;      // una respuesta vacía también vale como buena
    const intentos = [];
    const probar = async function (nombre, metodo, ruta, cuerpo) {
      if (guardada) return;
      try {
        respuesta = await apiEscribe(env, metodo, ruta, cuerpo);
        guardada = true;
        intentos.push(nombre + ': bien');
      } catch (error) {
        intentos.push(nombre + ': ' + (error.message || error));
      }
    };

    await probar('/user', 'PUT', '/user?fields=*,lineup(date)', { lineup: alineacion });
    await probar('/user sin suplentes', 'PUT', '/user?fields=*,lineup(date)',
      { lineup: { type: orden.type, playersID: titulares } });
    await probar('roundLineup', 'PUT', '/user/' + who.userId + '/roundLineup',
      { round: Number(jornada), lineup: { type: orden.type, playersID: titulares } });

    if (!guardada) {
      return {
        hecho: false,
        error: intentos[intentos.length - 1] || 'Biwenger no ha aceptado la alineación.',
        intentos: intentos,
        enviado: alineacion
      };
    }

    /* No basta con que conteste bien: se vuelve a leer la alineación para
       comprobar que de verdad ha quedado puesta. Así, si Biwenger la ignora,
       se dice en vez de cantar victoria. */
    const despues = await api(env, '/user?fields=lineup', cabeceras).catch(function () { return null; });
    const puesta = ((despues && despues.lineup && despues.lineup.players) || [])
      .map(function (jugador) { return jugador && jugador.id != null ? String(jugador.id) : null; });

    const pedida = titulares.map(function (id) { return id == null ? null : String(id); });
    const igual = puesta.length === pedida.length && puesta.every(function (id, i) { return id === pedida[i]; });

    return {
      hecho: true,
      accion: accion,
      round: Number(jornada),
      type: orden.type,
      /* Lo que hay ahora mismo en Biwenger, para que la web lo cuente. */
      comprobada: igual,
      guardada: puesta,
      intentos: intentos,
      sistema: (despues && despues.lineup && despues.lineup.type) || null,
      respuesta: respuesta || null
    };
  }

  if (accion === 'vender') {
    /* Poner o renovar la venta de uno de los tuyos. Con rechazar, además tumba
       las ofertas que tuviera, que es lo que hace su botón de renovar. */
    const precio = Math.round(Number(orden.price));
    if (!orden.player || !(precio > 0)) return { hecho: false, error: 'Falta el futbolista o el precio.' };
    await apiEscribe(env, 'POST', '/market', {
      type: 'sell',
      player: Number(orden.player),
      price: precio,
      rejectOffers: !!orden.rechazar
    });
    return { hecho: true, accion: accion, price: precio };
  }

  if (accion === 'quitar') {
    if (!orden.player) return { hecho: false, error: 'Falta el futbolista.' };
    await apiEscribe(env, 'DELETE', '/market?player=' + encodeURIComponent(orden.player));
    return { hecho: true, accion: accion };
  }

  if (accion === 'pujar') {
    const importe = Math.round(Number(orden.amount));
    if (!orden.player || !(importe > 0)) return { hecho: false, error: 'Falta el futbolista o el importe.' };
    const cuerpo = {
      type: orden.tipo === 'bid' ? 'bid' : 'purchase',
      amount: importe,
      to: orden.to != null && orden.to !== '' ? Number(orden.to) : null,
      requestedPlayers: [Number(orden.player)]
    };
    /* Editar una puja ya enviada es el mismo cuerpo, pero por PUT. */
    const respuesta = orden.id
      ? await apiEscribe(env, 'PUT', '/offers/' + encodeURIComponent(orden.id), cuerpo)
      : await apiEscribe(env, 'POST', '/offers', cuerpo);
    return { hecho: true, accion: accion, amount: importe, estado: respuesta && respuesta.status };
  }

  if (accion === 'retirar') {
    if (!orden.id) return { hecho: false, error: 'Falta la puja.' };
    await apiEscribe(env, 'DELETE', '/offers/' + encodeURIComponent(orden.id));
    return { hecho: true, accion: accion };
  }

  return { hecho: false, error: 'No sé hacer eso: ' + accion };
}

/**
 * Cuántas pujas lleva un futbolista que está en el mercado.
 *
 * Es la llamada de su propia web (`POST /market/bids`), con el vendedor cuando
 * lo vende un mánager y sin él cuando sale del mercado libre. Solo funciona si
 * la liga tiene puesto `marketShowBids`, y nunca por lo que vendes tú: de lo
 * tuyo las pujas ya se ven enteras en las ofertas recibidas.
 *
 * La respuesta de Biwenger unas veces es el número pelado y otras la lista de
 * pujas, así que aquí se devuelven las dos cosas ya resueltas.
 */
async function pujasDeUnJugador(env, jugador, vendedor) {
  const cuerpo = { player: Number(jugador) };
  if (vendedor != null && vendedor !== '') cuerpo.user = Number(vendedor);

  try {
    const respuesta = await apiEscribe(env, 'POST', '/market/bids', cuerpo);

    const lista = Array.isArray(respuesta) ? respuesta
      : (respuesta && Array.isArray(respuesta.bids) ? respuesta.bids : null);
    const cuantas = lista ? lista.length
      : (typeof respuesta === 'number' ? respuesta
        : (respuesta && typeof respuesta.bids === 'number' ? respuesta.bids
          : (respuesta && typeof respuesta.count === 'number' ? respuesta.count : null)));

    return { player: String(jugador), bids: cuantas, lista: lista || null };
  } catch (error) {
    return {
      player: String(jugador), bids: null, lista: null,
      error: String((error && error.message) || error)
    };
  }
}

/** Como api(), pero sin lanzar: devuelve estado y principio del cuerpo. */
async function rawApi(env, path) {
  const token = cache.token || await login(env);
  const who = await account(env);
  const response = await fetch(API + path, {
    headers: Object.assign({}, NAVEGADOR, {
      'authorization': 'Bearer ' + token,
      'x-league': who.leagueId,
      'x-user': who.userId,
      'x-version': '628'
    })
  });
  const text = await response.text();
  /* 1500 caracteres se quedaban en el cuarto mánager de la clasificación y no
     dejaban ver el resto: con la clasificación entera son unos 6 KB. */
  return { path: path, status: response.status, body: text.slice(0, 20000) };
}

/** Liga y usuario activos del token. */
async function account(env) {
  if (cache.account) return cache.account;
  const data = await api(env, '/account');
  const league = data && (data.league || (data.leagues && data.leagues[0]));
  if (!league || !league.id) throw new Error('La cuenta no tiene ninguna liga activa.');
  let userId = String((league.user && league.user.id) || (data.user && data.user.id) || '');

  /* Sin id de usuario no se puede distinguir una puja enviada de una recibida,
     así que se pregunta directamente si /account no lo ha traído. */
  if (!userId) {
    try {
      const me = await api(env, '/user?fields=id', { 'x-league': String(league.id) });
      userId = String((me && me.id) || '');
    } catch (error) { /* se sigue sin id */ }
  }

  cache.account = { leagueId: String(league.id), userId: userId };
  return cache.account;
}

/* ---------- Nombres de jugadores (endpoint público, sin token) ---------- */

async function players(score) {
  /* Cada liga puntúa con un sistema y los puntos cambian con él: esta juega
     con el 5, la media del AS y SofaScore, y sin pedirlo llegarían los del 1,
     que son los de Biwenger a secas. */
  const sistema = score || cache.score || 1;

  /* Aquí vienen los puntos, que suben durante los partidos, así que con algo
     rodando se mira cada diez minutos. Pero fuera de los partidos esos puntos
     no se mueven en horas, y esta descarga son 220 KB: repetirla cada diez
     minutos de madrugada, con la web preguntando cada minuto, es lo que llena
     la cuota de tráfico sin que cambie un solo dato. */
  const rodando = !!(cache.round && cache.round.live);
  const vigencia = rodando ? 10 * 60 * 1000 : 60 * 60 * 1000;
  const fresh = cache.players && cache.playersScore === sistema &&
    Date.now() - cache.playersAt < vigencia;
  if (fresh) return cache.players;

  /* Este índice es la columna vertebral de todo: de él salen los nombres, los
     precios, los puestos y los equipos. Si la descarga falla y se devuelve
     vacío, la web entera se queda en «Jugador 1679» a 0 €. Así que se reintenta
     una vez —el fallo típico es un límite de consultas momentáneo de
     Biwenger— y, si tampoco, se sirve el último bueno aunque esté pasado: un
     índice de hace una hora es infinitamente mejor que ninguno. */
  let response = await fetch(fresco(CDN + '/competitions/la-liga/data?lang=es&score=' +
    encodeURIComponent(sistema)), { headers: NAVEGADOR, cf: SIN_CACHE })
    .catch(function () { return null; });
  apuntarCorteDelCdn(response);
  if (!response || !response.ok) {
    await new Promise(function (listo) { setTimeout(listo, 1500); });
    response = await fetch(fresco(CDN + '/competitions/la-liga/data?lang=es&score=' +
      encodeURIComponent(sistema)), { headers: NAVEGADOR, cf: SIN_CACHE })
      .catch(function () { return null; });
  }
  /* Ni con el reintento: se tira de lo que haya, primero de memoria y luego de
     la copia del KV. Y se deja `playersAt` dos minutos atrás del vencimiento
     para volver a intentarlo pronto, en vez de quedarse una hora con lo viejo. */
  const deReserva = async function () {
    if (cache.players && Object.keys(cache.players).length) return cache.players;
    const guardado = await indiceDeReserva(sistema);
    if (!guardado) return cache.players || {};
    cache.players = guardado;
    cache.playersScore = sistema;
    cache.playersAt = Date.now() - vigencia + 2 * 60 * 1000;
    return guardado;
  };

  if (!response || !response.ok) return await deReserva();

  const body = await response.json().catch(function () { return {}; });
  const source = (body.data && body.data.players) || {};
  /* Una respuesta buena pero sin futbolistas dentro tampoco vale: es lo que
     contesta Biwenger cuando corta las consultas, y guardarla dejaba la web sin
     nombres durante una hora entera. */
  if (!Object.keys(source).length) return await deReserva();
  const names = {};
  Object.keys(source).forEach(function (id) {
    names[id] = source[id].name;
    names[id + ':slug'] = source[id].slug;
    names[id + ':price'] = source[id].price;   // valor de mercado de hoy
    /* 1 POR · 2 DEF · 3 MED · 4 DEL. Hay 107 jugadores con doble posición:
       Biwenger la guarda aparte, en altPositions. */
    names[id + ':pos'] = source[id].position;
    names[id + ':alt'] = (source[id].altPositions || []).join(',');
    /* Club real del futbolista: con él se pinta el escudo. */
    names[id + ':team'] = source[id].teamID != null ? source[id].teamID : null;
    /* ok · injured · sanctioned · doubt · discarded */
    names[id + ':status'] = source[id].status || null;
    /* El detalle del parte médico o de la sanción, tal como lo escribe
       Biwenger: «Lesión en el bíceps femoral. Retorno estimado: Mediados de
       enero», «Roja directa»... Solo viene cuando no está sano. */
    names[id + ':statusInfo'] = source[id].statusInfo || null;
    names[id + ':inc'] = source[id].priceIncrement != null ? source[id].priceIncrement : 0;
    names[id + ':pts'] = source[id].points != null ? source[id].points : null;
    names[id + ':ptsPrev'] = source[id].pointsLastSeason != null ? source[id].pointsLastSeason : null;
    /* `fitness` trae un valor por jornada ya jugada por su equipo (un número,
       `null` si no jugó o estaba lesionado), y las manda DE LA MÁS NUEVA A LA
       MÁS VIEJA: fitness[0] es la última que jugó. Aquí se le da la vuelta y
       se guarda en orden de calendario, que es como se lee en todos lados.
       Antes se cogía la última posición del array creyendo que era la más
       reciente, y era justo la contraria: por eso en la jornada 2 salían las
       notas de la 1. De aquí salen los puntos de cada jornada, que es lo
       único que cuadra con lo que enseña Biwenger; los del detalle de jornada
       van y vienen y no traen `rawStats` con el que comprobarlos. */
    const partidos = (source[id].fitness || []).slice().reverse();
    const ultimo = partidos.length ? partidos[partidos.length - 1] : null;
    names[id + ':jornada'] = typeof ultimo === 'number' ? ultimo : null;
    /* Partidos jugados en la temporada, para la ficha de cada plantilla. */
    names[id + ':jug'] = (source[id].playedHome || 0) + (source[id].playedAway || 0);
    names[id + ':jugCasa'] = source[id].playedHome || 0;
    names[id + ':jugFuera'] = source[id].playedAway || 0;
    names[id + ':ptsCasa'] = source[id].pointsHome || 0;
    names[id + ':ptsFuera'] = source[id].pointsAway || 0;
    /* Biwenger tiene una segunda foto, más trabajada, para un puñado de
       destacados: la anuncia con `iconHero` y es la que usa en su once ideal.
       La ruta siempre es la misma («i/p/hero/<id>.png»), así que basta con
       saber quién la tiene y la web ya la compone. */
    names[id + ':hero'] = !!source[id].iconHero;
    /* El dorsal, por si la ficha de LaLiga no lo trae. */
    names[id + ':num'] = source[id].number != null ? source[id].number : null;
    /* Las últimas jornadas suyas, para dibujar su racha. Los huecos («injured»,
       null) se guardan como null: se pintan igual, pero sin nota. */
    names[id + ':fit'] = partidos.map(function (nota) {
      return typeof nota === 'number' ? nota : null;
    });
  });

  /* Nombre de cada club, para el título del escudo. */
  const teams = (body.data && body.data.teams) || {};
  Object.keys(teams).forEach(function (id) {
    names['team:' + id] = teams[id].name || '';
  });

  cache.players = names;
  cache.playersAt = Date.now();
  cache.playersScore = sistema;

  /* Copia en el KV, como mucho cada seis horas. Son 121 KiB —cuatro trozos— y
     veinte escrituras al día: nada. Sirve para que un corte de Biwenger no deje
     la web ciega: sin índice no hay nombres ni precios, y todo sale como
     «Jugador 19441» a 0 €. Los precios de una copia de hace horas no son los de
     hoy, pero se parecen; ningún nombre es infinitamente peor. */
  if (JORNADAS && Date.now() - (cache.indiceAt || 0) > 6 * 60 * 60 * 1000) {
    cache.indiceAt = Date.now();
    JORNADAS.put('indice-' + sistema, JSON.stringify(names))
      .catch(function () { cache.indiceAt = 0; });   // si falla, se reintenta
  }
  return names;
}

/** El último índice bueno que se guardó, para cuando Biwenger no contesta. */
async function indiceDeReserva(sistema) {
  if (!JORNADAS) return null;
  try {
    const crudo = await JORNADAS.get('indice-' + sistema);
    if (!crudo) return null;
    const guardado = JSON.parse(crudo);
    return Object.keys(guardado).length ? guardado : null;
  } catch (error) {
    return null;
  }
}

/* ---------- Guía de televisión ----------
   Biwenger da rival, hora y estadio, pero no el canal. La saco de
   futbolenlatv.es, que publica cada partido con un bloque schema.org:
   de ahí salen el instante exacto (UTC) y la lista de canales. Si la
   página cambia o falla, los partidos se siguen viendo sin canal. */

const TV_URL = 'https://www.futbolenlatv.es/competicion/la-liga';

function decodeEntities(text) {
  return String(text)
    .replace(/&#(\d+);/g, function (m, code) { return String.fromCharCode(Number(code)); })
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
}

/* Emisores de verdad; lo demás son enlaces de "ver en directo", la señal
   para bares y los duplicados en HDR. */
function cleanChannel(name) {
  const text = decodeEntities(name).replace(/\s*\([^)]*\)\s*$/, '').trim();
  if (/ver en directo|ver gratis|ver partido|app gratis|tv bar|hdr/i.test(text)) return null;
  return text.replace(/LALIGA/g, 'LaLiga');
}

/* Los dos sitios escriben los nombres distinto ("Sevilla" / "Sevilla FC",
   "Betis" / "Real Betis"). Se comparan por palabras, ignorando las siglas. */
const NAME_NOISE = { fc: 1, cf: 1, cd: 1, ud: 1, sd: 1, sad: 1, club: 1, de: 1, ea: 1, sports: 1 };
const NAME_ALIAS = { atletico: 'at madrid' };

function teamWords(name) {
  let text = decodeEntities(name).toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (NAME_ALIAS[text]) text = NAME_ALIAS[text];
  return text.split(' ').filter(function (word) { return word && !NAME_NOISE[word]; });
}

function sameTeam(a, b) {
  const x = teamWords(a);
  const y = teamWords(b);
  if (!x.length || !y.length) return false;
  const inside = function (small, big) {
    return small.every(function (word) { return big.indexOf(word) !== -1; });
  };
  return inside(x, y) || inside(y, x);
}


/** Las demarcaciones de repuesto de un futbolista, ya en numeros. */
function otrosPuestos(names, id) {
  const guardadas = names[String(id) + ':alt'];
  return guardadas ? guardadas.split(',').map(Number) : [];
}

/** Listado de partidos con canal: instante, equipos y emisora principal. */
async function tvGuide() {
  if (cache.tv && Date.now() - cache.tvAt < 6 * 60 * 60 * 1000) return cache.tv;

  const response = await fetch(TV_URL, {
    headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'accept-language': 'es-ES,es;q=0.9' }
  });
  if (!response.ok) return cache.tv || [];

  const html = await response.text();
  const rows = [];
  /* Cada celda de canales lleva su bloque schema.org: el instante en UTC y
     el nombre del partido. Los enlaces a equipos solo están en unas filas. */
  html.split('<td class="canales">').slice(1).forEach(function (cell) {
    const when = cell.match(/itemprop="startDate"\s+content="([^"]+)"/);
    const name = cell.match(/itemprop="name"\s+content="([^"]+)"/);
    if (!when || !name) return;

    const sides = decodeEntities(name[1]).split(' - ');
    if (sides.length < 2) return;

    const channels = [];
    const list = cell.slice(cell.indexOf('listaCanales'));
    (list.match(/<li[^>]*title="([^"]+)"/g) || []).forEach(function (item) {
      const channel = cleanChannel(item.replace(/^.*title="/, '').replace(/"$/, ''));
      if (channel && channels.indexOf(channel) === -1) channels.push(channel);
    });
    if (!channels.length) return;

    rows.push({
      start: Date.parse(when[1] + (/[Zz]|[+-]\d\d:?\d\d$/.test(when[1]) ? '' : 'Z')),
      home: sides[0],
      away: sides[1],
      tv: channels[0]
    });
  });

  cache.tv = rows;
  cache.tvAt = Date.now();
  return rows;
}

/* Primero por instante exacto; si las dos fuentes discrepan en la hora
   (partidos que se reprograman), se cae al nombre de los equipos. */
function channelFor(rows, start, home, away) {
  const exact = rows.find(function (row) { return row.start === start; });
  if (exact) return exact.tv;
  const byName = rows.find(function (row) {
    return sameTeam(row.home, home) && sameTeam(row.away, away);
  });
  return byName ? byName.tv : null;
}

/**
 * La jornada de la portada: la que está en juego mientras lo esté y, si no,
 * la próxima con su cuenta atrás.
 */
async function nextRound() {
  /* Con la jornada viva los resultados cambian solos, así que se mira más. */
  const vigencia = cache.round && cache.round.live ? 2 * 60 * 1000 : 30 * 60 * 1000;
  if (cache.round && Date.now() - cache.roundAt < vigencia) return cache.round;

  const enJuego = await jornadaEnJuego().catch(function () { return null; });
  const proxima = await proximaJornada().catch(function () { return null; });
  let round = enJuego || proxima;
  if (!round) return cache.round || null;

  /* LaLiga no juega las jornadas seguidas: la 1 puede quedarse con partidos
     aplazados y colarse la 2 entre medias. Así que el siguiente partido se
     busca entre las dos jornadas, no solo dentro de la que está en juego. */
  const ahora = Date.now();
  const porVenir = [];
  [enJuego, proxima].forEach(function (jornada) {
    if (!jornada) return;
    (jornada.matches || []).forEach(function (partido) {
      const cuando = Date.parse(partido.start);
      if (cuando > ahora) porVenir.push({ cuando: cuando, partido: partido, jornada: jornada });
    });
  });
  porVenir.sort(function (a, b) { return a.cuando - b.cuando; });

  const primero = porVenir[0];
  if (primero) {
    /* Si el siguiente pitido abre una jornada nueva, la tarjeta pasa a ser la
       de esa jornada entera. Antes se quedaba con la anterior y al desplegar
       salían sus partidos, que es lo último que interesa cuando lo que va a
       empezar es la siguiente. */
    const arranca = !(primero.jornada.matches || []).some(function (partido) {
      return Date.parse(partido.start) <= ahora;
    });
    const suya = arranca ? primero.jornada : round;

    round = Object.assign({}, suya, {
      /* La cuenta atrás siempre apunta al primer pitido que toque. */
      start: primero.partido.start,
      proximo: {
        home: primero.partido.home,
        away: primero.partido.away,
        /* Los identificadores, para poder pintar los escudos. */
        homeId: primero.partido.homeId != null ? primero.partido.homeId : null,
        awayId: primero.partido.awayId != null ? primero.partido.awayId : null,
        start: primero.partido.start,
        number: primero.jornada.number || null,
        /* Para poder decirlo cuando el próximo es de otra jornada. */
        otraJornada: (primero.jornada.number || null) !== (suya.number || null),
        /* ¿Este partido abre su jornada? La portada se ordena distinta según
           eso, y desde la web no se puede saber. */
        arranca: arranca
      }
    });
  }

  cache.round = round;
  cache.roundAt = Date.now();
  return cache.round;
}

/** La jornada activa, si ya ha empezado y todavía le quedan partidos. */
async function jornadaEnJuego() {
  const calendario = await seasonRounds().catch(function () { return []; });

  /* No vale fiarse de `status`: con los aplazados miente. La jornada 1 dice
     «finished» llevando 6 partidos de 10, así que mirando solo las «active» se
     la saltaba y la tarjeta se iba a la 3 —que no ha empezado— y la anunciaba
     como «Inicio de la Jornada 3» teniendo un partido de la 1 rodando.

     Lo que no engaña es el recuento: la jornada en juego es la más antigua que
     ha empezado y no ha terminado. */
  const candidatas = calendario
    .filter(function (r) { return (r.part || 1) === 1 && r.status !== 'pending'; })
    .sort(function (a, b) { return (a.number || 0) - (b.number || 0); })
    .slice(0, 4);

  let ficha = null;
  let detalle = null;
  for (let i = 0; i < candidatas.length && !ficha; i++) {
    const suyo = await roundDetail(candidatas[i].id, null).catch(function () { return null; });
    if (!suyo) continue;
    const jugados = suyo.played || 0;
    if (jugados > 0 && jugados < (suyo.games || 0)) { ficha = candidatas[i]; detalle = suyo; }
  }
  if (!ficha || !detalle) return null;

  const guide = await tvGuide().catch(function () { return []; });
  const matches = detalle.matches.map(function (partido) {
    return Object.assign({}, partido, {
      tv: channelFor(guide, Date.parse(partido.start), partido.home, partido.away)
    });
  });

  /* `start` apunta al siguiente partido por jugar: es lo que interesa contar
     cuando la jornada ya ha arrancado. */
  const ahora = Date.now();
  const pendiente = matches.filter(function (p) { return Date.parse(p.start) > ahora; })[0];

  return {
    id: detalle.id,
    number: detalle.number || ficha.number || null,
    name: detalle.name || ficha.name || null,
    start: pendiente ? pendiente.start : (matches.length ? matches[0].start : null),
    games: matches.length,
    played: detalle.played,
    live: true,
    matches: matches
  };
}

/** Próxima jornada: número, hora del primer partido y los partidos uno a uno. */
async function proximaJornada() {
  /* Manda la jornada EN CURSO. Si no hay ninguna rodando, entonces sí vale la
     de Biwenger: su `/rounds/la-liga/next` devuelve la ronda que tiene el
     próximo partido, y sin nada en juego eso es exactamente lo que se quiere
     anunciar, aunque sea de una jornada más adelante —la 6 tiene un Real
     Sociedad-Celta el 3 de septiembre, antes del primer partido de la 4, y ese
     es el siguiente partido de verdad—.

     Lo que no puede es pisar a la que se está jugando: el 28 de agosto la
     tarjeta anunciaba «Inicio de la Jornada 6» con la 3 empezando esa tarde. */
  const calendario = await seasonRounds().catch(function () { return []; });
  const candidatas = calendario.filter(function (r) {
    return (r.part || 1) === 1 && r.status === 'active';
  }).sort(function (a, b) { return (a.number || 0) - (b.number || 0); });

  /* «Active» no basta: Biwenger las deja así con todos los partidos jugados —la
     jornada 3 seguía «active» el lunes por la noche— y entonces la tarjeta se
     quedaba anunciándola en vez de pasar a la siguiente. Solo cuenta como en
     juego la que de verdad tiene partidos por acabar. */
  let enJuego = null;
  for (let i = 0; i < candidatas.length; i++) {
    const suyo = await roundDetail(candidatas[i].id, null).catch(function () { return null; });
    if (!suyo) continue;
    if ((suyo.played || 0) < (suyo.games || 0)) { enJuego = candidatas[i]; break; }
  }

  const url = enJuego
    ? CDN + '/rounds/la-liga/' + encodeURIComponent(enJuego.id) + '?lang=es'
    : CDN + '/rounds/la-liga/next?lang=es';

  const response = await fetch(fresco(url), { headers: NAVEGADOR, cf: SIN_CACHE });
  if (!response.ok) return null;

  const data = (await response.json()).data || {};
  const guide = await tvGuide().catch(function () { return []; });

  const matches = (data.games || [])
    .filter(function (game) { return game.date; })
    .sort(function (a, b) { return a.date - b.date; })
    .map(function (game) {
      const start = game.date * 1000;
      const home = (game.home && game.home.name) || '';
      const away = (game.away && game.away.name) || '';
      return {
        start: new Date(start).toISOString(),
        status: game.status || null,
        home: home,
        away: away,
        homeId: (game.home && game.home.id) != null ? game.home.id : null,
        awayId: (game.away && game.away.id) != null ? game.away.id : null,
        homeScore: null,
        awayScore: null,
        where: game.location || null,
        tv: channelFor(guide, start, home, away)
      };
    });

  /* «La próxima» no significa «sin empezar». La mitad aplazada de la jornada 1
     es la próxima que se juega y llega con seis partidos ya en el bote, así que
     dar por hecho que va a cero hacía que la tarjeta de inicio la anunciara
     como «Inicio de la Jornada 1» diez días después de haber arrancado. Se
     cuenta lo que hay. */
  const jugados = matches.filter(function (p) { return p.status === 'finished'; }).length;
  const empezados = matches.filter(function (p) {
    return p.status && p.status !== 'pending' && p.status !== 'preview';
  }).length;
  /* El primero que queda por jugar: es el que la tarjeta cuenta atrás. */
  const ahora = Date.now();
  const pendiente = matches.filter(function (p) { return Date.parse(p.start) > ahora; })[0];

  return {
    id: data.id != null ? data.id : null,
    number: Number(String(data.short || '').replace(/\D/g, '')) || null,
    name: data.name || null,
    start: pendiente ? pendiente.start : (matches.length ? matches[0].start : null),
    games: matches.length,
    played: jugados,
    live: empezados > 0 && jugados < matches.length,
    matches: matches
  };
}

/**
 * Qué jornada cuenta como «actual» para el selector de Jornadas: la que sigue
 * en juego hasta cinco horas antes de que arranque la siguiente, momento en
 * el que el foco pasa a esa (para ver las probables según van saliendo).
 * Biwenger decide esto a su manera y a veces tarda o se adelanta, así que
 * aquí se recalcula por cuenta propia con el mismo calendario de siempre.
 */
async function jornadaActualEfectiva() {
  const calendario = await seasonRounds().catch(function () { return []; });

  /* La jornada que se está jugando es la más antigua que ha empezado y no ha
     terminado. Se mira el recuento de partidos, NO el campo `status`: con los
     aplazados miente, y mucho —la jornada 1 dice «finished» llevando 6 de 10 y
     con un partido rodando esa misma noche—. Mirando solo las «active» se la
     saltaba y se caía en la rama de abajo, que devuelve la última cerrada: por
     eso la pestaña se quedaba en la 2 con la 1 en juego.

     Las que ni han empezado se descartan sin consultarlas, que cada una es una
     petición; con cuatro sobra para encontrarla. */
  const candidatas = calendario
    .filter(function (r) { return (r.part || 1) === 1 && r.status !== 'pending'; })
    .sort(function (a, b) { return (a.number || 0) - (b.number || 0); })
    .slice(0, 4);

  /* De paso se apunta la última que ya tiene TODOS sus partidos jugados. Hace
     falta porque Biwenger deja jornadas en «active» mucho después de acabarlas:
     la 3 seguía así con sus diez partidos disputados. Buscando la última
     «finished» se la saltaba y el selector se quedaba en la 2. */
  let ultima = null;
  for (let i = 0; i < candidatas.length; i++) {
    const suyo = await roundDetail(candidatas[i].id, null).catch(function () { return null; });
    if (!suyo) continue;
    const jugados = suyo.played || 0;
    const total = suyo.games || 0;
    if (jugados > 0 && jugados < total) return candidatas[i].id;
    if (total > 0 && jugados >= total) ultima = candidatas[i];
  }

  /* Sin nada en juego: se sigue viendo la última acabada hasta que a la
     siguiente jornada normal (part 1, nunca un aplazado suelto) le falten
     cinco horas o menos para su primer pitido. */
  if (!ultima) {
    const cerradas = calendario.filter(function (r) { return r.status === 'finished' && (r.part || 1) === 1; })
      .sort(function (a, b) { return (b.number || 0) - (a.number || 0); });
    ultima = cerradas[0] || null;
  }

  const proxima = await proximaJornada().catch(function () { return null; });
  const siguienteFicha = proxima && proxima.id != null
    ? calendario.filter(function (r) { return String(r.id) === String(proxima.id) && (r.part || 1) === 1; })[0]
    : null;

  if (!siguienteFicha) return ultima ? ultima.id : (proxima ? proxima.id : null);

  const arranque = Date.parse(proxima.start);
  const faltanCinco = !isNaN(arranque) && arranque > Date.now() && arranque - Date.now() <= 5 * 3600e3;
  return faltanCinco ? siguienteFicha.id : (ultima ? ultima.id : siguienteFicha.id);
}

/** Calendario de la temporada: id, número y estado de cada jornada. */
async function seasonRounds() {
  if (cache.calendar && Date.now() - cache.calendarAt < 6 * 60 * 60 * 1000) return cache.calendar;

  /* Sin `lang` el CDN responde en el idioma del borde de Cloudflare y las
     jornadas llegan como «Round 1». */
  const response = await fetch(CDN + '/rounds/la-liga?lang=es', { headers: NAVEGADOR });
  if (!response.ok) return cache.calendar || [];

  const data = (await response.json()).data || {};
  /* Son 38 jornadas: las dos entradas de más son la segunda parte de las que
     se aplazan (misma jornada, partidos jugados otro día). Se marcan con
     `part` para poder dejarlas fuera del selector. */
  const list = ((data.season && data.season.rounds) || []).map(function (round) {
    return {
      id: round.id,
      name: round.name || '',
      number: Number(String(round.short || '').replace(/\D/g, '')) || null,
      part: round.part || 1,
      status: round.status || null
    };
  });

  cache.calendar = list;
  cache.calendarAt = Date.now();
  return list;
}

/**
 * Coloca el once en las líneas del sistema que puso el mánager.
 *
 * Biwenger manda la alineación en orden —portero, defensas, medios y
 * delanteros— y el sistema aparte. El puesto de ficha de cada futbolista no
 * sirve: Mourinho alineó a Berenguer, delantero, de medio, y su 4-6-0 salía
 * dibujado como un 4-5-1.
 */
function colocarEnSistema(jugadores, sistema) {
  const lineas = String(sistema || '').split('-').map(Number);
  if (lineas.length !== 3 || lineas.some(function (n) { return !isFinite(n); })) return jugadores;
  if (jugadores.length !== 11 || 1 + lineas[0] + lineas[1] + lineas[2] !== 11) return jugadores;

  const puestos = [1]
    .concat(new Array(lineas[0]).fill(2))
    .concat(new Array(lineas[1]).fill(3))
    .concat(new Array(lineas[2]).fill(4));

  return jugadores.map(function (jugador, i) {
    /* Se guarda su demarcación de verdad antes de pisarla: `position` pasa a ser
       la LÍNEA en la que lo alinearon, y sin esto se perdía de qué juega. La
       web la usaba para las chapas y salían mal (Sucic de delantero en todas
       partes), y aquí hace falta para recolocarle el gol. */
    return Object.assign({}, jugador, {
      position: puestos[i],
      posReal: jugador.posReal != null ? jugador.posReal : jugador.position
    });
  });
}

/**
 * Las primas que paga la liga, tal y como las tiene puestas el administrador.
 *
 * No se fijan a fuego a propósito: si algún día se cambian los importes en los
 * ajustes, la web tiene que seguir cuadrando sola. Cambian una vez al año como
 * mucho, así que se guardan en el KV y no se vuelven a pedir.
 */
async function primasDeLaLiga(env) {
  if (cache.primas) return cache.primas;

  /* La clave lleva versión a propósito. Lo guardado es un objeto con forma
     fija, y al añadirle un campo nuevo (`superPica`) lo que había en el KV se
     seguía sirviendo sin él: el código nuevo desplegado y el ajuste sin
     aplicarse, porque la caché no caduca nunca. Subir el número aquí obliga a
     volver a preguntar. */
  if (env.JORNADAS) {
    try {
      const guardado = await env.JORNADAS.get('primas-v2');
      if (guardado) {
        cache.primas = JSON.parse(guardado);
        return cache.primas;
      }
    } catch (error) { /* se pregunta abajo */ }
  }

  try {
    const who = await account(env);
    const liga = await api(env, '/league?fields=settings',
      { 'x-league': who.leagueId, 'x-user': who.userId, 'x-version': '628' });
    const s = (liga && liga.settings) || {};
    const num = function (v) { return typeof v === 'number' ? v : 0; };
    cache.primas = {
      porPunto: num(s.bonusPoint),
      fija: num(s.bonusFixed),
      onceIdeal: num(s.bonusIdealLineup),
      mvpPartido: num(s.bonusGameMVP),
      mvpJornada: num(s.bonusRoundMVP),
      /* Con esto en true, al que hace puntuación negativa le quitan dinero;
         sin él, el abono se queda en cero pero no resta. */
      restaSiNegativo: s.bonusAllowNegative !== false,
      /* Y con esto, la nota de quien se lleva la Súper Pica se recalcula con
         ella dentro. Es un ajuste de la liga, no del sistema de puntuación,
         por eso el índice de futbolistas nunca la trae. */
      superPica: s.superPicaExtraPoints === true
    };
    if (env.JORNADAS) {
      try { await env.JORNADAS.put('primas-v2', JSON.stringify(cache.primas)); } catch (e) { /* da igual */ }
    }
  } catch (error) { /* sin primas se sigue: la web simplemente no las enseña */ }
  return cache.primas || null;
}

/**
 * El sistema de puntuación de la liga. Los puntos cambian con él, y si el
 * Worker acaba de arrancar todavía no lo sabe: se pregunta una vez y se guarda.
 */
async function sistemaDeLaLiga(env) {
  if (cache.score) return cache.score;

  /* Guardado en el KV: el Worker arranca en frío a cada rato y preguntárselo a
     Biwenger cada vez son dos llamadas autenticadas de más. Con cuatro
     endpoints tirando a la vez, eso es lo que nos hizo llegar al límite. */
  if (env.JORNADAS) {
    try {
      const guardado = await env.JORNADAS.get('sistema-puntuacion');
      if (guardado) {
        cache.score = Number(guardado) || null;
        if (cache.score) return cache.score;
      }
    } catch (error) { /* se pregunta abajo */ }
  }

  try {
    const who = await account(env);
    const liga = await api(env, '/league?fields=scoreID',
      { 'x-league': who.leagueId, 'x-user': who.userId, 'x-version': '628' });
    if (liga && liga.scoreID != null) {
      cache.score = liga.scoreID;
      if (env.JORNADAS) {
        try { await env.JORNADAS.put('sistema-puntuacion', String(cache.score)); } catch (e) { /* da igual */ }
      }
    }
  } catch (error) { /* se sigue con el sistema por defecto */ }
  return cache.score || null;
}

/**
 * Recuento de la temporada de toda la competición: goles, asistencias,
 * tarjetas, cambios y porterías a cero.
 *
 * Se saca recorriendo el detalle de cada jornada jugada, que trae un informe
 * por futbolista con sus lances. Los minutos no se pueden: Biwenger solo los da
 * en la ficha de cada jugador, uno a uno, y serían 569 consultas.
 */
/** Puntos por cada millón de valor: quién rinde por lo que cuesta. */
function rendimientoPorMillon(puntos, precio) {
  if (!precio || puntos == null) return 0;
  return Math.round((puntos / (precio / 1000000)) * 100) / 100;
}

/** Lo que lleva en las últimas jornadas con nota; los huecos no cuentan. */
function rachaDe(fitness, cuantas) {
  const notas = (fitness || []).filter(function (n) { return typeof n === 'number'; });
  return notas.slice(-cuantas).reduce(function (suma, n) { return suma + n; }, 0);
}

/**
 * Los futbolistas que alineó algún mánager de la liga en una jornada, como
 * {id: true}. Solo el once: al banquillo no le cuenta nada.
 *
 * La clasificación de cada jornada ya viene con las alineaciones y la web las
 * va guardando en KV según las mira, así que casi siempre sale de ahí. Una
 * jornada cerrada no cambia nunca, y su lista se guarda aparte: son cuatro
 * líneas de KV frente a una llamada a la API por jornada y visita.
 */
async function alineadosEnLaJornada(env, headers, jornada, names) {
  const cerrada = jornada.status === 'finished';
  const clave = 'alineados-' + jornada.id;

  if (cerrada && env.JORNADAS) {
    try {
      const crudo = await env.JORNADAS.get(clave);
      if (crudo) return JSON.parse(crudo);
    } catch (error) { /* sin KV se pregunta y ya */ }
  }

  /* Lo que la web ya guardó al mirar esa jornada. */
  let guardada = await kvLeer(env, jornada.id);
  if (!guardada || !(guardada.standings || []).some(function (f) { return (f.xi || []).length; })) {
    guardada = await roundBoard(env, headers, jornada.id, names).catch(function () { return null; });
  }
  if (!guardada || !guardada.standings) return null;

  const quienes = {};
  guardada.standings.forEach(function (fila) {
    (fila.xi || []).forEach(function (jugador) {
      if (jugador && jugador.id != null) quienes[String(jugador.id)] = true;
    });
  });
  if (!Object.keys(quienes).length) return null;

  if (cerrada && env.JORNADAS) {
    try { await env.JORNADAS.put(clave, JSON.stringify(quienes)); } catch (error) { /* da igual */ }
  }
  return quienes;
}

async function recuentoDeLaTemporada(env, headers, soloMiLiga) {
  /* Dos recuentos distintos y cada uno con su caché: el de toda LaLiga y el de
     la liga, que solo cuenta lo que hizo cada uno mientras lo alineaban. */
  const donde = soloMiLiga ? 'recuentoLiga' : 'recuento';
  if (cache[donde] && Date.now() - cache[donde + 'At'] < 5 * 60 * 1000) return cache[donde];

  const score = await sistemaDeLaLiga(env);
  const names = await players(score);
  const calendario = await seasonRounds().catch(function () { return []; });
  const jugadas = calendario.filter(function (r) {
    return (r.part || 1) === 1 && (r.status === 'finished' || r.status === 'active');
  });

  const cuenta = {};
  const ficha = function (id) {
    if (!cuenta[id]) {
      cuenta[id] = { id: id, goals: 0, penalties: 0, assists: 0, yellow: 0, red: 0,
        subsIn: 0, subsOut: 0, appearances: 0, conceded: 0, cleanSheets: 0, minutes: 0 };
    }
    return cuenta[id];
  };

  for (let i = 0; i < jugadas.length; i++) {
    const detalle = await roundDetail(jugadas[i].id, score).catch(function () { return null; });
    if (!detalle) continue;

    /* En el de la liga, esa jornada solo cuentan los que alineó alguien. Un
       fichaje no arrastra lo que hizo antes de llegar: si Mbappé llevaba
       catorce goles, aquí empieza de cero y solo suma los que meta alineado. */
    let alineados = null;
    if (soloMiLiga) {
      alineados = await alineadosEnLaJornada(env, headers, jugadas[i], names)
        .catch(function () { return null; });
      /* Sin saber quién jugó, esa jornada se salta: contarla entera sería
         justo lo contrario de lo que se pide. */
      if (!alineados) continue;
    }
    const cuenta_ = function (id) { return !alineados || alineados[String(id)]; };

    /* Marcador de cada equipo esa jornada, para encajados, porterías a cero y
       minutos. Solo cuenta el partido terminado del todo: uno en juego ya
       tiene marcador (no es null) pero ni ha dado sus puntos definitivos ni
       ha dicho su minuto de salida, así que contarlo aquí adelantaba noventa
       minutos y encajados de un partido que todavía puede cambiar. */
    const enContra = {};
    (detalle.matches || []).forEach(function (juego) {
      if (juego.status !== 'finished') return;
      if (juego.homeScore == null || juego.awayScore == null) return;
      if (juego.homeId != null) enContra[juego.homeId] = juego.awayScore;
      if (juego.awayId != null) enContra[juego.awayId] = juego.homeScore;
    });

    /* Los minutos no vienen en el detalle de jornada (solo en la ficha de cada
       futbolista, y son quinientas peticiones). Se deducen de los cambios, que
       sí están: quien ni entra ni sale jugó los noventa. Es aproximado y se usa
       solo para deshacer empates, nunca se enseña. */
    const cambios = {};
    (detalle.lances || []).forEach(function (lance) {
      if (lance.type !== 4 && lance.type !== 5) return;
      const suyo = cambios[lance.id] || (cambios[lance.id] = {});
      if (lance.type === 5) suyo.entra = lance.minute;
      else suyo.sale = lance.minute;
    });

    Object.keys(detalle.fichas).forEach(function (id) {
      const dato = detalle.fichas[id] || {};
      const recibidos = enContra[dato.team];
      /* Solo cuenta si su partido se ha jugado: en los que faltan, Biwenger ya
         publica alineaciones probables y esos no han jugado nada. */
      if (typeof recibidos !== 'number') return;
      if (!cuenta_(id)) return;

      const suyo = ficha(id);
      suyo.appearances += 1;
      suyo.conceded += recibidos;
      if (recibidos === 0) suyo.cleanSheets += 1;

      const cambio = cambios[id] || {};
      const desde = cambio.entra != null ? cambio.entra : 0;
      const hasta = cambio.sale != null ? Math.min(cambio.sale, 90) : 90;
      suyo.minutes += Math.max(0, hasta - desde);
    });

    (detalle.lances || []).forEach(function (lance) {
      if (!cuenta_(lance.id)) return;
      const suyo = ficha(lance.id);
      if (lance.type === 1) suyo.goals += 1;
      else if (lance.type === 2) { suyo.goals += 1; suyo.penalties += 1; }
      else if (lance.type === 3) suyo.assists += 1;
      else if (lance.type === 4) suyo.subsOut += 1;
      else if (lance.type === 5) suyo.subsIn += 1;
      else if (lance.type === 6) suyo.yellow += 1;
      else if (lance.type === 7) suyo.red += 1;
    });
  }

  const lista = Object.keys(cuenta).filter(function (id) {
    /* Si ya no tiene club, fuera de los rankings hasta que fiche por alguien. */
    const equipo = names[id + ':team'];
    return equipo != null && !!names['team:' + equipo];
  }).map(function (id) {
    const c = cuenta[id];
    const equipo = names[id + ':team'] != null ? names[id + ':team'] : null;
    /* En el de la liga los partidos son los que jugó alineado, no los suyos de
       LaLiga: si no, las medias saldrían con un divisor que no le toca. */
    const partidos = soloMiLiga ? c.appearances : (names[id + ':jug'] || c.appearances);
    return Object.assign(c, {
      name: names[id] || ('Jugador ' + id),
      position: names[id + ':pos'] != null ? names[id + ':pos'] : null,
      altPositions: otrosPuestos(names, id),
      team: equipo,
      teamName: names['team:' + equipo] || null,
      /* Los puntos de LaLiga no valen para el de la liga: ahí solo cuenta lo
         hecho estando alineado, y ese total lo suma la web. */
      points: soloMiLiga ? 0 : (names[id + ':pts'] != null ? names[id + ':pts'] : 0),
      played: partidos,
      goalsPerGame: partidos ? Math.round((c.goals / partidos) * 100) / 100 : 0,
      /* Cada cuántos minutos marca uno: los minutos salen de los cambios y son
         aproximados, pero es la medida que compara de verdad a un titular con
         alguien que entra media hora. Se manda así, en minutos, porque «un gol
         cada 33 minutos» se lee y «2,37 goles por noventa minutos» no. */
      minutesPerGoal: c.goals ? Math.round(c.minutes / c.goals) : 0,
      marketValue: names[id + ':price'] != null ? Math.round(names[id + ':price']) : null,
      /* Rendimiento por lo que cuesta y forma de las últimas jornadas. */
      pointsPerMillion: rendimientoPorMillon(names[id + ':pts'], names[id + ':price']),
      racha: rachaDe(names[id + ':fit'], 3)
    });
  });

  cache[donde] = { players: lista, rounds: jugadas.length, ambito: soloMiLiga ? 'liga' : 'laliga',
    updatedAt: new Date().toISOString() };
  cache[donde + 'At'] = Date.now();
  return cache[donde];
}

/**
 * Todos los futbolistas de la competición, hayan jugado o no. Es la lista del
 * buscador, así que va con lo justo para pintar cada fila.
 */
async function todosLosJugadores(env) {
  const names = await players(await sistemaDeLaLiga(env));
  const lista = [];

  Object.keys(names).forEach(function (clave) {
    if (clave.indexOf(':') !== -1) return;        // las claves con ':' son atributos
    const id = clave;
    const equipo = names[id + ':team'] != null ? names[id + ':team'] : null;
    /* Sin club no pinta nada en la lista: Biwenger los deja ahí cuando se van
       de LaLiga. Si vuelven a fichar por alguien, reaparecen solos. */
    if (equipo == null || !names['team:' + equipo]) return;
    lista.push({
      id: id,
      name: names[id],
      position: names[id + ':pos'] != null ? names[id + ':pos'] : null,
      altPositions: otrosPuestos(names, id),
      team: equipo,
      teamName: names['team:' + equipo] || null,
      status: names[id + ':status'] || null,
      /* El parte de la lesión o la sanción, para la ficha. */
      statusInfo: names[id + ':statusInfo'] || null,
      marketValue: names[id + ':price'] != null ? Math.round(names[id + ':price']) : null,
      points: names[id + ':pts'] != null ? names[id + ':pts'] : 0,
      played: names[id + ':jug'] || 0
    });
  });

  /* Por puntos y, a igualdad —los 435 que aún no han puntuado—, por equipo y
     nombre: si no, salen en el orden en que los manda Biwenger, que es ninguno. */
  lista.sort(function (a, b) {
    if (b.points !== a.points) return b.points - a.points;
    /* Dentro de cada equipo, por demarcación: portero, defensa, medio, delantero
       (y el entrenador al final, que es el 5). */
    return String(a.teamName || '').localeCompare(String(b.teamName || ''), 'es') ||
      ((a.position || 9) - (b.position || 9)) ||
      String(a.name || '').localeCompare(String(b.name || ''), 'es');
  });
  return { players: lista, updatedAt: new Date().toISOString() };
}

/**
 * Todos los futbolistas de la competición que ya han jugado algún partido, con
 * lo que llevan y su racha. El dueño no se dice aquí: eso lo cruza la web con
 * las plantillas que ya tiene.
 */
async function globalRanking(env) {
  const names = await players(await sistemaDeLaLiga(env));
  const lista = [];

  Object.keys(names).forEach(function (clave) {
    if (clave.indexOf(':') !== -1) return;        // las claves con ':' son atributos
    const id = clave;
    const jugados = names[id + ':jug'] || 0;
    if (jugados === 0) return;                    // sin jugar no hay nada que comparar

    const equipo = names[id + ':team'] != null ? names[id + ':team'] : null;
    if (equipo == null || !names['team:' + equipo]) return;   // y sin club, tampoco
    lista.push({
      id: id,
      name: names[id],
      position: names[id + ':pos'] != null ? names[id + ':pos'] : null,
      altPositions: otrosPuestos(names, id),
      team: equipo,
      teamName: names['team:' + equipo] || null,
      points: names[id + ':pts'] != null ? names[id + ':pts'] : 0,
      played: jugados,
      /* En casa y fuera por separado: rinden distinto y se nota. */
      pointsHome: names[id + ':ptsCasa'] || 0,
      playedHome: names[id + ':jugCasa'] || 0,
      pointsAway: names[id + ':ptsFuera'] || 0,
      playedAway: names[id + ':jugFuera'] || 0,
      fitness: names[id + ':fit'] || []
    });
  });

  return { players: lista, score: cache.score || null, updatedAt: new Date().toISOString() };
}

/**
 * Los partidos de una jornada con quién jugó y qué hizo.
 *
 * Biwenger manda un informe por futbolista que pisó el campo —dieciséis por
 * equipo: los once y los cinco que entraron— con sus puntos y sus lances. Los
 * lances vienen numerados y sin explicar; el número se ha ido despejando
 * cruzándolos con el desglose de puntos y con los resultados:
 *
 *   1 gol · 2 gol de penalti · 3 asistencia · 4 sale · 5 entra
 *   6 amarilla · 7 roja · 14 lesión · 16 penalti cometido
 *
 * Quien no tiene un «entra» es que salió de inicio: así se parte el once del
 * banquillo sin que Biwenger lo diga en ningún sitio.
 */
async function matchDay(roundId, score, names, primas) {
  const detalle = await roundDetail(roundId, score);
  if (!detalle) return null;

  const response = await fetch(fresco(CDN + '/rounds/la-liga/' + encodeURIComponent(roundId) +
    '?lang=es' + (score ? '&score=' + encodeURIComponent(score) : '')),
    { headers: NAVEGADOR, cf: SIN_CACHE });
  if (!response.ok) return null;
  const data = (await response.json()).data || {};

  /* Los puntos del informe del partido bailan entre peticiones: para el mismo
     futbolista y el mismo partido ya terminado devolvían 6, 8 o 4 según la
     consulta, y no viene `rawStats` con el que comprobarlos. Los buenos, los
     que enseña la app, son los del índice de futbolistas con el sistema de la
     liga, esté la jornada en juego o cerrada. */
  const salto = await saltoPorEquipo(detalle.number, score, detalle.id).catch(function () { return {}; });
  const delIndice = conCorrecciones(
    conSuperPica(puntosDeLaJornada(names, salto),
      detalle, primas), detalle.number);

  const equipo = function (lado, estadoPartido) {
    const once = [];
    const banquillo = [];


    /* Hasta que el partido no termina del todo, cualquier puntuación que
       llegue es la de la jornada anterior: Biwenger no la publica de verdad
       ni la pone a cero hasta el pitido final, ni mediado el partido. */
    const sinTerminar = estadoPartido !== 'finished';

    (lado.reports || []).forEach(function (informe) {
      const jugador = informe.player || {};
      const lances = (informe.events || []).map(function (evento) {
        return { type: evento.type, minute: evento.metadata != null ? evento.metadata : null };
      });
      const entra = lances.some(function (lance) { return lance.type === 5; });

      const ficha = {
        id: String(jugador.id),
        name: jugador.name || names[String(jugador.id)] || ('Jugador ' + jugador.id),
        position: jugador.position != null ? jugador.position : null,
        altPositions: otrosPuestos(names, jugador.id),
        points: sinTerminar ? null
          : (delIndice[String(jugador.id)] != null ? delIndice[String(jugador.id)] : null),
        star: !!informe.star,
        events: lances
      };

      if (entra) banquillo.push(ficha); else once.push(ficha);
    });

    return {
      id: lado.id != null ? lado.id : null,
      name: lado.name || '',
      score: lado.score != null ? lado.score : null,
      xi: once,
      bench: banquillo
    };
  };

  /**
   * El once de verdad de un partido que se está jugando.
   *
   * El feed de la jornada se queda atrás mientras rueda el partido: en
   * Valencia-Betis daba un Betis con Fran García, Natan, Bartra y Bellerín
   * cuando los que estaban en el campo eran Firpo, Diego Llorente, Valentín
   * Gómez y Ángel Ortiz. La ficha del partido suelto sí va al día —es la que
   * usa su propia web—, así que para los que están en curso se pregunta por
   * ella. Son 7 KB y solo se hace con los que ruedan, que nunca son más de dos
   * o tres a la vez.
   */
  const onceEnVivo = async function (id) {
    const respuesta = await fetch(fresco(CDN + '/matches/la-liga/' + encodeURIComponent(id) + '?lang=es'),
      { headers: NAVEGADOR, cf: SIN_CACHE }).catch(function () { return null; });
    if (!respuesta || !respuesta.ok) return null;
    const suyo = ((await respuesta.json().catch(function () { return {}; })).data) || {};
    if (!suyo.home || !suyo.away) return null;
    return {
      status: suyo.status || null,
      confirmadas: !!suyo.initialLineups,
      home: equipo(suyo.home, suyo.status || null),
      away: equipo(suyo.away, suyo.status || null),
      homeScore: (suyo.home || {}).score != null ? suyo.home.score : null,
      awayScore: (suyo.away || {}).score != null ? suyo.away.score : null
    };
  };

  /* La guía de televisión, la misma que usa la tarjeta de inicio. Sin esto la
     pestaña de jornadas no sabía por dónde se ve cada partido. */
  const guia = await tvGuide().catch(function () { return []; });

  const partidos = (data.games || []).map(function (game) {
    const cuando = game.date ? game.date * 1000 : null;
    return {
      id: game.id,
      start: cuando ? new Date(cuando).toISOString() : null,
      status: game.status || null,
      where: game.location || null,
      tv: cuando ? channelFor(guia, cuando, (game.home || {}).name, (game.away || {}).name) : null,
      /* Biwenger marca con «initialLineups» los partidos cuyos onces ya son
         los oficiales; sin esa marca, lo que hay son alineaciones probables. */
      confirmadas: !!game.initialLineups,
      home: equipo(game.home || {}, game.status || null),
      away: equipo(game.away || {}, game.status || null)
    };
  }).sort(function (a, b) { return String(a.start).localeCompare(String(b.start)); });

  /* A los que ya deberían estar rodando se les pide su propia ficha.
     No basta con mirar el estado: un aplazado vive en DOS jornadas —la suya y
     la mitad aplazada— y en la suya Biwenger lo deja congelado en «preview» con
     la alineación de hace diez días. Valencia-Betis salía en la jornada 1 como
     no empezado y con un Betis de Fran García, Natan y Bartra, mientras en el
     campo estaban Firpo, Diego Llorente y Ángel Ortiz.

     Así que lo que decide es el reloj: si la hora del pitido ya pasó y no
     consta terminado, se pregunta por él. De paso llegan el estado y el
     marcador de verdad. Si no contesta, se deja lo que hubiera. */
  const ahoraMismo = Date.now();
  /* También los que están a punto de empezar: las alineaciones se confirman en
     la hora previa al pitido, y el feed de la jornada tarda en enterarse —dejaba
     el Madrid-Real Sociedad como «probables» con un once viejo cuando su ficha
     ya las daba por confirmadas y con Courtois, Mbappé y Vinícius dentro. */
  const DOS_HORAS = 2 * 3600e3;
  const dudosos = partidos.filter(function (p) {
    if (p.status === 'finished') return false;
    const empezado = p.status && p.status !== 'pending' && p.status !== 'preview';
    const cuando = p.start ? Date.parse(p.start) : NaN;
    const aPuntoOPasado = !isNaN(cuando) && cuando - ahoraMismo <= DOS_HORAS;
    return empezado || aPuntoOPasado;
  }).slice(0, 6);

  await Promise.all(dudosos.map(function (p) {
    return onceEnVivo(p.id).then(function (bueno) {
      if (!bueno) return;
      if (bueno.status) p.status = bueno.status;
      /* La marca de «confirmadas» también sale de aquí: es lo que decide si la
         web avisa de que el once es probable o definitivo. */
      p.confirmadas = bueno.confirmadas;
      if (bueno.homeScore != null) p.home.score = bueno.homeScore;
      if (bueno.awayScore != null) p.away.score = bueno.awayScore;
      if ((bueno.home.xi || []).length) p.home = Object.assign({}, p.home, { xi: bueno.home.xi, bench: bueno.home.bench });
      if ((bueno.away.xi || []).length) p.away = Object.assign({}, p.away, { xi: bueno.away.xi, bench: bueno.away.bench });
    }).catch(function () { /* se deja lo que había */ });
  }));

  return {
    round: {
      id: detalle.id,
      number: detalle.number,
      name: detalle.name,
      status: detalle.status
    },
    games: partidos,
    updatedAt: new Date().toISOString()
  };
}

/**
 * Estad\u00edsticas de la temporada de un futbolista.
 *
 * La ficha de cada jugador trae un informe por partido con lo que hizo
 * (`rawStats`) y sus puntos en cada sistema de puntuaci\u00f3n, as\u00ed que aqu\u00ed solo
 * hay que sumar. Es tambi\u00e9n la \u00fanica fuente que da los puntos de jornadas ya
 * cerradas, que el \u00edndice deja de traer.
 */
/**
 * Estatura, peso, fecha y lugar de nacimiento, de la web de LaLiga.
 *
 * Biwenger no publica nada de esto y las alternativas están cerradas: SofaScore
 * responde 403 aunque se imite un navegador entero, BeSoccer pide clave de
 * pago, y la API de LaLiga necesita suscripción. Su web, en cambio, lleva la
 * ficha en el JSON de la página, en centímetros y kilos.
 *
 * El enganche sale gratis: el slug de Biwenger y el de LaLiga coinciden
 * («oso», «iago-aspas»), así que no hay que cruzar nombres ni arriesgarse a
 * confundir a dos futbolistas. Al que no exista allí se le devuelve nada.
 *
 * Se cachea en el KV para siempre: la estatura de nadie cambia, y la página
 * son 300 KB que no conviene volver a bajar.
 */
/**
 * Cuántas Súper Picas lleva cada futbolista esta temporada.
 *
 * El premio NO está en su ficha: se pidió `optionalPoints` ahí y viene vacío.
 * Solo aparece en el feed de cada jornada, en `superPicaExtraPoints`, que
 * `roundDetail` ya recoge en `detalle.picas`. Sale uno por partido.
 *
 * Ojo con DOS cosas, que las dos me las he comido ya:
 *
 *   · `rawStats.picas` es OTRA cosa —el recuento del indicador del AS— y no
 *     vale: Pedri hizo 3 en la jornada 1 y no se llevó la Súper Pica, y Guridi
 *     la ganó con 2.
 *   · y solo cuentan las rondas propias (part 1). La mitad aplazada repite los
 *     MISMOS partidos que la suya, así que contando las dos salía el doble:
 *     Mbappé aparecía con 2 Súper Picas teniendo solo la de la jornada 1.
 *
 * Se lleva la cuenta guardada y solo se miran las jornadas nuevas: una cerrada
 * no cambia, y repasar las treinta y ocho en cada ficha era justo el atracón de
 * peticiones que tumbó el índice de futbolistas.
 */
async function superPicasDeLaTemporada(env, score) {
  const clave = 'superpicas-v2-' + (score || '');
  const calendario = await seasonRounds().catch(function () { return []; });
  const jugadas = calendario.filter(function (r) {
    return (r.part || 1) === 1 && (r.status === 'finished' || r.status === 'active');
  });

  let caja = cache.superPicas && cache.superPicas.clave === clave ? cache.superPicas : null;
  if (!caja && env && env.JORNADAS) {
    try {
      const crudo = await env.JORNADAS.get(clave);
      if (crudo) caja = Object.assign({ clave: clave }, JSON.parse(crudo));
    } catch (error) { /* se empieza de cero */ }
  }
  if (!caja) caja = { clave: clave, cuenta: {}, hechas: [] };

  const pendientes = jugadas.filter(function (r) {
    return caja.hechas.indexOf(String(r.id)) === -1;
  });

  /* Lo que se devuelve: lo guardado más lo que llevan las jornadas que aún no
     están consolidadas, la que se esté jugando incluida. En la caja, en cambio,
     solo entra lo de las CERRADAS del todo. Esa es la diferencia que permite
     enseñar las de una jornada en curso sin duplicarlas al cerrarse: lo vivo se
     recalcula cada vez y nunca se guarda. */
  const cuenta = {};
  Object.keys(caja.cuenta).forEach(function (quien) { cuenta[quien] = caja.cuenta[quien]; });

  let consolidada = false;
  for (let i = 0; i < pendientes.length; i++) {
    if (i) await new Promise(function (listo) { setTimeout(listo, 120); });
    const detalle = await roundDetail(pendientes[i].id, score).catch(function () { return null; });
    if (!detalle) continue;

    const suyas = Object.keys(detalle.picas || {});
    suyas.forEach(function (quien) { cuenta[quien] = (cuenta[quien] || 0) + 1; });

    const zanjada = (detalle.played || 0) >= (detalle.games || 0) && (detalle.games || 0) > 0;
    if (!zanjada) continue;
    suyas.forEach(function (quien) { caja.cuenta[quien] = (caja.cuenta[quien] || 0) + 1; });
    caja.hechas.push(String(pendientes[i].id));
    consolidada = true;
  }

  cache.superPicas = caja;
  if (consolidada && env && env.JORNADAS) {
    try {
      await env.JORNADAS.put(clave,
        JSON.stringify({ cuenta: caja.cuenta, hechas: caja.hechas }));
    } catch (error) { /* da igual, se recalcula */ }
  }
  return cuenta;
}

async function playerStats(id, names, score, env) {
  const slug = names[String(id) + ':slug'];
  if (!slug) return null;

  const sistema = String(score || 1);

  /* Las Súper Picas de la temporada, de la cuenta guardada. Si algo falla se
     enseña cero antes que romper la ficha entera por un dato de adorno. */
  const cuentaPicas = await superPicasDeLaTemporada(env, sistema)
    .catch(function () { return {}; });
  const picas = cuentaPicas[String(id)] || 0;
  /* Biwenger vació el comodín: 'reports(*)' ya no trae los puntos, ni la
     jornada, ni los equipos, ni los minutos. Hay que pedir cada cosa por su
     nombre; si no, los informes llegan pelados y no se puede saber ni de qué
     partido eran ni qué hizo el futbolista en él. */
  const campos = 'fields=*,reports(*,points,rawStats,' +
    'match(*,round(*),home(*),away(*)),events(*))';
  const response = await fetch(CDN + '/players/la-liga/' + encodeURIComponent(slug) +
    '?lang=es&' + campos + '&score=' + encodeURIComponent(sistema), { headers: NAVEGADOR });
  if (!response.ok) return null;

  const data = (await response.json()).data || {};
  const informes = data.reports || [];

  const suma = {
    played: 0, minutes: 0, goals: 0, assists: 0, cleanSheets: 0,
    yellow: 0, red: 0, subsIn: 0, subsOut: 0, wins: 0,
    points: 0, conceded: 0, home: { played: 0, points: 0 }, away: { played: 0, points: 0 }
  };
  /* Jornada a jornada, para dibujar su racha. */
  const jornadas = [];

  informes.forEach(function (informe) {
    const bruto = informe.rawStats || {};
    const lances = informe.events || [];
    /* Los puntos vienen por sistema; si falta el nuestro, se cae al bruto. */
    const puntos = (informe.points && informe.points[sistema] != null)
      ? informe.points[sistema]
      : (bruto['score' + sistema] != null ? bruto['score' + sistema] : 0);

    /* Biwenger emite informe de TODO el que estaba convocado, juegue o no: el
       suplente que se queda en el banquillo tiene el suyo, a cero. Contarlo
       como partido jugado hacía que la ficha diera por titular a quien no pisó
       el campo —Rodri salía con una titularidad llevando cero minutos—, porque
       «titular» se calcula como jugados menos los que entraron de cambio.
       Sin minutos no jugó, y punto. Si Biwenger no manda el dato de minutos no
       se supone nada y se cuenta como jugado, que es lo de siempre. */
    /* La señal buena es que el informe traiga `points`. Comprobado: al que jugó
       le llegan `points`, `rawStats` y `events`; al convocado que se quedó en el
       banquillo, el informe pelado —solo `match` y `home`—. Mirar los minutos no
       basta: en esos informes `rawStats` no viene, así que `minutesPlayed` es
       `undefined` y se colaba como jugado. */
    const minutos = bruto.minutesPlayed;
    const jugado = informe.points != null && (minutos == null ? true : minutos > 0);
    if (!jugado) {
      /* Ni jugados, ni casa/fuera, ni racha: para él ese partido no existe.
         La jornada sí se apunta, con su guion, que es lo que dibuja el hueco
         en el gráfico de barras. */
      const rondaFuera = (informe.match && informe.match.round) || {};
      const nFuera = Number(String(rondaFuera.short || '').replace(/\D/g, '')) || null;
      if (nFuera) {
        jornadas.push({ number: nFuera, points: 0, sinNota: true, home: !!informe.home });
      }
      return;
    }

    suma.played += 1;
    suma.minutes += bruto.minutesPlayed || 0;
    suma.goals += bruto.goals || 0;
    suma.assists += bruto.assists || 0;
    if (bruto.cleanSheet) suma.cleanSheets += 1;
    if (bruto.win) suma.wins += 1;
    /* Lo que le metieron a su equipo ese día: para los porteros, sus encajados. */
    const enContra = informe.home ? bruto.awayScore : bruto.homeScore;
    if (typeof enContra === 'number') suma.conceded += enContra;
    suma.points += puntos;

    lances.forEach(function (lance) {
      if (lance.type === 5) suma.subsIn += 1;
      else if (lance.type === 4) suma.subsOut += 1;
      else if (lance.type === 6) suma.yellow += 1;
      else if (lance.type === 7) suma.red += 1;
    });

    const donde = informe.home ? suma.home : suma.away;
    donde.played += 1;
    donde.points += puntos;

    const ronda = (informe.match && informe.match.round) || {};
    const numero = Number(String(ronda.short || '').replace(/\D/g, '')) || null;
    /* Aquí ya se sabe que jugó: los que no, salieron antes con su guion. */
    if (numero) {
      jornadas.push({ number: numero, points: puntos, sinNota: false, home: !!informe.home });
    }
  });

  jornadas.sort(function (a, b) { return a.number - b.number; });

  const media = function (total, partidos) {
    return partidos ? Math.round((total / partidos) * 10) / 10 : null;
  };

  return {
    id: String(id),
    name: data.name || names[String(id)] || null,
    position: data.position != null ? data.position : (names[String(id) + ':pos'] || null),
    /* Lesión o sanción, con el parte tal como lo escribe Biwenger, para
       poder decirlo en la ficha en vez de solo pintar la marca. */
    status: data.status || names[String(id) + ':status'] || null,
    statusInfo: data.statusInfo || names[String(id) + ':statusInfo'] || null,
    /* Su club. La web lo necesita para emparejarlo en SofaScore sin colarse de
       futbolista: hay varios «Balde» y varios «Yuri», y el equipo los separa. */
    teamName: names['team:' + names[String(id) + ':team']] || null,
    /* Y su slug, que lleva el nombre largo. Buscando por el corto se falla:
       «Vini Jr» devuelve un jugador de fútbol sala, y «vinicius junior» sí da
       con el del Real Madrid. */
    slug: names[String(id) + ':slug'] || null,
    played: suma.played,
    minutes: suma.minutes,
    goals: suma.goals,
    assists: suma.assists,
    cleanSheets: suma.cleanSheets,
    conceded: suma.conceded,
    yellow: suma.yellow,
    red: suma.red,
    subsIn: suma.subsIn,
    subsOut: suma.subsOut,
    wins: suma.wins,
    points: suma.points,
    average: media(suma.points, suma.played),
    goalsPerGame: media(suma.goals, suma.played),
    home: { played: suma.home.played, points: suma.home.points, average: media(suma.home.points, suma.home.played) },
    away: { played: suma.away.played, points: suma.away.points, average: media(suma.away.points, suma.away.played) },
    rounds: jornadas,
    /* Súper Picas ganadas esta temporada. Va aparte porque no sale de su ficha
       —ahí no viene— sino del feed de cada jornada. */
    superPicas: picas,
    updatedAt: new Date().toISOString()
  };
}

/**
 * La nota de cada futbolista en una jornada concreta, sacada del índice.
 *
 * `:fit` guarda una nota por jornada ya jugada por su equipo, en orden de
 * calendario. Para dar con la de la jornada que se mira hay que contar hacia
 * atrás desde el final: `salto` dice cuántas jornadas ha jugado ese equipo
 * DESPUÉS de esta (0 si es la última que jugó, 1 la anterior...).
 *
 * Si el salto se sale del array, no se devuelve nada: mejor dejarlo pendiente
 * que enseñar la nota de otra jornada, que es justo lo que pasaba antes.
 */
/**
 * Pone encima del marcador las notas recalculadas con Súper Pica.
 *
 * Solo hay una por partido, así que toca a diez futbolistas de trescientos y
 * pico; para el resto no cambia nada. Sin esto, esos diez se quedan un punto
 * o dos por debajo de lo que enseña Biwenger, y con ellos su mánager.
 */
/* Correcciones a mano, por jornada y futbolista.
 *
 * Aquí solo entra lo que se ha comprobado contra la pantalla de Biwenger y no
 * se puede sacar de ningún dato suyo. Hoy hay un caso: Pablo García en la
 * jornada 1. Su web le da 11 y TRES fuentes distintas de la propia Biwenger
 * dicen 10 —el índice de futbolistas, el informe del jugador y su mapa en el
 * sistema 5, que es el de esta liga—; el 11 solo aparece bajo el sistema 6,
 * que no es el que se juega aquí. Tampoco es Súper Pica: no está en la lista
 * de ninguna de las dos mitades de la jornada.
 *
 * Es un parche, no un arreglo: si Biwenger revisa ese punto, esta línea pasa a
 * estar mal y hay que quitarla. Se deja acotada a un futbolista y una jornada
 * a propósito, para que no pueda estropear nada más.
 */
/* Vacía a propósito. Aquí estaba Pablo García con 11 en la jornada 1, puesto a
   mano porque su ficha daba 10 y no se sabía por qué. Ya se sabe: es delantero,
   marcó de delantero (gol de 3) y gijonudo lo alineó de medio (gol de 4). Eso
   lo hace ahora `recolocarGoles`, que además lo hace BIEN: por mánager. Este
   parche era global y le habría dado 11 también a quien lo alineara de
   delantero, donde lo correcto son 10. */
const CORRECCIONES = {
  // jornada -> { id de futbolista: puntos }
};

function conCorrecciones(marcador, numero) {
  const tabla = CORRECCIONES[numero];
  if (!tabla) return marcador;
  Object.keys(tabla).forEach(function (id) {
    /* Solo si ese futbolista ya tiene nota: si no jugó, no se le inventa una. */
    if (marcador[id] != null) marcador[id] = tabla[id];
  });
  return marcador;
}

/* Lo que vale un gol según la línea en la que juegas: 6 de portero, 5 de
   defensa, 4 de medio y 3 de delantero. */
const VALOR_GOL = { 1: 6, 2: 5, 3: 4, 4: 3 };

/**
 * Recoloca el gol del que está alineado fuera de su puesto.
 *
 * La nota de la ficha está calculada en la posición en la que JUGÓ, pero
 * Biwenger la recalcula según la línea en la que lo pone cada mánager: un medio
 * que marca, puesto de delantero, vale un punto menos, porque su gol pasa de
 * valer 4 a valer 3. Y como depende de la alineación, esto no se puede tocar en
 * el marcador —que es común a toda la liga—: solo aquí, con el once delante.
 *
 * Jornada 1: Sucic marcó de medio y Bella lo alineó de delantero. Su ficha da
 * 8; Biwenger le pone 7 en ese once, y a quien lo alineara de medio, 8.
 */
function recolocarGoles(once, goles, posReales) {
  return once.map(function (jugador) {
    const suyos = goles[jugador.id] || 0;
    if (!suyos || jugador.points == null) return jugador;
    /* Solo sobre la nota que hemos calculado nosotros: la que manda Biwenger ya
       la trae recolocada, y ajustarla otra vez la estropearía. */
    if (!jugador.nuestra) return jugador;

    const real = posReales[jugador.id];
    const puesta = jugador.position;
    if (real == null || puesta == null || real === puesta) return jugador;
    if (VALOR_GOL[real] == null || VALOR_GOL[puesta] == null) return jugador;

    return Object.assign({}, jugador, {
      points: jugador.points + (VALOR_GOL[puesta] - VALOR_GOL[real]) * suyos
    });
  });
}

function conSuperPica(marcador, detalle, primas) {
  if (!primas || !primas.superPica) return marcador;
  const picas = (detalle && detalle.picas) || {};
  Object.keys(picas).forEach(function (id) {
    if (typeof picas[id] === 'number') marcador[id] = picas[id];
  });
  return marcador;
}

function puntosDeLaJornada(names, salto) {
  const saltos = salto || {};
  const mapa = {};
  Object.keys(names).forEach(function (clave) {
    if (clave.slice(-4) !== ':fit') return;
    const id = clave.slice(0, -4);
    const notas = names[clave] || [];
    if (!notas.length) return;
    /* El salto se cuenta con los partidos del EQUIPO, pero `fitness` solo trae
       nota de los que jugó ÉL: el que se perdió alguno tiene menos casillas que
       partidos su club. Sin este tope se pedía una casilla que no existe y el
       futbolista se quedaba sin nota —a Pedri le pasaba, con una sola entrada y
       dos partidos del Barça—. Retrocediendo como mucho hasta la más antigua se
       acierta igual cuando encaja y no se pierde la nota cuando no. */
    /* El salto se cuenta con los partidos del EQUIPO, pero el historial solo
       trae nota de los que jugó ÉL: quien se perdió alguno tiene menos casillas
       que partidos su club. Sin este tope se pedía una casilla que no existe y
       el futbolista se quedaba sin nota. */
    const atras = Math.min(saltos[names[id + ':team']] || 0, notas.length - 1);
    const nota = notas[notas.length - 1 - atras];
    if (typeof nota === 'number') mapa[id] = nota;
  });
  return mapa;
}

/**
 * Las notas de una jornada, sacadas de la ficha de cada futbolista.
 *
 * Es la ÚNICA fuente que dice a qué jornada pertenece cada nota. Se probaron
 * todas las demás y ninguna vale:
 *
 *   · el historial resumido (`fitness`) no trae la jornada, solo una lista, y
 *     su orden no es deducible: el Barça la manda [J2, J1] y el Celta [J1, J2]
 *     con los dos partidos de la jornada 1 jugados el mismo día. Contando
 *     partidos por fecha o por número se acierta con unos y se falla con otros.
 *   · el detalle de la jornada da unos puntos que no son los de la liga:
 *     acertaba 1 de 9 contra la pantalla de Biwenger.
 *
 * Cuesta una consulta por futbolista, así que se piden por tandas para no
 * disparar el límite de Biwenger y se guarda el resultado: una jornada cerrada
 * no cambia nunca, y a partir de la segunda vez sale del almacén.
 */
async function notasDeLaJornada(env, ids, names, score, numero, cerrada, partidoDe) {
  if (numero == null || !ids.length) return null;
  /* v2 a propósito: la clave vieja se quedó con las notas de la J1 tomadas
     mientras la ronda aplazada seguía abierta, y como no se comprobaba nada al
     leerlas, esa foto mala se devolvía para siempre. Cambiando el nombre
     caducan solas, sin tener que vaciar nada a mano. */
  const clave = 'notas-v3-' + numero + '-' + (score || '');

  /* Solo se piden las fichas de los que YA tienen el partido acabado. Al que le
     queda por jugar no hay nota que sacarle —y `roundPlayer` la descartaría de
     todas formas—, así que pedirla es tirar consultas.

     Importa mucho más de lo que parece: mientras la jornada está viva esto se
     repite cada pocos minutos, y pedir noventa fichas una y otra vez es lo que
     hacía que Biwenger cortara y el índice de futbolistas llegara vacío, con la
     web entera en «Jugador 1679» a 0 €. Con este filtro se empieza pidiendo un
     puñado y va creciendo según acaban los partidos; cuando acaban todos, se
     guarda en el KV y no se vuelve a pedir nunca. */
  const pedibles = ids.map(String).filter(function (id) {
    if (!partidoDe) return true;                  // sin saberlo, se piden todas
    const equipo = names[id + ':team'];
    return equipo != null && partidoDe[equipo] === 'finished';
  });
  if (!pedibles.length) return null;
  const estanTodos = function (vistos) {
    return pedibles.every(function (id) { return vistos.indexOf(String(id)) !== -1; });
  };

  /* Copia en memoria, para cuando la jornada aún no se puede dar por zanjada:
     sin ella habría que releer noventa fichas en CADA petición. */
  if (!cache.notas) cache.notas = {};
  const enMemoria = cache.notas[clave];
  if (enMemoria && Date.now() - enMemoria.at < 10 * 60 * 1000 && estanTodos(enMemoria.vistos)) {
    return enMemoria;
  }

  if (env && env.JORNADAS) {
    try {
      const guardado = await env.JORNADAS.get(clave);
      if (guardado) {
        const caja = JSON.parse(guardado);
        /* Solo vale si se leyeron las fichas de TODOS los que se piden ahora.
           Si aparece alguien nuevo —un fichaje alineado después—, se vuelve a
           pedir en vez de dejarlo con la nota del historial, que falla. */
        if (caja && caja.notas && estanTodos(caja.vistos || [])) return caja;
      }
    } catch (error) { /* se pide abajo */ }
  }

  /* Con el CDN cortado no se piden noventa fichas: se sigue con el historial,
     que acierta en la mayoría, y se vuelve a intentar cuando levante. */
  if (cdnCortado()) return null;

  const mapa = {};
  /* En qué puesto jugó de verdad esa jornada. Hace falta para poder recolocar
     su gol cuando el mánager lo alinea en otra línea, y viene en el mismo
     `rawStats` que ya trae la petición: no cuesta una consulta más. */
  const posiciones = {};
  /* Fichas leídas de verdad. No es lo mismo que `mapa`: quien no jugó esa
     jornada no tiene nota, y aun así su ficha se consultó. Sin esta distinción,
     un suplente que no salió dejaba el mapa «incompleto» para siempre. */
  const vistos = [];
  /* Tandas de 10 y pausa corta. El freno se puso cuando CADA arranque volvia a
     pedirlo todo; ahora el indice, los precios del dia y las notas de una
     jornada cerrada viven en el KV, asi que esto solo corre la primera vez y no
     hace falta ir tan despacio. Ademas, si Biwenger corta, `cdnCortado()` para
     en seco, que es la proteccion que de verdad importa. */
  const TANDA = 10;
  for (let i = 0; i < pedibles.length; i += TANDA) {
    /* Un respiro entre tandas. Noventa fichas seguidas a toda velocidad es lo
       que hacía que Biwenger cortara, y cuando corta no falla solo esto: cae
       también la descarga del índice de futbolistas y la web entera se queda
       sin nombres ni precios. Quince tandas a 400 ms son seis segundos, y solo
       la primera vez de cada jornada. */
    if (i) await new Promise(function (listo) { setTimeout(listo, 120); });
    await Promise.all(pedibles.slice(i, i + TANDA).map(async function (id) {
      const quien = names[String(id) + ':slug'] || String(id);
      const respuesta = await fetch(CDN + '/players/la-liga/' + encodeURIComponent(quien) +
        '?lang=es&fields=*,reports(*,points,rawStats,match(*,round(*)))',
        { headers: NAVEGADOR, cf: SIN_CACHE }).catch(function () { return null; });
      if (!respuesta || !respuesta.ok) return;
      const ficha = ((await respuesta.json().catch(function () { return {}; })).data) || {};
      vistos.push(String(id));
      (ficha.reports || []).forEach(function (informe) {
        const ronda = (informe.match && informe.match.round) || {};
        /* Se compara por `short`, no por id de ronda: el partido aplazado de
           una jornada vive en una ronda distinta («Jornada 1 (aplazada)») que
           lleva el mismo «J1». Por id se quedaban sin nota los ocho equipos
           que jugaron su partido de la 1 más tarde. */
        const suya = Number(String(ronda.short || '').replace(/\D/g, '')) || null;
        if (suya !== numero) return;
        const nota = (informe.points || {})[String(score)];
        if (typeof nota === 'number') mapa[String(id)] = nota;
        /* La posición jugada viene como una marca suelta —`pos3: true`—, no
           como un número. */
        const bruto = informe.rawStats || {};
        const marca = Object.keys(bruto).filter(function (campo) {
          return /^pos[1-5]$/.test(campo) && bruto[campo];
        })[0];
        if (marca) posiciones[String(id)] = Number(marca.slice(3));
      });
    }));
  }

  const completo = estanTodos(vistos);
  cache.notas[clave] = { at: Date.now(), notas: mapa, posiciones: posiciones, vistos: vistos };

  /* Se guarda para siempre solo si se cumplen las DOS cosas:
       · la jornada está zanjada de verdad —su ronda y la aplazada, que lleva su
         mismo número—, porque hasta entonces Biwenger sigue moviendo notas;
       · y han contestado TODAS las fichas. Antes bastaba con que el mapa no
         estuviera vacío, así que un límite de consultas de Biwenger a media
         tanda congelaba una jornada a medias y ya no había forma de arreglarla. */
  if (cerrada && completo && env && env.JORNADAS && await jornadaZanjada(numero, score)) {
    try {
      await env.JORNADAS.put(clave,
        JSON.stringify({ notas: mapa, posiciones: posiciones, vistos: vistos }));
    } catch (error) { /* da igual */ }
  }
  return { notas: mapa, posiciones: posiciones, vistos: vistos };
}

/**
 * ¿Está esta jornada zanjada del todo?
 *
 * No basta con que lo esté su ronda. Los aplazados viven en una ronda aparte
 * —«Jornada 1 (aplazada)», `part` 2— con el MISMO `short`, y trae los mismos
 * diez partidos que la suya. Mientras esa siga abierta, Biwenger puede seguir
 * moviendo las notas de la jornada: la J1 tenía su ronda ya `finished` con la
 * aplazada todavía `active`, y así se guardaban como definitivas notas que
 * seguían cambiando.
 */
async function jornadaZanjada(numero, score) {
  if (numero == null) return false;
  const calendario = await seasonRounds().catch(function () { return []; });
  const suyas = calendario.filter(function (r) { return r.number === numero; });
  if (!suyas.length) return false;

  /* Se miran los PARTIDOS, no el `status` de la ronda. Biwenger deja la ronda
     aplazada en `active` mucho después de que se hayan jugado todos sus
     partidos —la de la jornada 1 lleva así desde que acabó—, y fiándose de ese
     estado la jornada no se daba nunca por cerrada: no se guardaba en el KV y
     se volvían a pedir las noventa fichas cada diez minutos. Eso agotaba el
     límite de consultas de Biwenger y tumbaba el índice de futbolistas, que es
     lo que dejaba el mercado sin nombres y a cero. */
  for (let i = 0; i < suyas.length; i++) {
    const d = await roundDetail(suyas[i].id, score).catch(function () { return null; });
    if (!d || !(d.games > 0) || (d.played || 0) < d.games) return false;
  }
  return true;
}

/**
 * Cuántos partidos ha jugado cada equipo DESPUÉS del suyo de esta jornada, que
 * es lo que hay que retroceder en su historial para dar con la nota de esta.
 *
 * Se cuenta por FECHA de partido, no por número de jornada: con los aplazados
 * dejan de coincidir —el Valencia jugó su partido de la 2 el día 22 y el de la
 * 1 el día 25—, y el historial va en el orden en que se jugaron.
 *
 * Solo las jornadas propias (part 1). La mitad aplazada no es una jornada más:
 * repite los mismos partidos que ya están en la suya, con su fecha real, y
 * contando las dos el aplazado se contaba dos veces.
 */
async function saltoPorEquipo(numero, score, ronda) {
  const saltos = {};
  if (numero == null) return saltos;

  const calendario = await seasonRounds().catch(function () { return []; });

  /* Cuándo jugó cada equipo SU partido de esta jornada: es la referencia. */
  const cuando = {};
  const propia = ronda != null
    ? await roundDetail(ronda, score).catch(function () { return null; })
    : null;
  ((propia && propia.matches) || []).forEach(function (partido) {
    const dia = Date.parse(partido.start);
    if (isNaN(dia)) return;
    if (partido.homeId != null) cuando[partido.homeId] = dia;
    if (partido.awayId != null) cuando[partido.awayId] = dia;
  });

  const jugadas = calendario.filter(function (r) {
    return (r.part || 1) === 1 && (r.status === 'finished' || r.status === 'active');
  });

  for (let i = 0; i < jugadas.length; i++) {
    if (String(jugadas[i].id) === String(ronda)) continue;
    const otra = await roundDetail(jugadas[i].id, score).catch(function () { return null; });
    ((otra && otra.matches) || []).forEach(function (partido) {
      if (partido.status !== 'finished') return;
      const dia = Date.parse(partido.start);
      if (isNaN(dia)) return;
      [partido.homeId, partido.awayId].forEach(function (equipo) {
        if (equipo == null) return;
        const suyo = cuando[equipo];
        /* Sin fecha de referencia se cae a lo de antes: por número de jornada. */
        const despues = suyo != null ? dia > suyo : (jugadas[i].number || 0) > numero;
        if (despues) saltos[equipo] = (saltos[equipo] || 0) + 1;
      });
    });
  }
  return saltos;
}



/** Un jugador de una alineación de jornada, con lo que puntuó. */
/* Lo que hizo cada futbolista en la jornada, de los lances del detalle:
     1 gol · 2 gol de penalti · 3 asistencia
   Se cuenta aquí y no en la web para no tener que cruzar allí la alineación con
   el parte de cada partido. */
function roundPlayer(entry, names, puntos, partidoDe, enCasa, lances) {
  /* Biwenger manda unas veces el futbolista entero y otras solo su número. */
  const suelto = entry != null && typeof entry !== 'object';
  const player = suelto ? { id: entry } : ((entry && entry.player) || entry);
  if (!player || player.id == null) return null;
  const id = String(player.id);
  const marcador = puntos || {};
  const equipo = names[id + ':team'] != null ? names[id + ':team'] : null;
  /* Sus lances de esta jornada: 1 gol, 2 gol de penalti, 3 asistencia. */
  const suyos = (lances || []).filter(function (l) { return String(l.id) === id; });

  /* El que se ha ido de LaLiga sigue en la alineación de quien lo tenía, pero
     ya no tiene equipo en el índice. No es que su partido esté por jugarse: es
     que no hay partido y no lo habrá, así que se da por resuelto y sin nota.
     Antes caía en «sin terminar» y la web le pintaba una interrogación para
     siempre, como si aún fuera a puntuar. Biwenger tampoco lo penaliza: a
     gijonudo le da los mismos 26 puntos que salen de sus otros diez. */
  const fuera = equipo == null;

  /* Sin puntuación hay dos casos distintos: su partido ya acabó y no jugó (un
     guion), o todavía no se sabe la nota (una interrogación). */
  const estadoPartido = (partidoDe || {})[equipo] || null;
  /* Hasta que el partido no ha terminado del todo, cualquier puntuación que
     llegue (de la alineación, de la ficha o del índice) es la de la jornada
     pasada: Biwenger no la pone a cero ni la publica de verdad hasta el
     pitido final, ni con el partido ya mediado. Se ignora sin más. */
  const sinTerminar = !fuera && estadoPartido !== 'finished';

  /* Cuando solo llega el número, los puntos salen del índice de futbolistas:
     así van subiendo según acaba cada partido. Al que ya no está se le fuerza
     el vacío: si no, se le colaría por el índice la nota de la última jornada
     que llegó a jugar. */
  const suya = !suelto && entry && entry.points != null ? entry.points
    : (player.points != null ? player.points : null);
  const puntuacion = (sinTerminar || fuera) ? null
    : (suya != null ? suya : (marcador[id] != null ? marcador[id] : null));

  /* ¿La nota la ha puesto Biwenger o la hemos calculado nosotros? Importa para
     recolocar el gol del que está alineado fuera de su puesto: la de Biwenger
     YA viene con ese ajuste hecho, y volver a aplicárselo la dejaría mal. */
  const nuestra = !(sinTerminar || fuera) && suya == null && marcador[id] != null;

  const pendiente = sinTerminar;
  /* Si jugaba en casa o fuera esa jornada: rinden distinto y se compara. */
  const casa = (enCasa || {})[equipo];

  return {
    id: id,
    name: player.name || names[id] || ('Jugador ' + id),
    position: player.position != null ? player.position
      : (names[id + ':pos'] != null ? names[id + ':pos'] : null),
    points: puntuacion,
    nuestra: nuestra,
    pending: pendiente,
    /* Para poder decir en la web por qué no tiene nota, y para dejarlo fuera
       de la cuenta de jugadores: Biwenger enseña diez, no once. */
    fuera: fuera,
    /* Lo que hizo esa jornada. Va aquí porque el detalle de la jornada ya trae
       los lances y así la web no tiene que cruzar la alineación con el parte de
       cada partido para saber quién marcó. */
    goals: suyos.filter(function (l) { return l.type === 1 || l.type === 2; }).length,
    assists: suyos.filter(function (l) { return l.type === 3; }).length,
    home: casa == null ? null : casa,
    marketValue: names[id + ':price'] != null ? Math.round(names[id + ':price']) : null,
    team: equipo,
    teamName: names['team:' + equipo] || null
  };
}

/* ---------- Memoria compartida entre PC y móvil ----------
   Con un KV enlazado como JORNADAS, lo que capture cualquier dispositivo lo
   ven todos. Sin KV el Worker funciona igual, solo que cada navegador se
   guarda lo suyo. */

async function kvLeer(env, id) {
  if (!env.JORNADAS) return null;
  try {
    const raw = await env.JORNADAS.get('jornada-' + id);
    return raw ? JSON.parse(raw) : null;
  } catch (error) { return null; }
}

/* Huella de lo último que se escribió en cada clave, para no repetir la
   escritura cuando el contenido es idéntico. Se reescribía en CADA petición:
   la jornada entera pasa de 40 KB, así que el almacén la parte en trozos y era
   media docena de escrituras por visita, dijeran lo mismo o no. Con la jornada
   parada (de madrugada, o entre partidos) eso es puro gasto, y es lo que se
   comió la cuota del plan gratuito. */
const ultimoEscrito = {};

function huellaDe(texto) {
  let h = 5381;
  for (let i = 0; i < texto.length; i++) h = ((h * 33) ^ texto.charCodeAt(i)) >>> 0;
  return texto.length + ':' + h;
}

/**
 * Escribe solo si cambió. Devuelve si llegó a escribir.
 *
 * `paraHuella` permite comparar por una versión distinta del texto: los
 * payloads llevan un `updatedAt` que cambia en cada respuesta y, si entrara en
 * la cuenta, no se ahorraría ni una escritura.
 */
async function guardarSiCambia(env, clave, texto, paraHuella) {
  if (!env.JORNADAS) return false;
  const huella = huellaDe(paraHuella != null ? paraHuella : texto);
  if (ultimoEscrito[clave] === huella) return false;
  try {
    await env.JORNADAS.put(clave, texto);
    ultimoEscrito[clave] = huella;
    return true;
  } catch (error) { return false; }
}

async function kvGuardar(env, id, data) {
  if (!env.JORNADAS) return;
  await guardarSiCambia(env, 'jornada-' + id, JSON.stringify(data),
    JSON.stringify(Object.assign({}, data, { updatedAt: null })));
}

/** Se queda con lo más completo de las dos versiones, nunca con lo más pobre. */
function mezclarJornada(guardado, fresco) {
  if (!guardado || !guardado.standings) return fresco;
  const previas = {};
  guardado.standings.forEach(function (fila) { previas[fila.id] = fila; });

  /* Un cero fresco ya es el dato bueno siempre que venga con su once: lo
     calcula roundBoard mirando partido a partido si cada jugador ha
     terminado el suyo, así que si de los once nadie ha acabado, cero puntos
     y cero jugados es lo correcto, no un fallo que haya que tapar con lo
     que hubiera guardado de antes (que además podía ser de la jornada
     pasada). Solo se recurre a lo guardado si esta vez ni siquiera ha
     llegado el once: eso sí es un fallo de la consulta, no un cero real. */
  if (!fresco.bestXi && guardado.bestXi) fresco.bestXi = guardado.bestXi;
  fresco.standings = (fresco.standings || []).map(function (fila) {
    const antes = previas[fila.id];
    if (!antes) return fila;
    const conOnce = fila.xi && fila.xi.length;
    return {
      id: fila.id,
      name: fila.name || antes.name,
      icon: fila.icon || antes.icon,
      position: fila.position != null ? fila.position : antes.position,
      points: conOnce ? fila.points : (antes.points != null ? antes.points : fila.points),
      pointsOfficial: fila.pointsOfficial != null ? fila.pointsOfficial : antes.pointsOfficial,
      played: fila.played != null ? fila.played : antes.played,
      counts: fila.counts !== undefined ? fila.counts : antes.counts,
      gaps: fila.gaps !== undefined ? fila.gaps : antes.gaps,
      type: fila.type || antes.type,
      xi: fila.xi && fila.xi.length ? fila.xi : (antes.xi || []),
      bench: fila.bench && fila.bench.length ? fila.bench : (antes.bench || []),
      xiValue: fila.xiValue || antes.xiValue || 0,
      /* Sin esto el día de los precios se perdía en cada mezcla y el valor del
         once se recalculaba entero cada vez, que son casi cien consultas al
         CDN que ya estaban hechas. */
      xiValueDay: fila.xiValueDay || antes.xiValueDay || null,
      abono: fila.abono || antes.abono || null
    };
  });
  return fresco;
}

/* Los mismos catorce sistemas que admite Biwenger. */
const SISTEMAS = ['3-2-5', '3-3-4', '3-4-3', '3-5-2', '3-6-1', '4-2-4', '4-3-3',
  '4-4-2', '4-5-1', '4-6-0', '5-1-4', '5-2-3', '5-3-2', '5-4-1'];

/**
 * Detalle de una jornada en el CDN: cómo va cada partido y lo que lleva cada
 * futbolista. Sin `score` llegan los puntos del sistema 1, y esta liga juega
 * con el 5 (mixto AS + Biwenger), así que se pasa siempre que se conoce.
 */
async function roundDetail(roundId, score) {
  const clave = String(roundId) + '/' + (score || '');
  if (!cache.detalles) cache.detalles = {};
  const guardado = cache.detalles[clave];
  if (guardado && Date.now() - guardado.at < guardado.vigencia) return guardado.data;

  const response = await fetch(fresco(CDN + '/rounds/la-liga/' + encodeURIComponent(roundId) +
    '?lang=es' + (score ? '&score=' + encodeURIComponent(score) : '')),
    { headers: NAVEGADOR, cf: SIN_CACHE });
  if (!response.ok) return guardado ? guardado.data : null;

  const data = (await response.json()).data || {};
  const puntos = {};      // futbolista -> lo que lleva en esta jornada
  const fichas = {};      // futbolista -> nombre, puesto y equipo con el que jugó
  const lances = [];      // cada gol, tarjeta o cambio de la jornada
  const partidos = [];
  /* Biwenger marca al mejor de cada partido con `mvp`. Esta liga paga por
     alinearlo, así que se recoge aquí: viene en el mismo informe que ya se
     recorre, sin una sola petición de más. */
  const mvps = {};
  /* La Súper Pica del AS: una por partido. Cuando la liga la tiene activada,
     Biwenger NO suma un extra al final —recalcula la nota entera con ella
     dentro del AS y vuelve a hacer la media con SofaScore—, y el resultado
     vive aparte, en `optionalPoints`. El campo `points` de siempre sigue
     trayendo la nota sin Súper Pica, que es la que se nos quedaba corta:
     Oso 14 donde su web enseñaba 15, Ryan 12 donde enseñaba 13. */
  const picas = {};

  (data.games || []).forEach(function (game) {
    const local = game.home || {};
    const visitante = game.away || {};

    [local, visitante].forEach(function (equipo) {
      (equipo.reports || []).forEach(function (informe) {
        const jugador = informe.player || {};
        if (jugador.id == null) return;
        const id = String(jugador.id);
        /* Se guarda, pero ya no se usa para puntuar a nadie: este campo baila
           entre peticiones (el mismo futbolista en el mismo partido cerrado
           daba 6, 8 o 4) y este feed no trae `rawStats` con el que
           contrastarlo. Las notas buenas salen del índice de futbolistas, en
           puntosDeLaJornada(). */
        if (informe.points != null) puntos[id] = informe.points;
        if (informe.mvp) mvps[id] = true;
        const extra = (informe.optionalPoints || {}).superPicaExtraPoints;
        if (extra && extra.points != null) picas[id] = extra.points;
        (informe.events || []).forEach(function (evento) {
          lances.push({ id: id, type: evento.type, minute: evento.metadata != null ? evento.metadata : null });
        });
        fichas[id] = {
          name: jugador.name || null,
          position: jugador.position != null ? jugador.position : null,
          team: equipo.id != null ? equipo.id : null,
          teamName: equipo.name || null,
          /* Minutos de ese partido, para la lista de partidos del futbolista. */
          minutes: (informe.rawStats && informe.rawStats.minutesPlayed != null)
            ? informe.rawStats.minutesPlayed : null
        };
      });
    });

    partidos.push({
      start: game.date ? new Date(game.date * 1000).toISOString() : null,
      status: game.status || null,
      home: local.name || '',
      away: visitante.name || '',
      homeId: local.id != null ? local.id : null,
      awayId: visitante.id != null ? visitante.id : null,
      /* Biwenger marca con «initialLineups» los partidos cuyos onces ya son
         los oficiales; sin esa marca, lo que hay son alineaciones probables. */
      confirmadas: !!game.initialLineups,
      homeScore: local.score != null ? local.score : null,
      awayScore: visitante.score != null ? visitante.score : null,
      where: game.location || null
    });
  });

  partidos.sort(function (a, b) { return String(a.start).localeCompare(String(b.start)); });


  /* «pending» y «preview» son los que aún no han empezado; el resto o están en
     juego o ya han acabado. */
  const jugados = partidos.filter(function (p) { return p.status === 'finished'; }).length;
  const empezados = partidos.filter(function (p) {
    return p.status && p.status !== 'pending' && p.status !== 'preview';
  }).length;

  const detalle = {
    id: data.id != null ? data.id : roundId,
    number: Number(String(data.short || '').replace(/\D/g, '')) || null,
    name: data.name || null,
    /* La mitad de la jornada, de la propia ronda. Hace falta como respaldo por
       si el calendario no la trae: sin ella, una jornada aplazada se colaba
       como si fuera propia. */
    part: data.part || 1,
    status: data.status || null,
    ideal: data.idealLineup || null,
    puntos: puntos,
    fichas: fichas,
    mvps: mvps,
    picas: picas,
    lances: lances,
    matches: partidos,
    played: jugados,
    games: partidos.length,
    live: empezados > 0 && jugados < partidos.length,
    /* ¿Hay algún partido a punto de empezar? */
    pronto: partidos.some(function (p) {
      const empieza = Date.parse(p.start);
      return !isNaN(empieza) && Math.abs(Date.now() - empieza) < 3 * 60 * 60 * 1000;
    })
  };

  cache.detalles[clave] = {
    data: detalle,
    at: Date.now(),
    /* Con la jornada viva, o con algún partido a menos de tres horas —las
       alineaciones se confirman una hora antes—, hay que mirar a menudo. */
    vigencia: (detalle.live || detalle.pronto) ? 2 * 60 * 1000 : 30 * 60 * 1000
  };
  return detalle;
}

/**
 * Los partidos de un futbolista esta temporada: el rival de cada jornada, el
 * resultado y lo que hizo él (goles, asistencias, tarjetas, cambios y nota).
 * Sale del detalle de cada jornada, que ya está cacheado.
 */
async function partidosDeJugador(env, id) {
  const score = await sistemaDeLaLiga(env);
  const names = await players(score);
  const clave = String(id);
  const slug = names[clave + ':slug'];
  const suEquipo = names[clave + ':team'];

  /* Su ficha trae, partido a partido, el rival, el resultado, los lances y
     —esto solo está aquí— los minutos jugados. El detalle de jornada no los
     publica, así que esta es la única fuente buena. */
  /* Biwenger vació el comodín: 'reports(*)' ya no trae los puntos, ni la
     jornada, ni los equipos, ni los minutos. Hay que pedir cada cosa por su
     nombre; si no, los informes llegan pelados y no se puede saber ni de qué
     partido eran ni qué hizo el futbolista en él. */
  const campos = 'fields=*,reports(*,points,rawStats,' +
    'match(*,round(*),home(*),away(*)),events(*))';
  /* Se prueba por slug y, si falla, por id. El id SIEMPRE vale como ruta
     —`/players/la-liga/19441` responde igual que `/players/la-liga/pedri`—, y
     así el que no tiene slug en el índice, o lo tiene cambiado porque Biwenger
     se lo renombró, deja de quedarse sin partidos. Antes se devolvía la lista
     vacía y en su ficha salía «todavía no hay partidos suyos». */
  const pedirFicha = async function (quien) {
    if (!quien) return null;
    const r = await fetch(CDN + '/players/la-liga/' + encodeURIComponent(quien) +
      '?lang=es&' + campos + '&score=' + encodeURIComponent(score),
      { headers: NAVEGADOR }).catch(function () { return null; });
    if (!r || !r.ok) return null;
    return (await r.json().catch(function () { return {}; })).data || null;
  };

  const data = (await pedirFicha(slug)) || (await pedirFicha(clave));
  if (!data) return { player: clave, matches: [] };
  const suyos = {};

  (data.reports || []).forEach(function (informe) {
    const partido = informe.match || {};
    const ronda = partido.round || {};
    const numero = Number(String(ronda.short || '').replace(/\D/g, '')) || null;
    if (numero == null) return;

    const bruto = informe.rawStats || {};
    /* La nota puede venir como número suelto o repartida por sistema de
       puntuación; y si no, está en el bruto como «score5». */
    const puntos = typeof informe.points === 'number'
      ? informe.points
      : ((informe.points && informe.points[String(score)] != null)
          ? informe.points[String(score)]
          : (bruto['score' + score] != null ? bruto['score' + score] : null));

    suyos[numero] = {
      round: ronda.id != null ? ronda.id : null,
      number: numero,
      home: (partido.home && partido.home.name) || '',
      away: (partido.away && partido.away.name) || '',
      homeId: partido.home && partido.home.id != null ? partido.home.id : null,
      awayId: partido.away && partido.away.id != null ? partido.away.id : null,
      homeScore: partido.home && partido.home.score != null ? partido.home.score : null,
      awayScore: partido.away && partido.away.score != null ? partido.away.score : null,
      start: partido.date ? new Date(partido.date * 1000).toISOString() : null,
      status: partido.status || null,
      enCasa: !!informe.home,
      points: puntos,
      alineado: true,
      minutes: bruto.minutesPlayed != null ? bruto.minutesPlayed : null,
      events: (informe.events || []).map(function (lance) {
        return { type: lance.type, minute: lance.metadata != null ? lance.metadata : null };
      })
    };
  });

  /* Y el calendario entero, para que estén las 38 jornadas aunque no jugara. */
  const calendario = await seasonRounds().catch(function () { return []; });

  /* Las jornadas en las que no jugó hay que mirarlas una a una para sacar el
     partido de su equipo. Se piden TODAS A LA VEZ: en fila iban treinta y ocho
     esperas encadenadas y la primera consulta de cada arranque tardaba veinte
     segundos. En paralelo tarda lo que la más lenta. */
  const propias = calendario.filter(function (jornada) {
    return (jornada.part || 1) === 1 && !suyos[jornada.number];
  });
  const detalles = {};
  /* Por tandas de seis con un respiro, no las treinta y ocho de golpe. Una
     ráfaga así es de las que hacen que Biwenger corte las consultas, y cuando
     corta no falla solo esto: cae también el índice de futbolistas y la web se
     queda sin nombres ni precios. Casi todas salen de la caché, así que en la
     práctica esto no se nota. */
  const TANDA_JORNADAS = 10;
  for (let i = 0; i < propias.length; i += TANDA_JORNADAS) {
    if (i) await new Promise(function (listo) { setTimeout(listo, 120); });
    await Promise.all(propias.slice(i, i + TANDA_JORNADAS).map(function (jornada) {
      return roundDetail(jornada.id, score)
        .then(function (d) { detalles[jornada.id] = d; })
        .catch(function () { detalles[jornada.id] = null; });
    }));
  }

  const salida = [];
  for (let i = 0; i < calendario.length; i++) {
    const jornada = calendario[i];
    if ((jornada.part || 1) !== 1) continue;
    const numero = jornada.number;

    if (suyos[numero]) { salida.push(suyos[numero]); continue; }

    /* Sin jugar: se busca el partido de su equipo para enseñarlo en blanco. */
    const detalle = detalles[jornada.id];
    const juego = ((detalle && detalle.matches) || []).filter(function (partido) {
      return String(partido.homeId) === String(suEquipo) || String(partido.awayId) === String(suEquipo);
    })[0];
    if (!juego) continue;

    salida.push({
      round: jornada.id, number: numero,
      home: juego.home, away: juego.away,
      homeId: juego.homeId, awayId: juego.awayId,
      homeScore: juego.homeScore, awayScore: juego.awayScore,
      start: juego.start || null, status: juego.status || null,
      enCasa: String(juego.homeId) === String(suEquipo),
      points: null, alineado: false, minutes: null, events: []
    });
  }

  salida.sort(function (a, b) { return (a.number || 0) - (b.number || 0); });

  return { player: clave, name: names[clave] || null, team: suEquipo,
    teamName: names['team:' + suEquipo] || null, matches: salida };
}

/**
 * El once ideal de la jornada: el que publica Biwenger para el sistema de
 * puntuación de la liga, que es el que se ve en su app.
 *
 * Su total puede no cuadrar al céntimo con la suma de los once mientras la
 * jornada está viva, porque las notas se siguen moviendo y su once está hecho
 * en un instante distinto al de las puntuaciones que leemos. Manda el suyo.
 *
 * Si todavía no ha publicado ninguno, se arma uno probando las catorce
 * formaciones y quedándose con la que más suma.
 */
async function bestXi(roundId, names, score) {
  const detalle = await roundDetail(roundId, score);
  if (!detalle) return null;

  /* Los puntos del detalle bailan entre peticiones; los del índice de
     futbolistas son los que enseña la app, en juego y ya cerrada. */
  /* Sin Súper Pica, a propósito. Este once es el de toda Primera División, no
     el de la liga: Biwenger lo publica igual para todo el mundo, y la Súper
     Pica es un ajuste de esta liga en concreto. Aplicándola, las chapas sumaban
     159 mientras su propia cabecera decía 154. Los 11 elegidos salen de él, así
     que aquí solo se pintan sus notas tal cual. */
  const salto = await saltoPorEquipo(detalle.number, score, detalle.id).catch(function () { return {}; });
  const delIndice = puntosDeLaJornada(names, salto);

  const ficha = function (id) {
    const clave = String(id);
    const dato = detalle.fichas[clave] || {};
    return {
      id: clave,
      name: dato.name || names[clave] || ('Jugador ' + clave),
      position: dato.position != null ? dato.position
        : (names[clave + ':pos'] != null ? names[clave + ':pos'] : null),
      points: delIndice[clave] != null ? delIndice[clave] : null,
      /* Para deshacer los empates: a igualdad de puntos, el once ideal se
         queda con el más caro. */
      marketValue: names[clave + ':price'] != null ? Math.round(names[clave + ':price']) : 0,
      team: dato.team != null ? dato.team : null,
      teamName: dato.teamName || null
    };
  };

  const oficial = detalle.ideal;
  if (oficial && (oficial.players || []).length) {
    /* Viene ordenado por líneas, igual que las alineaciones de los mánagers. */
    const elegidos = colocarEnSistema(
      oficial.players.map(function (jugador) { return ficha(jugador.id); }),
      oficial.type);
    return {
      type: oficial.type || null,
      points: oficial.points != null ? oficial.points
        : elegidos.reduce(function (t, j) { return t + (j.points || 0); }, 0),
      players: elegidos
    };
  }

  const porPuesto = { 1: [], 2: [], 3: [], 4: [] };
  Object.keys(detalle.puntos).forEach(function (id) {
    const jugador = ficha(id);
    /* Sin nota no entra: ordenar con nulos colaba a quien no ha jugado. */
    if (typeof jugador.points !== 'number') return;
    const puesto = jugador.position || 3;
    if (porPuesto[puesto]) porPuesto[puesto].push(jugador);
  });

  const total = Object.keys(porPuesto).reduce(function (suma, puesto) {
    return suma + porPuesto[puesto].length;
  }, 0);
  if (total === 0) return null;      // la jornada aún no ha puntuado

  /* A igualdad de puntos manda el de mayor valor, como dice Biwenger para sus
     onces ideales (en los rentables sería al revés, el más barato). */
  Object.keys(porPuesto).forEach(function (puesto) {
    porPuesto[puesto].sort(function (a, b) {
      return (b.points - a.points) || ((b.marketValue || 0) - (a.marketValue || 0));
    });
  });

  let mejor = null;
  SISTEMAS.forEach(function (sistema) {
    const lineas = sistema.split('-').map(Number);
    const elegidos = (porPuesto[1] || []).slice(0, 1)
      .concat((porPuesto[2] || []).slice(0, lineas[0]))
      .concat((porPuesto[3] || []).slice(0, lineas[1]))
      .concat((porPuesto[4] || []).slice(0, lineas[2]));
    if (elegidos.length < 11) return;
    const suma = elegidos.reduce(function (t, j) { return t + j.points; }, 0);
    if (!mejor || suma > mejor.points) mejor = { type: sistema, points: suma, players: elegidos };
  });

  return mejor;
}

/**
 * Clasificación de una jornada con la alineación de cada mánager. Biwenger
 * solo la enseña cuando la jornada ha empezado; antes llegan vacías.
 */
async function roundBoard(env, headers, jornada, listaNombres) {
  const calendar = await seasonRounds().catch(function () { return []; });
  let wanted = String(jornada) === 'actual' ? '' : String(jornada);

  /* «actual» ya viene resuelto de fuera, en jornadaActualEfectiva(). */
  /* La jornada va en la ruta, no como parámetro: su propia web pide
     /rounds/league/<id>. Con ?round= contestaba siempre la actual, y por eso
     elegir otra jornada no cambiaba nada. */
  let data = null;
  try {
    data = await api(env, '/rounds/league' + (wanted ? '/' + encodeURIComponent(wanted) : ''), headers);
  } catch (error) {
    if (!wanted) throw error;
    /* Por si acaso cambian de idea: la forma antigua como red de seguridad. */
    data = await api(env, '/rounds/league?round=' + encodeURIComponent(wanted), headers);
  }

  const round = (data && data.round) || {};
  const ficha = calendar.filter(function (r) { return String(r.id) === String(round.id); })[0] || {};

  /* Cada liga puntúa con un sistema (esta, el 5: la media del AS y SofaScore).
     Si el índice se bajó con otro, se vuelve a pedir con este. */
  /* Si la respuesta de la liga no trae el sistema, se tira del guardado en vez
     de quedarse en null: con null se pide todo sin `score` y llegan los puntos
     del sistema 1, que no son los de esta liga. */
  const score = ((data && data.league) || {}).scoreID
    || await sistemaDeLaLiga(env).catch(function () { return null; })
    || cache.score || null;
  if (score) cache.score = score;
  let names = listaNombres;
  if (score && cache.playersScore !== score) {
    names = await players(score).catch(function () { return listaNombres; });
  }

  const detalle = round.id != null
    ? await roundDetail(round.id, score).catch(function () { return null; })
    : null;

  /* Los puntos salen SIEMPRE del índice de futbolistas, esté la jornada en
     juego o cerrada. Los del detalle de jornada no valen: para el mismo
     futbolista y el mismo partido ya terminado devolvían 6, 8 o 4 según la
     petición, y no traen `rawStats` con el que comprobarlos. Los del índice
     cuadran al punto con lo que enseña Biwenger, jornada a jornada. */
  const numeroJornada = ficha.number != null ? ficha.number
    : ((detalle && detalle.number) != null ? detalle.number : null);
  const salto = await saltoPorEquipo(numeroJornada, score, round.id).catch(function () { return {}; });
  const primas = await primasDeLaLiga(env).catch(function () { return null; });
  /* La base sale del historial; abajo se sustituye por las notas buenas y solo
     entonces se aplican la Súper Pica y las correcciones. Al revés se perdían:
     las notas buenas pisaban lo que ya se había ajustado. */
  const base = puntosDeLaJornada(names, salto);

  /* En qué anda el partido de cada club: sirve para distinguir al que no ha
     puntuado del que todavía no ha jugado. */
  const partidoDe = {};
  const enCasa = {};
  ((detalle && detalle.matches) || []).forEach(function (partido) {
    if (partido.homeId != null) { partidoDe[partido.homeId] = partido.status; enCasa[partido.homeId] = true; }
    if (partido.awayId != null) { partidoDe[partido.awayId] = partido.status; enCasa[partido.awayId] = false; }
  });

  /* Antes de que arranque la jornada, Biwenger a veces manda el once y el
     «played»/«points» de la anterior, tal cual, porque el mánager no ha
     tocado la alineación desde entonces. Aquí se empieza de cero: jugadores
     y puntos son de ESTA jornada, y esta jornada todavía no ha jugado nada. */
  const empezada = ficha.status && ficha.status !== 'pending';

  /* Las notas buenas, de la ficha de cada futbolista alineado: es lo único que
     dice a qué jornada pertenece cada una. Se piden solo de los que están en
     alguna alineación —unos noventa, no los quinientos del índice— y se guardan
     en cuanto la jornada cierra. Si algo falla, se sigue con el historial, que
     acierta en la mayoría. */
  const alineados = {};
  (((data && data.league) || {}).standings || []).forEach(function (fila) {
    const lineup = fila && fila.lineup;
    ((lineup && lineup.players) || []).concat((lineup && (lineup.discarded || lineup.bench)) || [])
      .forEach(function (entry) {
        const j = (entry && typeof entry === 'object') ? ((entry.player || entry)) : { id: entry };
        if (j && j.id != null) alineados[String(j.id)] = true;
      });
  });

  const cerrada = ficha.status === 'finished' &&
    !!detalle && (detalle.played || 0) >= (detalle.games || 0) && (detalle.games || 0) > 0;
  const buenas = await notasDeLaJornada(env, Object.keys(alineados), names, score,
    numeroJornada, cerrada, partidoDe).catch(function () { return null; });
  if (buenas && buenas.notas) {
    Object.keys(buenas.notas).forEach(function (id) { base[id] = buenas.notas[id]; });
  }

  /* En qué puesto jugó cada uno de verdad. De la ficha si la hemos leído; si
     no, su demarcación de siempre, que es la que acierta casi siempre. */
  const posReales = {};
  Object.keys((detalle && detalle.fichas) || {}).forEach(function (id) {
    const p = detalle.fichas[id].position;
    if (p != null) posReales[id] = p;
  });
  Object.keys((buenas && buenas.posiciones) || {}).forEach(function (id) {
    posReales[id] = buenas.posiciones[id];
  });

  /* Goles de cada uno esta jornada, para poder recolocarlos si el mánager lo
     alineó en otra línea. Solo los de jugada (tipo 1): el de penalti (tipo 2)
     es otro concepto en el baremo. */
  const golesDe = {};
  ((detalle && detalle.lances) || []).forEach(function (lance) {
    if (lance && lance.type === 1) golesDe[String(lance.id)] = (golesDe[String(lance.id)] || 0) + 1;
  });

  /* Y ahora sí: la Súper Pica de esta liga y las correcciones, encima de las
     notas buenas. */
  const marcador = conCorrecciones(conSuperPica(base, detalle, primas), numeroJornada);

  const standings = (((data && data.league) || {}).standings || []).filter(Boolean).map(function (row) {
    const lineup = row.lineup || null;
    /* Primero se coloca el once en sus líneas y solo después se recolocan los
       goles: hasta que no está puesto no se sabe de qué juega cada uno aquí. */
    const once = recolocarGoles(colocarEnSistema(
      ((lineup && lineup.players) || []).map(function (entry) { return roundPlayer(entry, names, marcador, partidoDe, enCasa,
        (detalle && detalle.lances) || []); }).filter(Boolean),
      lineup && lineup.type), golesDe, posReales);
    /* Biwenger llama «discarded» a los que se quedaron fuera: el banquillo. */
    const banquillo = ((lineup && (lineup.discarded || lineup.bench)) || [])
      .map(function (entry) {
        return roundPlayer(entry, names, marcador, partidoDe, enCasa,
          (detalle && detalle.lances) || []);
      }).filter(Boolean);

    /* Biwenger deja la clasificación de la jornada a cero hasta que la cierra,
       así que mientras tanto se suma el once a mano y los puntos van subiendo
       según acaba cada partido.

       Los negativos SÍ restan. Se probó a no restarlos y entonces la tabla
       dejaba de cuadrar con la de Biwenger (Jordaan 24 en vez de 22, Eneko 22
       en vez de 21, jornada 1): su clasificación los resta, así que aquí
       también. Al que pincha se le sigue viendo en rojo en su chapa. */
    const enJuego = once.reduce(function (t, p) { return t + (p.points || 0); }, 0);

    /* Regla de Biwenger: cuatro puntos menos por cada hueco sin cubrir en la
       alineación; si está entera vacía, no se penaliza, son cero puntos. Un
       jugador cuyo partido aún no ha acabado NO es un hueco: está alineado. */
    const huecos = once.length ? Math.max(0, 11 - once.length) : 0;
    const sumado = enJuego - huecos * 4;

    const oficiales = lineup && lineup.points != null ? lineup.points
      : (row.points != null ? row.points : null);
    /* Cuenta el que ya tiene su jornada resuelta, puntúe o no: si en su chapa
       hay un guion, cuenta. Da igual que el guion sea porque su partido acabó
       y no jugó (Lemar) o porque se fue de LaLiga y ya no va a jugar (Manu
       Fernández): los dos están cerrados, y contar uno sí y otro no era una
       incoherencia nuestra. Solo se queda fuera el que aún tiene el partido
       por delante, que es el de la interrogación. */
    const jugados = once.filter(function (p) { return !p.pending; }).length;

    return {
      id: row.id != null ? String(row.id) : null,
      name: row.name || '',
      icon: iconUrl(row.icon),
      position: row.position != null ? row.position : null,
      /* Manda lo calculado aquí, teniendo el once: con la Súper Pica aplicada
         cuadra al punto con la tabla de Biwenger en los ocho mánagers de la
         jornada 2. Su campo oficial no se usa —lleva toda la temporada a cero
         mientras la jornada 1 siga con aplazados—, pero se manda al lado para
         poder cotejarlo el día que lo publique. */
      points: !empezada ? 0 : (once.length ? sumado : (oficiales || 0)),
      pointsOfficial: oficiales || null,
      played: !empezada ? 0
        : (once.length ? jugados : (lineup && lineup.played != null ? lineup.played : null)),
      /* Al mánager que empieza la jornada con saldo negativo Biwenger no le
         cuenta esa jornada: ni suma ni resta. Lo dice él mismo en la
         alineación, con `count: false`. Los puntos se siguen enseñando (su
         app los pinta en rojo), pero no entran en la general. */
      counts: !(lineup && lineup.count === false),
      /* Huecos sin cubrir en el once, a cuatro puntos de penalización cada
         uno: se manda para poder explicarlo en la web. */
      gaps: !empezada ? 0 : huecos,
      type: (lineup && lineup.type) || null,
      xi: once,
      bench: banquillo,
      xiValue: once.reduce(function (sum, p) { return sum + (p.marketValue || 0); }, 0)
    };
  });

  /* El valor del once cuenta para desempatar la clasificación de la jornada, y
     Biwenger lo mide con los precios del día en que empezó, no con los de hoy.
     El CDN publica el histórico de cada futbolista, así que se le pregunta por
     ese día concreto; las series quedan cacheadas y se reaprovechan. */
  const arranque = ((detalle && detalle.matches) || [])
    .map(function (partido) { return Date.parse(partido.start); })
    .filter(function (t) { return !isNaN(t); })
    .sort(function (a, b) { return a - b; })[0];

  if (arranque) {
    const dia = isoDay(arranque);
    const alineados = [];
    standings.forEach(function (fila) {
      (fila.xi || []).forEach(function (jugador) {
        if (jugador && jugador.id != null) alineados.push(String(jugador.id));
      });
    });

    /* Si ya se calculó antes para ese mismo día, se reaprovecha: son casi cien
       consultas al CDN y no cambian, la jornada ya empezó. */
    const guardada = await kvLeer(env, round.id).catch(function () { return null; });
    const antiguos = {};
    (((guardada || {}).standings) || []).forEach(function (fila) {
      if (fila && fila.xiValueDay === dia && fila.xiValue != null) antiguos[String(fila.id)] = fila.xiValue;
    });
    const faltan = standings.some(function (fila) { return antiguos[String(fila.id)] == null; });

    if (alineados.length && !faltan) {
      standings.forEach(function (fila) {
        fila.xiValue = antiguos[String(fila.id)];
        fila.xiValueDay = dia;
      });
    } else if (alineados.length) {
      const precios = await pricesOnDay(alineados, dia, names).catch(function () { return {}; });
      standings.forEach(function (fila) {
        fila.xiValue = (fila.xi || []).reduce(function (suma, jugador) {
          const ese = precios[String(jugador.id)];
          return suma + (ese != null ? ese : (jugador.marketValue || 0));
        }, 0);
      });
      /* Para poder decir de cuándo son esos precios. */
      standings.forEach(function (fila) { fila.xiValueDay = dia; });
    }
  }

  const once = round.id != null
    ? await bestXi(round.id, names, score).catch(function () { return null; })
    : null;

  /* ---------- Lo que cobra cada mánager por esta jornada ----------
     La liga paga por punto, por meter gente en el once ideal y por alinear al
     mejor de un partido o de la jornada. Biwenger no lo abona hasta el día
     siguiente de cerrarla, así que hasta entonces esto es una previsión: sale
     de los mismos puntos que ya se enseñan, no de un número inventado.
     `primas` ya se pidió arriba, que es donde hace falta para la Súper Pica. */
  if (primas) {
    const enIdeal = {};
    ((once && once.players) || []).forEach(function (jugador) {
      if (jugador && jugador.id != null) enIdeal[String(jugador.id)] = true;
    });
    const mvps = (detalle && detalle.mvps) || {};

    /* El MVP de la jornada es el que más puntúa de todos los que sí fueron el
       mejor de su partido. Sin jornada cerrada todavía puede moverse. */
    let mejor = null;
    Object.keys(mvps).forEach(function (id) {
      const nota = marcador[id];
      if (typeof nota !== 'number') return;
      if (!mejor || nota > mejor.nota) mejor = { id: id, nota: nota };
    });

    standings.forEach(function (fila) {
      let ideales = 0, mejores = 0, deJornada = 0;
      (fila.xi || []).forEach(function (jugador) {
        const id = String(jugador.id);
        if (enIdeal[id]) { jugador.ideal = true; ideales++; }
        if (mvps[id]) { jugador.mvp = true; mejores++; }
        if (mejor && id === mejor.id) deJornada++;
      });

      /* Al que arranca la jornada en números rojos Biwenger no le cuenta la
         jornada, y con ella se va todo el abono: ni puntos, ni once ideal, ni
         MVP. Confirmado en la jornada 2, con Eneko a 25 puntos y cero euros. */
      if (!fila.counts) {
        fila.abono = { total: 0, puntos: 0, ideal: 0, mvp: 0, motivo: 'negativo' };
        return;
      }

      /* Si la liga no resta por puntuación negativa, el abono por puntos se
         queda en cero pero nunca baja de ahí. */
      const cuentan = primas.restaSiNegativo ? fila.points : Math.max(0, fila.points);
      const porPuntos = cuentan * primas.porPunto;
      const porIdeal = ideales * primas.onceIdeal;
      const porMvp = mejores * primas.mvpPartido + deJornada * primas.mvpJornada;

      fila.abono = {
        total: primas.fija + porPuntos + porIdeal + porMvp,
        puntos: porPuntos,
        ideal: porIdeal,
        mvp: porMvp,
        motivo: null
      };
    });
  }

  let payload = {
    round: {
      id: round.id != null ? round.id : null,
      /* Si el calendario no trae esta ronda —pasa: se pide una que se acaba de
         crear, o `seasonRounds` viene de una copia vieja—, `ficha` llega vacía
         y salían `number: null` y `part: 1`. Con eso, la JORNADA 1 APLAZADA se
         guardaba como si fuera una jornada propia sin número, y de ahí contaba
         como una jornada más: a Lemar le salían 4 partidos habiéndose jugado
         tres, y a Buonanotte 2 habiendo jugado 1. El detalle de la ronda sí
         sabe quién es, así que se usa de respaldo. */
      number: ficha.number != null ? ficha.number
        : ((detalle && detalle.number) != null ? detalle.number : null),
      name: ficha.name || (round.id ? 'Jornada ' + round.id : ''),
      /* La mitad aplazada de una jornada (part 2) repite los mismos partidos
         que la primera. Sin esta marca aquí, la web no podía distinguirlas y
         contaba dos veces a los mismos futbolistas. */
      part: ficha.part || (detalle && detalle.part) || 1,
      status: ficha.status || (detalle && detalle.status) || null
    },
    rounds: calendar,
    standings: standings,
    bestXi: once,
    /* Los importes que paga la liga, para poder explicarlos en la web sin
       repetirlos allí: si se cambian en Biwenger, cambian aquí solos. */
    primas: primas,
    /* Con qué versión del proxy se calcularon estos puntos. La web lo guarda
       junto a la jornada: así se puede ver de un vistazo si lo que estás
       mirando lo calculó la versión desplegada o una vieja que se quedó en la
       caché del navegador. */
    calc: VERSION,
    updatedAt: new Date().toISOString()
  };

  /* Se cruza con lo ya guardado y se devuelve la versión completa; si alguien
     ha capturado la alineación desde el móvil, aquí sigue estando. */
  if (payload.round.id != null) {
    payload = mezclarJornada(await kvLeer(env, payload.round.id), payload);
    refrescarNombres(payload, names);
    const alineaciones = payload.standings.filter(function (fila) { return (fila.xi || []).length; }).length;
    if (alineaciones) await kvGuardar(env, payload.round.id, payload);
  }

  return payload;
}

/**
 * Vuelve a poner el nombre de cada futbolista con el índice de AHORA.
 *
 * El nombre se escribe dentro del once cuando se calcula la jornada, y la
 * jornada se guarda. Si en ese momento el índice estaba caído —Biwenger corta
 * las consultas y devuelve un 200 sin datos—, se guardaba «Jugador 19441» y ahí
 * se quedaba para siempre, aunque el índice volviera al minuto siguiente: nadie
 * lo recalculaba. Repasándolo aquí, en cada respuesta, esas jornadas se curan
 * solas en cuanto Biwenger contesta una vez.
 */
function refrescarNombres(payload, names) {
  if (!names || !Object.keys(names).length) return;   // sin índice, no se toca nada
  const arreglar = function (lista) {
    (lista || []).forEach(function (jugador) {
      if (!jugador || jugador.id == null) return;
      const bueno = names[String(jugador.id)];
      if (bueno) jugador.name = bueno;
    });
  };
  (payload.standings || []).forEach(function (fila) {
    arreglar(fila.xi);
    arreglar(fila.bench);
  });
  /* El once ideal viene como { type, points, players }, no como lista suelta. */
  arreglar(payload.bestXi && payload.bestXi.players);
}

/**
 * Los que más se mueven de precio hoy. Sale del índice que ya se ha
 * descargado, así que no cuesta ninguna llamada más.
 */
function movers(names, cuantos) {
  const lista = [];
  Object.keys(names).forEach(function (clave) {
    if (clave.indexOf(':') !== -1) return;      // las claves con ':' son atributos
    const id = clave;
    const inc = names[id + ':inc'] || 0;
    if (!inc) return;
    lista.push({
      id: id,
      name: names[id],
      position: names[id + ':pos'] != null ? names[id + ':pos'] : null,
      altPositions: otrosPuestos(names, id),
      marketValue: names[id + ':price'] != null ? Math.round(names[id + ':price']) : null,
      increment: inc,
      status: names[id + ':status'] || null,
      team: names[id + ':team'] != null ? names[id + ':team'] : null,
      teamName: names['team:' + names[id + ':team']] || null
    });
  });

  lista.sort(function (a, b) { return b.increment - a.increment; });
  return {
    up: lista.slice(0, cuantos),
    down: lista.slice(-cuantos).reverse().filter(function (p) { return p.increment < 0; })
  };
}

/* ---------- Normalización ---------- */

/* Tipos del tablón que mueven dinero. `market` son fichajes al mercado y
   `transfer` ventas o traspasos entre mánagers. */
const MONEY_TYPES = ['market', 'transfer', 'adminTransfer', 'exchange', 'loan', 'loanReturn', 'clauseIncrement'];

/**
 * Altas, bajas y cambios de club en LaLiga de verdad. Biwenger los publica en
 * el mismo tablón, como avisos de tipo «playerMovements»: cada uno trae varios
 * apuntes, unos de tipo «leave» (se va de un club) y otros «join» (llega).
 */
function movimientosDeLaLiga(board, names) {
  const salida = [];

  (board || []).forEach(function (post) {
    if (!post || post.type !== 'playerMovements') return;
    const fecha = post.date ? new Date(post.date * 1000).toISOString() : null;

    (post.content || []).forEach(function (apunte) {
      const id = apunte && apunte.player != null ? String(apunte.player) : null;
      if (!id) return;

      const club = apunte.team || apunte.to || null;
      const antes = apunte.from || null;

      salida.push({
        playerId: id,
        player: names[id] || ('Jugador ' + id),
        position: names[id + ':pos'] != null ? names[id + ':pos'] : null,
        altPositions: otrosPuestos(names, id),
        /* «join» es alta o fichaje; «leave», baja. */
        tipo: apunte.type === 'leave' ? 'baja' : 'alta',
        team: club && club.id != null ? club.id : (names[id + ':team'] != null ? names[id + ':team'] : null),
        teamName: (club && club.name) || names['team:' + names[id + ':team']] || null,
        desde: antes && antes.name ? antes.name : null,
        desdeId: antes && antes.id != null ? antes.id : null,
        marketValue: names[id + ':price'] != null ? Math.round(names[id + ':price']) : null,
        status: names[id + ':status'] || null,
        /* ¿Sigue en LaLiga? Si la baja es para irse a otro club, sí. */
        sigue: names[id + ':team'] != null && !!names['team:' + names[id + ':team']],
        date: fecha
      });
    });
  });

  return salida;
}

/* Cómo se llama cada concepto del reparto, para poder desglosarlo. */
const CONCEPTOS_DE_PRIMA = {
  bonusPoint: 'por puntos',
  bonusFixed: 'fijo',
  bonusIdealLineup: 'once ideal',
  bonusGameMVP: 'MVP de partido',
  bonusRoundMVP: 'MVP de la jornada'
};

/**
 * Los abonos de una jornada, sacados del tablón.
 *
 * Biwenger publica el reparto al cerrar la jornada, en un aviso de tipo
 * `roundFinished` que trae la lista entera de mánagers con sus puntos y lo que
 * cobra cada uno:
 *
 *   {"type":"roundFinished","content":{"round":{"name":"Jornada 2"},
 *     "results":[{"user":{...},"points":65,"bonus":3550000,
 *       "reason":{"bonusPoint":3250000,"bonusIdealLineup":[100000,2],
 *                 "bonusGameMVP":[200000,2]}}, …]}}
 *
 * En `reason` cada concepto viene como importe suelto o como [importe, cuántas
 * veces]; quien solo cobra por puntos no trae `reason`. Al que no cobra nada
 * —el que empieza la jornada en negativo— le falta el campo `bonus` entero, y
 * entonces no se le hace línea: en una lista de ingresos, una fila de 0 € no
 * cuenta nada. Sus puntos tachados ya salen en la tabla de la jornada.
 */
function abonosDelTablon(board) {
  const salida = [];

  (board || []).forEach(function (post) {
    if (post.type !== 'roundFinished') return;
    const date = post.date ? new Date(post.date * 1000).toISOString() : null;
    const contenido = post.content || {};
    const jornada = (contenido.round || {}).name || null;

    (contenido.results || []).filter(Boolean).forEach(function (fila) {
      const quien = (fila.user && fila.user.name) || null;
      const importe = fila.bonus;
      if (!quien || importe == null || isNaN(Number(importe))) return;

      /* El desglose, para poder contarlo al pasar por encima. */
      const razones = fila.reason || {};
      const detalle = Object.keys(razones).map(function (concepto) {
        const valor = razones[concepto];
        const nombre = CONCEPTOS_DE_PRIMA[concepto] || concepto;
        return Array.isArray(valor)
          ? valor[0] + ' € ' + nombre + ' ×' + valor[1]
          : valor + ' € ' + nombre;
      });

      salida.push({
        playerId: null,
        /* En la lista de fichajes va en el sitio del futbolista: no hay ninguno
           que enseñar, y lo que interesa es de qué es el dinero. */
        player: 'Abono de puntos',
        type: 'bonus',
        manager: quien,
        /* La jornada, que es contra quién se cobra. */
        otro: jornada,
        amount: Math.round(Number(importe)),
        date: date,
        source: post.type,
        roundPoints: fila.points != null ? fila.points : null,
        detail: detalle.length ? detalle.join(' · ') : null,
        team: null,
        teamName: null,
        status: null,
        position: null,
        points: null,
        marketValue: null
      });
    });
  });

  return salida;
}

function normalizeBoard(board, names) {
  const movements = abonosDelTablon(board);

  (board || []).forEach(function (post) {
    if (MONEY_TYPES.indexOf(post.type) === -1) return;
    const date = post.date ? new Date(post.date * 1000).toISOString() : null;

    (post.content || []).filter(Boolean).forEach(function (item) {
      const amount = item.amount != null ? item.amount : item.price;
      if (amount == null) return;

      const playerId = item.player != null ? String(item.player) : null;
      const seller = item.from && item.from.name;
      const buyer = (item.to && item.to.name) || (item.user && item.user.name);

      // Compra: hay comprador. Venta al mercado: solo vendedor.
      const name = (playerId && names[playerId]) || ('Jugador ' + playerId);
      /* Club del futbolista, para pintar su escudo en Fichajes. */
      const team = playerId && names[playerId + ':team'] != null ? names[playerId + ':team'] : null;
      const teamName = names['team:' + team] || null;
      /* Estado de hoy; la calculadora lo congela la primera vez que ve el
         movimiento, porque Biwenger no guarda el de aquel día. */
      const estado = playerId ? (names[playerId + ':status'] || null) : null;
      const puesto = playerId && names[playerId + ':pos'] != null ? names[playerId + ':pos'] : null;
      /* Puntos y valor de hoy: la ficha del futbolista los necesita aunque se
         abra desde Fichajes, donde no hay plantilla ni mercado que consultar. */
      const puntos = playerId && names[playerId + ':pts'] != null ? names[playerId + ':pts'] : null;
      const valorHoy = playerId && names[playerId + ':price'] != null
        ? Math.round(names[playerId + ':price']) : null;

      if (buyer) {
        movements.push({
          playerId: playerId,
          player: name,
          type: 'buy',
          manager: buyer,
          /* De quién lo compró: otro mánager, o el mercado si no hay nadie. */
          otro: seller || null,
          amount: Math.round(amount),
          date: date,
          source: post.type,
          team: team,
          teamName: teamName,
          status: estado,
          position: puesto,
          points: puntos,
          marketValue: valorHoy
        });
      }
      if (seller) {
        movements.push({
          playerId: playerId,
          player: name,
          type: 'sell',
          manager: seller,
          /* A quién se lo vendió; sin comprador, se fue al mercado. */
          otro: buyer || null,
          amount: Math.round(amount),
          date: date,
          source: post.type,
          team: team,
          teamName: teamName,
          status: estado,
          position: puesto,
          points: puntos,
          marketValue: valorHoy
        });
      }
    });
  });

  return movements;
}

/* Los avatares llegan como URL absoluta (Google, Facebook) o como ruta
   relativa al CDN de Biwenger. */
function iconUrl(icon) {
  if (!icon) return null;
  return /^https?:\/\//i.test(icon) ? icon : 'https://cdn.biwenger.com/' + icon;
}

function normalizeStandings(league) {
  const rows = ((league && (league.standings || league.users)) || []).filter(Boolean);
  return rows.map(function (row) {
    return {
      id: row.id != null ? String(row.id) : null,
      name: row.name,
      icon: iconUrl(row.icon),
      balance: row.balance != null ? row.balance : null,
      teamValue: row.teamValue != null ? row.teamValue : null,
      teamSize: row.teamSize != null ? row.teamSize : null,
      points: row.points != null ? row.points : null,
      /* Última vez que entró en Biwenger; la liga lo publica si tiene activado
         «mostrar último acceso». */
      lastAccess: row.lastAccess ? new Date(row.lastAccess * 1000).toISOString() : null
    };
  });
}

/* Pujas y ofertas pendientes. Biwenger solo publica aquellas en las que eres
   parte: las pujas de los demás mánagers no las expone ninguna ruta, es una
   subasta a ciegas. Salen tanto las que envías como las que recibes. */
function normalizeOffers(offers, names, myId) {
  return (offers || [])
    .filter(function (offer) { return offer && offer.status === 'waiting'; })
    .map(function (offer) {
      const requested = (offer.requestedPlayers || [])[0];
      const id = requested && typeof requested === 'object' ? requested.id : requested;
      const outgoing = !!(offer.from && (!myId || String(offer.from.id) === String(myId)));
      const other = outgoing
        ? (offer.to && offer.to.name) || 'Mercado'
        : (offer.from && offer.from.name) || 'Mercado';
      return {
        id: String(offer.id),
        playerId: id != null ? String(id) : null,
        player: (id != null && names[String(id)]) || ('Jugador ' + id),
        amount: Math.round(offer.amount || 0),
        direction: outgoing ? 'out' : 'in',
        other: other,
        until: offer.until ? new Date(offer.until * 1000).toISOString() : null,
        team: id != null && names[String(id) + ':team'] != null ? names[String(id) + ':team'] : null,
        teamName: names['team:' + names[String(id) + ':team']] || null
      };
    })
    .sort(function (a, b) { return b.amount - a.amount; });
}

/** Jugadores propios puestos a la venta en el mercado. */
function normalizeListings(user, names) {
  return ((user && user.market) || [])
    .filter(function (item) { return item && item.type === 'sale'; })
    .map(function (item) {
      const id = item.playerID != null ? String(item.playerID) : null;
      const market = id ? names[id + ':price'] : null;
      return {
        playerId: id,
        player: (id && names[id]) || ('Jugador ' + id),
        price: Math.round(item.price || 0),
        marketValue: market != null ? Math.round(market) : null,
        until: item.until ? new Date(item.until * 1000).toISOString() : null,
        team: id && names[id + ':team'] != null ? names[id + ':team'] : null,
        teamName: names['team:' + names[id + ':team']] || null
      };
    })
    .sort(function (a, b) { return b.price - a.price; });
}

/**
 * El mercado de hoy: cada jugador en venta, quién lo vende y cuántas pujas
 * lleva. Biwenger no deja ver las pujas de lo que vendes tú.
 */
async function marketBoard(env, headers, myId, names) {
  const [market, league] = await Promise.all([
    api(env, '/market', headers),
    api(env, '/league?fields=standings', headers)
  ]);

  const dueños = {};
  ((league && league.standings) || []).filter(Boolean).forEach(function (row) {
    dueños[String(row.id)] = row.name;
  });

  const ventas = ((market && market.sales) || []).filter(Boolean).map(function (item) {
    const id = item.player && item.player.id != null ? String(item.player.id) : null;
    const vendedor = item.user && item.user.id != null ? String(item.user.id) : null;
    return {
      playerId: id,
      player: (id && names[id]) || ('Jugador ' + id),
      position: id && names[id + ':pos'] != null ? names[id + ':pos'] : null,
      altPositions: id ? otrosPuestos(names, id) : [],
      marketValue: id && names[id + ':price'] != null ? Math.round(names[id + ':price']) : null,
      increment: id ? (names[id + ':inc'] || 0) : 0,
      status: id ? (names[id + ':status'] || null) : null,
      team: id && names[id + ':team'] != null ? names[id + ':team'] : null,
      teamName: id ? (names['team:' + names[id + ':team']] || null) : null,
      points: id && names[id + ':pts'] != null ? names[id + ':pts'] : null,
      pointsLastSeason: id && names[id + ':ptsPrev'] != null ? names[id + ':ptsPrev'] : null,
      price: Math.round(item.price || 0),
      until: item.until ? new Date(item.until * 1000).toISOString() : null,
      sellerId: vendedor,
      saleType: item.type || null,
      free: !vendedor,
      seller: vendedor ? (dueños[vendedor] || 'Un mánager') : 'Libre',
      mine: !!(vendedor && myId && vendedor === String(myId))
    };
  });

  ventas.sort(function (a, b) { return (b.marketValue || 0) - (a.marketValue || 0); });
  return { sales: ventas, updatedAt: new Date().toISOString() };
}

/* ---------- Histórico de valor de equipo ---------- */

/* Biwenger no publica la evolución del valor de equipo, pero se puede
   reconstruir: se parte de la plantilla de hoy, se deshacen los fichajes hacia
   atrás para saber quién tenía cada día, y se suman los precios diarios que sí
   publica el CDN para cada jugador. */

const ymd = (day) => Number(day.slice(2, 4) + day.slice(5, 7) + day.slice(8, 10));
const isoDay = (time) => new Date(time).toISOString().slice(0, 10);

async function playerPrices(slug) {
  if (cache.prices[slug]) return cache.prices[slug];
  const response = await fetch(CDN + '/players/la-liga/' + slug + '?fields=*,prices', {
    headers: NAVEGADOR
  });
  if (!response.ok) return null;
  const body = await response.json();
  const prices = (body.data && body.data.prices) || [];
  cache.prices[slug] = prices;
  return prices;
}

/** Precio del jugador ese día, o el último conocido antes de esa fecha. */
function priceOn(prices, stamp) {
  let value = null;
  for (let i = 0; i < prices.length; i++) {
    if (prices[i][0] > stamp) break;
    value = prices[i][1];
  }
  return value;
}

/**
 * Lo que valía cada uno de esos jugadores un día dado. Sirve para saber cuánto
 * se ha revalorizado quien llegó en el reparto inicial, que no tiene precio de
 * compra con el que comparar.
 */
/**
 * ¿Nos ha cortado el CDN hace nada?
 *
 * La API privada ya llevaba freno (`cache.limitedUntil`), pero el CDN —de donde
 * salen el índice, las fichas y los precios— no tenía ninguno: si cortaba, se
 * le seguía preguntando en cada petición y eso solo alarga el castigo. Se marca
 * al primer 429 y durante ese rato se deja de pedir lo prescindible.
 */
function cdnCortado() {
  return !!(cache.cdnHasta && Date.now() < cache.cdnHasta);
}

function apuntarCorteDelCdn(respuesta) {
  if (respuesta && (respuesta.status === 429 || respuesta.status === 403)) {
    cache.cdnHasta = Date.now() + 90 * 1000;
    return true;
  }
  return false;
}

/**
 * Recorre una lista en tandas, con un respiro entre ellas.
 *
 * Biwenger corta las consultas cuando le llega una ráfaga, y cuando corta no
 * falla solo lo que la provocó: se cae también la descarga del índice de
 * futbolistas y la web entera se queda en «Jugador 1679» a 0 €, sin nombres ni
 * precios. Por eso NINGUNA lista larga se pide de golpe.
 */
async function porTandas(lista, tam, pausa, hacer) {
  for (let i = 0; i < lista.length; i += tam) {
    if (i) await new Promise(function (listo) { setTimeout(listo, pausa); });
    await Promise.all(lista.slice(i, i + tam).map(hacer));
  }
}

/**
 * Separa los que ya tienen la serie de precios guardada de los que hay que
 * pedir. Los guardados se resuelven de golpe: frenarlos también sería regalar
 * cuatro segundos de espera en cada carga de jornada sin tocar la red.
 */
function precioYaGuardado(ids, names) {
  const listos = [], porPedir = [];
  (ids || []).forEach(function (id) {
    const clave = String(id).trim();
    if (!clave) return;
    const slug = names[clave + ':slug'] || clave;
    (cache.prices[slug] ? listos : porPedir).push(clave);
  });
  return { listos: listos, porPedir: porPedir };
}

async function pricesOnDay(ids, dia, names) {
  const stamp = /^\d{4}-\d{2}-\d{2}$/.test(dia) ? ymd(dia) : null;
  const salida = {};
  if (!stamp) return salida;

  /* Lo que valia cada uno un dia concreto NO cambia nunca: ese dia ya paso. Se
     guarda en el KV y solo se preguntan los que falten.

     Sin esto, cada arranque en frio del proxy —cualquier despliegue— volvia a
     pedir el historico de precios de los casi cien alineados, y eso es lo que
     acaba haciendo que Biwenger corte las consultas y la web se quede sin
     nombres ni precios. Son unos 6 KB: nada. */
  const claveDia = 'precios-' + stamp;
  let guardados = {};
  if (JORNADAS) {
    try {
      const crudo = await JORNADAS.get(claveDia);
      if (crudo) guardados = JSON.parse(crudo) || {};
    } catch (error) { /* se piden todos */ }
  }
  const porPedir = [];
  (ids || []).forEach(function (id) {
    const clave = String(id).trim();
    if (!clave) return;
    if (guardados[clave] != null) salida[clave] = guardados[clave];
    else porPedir.push(clave);
  });
  if (!porPedir.length) return salida;
  /* Cortado: se devuelve lo que hubiera guardado. El valor del once es un
     desempate, no un dato esencial: no merece insistir y alargar el corte. */
  if (cdnCortado()) return salida;
  ids = porPedir;

  /* Son los once de cada mánager: casi noventa. De golpe era la ráfaga más
     grande que soltábamos, y en cada carga de jornada. Los que ya están
     guardados se resuelven sin frenos; solo se dosifican los que van a la red. */
  const uno = async function (id) {
    const clave = String(id).trim();
    if (!clave) return;
    const slug = names[clave + ':slug'] || clave;
    try {
      const prices = await playerPrices(slug);
      const valor = prices ? priceOn(prices, stamp) : null;
      if (valor != null) salida[clave] = Math.round(valor);
    } catch (error) { /* ese jugador se queda sin dato */ }
  };
  const reparto = precioYaGuardado(ids, names);
  await Promise.all(reparto.listos.map(uno));
  await porTandas(reparto.porPedir, 10, 120, uno);

  /* Y se guarda lo aprendido, para no volver a preguntarlo jamas. */
  if (JORNADAS && Object.keys(salida).length) {
    try {
      await JORNADAS.put(claveDia, JSON.stringify(Object.assign(guardados, salida)));
    } catch (error) { /* da igual: se recalcula */ }
  }
  return salida;
}

/**
 * Serie de precios de cada jugador, recortada a los últimos días. El CDN la
 * da entera en una sola llamada por jugador y el Worker la cachea.
 */
async function priceSeries(ids, dias, names) {
  const salida = {};
  const uno = async function (id) {
    const clave = String(id).trim();
    if (!clave) return;
    const slug = names[clave + ':slug'] || clave;
    try {
      const prices = await playerPrices(slug);
      if (!prices || !prices.length) return;
      /* `Infinity` deja la serie entera; `slice(-Infinity)` no vale. */
      const trozo = dias === Infinity ? prices : prices.slice(-dias);
      salida[clave] = trozo.map(function (par) {
        return [par[0], Math.round(par[1])];
      });
    } catch (error) { /* ese jugador se queda sin serie */ }
  };
  const reparto = precioYaGuardado(ids, names);
  await Promise.all(reparto.listos.map(uno));
  await porTandas(reparto.porPedir, 10, 120, uno);
  return salida;
}

/** Fichajes y ventas de un mánager sacados del tablón, con id de jugador. */
function ownershipMoves(board, userId) {
  const moves = [];
  (board || []).forEach(function (post) {
    if (post.type !== 'market' && post.type !== 'transfer' && post.type !== 'adminTransfer') return;
    const day = isoDay((post.date || 0) * 1000);
    (post.content || []).forEach(function (item) {
      if (item.player == null) return;
      const to = item.to && String(item.to.id);
      const from = item.from && String(item.from.id);
      const amount = item.amount != null ? Math.round(item.amount) : null;
      const other = to === userId
        ? (item.from && item.from.name) || 'Mercado'
        : (item.to && item.to.name) || 'Mercado';
      if (to === userId) moves.push({ day: day, player: String(item.player), type: 'buy', amount: amount, other: other });
      if (from === userId) moves.push({ day: day, player: String(item.player), type: 'sell', amount: amount, other: other });
    });
  });
  return moves.sort(function (a, b) { return a.day < b.day ? -1 : a.day > b.day ? 1 : 0; });
}

/* La alineación propia: sistema y once titulares. La respuesta de Biwenger
   trae el equipo y el calendario de cada jugador, así que se queda solo lo
   necesario para pintar el campo. */
function normalizeLineup(user, names) {
  const lineup = user && user.lineup;
  if (!lineup) return null;
  return {
    type: lineup.type || null,
    /* Cuándo la guardaste en Biwenger: con esto se sabe si manda ella o la que
       tengas puesta en la calculadora. */
    date: lineup.date ? new Date(lineup.date * 1000).toISOString() : null,
    captain: lineup.captain != null ? String(lineup.captain) : null,
    /* Los suplentes van solo como ids: la web no los toca, pero hay que
       devolvérselos a Biwenger tal cual al guardar el once. */
    reserves: (lineup.reserves || []).map(function (suplente) {
      return suplente && suplente.id != null ? String(suplente.id) : null;
    }),
    coach: lineup.coach && lineup.coach.id != null ? String(lineup.coach.id) : null,
    /* Los huecos sin jugador vienen como null: hay que tirarlos antes de leer
       nada de ellos. */
    players: (lineup.players || []).filter(Boolean).map(function (player) {
      const id = String(player.id);
      return {
        id: id,
        name: player.name || names[id] || ('Jugador ' + id),
        position: player.position != null ? player.position : null,
        altPositions: otrosPuestos(names, id),
        marketValue: player.price != null ? Math.round(player.price) : null,
        status: player.status || null,
        points: player.points != null ? player.points : null,
        team: names[id + ':team'] != null ? names[id + ':team'] : null,
        teamName: names['team:' + names[id + ':team']] || null,
        status: player.status || names[id + ':status'] || null,
        increment: names[id + ':inc'] || 0
      };
    })
  };
}

/* ---------- Plantillas de todos los mánagers ---------- */

/**
 * Plantilla de cada mánager con, por jugador, desde cuándo lo tiene, lo que
 * pagó (o si venía en el reparto inicial) y su valor de mercado de hoy.
 */
async function allSquads(env, headers, leagueId, names) {
  const league = await api(env, '/league?include=all&fields=*,standings', headers);
  const board = await boardItems(env, headers, leagueId);
  const start = boardStartDay(board);
  const rows = normalizeStandings(league).filter(function (row) { return row.id; });

  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const squad = await api(env, '/user/' + row.id + '?fields=players', headers);
    const moves = ownershipMoves(board, row.id);

    const players = ((squad && squad.players) || []).filter(Boolean).map(function (entry) {
      const id = String(entry.id);
      // El último fichaje de ese jugador es el que cuenta como fecha de entrada.
      let bought = null;
      moves.forEach(function (move) {
        if (move.player === id && move.type === 'buy') bought = move;
      });
      const price = names[id + ':price'];
      return {
        id: id,
        name: names[id] || ('Jugador ' + id),
        position: names[id + ':pos'] != null ? names[id + ':pos'] : null,
        altPositions: otrosPuestos(names, id),
        marketValue: price != null ? Math.round(price) : null,
        since: bought ? bought.day : start,
        paid: bought ? bought.amount : null,     // null = venía en el reparto
        from: bought ? bought.other : null,
        team: names[id + ':team'] != null ? names[id + ':team'] : null,
        teamName: names['team:' + names[id + ':team']] || null,
        status: names[id + ':status'] || null,
        /* El parte de la lesión o la sanción, para la ficha. */
        statusInfo: names[id + ':statusInfo'] || null,
        increment: names[id + ':inc'] || 0,
        points: names[id + ':pts'] != null ? names[id + ':pts'] : null,
        played: names[id + ':jug'] != null ? names[id + ':jug'] : null
      };
    }).sort(function (a, b) { return (b.marketValue || 0) - (a.marketValue || 0); });

    out.push({ id: row.id, name: row.name, icon: row.icon, players: players });
  }
  return { squads: out };
}

/** Día del primer apunte del tablón: el arranque real de la liga. */
function boardStartDay(board) {
  let first = null;
  (board || []).forEach(function (post) {
    if (!post.date) return;
    const day = isoDay(post.date * 1000);
    if (!first || day < first) first = day;
  });
  return first;
}

async function teamValueHistory(env, headers, userId, names) {
  const squad = await api(env, '/user/' + userId + '?fields=players', headers);
  const board = await boardItems(env, headers, (await account(env)).leagueId);
  const moves = ownershipMoves(board, userId);
  const start = boardStartDay(board);

  const owned = {};
  ((squad && squad.players) || []).forEach(function (player) { owned[String(player.id)] = true; });

  /* Se recorre hacia atrás: deshacer una compra es quitar al jugador, y
     deshacer una venta es devolverlo a la plantilla. */
  const timeline = [];
  const current = Object.assign({}, owned);
  for (let i = moves.length - 1; i >= 0; i--) {
    timeline.push({ day: moves[i].day, squad: Object.assign({}, current) });
    if (moves[i].type === 'buy') delete current[moves[i].player];
    else current[moves[i].player] = true;
  }
  const initialSquad = current;

  const firstMove = moves.length ? moves[0].day : isoDay(Date.now());
  const first = start && start < firstMove ? start : firstMove;
  const days = [];
  for (let time = Date.parse(first); time <= Date.now(); time += 86400000) days.push(isoDay(time));
  if (days.length === 0) days.push(isoDay(Date.now()));

  // Plantilla de cada día: la inicial más los movimientos hasta esa fecha.
  const squads = {};
  days.forEach(function (day) {
    const set = Object.assign({}, initialSquad);
    moves.forEach(function (move) {
      if (move.day > day) return;
      if (move.type === 'buy') set[move.player] = true;
      else delete set[move.player];
    });
    squads[day] = set;
  });

  const ids = {};
  Object.keys(squads).forEach(function (day) {
    Object.keys(squads[day]).forEach(function (id) { ids[id] = true; });
  });

  const prices = {};
  const list = Object.keys(ids);
  for (let i = 0; i < list.length; i++) {
    const slug = names[list[i] + ':slug'];
    prices[list[i]] = slug ? await playerPrices(slug) : null;
  }

  return {
    userId: userId,
    days: days.map(function (day) {
      const stamp = ymd(day);
      let total = 0;
      let known = 0;
      Object.keys(squads[day]).forEach(function (id) {
        const value = prices[id] ? priceOn(prices[id], stamp) : null;
        if (value != null) { total += value; known += 1; }
      });
      return { day: day, teamValue: known ? total : null, players: known };
    })
  };
}

/* ---------- Respuesta ---------- */

/* El tablón cuelga de /league/{id}/board. Ni /board ni /league/board valen:
   el primero responde «Invalid method» y el segundo «Invalid ID». */
function boardPaths(leagueId) {
  return [
    '/league/' + leagueId + '/board?offset=0&limit=500',
    '/league/' + leagueId + '/board?offset=0&limit=100',
    '/league/' + leagueId + '/board?offset=0&limit=50'
  ];
}

/**
 * El tablón entero, paginando. Con una sola página de 500 se perderían los
 * fichajes más viejos según avanza la temporada, y con ellos los saldos.
 */
async function boardItems(env, headers, leagueId) {
  /* El tablón es idéntico para los ocho y lo piden la sincronización y cada
     histórico: sin caché son diez descargas seguidas de lo mismo. */
  if (cache.board && Date.now() - cache.boardAt < 3 * 60 * 1000) return cache.board;

  const LIMITE = 500;
  const TOPE = 8000;              // suficiente para una temporada entera
  const todo = [];
  let last = null;

  for (let offset = 0; offset < TOPE; offset += LIMITE) {
    let pagina = null;
    try {
      pagina = await api(env, '/league/' + leagueId + '/board?offset=' + offset + '&limit=' + LIMITE, headers);
    } catch (error) {
      last = error;
      break;
    }
    if (!Array.isArray(pagina) || pagina.length === 0) break;
    todo.push.apply(todo, pagina);
    if (pagina.length < LIMITE) break;   // última página
  }

  if (todo.length) {
    cache.board = todo;
    cache.boardAt = Date.now();
    return todo;
  }

  /* Si la paginación no ha dado nada, se prueban las rutas de siempre. */
  for (const path of boardPaths(leagueId)) {
    try {
      return await api(env, path, headers);
    } catch (error) {
      last = error;
    }
  }
  throw last || new Error('No se ha podido leer el tablón.');
}

/**
 * Quién luce la foto de destacado ahora mismo.
 *
 * Biwenger tiene esa segunda foto hecha para 91 futbolistas, pero no se la pone
 * a los 91: solo a los que destacaron en la última jornada, o sea a los del
 * ONCE IDEAL. Y además tienen que estar disponibles: al lesionado o sancionado
 * le devuelve la normal.
 *
 * Los dos filtros hacen falta, y cada uno se ganó con un caso: Raphinha (19
 * puntos), Fermín (19) y Espí (13) la llevan y están en el once; Sancet la
 * tiene hecha, está sano y hace 3 puntos —no está en el once y no la lleva—;
 * Le Normand y Ruibal la tienen hecha y su web les enseña la normal, uno
 * sancionado y el otro lesionado.
 *
 * Se probó a soltarla a los 91 sanos (72) y salía en gente como Sancet.
 */
/* A partir de cuántos puntos de temporada luce la foto. Sale de casos reales,
   no de la documentación de nadie:

     la llevan     Raphinha 19 · Fermín 19 · Pépé 16 · Espí 13 ·
                   Isaac Romero 13 · Bellingham 12
     no la llevan  Terrats 11 · Sancet 3   (los dos sanos)

   Con Bellingham a 12 dentro y Terrats a 11 fuera, el corte queda cerrado.
   No es el once ideal —Pépé no está en él y sí la lleva— ni la nota de la
   última jornada —Isaac Romero hizo −1 y la lleva—: son los puntos de la
   temporada.

   Aviso para el futuro: si el criterio de Biwenger fuera relativo (los mejores
   X) y no un número fijo, en enero habrá pasado de 12 media liga y se verá.
   Entonces habrá que volver aquí con casos nuevos. */
const PUNTOS_DE_DESTACADO = 12;

function heroesDisponibles(names) {
  return Object.keys(names)
    .filter(function (clave) { return clave.slice(-5) === ':hero' && names[clave]; })
    .map(function (clave) { return clave.slice(0, -5); })
    .filter(function (id) {
      /* Lesionado o sancionado, foto normal: comprobado con Le Normand y
         Ruibal, que tienen la suya hecha y su web no se la pone. */
      const estado = names[id + ':status'];
      if (estado && estado !== 'ok') return false;
      const puntos = names[id + ':pts'];
      return typeof puntos === 'number' && puntos >= PUNTOS_DE_DESTACADO;
    });
}

async function build(env, debug) {
  const who = await account(env);
  const headers = { 'x-league': who.leagueId, 'x-user': who.userId, 'x-version': '628' };

  /* Si el tablón falla se devuelven igualmente los valores de equipo: más vale
     media calculadora que un error. */
  const soft = function (promise) {
    return promise.then(
      function (data) { return { data: data, error: null }; },
      function (error) { return { data: null, error: String(error.message || error) }; }
    );
  };

  /* La liga va primero y sola: de ella sale el sistema de puntuación, y el
     índice de futbolistas hay que pedirlo ya con él o los puntos no serán los
     que enseña Biwenger. */
  const league = await api(env, '/league?include=all&fields=*,standings', headers);
  if (league && league.scoreID != null) {
    cache.score = league.scoreID;
    if (env.JORNADAS) {
      try { await env.JORNADAS.put('sistema-puntuacion', String(cache.score)); } catch (e) { /* da igual */ }
    }
  }

  const [boardResult, offersResult, lineupResult, marketResult, names, roundResult] = await Promise.all([
    soft(boardItems(env, headers, who.leagueId)),
    /* /offers devuelve una lista incompleta (se dejaba pujas fuera);
       /user?fields=offers sí trae todas las pendientes, enviadas y recibidas. */
    soft(api(env, '/user?fields=offers,market', headers)),
    soft(api(env, '/user?fields=lineup', headers)),
    soft(api(env, '/market', headers)),
    players(cache.score),
    soft(nextRound())
  ]);

  const status = (marketResult.data && marketResult.data.status) || {};

  /* Cada bloque se arma por separado: si Biwenger manda algo inesperado en uno,
     el resto de la calculadora sigue funcionando. */
  const avisos = [];
  const safe = function (nombre, fn, fallback) {
    try { return fn(); } catch (error) {
      avisos.push(nombre + ': ' + String((error && error.message) || error));
      return fallback;
    }
  };

  let destacados = [];
  try { destacados = heroesDisponibles(names); } catch (error) { /* sin fotos y ya */ }

  const payload = {
    updatedAt: new Date().toISOString(),
    league: {
      id: who.leagueId,
      name: league && league.name,
      startDay: boardStartDay(boardResult.data)
    },
    managers: safe('clasificación', function () { return normalizeStandings(league); }, []),
    movements: safe('tablón', function () { return normalizeBoard(boardResult.data || [], names); }, []),
    offers: safe('pujas', function () {
      return normalizeOffers(offersResult.data && offersResult.data.offers, names, who.userId);
    }, []),
    listings: safe('ventas', function () { return normalizeListings(offersResult.data, names); }, []),
    lineup: safe('alineación', function () { return normalizeLineup(lineupResult.data, names); }, null),
    round: roundResult.data || null,
    movers: safe('mercado', function () { return movers(names, 150); }, { up: [], down: [] }),
    /* Altas y bajas de LaLiga, del mismo tablón que los fichajes. */
    laligaMoves: safe('movimientos de LaLiga', function () {
      return movimientosDeLaLiga(boardResult.data, names);
    }, []),
    /* Los destacados de la última jornada. Van solo los ids: la ruta la compone
       la web. */
    heroes: destacados,
    me: {
      id: who.userId,
      balance: status.balance != null ? status.balance : null,
      maximumBid: status.maximumBid != null ? status.maximumBid : null
    }
  };

  if (boardResult.error) avisos.push('Tablón: ' + boardResult.error);
  if (avisos.length) payload.warning = avisos.join(' · ');

  // ?debug=1 devuelve además la respuesta cruda, para ajustar el mapeo.
  if (debug) payload.raw = { league: league, board: boardResult.data };

  return payload;
}


/* Deno Deploy atiende cada peticion por aqui. */
Deno.serve(function (request) {
  return app.fetch(request, ENTORNO);
});
