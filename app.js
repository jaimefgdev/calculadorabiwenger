/* ===========================================================
   Calculadora Biwenger
   · Tablón   → movimientos → saldo disponible
   · Liga     → valor de equipo → puja máxima
   Sin datos precargados: todos parten de 20.000.000 €.
   =========================================================== */

(function () {
  'use strict';

  /* ---------- Configuración de la liga ---------- */

  const MANAGERS = [
    'Eneko',
    'CoZoKe',
    'gijonudoF.C.',
    'Maccabi De Levantar',
    'Izaskun V',
    'Bella Rodriguez',
    'Atlético Jordaan FC',
    'José Mário dos Santos Mourinho🐐'
  ];

  const INITIAL_BUDGET = 20000000;
  const TEAM_VALUE_SHARE = 0.25;          // fracción del valor de equipo que suma a la puja
  const STORAGE_KEY = 'biwenger-calc-v2';
  const SYNC_KEY = 'biwenger-calc-sync';
  const HISTORY_KEY = 'biwenger-calc-history';
  /* Cada jornada, guardada para siempre: Biwenger deja de servir el banquillo
     en cuanto arranca la siguiente. */
  const ROUNDS_KEY = 'biwenger-calc-jornadas';
  /* El once del simulador se guarda aparte: es tuyo, no el que tenga puesto
     Biwenger, y no debe perderse al recargar. */
  const XI_KEY = 'biwenger-calc-xi';
  /* El filtro del mercado (todos / libres / de mánagers), que se recuerda de
     una visita a otra: casi siempre se mira lo mismo. */
  const MARKET_FILTER_KEY = 'biwenger-calc-filtro-mercado';

  /* ---------- Copia en disco de lo que trae el Worker ----------
     Cada pestaña pedía lo suyo al abrirla y, al recargar la página, todo otra
     vez desde cero: entre uno y dos segundos mirando un «cargando». Aquí se
     guarda la última respuesta buena de cada cosa y se enseña al momento
     mientras por detrás se pide la de ahora. */
  const CACHE_KEY = 'biwenger-calc-cache';

  /* Cuánto se da por bueno lo guardado sin ni siquiera repintarlo luego. Es
     solo para no enseñar algo de anteayer: aunque esté fresco, siempre se
     vuelve a pedir por detrás. */
  const CACHE_HORAS = 12;

  function cacheTodo() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') || {}; }
    catch (error) { return {}; }
  }

  function cacheLeer(nombre) {
    const caja = cacheTodo()[nombre];
    if (!caja || !caja.at) return null;
    if (Date.now() - caja.at > CACHE_HORAS * 3600e3) return null;
    return caja.data;
  }

  function cacheGuardar(nombre, data) {
    try {
      const todo = cacheTodo();
      todo[nombre] = { at: Date.now(), data: data };
      localStorage.setItem(CACHE_KEY, JSON.stringify(todo));
    } catch (error) {
      /* Sin sitio: se tira lo guardado y se sigue, que esto es un apaño de
         velocidad, no un dato que haya que conservar. */
      try { localStorage.removeItem(CACHE_KEY); } catch (e) { /* nada */ }
    }
  }
  /* El estado del futbolista cuando se hizo cada fichaje. Se guarda la primera
     vez que se ve el movimiento y ya no se toca: Biwenger solo da el de hoy. */
  const MOVE_STATUS_KEY = 'biwenger-calc-estado-fichajes-v2';
  /* En reposo, media hora: el mercado se renueva una vez al día y las pujas
     duran 24 h. Se aprieta al terminar cada partido, que es cuando llegan los
     puntos: con puntuación mixta hay que esperar a las notas del AS, así que
     durante el partido no hay nada que mirar. */
  const AUTO_SYNC_MS = 30 * 60 * 1000;
  /* Con partido en marcha ya no hace falta esperar tanto: lo que de verdad
     actualiza es el aviso de ESPN en cuanto pasa algo (pedirSyncPorCambio).
     Esto es solo la red de seguridad por si ESPN fallara. */
  const AUTO_SYNC_PUNTOS_MS = 5 * 60 * 1000;

  /* ---------- Utilidades ---------- */

  const numberFormat = new Intl.NumberFormat('es-ES');
  const money = (n) => numberFormat.format(Math.round(n)) + ' €';
  const collapse = (s) => (s || '').replace(/\s+/g, ' ').trim();

  const COMBINING_MARKS = new RegExp('[\\u0300-\\u036f]', 'g');

  /** Clave de comparación: sin acentos, emojis, puntos ni espacios. */
  function normalize(text) {
    return (text || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(COMBINING_MARKS, '')
      .replace(/[^a-z0-9]/g, '');
  }

  const MANAGER_KEYS = MANAGERS.map((name) => ({ name, key: normalize(name) }));

  /**
   * "2.087.300" → 2087300 · "1,5" → 1.5
   * Formato español: el punto separa miles y la coma decimales.
   */
  function parseAmount(raw) {
    const s = (raw || '').trim();
    if (/^\d{1,3}(\.\d{3})+$/.test(s)) return parseInt(s.replace(/\./g, ''), 10);
    if (/^\d{1,3}(,\d{3})+$/.test(s)) return parseInt(s.replace(/,/g, ''), 10);
    const n = parseFloat(s.replace(/\./g, '').replace(',', '.'));
    return isNaN(n) ? null : n;
  }

  /** Primer importe en euros del texto, con sufijo M/K opcional. */
  function extractAmount(text) {
    const match = /(\d[\d.,]*)\s*(M|K)?\s*€/i.exec(text || '');
    if (!match) return null;
    let value = parseAmount(match[1]);
    if (value == null) return null;
    const suffix = (match[2] || '').toUpperCase();
    if (suffix === 'M') value *= 1000000;
    if (suffix === 'K') value *= 1000;
    return Math.round(value);
  }

  const MONTHS = {
    ene: 0, feb: 1, mar: 2, abr: 3, may: 4, jun: 5,
    jul: 6, ago: 7, sep: 8, oct: 9, nov: 10, dic: 11
  };

  /** "12 ago 2026, 7:09:46" → timestamp (o null). */
  function parseSpanishDate(text) {
    const m = /(\d{1,2})\s+([a-záéíóú]{3,})\.?\s+(\d{4})(?:,\s*(\d{1,2}):(\d{2})(?::(\d{2}))?)?/i.exec(text || '');
    if (!m) return null;
    const month = MONTHS[normalize(m[2]).slice(0, 3)];
    if (month === undefined) return null;
    return new Date(+m[3], month, +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)).getTime();
  }

  /**
   * Localiza un jugador de la liga dentro de un texto. La búsqueda arranca en
   * la acción ("Fichado por" / "Vendido por") para no confundirse con
   * menciones anteriores del mismo bloque.
   */
  function findManager(text, actionKeyword) {
    const haystack = normalize(text);
    const from = actionKeyword ? haystack.indexOf(normalize(actionKeyword)) : -1;
    const start = from >= 0 ? from : 0;

    let best = null;
    for (const manager of MANAGER_KEYS) {
      let index = haystack.indexOf(manager.key, start);
      if (index === -1) index = haystack.indexOf(manager.key);
      if (index === -1) continue;
      if (!best || index < best.index || (index === best.index && manager.key.length > best.key.length)) {
        best = { name: manager.name, key: manager.key, index: index };
      }
    }
    return best ? best.name : null;
  }

  /* ---------- Parseo del tablón (movimientos) ---------- */

  function closestPost(el) {
    return el.closest('league-board-post, [class*="board-post"], article, section') || null;
  }

  function postContext(post) {
    if (!post) return { date: '', timestamp: null, source: '' };
    const dateEl = post.querySelector('.date, time-relative, time');
    const rawDate = dateEl ? (dateEl.getAttribute('title') || collapse(dateEl.textContent)) : '';
    const titleEl = post.querySelector('.header h3, h3, h4');
    return {
      date: collapse(rawDate),
      timestamp: parseSpanishDate(rawDate),
      source: titleEl ? collapse(titleEl.textContent) : ''
    };
  }

  function extractPlayerName(card) {
    const selectors = ['.sr-only', '[itemprop="name"]', '.main h3', '.main .name', 'h3', 'h4', '.name'];
    for (const selector of selectors) {
      const el = card.querySelector(selector);
      if (!el) continue;
      const value = collapse(el.textContent);
      if (value && !/fichado|vendido|cambia por/i.test(value)) return value;
    }
    const href = card.querySelector('a[href*="/players/"]');
    if (href) {
      const slug = href.getAttribute('href').split('/').pop();
      if (slug) return slug.replace(/-/g, ' ');
    }
    return null;
  }

  /** Movimiento de un `<player-card>`, o null si no es compra/venta. */
  function parseCard(card, warnings) {
    const cardText = collapse(card.textContent);
    const titles = Array.from(card.querySelectorAll('[title]'))
      .map((el) => el.getAttribute('title'))
      .filter(Boolean)
      .join(' | ');
    const haystack = collapse(cardText + ' | ' + titles);

    const isBuy = /fichado por/i.test(haystack);
    const isSell = /vendido por/i.test(haystack);
    if (!isBuy && !isSell) return null;

    const type = isBuy ? 'buy' : 'sell';
    const keyword = isBuy ? 'Fichado por' : 'Vendido por';

    const player = extractPlayerName(card) || 'Jugador desconocido';
    const amount = extractAmount(haystack);

    const post = closestPost(card);
    const context = postContext(post);

    // El jugador viene en la tarjeta (fichajes) o en el title / autor del post
    // (ventas al mercado, donde la tarjeta solo lleva el importe).
    let manager = findManager(haystack, keyword);
    if (!manager && post) {
      const author = post.querySelector('.author, user-link.author');
      if (author) manager = findManager(collapse(author.textContent), null);
    }
    if (!manager && post) manager = findManager(collapse(post.textContent), keyword);

    if (amount == null) {
      warnings.push('Sin importe reconocible en el movimiento de «' + player + '».');
      return null;
    }
    if (!manager) {
      warnings.push('No se ha identificado al jugador en el movimiento de «' + player + '» (' + money(amount) + ').');
    }

    return {
      player: player,
      type: type,
      manager: manager,
      amount: amount,
      date: context.date,
      timestamp: context.timestamp,
      source: context.source
    };
  }

  /* Tipos de post que mueven saldo y que todavía no se contabilizan. La clase
     la pone Biwenger en el `.content` del post (content loan, content exchange…). */
  const UNHANDLED_TYPES = {
    loan: 'cesiones',
    loanReturn: 'devoluciones de cesión',
    exchange: 'intercambios',
    clauseIncrement: 'subidas de cláusula',
    adminTransfer: 'movimientos del administrador',
    bonus: 'bonus de jornada'
  };

  /** Avisa de lo que lleva dinero y el parser no sabe interpretar aún. */
  function detectUnhandled(doc, warnings) {
    const kinds = new Set();
    Array.from(doc.querySelectorAll('[class*="content"]')).forEach(function (el) {
      Object.keys(UNHANDLED_TYPES).forEach(function (key) {
        if (el.classList.contains(key)) kinds.add(key);
      });
    });
    kinds.forEach(function (key) {
      warnings.push('El tablón incluye ' + UNHANDLED_TYPES[key] + ', que aún no se suman ni restan al saldo.');
    });

    let unclassified = 0;
    Array.from(doc.querySelectorAll('player-card')).forEach(function (card) {
      const titles = Array.from(card.querySelectorAll('[title]'))
        .map(function (el) { return el.getAttribute('title'); })
        .filter(Boolean)
        .join(' | ');
      const haystack = collapse(collapse(card.textContent) + ' | ' + titles);
      if (/fichado por|vendido por/i.test(haystack)) return;
      if (extractAmount(haystack) == null) return;

      unclassified += 1;
      if (unclassified <= 5) {
        const player = extractPlayerName(card) || 'jugador desconocido';
        warnings.push('Movimiento con importe sin clasificar en «' + player + '»: ' +
          haystack.slice(0, 90) + (haystack.length > 90 ? '…' : ''));
      }
    });
    if (unclassified > 5) {
      warnings.push('…y ' + (unclassified - 5) + ' movimientos más con importe sin clasificar.');
    }
  }

  function parseBoardHTML(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const warnings = [];
    const movements = [];

    Array.from(doc.querySelectorAll('player-card')).forEach(function (card) {
      const movement = parseCard(card, warnings);
      if (movement) movements.push(movement);
    });

    if (movements.length === 0) {
      const candidates = Array.from(doc.querySelectorAll('li, div, p')).filter(function (el) {
        if (!/fichado por|vendido por/i.test(el.textContent || '')) return false;
        return !Array.from(el.children).some(function (child) {
          return /fichado por|vendido por/i.test(child.textContent || '');
        });
      });
      candidates.forEach(function (el) {
        const movement = parseCard(el, warnings);
        if (movement) movements.push(movement);
      });
      if (movements.length > 0) {
        warnings.push('No se han encontrado etiquetas <player-card>; se han leído los movimientos del texto plano.');
      }
    }

    detectUnhandled(doc, warnings);

    return { movements: movements, warnings: warnings };
  }

  /* ---------- Parseo de la clasificación (valor de equipo) ---------- */

  /** Valor del `<td>` ignorando el incremento diario que Biwenger anida dentro. */
  function cellAmountWithoutIncrement(td) {
    const clone = td.cloneNode(true);
    Array.from(clone.querySelectorAll('increment, .increment, .decrement')).forEach(function (el) {
      el.parentNode.removeChild(el);
    });
    return extractAmount(collapse(clone.textContent));
  }

  function parseStandingsHTML(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const teams = {};
    const warnings = [];

    Array.from(doc.querySelectorAll('tr')).forEach(function (row) {
      // La fila trae varios enlaces al usuario (avatar sin texto y nombre); el
      // slug del href sirve de respaldo cuando el enlace no lleva texto.
      const links = Array.from(row.querySelectorAll('a[href*="/user/"]'));
      if (links.length === 0) return;

      const identity = links
        .map(function (link) { return collapse(link.textContent) + ' ' + link.getAttribute('href'); })
        .join(' ');

      const manager = findManager(identity, null);
      if (!manager) {
        const name = collapse(links.map(function (link) { return link.textContent; }).join(' '));
        if (name) warnings.push('Participante no reconocido en la clasificación: «' + name + '».');
        return;
      }

      const cells = Array.from(row.querySelectorAll('td'));
      let value = null;
      let players = null;
      let points = null;

      cells.forEach(function (td) {
        const label = td.getAttribute('aria-label') || '';
        if (value === null && /valor de equipo/i.test(label)) value = extractAmount(label);
        if (players === null && /jugador/i.test(label)) players = parseInt(label, 10);
        if (points === null && /punto/i.test(label)) points = parseInt(label, 10);
      });

      if (value === null) {
        for (const td of cells) {
          const amount = cellAmountWithoutIncrement(td);
          if (amount != null) { value = amount; break; }
        }
      }

      if (value === null) {
        warnings.push('Sin valor de equipo para «' + manager + '».');
        return;
      }

      teams[manager] = {
        value: value,
        players: isNaN(players) ? null : players,
        points: isNaN(points) ? null : points
      };
    });

    return { teams: teams, warnings: warnings };
  }

  /* ---------- Cálculo ---------- */

  /**
   * Lo que lleva un mánager sumando jornada a jornada lo calculado aquí.
   * Biwenger no publica el total de la temporada mientras la jornada 1 tenga
   * partidos aplazados sin jugar: deja su campo de puntos a cero, así que la
   * general se suma a mano.
   *
   * Con `hasta` se corta en esa jornada inclusive, que es lo que hace falta en
   * la pestaña de Jornadas: mirando la 1 la general es la de la 1, mirando la
   * 2 la de la 1 más la 2, y así. Sin `hasta`, la temporada entera.
   *
   * Solo cuentan las jornadas propias (part 1, nunca la mitad aplazada de otra,
   * que repite sus mismos partidos) y las que ya han empezado: una por jugar no
   * suma nada aunque haya quedado algo guardado de ella.
   */
  function puntosSumados(equipo, hasta) {
    if (!equipo || !equipo.id) return null;

    let total = 0;
    let alguna = false;
    Object.keys(state.jornadas.datos).forEach(function (id) {
      const jornada = state.jornadas.datos[id];
      const round = jornada && jornada.round;
      if (!esJornadaPropia(round)) return;
      if (round.status === 'pending') return;
      if (hasta != null && (round.number || 0) > hasta) return;
      /* Por identificador y no por nombre: en la jornada Biwenger devuelve el
         nombre con emojis y aquí llega sin ellos. */
      const fila = (jornada.standings || []).filter(function (f) {
        return String(f.id) === String(equipo.id);
      })[0];
      if (!fila) return;
      /* El mánager que empezó la jornada con saldo negativo no puntúa esa
         jornada: ni suma ni resta. La jornada cuenta igual (por eso `alguna`),
         pero él aporta cero. */
      if (fila.counts !== false) total += fila.points || 0;
      alguna = true;
    });

    return alguna ? total : null;
  }

  function conJornadaEnJuego(equipo, base) {
    const total = puntosSumados(equipo, null);
    return total != null ? total : base;
  }

  function computeBudgets(movements, teams) {
    const rows = MANAGERS.map(function (name) {
      return {
        name: name,
        initial: INITIAL_BUDGET,
        spent: 0,
        earned: 0,
        buys: 0,
        sells: 0,
        teamValue: teams[name] ? teams[name].value : null,
        players: teams[name] ? teams[name].players : null,
        points: conJornadaEnJuego(teams[name], teams[name] && teams[name].points != null ? teams[name].points : null),
        // Saldo tal cual lo da Biwenger; incluye cesiones, bonus y cláusulas.
        officialBalance: teams[name] && teams[name].balance != null ? teams[name].balance : null,
        lastAccess: teams[name] ? teams[name].lastAccess : null
      };
    });
    const byName = new Map(rows.map(function (row) { return [row.name, row]; }));

    movements.forEach(function (movement) {
      const row = byName.get(movement.manager);
      if (!row) return;
      if (movement.type === 'buy') {
        row.spent += movement.amount;
        row.buys += 1;
      } else if (movement.type === 'bonus') {
        /* El abono de la jornada entra como ingreso, pero no es una venta: si
           se contara como tal, el número de ventas y la media por venta
           saldrían inflados. Puede ser negativo, si la liga resta por
           puntuación negativa, y entonces baja el ingreso, que es lo suyo. */
        row.earned += movement.amount;
      } else {
        row.earned += movement.amount;
        row.sells += 1;
      }
    });

    rows.forEach(function (row) {
      /* El saldo se calcula siempre igual para todos: Biwenger solo publica el
         del usuario conectado, así que usarlo solo en su fila daría una tabla
         mitad exacta y mitad estimada. El oficial se guarda aparte y sirve de
         contraste (ver la marca ≠ en la tabla). */
      row.balance = row.initial - row.spent + row.earned;
      row.maxBid = row.teamValue == null ? null : row.balance + row.teamValue * TEAM_VALUE_SHARE;
    });

    return rows;
  }

  /* ---------- Ordenación de tablas ---------- */

  /* Valor por el que ordena cada columna. Devolver null manda la fila al final. */
  /**
   * Desempates de Biwenger (ligas normales y clásicas), tal cual los publica:
   *
   * Clasificación general
   *   1. Más puntos.
   *   2. Mayor valor de equipo + saldo.
   *   3. El más veterano en la liga.
   *
   * Clasificación de la jornada
   *   1. Más puntos.
   *   2. Mayor valor de la alineación.
   *   3. Más puntos en la general.
   *   4. Mayor valor de equipo.
   *   5. Mejor puesto en la general.
   *   6. Más saldo.
   *   7. El más veterano.
   *
   * La antigüedad no la publica su API, así que ese último escalón se resuelve
   * con el orden que da Biwenger en su propia clasificación, que ya la aplica.
   */
  function desempateGeneral(a, b) {
    const equipoA = state.teams[a.name] || {};
    const equipoB = state.teams[b.name] || {};
    const patrimonio = function (equipo) {
      return (equipo.value != null ? equipo.value : (equipo.teamValue || 0)) + (equipo.balance || 0);
    };
    const porPatrimonio = patrimonio(equipoB) - patrimonio(equipoA);
    if (porPatrimonio) return porPatrimonio;
    /* Sin fecha de alta, manda el orden que da Biwenger. */
    return (a.position != null ? a.position : 99) - (b.position != null ? b.position : 99);
  }

  function desempateJornada(a, b) {
    /* 2. Valor de la alineación de esa jornada. */
    const porOnce = (b.xiValue || 0) - (a.xiValue || 0);
    if (porOnce) return porOnce;

    const equipoA = state.teams[a.name] || {};
    const equipoB = state.teams[b.name] || {};

    /* 3. Puntos en la general. */
    const generalA = puntosGenerales(a.name);
    const generalB = puntosGenerales(b.name);
    const porGeneral = (generalB || 0) - (generalA || 0);
    if (porGeneral) return porGeneral;

    /* 4. Valor de equipo. */
    const valorA = equipoA.value != null ? equipoA.value : (equipoA.teamValue || 0);
    const valorB = equipoB.value != null ? equipoB.value : (equipoB.teamValue || 0);
    if (valorB - valorA) return valorB - valorA;

    /* 5. Puesto en la general. */
    const puestoA = a.position != null ? a.position : 99;
    const puestoB = b.position != null ? b.position : 99;
    if (puestoA !== puestoB) return puestoA - puestoB;

    /* 6. Saldo. */
    const saldo = (equipoB.balance || 0) - (equipoA.balance || 0);
    if (saldo) return saldo;

    /* 7. Antigüedad: no la publica, así que se deja el orden de Biwenger. */
    return 0;
  }

  const SORT_VALUES = {
    budget: {
      name:      function (row) { return row.name; },
      buys:      function (row) { return row.buys; },
      sells:     function (row) { return row.sells; },
      spent:     function (row) { return row.spent; },
      earned:    function (row) { return row.earned; },
      balance:   function (row) { return row.balance; },
      teamValue: function (row) { return row.teamValue; },
      players:   function (row) { return row.players; },
      maxBid:    function (row) { return row.maxBid; }
    },
    managers: {
      name:      function (row) { return row.name; },
      points:    function (row) { return row.points; },
      teamValue: function (row) { return row.teamValue; },
      players:   function (row) { return row.players; },
      balance:   function (row) { return row.balance; },
      maxBid:    function (row) { return row.maxBid; },
      /* Al ordenar por conexión, primero el que acaba de entrar. */
      lastAccess: function (row) { return row.lastAccess ? Date.parse(row.lastAccess) : -Infinity; }
    },
    moves: {
      player:  function (m) { return m.player; },
      type:    function (m) {
        return m.type === 'bonus' ? 'Abono' : (m.type === 'buy' ? 'Fichado' : 'Vendido');
      },
      manager: function (m) { return m.manager; },
      amount:  function (m) { return m.amount; },
      date:    function (m) { return m.timestamp; }
    }
  };

  /* Desempate cuando la columna no tiene valor (p. ej. sin valor de equipo):
     entre jugadores empatados manda el saldo más alto. */
  const SORT_FALLBACK = {
    budget: function (row) { return row.balance; }
  };

  /* Los textos arrancan de la A a la Z; los importes, de mayor a menor. */
  const TEXT_COLUMNS = { name: true, player: true, type: true, manager: true };
  const defaultDir = (key) => (TEXT_COLUMNS[key] ? 1 : -1);

  const SORT_TABLES = { budget: '.table--budget', moves: '.table--moves', managers: '.table--managers' };

  /** Copia ordenada de `rows`. Empates y nulos conservan el orden de origen. */
  function sortRows(rows, table, sort) {
    const pick = SORT_VALUES[table][sort.key];
    if (!pick) return rows;
    return rows
      .map(function (row, index) { return { row: row, index: index }; })
      .sort(function (a, b) {
        const x = pick(a.row);
        const y = pick(b.row);
        if (x == null && y == null) {
          const fallback = SORT_FALLBACK[table];
          const diff = fallback ? fallback(b.row) - fallback(a.row) : 0;
          return diff || a.index - b.index;
        }
        if (x == null) return 1;
        if (y == null) return -1;
        const cmp = typeof x === 'string' || typeof y === 'string'
          ? String(x).localeCompare(String(y), 'es')
          : x - y;
        if (cmp !== 0) return cmp * sort.dir;
        /* Empatados a puntos en la clasificación: valor de equipo + saldo, y
           luego la antigüedad, que no se publica. */
        if (table === 'managers' && sort.key === 'points') {
          const patrimonio = function (row) { return (row.teamValue || 0) + (row.balance || 0); };
          const diff = patrimonio(b.row) - patrimonio(a.row);
          if (diff) return diff;
        }
        return a.index - b.index;
      })
      .map(function (entry) { return entry.row; });
  }

  function updateSortHeaders(table, sort) {
    const headers = document.querySelectorAll(SORT_TABLES[table] + ' thead th[data-sort]');
    Array.prototype.forEach.call(headers, function (th) {
      const active = th.getAttribute('data-sort') === sort.key;
      th.setAttribute('aria-sort', active ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none');
    });
  }

  /* ---------- Estado ---------- */

  const $ = (id) => document.getElementById(id);

  const state = {
    movements: [],
    /* Altas y bajas de LaLiga, y cuál de las dos vistas se está mirando. */
    laligaMoves: [],
    ambitoFichajes: 'liga',
    /* Partidos de cada futbolista, para la píldora de su ficha. */
    partidosJugador: {},
    faltas: {},             // goles de falta por dia (AAAAMMDD), según ESPN
    envivo: [],             // partidos rodando ahora mismo, con marcador de ESPN
    envivoPidiendo: false,
    envivoFirma: undefined,  // cómo iban los partidos en la última mirada
    syncPorCambioAt: 0,      // cuándo se sincronizó por un cambio en el campo
    recuentoLiga: null,     // el mismo recuento, pero solo de lo hecho alineado
    rankingsAmbito: 'laliga',
    puntosAmbito: 'laliga',  // el mismo cambio, en la tabla de Puntos
    pujasDe: {},             // cuántas pujas lleva cada futbolista, ya preguntadas
    rankingsAbiertos: {},   // que rankings se han desplegado, uno por campo
    puntosAbiertos: {},     // lo mismo, en las listas de Puntos
    teams: {},
    warnings: [],
    filters: { text: '', manager: '', type: '' },
    expanded: {},          // jugadores con la ficha de jugadores desplegada
    charts: { saldo: true, value: true },
    kpiCharts: { moves: false, spent: false, earned: false, balance: false },
    kpiOpen: [],           // orden de apertura, para cerrar el más antiguo
    kpi: null,             // últimos valores de cabecera
    tab: 'inicio',
    expandedManager: null,
    expandedPoints: null,   // desglose de puntos por futbolista, en la clasificación
    puntosDetalle: null,    // gráfico de puntos por jornada de un futbolista
    recuento: null,         // goles, asistencias y tarjetas de toda la competición
    recuentoCargando: false,
    jugadores: null,        // lista completa de la competición, para el buscador
    jugadoresCargando: false,
    estadisticas: {},       // resumen de temporada de cada futbolista
    partidos: {},           // partidos de cada jornada, con sus alineaciones
    partidosEstado: '',
    partidoAbierto: null,   // el partido cuyo detalle se está viendo
    vistaPartido: 'tabla',  // cómo se enseña la alineación: tabla o campo
    laliga: null,           // todos los futbolistas de la competición
    ambito: { nuestra: 'total', laliga: 'total' },   // total · en casa · fuera
    puesto: { nuestra: '0', laliga: '0' },           // demarcación: 0 son todas
    laligaCargando: false,
    listings: [],
    lineup: null,          // mi alineación en Biwenger
    round: null,           // próxima jornada y su hora de inicio
    roundOpen: false,      // lista de partidos desplegada
    picker: null,          // hueco del campo que se está cambiando
    moveStatus: {},        // estado congelado de cada fichaje
    movers: null,          // los que más suben y bajan hoy
    heroes: {},            // los que tienen la foto de destacado de Biwenger
    moversAbiertos: {},    // listas desplegadas a la lista larga
    market: null,          // el mercado de hoy, con sus pujas
    marketFiltro: 'todos',  // todos · libres · vendidos (de mánagers)
    marketState: '',       // 'cargando' | 'error' | ''
    marketError: '',       // el motivo, tal como lo dice Biwenger
    marketReintento: null, // el temporizador del reintento tras su tregua
    marketIntentos: 0,     // cuántos reintentos seguidos llevamos (tope: 3)
    marketViejo: false,    // si lo que se ve es el respaldo, no lo de ahora
    startPrices: {},       // lo que valía cada jugador el día que lo recibió
    priceSeries: {},       // evolución de precio de cada futbolista
    priceModal: null,      // futbolista con la evolución ampliada
    jornadas: { list: [], actual: null, datos: {} },   // clasificación y alineaciones por jornada
    jornadaVista: null,    // la que se está mirando
    jornadaAbierta: null,  // mánager desplegado dentro de esa jornada
    jornadaEstado: '',     // 'cargando' | 'error' | ''
    jornadaChart: [],      // mánagers dibujados en el gráfico de puntos
    pickerJornada: false,  // menú de jornadas abierto
    xi: null,              // el once del simulador
    squads: null,          // plantillas de todos los jugadores
    expandedSquad: null,
    expandedSpend: null,
    sim: {},               // operaciones marcadas para simular
    history: {},           // valor de equipo día a día, por jugador
    leagueStart: null,     // primer día del tablón
    offers: [],            // pujas enviadas y ofertas recibidas, pendientes
    me: null,              // saldo y puja máxima oficiales del usuario
    syncing: false,
    syncFails: 0,          // fallos seguidos, para espaciar los reintentos
    nextSyncAt: 0,         // no se vuelve a intentar antes de este momento
    lastSync: null,
    // key vacía = orden por defecto de cada tabla (ver más abajo).
    sort: {
      budget: { key: '', dir: -1 },
      moves:  { key: '', dir: -1 },
      managers: { key: '', dir: -1 },
      squad: { key: '', dir: 1 },
      spend: { key: 'total', dir: -1 },
      income: { key: 'total', dir: -1 },
      detail: { key: 'amount', dir: -1 },  // dentro de la ficha de cada jugador
      rounds: { key: 'points', dir: -1 },
      market: { key: '', dir: -1 }        // vacío = libres primero y por valor
    }
  };

  /* Sin ordenación elegida, la tabla de presupuestos manda arriba la puja más
     alta; mientras no haya valores de equipo, el saldo disponible. */
  function effectiveBudgetSort() {
    const sort = state.sort.budget;
    if (sort.key) return sort;
    return { key: Object.keys(state.teams).length > 0 ? 'maxBid' : 'balance', dir: -1 };
  }

  function budgetRows() {
    return sortRows(computeBudgets(state.movements, state.teams), 'budget', effectiveBudgetSort());
  }

  /* ---------- Render ---------- */

  const AVATAR_COLORS = ['#ff0033', '#ff7a00', '#c99700', '#00b37a', '#0091b3', '#7c5cff', '#ff3d9a', '#6b7785'];

  /* Biwenger devuelve 404 en el avatar de esta cuenta —está roto en su CDN—,
     así que se sustituye por otra imagen para no dejar el hueco. */
  /* Foto incrustada (256 px, JPEG) para no depender de ningún servidor. */
  const MOU_PHOTO = 'data:image/jpeg;base64,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';

  const AVATAR_OVERRIDES = [
    { name: 'José Mário dos Santos Mourinho', url: MOU_PHOTO }
  ].reduce(function (map, item) {
    map[normalize(item.name)] = item.url;
    return map;
  }, {});

  /* Colores propios de algunos jugadores; el resto tira de la paleta automática. */
  const AVATAR_STYLES = [
    { name: 'José Mário dos Santos Mourinho', bg: '#ffffff', fg: '#7c3aed' },
    { name: 'Atlético Jordaan FC',            bg: '#d80030', fg: '#ffffff' },
    { name: 'Izaskun V',                      bg: '#8e0020', fg: '#ffffff' },
    { name: 'Eneko',                          bg: '#1e6bff', fg: '#ffffff' }
  ].reduce(function (map, item) {
    map[normalize(item.name)] = item;
    return map;
  }, {});

  function avatar(name) {
    const initials = name
      .replace(/[^\p{L}\p{N}\s]/gu, '')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map(function (word) { return word[0].toUpperCase(); })
      .join('');
    /* La foto se pinta encima de las iniciales: si la URL falla —la del CDN de
       Biwenger devuelve 404 en algunas cuentas— sigue viéndose el círculo de
       color, sin huecos ni imágenes rotas. */
    /* Siempre se pide primero la foto de Biwenger. Si su CDN la da por perdida
       —hay cuentas con el avatar roto— se cae al sustituto, y si tampoco hay,
       quedan las iniciales. El relevo lo hace el listener de 'error'. */
    const team = state.teams[name];
    const icon = team && team.icon;
    const fallback = AVATAR_OVERRIDES[normalize(name)] || '';
    const source = icon || fallback;
    const photo = source
      ? '<img class="avatar__pic" src="' + escapeHtml(source) + '"' +
        (fallback && fallback !== source ? ' data-fallback="' + escapeHtml(fallback) + '"' : '') +
        ' alt="">'
      : '';

    const custom = AVATAR_STYLES[normalize(name)];
    if (custom) {
      // El aro sutil evita que los fondos claros desaparezcan en modo claro.
      return '<span class="avatar avatar--ring" style="background:' + custom.bg + ';color:' + custom.fg +
        '" aria-hidden="true">' + initials + photo + '</span>';
    }

    const index = MANAGERS.indexOf(name);
    const color = AVATAR_COLORS[(index === -1 ? name.length : index) % AVATAR_COLORS.length];
    return '<span class="avatar" style="background:' + color + '" aria-hidden="true">' + initials + photo + '</span>';
  }

  /* Demarcación de cada futbolista, para poder pintarla en cualquier tabla
     aunque quien la dibuja no la sepa. Se llena con la lista de la competición
     y con las plantillas. */
  const posicionConocida = {};
  /* Y las de repuesto, para poder pintar las dos chapas en cualquier tabla. */
  const altConocida = {};

  function recordarPosiciones(lista) {
    (lista || []).forEach(function (jugador) {
      if (!jugador || jugador.id == null) return;
      if (jugador.position != null) posicionConocida[String(jugador.id)] = jugador.position;
      if (jugador.altPositions && jugador.altPositions.length) {
        altConocida[String(jugador.id)] = jugador.altPositions;
      }
    });
  }

  /** Las demarcaciones de repuesto de alguien, vengan en el objeto o guardadas. */
  function otrosPuestosDe(jugador, id) {
    if (jugador && jugador.altPositions && jugador.altPositions.length) return jugador.altPositions;
    const clave = String(id != null ? id : (jugador && jugador.id));
    return altConocida[clave] || [];
  }

  /** Nombre del futbolista con su foto del CDN de Biwenger. */
  function playerName(movement, sinChapa) {
    const id = movement.playerId;
    const pic = id
      ? '<span class="pic-player" style="background-image:url(\'' + fotoDe(id) +
        '\')" aria-hidden="true"></span>'
      : '';
    /* La demarcación va delante, con su color, igual que en las fichas. */
    const puesto = movement.position != null ? movement.position
      : (posicionConocida[String(id)] != null ? posicionConocida[String(id)] : null);

    return '<span class="player" data-player-id="' + escapeHtml(String(id || '')) + '">' +
      (sinChapa ? '' : chapaDePuesto(puesto, 'puesto--fila',
        otrosPuestosDe(movement, movement.playerId))) + pic + '<span class="player-name">' +
      escapeHtml(movement.player) + '</span></span>';
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function signedCell(value) {
    if (value === 0) return '<span class="zero">' + money(0) + '</span>';
    return '<span class="' + (value < 0 ? 'money-neg' : 'money-pos') + '">' + money(value) + '</span>';
  }

  /** Los cuatro números de cabecera, compartidos por Inicio y Datos. */
  function kpiValues(rows) {
    const spent = rows.reduce(function (sum, row) { return sum + row.spent; }, 0);
    const earned = rows.reduce(function (sum, row) { return sum + row.earned; }, 0);
    const balance = rows.reduce(function (sum, row) { return sum + row.balance; }, 0);
    const buys = state.movements.filter(function (m) { return m.type === 'buy'; }).length;
    /* Los abonos de jornada no son ventas: entran en el dinero ingresado, pero
       contarlos aquí inflaría el recuento y la media por venta. */
    const sells = state.movements.filter(function (m) {
      return m.type !== 'buy' && m.type !== 'bonus';
    }).length;
    const negatives = rows.filter(function (row) { return row.balance < 0; }).length;

    return {
      moves: {
        label: 'Movimientos', value: String(state.movements.length), modifier: '',
        foot: state.movements.length === 0 ? 'Sin datos del tablón' : buys + ' fichajes · ' + sells + ' ventas'
      },
      spent: {
        label: 'Gastado en fichajes', value: money(spent), modifier: 'kpi--out',
        foot: buys > 0 ? 'Media por fichaje: ' + money(spent / buys) : 'Sin fichajes'
      },
      earned: {
        label: 'Ingresado por ventas', value: money(earned), modifier: 'kpi--in',
        foot: sells > 0 ? 'Media por venta: ' + money(earned / sells) : 'Sin ventas'
      },
      balance: {
        label: 'Saldo total en liga', value: money(balance), modifier: '',
        foot: negatives > 0
          ? negatives + (negatives === 1 ? ' jugador en números rojos' : ' jugadores en números rojos')
          : 'Ningún jugador en números rojos'
      }
    };
  }

  /** La pestaña Datos: una fila por métrica, y al pulsar se abre su gráfico. */
  function renderDataKpis() {
    const kpi = state.kpi || kpiValues(budgetRows());

    $('data-kpis').innerHTML = KPI_SERIES.map(function (serie) {
      const info = kpi[serie.key];
      const on = state.kpiCharts[serie.key];
      return '<tr class="' + (on ? 'row-open' : '') + '">' +
        '<td data-label="Métrica">' +
          '<button type="button" class="row-toggle" data-kpi="' + serie.key + '"' +
            ' aria-expanded="' + (on ? 'true' : 'false') + '" title="Ver evolución por días">' +
            '<span class="row-toggle__icon" aria-hidden="true">▸</span>' +
            '<span class="chip__dot" style="background:' + serie.color + '"></span>' +
            '<span class="manager__name">' + info.label + '</span>' +
          '</button></td>' +
        '<td class="num" data-label="Total"><strong>' + info.value + '</strong></td>' +
        '<td data-label="Detalle"><span class="sub">' + info.foot + '</span></td>' +
      '</tr>';
    }).join('');
  }

  const BUDGET_COLUMNS = 10;

  /* ---------- Histórico y gráficos ---------- */

  /* Biwenger no publica la evolución del valor de equipo: solo el dato de hoy.
     Así que el saldo se reconstruye día a día desde los movimientos (eso sí es
     exacto desde el primer día) y del valor de equipo se guarda una foto diaria
     a partir de la primera sincronización. */

  const dayKey = (time) => new Date(time).toISOString().slice(0, 10);

  function loadHistory() {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      const data = raw ? JSON.parse(raw) : null;
      return data && typeof data === 'object' ? data : {};
    } catch (error) {
      return {};
    }
  }

  /** Guarda el valor de equipo de hoy de cada jugador (una foto por día). */
  function recordSnapshot() {
    const history = loadHistory();
    const today = dayKey(Date.now());
    const snapshot = {};
    Object.keys(state.teams).forEach(function (name) {
      const team = state.teams[name];
      if (team && team.value != null) snapshot[name] = team.value;
    });
    if (Object.keys(snapshot).length === 0) return;
    history[today] = snapshot;
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch (error) { /* sin espacio */ }
  }

  const CHART_SERIES = [
    { key: 'saldo',  label: 'Saldo',        color: 'var(--viz-1)' },
    { key: 'value',  label: 'Valor equipo', color: 'var(--viz-2)' }
  ];

  /**
   * Pide al Worker el valor de equipo día a día de un jugador. Se reconstruye
   * allí a partir de su plantilla y del histórico de precios, así que tarda un
   * poco: se hace solo al desplegar su ficha y se guarda en memoria.
   */
  function ensureHistory(name) {
    const team = state.teams[name];
    if (!team || !team.id) return;
    if (state.history[name]) return;

    const config = loadSyncConfig();
    if (!config.url || !config.key) return;

    state.history[name] = { status: 'loading', days: {} };

    const endpoint = config.url.replace(/\/+$/, '') + '/?key=' + encodeURIComponent(config.key) +
      '&history=' + encodeURIComponent(team.id);

    fetch(endpoint, { headers: { 'accept': 'application/json' } })
      .then(function (response) { return response.json(); })
      .then(function (payload) {
        if (payload.error) throw new Error(payload.error);
        const days = {};
        (payload.days || []).forEach(function (entry) {
          if (entry.teamValue != null) days[entry.day] = entry.teamValue;
        });
        state.history[name] = { status: 'ok', days: days };
        renderBudgets(budgetRows());
      })
      .catch(function () {
        state.history[name] = { status: 'error', days: {} };
        renderBudgets(budgetRows());
      });
  }

  /** Serie diaria de saldo, valor de equipo y puja máxima de un jugador. */
  function managerSeries(name) {
    const history = loadHistory();
    const remote = (state.history[name] && state.history[name].days) || {};
    const moves = state.movements
      .filter(function (movement) { return movement.manager === name && movement.timestamp; })
      .sort(function (a, b) { return a.timestamp - b.timestamp; });

    const stamps = Object.keys(history).concat(Object.keys(remote)).concat([startDay()]);
    const days = daysRange(stamps.sort()[0]);

    const team = state.teams[name];
    let balance = INITIAL_BUDGET;
    let index = 0;

    return days.map(function (day, position) {
      while (index < moves.length && dayKey(moves[index].timestamp) <= day) {
        balance += moves[index].type === 'buy' ? -moves[index].amount : moves[index].amount;
        index += 1;
      }
      /* Prioridad: reconstrucción del Worker, luego la foto local, y para el
         último día el valor recién sincronizado, que es el más fresco. */
      const stored = history[day] && history[day][name];
      let value = remote[day] != null ? remote[day] : (stored != null ? stored : null);
      if (position === days.length - 1 && team && team.value != null) value = team.value;

      return { day: day, saldo: balance, value: value };
    });
  }

  const shortDay = (day) => day.slice(8, 10) + '/' + day.slice(5, 7);
  const shortMoney = (n) => (Math.round(n / 100000) / 10).toFixed(1).replace('.', ',') + 'M';

  /**
   * Gráfico de líneas en SVG, sin librerías. Ancho fijo en el viewBox y
   * escalado por CSS; el trazo se mantiene a 2 px reales.
   */
  /**
   * @param {Array} [options.series] Varias líneas en el mismo gráfico, cada
   *        una con su campo y color; entonces `key` solo fija la escala.
   */
  function lineChart(points, key, color, label, options) {
    const opts = options || {};
    const isCount = !!opts.count;
    const isBars = !!opts.bars;
    const multi = opts.series && opts.series.length ? opts.series : null;
    /* En el detalle ampliado las cifras van completas: «0,5M» no sirve para
       comparar precios de verdad. */
    const fmtTick = isCount ? function (v) { return String(Math.round(v)); }
      : (opts.fullTicks ? function (v) { return money(Math.round(v)); } : shortMoney);
    const fmtFull = isCount ? function (v) { return Math.round(v) + (v === 1 ? ' movimiento' : ' movimientos'); } : money;
    const fields = multi ? multi.map(function (s) { return s.field; }) : [key];
    const valid = points.filter(function (point) {
      return fields.some(function (field) { return point[field] != null; });
    });
    if (valid.length === 0) {
      return '<p class="viz__empty">Sin datos todavía de ' + escapeHtml(label.toLowerCase()) + '.</p>';
    }

    /* Con las cifras completas hace falta más margen a la izquierda o se salen. */
    const W = 600, H = opts.height || 130, padX = opts.padX || 46, padTop = 14, padBottom = 22;
    const values = [];
    valid.forEach(function (point) {
      fields.forEach(function (field) { if (point[field] != null) values.push(point[field]); });
    });
    /* Lo que se pagó por él va marcado en el gráfico: entra en la escala para
       que el punto no se salga por arriba ni por abajo. */
    if (opts.mark && opts.mark.paid != null) values.push(opts.mark.paid);

    let min = Math.min.apply(null, values);
    let max = Math.max.apply(null, values);
    // Las barras arrancan siempre en cero: si no, exageran diferencias pequeñas.
    if (isBars) { min = Math.min(0, min); max = Math.max(max, min + 1); }

    // Serie plana: se abre un margen proporcional para que la línea quede centrada.
    if (!isBars && min === max) {
      const pad = isCount ? Math.max(1, Math.abs(min) * 0.2) : Math.max(500000, Math.abs(min) * 0.05);
      min -= pad;
      max += pad;
    }
    const span = max - min;

    const x = (i) => points.length === 1
      ? W / 2
      : padX + (i * (W - padX - 12)) / (points.length - 1);
    const y = (v) => padTop + (1 - (v - min) / span) * (H - padTop - padBottom);

    const coords = points
      .map(function (point, i) { return point[key] == null ? null : { x: x(i), y: y(point[key]), point: point }; })
      .filter(Boolean);

    const path = coords.map(function (c, i) { return (i ? 'L' : 'M') + c.x.toFixed(1) + ' ' + c.y.toFixed(1); }).join(' ');

    /* Si se sabe cuándo pasó a ser de alguien, lo anterior se pinta apagado y
       lo posterior con el color del gráfico: se ve de un vistazo desde cuándo
       es suyo. */
    const corte = opts.mark && opts.mark.day
      ? coords.map(function (c) { return c.point.day; }).indexOf(opts.mark.day)
      : -1;
    const trazo = corte > 0
      ? '<path class="viz__line viz__line--antes" d="' +
          coords.slice(0, corte + 1).map(function (c, i) {
            return (i ? 'L' : 'M') + c.x.toFixed(1) + ' ' + c.y.toFixed(1);
          }).join(' ') + '"></path>' +
        '<path class="viz__line" d="' +
          coords.slice(corte).map(function (c, i) {
            return (i ? 'L' : 'M') + c.x.toFixed(1) + ' ' + c.y.toFixed(1);
          }).join(' ') + '" stroke="' + color + '"></path>'
      : '<path class="viz__line" d="' + path + '" stroke="' + color + '"></path>';
    const area = coords.length > 1
      ? '<path class="viz__area" d="' + path + ' L' + coords[coords.length - 1].x.toFixed(1) + ' ' + (H - padBottom) +
        ' L' + coords[0].x.toFixed(1) + ' ' + (H - padBottom) + ' Z" fill="' + color + '"></path>'
      : '';

    /* Por defecto tres líneas de referencia; el detalle ampliado pide más. */
    const cuantas = opts.ticks || 3;
    const escalones = [];
    for (let i = 0; i < cuantas; i++) escalones.push(min + (span * i) / (cuantas - 1));

    const grid = escalones.map(function (v) {
      return '<line class="viz__grid" x1="' + padX + '" x2="' + (W - 12) + '" y1="' + y(v).toFixed(1) +
        '" y2="' + y(v).toFixed(1) + '"></line>' +
        '<text class="viz__tick" x="' + (padX - 6) + '" y="' + (y(v) + 3).toFixed(1) + '" text-anchor="end">' +
        fmtTick(v) + '</text>';
    }).join('');

    /* Por defecto el eje va en fechas; las jornadas traen su propia etiqueta. */
    const etiqueta = opts.xlabel || function (point) { return shortDay(point.day); };
    const firstLabel = '<text class="viz__tick" x="' + padX + '" y="' + (H - 6) + '">' + etiqueta(points[0]) + '</text>';
    const lastLabel = points.length > 1
      ? '<text class="viz__tick" x="' + (W - 12) + '" y="' + (H - 6) + '" text-anchor="end">' +
        etiqueta(points[points.length - 1]) + '</text>'
      : '';

    /* Un día es un cubo, no un continuo: los flujos diarios van en barras, con
       hueco entre ellas y las esquinas redondeadas. */
    if (isBars) {
      const slot = points.length > 1 ? (x(1) - x(0)) : (W - padX - 12);
      const width = Math.max(3, Math.min(38, slot * 0.62));
      const base = y(Math.max(0, min));
      const bars = points.map(function (point, i) {
        const value = point[key];
        if (value == null) return '';
        const top = y(value);
        const height = Math.max(1, base - top);
        return '<rect class="viz__bar" x="' + (x(i) - width / 2).toFixed(1) + '" y="' + top.toFixed(1) +
          '" width="' + width.toFixed(1) + '" height="' + height.toFixed(1) + '" rx="3" fill="' + color + '">' +
          '<title>' + shortDay(point.day) + ' · ' + fmtFull(value) + '</title></rect>';
      }).join('');

      return '<svg class="viz__svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' +
        escapeHtml(label) + ' por día">' + grid + bars + firstLabel + lastLabel + '</svg>';
    }

    /* Varias líneas: se dibuja cada serie con su color y se acompaña de una
       leyenda, que el color por sí solo no basta para identificarlas. */
    if (multi) {
      const body = multi.map(function (serie) {
        const points2 = points
          .map(function (point, i) {
            return point[serie.field] == null ? null : { x: x(i), y: y(point[serie.field]), point: point };
          })
          .filter(Boolean);
        if (points2.length === 0) return '';
        const d = points2.map(function (c, i) {
          return (i ? 'L' : 'M') + c.x.toFixed(1) + ' ' + c.y.toFixed(1);
        }).join(' ');
        /* Con un dato por día son cientos de puntos, y cada uno lleva un borde
           de 2 px del color del fondo (.viz__dot): amontonados, esos bordes
           oscuros pintan por encima y BORRAN la línea. Por eso no se veían los
           colores. Cuando hay muchos, los puntos se quedan en una mota y sin
           borde, para que la línea quede a la vista; siguen llevando su
           etiqueta al pasar por encima. */
        const denso = points2.length > 60;
        const radio = denso ? 1.4 : 4;
        /* Por clase y no por atributo: el `stroke` de `.viz__dot` viene del
           CSS, y una regla de CSS siempre le gana a un atributo del SVG. */
        const clase = 'viz__dot' + (denso ? ' viz__dot--mota' : '');
        return '<path class="viz__line" d="' + d + '" stroke="' + serie.color + '"></path>' +
          points2.map(function (c) {
            return '<circle class="' + clase + '" cx="' + c.x.toFixed(1) + '" cy="' + c.y.toFixed(1) +
              '" r="' + radio + '" fill="' + serie.color + '"><title>' +
              etiqueta(c.point) + ' · ' +
              serie.label + ': ' + (isCount ? String(c.point[serie.field]) : money(c.point[serie.field])) +
              '</title></circle>';
          }).join('');
      }).join('');

      return '<svg class="viz__svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' +
        escapeHtml(label) + ' por día">' + grid + body + firstLabel + lastLabel + '</svg>';
    }

    /* Lo mismo que arriba: con muchos días, puntos de mota y sin borde, que
       si no tapan la línea. */
    const densoUno = coords.length > 60;
    const radioUno = densoUno ? 1.4 : 4;
    const claseUno = 'viz__dot' + (densoUno ? ' viz__dot--mota' : '');
    const dots = coords.map(function (c) {
      return '<circle class="' + claseUno + '" cx="' + c.x.toFixed(1) + '" cy="' + c.y.toFixed(1) +
        '" r="' + radioUno + '" fill="' + color +
        '"><title>' + shortDay(c.point.day) + ' · ' + fmtFull(c.point[key]) + '</title></circle>';
    }).join('');

    /* Las medidas viajan con el SVG: así el rastreador puede traducir un punto
       de la pantalla al día que le corresponde. */
    /* El día en que llegó a la plantilla se señala aparte, en azul, para
       distinguirlo del trazo del precio. */
    let marca = '';
    if (opts.mark && opts.mark.day) {
      const i = points.map(function (punto) { return punto.day; }).indexOf(opts.mark.day);
      if (i !== -1 && points[i][key] != null) {
        const mx = x(i);
        const my = y(points[i][key]);
        /* Sobre la misma raya, a la altura de lo que pagaste: de un vistazo se
           ve si lo compraste por encima o por debajo de lo que valía. */
        const pagado = opts.mark.paid != null
          ? '<circle class="viz__markpaid" cx="' + mx.toFixed(1) + '" cy="' + y(opts.mark.paid).toFixed(1) +
              '" r="5"><title>Pagaste ' + escapeHtml(money(opts.mark.paid)) + '</title></circle>'
          : '';
        marca = '<line class="viz__mark" x1="' + mx.toFixed(1) + '" x2="' + mx.toFixed(1) +
            '" y1="' + padTop + '" y2="' + (H - padBottom) + '"></line>' +
          '<circle class="viz__markdot" cx="' + mx.toFixed(1) + '" cy="' + my.toFixed(1) + '" r="6"></circle>' +
          pagado;
      }
    }

    const cursor = opts.hover
      ? '<line class="viz__cross" x1="0" x2="0" y1="' + padTop + '" y2="' + (H - padBottom) + '" hidden></line>' +
        '<circle class="viz__cursor" r="5" fill="' + color + '" hidden></circle>'
      : '';

    return '<svg class="viz__svg" viewBox="0 0 ' + W + ' ' + H + '" role="img"' +
      ' data-padx="' + padX + '" data-w="' + W + '"' +
      ' aria-label="Evolución de ' + escapeHtml(label.toLowerCase()) + '">' + grid + area +
      trazo + dots + marca + cursor + firstLabel + lastLabel + '</svg>';
  }

  /** Bloque de gráficos de la ficha, con sus interruptores. */
  function managerCharts(name) {
    ensureHistory(name);

    const loading = state.history[name] && state.history[name].status === 'loading';
    const points = managerSeries(name);
    const last = points[points.length - 1];

    const chips = CHART_SERIES.map(function (serie) {
      const on = state.charts[serie.key];
      return '<button type="button" class="chip" data-chart="' + serie.key + '" aria-pressed="' + (on ? 'true' : 'false') + '">' +
        '<span class="chip__dot" style="background:' + serie.color + '"></span>' +
        '<span class="chip__label">' + serie.label + '</span></button>';
    }).join('');

    const charts = CHART_SERIES.filter(function (serie) { return state.charts[serie.key]; })
      .map(function (serie) {
        const current = last ? last[serie.key] : null;
        return '<figure class="viz">' +
          '<figcaption class="viz__head">' + serie.label +
            '<strong>' + (current == null ? '—' : money(current)) + '</strong></figcaption>' +
          lineChart(points, serie.key, serie.color, serie.label) +
        '</figure>';
      }).join('');

    const note = loading
      ? '<p class="viz__empty">Reconstruyendo el valor de equipo día a día…</p>'
      : '';

    return '<div class="viz-block"><div class="chips">' + chips + '</div>' + note +
      (charts || '<p class="viz__empty">Activa alguna serie para ver su evolución.</p>') + '</div>';
  }

  /* ---------- Gráficos de la liga (los KPI) ---------- */

  /* Los tres primeros son flujos —lo que pasó ESE día— y van en barras. El
     saldo es un nivel, así que se dibuja como línea con el valor al cierre. */
  const KPI_SERIES = [
    /* El total va acompañado de su desglose: azul todo lo que se movió,
       ámbar lo que se ficha, verde lo que se vende. */
    { key: 'moves',   field: 'movesDay',  label: 'Movimientos',         color: 'var(--viz-1)', count: true,
      series: [
        { field: 'movesDay', color: 'var(--viz-1)', label: 'Total' },
        { field: 'buysDay',  color: 'var(--viz-4)', label: 'Fichajes' },
        { field: 'sellsDay', color: 'var(--viz-2)', label: 'Ventas' }
      ] },
    { key: 'spent',   field: 'spentDay',  label: 'Gastado en fichajes',  color: 'var(--viz-4)' },
    { key: 'earned',  field: 'earnedDay', label: 'Ingresado por ventas', color: 'var(--viz-2)' },
    { key: 'balance', field: 'balance',   label: 'Saldo total en liga', color: 'var(--viz-3)' }
  ];

  /** Primer día del que tiene sentido pintar: el arranque de la liga. */
  function startDay() {
    const candidates = state.movements
      .filter(function (movement) { return movement.timestamp; })
      .map(function (movement) { return dayKey(movement.timestamp); });
    if (state.leagueStart) candidates.push(state.leagueStart);
    if (candidates.length === 0) return dayKey(Date.now());
    return candidates.sort()[0];
  }

  function daysRange(from) {
    const days = [];
    const today = dayKey(Date.now());
    for (let time = Date.parse(from); time <= Date.parse(today); time += 86400000) days.push(dayKey(time));
    return days.length ? days : [today];
  }

  /** Serie diaria de toda la liga: movimientos, gasto e ingreso de cada día. */
  function leagueSeries() {
    const moves = state.movements
      .filter(function (movement) { return movement.timestamp; })
      .sort(function (a, b) { return a.timestamp - b.timestamp; });
    if (moves.length === 0) return [];

    const initial = INITIAL_BUDGET * MANAGERS.length;
    let spent = 0, earned = 0, index = 0;

    return daysRange(startDay()).map(function (day) {
      let movesDay = 0, buysDay = 0, sellsDay = 0, spentDay = 0, earnedDay = 0;
      while (index < moves.length && dayKey(moves[index].timestamp) <= day) {
        movesDay += 1;
        if (moves[index].type === 'buy') { buysDay += 1; spentDay += moves[index].amount; }
        else { sellsDay += 1; earnedDay += moves[index].amount; }
        index += 1;
      }
      spent += spentDay;
      earned += earnedDay;
      return {
        day: day,
        movesDay: movesDay,
        buysDay: buysDay,
        sellsDay: sellsDay,
        spentDay: spentDay,
        earnedDay: earnedDay,
        balance: initial - spent + earned
      };
    });
  }

  function renderKpiCharts() {
    const box = $('kpi-charts');
    const active = KPI_SERIES.filter(function (serie) { return state.kpiCharts[serie.key]; });

    if (active.length === 0) { box.hidden = true; box.innerHTML = ''; return; }

    const points = leagueSeries();
    if (points.length === 0) { box.hidden = true; box.innerHTML = ''; return; }

    const last = points[points.length - 1];
    box.hidden = false;
    box.innerHTML = active.map(function (serie) {
      const value = serie.count ? String(last[serie.field]) : money(last[serie.field]);
      const caption = serie.field === 'balance' ? serie.label + ' al cierre de cada día' : serie.label + ' por día';
      const legend = !serie.series ? '' :
        '<div class="viz__legend">' + serie.series.map(function (line) {
          return '<span class="viz__key"><span class="chip__dot" style="background:' + line.color + '"></span>' +
            line.label + '</span>';
        }).join('') + '</div>';
      return '<figure class="viz panel viz--kpi">' +
        '<figcaption class="viz__head">' + caption + '<strong>' + value + '</strong></figcaption>' +
        legend +
        lineChart(points, serie.field, serie.color, serie.label,
          { count: serie.count, bars: serie.bars, series: serie.series }) +
      '</figure>';
    }).join('');
  }

  /**
   * Orden dentro de la ficha de un jugador. Por «Acción» agrupa compras y
   * ventas, y dentro de cada grupo ordena del más caro al más barato; con
   * cualquier otra columna manda esa columna sin agrupar.
   */
  function sortDetail(moves, sort) {
    if (sort.key !== 'type') return sortRows(moves, 'moves', sort);
    return moves.slice().sort(function (a, b) {
      const groupA = a.type === 'buy' ? 0 : 1;
      const groupB = b.type === 'buy' ? 0 : 1;
      if (groupA !== groupB) return sort.dir === 1 ? groupA - groupB : groupB - groupA;
      return b.amount - a.amount;
    });
  }

  const DETAIL_COLUMNS = [
    { key: '',       label: '#',       cls: 'detail-rank' },
    { key: 'player', label: 'Jugador', cls: '' },
    { key: 'type',   label: 'Acción',  cls: '', title: 'Agrupa compras y ventas, cada grupo por precio' },
    { key: 'amount', label: 'Importe', cls: 'num' },
    { key: 'date',   label: 'Fecha',   cls: 'detail-date' }
  ];

  function detailHead() {
    const sort = state.sort.detail;
    return '<thead><tr>' + DETAIL_COLUMNS.map(function (column) {
      if (!column.key) return '<th class="' + column.cls + '"></th>';
      const active = sort.key === column.key;
      return '<th class="' + column.cls + ' sortable" data-detail-sort="' + column.key + '"' +
        ' tabindex="0" aria-sort="' + (active ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none') + '"' +
        (column.title ? ' title="' + column.title + '"' : '') + '>' + column.label + '</th>';
    }).join('') + '</tr></thead>';
  }

  /** Ficha desplegable de un jugador con sus jugadores. */
  function managerDetail(name) {
    const moves = sortDetail(
      state.movements.filter(function (movement) { return movement.manager === name; }),
      state.sort.detail
    );

    const inner = moves.length === 0
      ? '<p class="muted">Este jugador no tiene movimientos en el tablón.</p>'
      : '<table class="detail-table">' + detailHead() + '<tbody>' + moves.map(function (movement, index) {
          const buy = movement.type === 'buy';
          return '<tr>' +
            '<td class="detail-rank">' + (index + 1) + '</td>' +
            '<td><span class="with-crest">' + playerName(movement) +
              crestOf(movement, 'crest--badge') + '</span></td>' +
            '<td>' + etiquetaDeOperacion(movement) + '</td>' +
            '<td class="num">' + (buy
              ? '<span class="money-neg">−' + money(movement.amount) + '</span>'
              : '<span class="money-pos">+' + money(movement.amount) + '</span>') + '</td>' +
            '<td class="detail-date">' + escapeHtml(movement.date || '—') + '</td>' +
          '</tr>';
        }).join('') + '</tbody></table>';

    /* Aquí solo la lista de jugadores: los gráficos viven en la pestaña
       Jugadores, dentro de la ficha de cada uno. */
    return '<tr class="detail-row"><td class="detail-cell" colspan="' + BUDGET_COLUMNS + '">' +
      '<div class="detail">' + inner + '</div></td></tr>';
  }

  function renderBudgets(rows) {
    updateSortHeaders('budget', effectiveBudgetSort());

    $('budget-body').innerHTML = rows.map(function (row, index) {
      const negative = row.balance < 0;
      const expanded = state.expanded[row.name] === true;
      return '<tr class="' + (negative ? 'row-neg' : '') + '">' +
        '<td class="col-rank">' + (index + 1) + '</td>' +
        '<td data-label="Futbolista">' +
          '<button type="button" class="row-toggle" data-manager="' + escapeHtml(row.name) + '"' +
            ' aria-expanded="' + (expanded ? 'true' : 'false') + '">' +
            '<span class="row-toggle__icon" aria-hidden="true">▸</span>' +
            '<span class="manager">' + avatar(row.name) +
              '<span class="manager__name">' + escapeHtml(row.name) + '</span></span>' +
          '</button></td>' +
        '<td class="num" data-label="Fichajes">' +
          (row.buys ? '<strong>' + row.buys + '</strong>' : '<span class="zero">0</span>') + '</td>' +
        '<td class="num" data-label="Ventas">' +
          (row.sells ? '<strong>' + row.sells + '</strong>' : '<span class="zero">0</span>') + '</td>' +
        '<td class="num" data-label="Gastado">' +
          (row.spent ? '<span class="money-neg">−' + money(row.spent) + '</span>' : '<span class="zero">' + money(0) + '</span>') + '</td>' +
        '<td class="num" data-label="Ingresado">' +
          (row.earned ? '<span class="money-pos">+' + money(row.earned) + '</span>' : '<span class="zero">' + money(0) + '</span>') + '</td>' +
        '<td class="num" data-label="Saldo"><strong>' +
          '<span class="' + (negative ? 'money-neg' : '') + '">' + money(row.balance) + '</span></strong>' +
          (row.officialBalance != null && row.officialBalance !== row.balance
            ? '<span class="mismatch" title="Biwenger dice ' + money(row.officialBalance) +
              '. La diferencia sale de movimientos que el tablón no detalla: cesiones, bonus de jornada o cláusulas.">≠</span>'
            : '') + '</td>' +
        '<td class="num" data-label="Valor equipo">' +
          (row.teamValue == null ? '<span class="unknown">—</span>' : money(row.teamValue)) + '</td>' +
        '<td class="num" data-label="Jug.">' +
          (row.players == null ? '<span class="unknown">—</span>' : row.players) + '</td>' +
        '<td class="num col-bid" data-label="Puja máxima">' +
          (row.maxBid == null ? '<span class="unknown">—</span>' : '<strong>' + signedCell(row.maxBid) + '</strong>') + '</td>' +
      '</tr>' + (expanded ? managerDetail(row.name) : '');
    }).join('');

    const totals = rows.reduce(function (acc, row) {
      acc.initial += row.initial;
      acc.spent += row.spent;
      acc.earned += row.earned;
      acc.balance += row.balance;
      acc.buys += row.buys;
      acc.sells += row.sells;
      if (row.teamValue != null) acc.teamValue += row.teamValue;
      if (row.players != null) acc.players += row.players;
      return acc;
    }, { initial: 0, spent: 0, earned: 0, balance: 0, teamValue: 0, buys: 0, sells: 0, players: 0 });

    $('budget-foot').innerHTML = '<tr>' +
      '<td class="col-rank"></td>' +
      '<td data-label="Total">Total liga</td>' +
      '<td class="num" data-label="Fichajes">' + totals.buys + '</td>' +
      '<td class="num" data-label="Ventas">' + totals.sells + '</td>' +
      '<td class="num" data-label="Gastado">' + (totals.spent ? '−' + money(totals.spent) : money(0)) + '</td>' +
      '<td class="num" data-label="Ingresado">' + (totals.earned ? '+' + money(totals.earned) : money(0)) + '</td>' +
      '<td class="num" data-label="Saldo">' + money(totals.balance) + '</td>' +
      '<td class="num" data-label="Valor equipo">' + (totals.teamValue ? money(totals.teamValue) : '<span class="unknown">—</span>') + '</td>' +
      '<td class="num" data-label="Jug.">' + (totals.players || '') + '</td>' +
      '<td class="num" data-label="Puja máxima">' +
        '<span class="pie-nota">(saldo + 25 % valor equipo)</span></td>' +
    '</tr>';

    $('standings-hint').hidden = Object.keys(state.teams).length > 0;
  }

  function filteredMovements() {
    const text = normalize(state.filters.text);
    return state.movements.filter(function (movement) {
      if (state.filters.type && movement.type !== state.filters.type) return false;
      if (state.filters.manager && movement.manager !== state.filters.manager) return false;
      if (text) {
        const hay = normalize(movement.player + ' ' + (movement.manager || ''));
        if (hay.indexOf(text) === -1) return false;
      }
      return true;
    });
  }

  function renderMovements() {
    const list = sortRows(filteredMovements(), 'moves', state.sort.moves);
    updateSortHeaders('moves', state.sort.moves);

    $('moves-body').innerHTML = list.map(function (movement, index) {
      const buy = movement.type === 'buy';
      const managerCell = movement.manager
        ? '<div class="manager">' + avatar(movement.manager) + '<span>' + escapeHtml(movement.manager) + '</span></div>'
        : '<span class="unknown">Sin identificar</span>';
      return '<tr>' +
        /* La demarcación va delante del nombre, como en las demás tablas. */
        '<td data-label="Futbolista"><span class="with-crest">' + playerName(movement) +
          crestOf(movement, 'crest--badge') + '</span></td>' +
        '<td class="estado-cell" data-label="Estado">' +
          statusCell({ id: movement.playerId,
            status: state.moveStatus[moveKey(movement)] || movement.status }) + '</td>' +
        '<td data-label="Acción">' + etiquetaDeOperacion(movement) + '</td>' +
        '<td data-label="Futbolista">' + managerCell + '</td>' +
        /* El abono puede ser negativo, si la liga resta por puntuación
           negativa: entonces se pinta como lo que es, dinero que se va. */
        '<td class="num" data-label="Importe">' +
          (buy || movement.amount < 0
            ? '<span class="money-neg">−' + money(Math.abs(movement.amount)) + '</span>'
            : '<span class="money-pos">+' + money(movement.amount) + '</span>') + '</td>' +
        '<td data-label="Fecha">' + escapeHtml(movement.date || '—') + '</td>' +
      '</tr>';
    }).join('');

    const empty = $('moves-empty');
    empty.hidden = list.length > 0;
    empty.textContent = state.movements.length === 0
      ? 'Aún no hay movimientos: pega el HTML del tablón arriba.'
      : 'Ningún movimiento coincide con el filtro.';
  }

  /** Mi jugador, el dueño del token con el que sincronizamos. */
  function myName() {
    if (!state.me || !state.me.id) return null;
    const found = Object.keys(state.teams).filter(function (name) {
      return state.teams[name] && state.teams[name].id === state.me.id;
    });
    return found[0] || null;
  }

  /** Saldo si se cerrasen las operaciones marcadas: pujas restan, ventas suman. */
  function simulation() {
    const name = myName();
    const rows = computeBudgets(state.movements, state.teams);
    const mine = rows.filter(function (row) { return row.name === name; })[0];
    const base = mine ? mine.balance : (state.me && state.me.balance) || 0;

    let delta = 0;
    let count = 0;
    let squadDelta = 0;
    state.offers.concat(marketSales()).forEach(function (offer) {
      if (!state.sim[offer.id]) return;
      count += 1;
      // Una puja ganada suma un jugador; una venta aceptada resta uno.
      if (offer.direction === 'out') { delta -= offer.amount; squadDelta += 1; }
      else { delta += offer.amount; squadDelta -= 1; }
    });

    const teamValue = mine ? mine.teamValue : null;
    const squad = mine && mine.players != null ? mine.players : null;
    return {
      name: name,
      base: base,
      delta: delta,
      count: count,
      balance: base + delta,
      maxBid: teamValue == null ? null : base + delta + teamValue * TEAM_VALUE_SHARE,
      squad: squad == null ? null : squad + squadDelta
    };
  }

  /**
   * Etiqueta de una operación: «Compra» o «Venta» y, entre paréntesis, con
   * quién se hizo. Sin contraparte fue con el mercado.
   */
  function etiquetaDeOperacion(movimiento) {
    /* El abono de la jornada no es ni compra ni venta: no hay futbolista ni
       nadie al otro lado, es la liga pagando por lo que se ha puntuado. */
    if (movimiento.type === 'bonus') {
      return '<span class="tag tag--sell">Abono' +
        ' <span class="tag__otro">(jornada)</span></span>';
    }
    const compra = movimiento.type !== 'sell';
    const otro = movimiento.otro || 'Mercado';
    return '<span class="tag ' + (compra ? 'tag--buy' : 'tag--sell') + '">' +
      (compra ? 'Compra' : 'Venta') +
      ' <span class="tag__otro">(' + escapeHtml(otro) + ')</span></span>';
  }

  /** @param {string} tone 'in' para ventas (verde) y 'out' para pujas (rojo). */
  function simToggle(id, checked, tone) {
    return '<button type="button" class="switch switch--' + tone + '" data-sim="' + escapeHtml(id) + '" aria-pressed="' +
      (checked ? 'true' : 'false') + '" title="Simular que se cierra"><span></span></button>';
  }

  /** Pujas enviadas y ofertas recibidas que siguen sin resolverse. */
  function renderOffers() {
    const section = $('offers-panel');
    const list = state.offers;

    if (!list || list.length === 0) {
      section.hidden = true;
      return;
    }
    section.hidden = false;

    $('offers-body').innerHTML = list.map(function (offer) {
      const out = offer.direction === 'out';
      const on = !!state.sim[offer.id];
      return '<tr class="' + (on ? 'row-sim' : '') + '">' +
        '<td data-label="Futbolista"><span class="with-crest">' + playerName(offer) +
          crestOf(offer, 'crest--badge') + '</span></td>' +
        '<td data-label="Operación"><span class="tag ' + (out ? 'tag--buy' : 'tag--sell') + '">' +
          (out ? '↗ Puja' : '↘ Oferta') + '</span> ' +
          '<span class="sub">' + escapeHtml(offer.other || 'Mercado') + '</span></td>' +
        '<td class="num" data-label="Importe"><strong class="' + (out ? 'money-neg' : 'money-pos') + '">' +
          (out ? '−' : '+') + money(offer.amount) + '</strong></td>' +
        '<td data-label="Queda">' + deadlineCell(offer.until) + '</td>' +
        '<td data-label="Simular">' + simToggle(offer.id, on, out ? 'out' : 'in') + '</td>' +
      '</tr>';
    }).join('');

    const outgoing = list.filter(function (offer) { return offer.direction === 'out'; });
    const incoming = list.length - outgoing.length;

    const parts = [];
    if (outgoing.length) {
      parts.push(outgoing.length + (outgoing.length === 1 ? ' puja enviada' : ' pujas enviadas'));
    }
    if (incoming) parts.push(incoming + (incoming === 1 ? ' oferta recibida' : ' ofertas recibidas'));
    $('offers-count').textContent = parts.join(' · ');

    renderSimulation();
  }

  /**
   * Altas y bajas de LaLiga: quién ha fichado por un club, quién lo ha dejado
   * y quién ha cambiado de equipo. No tiene nada que ver con nuestra liga.
   */
  /* «19 ago 2026», sin hora: en las altas y bajas de LaLiga no hace falta. */
  const fechaCorta = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });
  const diaCorto = (fecha) => fechaCorta.format(new Date(fecha));

  function renderMovimientosLaLiga() {
    const cuerpo = $('moves-body');
    const lista = state.laligaMoves || [];

    if (lista.length === 0) {
      cuerpo.innerHTML = '<tr><td colspan="6" class="muted">' +
        'Todavía no hay movimientos de LaLiga en el tablón.</td></tr>';
      return;
    }

    cuerpo.innerHTML = lista.map(function (mov) {
      const alta = mov.tipo !== 'baja';
      return '<tr>' +
        '<td data-label="Futbolista"><span class="with-crest">' +
          playerName({ playerId: mov.playerId, player: mov.player,
            position: mov.position, altPositions: mov.altPositions }) +
          crestOf(mov, 'crest--badge') + '</span></td>' +
        /* El estado solo dice algo si el futbolista sigue en LaLiga: en una baja
           definitiva no hay nada que avisar. */
        '<td class="estado-cell" data-label="Estado">' +
          (alta || mov.sigue ? statusCell({ id: mov.playerId, status: mov.status }) : '') + '</td>' +
        /* Alta en verde, baja en rojo. */
        '<td data-label="Movimiento"><span class="tag ' + (alta ? 'tag--sell' : 'tag--buy') + '">' +
          (alta ? 'Alta' : 'Baja') + '</span></td>' +
        '<td data-label="Equipo">' + escapeHtml(alta ? (mov.teamName || '—') : (mov.desde || '—')) + '</td>' +
        '<td class="num" data-label="Valor">' +
          (mov.marketValue == null ? '<span class="sub">—</span>' : money(mov.marketValue)) + '</td>' +
        /* Aquí la hora no aporta nada: basta con el día. */
        '<td data-label="Fecha">' + escapeHtml(mov.date ? diaCorto(mov.date) : '—') + '</td>' +
      '</tr>';
    }).join('');

    ajustarNombres();
  }

  /** Alterna entre los fichajes de la liga y los movimientos de LaLiga. */
  function pintarFichajes() {
    const enLaLiga = state.ambitoFichajes === 'laliga';
    const boton = $('moves-ambito');
    const titulo = $('moves-titulo');
    const filtros = document.querySelector('#panel-fichajes .filters');

    /* La píldora dice dónde ESTÁS, no a dónde irías: igual que las de Datos.
       Al revés confundía, porque ponía «LaLiga» estando en la tuya. */
    if (boton) boton.textContent = enLaLiga ? 'LaLiga' : 'Mi liga';
    if (titulo) titulo.textContent = enLaLiga ? 'Altas y bajas en LaLiga' : 'Todos los fichajes y ventas';
    /* Los filtros son de la liga: con los movimientos de LaLiga no pintan nada.
       Se ocultan uno a uno, no el bloque entero: la pastilla vive dentro y con
       ella desaparecía la única forma de volver. */
    if (filtros) {
      filtros.hidden = false;
      Array.prototype.forEach.call(filtros.querySelectorAll('.field'), function (campo) {
        campo.hidden = enLaLiga;
      });
    }

    const cabecera = document.querySelector('#panel-fichajes .table--moves thead tr');
    if (cabecera) {
      cabecera.innerHTML = enLaLiga
        ? '<th>Futbolista</th><th>Estado</th><th>Movimiento</th>' +
          '<th>Equipo</th><th class="num">Valor</th><th>Fecha</th>'
        : '<th class="sortable" data-sort="player" tabindex="0" aria-sort="none">Futbolista</th>' +
          '<th title="Cómo estaba el futbolista cuando se hizo la operación">Estado</th>' +
          '<th class="sortable" data-sort="type" tabindex="0" aria-sort="none">Acción</th>' +
          '<th class="sortable" data-sort="manager" tabindex="0" aria-sort="none">Jugador</th>' +
          '<th class="num sortable" data-sort="amount" tabindex="0" aria-sort="none">Importe</th>' +
          '<th class="sortable" data-sort="date" tabindex="0" aria-sort="none">Fecha</th>';
    }

    if (enLaLiga) renderMovimientosLaLiga();
    else renderMovements();
  }

  /** Cómo quedarías si se cerrasen las operaciones marcadas: saldo y plantilla. */
  function renderSimulation() {
    const note = $('offers-note');
    const sim = simulation();

    if (!state.me || state.me.balance == null) { note.hidden = true; return; }

    note.hidden = false;
    note.innerHTML = 'Saldo <strong class="' + (sim.balance < 0 ? 'money-neg' : '') + '">' +
      money(sim.balance) + '</strong>' +
      (sim.squad == null ? '' : ' · <strong>' + sim.squad +
        (sim.squad === 1 ? ' jugador' : ' jugadores') + '</strong>');
  }

  /* Valor de mercado del jugador; si Biwenger no lo diera, se cae al precio
     que pediste por él. */
  const listingValue = (item) => (item.marketValue != null ? item.marketValue : item.price);
  const marketSaleId = (item) => 'mkt:' + (item.playerId || item.player);

  /** Venta al valor de mercado de los que no tienen oferta, para simularla. */
  function marketSales() {
    return state.listings
      .filter(function (item) {
        return !state.offers.some(function (offer) {
          return offer.direction === 'in' && offer.playerId && offer.playerId === item.playerId;
        });
      })
      .map(function (item) {
        return { id: marketSaleId(item), amount: listingValue(item), direction: 'in' };
      });
  }

  /** Jugadores propios puestos a la venta. */
  function renderListings() {
    const section = $('listings-panel');
    const list = state.listings;

    if (!list || list.length === 0) { section.hidden = true; return; }
    section.hidden = false;

    $('listings-body').innerHTML = list.map(function (item) {
      const market = listingValue(item);

      // Ofertas recibidas por ese jugador, para poder aceptarlas en la simulación.
      const bids = state.offers.filter(function (offer) {
        return offer.direction === 'in' && offer.playerId && offer.playerId === item.playerId;
      });

      /* Sin ofertas se ofrece simular la venta al valor de mercado, en ámbar
         para distinguirla de una oferta real. */
      const offerCell = bids.length === 0
        ? (function () {
            const id = marketSaleId(item);
            const on = !!state.sim[id];
            return '<span class="bid' + (on ? ' bid--on' : '') + '" title="Sin ofertas: simula venderlo a su valor de mercado">' +
              '<strong class="' + (on ? 'money-pos' : 'money-market') + '">' + money(market) + '</strong> ' +
              simToggle(id, on, 'in') + '</span>';
          })()
        : bids.map(function (offer) {
            const on = !!state.sim[offer.id];
            const diff = offer.amount - market;
            /* Triángulo arriba en verde si la oferta mejora el valor de
               mercado, abajo en rojo si lo empeora, con la diferencia. */
            const delta = diff === 0 ? '' :
              '<span class="delta ' + (diff > 0 ? 'delta--up' : 'delta--down') + '">' +
              (diff > 0 ? '▲ +' : '▼ −') + money(Math.abs(diff)) + '</span>';
            return '<span class="bid' + (on ? ' bid--on' : '') + '" title="Oferta de ' +
              escapeHtml(offer.other || 'Mercado') + '">' +
              '<strong class="' + (on ? 'money-pos' : '') + '">' + money(offer.amount) + '</strong> ' +
              delta + ' ' + simToggle(offer.id, on, 'in') + '</span>';
          }).join('');

      return '<tr>' +
        '<td data-label="Futbolista"><span class="with-crest">' + playerName(item) +
          crestOf(item, 'crest--badge') + '</span></td>' +
        '<td class="num" data-label="Valor"><strong>' + money(market) + '</strong></td>' +
        '<td data-label="Queda">' + deadlineCell(item.until) + '</td>' +
        '<td data-label="Ofertas">' + offerCell + '</td>' +
      '</tr>';
    }).join('');

    const total = list.reduce(function (sum, item) { return sum + listingValue(item); }, 0);
    $('listings-count').textContent = list.length + (list.length === 1 ? ' jugador en venta' : ' jugadores en venta') +
      ' · ' + money(total) + ' de valor de mercado';
  }

  /* ---------- Cuenta atrás de la jornada ---------- */

  /**
   * ¿Lo siguiente que pasa es que arranca una jornada?
   *
   * Son dos casos: que la de la tarjeta no haya empezado todavía, o que ya esté
   * jugada y el próximo pitido sea de la siguiente. En los dos, la lista de
   * partidos no aporta nada y lo que interesa es la cuenta atrás.
   */
  function jornadaPorEmpezar(round) {
    if (!round) return false;
    /* Lo dice el Worker, que es quien ve las dos jornadas a la vez. */
    if (round.proximo && round.proximo.arranca != null) return !!round.proximo.arranca;
    /* Si contesta un Worker viejo, se apaña con lo que hay: vale para la
       jornada de la propia tarjeta, no para una aplazada. */
    return !round.live && (round.played || 0) === 0;
  }

  function renderRound() {
    const section = $('round-panel');
    const round = state.round;
    if (!round || !round.start) { section.hidden = true; return; }

    section.hidden = false;
    const porEmpezar = jornadaPorEmpezar(round);
    section.classList.toggle('round--porempezar', porEmpezar);
    /* Con la jornada empezada no interesa el arranque de la siguiente, sino
       cómo va la de ahora. */
    const enJuego = !!round.live;
    /* Si hay un partido rodando, el rótulo lo dice; el reloj de al lado lleva el
       marcador. Si no, cuántos van jugados o cuándo empieza. */
    /* En juego según Biwenger o según ESPN: él lo marca antes, así que un
       partido recién empezado ya sale aquí aunque Biwenger siga sin marcador. */
    const rodando = (round.matches || []).filter(function (partido) {
      if (partido.status === 'finished') return false;
      if (partido.homeScore != null && partido.awayScore != null) return true;
      return !!marcadorEnVivo(partido.home, partido.away);
    })[0];
    const vivoAhora = rodando ? marcadorEnVivo(rodando.home, rodando.away) : null;

    /* Con la jornada empezada el rótulo sobra: ya se ve el partido en curso o
       los que van jugados. Solo se dice algo cuando aún no ha arrancado.

       Mirar solo `live` no bastaba: una jornada con la mitad jugada y el resto
       aplazado no tiene ningún partido rodando ahora mismo, así que volvía a
       anunciarse como «Inicio de la Jornada 1» con seis partidos ya en el
       bote. Lo que decide es si ha arrancado, no si hay algo en juego. */
    $('round-label').textContent = porEmpezar ? 'Inicio de la' : '';
    $('round-name').textContent = 'Jornada ' + (round.number || '');

    if (rodando) {
      /* Escudos, igual que en el resto de la tarjeta: el nombre en texto
         desentonaba con el próximo partido de al lado, que va con escudos. */
      /* El marcador de ESPN manda mientras rueda: va por delante del suyo. */
      const marca = vivoAhora
        ? vivoAhora.homeScore + '–' + vivoAhora.awayScore
        : rodando.homeScore + '–' + rodando.awayScore;
      /* El minuto va detrás del marcador, no en el rótulo: así se lee de
         corrido «0–0 84'» en vez de tener el dato partido en dos sitios. */
      $('round-when').innerHTML = '<span class="round__live">En juego</span>' +
        '<span class="round__ahora">' + escudoDeEquipo(rodando.homeId, rodando.home) +
          '<strong class="round__score">' + marca + '</strong>' +
          escudoDeEquipo(rodando.awayId, rodando.away) +
          (vivoAhora && vivoAhora.reloj
            ? '<strong class="round__minuto">' + escapeHtml(vivoAhora.reloj) + '</strong>' : '') +
        '</span>';
    } else {
      /* Antes de arrancar, ni fecha ni hora: la cuenta atras de al lado ya dice
         cuanto queda, que es lo que se mira, y la fecha solo hacia ruido. */
      /* Ya arrancada, lo que se mira es por dónde va, no la fecha del siguiente
         —esa la da la cuenta atrás de al lado—. Con los aplazados, la fecha
         era encima la de dentro de diez días. */
      $('round-when').textContent = porEmpezar ? ''
        : (round.played || 0) + ' de ' + (round.games || 0) + ' partidos jugados';
    }

    const matches = round.matches || [];
    const toggle = $('round-toggle');
    /* Antes de que arranque la jornada la cuenta atrás pasa a la izquierda, pero
       el botón se queda: los horarios y la tele siguen haciendo falta, que es
       justo lo que se mira cuando aún no ha empezado. */
    toggle.hidden = false;
    toggle.setAttribute('aria-expanded', state.roundOpen && matches.length ? 'true' : 'false');
    toggle.disabled = matches.length === 0;

    const box = $('round-games');
    box.hidden = !(state.roundOpen && matches.length);
    if (!box.hidden) box.innerHTML = roundGames(matches);
    tickRound();
  }

  /** Los diez partidos, agrupados por día: hora, marcador y dónde se ve. */
  /** El escudo de un equipo; el nombre queda en el título, al pasar por encima. */
  function escudoDeEquipo(id, nombre) {
    if (id == null) return '<span class="round__equipo">' + escapeHtml(nombre || '') + '</span>';
    return '<span class="round__equipo" title="' + escapeHtml(nombre || '') + '">' +
      '<img class="round__escudo" src="' + escapeHtml(crestUrl(id)) + '" alt="' +
        escapeHtml(nombre || '') + '" loading="lazy">' +
    '</span>';
  }

  function roundGames(matches) {
    let day = '';
    return matches.map(function (match) {
      const when = new Date(match.start);
      const key = dayFormat.format(when);
      const header = key === day ? '' :
        '<p class="round__day">' + escapeHtml(key) + '</p>';
      day = key;

      const acabado = match.status === 'finished';
      /* Mientras rueda manda ESPN, que va por delante de Biwenger. */
      const vivo = acabado ? null : marcadorEnVivo(match.home, match.away);
      const hayMarcador = vivo ? true : (match.homeScore != null && match.awayScore != null);
      const rodando = hayMarcador && !acabado;
      const marca = vivo
        ? vivo.homeScore + '–' + vivo.awayScore
        : match.homeScore + '–' + match.awayScore;

      /* Una vez jugado el partido, el canal ya no le importa a nadie: ese
         hueco lo ocupa cómo va. */
      /* El mismo distintivo que arriba —punto que late incluido— para que la
         lista y la cabecera se lean igual. */
      const estado = acabado ? '<span class="round__final">Final</span>'
        : (rodando ? '<span class="round__live round__live--fila">En juego' +
            (vivo && vivo.reloj
              ? ' <strong class="round__minuto">' + escapeHtml(vivo.reloj) + '</strong>' : '') +
            '</span>'
          : (match.tv ? escapeHtml(match.tv) : '—'));

      return header +
        '<div class="round__game' + (rodando ? ' round__game--live' : '') +
          (acabado ? ' round__game--done' : '') + '">' +
          '<span class="round__hour">' + timeFormat.format(when) + '</span>' +
          '<span class="round__teams">' + escudoDeEquipo(match.homeId, match.home) +
            (hayMarcador
              ? '<span class="round__vs round__score">' + marca + '</span>'
              : '<span class="round__vs">–</span>') +
            escudoDeEquipo(match.awayId, match.away) + '</span>' +
          '<span class="round__tv">' + estado + '</span>' +
        '</div>';
    }).join('');
  }

  /** Actualiza el reloj; se llama cada segundo. */
  function tickRound() {
    tickDeadlines();
    const clock = $('round-clock');
    const round = state.round;
    if (!clock || !round || !round.start) return;

    let left = Math.floor((Date.parse(round.start) - Date.now()) / 1000);
    const enJuego = !!round.live;

    if (left <= 0) {
      if (enJuego) {
        clock.innerHTML = '<span class="round__live">En juego</span>';
        state.pidiendoArranque = false;
        return;
      }
      /* El reloj ha llegado a cero pero el Worker todavía no ha puesto la
         jornada «en juego»: Biwenger tarda un poco en avisar. Se adelanta
         una sincronización para que se ponga al día cuanto antes, y mientras
         tanto no se dice nada contradictorio como «¡Ya! en juego». */
      if (!state.pidiendoArranque) {
        state.pidiendoArranque = true;
        syncNow(true);
      }
      clock.innerHTML = '<span class="round__unit"><span class="round__value">…</span>' +
        '<small>empezando</small></span>';
      return;
    }
    state.pidiendoArranque = false;

    const days = Math.floor(left / 86400); left -= days * 86400;
    const hours = Math.floor(left / 3600); left -= hours * 3600;
    const minutes = Math.floor(left / 60);
    const seconds = left - minutes * 60;
    const pad = (n) => (n < 10 ? '0' + n : String(n));

    /* Con la jornada empezada el reloj cuenta al siguiente partido, no al
       arranque de nada. */
    const unidades = [
      { value: days, label: days === 1 ? 'día' : 'días' },
      { value: pad(hours), label: 'horas' },
      { value: pad(minutes), label: 'min' },
      { value: pad(seconds), label: 'seg' }
    ].map(function (unit) {
      return '<span class="round__unit"><span class="round__value">' + unit.value + '</span>' +
        '<small>' + unit.label + '</small></span>';
    }).join('');

    /* A la derecha, siempre la cuenta atrás, diciendo a qué partido. El Worker
       lo busca entre las dos jornadas: LaLiga aplaza partidos y a veces el
       siguiente pitido es de otra jornada distinta a la que está en juego. */
    const siguiente = round.proximo || (round.matches || []).filter(function (partido) {
      return Date.parse(partido.start) === Date.parse(round.start);
    })[0];

    /* Cuando la jornada va a empezar, el botón de al lado ya dice cuál es y
       cuándo: repetir «próximo partido · Jornada 2» era decirlo dos veces. Se
       quedan solo los escudos y la cuenta atrás. */
    const porEmpezar = jornadaPorEmpezar(round);
    const escudos = siguiente
      ? '<span class="round__rival">' +
        escudoDeEquipo(siguiente.homeId, siguiente.home) +
        '<span class="round__vs">–</span>' +
        escudoDeEquipo(siguiente.awayId, siguiente.away) + '</span>'
      : '';

    const deOtra = siguiente && siguiente.otraJornada && siguiente.number
      ? ' (jornada ' + siguiente.number + ')' : '';
    const rotulo = porEmpezar
      ? escudos
      : (siguiente ? 'próximo partido' + deOtra + ' · ' + escudos : 'próximo partido');

    clock.innerHTML = '<span class="round__next"><small>' + rotulo + '</small>' +
      unidades + '</span>';
  }

  /* ---------- Cuenta atrás de pujas y ventas ---------- */

  /** Lo que queda hasta `until`, en el detalle justo para cada escala. */
  function timeLeft(until, conSegundos) {
    if (!until) return null;
    const left = Date.parse(until) - Date.now();
    if (isNaN(left)) return null;
    if (left <= 0) return { text: 'vencida', urgent: true };

    /* Formato corto para que la columna no ensanche la tabla; con segundos
       solo donde se piden, como en la renovación del mercado. */
    const seconds = Math.floor(left / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    const cola = conSegundos ? ' ' + (seconds - minutes * 60) + 's' : '';

    if (days >= 1) return { text: days + 'd ' + (hours - days * 24) + 'h' + cola, urgent: false };
    if (hours >= 1) return { text: hours + 'h ' + (minutes - hours * 60) + 'm' + cola, urgent: hours < 2 };
    return { text: minutes + 'm' + cola, urgent: true };
  }

  /** Cuánto hace de algo, en horas, minutos y segundos. */
  function timeSince(desde) {
    if (!desde) return null;
    const pasado = Date.now() - Date.parse(desde);
    if (isNaN(pasado) || pasado < 0) return null;

    const seconds = Math.floor(pasado / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days >= 1) return days + 'd ' + (hours - days * 24) + 'h ' + (minutes - hours * 60) + 'm';
    return hours + 'h ' + (minutes - hours * 60) + 'm ' + (seconds - minutes * 60) + 's';
  }

  function sinceCell(desde) {
    const texto = timeSince(desde);
    if (!texto) return '<span class="sub">—</span>';
    return '<span class="deadline" data-since="' + escapeHtml(desde) + '"' +
      ' title="' + escapeHtml(dateFormat.format(new Date(desde))) + '">' + texto + '</span>';
  }

  /** Celda con el tiempo restante; `tickDeadlines` la refresca cada segundo. */
  function deadlineCell(until, conSegundos) {
    const left = timeLeft(until, conSegundos);
    if (!left) return '<span class="sub">—</span>';
    return '<span class="deadline' + (left.urgent ? ' deadline--soon' : '') + '"' +
      ' data-until="' + escapeHtml(until) + '"' + (conSegundos ? ' data-seconds="1"' : '') +
      ' title="' + escapeHtml(dateFormat.format(new Date(until))) + '">' +
      escapeHtml(left.text) + '</span>';
  }

  /* Se actualizan en el sitio, sin repintar las tablas enteras. */
  function tickDeadlines() {
    const desdes = document.querySelectorAll('[data-since]');
    for (let j = 0; j < desdes.length; j++) {
      const texto = timeSince(desdes[j].getAttribute('data-since'));
      if (texto) desdes[j].textContent = texto;
    }

    const marcas = document.querySelectorAll('[data-until]');
    for (let i = 0; i < marcas.length; i++) {
      const left = timeLeft(marcas[i].getAttribute('data-until'), marcas[i].hasAttribute('data-seconds'));
      if (!left) continue;
      marcas[i].textContent = left.text;
      marcas[i].classList.toggle('deadline--soon', left.urgent);
    }
  }

  /* ---------- Alineación (simulador) ---------- */

  /* Los siete sistemas de Biwenger. El portero va aparte, siempre uno. */
  /* Los catorce sistemas de Biwenger: los siete básicos y los siete que la
     aplicación marca en azul, reservados a las ligas de pago. */
  const FORMATIONS = [
    '3-2-5', '3-3-4', '3-4-3', '3-5-2', '3-6-1',
    '4-2-4', '4-3-3', '4-4-2', '4-5-1', '4-6-0',
    '5-1-4', '5-2-3', '5-3-2', '5-4-1'
  ];
  const POSITION_NAMES = { 1: 'POR', 2: 'DEF', 3: 'MED', 4: 'DEL' };

  /** Pide al Worker las plantillas de todos: hacen falta aquí y en Jugadores. */
  function ensureSquads() {
    if (state.squads) return;
    const config = loadSyncConfig();
    if (!config.url || !config.key) return;

    /* Lo de la última vez se enseña ya, sin esperar a la red: la plantilla no
       cambia de un minuto para otro y así la pestaña abre llena. Lo que llegue
       después manda. */
    const guardado = cacheLeer('squads');
    state.squads = guardado
      ? { status: 'ok', list: guardado.squads || [] }
      : { status: 'loading', list: [] };
    if (guardado) (guardado.squads || []).forEach(function (s) { recordarPosiciones(s.players); });
    fetch(config.url.replace(/\/+$/, '') + '/?key=' + encodeURIComponent(config.key) + '&squads=1',
      { headers: { 'accept': 'application/json' } })
      .then(function (response) { return response.json(); })
      .then(function (payload) {
        if (payload.error) throw new Error(payload.error);
        state.squads = { status: 'ok', list: payload.squads || [] };
        (payload.squads || []).forEach(function (s) { recordarPosiciones(s.players); });
        cacheGuardar('squads', payload);
        render();
        if (state.tab === 'jornadas') renderPartidos();
      })
      .catch(function () {
        /* Con algo guardado se deja lo que ya se veía, que es mejor que nada. */
        if (!state.squads || state.squads.status !== 'ok') {
          state.squads = { status: 'error', list: [] };
        }
        render();
      });
  }

  const squadList = () => (state.squads && state.squads.list) || [];

  /** Mi plantilla completa, sacada de las plantillas de la liga. */
  function mySquad() {
    const id = state.me && state.me.id;
    const mine = squadList().filter(function (squad) { return squad.id === id; })[0];
    return mine ? mine.players : [];
  }

  /** Cuántos jugadores pide cada línea del sistema elegido. */
  function formationLines(type) {
    const parts = String(type || '4-4-2').split('-').map(Number);
    /* Ojo con el cero: en el 4-6-0 no hay delanteros, y un `|| 2` lo
       convertiría en dos. */
    const linea = (valor, porDefecto) => (isNaN(valor) ? porDefecto : valor);
    return { 2: linea(parts[0], 4), 3: linea(parts[1], 4), 4: linea(parts[2], 2) };
  }

  /* El once del simulador arranca con lo que tengas puesto en Biwenger y se
     puede cambiar libremente; no se envía a ningún sitio. */
  function persistXi() {
    try {
      if (state.xi) localStorage.setItem(XI_KEY, JSON.stringify(state.xi));
    } catch (error) { /* sin persistencia */ }
  }

  /* ---------- La alineación, igual en el PC y en el móvil ----------
     Se guarda en el almacén del Worker con la hora en que la tocaste. Al
     sincronizar, cada aparato se queda con la más reciente. */

  let envioXi = null;

  /** Alineación cambiada por ti: se sella con la hora y se comparte. */
  function guardarXiMia() {
    if (state.xi) state.xi.savedAt = new Date().toISOString();
    persistXi();

    const config = loadSyncConfig();
    if (!config.url || !config.key || !state.xi) return;

    /* Al recolocar a varios seguidos se espera un poco: un solo envío. */
    clearTimeout(envioXi);
    envioXi = setTimeout(function () {
      fetch(config.url.replace(/\/+$/, '') + '/?key=' + encodeURIComponent(config.key) + '&alineacion=1', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(state.xi)
      }).catch(function () { /* se queda en local; ya subirá al próximo cambio */ });
    }, 1200);
  }

  /** Trae la del almacén y se queda con ella solo si es más nueva que la de aquí. */
  function traerXiCompartida() {
    const config = loadSyncConfig();
    if (!config.url || !config.key) return;

    fetch(config.url.replace(/\/+$/, '') + '/?key=' + encodeURIComponent(config.key) + '&alineacion=1',
      { headers: { 'accept': 'application/json' } })
      .then(function (response) { return response.json(); })
      .then(function (payload) {
        const fuera = payload && payload.lineup;
        if (!fuera || !fuera.slots || !fuera.savedAt) return;

        const mia = state.xi;
        if (mia && mia.savedAt && mia.savedAt >= fuera.savedAt) return;

        /* Ni pisa a la que tengas puesta en Biwenger si esa es posterior. */
        const oficial = alineacionOficial();
        if (oficial && oficial.date && oficial.date > fuera.savedAt) return;

        state.xi = { type: fuera.type || '4-4-2', slots: fuera.slots, savedAt: fuera.savedAt };
        ensureXi();          // quita a los que ya no estén en tu plantilla
        persistXi();
        renderLineup();
      })
      .catch(function () { /* sin almacén se sigue con la de este navegador */ });
  }

  function loadXi() {
    try {
      const raw = localStorage.getItem(XI_KEY);
      const data = raw ? JSON.parse(raw) : null;
      if (data && data.slots) {
        state.xi = { type: data.type || '4-4-2', slots: data.slots, savedAt: data.savedAt || null };
      }
    } catch (error) { /* se empieza con la de Biwenger */ }
  }

  /**
   * Tu alineación tal y como la tienes puesta.
   *
   * `/user?fields=lineup` manda un sistema que no siempre es el bueno: cuenta a
   * cada futbolista por su puesto de ficha, así que un 4-6-0 con un delantero
   * jugando de medio lo devuelve como 4-5-1. La clasificación de la jornada sí
   * trae el sistema real y el once ya colocado por líneas, así que manda esa
   * cuando está.
   */
  function alineacionOficial() {
    const actual = state.lineup;
    const round = state.round;
    const jornada = round && round.id != null ? state.jornadas.datos[round.id] : null;
    const mia = jornada && state.me && (jornada.standings || []).filter(function (fila) {
      return String(fila.id) === String(state.me.id);
    })[0];

    /* Manda la que tienes puesta ahora en Biwenger: la de la jornada es el
       registro de lo que alineaste ese día y puede tener a gente ya vendida. */
    if (!actual || !(actual.players || []).length) {
      return mia && mia.type && (mia.xi || []).length === 11
        ? { type: mia.type, players: mia.xi, date: null }
        : actual;
    }

    /* De la jornada solo se aprovecha el sistema, y solo si son los mismos
       once: «/user» lo calcula por el puesto de ficha y a veces se equivoca
       (un 4-6-0 con un delantero de medio se lo devuelve como 4-5-1). */
    let type = actual.type;
    if (mia && mia.type && (mia.xi || []).length === (actual.players || []).length) {
      const suyos = (mia.xi || []).map(function (p) { return String(p.id); }).sort().join(',');
      const mios = (actual.players || []).map(function (p) { return String(p.id); }).sort().join(',');
      if (suyos === mios) type = mia.type;
    }

    return { type: type, players: actual.players, date: actual.date || null };
  }

  function ensureXi() {
    /* Si en Biwenger la has cambiado después de lo que hay guardado aquí, manda
       Biwenger: es la de verdad, y además ya no tiene a los que vendiste. */
    const oficial = alineacionOficial();
    if (state.xi && oficial && oficial.date && state.xi.savedAt && oficial.date > state.xi.savedAt) {
      state.xi = null;
    }

    /* Lo guardado manda, pero se limpian los que ya no estén en la plantilla
       (vendidos desde la última vez). */
    /* Un once guardado sin nadie no sirve de nada y además tapa el de Biwenger:
       si allí hay alineación, se vuelve a construir con ella. */
    if (state.xi && Object.keys(state.xi.slots || {}).length === 0) {
      const hay = alineacionOficial();
      if (hay && (hay.players || []).length) state.xi = null;
    }

    if (state.xi) {
      const squad = mySquad();
      if (squad.length) {
        const tengo = {};
        squad.forEach(function (player) { tengo[player.id] = true; });
        Object.keys(state.xi.slots).forEach(function (key) {
          if (!tengo[state.xi.slots[key]]) delete state.xi.slots[key];
        });
      }
      return;
    }
    const lineup = alineacionOficial();
    const type = (lineup && lineup.type) || '4-4-2';
    const slots = {};

    if (lineup && lineup.players) {
      /* Biwenger manda el once en orden —portero, defensas, medios y
         delanteros— según el sistema puesto, y el puesto de ficha de cada uno
         no vale: Berenguer es delantero de ficha y juega de medio, así que
         repartiendo por ficha se quedaba fuera del 4-6-0. */
      const lines = formationLines(type);
      const huecos = [[1, 1], [2, lines[2]], [3, lines[3]], [4, lines[4]]];
      let indice = 0;

      huecos.forEach(function (par) {
        const pos = par[0];
        for (let i = 0; i < par[1] && indice < lineup.players.length; i++) {
          slots[pos + '-' + i] = String(lineup.players[indice].id);
          indice += 1;
        }
      });
    }
    /* Se sella con la fecha en que la guardaste en Biwenger: así, si allí la
       has tocado después, gana sobre la del otro aparato. */
    state.xi = { type: type, slots: slots, savedAt: (lineup && lineup.date) || null };
    persistXi();
  }

  function playerById(id) {
    const found = mySquad().filter(function (player) { return player.id === String(id); })[0];
    if (found) return found;
    const inLineup = ((state.lineup && state.lineup.players) || [])
      .filter(function (player) { return player.id === String(id); })[0];
    return inLineup || null;
  }

  /** Posición de un jugador según su plantilla o su ficha de alineación. */
  function playerPosition(id) {
    const inSquad = playerById(id);
    if (inSquad && inSquad.position) return inSquad.position;
    const inLineup = ((state.lineup && state.lineup.players) || [])
      .filter(function (player) { return player.id === String(id); })[0];
    return inLineup ? inLineup.position : null;
  }

  /* Hay jugadores que valen para dos demarcaciones (Djené de defensa o medio,
     Pere Milla de delantero o medio): Biwenger las guarda en altPositions. */
  function playsAs(id, position) {
    const player = playerById(id);
    const main = playerPosition(id);
    if (main === position) return true;
    const alt = (player && player.altPositions) || [];
    return alt.indexOf(position) !== -1;
  }

  /**
   * La foto de un futbolista.
   *
   * Biwenger publica una segunda foto, más trabajada, para un puñado de
   * destacados (unos noventa de los quinientos y pico): la manda en `iconHero`
   * y es la que enseña en su once ideal. Si ese futbolista tiene la suya, se
   * usa; el resto se quedan con la de siempre.
   */
  function fotoDe(id) {
    const clave = String(id);
    return 'https://cdn.biwenger.com/i/p/' +
      (state.heroes && state.heroes[clave] ? 'hero/' : '') +
      encodeURIComponent(clave) + '.png';
  }

  /** Foto de un futbolista como fondo; `extra` son clases del sitio donde va. */
  function faceOf(id, extra) {
    return '<span class="pic-player ' + extra + '" style="background-image:url(\'' +
      fotoDe(id) + '\')"></span>';
  }

  /* Lesionado, sancionado o en duda: un circulito blanco pegado al borde
     izquierdo de la foto, por delante de ella. */
  const STATUS_MARKS = {
    ok:        { icon: '✓', label: 'Disponible', cls: 'mark--ok' },
    injured:   { icon: '✚', label: 'Lesionado',  cls: 'mark--injured' },
    sanctioned:{ icon: '▮', label: 'Sancionado', cls: 'mark--sanctioned' },
    doubt:     { icon: '?', label: 'Duda',       cls: 'mark--doubt' },
    discarded: { icon: '✕', label: 'Descartado', cls: 'mark--out' }
  };

  /* Amarillas de cada futbolista, para avisar de quién está a una de sanción.
     Biwenger no lo manda como estado: sale del recuento de la temporada. */
  const amarillasDe = {};

  /**
   * El parte de Biwenger de un lesionado o sancionado, para la ficha.
   *
   * Él lo manda en `statusInfo` («Lesión en el bíceps femoral. Retorno
   * estimado: mediados de enero», «Roja directa»...), que es lo que de verdad
   * dice si contar con él o no. Puede venir de la plantilla, de la lista de
   * futbolistas o de sus estadísticas: se coge de donde esté.
   */
  function parteMedico(id) {
    const clave = String(id);
    const busca = function (lista) {
      return (lista || []).filter(function (j) { return j && String(j.id) === clave; })[0];
    };

    const suyas = state.estadisticas && state.estadisticas[clave];
    const fuentes = [
      suyas === 'pidiendo' ? null : suyas,
      busca(state.jugadores),
      busca(mySquad())
    ];
    (squadList() || []).forEach(function (plantilla) {
      fuentes.push(busca(plantilla.players));
    });

    let estado = null;
    let parte = null;
    fuentes.forEach(function (fuente) {
      if (!fuente) return;
      if (!estado && fuente.status && fuente.status !== 'ok') estado = fuente.status;
      if (!parte && fuente.statusInfo) parte = fuente.statusInfo;
    });

    if (!estado && !parte) return '';
    const marca = STATUS_MARKS[estado] || null;
    const titulo = marca ? marca.label : 'No disponible';

    return '<p class="ficha__parte">' +
      (marca ? '<span class="ficha__parte-icono" aria-hidden="true">' + marca.icon + '</span>' : '') +
      '<strong>' + escapeHtml(titulo) + '</strong>' +
      (parte ? ' · ' + escapeHtml(parte) : '') +
    '</p>';
  }

  function aUnaDeSancion(player) {
    if (!player || player.id == null) return false;
    const amarillas = amarillasDe[String(player.id)] || 0;
    /* En la liga se cumple ciclo a las cinco: con cuatro, la siguiente sanciona. */
    return amarillas > 0 && amarillas % 5 === 4;
  }

  function statusMark(player, extra) {
    /* El visto de «disponible» solo se pinta donde se pide expresamente
       (la columna Estado), no encima de cada foto. */
    if (player && player.status === 'ok' && aUnaDeSancion(player)) {
      return '<span class="mark mark--amarillas ' + (extra || '') + '"' +
        ' title="Cuatro amarillas: a una de sanción"' +
        ' aria-label="Cuatro amarillas">' + '</span>';
    }

    const mark = player && player.status !== 'ok' && STATUS_MARKS[player.status];
    if (!mark) return '';
    return '<span class="mark ' + mark.cls + ' ' + (extra || '') + '" title="' + mark.label + '"' +
      ' aria-label="' + mark.label + '">' + mark.icon + '</span>';
  }

  /** Celda de estado: siempre dice algo, también cuando está sano. */
  function statusCell(player) {
    if (player && (player.status || 'ok') === 'ok' && aUnaDeSancion(player)) {
      return '<span class="mark mark--amarillas mark--cell"' +
        ' title="Cuatro amarillas: a una de sanción"></span>';
    }
    const mark = STATUS_MARKS[(player && player.status) || 'ok'] || STATUS_MARKS.ok;
    return '<span class="mark ' + mark.cls + ' mark--cell" title="' + mark.label + '"' +
      ' aria-label="' + mark.label + '">' + mark.icon + '</span>';
  }

  /** ¿Alguno de mis titulares llega tocado a la jornada? */
  function lineupAlerts() {
    if (!state.xi) return [];
    return Object.keys(state.xi.slots).map(function (key) {
      return playerById(state.xi.slots[key]);
    }).filter(function (player) {
      return player && STATUS_MARKS[player.status] && player.status !== 'discarded';
    });
  }

  /* El escudo del Madrid que sirve Biwenger lleva la franja azul; aquí va con
     la morada, recoloreada sobre el propio escudo y empotrada para no depender
     de ningún servidor de fuera. */
  const CREST_OVERRIDES = {
    15: 'data:image/png;base64,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'
  };

  function crestUrl(team) {
    return CREST_OVERRIDES[team] || ('https://cdn.biwenger.com/i/t/' + encodeURIComponent(team) + '.png');
  }

  /** Puntos del futbolista, en su círculo abajo a la izquierda de la foto. */
  function pointsBadge(player, extra) {
    if (!player || player.points == null) return '';
    return '<span class="pts ' + (extra || '') + '" title="' + player.points +
      (player.points === 1 ? ' punto' : ' puntos') + ' esta temporada">' + player.points + '</span>';
  }

  /** Escudo del club del futbolista. `extra` decide si va como marca de agua. */
  function crestOf(player, extra) {
    if (!player || player.team == null) return '';
    return '<span class="crest ' + extra + '" aria-hidden="true"' +
      (player.teamName ? ' title="' + escapeHtml(player.teamName) + '"' : '') +
      ' style="background-image:url(\'' + crestUrl(player.team) + '\')"></span>';
  }

  /* Quién puede entrar en ese hueco: solo los que juegan en esa demarcación
     —contando la posición alternativa— y no ocupan ya un sitio de la misma
     línea. Los polivalentes alineados en otra línea sí valen: un DEF/MED
     puesto atrás puede subir al centro. */
  function slotCandidates(position) {
    const chosen = {};
    Object.keys(state.xi.slots).forEach(function (slot) { chosen[state.xi.slots[slot]] = slot; });

    return mySquad().filter(function (candidate) {
      if (!playsAs(candidate.id, position)) return false;
      const slot = chosen[candidate.id];
      if (!slot) return true;
      return Number(slot.split('-')[0]) !== position;
    }).map(function (candidate) {
      const main = playerPosition(candidate.id);
      const alt = (candidate.altPositions || []).length
        ? '/' + candidate.altPositions.map(function (p) { return POSITION_NAMES[p]; }).join('/')
        : '';
      const slot = chosen[candidate.id];
      return {
        id: candidate.id,
        name: candidate.name,
        status: candidate.status || null,
        role: (main ? POSITION_NAMES[main] + alt : ''),
        moving: slot ? 'ahora en ' + POSITION_NAMES[Number(slot.split('-')[0])] : ''
      };
    });
  }

  function pitchSlot(key, position) {
    const id = state.xi.slots[key];
    const player = id ? playerById(id) : null;
    const face = player
      ? faceOf(player.id, 'pitch__face')
      : '<span class="pic-player pitch__face pitch__face--empty"></span>';

    return '<div class="pitch__slot" data-hueco="' + key + '" data-puesto="' + position + '"' +
      (id ? ' data-lleva="' + escapeHtml(String(id)) + '"' : '') + '>' +
      crestOf(player, 'crest--ghost') +
      '<span class="face-box">' + face +
        chapaDePuesto(player && player.position, 'puesto--esquina', otrosPuestosDe(player)) +
        statusMark(player, 'mark--esquina') + pointsBadge(player, 'pts--esquina') +
      '</span>' +
      '<span class="pitch__name">' + (player ? escapeHtml(player.name) : '—') + '</span>' +
      '<button type="button" class="pitch__pick" data-slot="' + key + '" data-position="' + position + '"' +
        ' aria-label="Cambiar el ' + POSITION_NAMES[position] +
        (player ? ': ahora ' + escapeHtml(player.name) : '') + '"></button>' +
    '</div>';
  }

  /* Cuadro del sistema: un dibujo de puntos por línea, para reconocerlo de un
     vistazo sin leer los números. */
  function formationCard(type) {
    const lines = formationLines(type);
    const dots = [lines[4], lines[3], lines[2], 1].map(function (count) {
      let row = '';
      for (let i = 0; i < count; i++) row += '<i></i>';
      return '<span class="formation__line">' + row + '</span>';
    }).join('');
    return '<button type="button" class="picker__player formation' +
      (type === state.xi.type ? ' is-current' : '') + '" data-formation="' + type + '"' +
      (type === state.xi.type ? ' aria-pressed="true"' : '') + '>' +
      '<span class="formation__pitch">' + dots + '</span>' +
      '<span class="picker__name">' + type + '</span>' +
    '</button>';
  }

  /* Todo se elige en el mismo panel sobre el campo: ni listas ni desplegables. */
  function renderPicker() {
    const box = $('lineup-picker');
    const open = state.picker;
    if (!open || !state.xi) { box.hidden = true; box.innerHTML = ''; return; }

    if (open.kind === 'formation') {
      box.hidden = false;
      box.innerHTML =
        '<div class="picker__backdrop" data-picker-close></div>' +
        '<div class="picker__card" role="dialog" aria-modal="true" aria-label="Elegir sistema">' +
          '<div class="picker__head"><strong>Sistema</strong>' +
            '<button type="button" class="btn btn--ghost btn--close" data-picker-close' +
              ' title="Cerrar" aria-label="Cerrar">✕</button>' +
          '</div>' +
          '<div class="picker__grid">' + FORMATIONS.map(formationCard).join('') + '</div>' +
        '</div>';
      return;
    }

    /* Los de esta misma línea —incluido quien ocupa el hueco— no se listan:
       ahí no hay cambio que hacer. */
    const cards = slotCandidates(open.position).map(function (candidate) {
      return '<button type="button" class="picker__player"' +
        ' data-pick="' + escapeHtml(String(candidate.id)) + '">' +
        faceOf(candidate.id, 'picker__face') +
        statusMark(candidate, 'mark--picker') +
        '<span class="picker__name">' + escapeHtml(candidate.name) + '</span>' +
        '<span class="picker__meta">' + escapeHtml(candidate.role) +
          (candidate.moving ? ' · ' + escapeHtml(candidate.moving) : '') + '</span>' +
      '</button>';
    }).join('');

    const empty = '<button type="button" class="picker__player picker__player--empty" data-pick="">' +
      '<span class="pic-player picker__face picker__face--empty"></span>' +
      '<span class="picker__name">Dejar vacío</span>' +
    '</button>';

    box.hidden = false;
    box.innerHTML =
      '<div class="picker__backdrop" data-picker-close></div>' +
      '<div class="picker__card" role="dialog" aria-modal="true" aria-label="Elegir ' +
        POSITION_NAMES[open.position] + '">' +
        '<div class="picker__head">' +
          '<strong>' + POSITION_NAMES[open.position] + ' · elige quién juega</strong>' +
          '<button type="button" class="btn btn--ghost btn--close" data-picker-close' +
              ' title="Cerrar" aria-label="Cerrar">✕</button>' +
        '</div>' +
        /* Vaciar el hueco se ofrece siempre, también en la portería: si solo
           tienes un portero no había nadie que listar y desaparecía la opción. */
        '<div class="picker__grid">' + cards + empty + '</div>' +
        (cards ? '' : '<p class="muted picker__nota">No hay nadie más para esta posición.</p>') +
      '</div>';
  }

  /** Cambia de sistema y recoloca a los que quepan en la nueva distribución. */
  function applyFormation(type) {
    ensureXi();
    state.xi.type = type;

    const lines = formationLines(type);
    const kept = {};
    const used = { 1: 0, 2: 0, 3: 0, 4: 0 };
    Object.keys(state.xi.slots).sort().forEach(function (key) {
      const id = state.xi.slots[key];
      if (!id) return;
      const pos = Number(key.split('-')[0]);
      const limit = pos === 1 ? 1 : lines[pos];
      if (used[pos] < limit) { kept[pos + '-' + used[pos]] = id; used[pos] += 1; }
    });
    state.xi.slots = kept;

    state.picker = null;
    guardarXiMia();
    renderLineup();
    renderPicker();
  }

  /* ---------- Arrastrar y soltar en el campo ----------
     Con eventos de puntero, no con el arrastre de HTML5: ese no existe en el
     móvil, y aquí hace falta que funcione igual con el dedo y con el ratón.

     Se puede llevar un futbolista de un hueco a otro (se cambian entre ellos),
     del banquillo al campo (entra y sale el que estuviera) y del campo al
     banquillo (deja el hueco libre). Un toque sin mover sigue abriendo el
     panel de siempre, que para elegir de una lista va mejor. */
  let arrastre = null;
  /* El navegador manda un clic al soltar; con esto se descarta ese. */
  let huboArrastre = false;

  /** ¿Puede este futbolista jugar en ese hueco? La misma regla del panel. */
  function cabeEn(id, puesto) {
    return id != null && playsAs(id, Number(puesto));
  }

  function limpiarArrastre() {
    if (arrastre && arrastre.fantasma) arrastre.fantasma.remove();
    Array.prototype.forEach.call(
      document.querySelectorAll('.pitch__slot--vale, .pitch__slot--encima, .bench--encima, .pitch__slot--origen'),
      function (el) {
        el.classList.remove('pitch__slot--vale', 'pitch__slot--encima',
          'bench--encima', 'pitch__slot--origen');
      });
    arrastre = null;
  }

  /** Marca los huecos donde ese futbolista puede caer. */
  function marcarDestinos(id) {
    Array.prototype.forEach.call(document.querySelectorAll('#pitch [data-hueco]'), function (hueco) {
      if (cabeEn(id, hueco.getAttribute('data-puesto'))) hueco.classList.add('pitch__slot--vale');
    });
  }

  function empezarArrastre(evento, origen) {
    const id = origen.getAttribute('data-lleva');
    if (!id) return;

    const rect = origen.getBoundingClientRect();
    const fantasma = origen.cloneNode(true);
    fantasma.className = 'arrastrando';
    fantasma.style.width = rect.width + 'px';
    document.body.appendChild(fantasma);

    arrastre = {
      id: id,
      desdeHueco: origen.getAttribute('data-hueco'),   // null si viene del banquillo
      fantasma: fantasma,
      dx: evento.clientX - rect.left,
      dy: evento.clientY - rect.top
    };
    origen.classList.add('pitch__slot--origen');
    huboArrastre = true;
    marcarDestinos(id);
    moverFantasma(evento);
  }

  function moverFantasma(evento) {
    if (!arrastre) return;
    arrastre.fantasma.style.left = (evento.clientX - arrastre.dx) + 'px';
    arrastre.fantasma.style.top = (evento.clientY - arrastre.dy) + 'px';
  }

  /** Qué hay debajo del dedo: un hueco del campo o el banquillo. */
  function destinoBajo(evento) {
    arrastre.fantasma.style.visibility = 'hidden';
    const debajo = document.elementFromPoint(evento.clientX, evento.clientY);
    arrastre.fantasma.style.visibility = '';
    if (!debajo) return null;
    const hueco = debajo.closest('#pitch [data-hueco]');
    if (hueco) return { tipo: 'campo', el: hueco };
    if (debajo.closest('#bench')) return { tipo: 'banquillo', el: debajo.closest('#bench') };
    return null;
  }

  function soltar(evento) {
    if (!arrastre) return;
    const destino = destinoBajo(evento);
    const id = arrastre.id;
    const desde = arrastre.desdeHueco;

    if (!destino) { limpiarArrastre(); return; }

    if (destino.tipo === 'banquillo') {
      /* Al banquillo: solo tiene sentido si venía del campo. */
      if (desde) { delete state.xi.slots[desde]; guardarXiMia(); renderLineup(); }
      limpiarArrastre();
      return;
    }

    const hueco = destino.el.getAttribute('data-hueco');
    const puesto = destino.el.getAttribute('data-puesto');
    if (!cabeEn(id, puesto)) { limpiarArrastre(); return; }   // ahí no juega

    const habia = state.xi.slots[hueco] || null;

    if (desde) {
      /* De un hueco a otro: se cambian, pero solo si el otro también puede
         jugar donde estaba este; si no, se quedaría en un sitio que no es. */
      const puestoDeOrigen = desde.split('-')[0];
      if (habia && !cabeEn(habia, puestoDeOrigen)) { limpiarArrastre(); return; }
      if (habia) state.xi.slots[desde] = habia;
      else delete state.xi.slots[desde];
    } else if (habia) {
      /* Del banquillo: el que estaba se va al banquillo. */
      delete state.xi.slots[hueco];
    }

    state.xi.slots[hueco] = id;
    guardarXiMia();
    renderLineup();
    limpiarArrastre();
  }

  function engancharArrastre() {
    const campo = $('pitch');
    const banquillo = $('bench');
    if (!campo || !banquillo) return;

    [campo, banquillo].forEach(function (zona) {
      zona.addEventListener('pointerdown', function (evento) {
        if (evento.button != null && evento.button !== 0) return;   // solo el botón principal
        const origen = evento.target.closest('[data-lleva]');
        if (!origen || !state.xi) return;
        /* Todavía no se arrastra: se apunta por dónde empezó y se decide en
           cuanto se mueva. Así un toque limpio sigue abriendo el panel. */
        arrastre = null;
        zona.__pendiente = {
          origen: origen, x: evento.clientX, y: evento.clientY,
          pointerId: evento.pointerId
        };
      });
    });

    /* En todo el documento: si se sale de la zona mientras arrastra, se sigue. */
    document.addEventListener('pointermove', function (evento) {
      if (arrastre) {
        evento.preventDefault();
        moverFantasma(evento);
        const destino = destinoBajo(evento);
        Array.prototype.forEach.call(
          document.querySelectorAll('.pitch__slot--encima, .bench--encima'),
          function (el) { el.classList.remove('pitch__slot--encima', 'bench--encima'); });
        if (destino && destino.tipo === 'campo' &&
            cabeEn(arrastre.id, destino.el.getAttribute('data-puesto'))) {
          destino.el.classList.add('pitch__slot--encima');
        } else if (destino && destino.tipo === 'banquillo' && arrastre.desdeHueco) {
          destino.el.classList.add('bench--encima');
        }
        return;
      }

      [$('pitch'), $('bench')].forEach(function (zona) {
        const pend = zona && zona.__pendiente;
        if (!pend || pend.pointerId !== evento.pointerId) return;
        /* Ocho píxeles: por debajo de eso es un toque, no un arrastre. */
        if (Math.abs(evento.clientX - pend.x) + Math.abs(evento.clientY - pend.y) < 8) return;
        zona.__pendiente = null;
        empezarArrastre(evento, pend.origen);
      });
    }, { passive: false });

    const acabar = function (evento) {
      [$('pitch'), $('bench')].forEach(function (zona) { if (zona) zona.__pendiente = null; });
      if (arrastre) soltar(evento);
    };
    document.addEventListener('pointerup', acabar);
    document.addEventListener('pointercancel', function () {
      [$('pitch'), $('bench')].forEach(function (zona) { if (zona) zona.__pendiente = null; });
      limpiarArrastre();
    });
  }

  function renderLineup() {
    const section = $('lineup-panel');
    if (!state.me || !state.lineup) { section.hidden = true; return; }

    ensureSquads();
    ensureXi();
    section.hidden = false;

    const lines = formationLines(state.xi.type);
    const rows = [
      { position: 4, count: lines[4] },
      { position: 3, count: lines[3] },
      { position: 2, count: lines[2] },
      { position: 1, count: 1 }
    ];

    $('lineup-formation').textContent = state.xi.type;

    $('pitch').innerHTML =
      '<span class="pitch__area pitch__area--top" aria-hidden="true"></span>' +
      '<span class="pitch__area pitch__area--bottom" aria-hidden="true"></span>' +
      '<span class="pitch__spot" aria-hidden="true"></span>' +
      rows.map(function (row) {
        const slots = [];
        for (let i = 0; i < row.count; i++) slots.push(pitchSlot(row.position + '-' + i, row.position));
        return '<div class="pitch__line">' + slots.join('') + '</div>';
      }).join('');

    // Suplentes: los de la plantilla que no estén en el once.
    const inXi = {};
    Object.keys(state.xi.slots).forEach(function (key) { inXi[state.xi.slots[key]] = true; });
    const bench = mySquad().filter(function (player) { return !inXi[player.id]; });

    $('bench').innerHTML = bench.length === 0
      ? '<p class="muted">' + (state.squads && state.squads.status === 'loading'
          ? 'Cargando la plantilla…' : 'Sin suplentes.') + '</p>'
      : bench.map(function (player) {
          return '<div class="bench__player" data-lleva="' + escapeHtml(String(player.id)) + '">' +
            crestOf(player, 'crest--ghost') +
            caraConChapas(player, 'bench__face') +
            '<span class="bench__name">' + escapeHtml(player.name) + '</span>' +
          '</div>';
        }).join('');

    const titulares = Object.keys(state.xi.slots).filter(function (key) { return state.xi.slots[key]; }).length;
    const valor = Object.keys(state.xi.slots).reduce(function (sum, key) {
      const player = playerById(state.xi.slots[key]);
      return sum + ((player && player.marketValue) || 0);
    }, 0);
    $('lineup-count').textContent = titulares + ' de 11 titulares · ' + money(valor) + ' de valor en el campo';

    pintarAvisosDeAlineacion(titulares);
  }

  /**
   * Los dos avisos de antes de la jornada: que no llegues en negativo y que no
   * te dejes huecos en el once. Solo se pintan cuando hay algo que arreglar.
   */
  /**
   * Cuándo empieza la jornada de verdad: el primer partido, no el siguiente
   * que quede por jugar. Es la hora que cuenta para alinear.
   */
  function arranqueDeJornada(round) {
    const horas = (round.matches || [])
      .map(function (partido) { return Date.parse(partido.start); })
      .filter(function (t) { return !isNaN(t); });
    if (horas.length) return new Date(Math.min.apply(null, horas)).toISOString();
    return round.start || null;
  }

  /** «5h 12m» en negrita, solo cuando la jornada está encima. */
  function rotuloCuentaAtras(cerca, round) {
    if (!cerca) return '';
    const queda = timeLeft(arranqueDeJornada(round));
    return queda ? ' <strong>' + escapeHtml(queda.text) + '</strong>' : '';
  }

  function pintarAvisosDeAlineacion(titulares) {
    const caja = $('lineup-avisos');
    if (!caja) return;

    const avisos = [];
    const saldo = state.me && state.me.balance != null ? state.me.balance : null;
    const round = state.round;
    const arranque = round ? arranqueDeJornada(round) : null;
    const empieza = arranque ? Date.parse(arranque) : null;
    const faltan = empieza ? empieza - Date.now() : null;
    /* La cuenta atrás aparece en las últimas doce horas, que es cuando corre
       prisa; antes basta con el aviso. */
    const cerca = faltan != null && faltan > 0 && faltan <= 12 * 3600e3;

    if (saldo != null && saldo < 0) {
      /* El saldo ya se ve arriba: aquí solo el aviso. */
      avisos.push('Tienes que estar en positivo al comienzo de la jornada para puntuar.' +
        rotuloCuentaAtras(cerca, round));
    }

    if (titulares < 11) {
      const huecos = 11 - titulares;
      avisos.push('Te ' + (huecos === 1 ? 'falta 1 jugador' : 'faltan ' + huecos + ' jugadores') +
        ' en el once.' + rotuloCuentaAtras(cerca, round));
    }

    caja.hidden = avisos.length === 0;
    caja.innerHTML = avisos.map(function (texto) {
      return '<p class="aviso aviso--rojo"><span class="aviso__icono" aria-hidden="true">\u26a0</span>' +
        '<span>' + texto + '</span></p>';
    }).join('');
  }

  /* ---------- Mercado ---------- */

  function ensureMarket(forzar) {
    const config = loadSyncConfig();
    if (!config.url || !config.key) return;
    if (state.marketState === 'cargando') return;
    if (state.market && !forzar) return;

    /* Lo de la última vez, mientras llega lo de ahora. */
    if (!state.market) {
      const guardado = cacheLeer('mercado');
      if (guardado && guardado.sales) {
        state.market = guardado.sales;
        state.marketViejo = false;
      }
    }
    state.marketState = 'cargando';
    renderMarket();

    fetch(config.url.replace(/\/+$/, '') + '/?key=' + encodeURIComponent(config.key) + '&mercado=1',
      { headers: { 'accept': 'application/json' } })
      .then(function (response) { return response.json(); })
      .then(function (payload) {
        if (payload.error) throw new Error(payload.error);
        state.market = payload.sales || [];
        recordarPosiciones(state.market.map(function (v) {
          return { id: v.playerId, position: v.position, altPositions: v.altPositions };
        }));
        state.marketState = '';
        /* Puede venir del respaldo, si Biwenger estaba de tregua: se enseña
           igual, pero diciendo que no es de ahora mismo. */
        state.marketError = payload.stale ? (payload.warning || 'Datos de hace un rato.') : '';
        state.marketViejo = !!payload.stale;
        if (!payload.stale) {
          state.marketIntentos = 0;
          cacheGuardar('mercado', payload);
        }
        renderMarket();
        /* Si es viejo, se vuelve a pedir en cuanto pase la tregua. */
        if (payload.stale) reintentarMercado(payload.warning);
        ensurePriceSeries(state.market.map(function (v) { return v.playerId; }), renderMarket);
      })
      .catch(function (error) {
        state.marketState = 'error';
        state.marketViejo = false;
        /* Se guarda el motivo: casi siempre es que Biwenger nos ha limitado un
           rato, y decirlo (con lo que queda) evita pensar que está roto. */
        state.marketError = String((error && error.message) || '');
        renderMarket();
        if (/limitado/i.test(state.marketError)) reintentarMercado(state.marketError);
      });
  }

  /**
   * Vuelve a pedir el mercado cuando Biwenger nos tiene de tregua.
   *
   * Con cuentagotas a propósito: insistir es lo que alarga el bloqueo. Se
   * espera lo que él diga y un poco más, se va doblando la espera en cada
   * intento y a los tres se deja de insistir; a partir de ahí, la próxima
   * sincronización lo intentará por su cuenta.
   */
  function reintentarMercado(motivo) {
    if (state.marketReintento) return;              // ya hay uno esperando
    if (state.marketIntentos >= 3) return;          // se deja de insistir

    const dicho = String(motivo || '').match(/(\d+)\s*s/);
    const base = dicho ? Number(dicho[1]) + 5 : 95;
    const segundos = Math.min(600, base * Math.pow(2, state.marketIntentos));
    state.marketIntentos += 1;

    state.marketReintento = setTimeout(function () {
      state.marketReintento = null;
      ensureMarket(true);
    }, segundos * 1000);
  }

  const MARKET_VALUES = {
    player: function (v) { return (v.player || '').toLowerCase(); },
    seller: function (v) { return (v.free ? '0' : '1') + (v.seller || '').toLowerCase(); },
    status: function (v) {
      const orden = { injured: 0, sanctioned: 1, doubt: 2, discarded: 3 };
      return orden[v.status] != null ? orden[v.status] : 9;
    },
    points: function (v) { return v.points == null ? -Infinity : v.points; },
    marketValue: function (v) { return v.marketValue || 0; },
    price: function (v) { return v.price || 0; },
    until: function (v) { return v.until ? Date.parse(v.until) : Infinity; }
  };

  /** Libres primero y, dentro de cada grupo, por valor. */
  function sortMarket(lista) {
    const sort = state.sort.market;
    /* Orden natural: primero los libres y luego cada mánager con los suyos
       juntos, de más caro a más barato dentro de cada grupo. */
    if (!sort.key) {
      return lista.slice().sort(function (a, b) {
        if (a.free !== b.free) return a.free ? -1 : 1;
        if (!a.free) {
          const quien = (a.seller || '').localeCompare(b.seller || '');
          if (quien) return quien;
        }
        return (b.marketValue || 0) - (a.marketValue || 0);
      });
    }
    const valor = MARKET_VALUES[sort.key] || MARKET_VALUES.marketValue;
    return lista.slice().sort(function (a, b) {
      const x = valor(a);
      const y = valor(b);
      if (x === y) return (a.player || '').localeCompare(b.player || '');
      if (typeof x === 'string') return sort.dir * x.localeCompare(y);
      return sort.dir * (x < y ? -1 : 1);
    });
  }

  /* Las tres vueltas de la p\u00edldora del mercado, en orden. */
  const FILTROS_MERCADO = [
    { clave: 'todos',    rotulo: 'Todos' },
    { clave: 'libres',   rotulo: 'Libres' },
    { clave: 'vendidos', rotulo: 'No libres' }
  ];

  function filtrarMercado(lista) {
    if (state.marketFiltro === 'libres') {
      return lista.filter(function (venta) { return venta.free; });
    }
    if (state.marketFiltro === 'vendidos') {
      return lista.filter(function (venta) { return !venta.free; });
    }
    return lista;
  }

  function pintarFiltroMercado() {
    const boton = $('market-filtro');
    if (!boton) return;
    const actual = FILTROS_MERCADO.filter(function (f) {
      return f.clave === state.marketFiltro;
    })[0] || FILTROS_MERCADO[0];
    /* Solo cambia el r\u00f3tulo: el color se queda siempre igual. */
    boton.textContent = actual.rotulo;
  }

  function renderMarket() {
    const cuerpo = $('market-body');
    if (!cuerpo) return;

    pintarFiltroMercado();

    if (!state.market) {
      cuerpo.innerHTML = '<tr><td colspan="8" class="muted">' +
        (state.marketState === 'error'
          /* Con el motivo de Biwenger, que suele ser su tregua de un rato. */
          ? escapeHtml(state.marketError || 'No se ha podido traer el mercado.') +
            (/limitado/i.test(state.marketError || '') ? ' Se vuelve a intentar solo.' : '')
          : 'Cargando el mercado\u2026') +
        '</td></tr>';
      return;
    }
    if (state.market.length === 0) {
      cuerpo.innerHTML = '<tr><td colspan="8" class="muted">Ahora mismo no hay nadie en el mercado.</td></tr>';
      return;
    }

    const visibles = filtrarMercado(state.market);
    if (visibles.length === 0) {
      cuerpo.innerHTML = '<tr><td colspan="8" class="muted">' +
        (state.marketFiltro === 'libres'
          ? 'Ahora mismo no hay ning\u00fan futbolista libre.'
          : 'Ahora mismo no hay ninguno vendido por un m\u00e1nager.') +
        '</td></tr>';
      /* Aun sin filas, el resto de la cabecera se pinta igual. */
      pintarBotonOfertas();
      pintarCierreMercado();
      return;
    }

    cuerpo.innerHTML = sortMarket(visibles).map(function (venta) {
      const sube = venta.increment > 0;
      /* De lo que vendes tú la API no da el contador, pero las ofertas
         recibidas sí están: se cuentan de ahí. */
      return '<tr' + (venta.mine ? ' class="row-mine"' : '') + '>' +
        '<td data-label="Futbolista"><span class="with-crest">' +
          playerName({ playerId: venta.playerId, player: venta.player }) +
          crestOf(venta, 'crest--badge') + '</span></td>' +
        '<td data-label="Propietario">' + (venta.free
          ? '<span class="tag tag--free">Libre</span>'
          : '<span class="manager">' + avatar(venta.seller) +
            '<span class="manager__name">' + escapeHtml(venta.seller) + '</span></span>') + '</td>' +
        '<td class="estado-cell" data-label="Estado">' + statusCell(venta) + '</td>' +
        '<td class="num" data-label="Puntos">' + (venta.points == null ? '<span class="sub">\u2014</span>' : venta.points) + '</td>' +
        '<td class="num" data-label="Valor">' + money(venta.marketValue || 0) +
          (venta.increment ? ' <span class="delta ' + (sube ? 'delta--up' : 'delta--down') + '">' +
            (sube ? '\u25b2' : '\u25bc') + '</span>' : '') + '</td>' +
        '<td class="num" data-label="Precio"><strong>' + money(venta.price || 0) + '</strong></td>' +
        '<td class="spark-cell" data-label="Evolución">' +
          sparkline(ultimos(state.priceSeries[venta.playerId], 45), venta.playerId, venta.player) + '</td>' +
        '<td data-label="Queda">' + deadlineCell(venta.until) + '</td>' +
        /* Lo que vendes tú no se puja; en el resto, si ya has pujado, se ve por
           cuánto y el botón sirve para cambiarla. */
        '<td class="col-pujar">' + (venta.mine ? (
          /* Los tuyos no se pujan: se renuevan, se cambian o se retiran. */
          '<span class="acciones">' +
            '<button type="button" class="btn btn--sm btn--otra" data-renueva="' +
              escapeHtml(String(venta.playerId)) + '" title="Renovar la venta por ' +
              money(venta.price) + '">\u21bb</button>' +
            '<button type="button" class="btn btn--sm btn--otra" data-renovar="' +
              escapeHtml(String(venta.playerId)) + '" title="Cambiar el precio">\u270e</button>' +
            '<button type="button" class="btn btn--sm btn--no" data-quitar="' +
              escapeHtml(String(venta.playerId)) + '" title="Quitar del mercado">\u2715</button>' +
          '</span>'
        ) : (function () {
          const mia = miPujaPor(venta.playerId);
          return '<span class="acciones">' +
            (mia ? '<span class="pujado" title="Tu puja">' + money(mia.amount) + '</span>' : '') +
            '<button type="button" class="ambito ambito--pujar' + (mia ? ' ambito--pujado' : '') +
              '" data-pujar="' + escapeHtml(String(venta.playerId)) + '">' +
              (mia ? 'Cambiar' : 'Pujar') + '</button>' +
            /* Con puja hecha, al lado va el aspa para retirarla. */
            (mia ? '<button type="button" class="btn btn--sm btn--no" data-retirar="' +
              escapeHtml(mia.id) + '" title="Retirar la puja">✕</button>' : '') +
          '</span>';
        })()) + '</td>' +
      '</tr>';
    }).join('');

    /* La pastilla de ofertas vive en la cabecera del mercado. */
    pintarBotonOfertas();

    Array.prototype.forEach.call(document.querySelectorAll('[data-market-sort]'), function (th) {
      const key = th.getAttribute('data-market-sort');
      th.setAttribute('aria-sort', key !== state.sort.market.key ? 'none'
        : (state.sort.market.dir === 1 ? 'ascending' : 'descending'));
    });

    /* Los nombres largos de los duenos se encogen hasta caber enteros. */
    ajustarNombres();
    pintarCierreMercado();
  }

  /**
   * La cuenta atrás del cierre. El mercado se renueva cuando vencen los
   * jugadores libres, así que el más próximo de esos plazos es la hora.
   *
   * Se saca del mercado entero, nunca de lo que se esté viendo: filtrando por
   * «no libres» no queda ningún plazo y la cuenta atrás se habría borrado.
   */
  function pintarCierreMercado() {
    const nota = $('market-note');
    if (!nota) return;
    const cierre = (state.market || [])
      .filter(function (v) { return v.free && v.until; })
      .map(function (v) { return v.until; })
      .sort()[0] || null;
    nota.innerHTML = (cierre ? 'Se renueva en ' + deadlineCell(cierre, true) : '') +
      /* Cuando lo servido es el respaldo, se dice: si no, parecería de ahora. */
      (state.marketViejo
        ? (cierre ? ' · ' : '') + '<span class="stale">Biwenger no responde; esto es de hace un rato</span>'
        : '');
  }

  /* ---------- Operaciones de verdad en Biwenger ----------
     Todo lo de aquí escribe en tu cuenta: se manda al Worker, que es quien
     tiene el token, y nunca sin que lo confirmes en el diálogo. */

  function mandarOperacion(orden) {
    const config = loadSyncConfig();
    if (!config.url || !config.key) {
      return Promise.reject(new Error('Antes hay que conectar con el Worker.'));
    }
    return fetch(config.url.replace(/\/+$/, '') + '/?key=' + encodeURIComponent(config.key) + '&operacion=1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(orden)
    })
      .then(function (response) { return response.json(); })
      .then(function (payload) {
        if (payload.hecho) return payload;
        const fallo = new Error(payload.error || 'Biwenger no ha completado la operación.');
        /* El Worker cuenta qué intentó y qué le contestaron: se enseña debajo
           del error, que es lo que hace falta para saber por dónde falla. */
        fallo.intentos = payload.intentos || null;
        throw fallo;
      });
  }

  /** Ofertas que te han hecho y siguen esperando respuesta. */
  const ofertasRecibidas = () => state.offers.filter(function (o) { return o.direction === 'in'; });
  const pujasEnviadas = () => state.offers.filter(function (o) { return o.direction === 'out'; });

  function pintarBotonOfertas() {
    const boton = $('btn-ofertas');
    if (!boton) return;
    const recibidas = ofertasRecibidas().length;
    const enviadas = pujasEnviadas().length;
    boton.hidden = recibidas + enviadas === 0;
    boton.textContent = recibidas ? 'Ofertas \u00b7 ' + recibidas : 'Ofertas';
    boton.classList.toggle('ambito--avisa', recibidas > 0);
  }

  /* Qué venta tiene abierto el diálogo de puja, para poder repintarlo. */
  let opPujaAbierta = null;

  /* Cada apertura y cada cierre del diálogo cuenta como una pantalla distinta.
     Sirve para que una operación que tarda no reabra ni pise lo que estés
     mirando cuando termine: si el número ya no es el mismo, es que cerraste o
     abriste otra cosa entretanto, y entonces no se toca nada. */
  let opSesion = 0;

  function cerrarOpModal() {
    const caja = $('op-modal');
    caja.hidden = true;
    caja.innerHTML = '';
    opPendiente = null;
    opSesion++;
    /* La próxima puja empieza con las pujas plegadas otra vez. */
    opPujaAbierta = null;
  }

  function abrirOpModal(html) {
    const caja = $('op-modal');
    caja.innerHTML = '<div class="op-card">' + html + '</div>';
    caja.hidden = false;
    opSesion++;
  }

  function opAviso(texto, mal) {
    const hueco = document.querySelector('#op-modal .op-aviso');
    if (hueco) {
      hueco.innerHTML = '<span class="' + (mal ? 'money-neg' : 'money-pos') + '">' +
        escapeHtml(texto) + '</span>';
    }
  }

  const ventaDe = (id) => (state.market || []).filter(function (v) {
    return String(v.playerId) === String(id);
  })[0];

  /** La puja que ya le has hecho a ese futbolista, si la hay. */
  const miPujaPor = (id) => state.offers.filter(function (o) {
    return o.direction === 'out' && String(o.playerId) === String(id);
  })[0];

  /**
   * Lo que te queda de puja máxima. Las pujas que ya has enviado están
   * comprometidas: si ganas dos, pagas las dos, así que se descuentan. La del
   * futbolista que estás mirando no cuenta, porque cambiarla la sustituye.
   *
   * Las que tengas marcadas en el simulador ya las resta `simulation()`.
   */
  function topeDePuja(playerId) {
    /* Ojo: aquí NO vale `simulation()`. El simulador es un juguete para ver
       «qué pasaría si»; lo que se puede pujar de verdad sale del saldo y del
       valor de equipo que tienes ahora mismo en Biwenger. Marcar una venta en
       el simulador no te da dinero. */
    const mio = state.teams[myName()] || {};
    const saldo = state.me && state.me.balance != null ? state.me.balance
      : (mio.balance != null ? mio.balance : null);
    const valorEquipo = mio.value != null ? mio.value : (mio.teamValue != null ? mio.teamValue : null);

    if (saldo == null || valorEquipo == null) return { tope: null, comprometido: 0, saldo: saldo };

    const maximo = saldo + valorEquipo * TEAM_VALUE_SHARE;

    /* Las pujas ya enviadas están comprometidas: si te entran, las pagas. La
       del futbolista que estás mirando no cuenta, porque la sustituyes. */
    const comprometido = pujasEnviadas().reduce(function (suma, oferta) {
      if (playerId != null && String(oferta.playerId) === String(playerId)) return suma;
      return suma + oferta.amount;
    }, 0);

    return { tope: maximo - comprometido, comprometido: comprometido, saldo: saldo, maximo: maximo };
  }

  /**
   * La píldora «Ver pujas» del diálogo de puja, con lo que se sepa de verdad.
   *
   * Biwenger solo publica las pujas de lo que vendes tú: por lo que venden los
   * demás (o el propio mercado) no dice cuántas hay ni de cuánto, así que aquí
   * se dice eso en vez de inventar un número. La tuya sí se sabe siempre.
   */
  function pujasPorEsteJugador(venta) {
    /* De lo tuyo las pujas ya se saben enteras (son las ofertas recibidas); de
       lo de los demás hay que preguntárselo a Biwenger. */
    const recibidas = venta.mine
      ? ofertasRecibidas().filter(function (o) {
          return String(o.playerId) === String(venta.playerId);
        })
      : [];
    const contadas = state.pujasDe[String(venta.playerId)];

    const cuantas = venta.mine ? recibidas.length
      : (contadas && contadas.bids != null ? contadas.bids : null);

    /* Todo cabe en el propio botón: sin contar, invita; contando, avisa; y ya
       contado, el número pelado. Nada de listas ni de repetir tu puja, que ya
       está justo encima. */
    let rotulo = 'Ver pujas';
    if (contadas && contadas.cargando) rotulo = '…';
    else if (contadas && contadas.error) rotulo = 'No se ha podido';
    else if (cuantas != null) rotulo = cuantas === 1 ? '1 puja' : cuantas + ' pujas';

    /* Sin rótulo encima: el propio botón ya dice lo que es. */
    return '<div class="op-pujas">' +
      '<dd>' +
        '<button type="button" class="ambito ambito--rojo"' +
          ' data-op-pujas="' + escapeHtml(String(venta.playerId)) + '"' +
          (contadas && contadas.error ? ' title="' + escapeHtml(contadas.error) + '"' : '') + '>' +
          rotulo + '</button>' +
      '</dd>' +
    '</div>';
  }

  /* ---------- Claro y oscuro ----------
     Se cambia dejando pulsado el escudo de Inicio diez segundos, y se vuelve
     igual. Va escondido a propósito: es un atajo, no una opción del menú.
     Toda la web tira de las mismas variables de color, así que basta con poner
     la marca en el <html> para que cambie entera. */
  const TEMA_KEY = 'biwenger-calc-tema';
  const TEMA_SEGUNDOS = 10;
  let temaCambiado = false;      // para descartar el clic de después

  /** Un aviso corto abajo del todo, que se va solo. */
  function toast(texto) {
    let caja = document.getElementById('toast');
    if (!caja) {
      caja = document.createElement('div');
      caja.id = 'toast';
      caja.className = 'toast';
      document.body.appendChild(caja);
    }
    caja.textContent = texto;
    caja.classList.add('toast--visible');
    clearTimeout(toast._reloj);
    toast._reloj = setTimeout(function () {
      caja.classList.remove('toast--visible');
    }, 1800);
  }

  function aplicarTema(tema) {
    if (tema === 'claro' || tema === 'oscuro') {
      document.documentElement.setAttribute('data-tema', tema);
    } else {
      document.documentElement.removeAttribute('data-tema');
    }
  }

  /** Lo que se ve ahora: lo elegido a mano o, si no hay nada, lo del sistema. */
  function temaActual() {
    const puesto = document.documentElement.getAttribute('data-tema');
    if (puesto === 'claro' || puesto === 'oscuro') return puesto;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches
      ? 'claro' : 'oscuro';
  }

  function cargarTema() {
    let guardado = null;
    try { guardado = localStorage.getItem(TEMA_KEY); } catch (error) { /* sin memoria */ }
    aplicarTema(guardado);
  }

  function cambiarTema() {
    /* Se cambia al contrario de lo que estés viendo, mires con el sistema en
       claro o en oscuro. */
    const nuevo = temaActual() === 'claro' ? 'oscuro' : 'claro';
    aplicarTema(nuevo);
    try { localStorage.setItem(TEMA_KEY, nuevo); }
    catch (error) { /* sin memoria: dura lo que dure la sesión */ }
    toast(nuevo === 'claro' ? 'Modo claro' : 'Modo oscuro');
  }

  function engancharTemaLargo() {
    const boton = $('brand-home');
    if (!boton) return;

    let reloj = null;
    let desde = 0;

    const parar = function () {
      if (reloj) { clearInterval(reloj); reloj = null; }
      boton.style.removeProperty('--tema-avance');
      boton.classList.remove('brand__logo--cargando');
    };

    const empezar = function (evento) {
      if (evento.button != null && evento.button !== 0) return;
      parar();
      desde = Date.now();
      boton.classList.add('brand__logo--cargando');
      /* Se va pintando cuánto llevas: diez segundos a ciegas parecen una
         eternidad y darías por hecho que no funciona. */
      reloj = setInterval(function () {
        const parte = Math.min(1, (Date.now() - desde) / (TEMA_SEGUNDOS * 1000));
        boton.style.setProperty('--tema-avance', (parte * 100).toFixed(1) + '%');
        if (parte >= 1) {
          parar();
          temaCambiado = true;
          cambiarTema();
        }
      }, 100);
    };

    boton.addEventListener('pointerdown', empezar);
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (cual) {
      boton.addEventListener(cual, parar);
    });
    /* Con el dedo, mantener pulsado abre el menú del navegador: se corta. */
    boton.addEventListener('contextmenu', function (evento) { evento.preventDefault(); });
  }

  /** Repinta el diálogo de puja sin perder lo escrito en el importe. */
  function repintarPuja() {
    if (opPujaAbierta == null) return;
    const escrito = $('op-importe') ? $('op-importe').value : null;
    abrirPuja(opPujaAbierta);
    const campo = $('op-importe');
    if (campo && escrito !== null) campo.value = escrito;
  }

  /**
   * Le pregunta a Biwenger cuántas pujas lleva un futbolista del mercado.
   *
   * Es la misma consulta que hace su web con el botón de ver pujas, y puede
   * gastar un crédito de la cuenta, así que se hace solo cuando lo pides y una
   * única vez por futbolista mientras dure la sesión.
   */
  function contarPujas(playerId) {
    const clave = String(playerId);
    const venta = ventaDe(playerId);
    /* De lo tuyo no hace falta: las pujas recibidas ya las tienes enteras. */
    if (!venta || venta.mine) return;
    if (state.pujasDe[clave]) return;      // ya preguntado (o preguntándose)

    const config = loadSyncConfig();
    if (!config.url || !config.key) return;

    state.pujasDe[clave] = { cargando: true };

    fetch(config.url.replace(/\/+$/, '') + '/?key=' + encodeURIComponent(config.key) +
      '&pujas=' + encodeURIComponent(clave) +
      (venta.sellerId ? '&de=' + encodeURIComponent(venta.sellerId) : ''),
      { headers: { 'accept': 'application/json' } })
      .then(function (response) { return response.json(); })
      .then(function (payload) {
        state.pujasDe[clave] = payload.error
          ? { error: payload.error }
          : { bids: payload.bids, lista: payload.lista || null };
        repintarPuja();
      })
      .catch(function () {
        state.pujasDe[clave] = { error: 'No se ha podido preguntar.' };
        repintarPuja();
      });
  }

  /** Diálogo de puja: dice lo que vale, lo que piden y hasta dónde puedes. */
  function abrirPuja(playerId) {
    const venta = ventaDe(playerId);
    if (!venta) return;
    opPujaAbierta = playerId;
    const mia = miPujaPor(playerId);
    const limite = topeDePuja(playerId);
    /* Si ya pujaste, se parte de tu puja; si no, del precio que piden. */
    const partida = mia ? mia.amount : (venta.price || venta.marketValue || 0);
    /* En rojo cuando no da para lo que piden por él. */
    const corto = limite.tope != null && limite.tope < (venta.price || 0);

    abrirOpModal(
      '<div class="op-card__cab">' +
        '<h3 id="op-modal-titulo">' + (mia ? 'Tu puja por ' : 'Pujar por ') +
          escapeHtml(venta.player) + '</h3>' +
        '<button type="button" class="btn btn--ghost btn--close" data-op-cerrar' +
          ' title="Cerrar" aria-label="Cerrar">\u2715</button>' +
      '</div>' +
      '<dl class="op-datos">' +
        '<div><dt>Valor de mercado</dt><dd>' + money(venta.marketValue || 0) + '</dd></div>' +
        '<div><dt>' + (venta.free ? 'Precio de salida' : 'Pide ' + escapeHtml(venta.seller)) +
          '</dt><dd>' + money(venta.price || 0) + '</dd></div>' +
        '<div><dt>Tu saldo</dt><dd>' + money(limite.saldo || 0) + '</dd></div>' +
        /* Se recalcula al vuelo según lo que vayas escribiendo. */
        '<div><dt>Te quedaría</dt><dd><strong id="op-restante"' + (corto ? ' class="money-neg"' : '') + '>' +
          (limite.tope == null ? '\u2014' : money(limite.tope - partida)) + '</strong></dd></div>' +
        '<div><dt>Tu puja máxima</dt><dd>' +
          (limite.tope == null ? '\u2014' : money(limite.tope)) + '</dd></div>' +
        (limite.comprometido
          ? '<div><dt>En pujas enviadas</dt><dd class="money-neg">\u2212' +
            money(limite.comprometido) + '</dd></div>'
          : '') +
        (mia ? '<div><dt>Tu puja de ahora</dt><dd><strong class="money-neg">' +
          money(mia.amount) + '</strong></dd></div>' : '') +
        pujasPorEsteJugador(venta) +
      '</dl>' +
      '<label class="op-importe"><span>' + (mia ? 'Nueva puja' : 'Cuánto ofreces') + '</span>' +
        '<input type="number" id="op-importe" inputmode="numeric" step="100000" min="0"' +
          ' value="' + partida + '"></label>' +
      '<p class="op-aviso"></p>' +
      /* Para cerrar está el aspa de arriba: aquí solo va la acción. */
      '<div class="op-botones">' +
        '<button type="button" class="btn btn--primary" data-op-pujar="' +
          escapeHtml(String(venta.playerId)) + '">' + (mia ? 'Cambiar' : 'Pujar') + '</button>' +
      '</div>');

    const campo = $('op-importe');
    if (campo) { campo.focus(); campo.select(); }
  }

  function confirmarPuja(playerId) {
    const venta = ventaDe(playerId);
    const campo = $('op-importe');
    if (!venta || !campo) return;

    const importe = Math.round(Number(campo.value));
    if (!(importe > 0)) { opAviso('Pon una cantidad.', true); return; }

    const limite = topeDePuja(playerId);
    if (limite.tope != null && importe > limite.tope) {
      opAviso('Eso pasa de tu puja máxima (' + money(limite.tope) +
        (limite.comprometido ? ', ya con las pujas que tienes enviadas' : '') + ').', true);
      return;
    }

    const mia = miPujaPor(playerId);
    opAviso(mia ? 'Cambiando la puja\u2026' : 'Enviando la puja\u2026');

    /* El mercado se pone al día en cuanto Biwenger dice que sí. Antes había que
       esperar a la siguiente sincronización y la fila se quedaba unos segundos
       con la puja vieja, como si no hubiera pasado nada. Lo que llegue luego
       manda: esto es solo para no mirar un dato caducado mientras tanto. */
    trasOperarLimpia = function () {
      if (mia) {
        mia.amount = importe;
      } else {
        state.offers.push({
          id: 'nueva-' + venta.playerId,   // hasta que llegue el suyo
          playerId: String(venta.playerId),
          player: venta.player,
          amount: importe,
          direction: 'out',
          other: venta.free ? 'Mercado' : venta.seller,
          until: venta.until || null,
          team: venta.team != null ? venta.team : null,
          teamName: venta.teamName || null
        });
      }
      /* Ordenadas por importe, igual que las manda el Worker. */
      state.offers.sort(function (a, b) { return b.amount - a.amount; });
      render();
    };

    lanzarOperacion({
      accion: 'pujar',
      /* Con id, Biwenger la corrige en vez de crear otra. */
      id: mia ? mia.id : null,
      player: venta.playerId,
      amount: importe,
      to: venta.free ? null : venta.sellerId,
      tipo: venta.saleType === 'auction' ? 'bid' : 'purchase'
    }, 'Puja de ' + money(importe) + ' por ' + venta.player + (mia ? ' cambiada.' : ' enviada.'));
  }

  /**
   * Poner en venta, cambiar el precio o renovarla: es el mismo diálogo. Los
   * datos salen del mercado si ya está puesto y, si no, de tu plantilla.
   */
  function abrirRenovar(playerId) {
    const enMercado = ventaDe(playerId);
    const mio = miJugador(playerId);
    const listado = miVentaDe(playerId);
    const venta = enMercado || (mio ? {
      playerId: String(mio.id), player: mio.name,
      marketValue: mio.marketValue,
      price: listado ? listado.price : mio.marketValue
    } : null);
    if (!venta) return;

    const yaEstaba = !!(enMercado || listado);

    abrirOpModal(
      '<div class="op-card__cab">' +
        '<h3 id="op-modal-titulo">' + (yaEstaba ? 'Cambiar la venta de ' : 'Poner en venta a ') +
          escapeHtml(venta.player) + '</h3>' +
        '<button type="button" class="btn btn--ghost btn--close" data-op-cerrar' +
          ' title="Cerrar" aria-label="Cerrar">\u2715</button>' +
      '</div>' +
      '<dl class="op-datos">' +
        '<div><dt>Valor de mercado</dt><dd>' + money(venta.marketValue || 0) + '</dd></div>' +
        (yaEstaba
          ? '<div><dt>Precio de ahora</dt><dd><strong>' + money(venta.price || 0) + '</strong></dd></div>'
          : '') +
      '</dl>' +
      '<label class="op-importe"><span>Precio nuevo</span>' +
        '<input type="number" id="op-importe" inputmode="numeric" step="100000" min="0"' +
          ' value="' + (venta.price || 0) + '"></label>' +
      '<p class="op-aviso"></p>' +
      '<div class="op-botones">' +
        /* Repetir precio solo tiene sentido si ya estaba puesto. */
        (yaEstaba
          ? '<button type="button" class="btn btn--ghost" data-op-mismo="' +
            escapeHtml(String(venta.playerId)) + '">Repetir precio</button>'
          : '') +
        '<button type="button" class="btn btn--primary" data-op-vender="' +
          escapeHtml(String(venta.playerId)) + '">Aceptar</button>' +
      '</div>');

    const campo = $('op-importe');
    if (campo) { campo.focus(); campo.select(); }
  }

  /** Renovar la venta al mismo precio: solo pide confirmación. */
  function confirmarRenovar(playerId) {
    const suya = ventaDe(playerId) || miVentaDe(playerId);
    const mio = miJugador(playerId);
    const precio = suya ? suya.price : (mio ? mio.marketValue : 0);
    const quien = (suya && suya.player) || (mio && mio.name) || 'El futbolista';
    if (!(precio > 0)) return;

    abrirOpModal(
      '<div class="op-card__cab">' +
        '<h3 id="op-modal-titulo">Renovar la venta</h3>' +
        '<button type="button" class="btn btn--ghost btn--close" data-op-cerrar' +
          ' title="Cerrar" aria-label="Cerrar">✕</button>' +
      '</div>' +
      '<p class="op-texto">Dejar a ' + escapeHtml(quien) + ' en venta por <strong>' +
        money(precio) + '</strong>.</p>' +
      '<p class="op-aviso"></p>' +
      '<div class="op-botones">' +
        '<button type="button" class="btn btn--primary" data-op-mismo="' +
          escapeHtml(String(playerId)) + '">Sí</button>' +
      '</div>');
  }

  /**
   * Poner en venta, renovar o cambiar el precio. Nunca rechaza ofertas: eso
   * solo lo hace el boton de «devolver al mercado» del panel de ofertas, que
   * es donde tiene sentido tumbarlas.
   */
  function mandarVenta(playerId, precio) {
    const mio = miJugador(playerId);
    const venta = ventaDe(playerId);
    const quien = (venta && venta.player) || (mio && mio.name) || 'El futbolista';
    if (!(precio > 0)) { opAviso('Pon un precio.', true); return; }

    const yaEstaba = !!(venta || miVentaDe(playerId));
    opAviso(yaEstaba ? 'Renovando la venta…' : 'Poniendolo en el mercado…');
    lanzarOperacion({ accion: 'vender', player: playerId, price: precio, rechazar: false },
      quien + ' en venta por ' + money(precio) + '.');
  }

  /** Quitarlo del mercado, con su confirmación. */
  function abrirQuitar(playerId) {
    const mio = miJugador(playerId);
    const venta = ventaDe(playerId) || (mio ? { playerId: String(mio.id), player: mio.name } : null);
    if (!venta) return;

    abrirOpModal(
      '<div class="op-card__cab">' +
        '<h3 id="op-modal-titulo">\u00bfSeguro?</h3>' +
        '<button type="button" class="btn btn--ghost btn--close" data-op-cerrar' +
          ' title="Cerrar" aria-label="Cerrar">\u2715</button>' +
      '</div>' +
      '<p class="op-texto">Quitar a ' + escapeHtml(venta.player) + ' del mercado.</p>' +
      '<p class="op-aviso"></p>' +
      '<div class="op-botones">' +
        '<button type="button" class="btn btn--ghost" data-op-cerrar>Cancelar</button>' +
        '<button type="button" class="btn btn--primary" data-op-quitar-mercado="' +
          escapeHtml(String(venta.playerId)) + '">S\u00ed</button>' +
      '</div>');
  }

  /* ---------- Mandar la alineación a Biwenger ---------- */

  /**
   * El once en el orden que espera Biwenger: portero, defensas, medios y
   * delanteros, tantos como diga el sistema. Los huecos vacíos van como null,
   * igual que los manda su propia web.
   */
  function onceParaBiwenger() {
    if (!state.xi) return null;
    const lineas = formationLines(state.xi.type);
    const orden = [[1, 1], [2, lineas[2]], [3, lineas[3]], [4, lineas[4]]];
    const ids = [];
    orden.forEach(function (par) {
      for (let i = 0; i < par[1]; i++) ids.push(state.xi.slots[par[0] + '-' + i] || null);
    });
    return ids;
  }

  function abrirEnviarOnce() {
    const once = onceParaBiwenger();
    if (!once) return;

    const puestos = once.filter(Boolean).length;
    /* Un once vacío borraría el que tengas puesto allí: ni se ofrece. */
    if (puestos === 0) {
      abrirOpModal(
        '<div class="op-card__cab">' +
          '<h3 id="op-modal-titulo">Todavía no</h3>' +
          '<button type="button" class="btn btn--ghost btn--close" data-op-cerrar' +
            ' title="Cerrar" aria-label="Cerrar">✕</button>' +
        '</div>' +
        '<p class="op-texto">No hay ningún titular puesto. Si mandara esto, ' +
          'Biwenger se quedaría sin alineación.</p>' +
        '<div class="op-botones">' +
          '<button type="button" class="btn btn--primary" data-op-cerrar>Vale</button>' +
        '</div>');
      return;
    }
    const huecos = once.length - puestos;
    const jornada = state.round && state.round.number;

    abrirOpModal(
      '<div class="op-card__cab">' +
        '<h3 id="op-modal-titulo">Poner esta alineación en Biwenger</h3>' +
        '<button type="button" class="btn btn--ghost btn--close" data-op-cerrar' +
          ' title="Cerrar" aria-label="Cerrar">\u2715</button>' +
      '</div>' +
      '<dl class="op-datos">' +
        '<div><dt>Sistema</dt><dd><strong>' + escapeHtml(state.xi.type) + '</strong></dd></div>' +
        '<div><dt>Titulares</dt><dd>' + puestos + ' de ' + once.length + '</dd></div>' +
        (jornada ? '<div><dt>Jornada</dt><dd>' + jornada + '</dd></div>' : '') +
      '</dl>' +
      (huecos
        ? '<p class="op-texto">Quedan ' + huecos + (huecos === 1 ? ' hueco' : ' huecos') +
          ' sin cubrir; en Biwenger se quedarán vacíos.</p>'
        : '') +
      '<p class="op-aviso"></p>' +
      '<div class="op-botones">' +
        '<button type="button" class="btn btn--ghost" data-op-cerrar>Cancelar</button>' +
        '<button type="button" class="btn btn--primary" data-op-alinear>S\u00ed</button>' +
      '</div>');
  }

  function mandarOnce() {
    const once = onceParaBiwenger();
    if (!once || once.filter(Boolean).length === 0) {
      opAviso('No hay alineación que mandar.', true);
      return;
    }

    opAviso('Guardando la alineación\u2026');
    lanzarOperacion({
      accion: 'alinear',
      type: state.xi.type,
      players: once,
      /* Solo el once: los suplentes se quedan como estén en Biwenger. */
      captain: (state.lineup && state.lineup.captain) || null,
      round: (state.round && state.round.id) || null
    }, function (respuesta) {
      /* El Worker vuelve a leer la alineación después de guardarla: si no
         coincide con la que se mandó, más vale decirlo que dar por hecho. */
      if (respuesta && respuesta.comprobada === false) {
        return 'Biwenger la ha aceptado, pero al releerla sigue con otra. Míralo allí.';
      }
      return 'Alineación guardada en Biwenger.';
    });
  }

  /** Las ofertas recibidas y tus pujas, cada una con lo que se puede hacer. */
  function abrirOfertas(soloDe) {
    /* Solo lo que te han ofrecido: tus pujas se ven en la fila del mercado.
       Con `soloDe` se enseñan únicamente las de ese futbolista. */
    const todas = ofertasRecibidas();
    const recibidas = soloDe
      ? todas.filter(function (o) { return String(o.playerId) === String(soloDe); })
      : todas;
    const suyo = soloDe ? miJugador(soloDe) : null;

    const enVentaDe = function (playerId) {
      return (state.listings || []).filter(function (item) {
        return String(item.playerId) === String(playerId);
      })[0];
    };

    recibidas.sort(function (a, b) { return b.amount - a.amount; });

    const filaRecibida = function (oferta) {
      const suya = enVentaDe(oferta.playerId);
      const valor = suya ? listingValue(suya) : null;
      const diferencia = valor == null ? null : oferta.amount - valor;
      return '<div class="op-oferta">' +
        '<div class="op-oferta__quien">' +
          '<span class="with-crest">' + playerName(oferta) + crestOf(oferta, 'crest--badge') + '</span>' +
          '<span class="sub">de ' + escapeHtml(oferta.other || 'Mercado') + '</span>' +
          /* Cuánto le queda a la oferta antes de caducar. Si ya venció, se
             dice tal cual en vez de «caduca en vencida». */
          (oferta.until
            ? '<span class="sub">' +
                (Date.parse(oferta.until) <= Date.now()
                  ? '<span class="op-caduca">Vencida</span>'
                  /* El rótulo en gris y el tiempo en rojo, que es lo que urge. */
                  : 'Caduca en <span class="op-caduca">' +
                    escapeHtml((timeLeft(oferta.until) || {}).text || '') + '</span>') +
              '</span>'
            : '') +
        '</div>' +
        '<div class="op-oferta__pasta">' +
          '<strong class="money-pos">' + money(oferta.amount) + '</strong>' +
          (diferencia == null || diferencia === 0 ? '' :
            '<span class="delta ' + (diferencia > 0 ? 'delta--up' : 'delta--down') + '">' +
            (diferencia > 0 ? '\u25b2 +' : '\u25bc \u2212') + money(Math.abs(diferencia)) + '</span>') +
        '</div>' +
        '<div class="op-oferta__botones">' +
          '<button type="button" class="btn btn--sm btn--ok" data-op="aceptar" data-oferta="' +
            escapeHtml(oferta.id) + '" title="Aceptar la oferta">\u2713</button>' +
          '<button type="button" class="btn btn--sm btn--no" data-op="rechazar" data-oferta="' +
            escapeHtml(oferta.id) + '" title="Rechazar la oferta">\u2715</button>' +
          (suya
            ? '<button type="button" class="btn btn--sm btn--otra" data-op="devolver" data-oferta="' +
              escapeHtml(oferta.id) + '" title="Rechazarla y dejarlo otra vez en el mercado al mismo precio">' +
              '\u21bb</button>'
            : '') +
        '</div>' +
      '</div>';
    };

    abrirOpModal(
      '<div class="op-card__cab">' +
        '<h3 id="op-modal-titulo">' +
          (suyo ? 'Ofertas por ' + escapeHtml(suyo.name) : 'Ofertas') + '</h3>' +
        '<button type="button" class="btn btn--ghost btn--close" data-op-cerrar' +
          ' title="Cerrar" aria-label="Cerrar">\u2715</button>' +
      '</div>' +
      (recibidas.length
        ? (recibidas.length > 1
            ? '<p class="op-titulillo">' + recibidas.length + ' ofertas</p>'
            : '') +
          recibidas.map(filaRecibida).join('')
        : '<p class="muted">No tienes ofertas por resolver.</p>') +
      '<p class="op-aviso"></p>');

    /* Al responder una, se vuelve a esta misma lista. */
    volverA = function () { abrirOfertas(soloDe); };
  }

  /* Qué se dice antes de mandar cada operación. */
  const OPERACIONES = {
    aceptar:  { texto: 'Aceptar la oferta de %quien% por %jugador%: %importe%.', hecho: 'Oferta aceptada.' },
    rechazar: { texto: 'Rechazar la oferta de %quien% por %jugador%.', hecho: 'Oferta rechazada.' },
    devolver: { texto: 'Rechazar las ofertas por %jugador% y dejarlo en venta a %importe%.',
                hecho: 'Vuelve a estar en el mercado.' },
    retirar:  { texto: 'Retirar tu puja de %importe% por %jugador%.', hecho: 'Puja retirada.' }
  };

  let opPendiente = null;
  /* Cómo volver a la lista de ofertas que se estaba mirando (con su filtro). */
  let volverA = null;
  /* Qué quitar de la pantalla en cuanto la operación salga bien. */
  let trasOperarLimpia = null;

  /** Paso intermedio: enseña qué va a pasar y espera el sí. */
  function confirmarOperacion(accion, oferta, desdeOfertas) {
    const guion = OPERACIONES[accion];
    if (!guion || !oferta) return;

    const suya = (state.listings || []).filter(function (item) {
      return String(item.playerId) === String(oferta.playerId);
    })[0];
    /* Al devolverlo al mercado se repite el precio que ya tenía puesto. */
    const importe = accion === 'devolver'
      ? (suya ? suya.price : oferta.amount)
      : oferta.amount;

    const texto = guion.texto
      .replace('%quien%', oferta.other || 'Mercado')
      .replace('%jugador%', oferta.player || 'ese futbolista')
      .replace('%importe%', money(importe || 0));

    abrirOpModal(
      '<div class="op-card__cab">' +
        '<h3 id="op-modal-titulo">\u00bfSeguro?</h3>' +
        '<button type="button" class="btn btn--ghost btn--close" data-op-cerrar' +
          ' title="Cerrar" aria-label="Cerrar">\u2715</button>' +
      '</div>' +
      '<p class="op-texto">' + escapeHtml(texto) + '</p>' +
      '<p class="op-aviso"></p>' +
      '<div class="op-botones">' +
        '<button type="button" class="btn btn--ghost" data-op-volver>' +
          (desdeOfertas ? 'Volver' : 'Cancelar') + '</button>' +
        '<button type="button" class="btn btn--primary" data-op-va>S\u00ed</button>' +
      '</div>');

    opPendiente = {
      accion: accion,
      desdeOfertas: !!desdeOfertas,
      id: oferta.id,
      playerId: oferta.playerId,
      importe: importe,
      hecho: guion.hecho
    };
  }

  /* Lo que hay que volver a abrir cuando termine la operación (y su sincronía):
     al responder una oferta se vuelve a la lista, que sigue teniendo trabajo. */
  let trasOperar = null;

  function lanzarOperacion(orden, mensaje) {
    /* La pantalla desde la que se lanza. Si al terminar ya no es esta, es que
       te has ido a otro sitio y no hay que devolverte a rastras. */
    const sesion = opSesion;
    Array.prototype.forEach.call(document.querySelectorAll('#op-modal button'), function (b) {
      b.disabled = true;
    });
    mandarOperacion(orden)
      .then(function (respuesta) {
        opAviso(typeof mensaje === 'function' ? mensaje(respuesta) : mensaje);
        /* Fuera de la pantalla lo que acaba de resolverse. */
        if (trasOperarLimpia) { trasOperarLimpia(); trasOperarLimpia = null; }
        opPendiente = null;
        const volver = trasOperar;
        trasOperar = null;
        /* Lo que diga Biwenger manda: se vuelve a preguntar todo. */
        setTimeout(function () {
          syncNow(true);
          /* Si mientras se resolvía cerraste el diálogo (o abriste otra oferta
             encima), aquí ya no se pinta nada: ni se reabre la lista —que a
             estas alturas está vacía, porque la oferta acaba de resolverse— ni
             se cierra lo que hayas abierto tú después. */
          if (opSesion !== sesion) return;
          if (!volver) { cerrarOpModal(); return; }

          /* La lista se repinta con lo que acabe de llegar. */
          volver();

          /* Y otra vez al llegar la sincronía, PERO solo si sigues en esa misma
             lista: antes se reabría siempre, así que si cerrabas el diálogo
             después de responder una oferta, a los dos segundos y medio te
             saltaba otra vez él solo —y encima vacío. */
          const listaAbierta = opSesion;
          setTimeout(function () {
            if (opSesion !== listaAbierta) return;
            volver();
          }, 2500);
        }, 900);
      })
      .catch(function (error) {
        /* Si falla no se quita nada: la oferta sigue donde estaba. */
        trasOperarLimpia = null;
        /* Y si ya no estás en esa pantalla, el error no se escribe encima de
           lo que estés mirando: se pierde, que es lo correcto —la oferta sigue
           sin resolver y la volverás a ver en la lista. */
        if (opSesion !== sesion) return;
        Array.prototype.forEach.call(document.querySelectorAll('#op-modal button'), function (b) {
          b.disabled = false;
        });
        opAviso(String(error.message || error), true);
        const hueco = document.querySelector('#op-modal .op-aviso');
        if (hueco && error.intentos) {
          hueco.insertAdjacentHTML('beforeend',
            '<span class="op-detalle">' + escapeHtml(error.intentos.join(' · ')) + '</span>');
        }
      });
  }

  /** El sí definitivo: aquí ya se escribe en Biwenger. */
  function ejecutarPendiente() {
    if (!opPendiente) return;
    opAviso('Hablando con Biwenger\u2026');
    /* Las tres respuestas a una oferta devuelven a la lista de ofertas. */
    if (['aceptar', 'rechazar', 'devolver'].indexOf(opPendiente.accion) !== -1) {
      trasOperar = volverA || abrirOfertas;

      /* Y la oferta respondida se quita de la lista en cuanto Biwenger dice
         que sí: esperar a la siguiente sincronización la dejaba unos segundos
         ahí, como si no hubiera pasado nada. */
      const respondida = opPendiente.id;
      const devuelto = opPendiente.accion === 'devolver' ? opPendiente.playerId : null;
      /* Aceptar una oferta recibida es vender: ese jugador sale de tu plantilla
         y de tu alineación ahora mismo, no cuando llegue la siguiente sincronía. */
      const vendido = opPendiente.accion === 'aceptar' ? opPendiente.playerId : null;
      trasOperarLimpia = function () {
        state.offers = state.offers.filter(function (o) {
          if (String(o.id) === String(respondida)) return false;
          /* Al devolverlo al mercado se tumban todas las suyas, no solo esta. */
          if (devuelto && o.direction === 'in' && String(o.playerId) === String(devuelto)) return false;
          return true;
        });
        if (vendido != null) {
          const mio = state.me && state.me.id;
          (squadList() || []).forEach(function (squad) {
            if (squad.id !== mio) return;
            squad.players = (squad.players || []).filter(function (p) {
              return String(p.id) !== String(vendido);
            });
          });
          ensureXi();
        }
        render();
      };
    }

    if (opPendiente.accion === 'devolver') {
      lanzarOperacion({ accion: 'devolver', player: opPendiente.playerId, price: opPendiente.importe },
        opPendiente.hecho);
      return;
    }
    lanzarOperacion({ accion: opPendiente.accion, id: opPendiente.id }, opPendiente.hecho);
  }

  /** Los clics del diálogo y de los botones que lo abren. */
  function engancharOperaciones() {
    const mercado = $('market-body');
    if (mercado) {
      mercado.addEventListener('click', function (event) {
        const puja = event.target.closest('[data-pujar]');
        if (puja) { abrirPuja(puja.getAttribute('data-pujar')); return; }
        const renueva = event.target.closest('[data-renueva]');
        if (renueva) { confirmarRenovar(renueva.getAttribute('data-renueva')); return; }
        const renovar = event.target.closest('[data-renovar]');
        if (renovar) { abrirRenovar(renovar.getAttribute('data-renovar')); return; }
        const retirar = event.target.closest('[data-retirar]');
        if (retirar) {
          const oferta = state.offers.filter(function (o) {
            return String(o.id) === String(retirar.getAttribute('data-retirar'));
          })[0];
          confirmarOperacion('retirar', oferta);
          return;
        }
        const quitar = event.target.closest('[data-quitar]');
        if (quitar) abrirQuitar(quitar.getAttribute('data-quitar'));
      });
    }

    const pastilla = $('btn-ofertas');
    if (pastilla) pastilla.addEventListener('click', function () { abrirOfertas(); });

    /* El filtro del mercado va rotando: todos → libres → no libres → todos. */
    const filtro = $('market-filtro');
    if (filtro) {
      filtro.addEventListener('click', function () {
        const donde = FILTROS_MERCADO.map(function (f) { return f.clave; })
          .indexOf(state.marketFiltro);
        state.marketFiltro = FILTROS_MERCADO[(donde + 1) % FILTROS_MERCADO.length].clave;
        try { localStorage.setItem(MARKET_FILTER_KEY, state.marketFiltro); } catch (e) { /* sin memoria */ }
        renderMarket();
      });
    }

    const ambito = $('moves-ambito');
    if (ambito) {
      ambito.addEventListener('click', function () {
        state.ambitoFichajes = state.ambitoFichajes === 'laliga' ? 'liga' : 'laliga';
        pintarFichajes();
      });
    }

    const plantilla = $('squad-body');
    if (plantilla) {
      plantilla.addEventListener('click', function (event) {
        const renueva = event.target.closest('[data-renueva]');
        if (renueva) { confirmarRenovar(renueva.getAttribute('data-renueva')); return; }
        const vender = event.target.closest('[data-vender]');
        if (vender) { abrirRenovar(vender.getAttribute('data-vender')); return; }
        const quitar = event.target.closest('[data-quitar]');
        if (quitar) { abrirQuitar(quitar.getAttribute('data-quitar')); return; }
        const ofertas = event.target.closest('[data-ofertas-de]');
        if (ofertas) { abrirOfertas(ofertas.getAttribute('data-ofertas-de')); return; }
      });
    }

    const enviar = $('lineup-enviar');
    if (enviar) enviar.addEventListener('click', abrirEnviarOnce);

    const caja = $('op-modal');
    if (!caja) return;

    caja.addEventListener('click', function (event) {
      if (event.target === caja) { cerrarOpModal(); return; }
      if (event.target.closest('[data-op-cerrar]')) { cerrarOpModal(); return; }
      if (event.target.closest('[data-op-volver]')) {
        /* Se vuelve a la lista solo si se salió de ella. */
        if (opPendiente && opPendiente.desdeOfertas) (volverA || abrirOfertas)();
        else cerrarOpModal();
        return;
      }
      if (event.target.closest('[data-op-va]')) { ejecutarPendiente(); return; }
      if (event.target.closest('[data-op-alinear]')) { mandarOnce(); return; }

      /* La píldora de las pujas: se vuelve a pintar el diálogo, pero sin
         perder lo que ya hubieras escrito en el importe. */
      const verPujas = event.target.closest('[data-op-pujas]');
      if (verPujas) {
        /* Se le pregunta a Biwenger una sola vez por futbolista: la consulta
           puede costar un crédito de la cuenta. */
        contarPujas(verPujas.getAttribute('data-op-pujas'));
        repintarPuja();
        return;
      }

      const puja = event.target.closest('[data-op-pujar]');
      if (puja) { confirmarPuja(puja.getAttribute('data-op-pujar')); return; }

      const retirar = event.target.closest('[data-op-quitar]');
      if (retirar) {
        opAviso('Retirando la puja\u2026');
        /* Igual que al pujar: fuera de la lista en cuanto Biwenger confirme. */
        const quitada = retirar.getAttribute('data-op-quitar');
        trasOperarLimpia = function () {
          state.offers = state.offers.filter(function (o) {
            return String(o.id) !== String(quitada);
          });
          render();
        };
        lanzarOperacion({ accion: 'retirar', id: quitada }, 'Puja retirada.');
        return;
      }

      const mismo = event.target.closest('[data-op-mismo]');
      if (mismo) {
        const cual = mismo.getAttribute('data-op-mismo');
        const suya = ventaDe(cual) || miVentaDe(cual);
        const mio = miJugador(cual);
        const precio = suya ? suya.price : (mio ? mio.marketValue : 0);
        mandarVenta(cual, precio);
        return;
      }

      const vender = event.target.closest('[data-op-vender]');
      if (vender) {
        const campo = $('op-importe');
        mandarVenta(vender.getAttribute('data-op-vender'), Math.round(Number(campo && campo.value)));
        return;
      }

      const fuera = event.target.closest('[data-op-quitar-mercado]');
      if (fuera) {
        opAviso('Quit\u00e1ndolo del mercado\u2026');
        lanzarOperacion({ accion: 'quitar', player: fuera.getAttribute('data-op-quitar-mercado') },
          'Fuera del mercado.');
        return;
      }

      const accion = event.target.closest('[data-op]');
      if (accion) {
        const id = accion.getAttribute('data-oferta');
        const oferta = state.offers.filter(function (o) { return String(o.id) === String(id); })[0];
        confirmarOperacion(accion.getAttribute('data-op'), oferta, true);
      }
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !caja.hidden) cerrarOpModal();
    });
  }

  /* ---------- Cómo va la liga ---------- */

  /**
   * ¿Es una jornada de verdad, y no la mitad aplazada de otra?
   *
   * Biwenger añade una entrada más («Jornada 1 (aplazada)») con los MISMOS
   * partidos y los mismos futbolistas que la original. Contarla es contar dos
   * veces a todo el mundo, que es lo que inflaba los partidos de cada uno.
   *
   * El `part` viene en la respuesta, pero las jornadas guardadas de antes no lo
   * tienen: para esas se busca en el calendario, que sí lo trae.
   */
  function esJornadaPropia(round) {
    if (!round) return false;
    if (round.part != null) return round.part === 1;
    const ficha = (state.jornadas.list || []).filter(function (r) {
      return String(r.id) === String(round.id);
    })[0];
    return ((ficha && ficha.part) || 1) === 1;
  }

  /** Las jornadas guardadas propias, de la más antigua a la más nueva. */
  function jornadasGuardadas() {
    return Object.keys(state.jornadas.datos)
      .map(function (id) { return state.jornadas.datos[id]; })
      .filter(function (j) { return j && j.round && (j.standings || []).length; })
      .filter(function (j) { return esJornadaPropia(j.round); })
      .sort(function (a, b) { return (a.round.number || 0) - (b.round.number || 0); });
  }

  /**
   * Quién ha ganado cada jornada y qué lleva cada uno en las tres últimas.
   * Se cuenta con lo que haya descargado la web; según se vayan mirando
   * jornadas, el recuento se completa solo.
   */
  /** ¿Esta jornada ha terminado y ya tiene los puntos repartidos? */
  function jornadaCerrada(jornada) {
    if (!jornada || !jornada.round) return false;

    /* Biwenger da por «finished» una jornada a la que todavía le quedan
       partidos aplazados por jugar: la 1 lo estuvo con cuatro pendientes para
       la semana siguiente. Si a algún alineado le falta su partido, la jornada
       no está cerrada por mucho que él diga lo contrario. */
    const faltaAlguno = (jornada.standings || []).some(function (fila) {
      return (fila.xi || []).some(function (jugador) { return jugador.pending; });
    });
    if (faltaAlguno) return false;

    if (jornada.round.status) return jornada.round.status === 'finished';
    /* Sin estado, se mira si es la que está en juego ahora mismo. */
    return !(state.round && String(state.round.id) === String(jornada.round.id));
  }

  function tandasDeLaLiga() {
    /* Con puntos en alguna fila: las que ni han empezado no cuentan para nada. */
    const conPuntos = jornadasGuardadas().filter(function (jornada) {
      return (jornada.standings || []).some(function (fila) { return (fila.points || 0) !== 0; });
    });

    const ganadas = {};
    const ultimas = {};

    /* Jornadas ganadas: solo las cerradas. Mientras rueda, el ganador puede
       cambiar con cada partido, así que no se cuenta hasta que Biwenger la
       da por acabada y reparte los puntos. */
    conPuntos.filter(jornadaCerrada).forEach(function (jornada) {
      /* El que empezó la jornada en negativo no puntúa esa jornada, así que
         tampoco puede ganarla por mucho que sumara su once. */
      const filas = (jornada.standings || []).filter(function (f) {
        return f.points != null && f.counts !== false;
      });
      if (!filas.length) return;

      /* El ganador se decide con los criterios oficiales, no solo por puntos. */
      const orden = filas.slice().sort(function (a, b) {
        return (b.points - a.points) || desempateJornada(a, b);
      });
      const campeon = orden[0];
      if (campeon) ganadas[campeon.name] = (ganadas[campeon.name] || 0) + 1;
    });

    /* Racha: los puntos de las tres últimas jornadas, incluida la que está en
       juego con lo que lleve. Al empezar la cuarta, la primera deja de contar.

       Al mánager que empezó la jornada con saldo negativo esa jornada no le
       cuenta (`counts: false`, lo dice Biwenger): ni suma ni resta, aporta
       cero. Lo que puntúen sus futbolistas da igual aquí. */
    conPuntos.slice(-3).forEach(function (jornada) {
      (jornada.standings || []).forEach(function (fila) {
        if (fila.points == null) return;
        if (fila.counts === false) {
          /* Que aparezca en la lista aunque esa jornada no le sume nada. */
          ultimas[fila.name] = ultimas[fila.name] || 0;
          return;
        }
        ultimas[fila.name] = (ultimas[fila.name] || 0) + fila.points;
      });
    });

    return { jornadas: conPuntos.length, ganadas: ganadas, racha: ultimas };
  }

  function renderTandasDeLiga() {
    const caja = $('liga-tandas');
    if (!caja) return;

    const datos = tandasDeLaLiga();
    if (!datos.jornadas) {
      caja.innerHTML = '<p class="muted">Todavía no hay jornadas guardadas.</p>';
      return;
    }

    const lista = function (titulo, mapa, sufijo) {
      const filas = MANAGERS.map(function (nombre) {
        return { name: nombre, valor: mapa[nombre] || 0 };
      }).sort(function (a, b) {
        return (b.valor - a.valor) || a.name.localeCompare(b.name, 'es');
      });

      return '<div class="ranking">' +
        '<h3 class="ranking__title">' + titulo + '</h3>' +
        '<ol class="ranking__list">' + filas.map(function (fila) {
          return '<li class="ranking__row">' +
            '<span class="ranking__boton ranking__boton--fijo">' +
              '<span class="ranking__quien"><span class="manager">' + avatar(fila.name) +
                '<span class="manager__name">' + escapeHtml(fila.name) + '</span></span></span>' +
              '<strong class="ranking__value">' + fila.valor + sufijo + '</strong>' +
            '</span>' +
          '</li>';
        }).join('') + '</ol>' +
      '</div>';
    };

    /* El rótulo es siempre el mismo aunque todavía no se hayan jugado tres:
       se suman las que haya y, al llegar a tres, cuadra solo. */
    caja.innerHTML =
      lista('Más jornadas ganadas', datos.ganadas, '') +
      lista('Mejor racha <span class="ranking__matiz">(últimas 3 jornadas)</span>',
        datos.racha, ' pts');

    ajustarNombres();
  }

  /* ---------- Mi plantilla ---------- */

  /** Uno de los míos, por su id. */
  const miJugador = (id) => mySquad().filter(function (j) {
    return String(j.id) === String(id);
  })[0];

  /** Lo que tengo puesto en venta de ese futbolista, si es que lo está. */
  const miVentaDe = (id) => (state.listings || []).filter(function (item) {
    return String(item.playerId) === String(id);
  })[0];

  /** Ofertas recibidas por él, de mayor a menor. */
  const ofertasPor = (id) => state.offers.filter(function (o) {
    return o.direction === 'in' && String(o.playerId) === String(id);
  }).sort(function (a, b) { return b.amount - a.amount; });

  function renderPlantilla() {
    const seccion = $('squad-panel');
    const cuerpo = $('squad-body');
    if (!seccion || !cuerpo) return;

    const plantilla = mySquad();
    if (!plantilla.length) { seccion.hidden = true; return; }
    seccion.hidden = false;

    /* Por demarcación —portero, defensas, medios, delanteros— y dentro de cada
       una, el que más vale primero. */
    const lista = plantilla.slice().sort(function (a, b) {
      return ((a.position || 9) - (b.position || 9)) ||
        ((b.marketValue || 0) - (a.marketValue || 0)) ||
        String(a.name || '').localeCompare(String(b.name || ''), 'es');
    });

    cuerpo.innerHTML = lista.map(function (jugador) {
      const venta = miVentaDe(jugador.id);
      const ofertas = ofertasPor(jugador.id);
      const mejor = ofertas[0];
      const sube = (jugador.increment || 0) > 0;

      return '<tr' + (venta ? ' class="row-mine"' : '') + '>' +
        '<td data-label="Futbolista"><span class="with-crest">' +
          playerName({ playerId: jugador.id, player: jugador.name,
            position: jugador.position, altPositions: jugador.altPositions }) +
          crestOf(jugador, 'crest--badge') + '</span></td>' +
        '<td class="num" data-label="Puntos">' +
          (jugador.points == null ? '<span class="sub">—</span>' : jugador.points) + '</td>' +
        '<td class="estado-cell" data-label="Estado">' + statusCell(jugador) + '</td>' +
        '<td class="num" data-label="Valor"><strong>' + money(jugador.marketValue || 0) + '</strong></td>' +
        '<td class="num" data-label="Hoy">' + (jugador.increment
          ? '<span class="delta ' + (sube ? 'delta--up' : 'delta--down') + '">' +
            (sube ? '▲ +' : '▼ −') + money(Math.abs(jugador.increment)) + '</span>'
          : '<span class="delta delta--igual">– ' + money(0) + '</span>') + '</td>' +
        '<td class="num" data-label="En venta">' + (venta
          ? '<strong>' + money(venta.price) + '</strong>'
          : '<span class="sub">—</span>') + '</td>' +
        '<td data-label="Ofertas">' + (mejor
          ? '<button type="button" class="btn btn--sm btn--ok" data-ofertas-de="' +
            escapeHtml(String(jugador.id)) + '" title="Ver las ofertas por ' +
            escapeHtml(jugador.name) + '">' + money(mejor.amount) +
            (ofertas.length > 1 ? ' (' + ofertas.length + ')' : '') + '</button>'
          : '<span class="sub">—</span>') + '</td>' +
        '<td class="col-pujar">' + (venta
          /* Renovar al mismo precio, cambiar el precio o sacarlo del mercado. */
          ? '<span class="acciones">' +
              '<button type="button" class="btn btn--sm btn--otra" data-renueva="' +
                escapeHtml(String(jugador.id)) + '" title="Renovar la venta por ' +
                money(venta.price) + '">\u21bb</button>' +
              '<button type="button" class="btn btn--sm btn--otra" data-vender="' +
                escapeHtml(String(jugador.id)) + '" title="Cambiar el precio">\u270e</button>' +
              '<button type="button" class="btn btn--sm btn--no" data-quitar="' +
                escapeHtml(String(jugador.id)) + '" title="Quitar del mercado">\u2715</button>' +
            '</span>'
          : '<span class="acciones">' +
              '<button type="button" class="ambito ambito--pujar ambito--vender" data-vender="' +
                escapeHtml(String(jugador.id)) + '">Vender</button>' +
            '</span>') + '</td>' +
      '</tr>';
    }).join('');

    const enVenta = lista.filter(function (j) { return !!miVentaDe(j.id); }).length;
    const valor = lista.reduce(function (suma, j) { return suma + (j.marketValue || 0); }, 0);
    $('squad-count').textContent = lista.length + ' futbolistas · ' + money(valor) +
      (enVenta ? ' · ' + enVenta + (enVenta === 1 ? ' en venta' : ' en venta') : '');

    ajustarNombres();
  }

  /* ---------- Suben y bajan hoy ---------- */

  /** ¿De quién es este futbolista? Se busca en las plantillas de la liga. */
  function ownerOf(playerId) {
    const squads = squadList();
    for (let i = 0; i < squads.length; i++) {
      const players = squads[i].players || [];
      for (let j = 0; j < players.length; j++) {
        if (String(players[j].id) === String(playerId)) return squads[i].name;
      }
    }
    return null;
  }

  function moverRow(player) {
    const sube = player.increment > 0;
    const dueño = ownerOf(player.id);
    /* Mismo formato que el resto de tablas: foto, nombre y escudo detrás. */
    return '<div class="mover">' +
      '<span class="with-crest">' +
        playerName({ playerId: player.id, player: player.name,
          position: player.position, altPositions: player.altPositions }) +
        crestOf(player, 'crest--badge') +
        statusMark(player, 'mark--row') +
      '</span>' +
      /* Solo la foto del dueño: el nombre ensanchaba la fila hasta desbordar.
         Queda en el título, al pasar el ratón. */
      /* Sin dueño no se pinta nada: el guion solo ensuciaba la columna. */
      '<span class="mover__owner"' + (dueño ? ' title="' + escapeHtml(dueño) + '"' : '') + '>' +
        (dueño ? avatar(dueño) : '') + '</span>' +
      '<span class="mover__value">' + money(player.marketValue || 0) + '</span>' +
      '<span class="delta ' + (sube ? 'delta--up' : 'delta--down') + '">' +
        (sube ? '▲ +' : '▼ −') + money(Math.abs(player.increment)) + '</span>' +
    '</div>';
  }

  const MOVERS_CORTO = 25;
  const MOVERS_LARGO = 150;
  /* Lo pedido: los rankings de Datos despliegan hasta setenta y cinco. */
  const RANKING_LARGO = 75;

  function renderMovers() {
    const datos = state.movers || { up: [], down: [] };

    const pinta = function (id, lista) {
      const abierto = !!state.moversAbiertos[id];
      const tope = abierto ? MOVERS_LARGO : MOVERS_CORTO;
      const hayMas = lista.length > MOVERS_CORTO;

      /* Se despliega pulsando el título; abajo solo queda el «Ver menos». */
      $(id).innerHTML = lista.length === 0
        ? '<p class="muted">Sin cambios todavía.</p>'
        : lista.slice(0, tope).map(moverRow).join('') +
          (abierto && hayMas
            ? '<button type="button" class="btn btn--ghost btn--sm movers__mas" data-movers="' + id + '">' +
              'Ver menos</button>'
            : '');

      const titulo = document.querySelector('[data-movers="' + id + '"].movers__titulo');
      if (titulo) titulo.setAttribute('aria-expanded', abierto ? 'true' : 'false');
    };

    pinta('movers-up', datos.up || []);
    pinta('movers-down', datos.down || []);
  }

  /* ---------- Pestaña de jornadas ----------
     Biwenger solo enseña la alineación de una jornada mientras está en juego y
     borra el banquillo al empezar la siguiente. Aquí se guarda cada jornada en
     el navegador y no se pisa lo guardado con una respuesta más pobre. */

  /** Identificador estable de un movimiento, para poder congelar su estado. */
  function moveKey(movement) {
    return (movement.playerId || movement.player) + '|' + movement.type + '|' + (movement.timestamp || movement.date);
  }

  function loadMoveStatus() {
    try {
      const raw = localStorage.getItem(MOVE_STATUS_KEY);
      if (raw) state.moveStatus = JSON.parse(raw) || {};
    } catch (error) { /* se empieza de cero */ }
  }

  function persistMoveStatus() {
    try { localStorage.setItem(MOVE_STATUS_KEY, JSON.stringify(state.moveStatus)); } catch (error) { /* sin sitio */ }
  }

  /* La primera vez que aparece un fichaje se anota cómo estaba el futbolista;
     a partir de ahí ese dato ya no cambia aunque se lesione después. */
  function freezeMoveStatus(movements) {
    let nuevos = 0;
    movements.forEach(function (movement) {
      /* Sin dato no se congela nada: si se guarda un «ok» a ciegas, ese
         fichaje se queda sano para siempre aunque el jugador esté lesionado. */
      if (!movement.status) return;
      const clave = moveKey(movement);
      if (state.moveStatus[clave] === undefined) {
        state.moveStatus[clave] = movement.status;
        nuevos += 1;
      }
    });
    if (nuevos) persistMoveStatus();
  }

  function loadJornadas() {
    try {
      const raw = localStorage.getItem(ROUNDS_KEY);
      const data = raw ? JSON.parse(raw) : null;
      if (data && data.datos) {
        state.jornadas.datos = data.datos;
        state.jornadas.list = data.list || [];
      }
    } catch (error) { /* se empieza de cero */ }
  }

  function persistJornadas() {
    try {
      localStorage.setItem(ROUNDS_KEY, JSON.stringify({
        list: state.jornadas.list,
        datos: state.jornadas.datos
      }));
    } catch (error) { /* sin sitio: se sigue en memoria */ }
  }

  /**
   * Une lo que llega con lo guardado, quedándose siempre con lo más completo.
   * En silencio (`callado`) no toca cuál es la jornada en curso: se usa al
   * refrescar por detrás una jornada que no se está mirando.
   */
  function mergeJornada(payload, callado) {
    const id = payload.round && payload.round.id;
    if (id == null) return null;

    const previo = state.jornadas.datos[id];
    const filas = (payload.standings || []).map(function (fila) {
      const antes = previo && (previo.standings || []).filter(function (x) { return x.id === fila.id; })[0];
      if (!antes) return fila;
      return {
        id: fila.id,
        name: fila.name || antes.name,
        icon: fila.icon || antes.icon,
        position: fila.position != null ? fila.position : antes.position,
        points: fila.points != null ? fila.points : antes.points,
        pointsOfficial: fila.pointsOfficial != null ? fila.pointsOfficial : antes.pointsOfficial,
        played: fila.played != null ? fila.played : antes.played,
        counts: fila.counts !== undefined ? fila.counts : antes.counts,
        gaps: fila.gaps !== undefined ? fila.gaps : antes.gaps,
        type: fila.type || antes.type,
        // Lo importante: una respuesta vacía nunca borra la alineación guardada.
        xi: fila.xi && fila.xi.length ? fila.xi : (antes.xi || []),
        bench: fila.bench && fila.bench.length ? fila.bench : (antes.bench || []),
        xiValue: fila.xiValue || antes.xiValue || 0,
        abono: fila.abono || antes.abono || null
      };
    });

    (payload.standings || []).forEach(function (fila) {
      recordarPosiciones(fila.xi); recordarPosiciones(fila.bench);
    });

    state.jornadas.datos[id] = {
      round: payload.round,
      standings: filas,
      /* Si esta vez no llega, se conserva el que ya hubiera guardado. */
      bestXi: payload.bestXi || (previo && previo.bestXi) || null,
      savedAt: new Date().toISOString()
    };
    if (payload.rounds && payload.rounds.length) state.jornadas.list = payload.rounds;
    if (!callado) state.jornadas.actual = id;
    persistJornadas();
    return id;
  }

  /** Pide una jornada al Worker; 'actual' es la que esté en juego. */
  function ensureJornada(cual, forzar) {
    const config = loadSyncConfig();
    if (!config.url || !config.key) return;

    /* Una jornada por jugar o en juego cambia sola: la primera en cuanto
       empieza, la segunda partido a partido. Y aunque Biwenger la marque
       «finished», si le queda algún jugador pendiente es que todavía tiene
       un partido aplazado sin jugar (pasa en la jornada 1): tampoco esa es
       de fiar. Solo una cerrada y sin nadie pendiente se queda en caché para
       siempre; las demás se vuelven a pedir cada vez que se abren, que si no
       se quedan clavadas con lo que hubiera la primera vez (un cero de antes
       de empezar, o un marcador ya viejo). */
    const previa = cual !== 'actual' ? state.jornadas.datos[cual] : null;
    const guardada = previa && jornadaCerrada(previa) ? previa : null;
    if (guardada && !forzar) { state.jornadaVista = cual; return; }
    /* Solo se frena si ya se está pidiendo esa misma: antes, con una jornada
       a medio traer, elegir otra no hacía nada. */
    if (state.jornadaEstado === 'cargando' && state.jornadaPidiendo === String(cual)) return;
    state.jornadaPidiendo = String(cual);

    state.jornadaEstado = 'cargando';
    renderJornadas();

    fetch(config.url.replace(/\/+$/, '') + '/?key=' + encodeURIComponent(config.key) +
      '&jornada=' + encodeURIComponent(cual), { headers: { 'accept': 'application/json' } })
      .then(function (response) { return response.json(); })
      .then(function (payload) {
        if (payload.error) throw new Error(payload.error);
        const id = mergeJornada(payload);
        state.jornadaEstado = '';
        /* Solo se cambia de vista si es la que se pidió: si el Worker
           contestara con otra, quedarse mirando esa despistaba. */
        if (id != null && (String(cual) === 'actual' || String(cual) === String(id))) {
          state.jornadaVista = id;
        }
        renderJornadas();
        /* La jornada llega después de la sincronización, y con ella los puntos
           que se suman a la clasificación y las clasificaciones de futbolistas:
           hay que repintarlas. */
        renderManagers();
        renderRankings();
      })
      .catch(function () {
        state.jornadaEstado = 'error';
        renderJornadas();
      });
  }

  /**
   * Refresca por detrás las jornadas guardadas que todavía no están cerradas.
   *
   * Sus puntos entran en la general aunque no se estén mirando, y hasta ahora
   * solo se actualizaban al abrirlas: en el PC la jornada 1 se quedó con los
   * números viejos de hacía dos días —y con ellos la general— mientras que en
   * el móvil, que sí la había abierto después, salían bien.
   */
  function refrescarJornadasAbiertas() {
    const config = loadSyncConfig();
    if (!config.url || !config.key) return;

    jornadasGuardadas()
      .filter(function (jornada) { return !jornadaCerrada(jornada); })
      .forEach(function (jornada) {
        const id = jornada.round.id;
        /* La que se está mirando ya la pide ensureJornada, con su aviso de
           «cargando»; aquí solo van las de detrás, y sin tocar la vista. */
        if (String(id) === String(jornadaVistaId())) return;

        fetch(config.url.replace(/\/+$/, '') + '/?key=' + encodeURIComponent(config.key) +
          '&jornada=' + encodeURIComponent(id), { headers: { 'accept': 'application/json' } })
          .then(function (response) { return response.json(); })
          .then(function (payload) {
            if (payload.error || !payload.round) return;
            mergeJornada(payload, true);
            renderJornadas();
            renderManagers();
            renderRankings();
          })
          .catch(function () { /* si falla, se queda lo guardado */ });
      });
  }

  /** La jornada que se está mirando, ya sea recién traída o guardada. */
  function jornadaActiva() {
    const id = jornadaVistaId();
    return id != null ? state.jornadas.datos[id] : null;
  }

  /** Qué jornada se está mirando, se haya descargado o no su clasificación. */
  function jornadaVistaId() {
    return state.jornadaVista != null ? state.jornadaVista : state.jornadas.actual;
  }

  /**
   * Puntos en la general hasta la jornada que se está mirando, inclusive: en la
   * 1 son los de la 1; en la 2, los de la 1 más los de la 2, y así. Es una
   * columna de la tabla de jornadas, y ahí una general que no avanza con la
   * jornada elegida no dice nada.
   */
  function puntosGenerales(nombre) {
    const equipo = state.teams[nombre];
    if (!equipo) return null;
    const vista = jornadaActiva();
    const hasta = vista && vista.round && vista.round.number != null ? vista.round.number : null;
    const total = puntosSumados(equipo, hasta);
    return total != null ? total : (equipo.points != null ? equipo.points : null);
  }

  const ROUND_VALUES = {
    name: function (row) { return (row.name || '').toLowerCase(); },
    /* Al que empezó la jornada en negativo se le enseñan sus puntos (tachados,
       como hace Biwenger) pero para la tabla valen cero, que es lo que suman.
       Si se ordena por lo que se ve, sale sexto teniendo un cero y adelanta a
       gente que sí ha puntuado; Biwenger lo manda al último puesto. */
    points: function (row) {
      if (row.points == null) return -Infinity;
      return row.counts === false ? 0 : row.points;
    },
    general: function (row) {
      const total = puntosGenerales(row.name);
      return total == null ? -Infinity : total;
    },
    played: function (row) { return row.played == null ? -Infinity : row.played; },
    xiValue: function (row) { return row.xiValue || 0; },
    abono: function (row) { return row.abono ? row.abono.total : -Infinity; }
  };

  /**
   * Con qué columna se ordena si no has tocado ninguna cabecera: en las
   * jornadas por jugar los puntos son todo ceros y no dicen nada, así que
   * manda la general; en las que están en juego o ya jugadas, la jornada.
   */
  function ordenDeJornada(filas) {
    if (state.sort.roundsManual) return state.sort.rounds;
    const jugada = (filas || []).some(function (fila) { return (fila.points || 0) !== 0; });
    return { key: jugada ? 'points' : 'general', dir: -1 };
  }

  function sortJornada(filas) {
    const sort = ordenDeJornada(filas);
    const valor = ROUND_VALUES[sort.key] || ROUND_VALUES.points;
    return filas.slice().sort(function (a, b) {
      const x = valor(a);
      const y = valor(b);
      if (x === y) {
        /* Empate: los criterios oficiales de Biwenger, en su orden. */
        const criterio = sort.key === 'general' ? desempateGeneral : desempateJornada;
        return criterio(a, b) || (a.name || '').localeCompare(b.name || '');
      }
      if (typeof x === 'string') return sort.dir * x.localeCompare(y);
      return sort.dir * (x < y ? -1 : 1);
    });
  }

  /* Campo de solo lectura: las mismas líneas que el simulador, sin botones. */
  /**
   * Lo que se pone en la chapa de puntos de un futbolista: su nota, un guion si
   * su partido acabó y no puntuó, y una interrogación mientras no se sepa.
   */
  function marcaDePuntos(jugador) {
    if (jugador.points != null) return String(jugador.points);
    /* Guion corto: el largo se comía la chapa. */
    return jugador.pending ? '?' : '–';
  }

  function staticPitch(type, jugadores, conDueno) {
    const porLinea = { 1: [], 2: [], 3: [], 4: [] };
    jugadores.forEach(function (jugador) {
      const pos = jugador.position || 3;
      (porLinea[pos] || porLinea[3]).push(jugador);
    });

    const filas = [4, 3, 2, 1].map(function (pos) {
      const huecos = porLinea[pos].map(function (jugador) {
        return '<div class="pitch__slot">' +
          crestOf(jugador, 'crest--ghost') +
          caraDeAlineacion(jugador, 'pitch__face', conDueno) +
          '<span class="pitch__name">' + escapeHtml(jugador.name) + '</span>' +
        '</div>';
      }).join('');
      return '<div class="pitch__line">' + huecos + '</div>';
    }).join('');

    return '<div class="pitch pitch--static">' +
      '<span class="pitch__area pitch__area--top" aria-hidden="true"></span>' +
      '<span class="pitch__area pitch__area--bottom" aria-hidden="true"></span>' +
      '<span class="pitch__spot" aria-hidden="true"></span>' +
      filas + '</div>';
  }

  function jornadaDetalle(fila) {
    if (!fila.xi.length && !fila.bench.length) {
      return '<p class="muted">De esta jornada no hay alineación guardada. Se guarda sola mientras la jornada está en juego.</p>';
    }

    const banquillo = fila.bench.length === 0
      ? '<p class="muted">Sin suplentes guardados.</p>'
      : '<div class="bench">' + fila.bench.map(function (jugador) {
          return '<div class="bench__player">' +
            crestOf(jugador, 'crest--ghost') +
            caraDeAlineacion(jugador, 'bench__face') +
            '<span class="bench__name">' + escapeHtml(jugador.name) + '</span>' +
          '</div>';
        }).join('') + '</div>';

    return '<div class="lineup-grid">' +
      '<div class="pitch-wrap">' + staticPitch(fila.type, fila.xi) + '</div>' +
      '<div class="lineup-bench"><h3 class="bench__title">Suplentes</h3>' + banquillo + '</div>' +
    '</div>';
  }

  /* Cuatro colores validados: no se dibujan más de cuatro a la vez. */
  const SERIE_COLORS = ['var(--viz-1)', 'var(--viz-4)', 'var(--viz-2)', 'var(--viz-3)'];

  /**
   * Encoge la letra de un rótulo hasta que cabe entero en su hueco. Los nombres
   * de los mánagers van de «Eneko» a «José Mário dos Santos Mourinho», y en una
   * pastilla estrecha no hay tamaño único que sirva para los dos.
   */
  function ajustarAlAncho(elemento, maximo, minimo) {
    if (!elemento) return;
    let tamano = maximo;
    elemento.style.fontSize = tamano + 'px';
    /* Medio punto cada vuelta: sobra para que no se note el escalón. Se mira a
       lo ancho y a lo alto, porque hay rótulos que pueden partir en dos. */
    while (tamano > minimo &&
      (elemento.scrollWidth > elemento.clientWidth + 1 ||
       elemento.scrollHeight > elemento.clientHeight + 1)) {
      tamano -= 0.5;
      elemento.style.fontSize = tamano + 'px';
    }
  }

  /** Todos los nombres de mánager que puedan quedarse cortos. */
  function ajustarNombres() {
    Array.prototype.forEach.call(document.querySelectorAll('.chip__label'), function (el) {
      ajustarAlAncho(el, 11.5, 6);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.ranking__owner'), function (el) {
      ajustarAlAncho(el, 10.5, 5.5);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.jugador-card__nombre'), function (el) {
      ajustarAlAncho(el, 12.5, 8);
    });
    /* El dueño de cada venta: hay nombres larguísimos y la columna es estrecha. */
    Array.prototype.forEach.call(document.querySelectorAll('.table--market .manager__name'), function (el) {
      ajustarAlAncho(el, 11.5, 6);
    });
    /* «Media goles p/p» y «Goles encajados» no caben a tamaño normal. */
    Array.prototype.forEach.call(document.querySelectorAll('.stat__label'), function (el) {
      ajustarAlAncho(el, 10.2, 7);
    });
  }

  /* La liga son 38 jornadas: los ejes se plantean enteros desde el principio. */
  const JORNADAS_LIGA = 38;

  /** Puntos de cada mánager jornada a jornada, con lo que haya guardado. */
  function jornadaSeries() {
    const ids = Object.keys(state.jornadas.datos);

    /* El eje va de la 1 a la 38 aunque solo se hayan jugado unas pocas: así se
       ve el hueco que queda por delante en vez de una liga en miniatura. */
    const jugadas = {};
    ids.forEach(function (id) {
      const jornada = state.jornadas.datos[id];
      if (!jornada.round || !jornada.round.number) return;
      jugadas[jornada.round.number] = jornada;
    });

    const total = (state.jornadas.list || []).reduce(function (mayor, round) {
      return (round.part || 1) === 1 && round.number > mayor ? round.number : mayor;
    }, 38);

    const puntos = [];
    for (let numero = 1; numero <= total; numero++) {
      const fila = { round: numero };
      const jornada = jugadas[numero];
      if (jornada) {
        (jornada.standings || []).forEach(function (m) {
          fila['m' + m.id] = m.points == null ? null : m.points;
        });
      }
      puntos.push(fila);
    }

    const managers = {};
    ids.forEach(function (id) {
      (state.jornadas.datos[id].standings || []).forEach(function (m) { managers[m.id] = m.name; });
    });
    return { puntos: puntos, managers: managers };
  }

  function renderJornadaChart() {
    const caja = $('jornada-chart');
    const datos = jornadaSeries();
    const nombres = Object.keys(datos.managers);

    if (datos.puntos.length === 0 || nombres.length === 0) { caja.hidden = true; return; }
    caja.hidden = false;

    const chips = nombres.map(function (id) {
      const on = state.jornadaChart.indexOf(id) !== -1;
      const color = SERIE_COLORS[state.jornadaChart.indexOf(id)] || 'var(--border-strong)';
      return '<button type="button" class="chip" data-jornada-serie="' + escapeHtml(id) + '"' +
        ' title="' + escapeHtml(datos.managers[id]) + '"' +
        ' aria-pressed="' + (on ? 'true' : 'false') + '">' +
        '<span class="chip__dot" style="background:' + color + '"></span>' +
        '<span class="chip__label">' + escapeHtml(datos.managers[id]) + '</span></button>';
    }).join('');

    const series = state.jornadaChart.map(function (id, i) {
      return { field: 'm' + id, color: SERIE_COLORS[i], label: datos.managers[id] };
    });

    const grafico = series.length === 0
      ? ''
      : '<div class="viz__legend">' + series.map(function (linea) {
          return '<span class="viz__key"><span class="chip__dot" style="background:' + linea.color + '"></span>' +
            escapeHtml(linea.label) + '</span>';
        }).join('') + '</div>' +
        lineChart(datos.puntos, series[0].field, series[0].color, 'Puntos por jornada',
          { count: true, series: series, xlabel: function (punto) { return 'J' + punto.round; } });

    caja.innerHTML = '<div class="panel__head"><h2>Puntos por jornada</h2></div>' +
      '<div class="chips">' + chips + '</div>' + grafico;
    ajustarNombres();
  }

  /* ---------- Buscador de futbolistas ---------- */

  /** Trae la lista completa de la competici\u00f3n; se guarda mientras dure la sesi\u00f3n. */
  function ensureJugadores() {
    const config = loadSyncConfig();
    if (!config.url || !config.key) return;
    if (state.jugadores || state.jugadoresCargando) return;

    /* Lo guardado se enseña ya; lo de ahora llega por detrás. */
    const previo = cacheLeer('jugadores');
    if (previo && previo.players) {
      state.jugadores = previo.players;
      recordarPosiciones(state.jugadores);
    }
    state.jugadoresCargando = true;
    fetch(config.url.replace(/\/+$/, '') + '/?key=' + encodeURIComponent(config.key) + '&jugadores=1',
      { headers: { 'accept': 'application/json' } })
      .then(function (response) { return response.json(); })
      .then(function (payload) {
        if (payload.error) throw new Error(payload.error);
        state.jugadores = payload.players || [];
        state.jugadoresAt = Date.now();
        recordarPosiciones(state.jugadores);
        state.jugadoresCargando = false;
        cacheGuardar('jugadores', payload);
        renderJugadores();
      })
      .catch(function () {
        state.jugadoresCargando = false;
        state.jugadores = [];
        renderJugadores();
      });
  }

  /* Cada demarcación con su color y sus dos letras. */
  const PUESTO_CHAPA = {
    1: { texto: 'PT', clase: 'puesto--por' },
    2: { texto: 'DF', clase: 'puesto--def' },
    3: { texto: 'MC', clase: 'puesto--med' },
    4: { texto: 'DL', clase: 'puesto--del' },
    /* Biwenger mete a los entrenadores en el mismo índice, uno por equipo. */
    5: { texto: 'EN', clase: 'puesto--entrenador' }
  };

  function unaChapa(posicion, extra) {
    const chapa = PUESTO_CHAPA[posicion];
    if (!chapa) return '';
    const nombre = POSITION_NAMES[posicion] || 'Entrenador';
    return '<span class="puesto ' + chapa.clase + (extra ? ' ' + extra : '') +
      '" title="' + nombre + '">' + chapa.texto + '</span>';
  }

  /**
   * La demarcación de un futbolista. Los que valen para dos (Marcos Llorente de
   * defensa o medio, Berenguer de delantero o medio) llevan las dos chapas, con
   * la suya de siempre delante; Biwenger guarda las otras en altPositions.
   */
  function chapaDePuesto(posicion, extra, alternativas) {
    if (!PUESTO_CHAPA[posicion]) {
      /* Sin saber su demarcación se deja el hueco vacío: en las tablas, la cara
         del de al lado no puede bailar por eso. */
      return extra === 'puesto--fila' ? '<span class="puestos puestos--fila"></span>' : '';
    }

    const otras = (alternativas || []).filter(function (otra) {
      return otra !== posicion && PUESTO_CHAPA[otra];
    });

    /* En las tablas la chapa va siempre dentro del mismo hueco, lleve una
       demarcación o tres: si no, cada cara empezaba en un sitio distinto y las
       filas quedaban en escalera. En las fichas no hace falta. */
    const enFila = extra === 'puesto--fila';
    if (otras.length === 0 && !enFila) return unaChapa(posicion, extra);

    const donde = extra === 'puesto--esquina' ? 'puestos--esquina'
      : (enFila ? 'puestos--fila' : '');
    const apretadas = otras.length > 1 ? ' puestos--tres' : '';
    return '<span class="puestos ' + donde + apretadas + '">' +
      unaChapa(posicion) + otras.map(function (otra) { return unaChapa(otra); }).join('') +
    '</span>';
  }

  /**
   * Foto con sus chapas para las alineaciones de jornada y de partido: aquí la
   * nota puede no estar todavía, y se marca con «?» o con un guion.
   */
  /* De quién es cada futbolista. Se recalcula solo si cambian las plantillas. */
  let duenosMemo = null;
  let duenosDe = null;

  function duenoDe(id) {
    const lista = squadList();
    if (duenosDe !== lista) { duenosDe = lista; duenosMemo = duenosDeFutbolistas(); }
    return (duenosMemo && duenosMemo[String(id)]) || '';
  }

  /** El manager que lo tiene en su plantilla, en un círculo con su foto. */
  /* Quién está alineado esta jornada por alguno de los ocho mánagers. Se
     recalcula solo cuando cambian los datos de la jornada. */
  let alineadosMemo = null;
  let alineadosDe = null;

  function alineadosEnLaJornada() {
    const jornada = jornadaActiva();
    if (alineadosDe === jornada && alineadosMemo) return alineadosMemo;

    const quienes = {};
    ((jornada && jornada.standings) || []).forEach(function (fila) {
      (fila.xi || []).forEach(function (jugador) {
        if (jugador && jugador.id != null) quienes[String(jugador.id)] = true;
      });
    });

    alineadosDe = jornada;
    alineadosMemo = quienes;
    return quienes;
  }

  /**
   * El dueño del futbolista. Si lo tiene alguien pero no lo ha alineado esta
   * jornada, su foto sale en blanco y negro: se ve de un vistazo quién está
   * puntuando y quién se ha quedado en el banquillo de su mánager.
   */
  function chapaDeManager(jugador, extra) {
    const dueno = jugador && duenoDe(jugador.id);
    if (!dueno) return '';

    /* Antes de que se cierren las alineaciones de esa jornada, «no alineado»
       no significa nada: es que todavía no ha llegado el momento de elegir
       once. Sin eso, cualquier jornada futura marcaba a todo el mundo fuera. */
    const jornada = jornadaActiva();
    const empezada = !!(jornada && jornada.round && jornada.round.status &&
      jornada.round.status !== 'pending');
    const juega = !empezada || alineadosEnLaJornada()[String(jugador.id)];
    return '<span class="dueno ' + (extra || '') + (juega ? '' : ' dueno--fuera') + '"' +
      ' title="' + escapeHtml(dueno) + (juega ? '' : ' (no lo ha alineado)') + '">' +
      avatar(dueno) +
      /* Sin alinear: su foto tal cual, con un aspa roja al lado. */
      (juega ? '' : '<span class="dueno__x" aria-hidden="true">' +
        '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M18.3 5.7L12 12l6.3 6.3-2.1 2.1L9.9 14.1 3.6 20.4l-2.1-2.1L7.8 12 1.5 5.7l2.1-2.1L9.9 9.9l6.3-6.3z"/></svg>' +
      '</span>') +
    '</span>';
  }

  function caraDeAlineacion(jugador, claseCara, conDueno) {
    const sinNota = jugador.points == null;
    const negativa = jugador.points != null && jugador.points < 0;
    return '<span class="face-box">' + faceOf(jugador.id, claseCara) +
      chapaDePuesto(jugador.position, 'puesto--esquina', otrosPuestosDe(jugador)) +
      /* Con el dueño puesto, él ocupa la esquina de arriba a la derecha y el
         estado se calla: en el once ideal de una jornada ya jugada no aporta.
         Al que no es de nadie no se le deja la esquina vacía: ahí vuelve el
         estado, que si no los libres perdían su marca. */
      (conDueno
        ? (chapaDeManager(jugador, 'dueno--alto') || statusMark(jugador, 'mark--esquina'))
        : statusMark(jugador, 'mark--esquina')) +
      '<span class="pts pts--esquina' + (sinNota ? ' pts--sinnota' : '') + (negativa ? ' pts--neg' : '') + '"' +
        (jugador.fuera ? ' title="Ya no juega en LaLiga: no puntúa esta jornada"' : '') + '>' +
        marcaDePuntos(jugador) + '</span>' +
    '</span>';
  }

  /** Foto con sus tres chapas, igual en todos los sitios. */
  function caraConChapas(jugador, claseCara) {
    return '<span class="face-box">' + faceOf(jugador.id, claseCara) +
      chapaDePuesto(jugador.position, 'puesto--esquina', otrosPuestosDe(jugador)) +
      statusMark(jugador, 'mark--esquina') + pointsBadge(jugador, 'pts--esquina') +
    '</span>';
  }

  function renderJugadores() {
    const caja = $('jugadores-body');
    if (!caja) return;

    if (!state.jugadores) {
      caja.innerHTML = '<p class="muted">Cargando futbolistas\u2026</p>';
      $('jugadores-cuenta').textContent = '';
      return;
    }

    /* Se busca sin acentos ni may\u00fasculas, por nombre y por equipo. */
    const busca = normalize($('jugadores-buscar').value || '');
    const lista = busca
      ? state.jugadores.filter(function (jugador) {
          return normalize(jugador.name).indexOf(busca) !== -1 ||
            normalize(jugador.teamName || '').indexOf(busca) !== -1;
        })
      : state.jugadores;

        /* Solo se dice algo cuando se está filtrando. */
    $('jugadores-cuenta').textContent = lista.length === state.jugadores.length
      ? ''
      : lista.length + ' de ' + state.jugadores.length;

    if (lista.length === 0) {
      caja.innerHTML = '<p class="muted">Ning\u00fan futbolista con ese nombre.</p>';
      return;
    }

    /* Misma ficha que en el campo: escudo difuminado detr\u00e1s, estado arriba a la
       izquierda, puntos abajo, y el nombre debajo de la cara. */
    caja.innerHTML = lista.map(function (jugador) {
      return '<button type="button" class="jugador-card" data-player-id="' +
          escapeHtml(String(jugador.id)) + '">' +
        crestOf(jugador, 'crest--ghost') +
        caraConChapas(jugador, 'pitch__face') +
        '<span class="jugador-card__nombre player-name">' + escapeHtml(jugador.name) + '</span>' +
      '</button>';
    }).join('');

    /* Los nombres largos encogen la letra hasta caber, como en las pastillas. */
    ajustarNombres();
  }

  /* ---------- Los partidos de la jornada ----------
     Biwenger numera los lances sin explicarlos; el significado se ha despejado
     cruzándolos con el desglose de puntos y con los resultados. */
  /* Los iconos van dibujados, no como caracteres: los emojis y los símbolos
     cambian de forma y de altura según la fuente del aparato, y en el móvil
     salían descentrados. */
  const DIBUJOS = {
    /* Balón: círculo con sus pentágonos insinuados. */
    balon: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="#fff"/>' +
      '<path fill="#111" d="M12 5.6l3.6 2.6-1.4 4.2H9.8L8.4 8.2 12 5.6zm-6.9 4l2.2.6 1.3 4-2 1.7A8 8 0 0 1 5.1 9.6zm13.8 0a8 8 0 0 1-1.5 6.3l-2-1.7 1.3-4 2.2-.6zM9.4 18.9l1-2h3.2l1 2a8 8 0 0 1-5.2 0z"/></svg>',
    /* Flechas de cambio. */
    entra: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 4l7 9h-4.5v7h-5v-7H5z"/></svg>',
    sale:  '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 20l-7-9h4.5V4h5v7H19z"/></svg>',
    /* Cruz de lesión, centrada por geometría. */
    lesion: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M9.6 3h4.8v6.6H21v4.8h-6.6V21H9.6v-6.6H3V9.6h6.6z"/></svg>',
    /* Silbato del árbitro, para el penalti cometido. */
    silbato: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M2 9.5A2.5 2.5 0 0 1 4.5 7H12l4.4-3.2a1 1 0 0 1 1.6.8V7h2a2 2 0 0 1 2 2v1.5a2 2 0 0 1-2 2h-1.2A6.3 6.3 0 1 1 6 9.3H4.5A2.5 2.5 0 0 1 2 9.5zm10 1.8a4.2 4.2 0 1 0 0 8.4 4.2 4.2 0 0 0 0-8.4zm0 2.2a2 2 0 1 1 0 4 2 2 0 0 1 0-4z"/></svg>',
    /* Al palo: la escuadra de la portería con el balón rebotando. */
    palo: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 3h2.4v18H3zM3 3h14v2.4H3z"/><circle cx="15" cy="14" r="4" fill="currentColor"/></svg>',
    /* Penalti parado: el guante del portero. */
    guante: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M6 10V5.5a1.6 1.6 0 0 1 3.2 0V9h.9V4a1.6 1.6 0 0 1 3.2 0v5h.9V5.4a1.6 1.6 0 0 1 3.2 0V13a7 7 0 0 1-7 7 7 7 0 0 1-7-7v-1.6a1.6 1.6 0 0 1 2.6-1.3z"/></svg>',
    /* La A de asistencia, dibujada para que quede clavada en el círculo. */
    asist: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 3.5l6.4 17h-3.6l-1.2-3.6H10.4L9.2 20.5H5.6L12 3.5zm0 5.6l-1.2 4.4h2.4L12 9.1z"/></svg>'
  };

  /* ---------- Goles de falta ----------
   *
   * Biwenger no los distingue: para él un gol de falta y uno de cabeza son los
   * dos «type 1» a secas. ESPN sí lo dice, y además deja que se lo pregunte el
   * navegador (manda cabeceras CORS).
   *
   * Se pregunta desde aquí y no desde el Worker a propósito: desde Cloudflare la
   * respuesta llegaba vacía, y por el camino gastaba peticiones externas de las
   * que Cloudflare tiene un tope por visita. Desde el navegador sale con tu
   * propia conexión, que es la que ESPN atiende sin rechistar.
   */
  const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/soccer/esp.1';

  /** Tipo propio: los de Biwenger llegan al 17, del 100 en adelante no chocan. */
  const GOL_DE_FALTA = 101;

  /** Sin tildes ni puntuación, para poder comparar nombres entre las dos webs. */
  function llano(texto) {
    return String(texto || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /** El minuto de ESPN («85'», «90'+3'») en el mismo número que da Biwenger. */
  function minutoDeEspn(reloj) {
    const trozos = String(reloj || '').match(/(\d+)(?:'?\s*\+\s*(\d+))?/);
    if (!trozos) return null;
    return Number(trozos[1]) + (trozos[2] ? Number(trozos[2]) : 0);
  }

  /**
   * Los goles de falta de un día. Una sola petición: el marcador de la jornada
   * ya trae cómo fue cada gol, sin tener que pedir el resumen de cada partido.
   */
  function faltasDelDia(dia) {
    if (state.faltas[dia] !== undefined) return Promise.resolve(state.faltas[dia]);

    return fetch(ESPN + '/scoreboard?dates=' + dia)
      .then(function (respuesta) {
        if (!respuesta.ok) throw new Error('ESPN ' + respuesta.status);
        return respuesta.json();
      })
      .then(function (cuerpo) {
        const encontradas = [];
        (cuerpo.events || []).forEach(function (evento) {
          const juego = (evento.competitions || [])[0] || {};
          (juego.details || []).forEach(function (lance) {
            if (!lance.scoringPlay) return;
            const como = (lance.type && lance.type.text) || '';
            if (!/free.?kick/i.test(como)) return;
            /* Un penalti también se lanza parado: si ESPN lo llama penalti, fuera. */
            if (lance.penaltyKick || /penalty/i.test(como)) return;

            const minuto = minutoDeEspn(lance.clock && lance.clock.displayValue);
            if (minuto == null) return;
            const quien = (lance.athletesInvolved || [])[0] || {};
            encontradas.push({ minuto: minuto, nombre: quien.displayName || quien.shortName || '' });
          });
        });
        state.faltas[dia] = encontradas;
        return encontradas;
      })
      .catch(function () {
        /* Si ESPN no contesta no se guarda nada, para poder reintentarlo luego:
           dejar una lista vacía guardada sería dar por hecho que no hubo goles. */
        return [];
      });
  }

  /* ---------- Marcador en directo ----------
   *
   * Biwenger tarda un rato en mover el marcador. ESPN lo lleva al momento y ya
   * se le pregunta desde aquí para los goles de falta, así que sale gratis.
   *
   * Solo se toca el marcador de los partidos EN JUEGO: el de los acabados lo
   * manda Biwenger, que es quien reparte los puntos. Y solo se emparejan
   * equipos —veinte, por nombre—, nunca futbolistas: ahí es donde se lía.
   */
  const NOMBRE_RUIDO = { fc: 1, cf: 1, cd: 1, ud: 1, sd: 1, club: 1, de: 1, la: 1 };

  function palabrasDeEquipo(nombre) {
    return llano(nombre).split(' ').filter(function (palabra) {
      return palabra && !NOMBRE_RUIDO[palabra];
    });
  }

  /**
   * ¿Son el mismo club? Las dos fuentes lo escriben distinto («Athletic» y
   * «Athletic Club», «Celta» y «Celta Vigo»), así que vale con que las
   * palabras de uno estén todas en el otro. «Real Madrid» y «Real Sociedad»
   * no se confunden: ninguno está contenido en el otro.
   */
  function mismoEquipo(uno, otro) {
    const a = palabrasDeEquipo(uno);
    const b = palabrasDeEquipo(otro);
    if (!a.length || !b.length) return false;
    const dentro = function (chico, grande) {
      return chico.every(function (palabra) { return grande.indexOf(palabra) !== -1; });
    };
    return dentro(a, b) || dentro(b, a);
  }

  /** Pide a ESPN los partidos de hoy y de ayer, con su marcador y su minuto. */
  function ensureEnVivo() {
    if (state.envivoPidiendo) return;
    state.envivoPidiendo = true;

    const dia = function (cuando) {
      const d = new Date(cuando);
      return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') +
        String(d.getDate()).padStart(2, '0');
    };
    /* Ayer también: un partido de noche cruza la medianoche en UTC. */
    const dias = [dia(Date.now() - 86400e3), dia(Date.now())];

    Promise.all(dias.map(function (d) {
      return fetch(ESPN + '/scoreboard?dates=' + d)
        .then(function (r) { return r.ok ? r.json() : { events: [] }; })
        .catch(function () { return { events: [] }; });
    })).then(function (tandas) {
      const vivos = [];
      tandas.forEach(function (cuerpo) {
        (cuerpo.events || []).forEach(function (evento) {
          const juego = (evento.competitions || [])[0] || {};
          const estado = (evento.status && evento.status.type) || {};
          /* Solo lo que está rodando: ni lo que no ha empezado ni lo acabado. */
          if (estado.state !== 'in') return;
          const equipos = juego.competitors || [];
          const local = equipos.filter(function (e) { return e.homeAway === 'home'; })[0];
          const fuera = equipos.filter(function (e) { return e.homeAway === 'away'; })[0];
          if (!local || !fuera) return;
          vivos.push({
            home: (local.team && local.team.displayName) || '',
            away: (fuera.team && fuera.team.displayName) || '',
            homeScore: Number(local.score),
            awayScore: Number(fuera.score),
            reloj: (evento.status && evento.status.displayClock) || ''
          });
        });
      });
      /* Antes de guardar, se mira si ha cambiado algo de verdad: un gol, o un
         partido que se ha acabado. Eso es lo que dispara la sincronización,
         en vez de estar preguntándole a Biwenger cada pocos minutos por si
         acaso. ESPN es gratis; Biwenger nos corta si insistimos. */
      const firma = vivos.map(function (v) {
        return v.home + '|' + v.away + '|' + v.homeScore + '-' + v.awayScore;
      }).sort().join(' ~ ');
      const antes = state.envivoFirma;
      /* Los que estaban rodando y ya no están: han terminado, y con el pitido
         final llegan los puntos. */
      const acabados = (state.envivo || []).filter(function (v) {
        return !vivos.some(function (n) { return n.home === v.home && n.away === v.away; });
      }).length;

      state.envivo = vivos;
      state.envivoFirma = firma;
      state.envivoPidiendo = false;

      /* Solo se repinta si hay algo rodando: si no, no cambia nada. */
      if (vivos.length) {
        render();
        if (state.tab === 'jornadas') renderPartidos();
      }

      /* La primera vuelta solo toma la foto: no hay con qué comparar. */
      if (antes === undefined) return;
      if (firma !== antes || acabados) pedirSyncPorCambio(acabados);
    }).catch(function () { state.envivoPidiendo = false; });
  }

  /**
   * Ha cambiado algo en el campo: se le pide a Biwenger lo nuevo.
   *
   * Con freno a propósito. Biwenger nos cortó un día por preguntarle de más, y
   * un gol no cambia los puntos al instante: sus notas tardan un rato. Así que
   * como mucho una consulta cada minuto y medio.
   *
   * Al acabar un partido se repite un par de veces más pasados unos minutos:
   * es cuando llegan las notas del AS, y no llegan todas a la vez.
   */
  function pedirSyncPorCambio(acabados) {
    const AHORA_NO_MAS_DE = 90 * 1000;
    if (state.syncPorCambioAt && Date.now() - state.syncPorCambioAt < AHORA_NO_MAS_DE) return;
    state.syncPorCambioAt = Date.now();

    syncNow(true);

    if (!acabados) return;
    /* Las notas de un partido recién acabado tardan en publicarse: se vuelve
       a mirar a los tres y a los ocho minutos, y ahí se deja. */
    [3, 8].forEach(function (minutos) {
      setTimeout(function () {
        if (document.visibilityState !== 'visible') return;
        syncNow(true);
      }, minutos * 60 * 1000);
    });
  }

  /** El marcador de ese partido según ESPN, si lo está jugando ahora mismo. */
  function marcadorEnVivo(home, away) {
    const vivos = state.envivo || [];
    for (let i = 0; i < vivos.length; i++) {
      const v = vivos[i];
      if (mismoEquipo(v.home, home) && mismoEquipo(v.away, away)) return v;
    }
    return null;
  }

  /** Junta los goles de falta de varios días. */
  function faltasDeLosDias(dias) {
    return Promise.all(dias.map(faltasDelDia)).then(function (tandas) {
      return tandas.reduce(function (todas, unas) { return todas.concat(unas); }, []);
    });
  }

  /** Los días (AAAAMMDD) en los que se juega una lista de partidos. */
  function diasDe(partidos) {
    const dias = {};
    (partidos || []).forEach(function (partido) {
      if (partido && partido.start) dias[String(partido.start).slice(0, 10).replace(/-/g, '')] = true;
    });
    return Object.keys(dias);
  }

  /** ¿Este gol fue de falta? Por minuto (con holgura, por el descuento) y apellido. */
  function esDeFalta(faltas, minuto, nombre) {
    if (!faltas || !faltas.length || minuto == null) return false;
    const mios = llano(nombre).split(' ').filter(function (p) { return p.length >= 3; });
    if (!mios.length) return false;

    return faltas.some(function (falta) {
      if (Math.abs(Number(falta.minuto) - Number(minuto)) > 2) return false;
      const suyos = llano(falta.nombre).split(' ');
      return mios.some(function (palabra) { return suyos.indexOf(palabra) !== -1; });
    });
  }

  /**
   * Pasa a tipo propio los goles de falta de una lista de futbolistas.
   * Devuelve si ha cambiado algo, para repintar solo cuando haga falta.
   */
  function marcaFaltas(jugadores, faltas) {
    let tocado = false;
    (jugadores || []).forEach(function (jugador) {
      (jugador.events || []).forEach(function (lance) {
        if (lance.type !== 1) return;
        if (!esDeFalta(faltas, lance.minute, jugador.name)) return;
        lance.type = GOL_DE_FALTA;
        tocado = true;
      });
    });
    return tocado;
  }

  /** Marca los goles de falta en los once y suplentes de una jornada. */
  function marcaFaltasDeJornada(datos) {
    if (!datos || !datos.games || !datos.games.length) return Promise.resolve(false);

    return faltasDeLosDias(diasDe(datos.games)).then(function (faltas) {
      if (!faltas.length) return false;
      let tocado = false;
      datos.games.forEach(function (juego) {
        [juego.home, juego.away].forEach(function (lado) {
          if (!lado) return;
          if (marcaFaltas(lado.xi, faltas)) tocado = true;
          if (marcaFaltas(lado.bench, faltas)) tocado = true;
        });
      });
      return tocado;
    });
  }

  /** Y en la lista de partidos de un futbolista, donde el nombre es siempre el suyo. */
  function marcaFaltasDeFicha(datos) {
    const jugados = ((datos && datos.matches) || []).filter(function (partido) {
      return (partido.events || []).some(function (lance) { return lance.type === 1; });
    });
    if (!jugados.length) return Promise.resolve(false);

    return faltasDeLosDias(diasDe(jugados)).then(function (faltas) {
      if (!faltas.length) return false;
      let tocado = false;
      jugados.forEach(function (partido) {
        partido.events.forEach(function (lance) {
          if (lance.type !== 1) return;
          if (!esDeFalta(faltas, lance.minute, datos.name)) return;
          lance.type = GOL_DE_FALTA;
          tocado = true;
        });
      });
      return tocado;
    });
  }

  /* Los números son los de Biwenger, sacados de su propio código: antes había
     tipos sin identificar que salían como «Lance 10». */
  const LANCES = {
    1:  { dibujo: 'balon',   clase: 'lance--gol',       nombre: 'Gol' },
    2:  { dibujo: 'balon',   clase: 'lance--penalti',   nombre: 'Gol de penalti' },
    3:  { dibujo: 'asist',   clase: 'lance--asist',     nombre: 'Asistencia' },
    4:  { dibujo: 'sale',    clase: 'lance--sale',      nombre: 'Sale' },
    5:  { dibujo: 'entra',   clase: 'lance--entra',     nombre: 'Entra' },
    6:  { icono: '',         clase: 'lance--amarilla',  nombre: 'Tarjeta amarilla' },
    7:  { icono: '',         clase: 'lance--roja',      nombre: 'Tarjeta roja' },
    8:  { icono: '',         clase: 'lance--doble',     nombre: 'Roja por doble amarilla' },
    9:  { dibujo: 'balon',   clase: 'lance--propia',    nombre: 'Gol en propia' },
    10: { dibujo: 'palo',    clase: 'lance--palo',      nombre: 'Al palo' },
    11: { dibujo: 'balon',   clase: 'lance--penfallado', nombre: 'Penalti fallado' },
    12: { dibujo: 'guante',  clase: 'lance--parado',    nombre: 'Penalti parado' },
    13: { dibujo: 'balon',   clase: 'lance--anulado',   nombre: 'Gol anulado' },
    14: { dibujo: 'lesion',  clase: 'lance--lesion',    nombre: 'Lesi\u00f3n' },
    15: { dibujo: 'balon',   clase: 'lance--penalti',   nombre: 'Gol en la tanda de penaltis' },
    16: { dibujo: 'silbato', clase: 'lance--fallo',     nombre: 'Penalti cometido' },
    17: { dibujo: 'balon',   clase: 'lance--penfallado', nombre: 'Penalti fallado en la tanda' },
    /* Biwenger no distingue el gol de falta: este tipo se lo pone el Worker
       cruzando la jornada con ESPN, que sí cuenta cómo fue cada gol. */
    101: { dibujo: 'balon',  clase: 'lance--falta',     nombre: 'Gol de falta' }
  };

  /** El dibujo de un lance, o su carácter si no lo tiene (las tarjetas). */
  function pintaDeLance(ficha) {
    return ficha.dibujo ? DIBUJOS[ficha.dibujo] : (ficha.icono || '');
  }

  /**
   * Los lances de un futbolista en un partido. Los repetidos no se pintan uno
   * detrás de otro: se agrupan con «×2», que se lee mejor y ocupa menos.
   */
  function lancesDe(jugador) {
    const grupos = [];
    const porTipo = {};

    (jugador.events || []).forEach(function (lance) {
      const clave = String(lance.type);
      const minuto = lance.minute != null ? lance.minute + "'" : '';
      if (porTipo[clave]) {
        porTipo[clave].veces += 1;
        if (minuto) porTipo[clave].minutos.push(minuto);
        return;
      }
      porTipo[clave] = { type: lance.type, veces: 1, minutos: minuto ? [minuto] : [] };
      grupos.push(porTipo[clave]);
    });

    /* Por importancia, no por minuto: primero lo que se recuerda del partido. */
    const ORDEN = {
      1: 0, 101: 1, 2: 2, 15: 3, 9: 4, 13: 5, 11: 6, 17: 7, 12: 8, 10: 9,
      3: 10, 6: 11, 8: 12, 7: 13, 16: 14, 14: 15, 5: 16, 4: 17
    };
    grupos.sort(function (a, b) {
      const x = ORDEN[a.type] != null ? ORDEN[a.type] : 50;
      const y = ORDEN[b.type] != null ? ORDEN[b.type] : 50;
      return x - y;
    });

    return grupos.map(function (grupo) {
      const ficha = LANCES[grupo.type];
      const cuando = grupo.minutos.length ? ' ' + grupo.minutos.join(', ') : '';
      const veces = grupo.veces > 1
        ? '<span class="lance__veces">\u00d7' + grupo.veces + '</span>' : '';

      if (!ficha) {
        return '<span class="lance lance--otro" title="Lance ' + grupo.type + cuando + '">\u00b7' +
          veces + '</span>';
      }
      return '<span class="lance ' + ficha.clase + '" title="' + ficha.nombre + cuando + '">' +
        pintaDeLance(ficha) + veces + '</span>';
    }).join('');
  }

  /**
   * La nota de un partido, en su pastilla de color: azul de 10 para arriba,
   * verde de 6 a 9, naranja de 1 a 5, gris el cero y rojo los negativos.
   */
  function notaDePartido(puntos) {
    if (puntos == null) return '<span class="nota nota--sin">–</span>';
    const clase = puntos >= 10 ? 'nota--azul'
      : (puntos >= 6 ? 'nota--verde'
        : (puntos >= 1 ? 'nota--naranja'
          : (puntos === 0 ? 'nota--cero' : 'nota--roja')));
    return '<span class="nota ' + clase + '">' + puntos + '</span>';
  }

  /** Una alineaci\u00f3n de las dos del partido. */
  function once(equipo, titulo) {
    /* De portero a delantero: Biwenger los manda al revés. */
    const porPuesto = function (lista) {
      return lista.slice().sort(function (a, b) {
        return (a.position || 9) - (b.position || 9);
      });
    };

    const fila = function (jugador) {
      return '<div class="alin__fila">' +
        '<span class="alin__pos">' + (jugador.position ? POSITION_NAMES[jugador.position] : '\u2014') + '</span>' +
        '<span class="with-crest">' + playerName({ playerId: jugador.id, player: jugador.name,
          position: jugador.position, altPositions: jugador.altPositions }) +
          chapaDeManager(jugador, 'dueno--fila') + '</span>' +
        '<span class="alin__lances">' + lancesDe(jugador) + '</span>' +
        '<span class="alin__pts">' + (jugador.points == null
          ? (jugador.pending ? '<span class="sub">?</span>' : '<span class="sub">\u2013</span>')
          : notaDePartido(jugador.points)) + '</span>' +
      '</div>';
    };

    return '<div class="alin">' +
      '<h4 class="alin__titulo">' + escapeHtml(titulo) + '</h4>' +
      porPuesto(equipo.xi).map(fila).join('') +
      (equipo.bench.length
        ? '<p class="alin__banquillo">Entraron</p>' + porPuesto(equipo.bench).map(fila).join('')
        : '') +
    '</div>';
  }

  /**
   * El mismo once, pero sobre el campo. El sistema no lo dice Biwenger en los
   * partidos, as\u00ed que se deduce contando por demarcaci\u00f3n: cuatro defensas,
   * cuatro medios y dos delanteros son un 4-4-2.
   */
  function campoDePartido(equipo, titulo) {
    const porLinea = { 1: [], 2: [], 3: [], 4: [] };
    equipo.xi.forEach(function (jugador) {
      const pos = jugador.position || 3;
      (porLinea[pos] || porLinea[3]).push(jugador);
    });

    const hueco = function (jugador) {
      return '<div class="pitch__slot">' +
        caraDeAlineacion(jugador, 'pitch__face', true) +
        '<span class="pitch__name">' + escapeHtml(jugador.name) + '</span>' +
        (jugador.events && jugador.events.length
          ? '<span class="pitch__lances">' + lancesDe(jugador) + '</span>' : '') +
      '</div>';
    };

    const lineas = [4, 3, 2, 1].map(function (pos) {
      return '<div class="pitch__line">' + porLinea[pos].map(hueco).join('') + '</div>';
    }).join('');

    return '<div class="alin">' +
      '<h4 class="alin__titulo">' + escapeHtml(titulo) + '</h4>' +
      '<div class="pitch-wrap"><div class="pitch pitch--static">' +
        '<span class="pitch__area pitch__area--top" aria-hidden="true"></span>' +
        '<span class="pitch__area pitch__area--bottom" aria-hidden="true"></span>' +
        '<span class="pitch__spot" aria-hidden="true"></span>' +
        lineas +
      '</div></div>' +
      (equipo.bench.length
        ? '<p class="alin__banquillo">Entraron</p>' +
          '<div class="bench">' + equipo.bench.map(function (jugador) {
            return '<div class="bench__player">' +
              caraDeAlineacion(jugador, 'bench__face', true) +
              '<span class="bench__name">' + escapeHtml(jugador.name) + '</span>' +
              (jugador.events && jugador.events.length
                ? '<span class="bench__lances">' + lancesDe(jugador) + '</span>' : '') +
            '</div>';
          }).join('') + '</div>'
        : '') +
    '</div>';
  }

  function renderPartidos() {
    const caja = $('jornada-partidos');
    if (!caja) return;

    const id = jornadaVistaId();
    if (id == null) { caja.hidden = true; caja.innerHTML = ''; return; }

    const datos = state.partidos[id];
    caja.hidden = false;
    /* Para poner el círculo del manager hay que saber de quién es cada uno. */
    ensureSquads();

    if (!datos) {
      caja.innerHTML = '<div class="panel__head"><h2>Partidos</h2></div>' +
        '<p class="muted">' + (state.partidosEstado === 'error'
          ? 'No se han podido traer los partidos.' : 'Cargando los partidos\u2026') + '</p>';
      return;
    }

    const partidos = datos.games || [];
    caja.innerHTML = '<div class="panel__head"><h2>Partidos</h2></div>' +
      (partidos.length === 0
        ? '<p class="muted">Esta jornada todav\u00eda no tiene calendario.</p>'
        : '<div class="partidos">' + partidos.map(function (juego) {
            const abierto = state.partidoAbierto === juego.id;
            const acabado = juego.status === 'finished';
            /* Mientras rueda manda ESPN: mueve el marcador antes que Biwenger. */
            const vivo = acabado ? null : marcadorEnVivo(juego.home.name, juego.away.name);
            const jugado = vivo ? true : (juego.home.score != null && juego.away.score != null);
            const marca = vivo
              ? vivo.homeScore + '–' + vivo.awayScore
              : juego.home.score + '–' + juego.away.score;
            const hayAlineacion = juego.home.xi.length > 0;

            return '<div class="partido' + (abierto ? ' partido--abierto' : '') + '">' +
              '<button type="button" class="partido__cab" data-partido="' + juego.id + '"' +
                ' aria-expanded="' + (abierto ? 'true' : 'false') + '"' +
                (hayAlineacion ? '' : ' disabled') + '>' +
                '<span class="partido__equipo partido__equipo--local">' +
                  escapeHtml(juego.home.name) + crestOf({ team: juego.home.id, teamName: juego.home.name }, 'crest--badge') +
                '</span>' +
                '<span class="partido__marcador' + (acabado ? '' : ' partido__marcador--vivo') + '"' +
                  (vivo && vivo.reloj ? ' title="En juego \u00b7 ' + escapeHtml(vivo.reloj) + '"' : '') + '>' +
                  (jugado ? marca : '\u2013') + '</span>' +
                '<span class="partido__equipo">' +
                  crestOf({ team: juego.away.id, teamName: juego.away.name }, 'crest--badge') +
                  escapeHtml(juego.away.name) +
                '</span>' +
              '</button>' +
              (abierto
                ? '<div class="partido__detalle">' +
                    (jugado ? ''
                      : '<p class="muted alin__aviso">' +
                        (juego.confirmadas ? 'Alineación confirmada.' : 'Alineaciones probables.') +
                        '</p>') +
                    (function () {
                      /* La píldora dice en qué vista estás, no a cuál irías
                         —igual que las de Mi liga y LaLiga—, y al pulsarla
                         cambian el rótulo y lo de debajo. Siempre a la
                         derecha: antes saltaba de lado según la vista. */
                      const ahora = state.vistaPartido === 'campo' ? 'campo' : 'tabla';
                      const otra = ahora === 'campo' ? 'tabla' : 'campo';
                      return '<div class="vistas">' +
                        '<button type="button" class="ambito ambito--marco" data-vista="' + otra + '">' +
                          (ahora === 'campo' ? 'Campo' : 'Tabla') + '</button>' +
                      '</div>';
                    })() +
                    '<div class="alineaciones">' +
                      (state.vistaPartido === 'campo'
                        ? campoDePartido(juego.home, juego.home.name) + campoDePartido(juego.away, juego.away.name)
                        : once(juego.home, juego.home.name) + once(juego.away, juego.away.name)) +
                    '</div>' +
                  '</div>'
                : '') +
            '</div>';
          }).join('') + '</div>');
  }

  /** Pide los partidos de una jornada; se guardan mientras dure la sesi\u00f3n. */
  /* Cada cuánto se vuelven a pedir los partidos de una jornada. Las alineaciones
     se confirman una hora antes del pitido inicial, así que con la jornada
     encima hay que mirar a menudo; si no hay nada cerca, cada media hora. */
  function vigenciaPartidos(datos) {
    if (!datos) return 0;
    const ahora = Date.now();
    const cerca = (datos.games || []).some(function (juego) {
      const empieza = Date.parse(juego.start);
      if (isNaN(empieza)) return false;
      /* Desde tres horas antes hasta tres después: alineaciones y resultados. */
      return ahora > empieza - 3 * 3600e3 && ahora < empieza + 3 * 3600e3;
    });
    return cerca ? 2 * 60e3 : 30 * 60e3;
  }

  function ensurePartidos(id, forzar) {
    const config = loadSyncConfig();
    if (!config.url || !config.key || id == null) return;

    const guardado = state.partidos[id];
    if (guardado && !forzar &&
      Date.now() - (guardado.pedidoA || 0) < vigenciaPartidos(guardado)) return;
    if (state.partidosEstado === 'cargando') return;

    state.partidosEstado = 'cargando';
    fetch(config.url.replace(/\/+$/, '') + '/?key=' + encodeURIComponent(config.key) +
      '&partidos=' + encodeURIComponent(id), { headers: { 'accept': 'application/json' } })
      .then(function (response) { return response.json(); })
      .then(function (payload) {
        if (payload.error) throw new Error(payload.error);
        payload.pedidoA = Date.now();
        state.partidos[id] = payload;
        state.partidosEstado = '';
        renderPartidos();
        /* Los goles de falta llegan de ESPN, que es otra web: se pintan en
           cuanto contesta, sin hacer esperar al resto de la jornada. */
        marcaFaltasDeJornada(payload).then(function (tocado) {
          if (tocado && state.partidos[id] === payload) renderPartidos();
        });
      })
      .catch(function () {
        state.partidosEstado = 'error';
        renderPartidos();
      });
  }

  /** El once ideal de la jornada, cuando Biwenger ya ha puntuado. */
  /**
   * El mejor once posible con los futbolistas que alinearon los mánagers de
   * la liga esa jornada. Se prueban todos los sistemas permitidos y se queda
   * el que más puntos suma; si un futbolista lo alinearon varios, cuenta una
   * sola vez.
   */
  function onceIdealDeLaLiga(jornada) {
    const porPuesto = { 1: [], 2: [], 3: [], 4: [] };
    const vistos = {};

    (jornada.standings || []).forEach(function (fila) {
      (fila.xi || []).forEach(function (jugador) {
        if (!jugador || jugador.points == null) return;
        const clave = String(jugador.id);
        if (vistos[clave]) return;
        vistos[clave] = true;

        const puesto = jugador.position || 3;
        (porPuesto[puesto] || porPuesto[3]).push(Object.assign({}, jugador, { dueno: fila.name }));
      });
    });

    /* De más a menos puntos dentro de cada demarcación. */
    Object.keys(porPuesto).forEach(function (puesto) {
      porPuesto[puesto].sort(function (a, b) {
        return (b.points - a.points) || ((b.marketValue || 0) - (a.marketValue || 0));
      });
    });

    if (!porPuesto[1].length) return null;

    let mejor = null;
    FORMATIONS.forEach(function (sistema) {
      const lineas = formationLines(sistema);
      /* Sin gente suficiente para esa demarcación, ese sistema no vale. */
      if (porPuesto[2].length < lineas[2] || porPuesto[3].length < lineas[3] ||
          porPuesto[4].length < lineas[4]) return;

      const elegidos = [porPuesto[1][0]]
        .concat(porPuesto[2].slice(0, lineas[2]))
        .concat(porPuesto[3].slice(0, lineas[3]))
        .concat(porPuesto[4].slice(0, lineas[4]));

      const total = elegidos.reduce(function (suma, j) { return suma + (j.points || 0); }, 0);
      if (!mejor || total > mejor.points) mejor = { type: sistema, points: total, players: elegidos };
    });

    return mejor;
  }

  function renderBestXi(jornada) {
    const caja = $('jornada-best');
    const once = jornada && jornada.bestXi;
    const nuestro = jornada ? onceIdealDeLaLiga(jornada) : null;

    if ((!once || !once.players || once.players.length === 0) && !nuestro) {
      caja.hidden = true;
      caja.innerHTML = '';
      return;
    }

    const campo = function (titulo, datos, conDueno) {
      if (!datos || !datos.players || !datos.players.length) return '';
      return '<div class="once">' +
        '<div class="panel__head panel__head--center"><h2>' + titulo + '</h2>' +
          '<p class="muted">' + escapeHtml(datos.type || '') + (datos.type ? ' · ' : '') +
            '<strong>' + datos.points + ' puntos</strong></p></div>' +
        '<div class="pitch-wrap">' + staticPitch(datos.type, datos.players, conDueno) + '</div>' +
      '</div>';
    };

    caja.hidden = false;
    caja.innerHTML = '<div class="onces">' +
      /* También en el de toda LaLiga: si el futbolista es de alguno de los
         ocho, se ve su foto. Los que no son de nadie no llevan chapa, que
         `chapaDeManager` devuelve vacío cuando no tiene dueño. */
      campo('Once ideal', once, true) +
      campo('Once ideal de mi liga', nuestro, true) +
    '</div>';
  }

  function renderJornadas() {
    const cuerpo = $('rounds-body');
    const boton = $('jornada-pick');
    const jornada = jornadaActiva();

    /* El número manda: así el rótulo es «Jornada 3» aunque la API conteste en
       inglés. */
    renderBestXi(jornada);

    /* Los partidos van entre la clasificación y el once ideal, y se piden por
       el id de la jornada elegida: no hacen falta ni su clasificación ni sus
       alineaciones, que es lo que tardaba en llegar. */
    const cual = jornadaVistaId();
    if (cual != null) ensurePartidos(cual);
    renderPartidos();

    boton.textContent = jornada && jornada.round
      ? (jornada.round.number ? 'Jornada ' + jornada.round.number : (jornada.round.name || '—'))
      : '—';

    if (state.jornadaEstado === 'cargando' && !jornada) {
      cuerpo.innerHTML = '<tr><td colspan="6" class="muted">Cargando la jornada…</td></tr>';
      return;
    }
    if (!jornada) {
      cuerpo.innerHTML = '<tr><td colspan="6" class="muted">' +
        (state.jornadaEstado === 'error'
          ? 'No se ha podido traer la jornada.'
          : 'Sincroniza para traer la jornada.') + '</td></tr>';
      return;
    }

    const filas = sortJornada(jornada.standings || []);
    if (filas.length === 0) {
      cuerpo.innerHTML = '<tr><td colspan="6" class="muted">Esta jornada todavía no tiene clasificación.</td></tr>';
      return;
    }

    cuerpo.innerHTML = filas.map(function (fila, indice) {
      const abierta = state.jornadaAbierta === fila.id;
      const detalle = !abierta ? '' :
        '<tr class="detail-row"><td class="detail-cell" colspan="7"><div class="detail">' +
          jornadaDetalle(fila) + '</div></td></tr>';

      return '<tr class="' + (abierta ? 'row-open' : '') + '">' +
        '<td class="col-rank">' + (indice + 1) + '</td>' +
        '<td>' +
          '<button type="button" class="row-toggle" data-jornada-manager="' + escapeHtml(fila.id) + '"' +
            ' aria-expanded="' + (abierta ? 'true' : 'false') + '">' +
            '<span class="row-toggle__icon" aria-hidden="true">▸</span>' +
            '<span class="manager">' + avatar(fila.name) +
              '<span class="manager__name">' + escapeHtml(fila.name) + '</span></span>' +
          '</button></td>' +
        /* Con saldo negativo al empezar la jornada, esos puntos no le cuentan:
           se enseñan igual (como hace Biwenger) pero en rojo y avisando. */
        '<td class="num" data-label="Jornada"><strong' +
          (fila.counts === false
            ? ' class="no-cuenta" title="Empezó la jornada con saldo negativo: no puntúa"'
            : '') + '>' +
          (fila.points == null ? '—' : fila.points) + '</strong>' +
          /* Cuatro puntos menos por hueco sin cubrir: si no se dice, el total
             parece que está mal restado. */
          (fila.gaps ? '<span class="ranking__sub" title="' + fila.gaps +
            (fila.gaps === 1 ? ' hueco' : ' huecos') + ' en la alineación, a 4 puntos cada uno">−' +
            (fila.gaps * 4) + '</span>' : '') +
        '</td>' +
        '<td class="num" data-label="General">' + (function () {
          const total = puntosGenerales(fila.name);
          return total == null ? '<span class="sub">—</span>' : total;
        })() + '</td>' +
        '<td class="num" data-label="Jugadores">' +
          (fila.played == null ? '<span class="sub">—</span>' : fila.played) + '</td>' +
        '<td class="num" data-label="Valor del once">' +
          (fila.xiValue ? money(fila.xiValue) : '<span class="sub">—</span>') + '</td>' +
        '<td class="num" data-label="Abono">' + celdaAbono(fila) + '</td>' +
      '</tr>' + detalle;
    }).join('');

    updateRoundHeaders();
    renderJornadaChart();
  }

  /**
   * Lo que la liga le paga a un mánager por la jornada.
   *
   * Mientras la jornada sigue abierta esto es una previsión: Biwenger no abona
   * hasta el día siguiente de cerrarla. Se avisa en el título para que nadie
   * cuente con ese dinero antes de tiempo.
   */
  function celdaAbono(fila) {
    const abono = fila.abono;
    if (!abono) return '<span class="sub">—</span>';

    if (abono.motivo === 'negativo') {
      return '<span class="sub" title="Empezó la jornada con saldo negativo: ' +
        'no puntúa, y sin puntos no cobra nada de la jornada">' + money(0) + '</span>';
    }

    const partes = [];
    if (abono.puntos) partes.push(money(abono.puntos) + ' por puntos');
    if (abono.ideal) partes.push(money(abono.ideal) + ' del once ideal');
    if (abono.mvp) partes.push(money(abono.mvp) + ' por MVP');
    const cerrada = fila.pointsOfficial != null;

    return '<span class="' + (abono.total < 0 ? 'money-neg' : 'money-pos') +
      '" title="' + escapeHtml((partes.join(' + ') || 'Sin abono') + '. ' +
        (cerrada ? 'Jornada cerrada: es lo que ha pagado.'
                 : 'Previsión: la jornada aún no ha cerrado.')) + '">' +
      (abono.total > 0 ? '+' : '') + money(abono.total) + '</span>';
  }

  function updateRoundHeaders() {
    const jornada = jornadaActiva();
    const sort = ordenDeJornada(jornada ? jornada.standings : []);
    Array.prototype.forEach.call(document.querySelectorAll('[data-round-sort]'), function (th) {
      const key = th.getAttribute('data-round-sort');
      th.setAttribute('aria-sort', key !== sort.key ? 'none' : (sort.dir === 1 ? 'ascending' : 'descending'));
    });
  }

  /** Menú de jornadas, con el mismo formato que el del campo. */
  function renderJornadaPicker() {
    const caja = $('jornada-picker');
    if (!state.pickerJornada) { caja.hidden = true; caja.innerHTML = ''; return; }

    /* La liga tiene 38 jornadas. Biwenger añade una entrada más por cada
       jornada aplazada (su segunda parte, con los mismos diez partidos que
       la primera): no es una jornada aparte que jugar, así que no se elige
       nunca desde aquí, tenga o no algo guardado de una consulta antigua. */
    const todas = state.jornadas.list.length
      ? state.jornadas.list
      : Object.keys(state.jornadas.datos).map(function (id) {
          return state.jornadas.datos[id].round;
        });
    const lista = todas.filter(function (round) {
      return (round.part || 1) === 1;
    }).sort(function (a, b) {
      return (a.number || 0) - (b.number || 0);
    });

    const vista = jornadaActiva();
    const actual = vista && vista.round ? vista.round.id : null;

    const cartas = lista.map(function (round) {
      const guardada = !!state.jornadas.datos[round.id];
      const jugada = guardada && (state.jornadas.datos[round.id].standings || [])
        .some(function (fila) { return (fila.xi || []).length; });
      return '<button type="button" class="picker__player jornada-card' +
        (String(round.id) === String(actual) ? ' is-current' : '') + '"' +
        ' data-jornada="' + escapeHtml(String(round.id)) + '">' +
        '<span class="jornada-card__num">J' + (round.number || '?') + '</span>' +
        '<span class="picker__meta">' + (jugada ? 'guardada' : (round.status === 'pending' ? 'pendiente' : '—')) + '</span>' +
      '</button>';
    }).join('');

    caja.hidden = false;
    caja.innerHTML =
      '<div class="picker__backdrop" data-picker-close></div>' +
      '<div class="picker__card" role="dialog" aria-modal="true" aria-label="Elegir jornada">' +
        '<div class="picker__head"><strong>Jornada</strong>' +
          '<button type="button" class="btn btn--ghost btn--close" data-picker-close' +
              ' title="Cerrar" aria-label="Cerrar">✕</button>' +
        '</div>' +
        (cartas ? '<div class="picker__grid picker__grid--rounds">' + cartas + '</div>'
                : '<p class="muted">Todavía no hay jornadas: sincroniza primero.</p>') +
      '</div>';
  }

  /* ---------- Pestaña de jugadores ---------- */

  /** Récords de un jugador: sus operaciones extremas. */
  function managerRecords(name) {
    const moves = state.movements.filter(function (movement) { return movement.manager === name; });
    const buys = moves.filter(function (movement) { return movement.type === 'buy'; });
    const sells = moves.filter(function (movement) { return movement.type === 'sell'; });
    const top = function (list, sign) {
      if (list.length === 0) return null;
      return list.slice().sort(function (a, b) { return sign * (b.amount - a.amount); })[0];
    };
    return {
      buys: buys,
      sells: sells,
      costliestBuy: top(buys, 1),
      cheapestBuy: top(buys, -1),
      bestSell: top(sells, 1),
      worstSell: top(sells, -1),
      avgBuy: buys.length ? buys.reduce(function (s, m) { return s + m.amount; }, 0) / buys.length : null,
      avgSell: sells.length ? sells.reduce(function (s, m) { return s + m.amount; }, 0) / sells.length : null
    };
  }

  function recordCell(label, movement) {
    if (!movement) return '<div class="record"><span class="record__label">' + label + '</span><span class="unknown">—</span></div>';
    return '<div class="record"><span class="record__label">' + label + '</span>' +
      '<span class="record__player">' + escapeHtml(movement.player) + '</span>' +
      '<strong class="record__amount">' + money(movement.amount) + '</strong></div>';
  }

  /* #, Jugador, Puntos, Valor equipo, Jug., Saldo, Puja máxima y Última conexión. */
  const MANAGER_COLUMNS = 8;

  /**
   * Clasificación: por puntos y, a igualdad, por Valor de Equipo + Saldo, que
   * es el desempate oficial de Biwenger para el campeón de la temporada.
   * Antes se miraba solo el valor de equipo y dejaba fuera el saldo.
   */
  function managerRows() {
    const sort = state.sort.managers;
    const rows = computeBudgets(state.movements, state.teams);
    if (sort.key) return sortRows(rows, 'managers', sort);
    const patrimonio = function (fila) {
      return (fila.teamValue || 0) +
        (fila.officialBalance != null ? fila.officialBalance : (fila.balance || 0));
    };
    return rows.slice().sort(function (a, b) {
      const points = (b.points || 0) - (a.points || 0);
      return points || (patrimonio(b) - patrimonio(a));
    });
  }

  function renderManagers() {
    updateSortHeaders('managers', state.sort.managers);

    $('managers-body').innerHTML = managerRows().map(function (row, index) {
      const open = state.expandedManager === row.name;
      const abiertoPuntos = state.expandedPoints === row.name;
      return '<tr class="' + (open || abiertoPuntos ? 'row-open' : '') + '">' +
        '<td class="col-rank">' + (index + 1) + '</td>' +
        '<td data-label="Futbolista">' +
          '<button type="button" class="row-toggle" data-manager-card="' + escapeHtml(row.name) + '"' +
            ' aria-expanded="' + (open ? 'true' : 'false') + '">' +
            '<span class="row-toggle__icon" aria-hidden="true">▸</span>' +
            '<span class="manager">' + avatar(row.name) +
              '<span class="manager__name">' + escapeHtml(row.name) + '</span></span>' +
          '</button></td>' +
        '<td class="num" data-label="Puntos">' +
          '<button type="button" class="puntos-toggle" data-manager-points="' + escapeHtml(row.name) + '"' +
            ' aria-expanded="' + (abiertoPuntos ? 'true' : 'false') + '"' +
            ' title="Ver los puntos de cada futbolista">' +
            '<strong>' + (row.points == null ? '—' : row.points) + '</strong>' +
          '</button></td>' +
        '<td class="num" data-label="Valor equipo">' +
          (row.teamValue == null ? '<span class="unknown">—</span>' : money(row.teamValue)) + '</td>' +
        '<td class="num" data-label="Jug.">' + (row.players == null ? '—' : row.players) + '</td>' +
        '<td class="num" data-label="Saldo"><span class="' + (row.balance < 0 ? 'money-neg' : '') + '">' +
          money(row.balance) + '</span></td>' +
        '<td class="num" data-label="Puja máxima"><strong class="bid-amount">' +
          (row.maxBid == null ? '—' : money(row.maxBid)) + '</strong></td>' +
        '<td data-label="Última conexión">' + sinceCell(row.lastAccess) + '</td>' +
      '</tr>' + (abiertoPuntos ? panelDePuntos(row) : '') + (open ? managerPanel(row) : '');
    }).join('');
  }

  /**
   * Lo que ha puntuado cada futbolista de una plantilla, de más a menos, con
   * los partidos que lleva jugados.
   */
  function panelDePuntos(row) {
    /* Solo los que ha alineado, y con lo que hicieron estando alineados. */
    const suyos = futbolistasAlineados(row.name)
      .sort(function (a, b) { return b.points - a.points; });

    const cuerpo = suyos.length === 0
      ? '<p class="muted">Todavía no hay jornadas guardadas con su alineación.</p>'
      : '<table class="detail-table"><thead><tr>' +
          '<th class="detail-rank">Pos.</th><th>Futbolista</th>' +
          '<th class="num">Puntos</th><th class="num">Partidos</th>' +
        '</tr></thead><tbody>' +
        suyos.map(function (jugador) {
          const clave = 'plantilla:' + row.name + ':' + jugador.id;
          const abierto = state.puntosDetalle === clave;
          return '<tr class="fila-puntos' + (abierto ? ' row-open' : '') + '"' +
              ' data-puntos="' + escapeHtml(clave) + '">' +
            '<td class="detail-rank">' +
              (jugador.position ? POSITION_NAMES[jugador.position] : '—') + '</td>' +
            '<td><span class="with-crest">' +
              playerName({ playerId: jugador.id, player: jugador.name,
                position: jugador.position, altPositions: jugador.altPositions }) +
              crestOf(jugador, 'crest--badge') + '</span></td>' +
            '<td class="num"><strong>' + jugador.points + '</strong></td>' +
            '<td class="num">' + jugador.played + '</td>' +
          '</tr>' +
          (abierto
            ? '<tr class="detail-row"><td class="detail-cell" colspan="4">' +
              graficoDePuntos(jugador) + '</td></tr>'
            : '');
        }).join('') + '</tbody></table>';

    return '<tr class="detail-row"><td class="detail-cell" colspan="' + MANAGER_COLUMNS + '"><div class="detail">' +
      '<h3 class="bench__title">Puntos por futbolista alineado</h3>' + cuerpo +
    '</div></td></tr>';
  }

  /** Ficha completa de un jugador: cifras, récords y gráficos. */
  function managerPanel(row) {
    const stats = managerRecords(row.name);

    return '<tr class="detail-row"><td class="detail-cell" colspan="' + MANAGER_COLUMNS + '">' +
      '<div class="detail detail--manager">' +
        '<div class="manager-card__stats">' +
          '<div class="stat"><span class="stat__label">Fichajes</span><strong>' + row.buys + '</strong></div>' +
          '<div class="stat"><span class="stat__label">Ventas</span><strong>' + row.sells + '</strong></div>' +
          '<div class="stat"><span class="stat__label">Gastado</span><strong class="money-neg">' + money(row.spent) + '</strong></div>' +
          '<div class="stat"><span class="stat__label">Ingresado</span><strong class="money-pos">' + money(row.earned) + '</strong></div>' +
          '<div class="stat"><span class="stat__label">Valor equipo</span><strong>' +
            (row.teamValue == null ? '—' : money(row.teamValue)) + '</strong></div>' +
          '<div class="stat stat--bid"><span class="stat__label">Puja máxima</span><strong>' +
            (row.maxBid == null ? '—' : money(row.maxBid)) + '</strong></div>' +
          '<div class="stat" title="Media por fichaje"><span class="stat__label">Media fichaje</span><strong>' +
            (stats.avgBuy == null ? '—' : money(stats.avgBuy)) + '</strong></div>' +
          '<div class="stat" title="Media por venta"><span class="stat__label">Media venta</span><strong>' +
            (stats.avgSell == null ? '—' : money(stats.avgSell)) + '</strong></div>' +
        '</div>' +

        '<div class="records">' +
          recordCell('Fichaje más caro', stats.costliestBuy) +
          recordCell('Fichaje más barato', stats.cheapestBuy) +
          recordCell('Venta más cara', stats.bestSell) +
          recordCell('Venta más barata', stats.worstSell) +
        '</div>' +

        managerCharts(row.name) +
      '</div></td></tr>';
  }

  /* ---------- Plantillas ---------- */

  /* La plantilla se ordena por demarcación (portero, defensas, medios,
     delanteros) salvo que pulses otra cabecera. */
  function sortSquad(players) {
    const sort = state.sort.squad;
    const list = players.slice();

    if (!sort.key || sort.key === 'position') {
      const dir = sort.key === 'position' ? sort.dir : 1;
      return list.sort(function (a, b) {
        const diff = ((a.position || 9) - (b.position || 9)) * dir;
        return diff || (b.marketValue || 0) - (a.marketValue || 0);
      });
    }

    return list.sort(function (a, b) {
      const value = function (player) {
        if (sort.key === 'name') return player.name;
        if (sort.key === 'since') return player.since;
        if (sort.key === 'diff') {
          return player.paid == null || player.marketValue == null ? null : player.marketValue - player.paid;
        }
        return player[sort.key];
      };
      const x = value(a);
      const y = value(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      const cmp = typeof x === 'string' ? String(x).localeCompare(String(y), 'es') : x - y;
      return cmp * sort.dir;
    });
  }

  function squadColumn(key, label, cls) {
    const sort = state.sort.squad;
    const active = sort.key === key || (!sort.key && key === 'position');
    return '<th class="' + cls + ' sortable" data-squad-sort="' + key + '" tabindex="0" aria-sort="' +
      (active ? (sort.dir === 1 || !sort.key ? 'ascending' : 'descending') : 'none') + '">' + label + '</th>';
  }

  /* Los jugadores del reparto inicial no tienen precio de compra, así que para
     saber cuánto se han revalorizado hay que preguntar qué valían aquel día.
     Se pide solo de la plantilla que se abre, para no cargar de golpe. */
  function ensureStartPrices(squad) {
    const config = loadSyncConfig();
    if (!config.url || !config.key || !squad) return;

    const faltan = (squad.players || []).filter(function (player) {
      return player.paid == null && player.since && state.startPrices[player.id] === undefined;
    });
    if (faltan.length === 0) return;

    // Se marcan como pedidos para no repetir la consulta en cada repintado.
    faltan.forEach(function (player) { state.startPrices[player.id] = null; });

    const dia = faltan[0].since;
    const ids = faltan.map(function (player) { return player.id; }).join(',');

    fetch(config.url.replace(/\/+$/, '') + '/?key=' + encodeURIComponent(config.key) +
      '&precios=' + encodeURIComponent(ids) + '&dia=' + encodeURIComponent(dia),
      { headers: { 'accept': 'application/json' } })
      .then(function (response) { return response.json(); })
      .then(function (payload) {
        if (!payload || payload.error) return;
        Object.keys(payload).forEach(function (id) { state.startPrices[id] = payload[id]; });
        renderSquads();
      })
      .catch(function () { /* se queda sin dato */ });
  }

  /** Los últimos `n` días de una serie. */
  function ultimos(serie, n) {
    return serie && serie.length > n ? serie.slice(-n) : serie;
  }

  /** Cuánto ha cambiado el precio en los últimos `dias`, si hay tanto histórico. */
  function variacion(serie, dias) {
    if (!serie || serie.length < 2) return null;
    /* Un dato por día: si la serie no llega, ese periodo no se muestra. */
    if (serie.length <= dias) return null;
    const desde = serie[serie.length - 1 - dias][1];
    const hasta = serie[serie.length - 1][1];
    return hasta - desde;
  }

  const PERIODOS = [
    { label: '6m', dias: 180 },
    { label: '3m', dias: 90 },
    { label: '1m', dias: 30 },
    { label: '15d', dias: 15 },
    { label: '7d', dias: 7 },
    { label: '3d', dias: 3 },
    /* De ayer a hoy: lo primero que se mira cuando abre el mercado. */
    { label: '1d', dias: 1 }
  ];

  /** Importe corto, para las filas donde no cabe la cifra entera. */
  function compactMoney(n) {
    const valor = Math.abs(n);
    if (valor >= 1000000) return (Math.round(valor / 100000) / 10).toFixed(1).replace('.', ',') + 'M';
    if (valor >= 1000) return Math.round(valor / 1000) + 'k';
    return String(Math.round(valor));
  }

  /* Minigráfica de la evolución del precio, sin ejes ni números: solo la
     forma, en verde si acaba por encima de como empezó y en rojo si no. */
  function sparkline(serie, id, nombre) {
    if (!serie || serie.length < 2) return '<span class="sub">—</span>';

    const W = 76, H = 22, pad = 2;
    const valores = serie.map(function (par) { return par[1]; });
    const min = Math.min.apply(null, valores);
    const max = Math.max.apply(null, valores);
    const span = (max - min) || 1;

    const puntos = serie.map(function (par, i) {
      const x = pad + (i * (W - pad * 2)) / (serie.length - 1);
      const y = pad + (1 - (par[1] - min) / span) * (H - pad * 2);
      return x.toFixed(1) + ' ' + y.toFixed(1);
    });

    const sube = valores[valores.length - 1] >= valores[0];
    const color = sube ? 'var(--pos)' : 'var(--neg)';
    const diferencia = valores[valores.length - 1] - valores[0];

    return '<button type="button" class="spark" data-spark="' + escapeHtml(String(id || '')) + '"' +
      ' data-spark-name="' + escapeHtml(nombre || '') + '"' +
      ' title="' + serie.length + ' días · ' +
      (diferencia >= 0 ? '+' : '−') + money(Math.abs(diferencia)) + ' · pulsa para ampliar">' +
      '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" aria-hidden="true">' +
      '<polyline points="' + puntos.join(' ') + '" fill="none" stroke="' + color +
      '" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"' +
      ' vector-effect="non-scaling-stroke"></polyline>' +
      '<circle cx="' + puntos[puntos.length - 1].split(' ')[0] + '" cy="' +
      puntos[puntos.length - 1].split(' ')[1] + '" r="1.8" fill="' + color + '"></circle>' +
      '</svg></button>';
  }

  /** Pide la evolución de precio de una lista de futbolistas, por tandas. */
  function ensurePriceSeries(ids, alTerminar) {
    const config = loadSyncConfig();
    if (!config.url || !config.key) return;

    const faltan = (ids || []).filter(function (id) {
      return id && state.priceSeries[id] === undefined;
    });
    if (faltan.length === 0) return;
    faltan.forEach(function (id) { state.priceSeries[id] = null; });

    /* El Worker atiende 30 por consulta: el mercado entero va en dos o tres. */
    for (let i = 0; i < faltan.length; i += 25) {
      const tanda = faltan.slice(i, i + 25);
      fetch(config.url.replace(/\/+$/, '') + '/?key=' + encodeURIComponent(config.key) +
        /* La serie entera: desde que el futbolista salió al mercado. */
        '&historial=' + encodeURIComponent(tanda.join(',')) + '&dias=todo',
        { headers: { 'accept': 'application/json' } })
        .then(function (response) { return response.json(); })
        .then(function (payload) {
          if (!payload || payload.error) return;
          Object.keys(payload).forEach(function (id) { state.priceSeries[id] = payload[id]; });
          if (alTerminar) alTerminar();
        })
        .catch(function () { /* sin evolución */ });
    }
  }

  /* Los precios vienen con la fecha como 260814; el resto de la calculadora
     trabaja con 2026-08-14. */
  function stampToDay(stamp) {
    const texto = String(stamp);
    return '20' + texto.slice(0, 2) + '-' + texto.slice(2, 4) + '-' + texto.slice(4, 6);
  }

  /** Reúne en un solo sitio lo que cada pestaña sabe de un futbolista. */
  function playerInfo(id) {
    const clave = String(id);
    const ficha = { id: clave, name: null, position: null, status: null, team: null, teamName: null,
      marketValue: null, increment: 0, points: null };

    const enPlantilla = (function () {
      const squads = squadList();
      for (let i = 0; i < squads.length; i++) {
        const players = squads[i].players || [];
        for (let j = 0; j < players.length; j++) {
          if (String(players[j].id) === clave) return { squad: squads[i], player: players[j] };
        }
      }
      return null;
    })();

    if (enPlantilla) {
      const p = enPlantilla.player;
      ficha.name = p.name; ficha.position = p.position; ficha.status = p.status;
      ficha.team = p.team; ficha.teamName = p.teamName;
      ficha.marketValue = p.marketValue; ficha.increment = p.increment || 0;
      ficha.points = p.points;
      ficha.owner = enPlantilla.squad.name;
    }

    const enMercado = (state.market || []).filter(function (v) { return String(v.playerId) === clave; })[0];
    if (enMercado) {
      ficha.name = ficha.name || enMercado.player;
      ficha.position = ficha.position != null ? ficha.position : enMercado.position;
      ficha.status = ficha.status || enMercado.status;
      ficha.team = ficha.team != null ? ficha.team : enMercado.team;
      ficha.teamName = ficha.teamName || enMercado.teamName;
      ficha.marketValue = ficha.marketValue != null ? ficha.marketValue : enMercado.marketValue;
      ficha.increment = ficha.increment || enMercado.increment || 0;
      ficha.points = ficha.points != null ? ficha.points : enMercado.points;
      ficha.enVenta = enMercado;
    }

    const enTablon = state.movements.filter(function (m) { return String(m.playerId) === clave; });
    if (enTablon.length) {
      ficha.name = ficha.name || enTablon[0].player;
      ficha.position = ficha.position != null ? ficha.position : enTablon[0].position;
      ficha.status = ficha.status || enTablon[0].status;
      ficha.points = ficha.points != null ? ficha.points : enTablon[0].points;
      ficha.marketValue = ficha.marketValue != null ? ficha.marketValue : enTablon[0].marketValue;
      ficha.team = ficha.team != null ? ficha.team : enTablon[0].team;
      ficha.teamName = ficha.teamName || enTablon[0].teamName;
    }
    /* Y si no está ni en plantillas, ni en el mercado, ni en el tablón, se mira
       la lista completa de la competición, que la tiene la pestaña Jugadores. */
    const enLista = (state.jugadores || []).filter(function (j) { return String(j.id) === clave; })[0];
    if (enLista) {
      ficha.name = ficha.name || enLista.name;
      ficha.position = ficha.position != null ? ficha.position : enLista.position;
      ficha.status = ficha.status || enLista.status;
      ficha.team = ficha.team != null ? ficha.team : enLista.team;
      ficha.teamName = ficha.teamName || enLista.teamName;
      ficha.marketValue = ficha.marketValue != null ? ficha.marketValue : enLista.marketValue;
      ficha.points = ficha.points != null ? ficha.points : enLista.points;
    }

    ficha.moves = enTablon.slice().sort(function (a, b) { return (b.timestamp || 0) - (a.timestamp || 0); });

    return ficha;
  }

  /** Busca en las plantillas cómo y cuándo llegó ese futbolista, y a quién. */
  function acquisitionOf(playerId) {
    const squads = squadList();
    for (let i = 0; i < squads.length; i++) {
      const players = squads[i].players || [];
      for (let j = 0; j < players.length; j++) {
        if (String(players[j].id) === String(playerId)) {
          return {
            owner: squads[i].name,
            since: players[j].since || null,
            paid: players[j].paid,
            from: players[j].from || null
          };
        }
      }
    }
    return null;
  }

  /**
   * Sigue el ratón por el gráfico y va cantando el precio de cada día: con 45
   * puntos, dar con el círculo exacto es imposible.
   */
  function bindChartHover(caja, puntos, llegada) {
    if (!caja || puntos.length < 2) return;
    const svg = caja.querySelector('svg');
    const tip = caja.querySelector('.viz-tip');
    if (!svg || !tip) return;

    const W = Number(svg.getAttribute('data-w'));
    const padX = Number(svg.getAttribute('data-padx'));
    const util = W - padX - 12;
    const cruz = svg.querySelector('.viz__cross');
    const bola = svg.querySelector('.viz__cursor');
    const circulos = svg.querySelectorAll('.viz__dot');

    if (llegada) {
      llegada.indice = puntos.map(function (punto) { return punto.day; }).indexOf(llegada.day);
    }

    const mover = function (event) {
      const donde = event.touches ? event.touches[0] : event;
      const marco = svg.getBoundingClientRect();
      const x = ((donde.clientX - marco.left) * W) / marco.width;

      let i = Math.round(((x - padX) * (puntos.length - 1)) / util);
      i = Math.max(0, Math.min(puntos.length - 1, i));

      /* Con un año de precios cada día ocupa poco más de un píxel, así que el
         día de la llegada atrae al cursor si se pasa cerca. */
      if (llegada && llegada.indice >= 0 && Math.abs(i - llegada.indice) <= 2) i = llegada.indice;

      const dato = puntos[i];
      const punto = circulos[i];
      if (!punto) return;

      const cx = punto.getAttribute('cx');
      cruz.setAttribute('x1', cx);
      cruz.setAttribute('x2', cx);
      cruz.hidden = false;
      bola.setAttribute('cx', cx);
      bola.setAttribute('cy', punto.getAttribute('cy'));
      bola.hidden = false;

      /* Justo en el día de la llegada se cuenta la historia completa. */
      tip.innerHTML = (llegada && dato.day === llegada.day)
        ? '<span class="viz-tip__llegada">' + llegada.texto + '</span>'
        : '<span class="viz-tip__day">' + escapeHtml(shortDay(dato.day)) + '</span>' +
          '<strong>' + money(dato.price) + '</strong>';
      tip.classList.toggle('viz-tip--llegada', !!(llegada && dato.day === llegada.day));
      tip.hidden = false;

      const enPantalla = (Number(cx) / W) * marco.width;
      const tope = marco.width - tip.offsetWidth - 4;
      tip.style.left = Math.max(4, Math.min(tope, enPantalla - tip.offsetWidth / 2)) + 'px';
    };

    const salir = function () {
      tip.hidden = true;
      cruz.hidden = true;
      bola.hidden = true;
    };

    caja.addEventListener('mousemove', mover);
    caja.addEventListener('touchmove', mover, { passive: true });
    caja.addEventListener('mouseleave', salir);
    caja.addEventListener('touchend', salir);
  }

  /**
   * Lo que lleva el futbolista esta temporada. Los lances van con el mismo
   * icono que en los partidos; lo dem\u00e1s, con su nombre debajo.
   */
  function estadisticasDeTemporada(id) {
    const datos = state.estadisticas[String(id)];
    /* Mientras no estén (o si no llegan) no se dice nada: aparecen solas al
       llegar, y anunciarlo solo ensucia la ficha. Ojo con «pidiendo», que es
       texto y pasaría por bueno pintando la ficha entera a cero. */
    if (!datos || datos === 'pidiendo') return '';

    /* Sin partidos se ense\u00f1an los mismos huecos a cero: la ficha se lee igual
       antes y despu\u00e9s de que el futbolista juegue. */
    const numero = function (valor) { return valor == null ? 0 : valor; };
    /* Con coma, como se escriben los decimales aquí. */
    const decimal = function (valor) { return (valor == null ? 0 : valor).toFixed(1).replace('.', ','); };

    const celda = function (rotulo, valor, extra) {
      return '<div class="stat' + (extra ? ' ' + extra : '') + '">' +
        '<span class="stat__label">' + rotulo + '</span>' +
        '<strong>' + valor + '</strong></div>';
    };

    /* Las porter\u00edas a cero solo dicen algo de porteros y defensas; los goles
       por partido, de medios y delanteros. */
    const portero = datos.position === 1;
    const atras = portero || datos.position === 2;

    /* Cada cuántos minutos marca; sin goles no hay proporción que dar. */
    const golCada = function (d) {
      if (!d.goals || !d.minutes) return '—';
      return Math.round(d.minutes / d.goals) + ' min';
    };

    return '<div class="stats">' +
      '<div class="stats__grupo">' +
        '<h4 class="stats__titulo">Participaci\u00f3n</h4>' +
        '<div class="stats__rejilla">' +
          celda('Partidos', numero(datos.played)) +
          celda('Minutos', numero(datos.minutes)) +
          celda('Titular', numero(datos.played) - numero(datos.subsIn)) +
          celda('Suplente', numero(datos.subsIn)) +
          celda('Cambio', numero(datos.subsOut)) +
        '</div>' +
      '</div>' +

      '<div class="stats__grupo">' +
        '<h4 class="stats__titulo">Juego</h4>' +
        '<div class="stats__rejilla">' +
          /* Al portero le interesan los goles que le meten, no los que mete. */
          (portero ? celda('Goles encajados', numero(datos.conceded))
                   : celda('Goles', numero(datos.goals))) +
          (atras ? celda('Porterías a cero', numero(datos.cleanSheets)) +
                   /* Al defensa también le cuentan los que encaja; al portero
                      ya se los hemos puesto arriba. */
                   (portero ? '' : celda('Goles encajados', numero(datos.conceded)))
                 : celda('Gol cada', golCada(datos)) +
                   celda('Media goles p/p', decimal(datos.goalsPerGame))) +
          celda('Asistencias', numero(datos.assists)) +
          /* Cuántos ganó jugando él: lo mandaba el servidor y no se enseñaba. */
          celda('Ganados', numero(datos.wins)) +
          celda('Amarillas', numero(datos.yellow)) +
          celda('Rojas', numero(datos.red)) +
      '</div>' +
      '</div>' +

      '<div class="stats__grupo">' +
        '<h4 class="stats__titulo">Puntos</h4>' +
        '<div class="stats__rejilla">' +
          celda('Totales', numero(datos.points)) +
          celda('Media', decimal(datos.average)) +
          celda('Casa', numero(datos.home.points)) +
          celda('Media casa', decimal(datos.home.average)) +
          celda('Fuera', numero(datos.away.points)) +
          celda('Media fuera', decimal(datos.away.average)) +
        '</div>' +
      '</div>' +
    '</div>';
  }

  /** Pide las estad\u00edsticas de un futbolista; se guardan mientras dure la sesi\u00f3n. */
  /**
   * Abre la ficha del futbolista al que pertenece lo que se ha pulsado. Dice si
   * la ha abierto, para que quien llame pueda parar ahí.
   */
  function abrirFicha(donde) {
    const quien = donde && donde.closest && donde.closest('[data-player-id]');
    if (!quien || !quien.getAttribute('data-player-id')) return false;

    const nombre = quien.querySelector('.player-name');
    state.priceModal = {
      id: quien.getAttribute('data-player-id'),
      name: nombre ? nombre.textContent : ''
    };
    ensurePriceSeries([state.priceModal.id], renderPriceModal);
    ensureEstadisticas(state.priceModal.id);
    renderPriceModal();
    return true;
  }

  /** Los puntos jornada a jornada del futbolista, en el mismo gráfico de barras. */
  function rachaDeTemporada(id) {
    const datos = state.estadisticas[String(id)];
    if (!datos || !(datos.rounds || []).length) return '';
    return '<h4 class="stats__titulo">Puntos por jornada</h4>' +
      graficoDePuntos({ rounds: datos.rounds, points: datos.points });
  }

  function ensureEstadisticas(id) {
    const config = loadSyncConfig();
    if (!config.url || !config.key || id == null) return;
    const clave = String(id);
    if (state.estadisticas[clave] !== undefined) return;

    /* Se marca como pedida para no repetir la llamada en cada repintado.
       Con `undefined` no valía: es lo mismo que devuelve una clave que no
       existe, así que el guardia de arriba no frenaba nada y la misma ficha
       se pedía una vez por repintado. */
    state.estadisticas[clave] = 'pidiendo';
    fetch(config.url.replace(/\/+$/, '') + '/?key=' + encodeURIComponent(config.key) +
      '&estadisticas=' + encodeURIComponent(clave), { headers: { 'accept': 'application/json' } })
      .then(function (response) { return response.json(); })
      .then(function (payload) {
        state.estadisticas[clave] = payload && payload.error ? null : payload;
        state.estadisticasAt = Date.now();
        renderPriceModal();
        /* Puede estar abierta dentro de un ranking en vez de en la ficha. */
        if (state.datosDetalle) renderRankingsTemporada();
      })
      .catch(function () {
        state.estadisticas[clave] = null;
        renderPriceModal();
      });
  }

  /** Las operaciones de ese futbolista en la liga, de la más reciente atrás. */
  function playerHistory(ficha) {
    /* Sin operaciones no se dice nada: el hueco vacío ya lo cuenta. */
    if (!ficha.moves || ficha.moves.length === 0) return '';
    return '<table class="detail-table ficha__historial"><tbody>' +
      ficha.moves.map(function (movimiento) {
        const compra = movimiento.type === 'buy';
        return '<tr>' +
          '<td class="detail-date">' + escapeHtml(movimiento.date || '—') + '</td>' +
          '<td>' + etiquetaDeOperacion(movimiento) + '</td>' +
          '<td>' + (movimiento.manager
            ? '<span class="manager">' + avatar(movimiento.manager) +
              '<span class="manager__name">' + escapeHtml(movimiento.manager) + '</span></span>'
            : '<span class="sub">—</span>') + '</td>' +
          '<td class="num"><strong class="' + (compra ? 'money-neg' : 'money-pos') + '">' +
            (compra ? '−' : '+') + money(movimiento.amount) + '</strong></td>' +
        '</tr>';
      }).join('') + '</tbody></table>';
  }

  /**
   * Deja la ficha centrada en lo que se est\u00e1 viendo.
   *
   * En el m\u00f3vil la p\u00e1gina se dibuja a 1024 px y el navegador la escala, as\u00ed que
   * una ventana `fixed` se centra respecto a esa p\u00e1gina entera y aparece a
   * media altura, lejos del futbolista que se ha pulsado. Con `visualViewport`
   * se sabe qu\u00e9 trozo se ve de verdad y la ficha se coloca justo ah\u00ed.
   */
  function ajustarFichaALaVista() {
    const caja = $('price-modal');
    if (!caja || caja.hidden) return;

    const vista = window.visualViewport;
    if (!vista) return;                    // sin soporte, el centrado normal vale

    caja.style.top = vista.offsetTop + 'px';
    caja.style.left = vista.offsetLeft + 'px';
    caja.style.width = vista.width + 'px';
    caja.style.height = vista.height + 'px';
    caja.style.right = 'auto';
    caja.style.bottom = 'auto';
  }

  /** Ficha del futbolista: quién lo tiene, cuánto vale y por dónde ha pasado. */
  /** El día en que se tocó un precio, escrito en corto: «14 ago 2026». */
  function diaLargo(dia) {
    const fecha = new Date(dia + 'T12:00:00');
    return isNaN(fecha) ? dia : fecha.toLocaleDateString('es-ES',
      { day: 'numeric', month: 'short', year: 'numeric' });
  }

  /** Máximo y mínimo históricos de la serie de precios, con su fecha. */
  function topesDePrecio(puntos) {
    if (!puntos || puntos.length < 2) return '';

    let alto = puntos[0];
    let bajo = puntos[0];
    puntos.forEach(function (punto) {
      if (punto.price > alto.price) alto = punto;
      if (punto.price < bajo.price) bajo = punto;
    });

    const celda = function (rotulo, punto, clase) {
      return '<span class="tope"><span class="tope__label">' + rotulo + '</span>' +
        '<strong class="' + clase + '">' + money(punto.price) + '</strong>' +
        '<span class="sub">' + escapeHtml(diaLargo(punto.day)) + '</span></span>';
    };

    return '<div class="topes">' +
      celda('Máximo', alto, 'money-pos') +
      celda('Mínimo', bajo, 'money-neg') +
    '</div>';
  }

  /** Lista para elegir con quién comparar, con su buscador. */
  function selectorDeComparacion(id) {
    const busca = normalize(state.priceModal.busca || '');
    const suyo = playerInfo(id);
    const puesto = suyo && suyo.position != null
      ? suyo.position
      : posicionConocida[String(id)];

    const candidatos = (state.jugadores || []).filter(function (j) {
      if (String(j.id) === String(id)) return false;
      if (busca) {
        return normalize(j.name).indexOf(busca) !== -1 ||
          normalize(j.teamName || '').indexOf(busca) !== -1;
      }
      /* Sin buscar nada, se proponen los de su misma demarcación: comparar un
         portero con un delantero no dice gran cosa. */
      if (puesto == null) return true;
      return j.position === puesto ||
        (j.altPositions || []).indexOf(puesto) !== -1;
    });

    const todos = candidatos.slice(0, 24);

    return '<div class="comparar">' +
      '<div class="comparar__barra">' +
        '<input type="search" id="comparar-buscar" class="field" placeholder="Buscar futbolista…"' +
          ' value="' + escapeHtml(state.priceModal.busca || '') + '">' +
        '<button type="button" class="btn btn--ghost btn--close" data-comparar-cerrar' +
          ' title="Cerrar" aria-label="Cerrar">✕</button>' +
      '</div>' +
      (state.jugadores
        ? (todos.length
            ? '<div class="comparar__lista">' + todos.map(function (j) {
                return '<button type="button" class="comparar__uno" data-comparar-con="' +
                  escapeHtml(String(j.id)) + '">' +
                  faceOf(j.id, 'picker__face') +
                  '<span class="comparar__nombre">' + escapeHtml(j.name) + '</span>' +
                  '<span class="sub">' + escapeHtml(j.teamName || '') + '</span>' +
                '</button>';
              }).join('') + '</div>'
            : '<p class="muted">Ningún futbolista con ese nombre.</p>')
        : '<p class="muted">Cargando futbolistas\u2026</p>') +
    '</div>';
  }

  /**
   * La evolución del precio de los dos comparados, en el mismo gráfico y cada
   * uno de su color, con sus cifras debajo también enfrentadas.
   *
   * Enseñar solo la línea de uno mientras se comparan dos engañaba, así que o
   * salen los dos o no sale ninguno.
   */
  function graficoDePreciosComparados(unoId, otroId) {
    const serieUno = state.priceSeries[String(unoId)];
    const serieOtro = state.priceSeries[String(otroId)];
    if (serieUno === undefined || serieOtro === undefined) {
      return '<p class="muted">Cargando la evolución…</p>';
    }
    if (!(serieUno || []).length || !(serieOtro || []).length) {
      return '<p class="viz__empty">Biwenger no publica la evolución de alguno de los dos.</p>';
    }

    const uno = playerInfo(unoId);
    const otro = playerInfo(otroId);
    const COLOR_UNO = '#2a78d6';
    const COLOR_OTRO = '#e08b14';

    /* Los dos precios en el mismo punto de cada día, que es lo que espera el
       gráfico para pintar dos líneas. */
    const porDia = {};
    (serieUno || []).forEach(function (par) {
      const dia = stampToDay(par[0]);
      (porDia[dia] = porDia[dia] || { day: dia }).unoPrice = par[1];
    });
    (serieOtro || []).forEach(function (par) {
      const dia = stampToDay(par[0]);
      (porDia[dia] = porDia[dia] || { day: dia }).otroPrice = par[1];
    });
    const puntos = Object.keys(porDia).sort().map(function (d) { return porDia[d]; });
    if (puntos.length < 2) return '<p class="viz__empty">Todavía no hay evolución que comparar.</p>';

    /* Cada uno tiene precio en días distintos, así que al juntarlos quedaban
       huecos: la línea se partía y salía una nube de puntos sueltos en vez de
       dos líneas. Se arrastra el último precio conocido hasta el siguiente
       dato. Antes del primero se deja vacío, que ahí todavía no cotizaba. */
    ['unoPrice', 'otroPrice'].forEach(function (campo) {
      let ultimo = null;
      puntos.forEach(function (p) {
        if (p[campo] != null) ultimo = p[campo];
        else if (ultimo != null) p[campo] = ultimo;
      });
    });

    const series = [
      { field: 'unoPrice', color: COLOR_UNO, label: uno.name || 'Uno' },
      { field: 'otroPrice', color: COLOR_OTRO, label: otro.name || 'Otro' }
    ];

    /* Lo que ha cambiado cada uno en cada periodo, enfrentado. */
    const cambios = function (serie) {
      return PERIODOS.map(function (p) { return variacion(serie, p.dias); });
    };
    const deUno = cambios(serieUno);
    const deOtro = cambios(serieOtro);

    const celda = function (cambio) {
      if (cambio == null) return '<span class="sub">—</span>';
      if (cambio === 0) return '<span class="delta delta--igual">– ' + compactMoney(0) + '</span>';
      return '<span class="delta ' + (cambio > 0 ? 'delta--up' : 'delta--down') + '">' +
        (cambio > 0 ? '+' : '−') + compactMoney(Math.abs(cambio)) + '</span>';
    };

    const ultimo = function (serie) { return serie[serie.length - 1][1]; };

    return '<h3 class="bench__title">Evolución del precio</h3>' +
      '<div class="viz__legend">' + series.map(function (s) {
        return '<span class="viz__key"><span class="chip__dot" style="background:' + s.color + '"></span>' +
          escapeHtml(s.label) + '</span>';
      }).join('') + '</div>' +
      '<div class="viz-hover">' +
        lineChart(puntos, 'unoPrice', COLOR_UNO, 'Valor de mercado',
          { height: 220, ticks: 6, fullTicks: true, padX: 96, hover: true, series: series }) +
        '<div class="viz-tip" hidden></div>' +
      '</div>' +
      /* Valor de hoy y lo que se ha movido en cada plazo, uno frente a otro. */
      '<div class="versus__filas versus__filas--precio">' +
        '<div class="versus__fila">' +
          '<span class="versus__dato">' + money(ultimo(serieUno)) + '</span>' +
          '<span class="versus__label">Hoy</span>' +
          '<span class="versus__dato">' + money(ultimo(serieOtro)) + '</span>' +
        '</div>' +
        /* De lo más reciente a lo más lejano: debajo de «Hoy» va 1d, luego 3d,
           7d… Así se baja en el tiempo en vez de empezar por hace medio año.
           `slice()` antes de dar la vuelta, que `reverse()` cambia el original
           y PERIODOS lo usan también otras partes. */
        PERIODOS.slice().reverse().map(function (p, i, lista) {
          /* El índice ahora va al revés, pero deUno/deOtro siguen en el orden
             de PERIODOS: se traduce para no cruzar los datos. */
          i = lista.length - 1 - i;
          if (deUno[i] == null && deOtro[i] == null) return '';
          return '<div class="versus__fila">' +
            '<span class="versus__dato">' + celda(deUno[i]) + '</span>' +
            '<span class="versus__label">' + p.label + '</span>' +
            '<span class="versus__dato">' + celda(deOtro[i]) + '</span>' +
          '</div>';
        }).join('') +
      '</div>';
  }

  /** Las estadísticas de los dos, en dos columnas. */
  function comparativaDeFichas(unoId, otroId) {
    const uno = playerInfo(unoId);
    const otro = playerInfo(otroId);
    const datosUno = state.estadisticas[String(unoId)];
    const datosOtro = state.estadisticas[String(otroId)];

    const sinLlegar = function (d) { return d === undefined || d === 'pidiendo'; };
    if (sinLlegar(datosUno) || sinLlegar(datosOtro)) {
      return '<p class="muted">Cargando\u2026</p>';
    }

    /* Todo lo que da la ficha, no solo cuatro cosas. `menor` marca las que se
       ganan por lo bajo (encajar menos, costar menos); `texto` las que no son
       una carrera y no se pintan en verde. */
    const num = function (v) { return v == null ? 0 : v; };
    const filas = [
      { rotulo: 'Puntos', valor: function (d, f) { return d ? num(d.points) : (f.points || 0); } },
      { rotulo: 'Media', valor: function (d) { return d && d.played ? (d.points / d.played).toFixed(1).replace('.', ',') : '0,0'; } },
      { rotulo: 'Partidos', valor: function (d) { return d ? num(d.played) : 0; } },
      { rotulo: 'Minutos', valor: function (d) { return d ? num(d.minutes) : 0; } },
      { rotulo: 'Goles', valor: function (d) { return d ? num(d.goals) : 0; } },
      { rotulo: 'Asistencias', valor: function (d) { return d ? num(d.assists) : 0; } },
      { rotulo: 'Goles por partido', valor: function (d) {
          return d ? (num(d.goalsPerGame)).toFixed(2).replace('.', ',') : '0,00'; } },
      { rotulo: 'Partidos ganados', valor: function (d) { return d ? num(d.wins) : 0; } },
      /* Dejar la portería a cero solo puntúa a porteros y defensas: en un
         medio o un delantero es un dato que no dice nada. */
      { rotulo: 'Porterías a cero', valor: function (d) { return d ? num(d.cleanSheets) : 0; }, atras: true },
      { rotulo: 'Goles encajados', valor: function (d) { return d ? num(d.conceded) : 0; }, menor: true, atras: true },
      { rotulo: 'Amarillas', valor: function (d) { return d ? num(d.yellow) : 0; }, menor: true },
      { rotulo: 'Rojas', valor: function (d) { return d ? num(d.red) : 0; }, menor: true },
      { rotulo: 'Veces sustituido', valor: function (d) { return d ? num(d.subsOut) : 0; }, menor: true },
      { rotulo: 'Sale del banquillo', valor: function (d) { return d ? num(d.subsIn) : 0; } },
      /* En casa y fuera, para ver de quién te puedes fiar dónde. */
      { rotulo: 'Puntos en casa', valor: function (d) { return d && d.home ? num(d.home.points) : 0; } },
      { rotulo: 'Media en casa', valor: function (d) {
          return d && d.home && d.home.played ? num(d.home.average).toFixed(1).replace('.', ',') : '0,0'; } },
      { rotulo: 'Puntos fuera', valor: function (d) { return d && d.away ? num(d.away.points) : 0; } },
      { rotulo: 'Media fuera', valor: function (d) {
          return d && d.away && d.away.played ? num(d.away.average).toFixed(1).replace('.', ',') : '0,0'; } },
      { rotulo: 'Valor', valor: function (d, f) { return money(f.marketValue || 0); }, texto: true }
    ];

    /* Las de portería solo si alguno de los dos juega atrás (portero o
       defensa); si los dos son medios o delanteros, no pintan nada. */
    const puestoDe = function (ficha, id) {
      return ficha && ficha.position != null ? ficha.position : posicionConocida[String(id)];
    };
    const hayAtras = [puestoDe(uno, unoId), puestoDe(otro, otroId)].some(function (p) {
      return p === 1 || p === 2;
    });
    const visibles = filas.filter(function (f) { return !f.atras || hayAtras; });

    const cabecera = function (ficha, id) {
      return '<div class="versus__quien">' + faceOf(id, 'ficha__face') +
        '<strong>' + escapeHtml(ficha.name || '') + '</strong>' +
        '<span class="sub">' + escapeHtml(ficha.teamName || '') + '</span></div>';
    };

    return '<div class="versus">' +
      '<div class="versus__cab">' + cabecera(uno, unoId) + cabecera(otro, otroId) + '</div>' +
      '<div class="versus__filas">' + visibles.map(function (fila) {
        const a = fila.valor(datosUno, uno);
        const b = fila.valor(datosOtro, otro);
        const bruto = fila.texto ? 0
          : (Number(String(a).replace(',', '.')) - Number(String(b).replace(',', '.')));
        /* Donde gana el que menos tiene (tarjetas, encajados), al revés. */
        const gana = fila.menor ? -bruto : bruto;
        return '<div class="versus__fila">' +
          '<span class="versus__dato' + (gana > 0 ? ' versus__dato--mejor' : '') + '">' + a + '</span>' +
          '<span class="versus__label">' + fila.rotulo + '</span>' +
          '<span class="versus__dato' + (gana < 0 ? ' versus__dato--mejor' : '') + '">' + b + '</span>' +
        '</div>';
      }).join('') + '</div>' +
    '</div>';
  }

  /** Los partidos del futbolista, con su rival, resultado y lo que hizo. */
  function listaDePartidos(id) {
    const datos = state.partidosJugador[String(id)];
    if (datos === undefined || datos === 'pidiendo') {
      return '<p class="muted">Cargando partidos\u2026</p>';
    }
    if (!datos || !datos.matches || !datos.matches.length) {
      return '<p class="muted">Todavía no hay partidos suyos esta temporada.</p>';
    }

    /* De la primera jornada a la última, en orden. */
    const filas = datos.matches.slice().map(function (juego) {
      const jugado = juego.homeScore != null && juego.awayScore != null;
      const suyos = juego.enCasa ? juego.homeScore : juego.awayScore;
      const otros = juego.enCasa ? juego.awayScore : juego.homeScore;
      const resultado = !jugado ? '–'
        : (suyos > otros ? 'gano' : (suyos < otros ? 'pierdo' : 'empato'));

      return '<div class="partido-jug' + (jugado ? ' partido-jug--' + resultado : '') + '">' +
        '<span class="partido-jug__jornada">J' + (juego.number || '') + '</span>' +
        '<span class="partido-jug__equipos">' +
          escudoDeEquipo(juego.homeId, juego.home) +
          '<span class="partido-jug__marcador">' +
            (jugado ? juego.homeScore + '\u2013' + juego.awayScore : '\u2013') + '</span>' +
          escudoDeEquipo(juego.awayId, juego.away) +
        '</span>' +
        /* Si no jugó ni un minuto, esas casillas se quedan vacías. */
        '<span class="partido-jug__lances">' + (juego.alineado ? lancesDe(juego) : '') + '</span>' +
        '<span class="partido-jug__min">' +
          (juego.minutes ? juego.minutes + "'" : '') + '</span>' +
        (juego.alineado ? notaDePartido(juego.points) : '<span class="nota nota--sin"></span>') +
      '</div>';
    }).join('');

    return '<div class="partidos-jug">' + filas + '</div>';
  }

  /**
   * Los partidos de los dos comparados, jornada a jornada y uno al lado del
   * otro, con la nota de cada uno para poder verlos de un vistazo.
   */
  function partidosComparados(unoId, otroId) {
    const deUno = state.partidosJugador[String(unoId)];
    const deOtro = state.partidosJugador[String(otroId)];
    const pendiente = function (d) { return d === undefined || d === 'pidiendo'; };
    if (pendiente(deUno) || pendiente(deOtro)) {
      return '<p class="muted">Cargando partidos…</p>';
    }

    const uno = playerInfo(unoId);
    const otro = playerInfo(otroId);
    const porJornada = function (datos) {
      const mapa = {};
      ((datos && datos.matches) || []).forEach(function (j) {
        if (j.number != null) mapa[j.number] = j;
      });
      return mapa;
    };
    const a = porJornada(deUno);
    const b = porJornada(deOtro);

    const jornadas = Object.keys(a).concat(Object.keys(b))
      .map(Number)
      .filter(function (n, i, lista) { return lista.indexOf(n) === i; })
      .sort(function (x, y) { return x - y; });

    if (!jornadas.length) {
      return '<p class="muted">Todavía no hay partidos suyos esta temporada.</p>';
    }

    /* El lado de uno: su rival de esa jornada y lo que hizo. */
    const lado = function (juego) {
      if (!juego) return '<span class="versus-part__vacio">—</span>';
      const rivalId = juego.enCasa ? juego.awayId : juego.homeId;
      const rival = juego.enCasa ? juego.away : juego.home;
      const jugado = juego.homeScore != null && juego.awayScore != null;
      const suyos = juego.enCasa ? juego.homeScore : juego.awayScore;
      const otros = juego.enCasa ? juego.awayScore : juego.homeScore;
      const resultado = !jugado ? '' : (suyos > otros ? ' partido-jug--gano'
        : (suyos < otros ? ' partido-jug--pierdo' : ' partido-jug--empato'));

      /* Todo en una línea, arrimado a la jornada del centro: es el hueco que
         sobraba y así los iconos caben sin apelotonarse. */
      const lances = juego.alineado ? lancesDe(juego) : '';
      const minutos = juego.minutes ? juego.minutes + "'" : '';

      return '<span class="versus-part__lado' + resultado + '">' +
        escudoDeEquipo(rivalId, rival) +
        '<span class="versus-part__marcador">' +
          (jugado ? suyos + '–' + otros : '–') + '</span>' +
        '<span class="versus-part__lances">' + lances + '</span>' +
        (minutos ? '<span class="versus-part__min">' + minutos + '</span>' : '') +
        (juego.alineado ? notaDePartido(juego.points) : '<span class="nota nota--sin"></span>') +
      '</span>';
    };

    const cabecera = function (ficha, id) {
      return '<div class="versus__quien">' + faceOf(id, 'ficha__face') +
        '<strong>' + escapeHtml(ficha.name || '') + '</strong></div>';
    };

    return '<div class="versus">' +
      '<div class="versus__cab">' + cabecera(uno, unoId) + cabecera(otro, otroId) + '</div>' +
      '<div class="versus-part">' + jornadas.map(function (n) {
        return '<div class="versus-part__fila">' +
          lado(a[n]) +
          '<span class="versus-part__jornada">J' + n + '</span>' +
          lado(b[n]) +
        '</div>';
      }).join('') + '</div>' +
    '</div>';
  }

  /** Pide al Worker los partidos de ese futbolista; se guardan por sesión. */
  function ensurePartidosDe(id) {
    const config = loadSyncConfig();
    if (!config.url || !config.key || id == null) return;
    const clave = String(id);
    if (state.partidosJugador[clave] !== undefined) return;

    /* Lo de la última vez se enseña al instante y no se pide nada: los
       partidos ya jugados no cambian. Solo se vuelve a preguntar si no hay
       nada guardado. */
    const guardado = cacheLeer('partidos:' + clave);
    if (guardado) {
      state.partidosJugador[clave] = guardado;
      renderPriceModal();
      return;
    }

    /* «Pidiendo» tiene que ser un valor distinto de «sin pedir»: antes se
       marcaba con `undefined`, que es justo lo que vale una clave que no
       existe, así que el guardia de arriba no frenaba nada y el mismo
       futbolista se podía pedir varias veces a la vez. */
    state.partidosJugador[clave] = 'pidiendo';
    fetch(config.url.replace(/\/+$/, '') + '/?key=' + encodeURIComponent(config.key) +
      '&partidosDe=' + encodeURIComponent(clave), { headers: { 'accept': 'application/json' } })
      .then(function (response) { return response.json(); })
      .then(function (payload) {
        const datos = payload && payload.error ? null : payload;
        state.partidosJugador[clave] = datos;
        if (datos) cacheGuardar('partidos:' + clave, datos);
        renderPriceModal();
        /* Igual que en la jornada: los goles de falta los pone ESPN despues. */
        if (datos) {
          marcaFaltasDeFicha(datos).then(function (tocado) {
            if (tocado && state.partidosJugador[clave] === datos) renderPriceModal();
          });
        }
      })
      .catch(function () {
        state.partidosJugador[clave] = null;
        renderPriceModal();
      });
  }

  function renderPriceModal() {
    const caja = $('price-modal');
    const abierto = state.priceModal;
    if (!abierto) { caja.hidden = true; caja.innerHTML = ''; return; }

    const serie = state.priceSeries[abierto.id];
    const puntos = (serie || []).map(function (par) {
      return { day: stampToDay(par[0]), price: par[1] };
    });

    const llegada = acquisitionOf(abierto.id);
    const diaLlegada = llegada && llegada.since;
    const precioEseDia = (function () {
      if (!diaLlegada) return null;
      const punto = puntos.filter(function (p) { return p.day === diaLlegada; })[0];
      return punto ? punto.price : null;
    })();

    const primero = puntos.length ? puntos[0].price : 0;
    const ultimo = puntos.length ? puntos[puntos.length - 1].price : 0;
    const sube = ultimo >= primero;
    const salto = ultimo - primero;

    const ficha = playerInfo(abierto.id);
    const sube2 = ficha.increment > 0;

    /* El precio y su variación ya los cuenta el gráfico: aquí sobran. */
    const datos = [
      ficha.position ? POSITION_NAMES[ficha.position] : null,
      ficha.teamName,
      ficha.points != null ? ficha.points + (ficha.points === 1 ? ' punto' : ' puntos') : null,
      ficha.owner ? '<strong>' + escapeHtml(ficha.owner) + '</strong>' : '<strong>Libre</strong>'
    ].filter(Boolean).join(' · ');

    caja.hidden = false;
    ajustarFichaALaVista();
    caja.innerHTML =
      '<div class="picker__backdrop" data-price-close></div>' +
      '<div class="picker__card modal__card" role="dialog" aria-modal="true" aria-label="Ficha de ' +
        escapeHtml(abierto.name) + '">' +
        '<div class="picker__head ficha__head">' +
          '<span class="with-crest">' +
            faceOf(abierto.id, 'ficha__face') +
            '<strong>' + escapeHtml(abierto.name) + '</strong>' +
            crestOf(ficha, 'crest--badge') + statusMark(ficha, 'mark--row') +
          '</span>' +
          /* Mientras se elige rival, la pastilla estorba: su sitio lo ocupa el
             aspa que hay junto al buscador. */
          (abierto.eligiendo ? '' :
            /* Con los partidos abiertos, comparar estorba: se deja solo la
             pastilla para volver. */
          (abierto.partidos ? '' :
            '<button type="button" class="ambito ficha__comparar" data-comparar>' +
              (abierto.comparar ? 'Quitar comparación' : 'Comparar') + '</button>') +
            /* Mientras estás eligiendo rival no hay dos a quien comparar, así
               que el botón de partidos se esconde hasta que elijas; en cuanto
               hay rival vuelve, y entonces enseña los de los dos. */
            '<button type="button" class="ambito' + (abierto.partidos ? ' ficha__comparar' : '') +
              '" data-partidos-de>' +
              (abierto.partidos ? 'Ocultar partidos' : 'Partidos') + '</button>') +
          '<button type="button" class="btn btn--ghost btn--close" data-price-close' +
            ' title="Cerrar" aria-label="Cerrar">✕</button>' +
        '</div>' +
        '<p class="muted ficha__datos">' + datos + '</p>' +
        /* Lesionado o sancionado: el parte de Biwenger («Retorno estimado:
           mediados de enero», «Roja directa»...) debajo del nombre y en rojo,
           que es el dato que de verdad decide si lo alineas. */
        parteMedico(abierto.id) +
        /* Elegido el rival, sus estadísticas van al lado de las de este, y
           debajo la evolución del precio de los dos en el mismo gráfico. */
        (abierto.comparar && !abierto.partidos
          ? comparativaDeFichas(abierto.id, abierto.comparar) +
            (abierto.soloDatos ? '' : graficoDePreciosComparados(abierto.id, abierto.comparar))
          : '') +
        /* Con rival elegido, los partidos también se comparan. */
        (abierto.partidos
          ? (abierto.comparar
              ? partidosComparados(abierto.id, abierto.comparar)
              : listaDePartidos(abierto.id))
          : '') +
        (abierto.eligiendo ? selectorDeComparacion(abierto.id) : '') +
        /* Los partidos van solos: ni estadísticas ni gráficos. Y comparando
           tampoco: esos cuadros son de uno solo y repiten, peor contadas, las
           mismas cifras que ya están enfrentadas arriba. */
        (abierto.partidos || abierto.soloPrecio || abierto.comparar
          ? '' : estadisticasDeTemporada(abierto.id) + rachaDeTemporada(abierto.id)) +
        /* Desde los rankings solo interesan las estadísticas: ni el valor de
           mercado ni su evolución pintan nada ahí. Comparando, el gráfico de
           precio sería el de uno de los dos y engañaría: se deja fuera. */
        (abierto.soloDatos || abierto.partidos || abierto.comparar ? '' :
        (puntos.length < 2
          /* Biwenger no publica el histórico de todos —los que están sin club,
             por ejemplo—, pero el valor de hoy sí se sabe: se enseña eso. */
          ? '<div class="viz-sinserie">' +
              '<div class="stat"><span class="stat__label">Valor de mercado</span>' +
                '<strong>' + money(ficha.marketValue || 0) + '</strong></div>' +
              '<div class="stat"><span class="stat__label">Hoy</span><strong>' +
                (ficha.increment
                  ? '<span class="delta ' + (sube2 ? 'delta--up' : 'delta--down') + '">' +
                    (sube2 ? '▲ +' : '▼ −') + money(Math.abs(ficha.increment)) + '</span>'
                  : '<span class="delta delta--igual">– ' + money(0) + '</span>') +
              '</strong></div>' +
            '</div>' +
            '<p class="viz__empty">' + (puntos.length === 1
              /* Recién llegado al mercado: un solo día no dibuja una línea. */
              ? 'Apareció en el mercado el ' + escapeHtml(diaLargo(puntos[0].day)) +
                ': aún no hay evolución que enseñar.'
              : 'Biwenger no publica la evolución de este futbolista.') + '</p>'
          : '<div class="viz-hover">' +
              lineChart(puntos, 'price', sube ? 'var(--pos)' : 'var(--neg)', 'Valor de mercado',
                { height: 260, ticks: 7, fullTicks: true, padX: 96, hover: true,
                  mark: diaLlegada
                    ? { day: diaLlegada, label: llegada.paid == null ? 'reparto' : 'fichaje',
                        paid: llegada.paid != null ? llegada.paid : null }
                    : null }) +
              '<div class="viz-tip" hidden></div>' +
            '</div>' +
            '<p class="muted viz-resumen">De ' + money(primero) + ' a <strong>' + money(ultimo) + '</strong>' +
              ' · <span class="delta ' + (sube ? 'delta--up' : 'delta--down') + '">' +
              (sube ? '▲ +' : '▼ −') + money(Math.abs(salto)) + '</span></p>' +
            (function () {
              /* De lo más reciente a lo más lejano (1d, 3d, 7d…), igual que en
                 la comparación. Con `slice()` antes de invertir: `reverse()`
                 cambia el original, y PERIODOS se usa en los dos sitios. */
              const celdas = PERIODOS.slice().reverse().map(function (periodo) {
                const cambio = variacion(serie, periodo.dias);
                if (cambio == null) return '';
                const arriba = cambio > 0;
                const marca = cambio === 0
                  ? '<span class="delta delta--igual">– ' + compactMoney(0) + '</span>'
                  : '<span class="delta ' + (arriba ? 'delta--up' : 'delta--down') + '">' +
                    (arriba ? '+' : '−') + compactMoney(Math.abs(cambio)) + '</span>';
                return '<span class="periodo"><span class="periodo__label">' + periodo.label + '</span>' +
                  marca + '</span>';
              }).join('');
              /* Sin el «N días» de la izquierda: ese dato ya sale en el propio
                 gráfico y ocupaba el sitio que necesitan 3d y 1d para caber
                 todos en una línea. */
              return '<div class="viz-periodos">' + celdas + '</div>';
            })() +
            /* Lo más alto y lo más bajo que ha llegado a valer, con su fecha. */
            topesDePrecio(puntos))) +
        (!abierto.partidos && ficha.moves && ficha.moves.length
          ? '<h3 class="bench__title">En la liga</h3>' + playerHistory(ficha)
          : '') +
      '</div>';

    /* Los rótulos largos de las estadísticas encogen hasta verse enteros. */
    ajustarNombres();

    /* Corto y al grano: qué día llegó, por cuánto y cuánto valía entonces.
       El valor de mercado de ese día va en amarillo, como la marca. */
    const textoLlegada = !llegada ? null
      : (llegada.paid == null
          ? 'en reparto ' + escapeHtml(shortDay(diaLlegada))
          : 'fichado ' + escapeHtml(shortDay(diaLlegada)) + ' por ' + money(llegada.paid)) +
        (precioEseDia != null
          ? ' · <span class="viz-tip__valor">' + money(precioEseDia) + '</span>'
          : '');

    bindChartHover(caja.querySelector('.viz-hover'), puntos,
      diaLlegada ? { day: diaLlegada, texto: textoLlegada } : null);
  }

  function renderSquads() {
    ensureSquads();
    const body = $('squads-body');
    const list = squadList();

    if (list.length === 0) {
      body.innerHTML = '<tr><td colspan="4" class="empty">' +
        (state.squads && state.squads.status === 'loading'
          ? 'Cargando plantillas…' : 'Sincroniza para ver las plantillas.') + '</td></tr>';
      return;
    }

    body.innerHTML = list.map(function (squad) {
      const open = state.expandedSquad === squad.id;
      const value = squad.players.reduce(function (sum, p) { return sum + (p.marketValue || 0); }, 0);
      const paid = squad.players.reduce(function (sum, p) { return sum + (p.paid || 0); }, 0);

      const detail = !open ? '' :
        '<tr class="detail-row"><td class="detail-cell" colspan="4"><div class="detail">' +
        '<table class="detail-table"><thead><tr>' +
          squadColumn('position', 'Pos.', '') +
          squadColumn('name', 'Futbolista', '') +
          '<th>Estado</th>' +
          squadColumn('points', 'Puntos', 'num') +
          squadColumn('since', 'Desde', 'detail-date') +
          squadColumn('paid', 'Método', '') +
          squadColumn('marketValue', 'Valor de mercado', 'num') +
          '<th>Evolución</th>' +
          squadColumn('diff', 'Diferencia', 'num') +
        '</tr></thead><tbody>' +
        sortSquad(squad.players).map(function (player) {
          /* Sin precio de compra se compara con lo que valía el día del reparto. */
          const base = player.paid != null ? player.paid : state.startPrices[player.id];
          const diff = base == null || player.marketValue == null
            ? null : player.marketValue - base;
          return '<tr>' +
            '<td class="detail-rank">' + (player.position ? POSITION_NAMES[player.position] : '—') + '</td>' +
            '<td><span class="with-crest">' +
              playerName({ playerId: player.id, player: player.name }) +
              crestOf(player, 'crest--badge') + '</span></td>' +
            '<td class="estado-cell">' + statusCell(player) + '</td>' +
            '<td class="num">' + (player.points == null ? '<span class="sub">—</span>' : player.points) + '</td>' +
            '<td class="detail-date">' + shortDay(player.since) + '</td>' +
            '<td class="metodo">' + (function () {
              /* Cómo llegó a la plantilla y por cuánto. El importe, siempre en el
                 mismo tamaño; la procedencia, en pequeño al lado. */
              if (player.paid == null) {
                /* No se pagó nada por él, así que el importe va discreto. */
                const valia = state.startPrices[player.id];
                return '<span class="sub">reparto' + (valia ? ' · ' + money(valia) : '') + '</span>';
              }
              /* Solo «compra» y el importe: de quién fue ya se ve en Fichajes. */
              return '<span class="sub">compra</span> ' + money(player.paid);
            })() + '</td>' +
            '<td class="num"><strong>' + (player.marketValue == null ? '—' : money(player.marketValue)) + '</strong></td>' +
            '<td class="spark-cell">' + sparkline(ultimos(state.priceSeries[player.id], 45), player.id, player.name) + '</td>' +
            '<td class="num">' + (diff == null ? '<span class="sub">—</span>' : (diff === 0
              /* Sin cambio no hay flecha ni verde: un guion y el número normal. */
              ? '<span class="delta delta--igual">– ' + money(0) + '</span>'
              : '<span class="delta ' + (diff > 0 ? 'delta--up' : 'delta--down') + '">' +
                (diff > 0 ? '▲ +' : '▼ −') + money(Math.abs(diff)) + '</span>')) + '</td>' +
          '</tr>';
        }).join('') + '</tbody></table></div></td></tr>';

      return '<tr class="' + (open ? 'row-open' : '') + '">' +
        '<td>' +
          '<button type="button" class="row-toggle" data-squad="' + escapeHtml(squad.id) + '"' +
            ' aria-expanded="' + (open ? 'true' : 'false') + '">' +
            '<span class="row-toggle__icon" aria-hidden="true">▸</span>' +
            '<span class="manager">' + avatar(squad.name) +
              '<span class="manager__name">' + escapeHtml(squad.name) + '</span></span>' +
          '</button></td>' +
        '<td class="num" data-label="Jugadores">' + squad.players.length + '</td>' +
        '<td class="num" data-label="Pagado">' + (paid ? money(paid) : '<span class="sub">—</span>') + '</td>' +
        '<td class="num" data-label="Valor de mercado"><strong>' + money(value) + '</strong></td>' +
      '</tr>' + detail;
    }).join('');
  }

  /* ---------- Rankings de gasto e ingresos ---------- */

  /* ---------- Quién puntúa en la liga ----------
     Solo cuentan los futbolistas que tiene alguno de los ocho, y solo los que
     ya han jugado: un 0 de quien no se ha estrenado no dice nada. */

  /**
   * Cuántos se enseñan en cada clasificación. Se amplía sola a 25 en cuanto hay
   * gente de sobra, pero nunca tanto como para que el mismo futbolista salga a
   * la vez en «más puntos» y en «menos»: para eso hacen falta el doble de
   * alineados que puestos tiene la lista.
   */
  function topeRanking(total) {
    if (total >= 50) return 25;
    if (total >= 20) return 10;
    return Math.max(1, Math.floor(total / 2));
  }

  /**
   * Lo que ha hecho cada futbolista jornada a jornada contando solo cuando
   * estaba alineado, que es lo único que le suma a su mánager. Si salió y no
   * puntuó —un cero, un sin calificar o un partido que no jugó— cuenta igual
   * como alineación: ese hueco desaprovechado también dice mucho.
   *
   * `deQuien` limita el recuento a las alineaciones de un mánager.
   */
  function futbolistasAlineados(deQuien) {
    const porJugador = {};

    Object.keys(state.jornadas.datos).forEach(function (id) {
      const jornada = state.jornadas.datos[id];
      /* La mitad aplazada de una jornada trae los mismos partidos y los mismos
         futbolistas que la original: contarla es contar a todos dos veces. */
      if (!esJornadaPropia(jornada.round)) return;
      const numero = (jornada.round && jornada.round.number) || null;

      (jornada.standings || []).forEach(function (fila) {
        if (deQuien && fila.name !== deQuien) return;

        (fila.xi || []).forEach(function (jugador) {
          /* Si el equipo del futbolista aún no ha jugado su partido, esa
             jornada no cuenta: no ha tenido ocasión de puntuar. */
          if (jugador.pending) return;

          const clave = String(jugador.id);
          if (!porJugador[clave]) {
            porJugador[clave] = {
              id: clave, name: jugador.name, position: jugador.position,
              team: jugador.team, teamName: jugador.teamName,
              owner: fila.name, rounds: [], points: 0,
              pointsHome: 0, playedHome: 0, pointsAway: 0, playedAway: 0
            };
          }
          const ficha = porJugador[clave];
          /* Puede haber cambiado de manos: manda el último que lo alineó. */
          ficha.owner = fila.name;
          ficha.name = jugador.name || ficha.name;
          ficha.rounds.push({
            number: numero,
            points: jugador.points || 0,
            sinNota: jugador.points == null,
            home: jugador.home
          });
          /* Un futbolista suma o resta lo que puntúe, tal cual. */
          ficha.points += jugador.points || 0;
          if (jugador.home === true) {
            ficha.pointsHome += jugador.points || 0;
            ficha.playedHome += 1;
          } else if (jugador.home === false) {
            ficha.pointsAway += jugador.points || 0;
            ficha.playedAway += 1;
          }
        });
      });
    });

    return Object.keys(porJugador).map(function (clave) {
      const ficha = porJugador[clave];
      ficha.rounds.sort(function (a, b) { return (a.number || 0) - (b.number || 0); });
      ficha.played = ficha.rounds.length;          // partidos con su equipo ya jugado
      ficha.media = ficha.played ? ficha.points / ficha.played : null;
      return ficha;
    });
  }

  /**
   * Los puntos de un futbolista jornada a jornada: una columna por jornada, de
   * izquierda a derecha. Con puntuaciones negativas la columna cuelga por
   * debajo de la línea del cero.
   */
  function graficoDePuntos(ficha) {
    const rondas = ficha.rounds || [];
    if (rondas.length === 0) return '';

    /* El eje son las 38 jornadas desde el principio: así una sola jornada no
       se dibuja como una barra gigante que ocupa todo. */
    const porJornada = {};
    rondas.forEach(function (r) { if (r.number) porJornada[r.number] = r; });

    const conDatos = Object.keys(porJornada);
    if (conDatos.length === 0) return '';

    const hayNegativos = conDatos.some(function (n) { return porJornada[n].points < 0; });
    const tope = Math.max.apply(null, conDatos.map(function (n) {
      return Math.abs(porJornada[n].points);
    }).concat([1]));

    let columnas = '';
    for (let jornada = 1; jornada <= JORNADAS_LIGA; jornada++) {
      const dato = porJornada[jornada];
      if (!dato) {
        columnas += '<span class="barras__col barras__col--vacia"></span>';
        continue;
      }

      const alto = (Math.abs(dato.points) / tope) * 100;
      const negativa = dato.points < 0;
      const mitad = function (esNegativa) {
        return '<span class="barras__mitad' + (esNegativa ? ' barras__mitad--neg' : '') + '">' +
          (esNegativa === negativa && alto > 0
            ? '<span class="barras__barra' + (negativa ? ' barras__barra--neg' : '') +
              '" style="height:' + alto.toFixed(1) + '%"></span>'
            : '') +
        '</span>';
      };

      /* Un guion si no llegó a jugar; «0 pts» si jugó y no puntuó. */
      columnas += '<span class="barras__col" data-j="' + jornada + '" data-p="' +
          (dato.sinNota ? '–' : dato.points + ' pts') + '">' +
        '<span class="barras__pista">' + mitad(false) + (hayNegativos ? mitad(true) : '') + '</span>' +
      '</span>';
    }

    return '<div class="barras">' +
      '<div class="barras__tip" hidden></div>' +
      '<div class="barras__cuerpo">' + columnas + '</div>' +
      '<div class="barras__eje"><span>J1</span><span>J' + Math.round(JORNADAS_LIGA / 2) +
        '</span><span>J' + JORNADAS_LIGA + '</span></div>' +
    '</div>';
  }

  /**
   * El globito del gráfico de barras. Las columnas son de cinco píxeles, así
   * que no se caza una con el dedo: se mira dónde está el puntero y se salta a
   * la jornada con datos más cercana.
   */
  function tipDeBarras(cuerpo, clienteX) {
    const caja = cuerpo.closest('.barras');
    const tip = caja.querySelector('.barras__tip');
    const conDatos = Array.prototype.slice.call(cuerpo.querySelectorAll('[data-j]'));
    if (!tip || conDatos.length === 0) return;

    let mejor = conDatos[0];
    let cerca = Infinity;
    conDatos.forEach(function (col) {
      const r = col.getBoundingClientRect();
      const distancia = Math.abs(clienteX - (r.left + r.width / 2));
      if (distancia < cerca) { cerca = distancia; mejor = col; }
    });

    const r = mejor.getBoundingClientRect();
    tip.innerHTML = '<strong>J' + mejor.getAttribute('data-j') + '</strong>' +
      '<span>' + escapeHtml(mejor.getAttribute('data-p')) + '</span>';
    tip.hidden = false;

    /* Que no se salga por los lados: se le pone tope a izquierda y derecha. */
    const base = caja.getBoundingClientRect();
    const mitadTip = tip.getBoundingClientRect().width / 2;
    const centro = r.left + r.width / 2 - base.left;
    tip.style.left = Math.max(mitadTip, Math.min(base.width - mitadTip, centro)) + 'px';

    conDatos.forEach(function (col) { col.classList.toggle('barras__col--activa', col === mejor); });
  }

  function ocultarTipDeBarras(caja) {
    const tip = caja.querySelector('.barras__tip');
    if (tip) tip.hidden = true;
    Array.prototype.forEach.call(caja.querySelectorAll('.barras__col--activa'), function (col) {
      col.classList.remove('barras__col--activa');
    });
  }

  function rankingRows(lista, valor, prefijo) {
    return '<ol class="ranking__list">' + lista.map(function (jugador) {
      const clave = prefijo + ':' + jugador.id;
      const abierto = state.puntosDetalle === clave;
      return '<li class="ranking__row' + (abierto ? ' ranking__row--abierta' : '') + '">' +
        '<button type="button" class="ranking__boton" data-puntos="' + escapeHtml(clave) + '"' +
          ' aria-expanded="' + (abierto ? 'true' : 'false') + '">' +
          /* Cerrada: cara, escudo y nombre, que puede salir cortado. Abierta:
             solo el nombre, entero, que es lo que hacía falta leer. */
          (abierto
            ? '<span class="ranking__nombre">' + escapeHtml(jugador.name) +
                (jugador.teamName ? ' <span class="sub">· ' + escapeHtml(jugador.teamName) + '</span>' : '') +
              '</span>'
            : '<span class="ranking__quien">' +
                '<span class="with-crest">' +
                  playerName({ playerId: jugador.id, player: jugador.name, position: jugador.position }) +
                  crestOf(jugador, 'crest--badge') +
                '</span>' +
                '<span class="ranking__owner">' + escapeHtml(jugador.owner) + '</span>' +
              '</span>') +
          '<strong class="ranking__value">' + valor(jugador) + '</strong>' +
        '</button>' +
        (abierto ? graficoDePuntos(jugador) : '') +
      '</li>';
    }).join('') + '</ol>';
  }

  /* Cada tanda se puede mirar entera, solo en casa o solo fuera. */
  const AMBITOS = [
    { clave: 'total', nombre: 'Total', puntos: 'points', partidos: 'played' },
    { clave: 'casa', nombre: 'En casa', puntos: 'pointsHome', partidos: 'playedHome' },
    { clave: 'fuera', nombre: 'Fuera', puntos: 'pointsAway', partidos: 'playedAway' }
  ];

  /* Y por demarcación: comparar un portero con un delantero no dice mucho. */
  const PUESTOS = [
    { clave: '0', nombre: 'Todas' },
    { clave: '1', nombre: 'Porteros' },
    { clave: '2', nombre: 'Defensas' },
    { clave: '3', nombre: 'Medios' },
    { clave: '4', nombre: 'Delanteros' }
  ];

  function selectorAmbito(marca, elegido, puesto) {
    const chips = function (lista, tipo, actual) {
      return lista.map(function (opcion) {
        return '<button type="button" class="ambito" data-' + tipo + '="' + marca + ':' + opcion.clave + '"' +
          ' aria-pressed="' + (opcion.clave === actual ? 'true' : 'false') + '">' +
          opcion.nombre + '</button>';
      }).join('');
    };

    return '<div class="ambitos" role="group" aria-label="Casa o fuera">' +
        chips(AMBITOS, 'ambito', elegido) +
      '</div>' +
      '<div class="ambitos" role="group" aria-label="Demarcación">' +
        chips(PUESTOS, 'puesto', puesto) +
      '</div>';
  }

  /** Las cuatro listas de una tanda de futbolistas, en el ámbito elegido. */
  function cuatroListas(lista, marca, cual, puesto) {
    const ambito = AMBITOS.filter(function (a) { return a.clave === cual; })[0] || AMBITOS[0];

    /* En casa y fuera solo entra quien ha jugado alguno allí. */
    const conDatos = lista.filter(function (j) {
        /* Los entrenadores (puesto 5) no son futbolistas: puntúan con otras
           reglas y no se comparan con nadie. Fuera de estas tablas. */
        if (Number(j.position) === 5) return false;
        if (puesto && puesto !== '0' && String(j.position) !== String(puesto)) return false;
        return (j[ambito.partidos] || 0) > 0;
      })
      .map(function (j) {
        const partidos = j[ambito.partidos] || 0;
        const puntos = j[ambito.puntos] || 0;
        return Object.assign({}, j, {
          points: puntos, played: partidos, media: partidos ? puntos / partidos : 0,
          rounds: ambito.clave === 'total' ? j.rounds
            : (j.rounds || []).filter(function (r) {
                return ambito.clave === 'casa' ? r.home === true : r.home === false;
              })
        });
      });

    if (conDatos.length === 0) {
      return '<p class="muted">Sin datos todavía para eso.</p>';
    }

    /* Racha: lo sumado en los últimos cinco partidos suyos con nota. */
    const conRacha = conDatos.map(function (j) {
      const ultimos = (j.rounds || []).filter(function (r) { return r && r.points != null; }).slice(-5);
      return Object.assign({}, j, {
        racha: ultimos.reduce(function (suma, r) { return suma + r.points; }, 0),
        rachaPartidos: ultimos.length
      });
    }).filter(function (j) { return j.rachaPartidos > 0; });

    const porPuntos = conDatos.slice().sort(function (a, b) { return b.points - a.points; });
    const porMedia = conDatos.slice().sort(function (a, b) { return b.media - a.media; });
    const porRacha = conRacha.slice().sort(function (a, b) { return b.racha - a.racha; });

    const enteros = function (j) { return j.points + ' pts'; };
    const decimales = function (j) { return j.media.toFixed(1).replace('.', ','); };
    const racha = function (j) { return j.racha + ' pts'; };
    const veces = function (j) {
      return '<span class="ranking__sub">' + j.played +
        (j.played === 1 ? ' partido' : ' partidos') + '</span>';
    };

    const tope = topeRanking(conDatos.length);
    const bloque = function (titulo, prefijo, orden, valor) {
      /* Cada lista se despliega desde su cabecera hasta setenta y cinco, igual
         que las de Rankings, y se pliega con la cabecera o con «Ver menos». */
      const clave = marca + ':' + ambito.clave + ':' + (puesto || '0') + ':' + prefijo;
      const desplegado = !!state.puntosAbiertos[clave];
      const cuantos = desplegado ? RANKING_LARGO : tope;
      const hayMas = orden.length > tope;

      return '<div class="ranking' + (desplegado ? ' ranking--desplegado' : '') + '">' +
        '<button type="button" class="ranking__title ranking__title--mando"' +
          ' data-puntos-mas="' + escapeHtml(clave) + '"' +
          ' aria-expanded="' + (desplegado ? 'true' : 'false') + '"' +
          (hayMas ? '' : ' disabled') + '>' +
          titulo +
          (hayMas ? '<span class="ranking__caret" aria-hidden="true">▸</span>' : '') +
        '</button>' +
        rankingRows(orden.slice(0, cuantos), function (j) {
          return valor(j) + veces(j);
        }, clave) +
        (desplegado && hayMas
          ? '<button type="button" class="btn btn--ghost btn--sm ranking__mas"' +
            ' data-puntos-mas="' + escapeHtml(clave) + '">Ver menos</button>'
          : '') +
      '</div>';
    };

    /* Dos filas de tres: arriba lo mejor, abajo lo peor. */
    const matiz = '<span class="ranking__matiz">(últimos 5 partidos)</span>';
    return '<div class="rankings--tres">' +
        bloque('Más puntos', 'mas', porPuntos, enteros) +
        bloque('Mejor media', 'media', porMedia, decimales) +
        bloque('Mejor racha ' + matiz, 'racha', porRacha, racha) +
      '</div>' +
      '<div class="rankings--tres">' +
        bloque('Menos puntos', 'menos', porPuntos.slice().reverse(), enteros) +
        bloque('Peor media', 'peormedia', porMedia.slice().reverse(), decimales) +
        bloque('Peor racha ' + matiz, 'peorracha', porRacha.slice().reverse(), racha) +
      '</div>';
  }

  /* ---------- Rankings de la temporada ----------
     Salen del recuento de lances de cada jornada; los minutos se aproximan
     ah\u00ed mismo a partir de los cambios (entra/sale), sin pedir la ficha de
     cada futbolista uno a uno. */
  const RANKINGS = [
    { titulo: 'M\u00e1s goles',          campo: 'goals',        sufijo: '' },
    /* Por minuto en vez de por partido: mide mejor a quien juega a ratos. Va en
       minutos por gol («1 cada 33'»), que es como se dice; y ordenado al revés,
       porque aquí gana el que menos tarda. */
    { titulo: 'Goles por minuto',   campo: 'minutesPerGoal', sufijo: '',
      menor: true, requiere: 'goals', cada: true, minimo: 1 },
    { titulo: 'M\u00e1s asistencias',    campo: 'assists',      sufijo: '' },
    { titulo: 'M\u00e1s minutos',        campo: 'minutes',      sufijo: '' },
    { titulo: 'M\u00e1s amarillas',      campo: 'yellow',       sufijo: '' },
    { titulo: 'M\u00e1s rojas',          campo: 'red',          sufijo: '' },
    { titulo: 'M\u00e1s sustituciones',  campo: 'subsOut',      sufijo: '' },
    { titulo: 'M\u00e1s veces suplente', campo: 'subsIn',       sufijo: '' },
    { titulo: 'Porter\u00edas a cero',   campo: 'cleanSheets',  sufijo: '', porteros: true },
    { titulo: 'Menos goles encajados', campo: 'conceded',   sufijo: '', porteros: true, menor: true }
  ];

  /** El recuento del ámbito que se esté mirando. */
  function recuentoActivo() {
    return state.rankingsAmbito === 'liga' ? state.recuentoLiga : state.recuento;
  }

  function ensureRecuento() {
    const config = loadSyncConfig();
    if (!config.url || !config.key) return;
    /* El de la liga es otra consulta y se guarda aparte: son dos recuentos
       distintos, no el mismo filtrado. */
    if (state.rankingsAmbito === 'liga') { ensureRecuentoDeLiga(); return; }
    if (state.recuento || state.recuentoCargando) return;

    /* Lo guardado se enseña ya; lo de ahora llega por detrás. */
    const previo = cacheLeer('recuento');
    if (previo && previo.players) {
      state.recuento = previo.players;
      recordarPosiciones(state.recuento);
      state.recuento.forEach(function (j) { amarillasDe[String(j.id)] = j.yellow || 0; });
    }
    state.recuentoCargando = true;
    fetch(config.url.replace(/\/+$/, '') + '/?key=' + encodeURIComponent(config.key) + '&recuento=1',
      { headers: { 'accept': 'application/json' } })
      .then(function (response) { return response.json(); })
      .then(function (payload) {
        if (payload.error) throw new Error(payload.error);
        state.recuento = payload.players || [];
        state.recuentoAt = Date.now();
        recordarPosiciones(state.recuento);
        state.recuento.forEach(function (j) { amarillasDe[String(j.id)] = j.yellow || 0; });
        state.recuentoCargando = false;
        cacheGuardar('recuento', payload);
        renderRankingsTemporada();
        /* Las amarillas llegan después de pintar: si alguien está a una de
           sanción, hay que repasar las vistas para que salga su tarjeta. */
        if (state.recuento.some(aUnaDeSancion)) {
          render();
          if (state.tab === 'jugadores') renderJugadores();
          if (state.tab === 'jornadas') renderJornadas();
        }
      })
      .catch(function () {
        state.recuentoCargando = false;
        state.recuento = [];
        renderRankingsTemporada();
      });
  }

  /** Lo mismo, pero contando solo lo que cada uno hizo estando alineado aquí. */
  function ensureRecuentoDeLiga() {
    const config = loadSyncConfig();
    if (!config.url || !config.key) return;
    if (state.recuentoLiga || state.recuentoLigaCargando) return;

    state.recuentoLigaCargando = true;
    renderRankingsTemporada();
    fetch(config.url.replace(/\/+$/, '') + '/?key=' + encodeURIComponent(config.key) + '&recuento=liga',
      { headers: { 'accept': 'application/json' } })
      .then(function (response) { return response.json(); })
      .then(function (payload) {
        if (payload.error) throw new Error(payload.error);
        state.recuentoLiga = payload.players || [];
        state.recuentoLigaCargando = false;
        renderRankingsTemporada();
      })
      .catch(function () {
        state.recuentoLigaCargando = false;
        state.recuentoLiga = [];
        renderRankingsTemporada();
      });
  }

  /**
   * Desempate de «más goles» y «más asistencias». Todo por dentro: en la lista
   * se sigue viendo solo el número que da título al ranking.
   *
   * Con los goles iguales gana quien los hizo en menos partidos; si también
   * empatan los partidos, quien los hizo en menos minutos; luego las
   * asistencias, y al final el nombre.
   */
  function desempata(campo, a, b) {
    /* Primero por minuto, que afina más que por partido: dos con los mismos
       goles en los mismos partidos pueden llevar minutos muy distintos.
       Los minutos son aproximados y los calcula el Worker; si contesta uno
       viejo que aún no los manda, este criterio se salta solo. */
    const porMinuto = function (j) {
      return (j.minutes || 0) ? (j[campo] || 0) / j.minutes : 0;
    };
    if (porMinuto(a) !== porMinuto(b)) return porMinuto(b) - porMinuto(a);

    const porPartido = function (j) {
      return (j.played || 0) ? (j[campo] || 0) / j.played : 0;
    };
    if (porPartido(a) !== porPartido(b)) return porPartido(b) - porPartido(a);

    if ((a.assists || 0) !== (b.assists || 0)) return (b.assists || 0) - (a.assists || 0);
    return String(a.name).localeCompare(String(b.name), 'es');
  }

  function renderRankingsTemporada() {
    const caja = $('rankings-temporada');
    if (!caja) return;

    /* Ojo con el nombre: 'liga' es MI liga, no LaLiga. La píldora dice
       dónde estás, no a dónde irías. */
    const deLaLiga = state.rankingsAmbito === 'liga';
    const boton = $('rankings-ambito');
    if (boton) {
      boton.textContent = deLaLiga ? 'Mi liga' : 'LaLiga';
      boton.setAttribute('aria-pressed', deLaLiga ? 'true' : 'false');
      boton.classList.toggle('ambito--on', deLaLiga);
    }
    const todos = recuentoActivo();
    if (!todos) {
      /* Un «cargando» y ya: lo de «repasando jornada a jornada» contaba las
         tripas del asunto y encima parecía que se había atascado. */
      caja.innerHTML = deLaLiga && state.recuentoLigaCargando
        ? '<p class="muted">Cargando…</p>' : '';
      return;
    }
    if (todos.length === 0) {
      caja.innerHTML = '<p class="muted">Todav\u00eda no hay jornadas jugadas.</p>';
      return;
    }

    const tarjetas = {};
    RANKINGS.forEach(function (ranking) {
      /* Solo los porteros en lo que solo les toca a ellos, y solo quien ha
         jugado: un cero de quien no se ha estrenado no dice nada. */
      const lista = todos.filter(function (j) {
        if (ranking.porteros && j.position !== 1) return false;
        if (!j.appearances) return false;
        if (ranking.minimo && (j.played || 0) < ranking.minimo) return false;
        /* En los «más», un cero no es un dato: si solo hay dos con rojas, se
           enseñan dos. En «menos encajados» el cero sí dice algo. */
        if (!ranking.menor && !(j[ranking.campo] > 0)) return false;
        /* Los «menos» admiten el cero, pero minutos por gol sin ningún gol no
           es un cero: es que no hay dato. */
        if (ranking.requiere && !(j[ranking.requiere] > 0)) return false;
        return true;
      }).sort(function (a, b) {
        const diferencia = ranking.menor ? a[ranking.campo] - b[ranking.campo]
                                         : b[ranking.campo] - a[ranking.campo];
        if (diferencia) return diferencia;
        /* Goles y asistencias tienen desempate propio; los demás, por nombre. */
        if (ranking.campo === 'goals' || ranking.campo === 'assists') {
          return desempata(ranking.campo, a, b);
        }
        return String(a.name).localeCompare(String(b.name), 'es');
      });

      if (lista.length === 0) { tarjetas[ranking.campo] = ''; return; }

      /* Diez de primeras; la cabecera despliega hasta setenta y cinco. Mismo
         patrón que «los que más suben y bajan»: se abre pulsando el título y
         se cierra con el «Ver menos» de abajo, para que la web se comporte
         igual en todos los desplegables largos. */
      const desplegado = !!state.rankingsAbiertos[ranking.campo];
      const tope = desplegado ? RANKING_LARGO : 10;
      const vistos = lista.slice(0, tope);
      const hayMas = lista.length > 10;

      tarjetas[ranking.campo] = '<div class="ranking' + (desplegado ? ' ranking--desplegado' : '') + '">' +
        '<button type="button" class="ranking__title ranking__title--mando"' +
          ' data-mas="' + escapeHtml(ranking.campo) + '"' +
          ' aria-expanded="' + (desplegado ? 'true' : 'false') + '"' +
          (hayMas ? '' : ' disabled') + '>' +
          ranking.titulo +
          (hayMas ? '<span class="ranking__caret" aria-hidden="true">▸</span>' : '') +
        '</button>' +
        '<ol class="ranking__list">' + vistos.map(function (jugador) {
          const valor = ranking.cada
            ? '1 cada ' + (jugador[ranking.campo] || 0) + '′'
            : (ranking.decimal
              ? (jugador[ranking.campo] || 0).toFixed(2).replace('.', ',')
              : (jugador[ranking.campo] || 0));
          const clave = ranking.campo + ':' + jugador.id;
          const abierto = state.datosDetalle === clave;
          return '<li class="ranking__row' + (abierto ? ' ranking__row--abierta' : '') + '">' +
            '<button type="button" class="ranking__boton" data-ficha="' +
              escapeHtml(clave) + '" aria-expanded="' + (abierto ? 'true' : 'false') + '">' +
              (abierto
                ? '<span class="ranking__nombre">' + escapeHtml(jugador.name) +
                    (jugador.teamName ? ' <span class="sub">· ' + escapeHtml(jugador.teamName) + '</span>' : '') +
                  '</span>'
                : '<span class="ranking__quien">' +
                    '<span class="with-crest">' +
                      playerName({ playerId: jugador.id, player: jugador.name, position: jugador.position }) +
                      crestOf(jugador, 'crest--badge') +
                    '</span>' +
                  '</span>') +
              '<strong class="ranking__value">' + valor + '</strong>' +
            '</button>' +
            /* Se abre aquí mismo, hacia abajo, y solo con las estadísticas. */
            (abierto ? '<div class="ranking__ficha">' + estadisticasDeTemporada(jugador.id) + '</div>' : '') +
          '</li>';
        }).join('') + '</ol>' +
        /* Mismo «Ver menos» que en «suben y bajan», y en el mismo sitio: al
           final de la lista desplegada, para volver a los diez de siempre. */
        (desplegado && hayMas
          ? '<button type="button" class="btn btn--ghost btn--sm ranking__mas" data-mas="' +
            escapeHtml(ranking.campo) + '">Ver menos</button>'
          : '') +
      '</div>';
    });

    /* Por temas y no en una parrilla suelta: goles, disciplina, participación
       y portería. Cada fila lleva las que pediste (3-2-3-2). */
    const FILAS = [
      ['goals', 'minutesPerGoal', 'assists'],
      ['yellow', 'red'],
      ['minutes', 'subsOut', 'subsIn'],
      ['cleanSheets', 'conceded']
    ];

    caja.innerHTML = FILAS.map(function (fila) {
      const dentro = fila.map(function (campo) { return tarjetas[campo] || ''; }).join('');
      if (!dentro) return '';
      /* La fila dice cuántas lleva, para repartirlas a lo ancho. */
      return '<div class="rankings-fila rankings-fila--' + fila.length + '">' + dentro + '</div>';
    }).join('');
  }

  /**
   * Los que más y menos rinden. Una sola tabla con su píldora, igual que en
   * Rankings: antes eran dos tablas seguidas, la nuestra y la de LaLiga.
   */
  function renderRankings() {
    const caja = $('rankings-puntos');
    if (!caja) return;

    /* Igual que en Rankings: 'liga' es MI liga. */
    const deLaLiga = state.puntosAmbito === 'liga';
    const boton = $('puntos-ambito');
    if (boton) {
      boton.textContent = deLaLiga ? 'Mi liga' : 'LaLiga';
      boton.setAttribute('aria-pressed', deLaLiga ? 'true' : 'false');
      boton.classList.toggle('ambito--on', deLaLiga);
    }

    /* Con las dos filas dentro, el contenedor no reparte columnas. */
    caja.classList.add('rankings--filas');

    if (deLaLiga) {
      const todos = futbolistasAlineados(null);
      /* Si aún se están trayendo las jornadas, es que está cargando; solo
         cuando ya han llegado y no hay nada se dice que no hay nada. */
      const cargando = state.jornadaEstado === 'cargando' ||
        (!todos.length && !jornadasGuardadas().length);
      caja.innerHTML = todos.length === 0
        ? '<p class="muted">' + (cargando
            ? 'Cargando…'
            : 'Todavía no hay jornadas guardadas con alineaciones.') + '</p>'
        : cuatroListas(todos, 'nuestra', state.ambito.nuestra, state.puesto.nuestra);

      const mando = $('ambitos-puntos');
      if (mando) mando.innerHTML = selectorAmbito('nuestra', state.ambito.nuestra, state.puesto.nuestra);
    } else {
      renderLaLiga();
    }

    ajustarNombres();
  }

  /** De quién es cada futbolista, mirando las ocho plantillas. */
  function duenosDeFutbolistas() {
    const de = {};
    squadList().forEach(function (plantilla) {
      (plantilla.players || []).forEach(function (jugador) {
        de[String(jugador.id)] = plantilla.name;
      });
    });
    return de;
  }

  /** Lo mismo, pero con todos los futbolistas de la competición. */
  function renderLaLiga() {
    const caja = $('rankings-puntos');
    if (!caja) return;

    const datos = state.laliga;
    if (!datos) {
      caja.innerHTML = '<p class="muted">Cargando…</p>';
      return;
    }

    const dueno = duenosDeFutbolistas();
    /* La racha llega sin numerar: la última entrada es la jornada en curso y
       las anteriores, hacia atrás. */
    const jornadaActual = (state.round && state.round.number) || JORNADAS_LIGA;

    const lista = datos.map(function (jugador) {
      const racha = jugador.fitness || [];
      const desde = jornadaActual - racha.length + 1;
      return {
        id: jugador.id,
        name: jugador.name,
        position: jugador.position,
        team: jugador.team,
        teamName: jugador.teamName,
        points: jugador.points || 0,
        played: jugador.played || 0,
        pointsHome: jugador.pointsHome || 0,
        playedHome: jugador.playedHome || 0,
        pointsAway: jugador.pointsAway || 0,
        playedAway: jugador.playedAway || 0,
        media: jugador.played ? (jugador.points || 0) / jugador.played : 0,
        owner: dueno[String(jugador.id)] || 'Libre',
        rounds: racha.map(function (nota, i) {
          return { number: desde + i, points: nota == null ? 0 : nota, sinNota: nota == null };
        })
      };
    });

    caja.classList.add('rankings--filas');
    caja.innerHTML = lista.length === 0
      ? '<p class="muted">Todavía no ha jugado nadie.</p>'
      : cuatroListas(lista, 'laliga', state.ambito.laliga, state.puesto.laliga);

    const mando = $('ambitos-puntos');
    if (mando) mando.innerHTML = selectorAmbito('laliga', state.ambito.laliga, state.puesto.laliga);
    ajustarNombres();
  }

  /** Trae la tabla de toda la competición; se guarda mientras dure la sesión. */
  function ensureLaLiga(forzar) {
    const config = loadSyncConfig();
    if (!config.url || !config.key) return;
    if (state.laliga && !forzar) return;
    if (state.laligaCargando) return;

    /* Lo guardado se enseña ya; lo de ahora llega por detrás. */
    if (!state.laliga) {
      const guardado = cacheLeer('laliga');
      if (guardado && guardado.players) {
        state.laliga = guardado.players;
        recordarPosiciones(state.laliga);
      }
    }
    state.laligaCargando = true;
    fetch(config.url.replace(/\/+$/, '') + '/?key=' + encodeURIComponent(config.key) + '&ranking=1',
      { headers: { 'accept': 'application/json' } })
      .then(function (response) { return response.json(); })
      .then(function (payload) {
        if (payload.error) throw new Error(payload.error);
        state.laliga = payload.players || [];
        state.laligaAt = Date.now();
        recordarPosiciones(state.laliga);
        state.laligaCargando = false;
        cacheGuardar('laliga', payload);
        /* Solo si es lo que se está mirando: si no, pisaría la tabla nuestra. */
        if (state.puntosAmbito !== 'liga') renderLaLiga();
      })
      .catch(function () {
        state.laligaCargando = false;
        if (state.puntosAmbito === 'liga') return;
        const caja = $('rankings-puntos');
        if (caja) caja.innerHTML = '<p class="muted">No se han podido traer los datos de la competición.</p>';
      });
  }

  function renderSpending() {
    ['spend', 'income'].forEach(function (kind) {
      const buys = kind === 'spend';
      const sort = state.sort[kind];

      const rows = MANAGERS.map(function (name) {
        const moves = state.movements.filter(function (movement) {
          return movement.manager === name && movement.type === (buys ? 'buy' : 'sell');
        }).sort(function (a, b) { return b.amount - a.amount; });
        return {
          name: name,
          moves: moves,
          count: moves.length,
          total: moves.reduce(function (sum, movement) { return sum + movement.amount; }, 0)
        };
      }).sort(function (a, b) {
        if (sort.key === 'name') return a.name.localeCompare(b.name, 'es') * sort.dir;
        const diff = (a[sort.key] - b[sort.key]) * sort.dir;
        return diff || b.total - a.total;
      });

      // Cabeceras con su flecha, según por dónde se esté ordenando.
      const headers = [
        { key: '', label: '#', cls: 'col-rank' },
        { key: 'name', label: 'Jugador', cls: '' },
        { key: 'count', label: buys ? 'Fichajes' : 'Ventas', cls: 'num' },
        { key: 'total', label: 'Total', cls: 'num' }
      ];
      $(kind + '-head').innerHTML = '<tr>' + headers.map(function (column) {
        if (!column.key) return '<th class="' + column.cls + '">' + column.label + '</th>';
        return '<th class="' + column.cls + ' sortable" data-spend-sort="' + kind + ':' + column.key +
          '" tabindex="0" aria-sort="' +
          (sort.key === column.key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none') + '">' +
          column.label + '</th>';
      }).join('') + '</tr>';

      $(kind + '-body').innerHTML = rows.map(function (row, index) {
        const key = kind + ':' + row.name;
        const open = state.expandedSpend === key;
        const detail = !open || row.moves.length === 0 ? '' :
          '<tr class="detail-row"><td class="detail-cell" colspan="4"><div class="detail">' +
          '<table class="detail-table"><tbody>' + row.moves.map(function (movement, i) {
            return '<tr><td class="detail-rank">' + (i + 1) + '</td>' +
              '<td><span class="with-crest">' + playerName(movement) +
                crestOf(movement, 'crest--badge') + '</span></td>' +
              '<td class="num"><strong class="' + (buys ? 'money-neg' : 'money-pos') + '">' +
                (buys ? '−' : '+') + money(movement.amount) + '</strong></td>' +
              '<td class="detail-date">' + escapeHtml(movement.date || '—') + '</td></tr>';
          }).join('') + '</tbody></table></div></td></tr>';

        return '<tr class="' + (open ? 'row-open' : '') + '">' +
          '<td class="col-rank">' + (index + 1) + '</td>' +
          '<td data-label="Futbolista">' +
            '<button type="button" class="row-toggle" data-spend="' + escapeHtml(key) + '"' +
              ' aria-expanded="' + (open ? 'true' : 'false') + '">' +
              '<span class="row-toggle__icon" aria-hidden="true">▸</span>' +
              '<span class="manager">' + avatar(row.name) +
                '<span class="manager__name">' + escapeHtml(row.name) + '</span></span>' +
            '</button></td>' +
          '<td class="num" data-label="Operaciones">' + row.count + '</td>' +
          '<td class="num" data-label="Total"><strong class="' + (buys ? 'money-neg' : 'money-pos') + '">' +
            money(row.total) + '</strong></td>' +
        '</tr>' + detail;
      }).join('');
    });
  }

  /* ---------- Plegar el presupuesto ---------- */

  const BUDGET_KEY = 'biwenger-calc-presupuesto';

  function pintarPresupuestoPlegado(oculto) {
    const cuerpo = $('budget-cuerpo');
    const boton = $('budget-toggle');
    const pie = $('budget-sub');
    if (!cuerpo || !boton) return;
    cuerpo.hidden = oculto;
    if (pie) pie.hidden = oculto;
    boton.textContent = oculto ? 'Mostrar' : 'Ocultar';
    boton.setAttribute('aria-expanded', oculto ? 'false' : 'true');
  }

  function engancharPresupuesto() {
    const boton = $('budget-toggle');
    if (!boton) return;

    let oculto = false;
    try { oculto = localStorage.getItem(BUDGET_KEY) === 'oculto'; } catch (error) { /* sin persistencia */ }
    pintarPresupuestoPlegado(oculto);

    boton.addEventListener('click', function () {
      const cuerpo = $('budget-cuerpo');
      const ahora = !cuerpo.hidden;         // si se ve, se esconde
      pintarPresupuestoPlegado(ahora);
      /* Se recuerda para la próxima vez que abras la web. */
      try { localStorage.setItem(BUDGET_KEY, ahora ? 'oculto' : 'visible'); } catch (error) { /* nada */ }
    });
  }

  /* ---------- Pestañas ---------- */

  const TAB_KEY = 'biwenger-calc-tab';

  /**
   * Sube la página hasta un bloque, dejándolo debajo de la barra de arriba,
   * que es fija y si no lo taparía.
   *
   * Solo se mueve si el bloque se ha quedado por encima de lo que se ve: al
   * plegar un ranking largo la lista encoge y el principio se va hacia arriba,
   * pero si ya lo tienes delante no hay que tocar nada.
   */
  function subirA(elemento) {
    if (!elemento) return;
    const barra = document.querySelector('.topbar');
    const alto = barra ? barra.getBoundingClientRect().height : 0;
    const arriba = elemento.getBoundingClientRect().top;
    if (arriba >= alto) return;             // ya se ve: no se toca
    window.scrollTo({
      top: window.scrollY + arriba - alto - 8,
      behavior: 'smooth'
    });
  }

  function showTab(name) {
    state.tab = name;
    /* Cada pestaña empieza por su principio: al cambiar, la página se quedaba
       a la altura a la que estuvieras en la anterior. */
    window.scrollTo({ top: 0, behavior: 'auto' });
    // Se recuerda para que al recargar (o al tirar hacia abajo en el móvil)
    // sigas en la pestaña donde estabas.
    try { localStorage.setItem(TAB_KEY, name); } catch (error) { /* sin persistencia */ }
    Array.prototype.forEach.call(document.querySelectorAll('#tabs .tab'), function (tab) {
      tab.setAttribute('aria-selected', tab.getAttribute('data-tab') === name ? 'true' : 'false');
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-panel]'), function (panel) {
      panel.hidden = panel.getAttribute('data-panel') !== name;
    });
    if (name === 'managers') { renderManagers(); renderSquads(); renderTandasDeLiga(); }
    if (name === 'fichajes') { renderDataKpis(); renderKpiCharts(); renderSpending(); pintarFichajes(); }
    if (name === 'datos') { ensureSquads(); ensureLaLiga(); ensureRecuento(); renderRankings(); renderRankingsTemporada(); }
    if (name === 'mercado') { ensureMarket(); renderMarket(); renderMovers(); }
    if (name === 'jugadores') { ensureJugadores(); renderJugadores(); }
    if (name === 'jornadas') { ensureJornada(state.jornadaVista || 'actual'); renderJornadas(); }
  }

  function renderWarnings() {
    const box = $('warnings');
    if (state.warnings.length === 0) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    box.hidden = false;
    box.innerHTML = '<strong>Revisa estos puntos</strong><ul>' +
      state.warnings.map(function (warning) { return '<li>' + escapeHtml(warning) + '</li>'; }).join('') +
      '</ul>';
  }

  function renderManagerFilter() {
    const select = $('filter-manager');
    const current = select.value;
    select.innerHTML = '<option value="">Todos los jugadores</option>' +
      MANAGERS.map(function (name) {
        return '<option value="' + escapeHtml(name) + '">' + escapeHtml(name) + '</option>';
      }).join('');
    select.value = current;
  }

  function render() {
    const rows = budgetRows();
    state.kpi = kpiValues(rows);   // los usa la pestaña Datos
    renderBudgets(rows);
    renderMovements();
    renderOffers();
    renderListings();
    renderRound();
    renderLineup();
    renderPlantilla();
    renderWarnings();
    if (state.tab === 'managers') { renderManagers(); renderSquads(); renderTandasDeLiga(); }
    if (state.tab === 'fichajes') { renderDataKpis(); renderKpiCharts(); renderSpending(); pintarFichajes(); }
    if (state.tab === 'datos') { ensureSquads(); ensureLaLiga(); ensureRecuento(); renderRankings(); renderRankingsTemporada(); }
    if (state.tab === 'mercado') { renderMarket(); renderMovers(); }
    if (state.tab === 'jugadores') { ensureJugadores(); renderJugadores(); }
  }

  /* ---------- Persistencia ---------- */

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        movements: state.movements,
        teams: state.teams
      }));
    } catch (error) {
      state.warnings.push('No se han podido guardar los datos en este navegador.');
      renderWarnings();
    }
  }

  function loadStored() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const data = JSON.parse(raw);
      state.movements = Array.isArray(data.movements) ? data.movements : [];
      state.teams = data.teams && typeof data.teams === 'object' ? data.teams : {};
      return state.movements.length > 0 || Object.keys(state.teams).length > 0;
    } catch (error) {
      return false;
    }
  }

  function setStatus(id, message, kind) {
    const el = $(id);
    el.textContent = message;
    el.className = 'parse-status' + (kind ? ' ' + kind : '');
  }

  /* ---------- Acciones ---------- */

  function processBoard() {
    const html = $('html-board').value;
    if (!html.trim()) {
      setStatus('status-board', 'Pega primero el HTML del tablón.', 'err');
      return;
    }
    const result = parseBoardHTML(html);
    if (result.movements.length === 0) {
      setStatus('status-board', 'No se ha encontrado ningún fichaje ni venta en ese HTML.', 'err');
      return;
    }
    state.movements = result.movements;
    state.warnings = result.warnings;
    persist();
    render();
    setStatus('status-board', result.movements.length + ' movimientos procesados.', 'ok');
  }

  function processStandings() {
    const html = $('html-standings').value;
    if (!html.trim()) {
      setStatus('status-standings', 'Pega primero el HTML de la pestaña Liga.', 'err');
      return;
    }
    const result = parseStandingsHTML(html);
    const count = Object.keys(result.teams).length;
    if (count === 0) {
      setStatus('status-standings', 'No se ha encontrado ningún valor de equipo en ese HTML.', 'err');
      return;
    }
    state.teams = result.teams;
    state.warnings = result.warnings;
    persist();
    render();
    setStatus('status-standings', count + ' equipos valorados.', 'ok');
  }

  /* ---------- Sincronización con el Worker ---------- */

  const dateFormat = new Intl.DateTimeFormat('es-ES', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });
  const dayFormat = new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
  const timeFormat = new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit' });

  /* El proxy se mudó de Cloudflare a Deno porque las operadoras españolas
     bloquean rangos de Cloudflare durante los partidos de LaLiga. La dirección
     se guarda en cada navegador por separado, así que el móvil (o cualquier
     otro aparato) se quedaba apuntando a la vieja y sin poder actualizar. Se
     cambia sola la primera vez, y se guarda para no repetirlo.

     Si algún día quieres volver a Cloudflare a mano, se respeta: la mudanza
     solo se hace una vez, y queda anotada. */
  const PROXY_VIEJO = 'biwenger-calc.jaime-5e2.workers.dev';
  const PROXY_NUEVO = 'https://calculadorabiwenger.jaimefgdev.deno.net';

  function loadSyncConfig() {
    try {
      const raw = localStorage.getItem(SYNC_KEY);
      const data = raw ? JSON.parse(raw) : null;
      let url = (data && data.url) || '';

      if (url && data && !data.mudado && url.indexOf(PROXY_VIEJO) !== -1) {
        url = PROXY_NUEVO;
        try {
          localStorage.setItem(SYNC_KEY, JSON.stringify({
            url: url, key: data.key || '', lastSync: data.lastSync || null, mudado: true
          }));
        } catch (e) { /* sin memoria: al menos vale para esta sesión */ }
      }

      return {
        url: url,
        key: (data && data.key) || '',
        lastSync: (data && data.lastSync) || null
      };
    } catch (error) {
      return { url: '', key: '', lastSync: null };
    }
  }

  function saveSyncConfig(config) {
    /* Si lo guardas tú a mano, esa es la buena: se marca como resuelta para
       que la mudanza automática de arriba no te la vuelva a cambiar. */
    const conMarca = Object.assign({}, config, { mudado: true });
    try { localStorage.setItem(SYNC_KEY, JSON.stringify(conMarca)); } catch (error) { /* sin persistencia */ }
  }

  /** Sello de «actualizado a las…» en la barra superior. */
  function renderLastSync(time, message) {
    const stamp = $('last-sync');
    if (!stamp) return;
    if (message) { stamp.textContent = message; return; }
    if (!time) {
      const sync = loadSyncConfig();
      stamp.textContent = sync.url && sync.key ? 'Sin actualizar aún' : 'Sin configurar';
      return;
    }
    const date = new Date(time);
    const sameDay = new Date().toDateString() === date.toDateString();
    stamp.textContent = 'Actualizado ' + (sameDay
      ? date.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
      : dateFormat.format(date));
  }

  /** Qué código tiene desplegado el Worker; se enseña en el panel de conexión. */
  function ensureVersionWorker() {
    const hueco = $('worker-version');
    if (!hueco) return;
    const config = loadSyncConfig();
    if (!config.url || !config.key) { hueco.textContent = ''; return; }

    fetch(config.url.replace(/\/+$/, '') + '/?key=' + encodeURIComponent(config.key) + '&version=1',
      { headers: { 'accept': 'application/json' } })
      .then(function (response) { return response.json(); })
      .then(function (payload) {
        const rotulo = payload && payload.version
          ? 'Worker ' + payload.version
          : (payload && payload.error) || '';
        /* Solo en el panel de conexión: encima del reloj estorbaba. */
        hueco.textContent = rotulo;
      })
      .catch(function () { hueco.textContent = 'Worker: no responde'; });
  }

  /* Cinco minutos: lo que tarda el Worker en volver a mirar. Con la pestaña
     abierta toda la tarde, sin esto los partidos del día no entraban nunca
     porque cada bloque se pedía una sola vez por carga. */
  const FRESCURA = 5 * 60 * 1000;

  function caducarEstadisticas() {
    const ahora = Date.now();
    const viejo = function (sello) { return sello && ahora - sello > FRESCURA; };

    if (viejo(state.recuentoAt)) { state.recuento = null; state.recuentoAt = 0; }
    if (viejo(state.jugadoresAt)) { state.jugadores = null; state.jugadoresAt = 0; }
    if (viejo(state.laligaAt)) { state.laliga = null; state.laligaAt = 0; }
    if (viejo(state.estadisticasAt)) { state.estadisticas = {}; state.estadisticasAt = 0; }
  }

  /** Traduce la respuesta del Worker al modelo interno de la calculadora. */
  function applySync(payload) {
    const warnings = [];
    const unknown = {};

    const movements = (payload.movements || []).map(function (item) {
      const manager = findManager(item.manager || '', null);
      if (!manager && item.manager) unknown[item.manager] = true;
      const time = item.date ? Date.parse(item.date) : NaN;
      return {
        playerId: item.playerId || null,
        player: item.player || 'Jugador desconocido',
        type: item.type === 'sell' ? 'sell' : 'buy',
        manager: manager,
        /* Con quién se hizo la operación: otro mánager, o el mercado. */
        otro: item.otro ? (findManager(item.otro, null) || item.otro) : null,
        amount: Math.round(item.amount || 0),
        date: isNaN(time) ? '' : dateFormat.format(new Date(time)),
        timestamp: isNaN(time) ? null : time,
        source: item.source || '',
        team: item.team != null ? item.team : null,
        teamName: item.teamName || null,
        status: item.status || null,
        position: item.position != null ? item.position : null,
        points: item.points != null ? item.points : null,
        marketValue: item.marketValue != null ? item.marketValue : null
      };
    });

    const teams = {};
    (payload.managers || []).forEach(function (item) {
      const manager = findManager(item.name || '', null);
      if (!manager) {
        if (item.name) unknown[item.name] = true;
        return;
      }
      teams[manager] = {
        id: item.id != null ? String(item.id) : null,
        value: item.teamValue != null ? item.teamValue : null,
        players: item.teamSize != null ? item.teamSize : null,
        points: item.points != null ? item.points : null,
        balance: item.balance != null ? item.balance : null,
        icon: item.icon || null,
        lastAccess: item.lastAccess || null
      };
    });

    if (payload.warning) warnings.push(payload.warning);

    Object.keys(unknown).forEach(function (name) {
      warnings.push('Participante no reconocido: «' + name + '». Revisa la lista MANAGERS de app.js.');
    });
    if (movements.length === 0) {
      warnings.push('El tablón no ha devuelto ningún movimiento con importe.');
    }

    state.movements = movements;
    state.teams = teams;
    state.offers = Array.isArray(payload.offers) ? payload.offers : [];
    state.listings = Array.isArray(payload.listings) ? payload.listings : [];
    state.lineup = payload.lineup || null;
    state.round = payload.round || state.round;
    state.movers = payload.movers || state.movers;
    /* Los que tienen foto de destacado. Se guardan como diccionario para poder
       preguntar por uno sin recorrer los noventa cada vez que se pinta una
       cara, que son cientos por pantalla. */
    if (Array.isArray(payload.heroes)) {
      const heroes = {};
      payload.heroes.forEach(function (id) { heroes[String(id)] = true; });
      state.heroes = heroes;
    }
    /* Altas y bajas de LaLiga: van en su propia vista dentro de Fichajes. */
    state.laligaMoves = payload.laligaMoves || state.laligaMoves || [];
    /* De aquí salen demarcaciones que no están en ninguna plantilla. */
    recordarPosiciones((state.movers && state.movers.up) || []);
    recordarPosiciones((state.movers && state.movers.down) || []);
    state.me = payload.me || null;
    state.leagueStart = (payload.league && payload.league.startDay) || state.leagueStart;
    state.warnings = warnings;
    freezeMoveStatus(movements);
    persist();
    recordSnapshot();
    /* Mientras la jornada está viva es el único momento en que Biwenger da el
       banquillo: se captura en cada sincronización, se mire o no la pestaña. */
    ensureJornada('actual', true);
    /* Y las que siguen abiertas por detrás (la 1 con sus aplazados, sin ir más
       lejos): sus puntos cuentan para la general aunque no se estén mirando. */
    refrescarJornadasAbiertas();
    /* Y se mira si has tocado la alineación desde el otro aparato. */
    traerXiCompartida();
    /* Lo que se pidió hace rato se vuelve a pedir: si no, con la pestaña
       abierta las estadísticas se quedan en la foto de cuando la abriste. */
    caducarEstadisticas();
    /* El recuento trae las amarillas, que hacen falta para el estado. */
    ensureRecuento();
    ensureVersionWorker();
    /* Los partidos de la jornada que se esté viendo, por si ya hay alineaciones. */
    const viendo = jornadaActiva();
    if (viendo && viendo.round) ensurePartidos(viendo.round.id, true);
    if (state.tab === 'mercado') ensureMarket(true);
    render();

    return { movements: movements.length, teams: Object.keys(teams).length };
  }

  /**
   * @param {boolean} auto  true si la dispara el temporizador: entonces no
   *                        abre paneles ni roba el foco, solo deja el aviso.
   */
  function syncNow(auto) {
    if (state.syncing) return;

    const url = collapse($('sync-url').value);
    const key = $('sync-key').value.trim();

    if (auto && (!url || !key)) return;

    if (!url) {
      $('input-panel').hidden = false;
      $('sync-url').focus();
      setStatus('status-sync', 'Falta la URL de tu Worker.', 'err');
      return;
    }
    if (!key) {
      $('input-panel').hidden = false;
      $('sync-key').focus();
      setStatus('status-sync', 'Falta la clave CALC_KEY.', 'err');
      return;
    }

    state.syncing = true;
    saveSyncConfig({ url: url, key: key, lastSync: state.lastSync });
    setStatus('status-sync', 'Consultando Biwenger…');
    $('btn-sync').disabled = true;
    $('btn-sync-top').disabled = true;

    const endpoint = url.replace(/\/+$/, '') + '/?key=' + encodeURIComponent(key);

    fetch(endpoint, { headers: { 'accept': 'application/json' } })
      .then(function (response) {
        return response.json()
          .catch(function () { throw new Error('El Worker no ha devuelto JSON (HTTP ' + response.status + ').'); })
          .then(function (body) {
            if (!response.ok || body.error) {
              throw new Error(body.error || ('El Worker ha respondido ' + response.status + '.'));
            }
            return body;
          });
      })
      .then(function (payload) {
        const result = applySync(payload);
        state.syncFails = 0;
        state.nextSyncAt = 0;
        state.lastSync = Date.now();
        saveSyncConfig({ url: url, key: key, lastSync: state.lastSync });
        renderLastSync(state.lastSync);
        setStatus('status-sync', result.movements + ' movimientos y ' + result.teams +
          ' equipos · ' + dateFormat.format(new Date()), 'ok');
      })
      .catch(function (error) {
        const message = /failed to fetch/i.test(String(error))
          ? 'No se ha podido contactar con el Worker: revisa la URL y que esté desplegado.'
          : String(error.message || error);
        /* Cada fallo seguido dobla la espera, hasta media hora. */
        state.syncFails += 1;
        const espera = Math.min(intervaloSync() * Math.pow(2, state.syncFails - 1), 30 * 60 * 1000);
        state.nextSyncAt = Date.now() + espera;

        const minutos = Math.round(espera / 60000);
        setStatus('status-sync', message + ' Se reintenta en ' + minutos +
          (minutos === 1 ? ' minuto.' : ' minutos.'), 'err');
        renderLastSync(state.lastSync, state.lastSync ? null : 'Error al actualizar');
      })
      .then(function () {
        state.syncing = false;
        $('btn-sync').disabled = false;
        $('btn-sync-top').disabled = false;
      });
  }

  /* Refresco automático: al abrir y cada AUTO_SYNC_MS, siempre que la pestaña
     esté a la vista. Biwenger publica los fichajes al cerrar el mercado, así
     que no tiene sentido consultar más a menudo. */
  /**
   * ¿Hay algún partido en marcha o recién acabado? Mientras se juega cambian
   * los resultados, y desde el pitido final aparecen las notas del AS y con
   * ellas los puntos. Fuera de esa horquilla no hay nada nuevo que traer.
   */
  function ventanaDePuntos() {
    const partidos = (state.round && state.round.matches) || [];
    const ahora = Date.now();
    const LIMITE = 5 * 60 * 60 * 1000;     // lo que dura el partido más el margen

    return partidos.some(function (partido) {
      const empieza = Date.parse(partido.start);
      if (isNaN(empieza)) return false;
      return ahora >= empieza && ahora <= empieza + LIMITE;
    });
  }

  function intervaloSync() {
    return ventanaDePuntos() ? AUTO_SYNC_PUNTOS_MS : AUTO_SYNC_MS;
  }

  function startAutoSync() {
    /* Si falla, se espera cada vez más: insistir cada cinco minutos contra una
       API que nos ha cortado solo alarga el corte. */
    setInterval(function () {
      if (document.visibilityState !== 'visible') return;
      if (state.nextSyncAt && Date.now() < state.nextSyncAt) return;
      if (state.lastSync && Date.now() - state.lastSync < intervaloSync()) return;
      syncNow(true);
    }, 60 * 1000);

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible') return;
      if (state.nextSyncAt && Date.now() < state.nextSyncAt) return;
      if (!state.lastSync || Date.now() - state.lastSync > intervaloSync()) syncNow(true);
      ensureEnVivo();
    });

    /* El marcador en directo va por su cuenta y mucho más a menudo que la
       sincronización: es una consulta a ESPN, no a Biwenger, así que no gasta
       de su cupo ni se arriesga a que nos corte. Solo mientras miras. */
    ensureEnVivo();
    setInterval(function () {
      if (document.visibilityState !== 'visible') return;
      /* Solo cuando puede haber algo rodando: la jornada en juego, o algún
         partido a menos de tres horas (por si acaba de empezar). */
      const round = state.round || {};
      const cerca = (round.matches || []).some(function (p) {
        const empieza = Date.parse(p.start);
        return !isNaN(empieza) && Date.now() - empieza > -15 * 60e3 &&
          Date.now() - empieza < 3 * 3600e3;
      });
      if (!round.live && !cerca && !(state.envivo || []).length) return;
      ensureEnVivo();
    }, 45 * 1000);
  }

  function resetAll() {
    state.movements = [];
    state.teams = {};
    state.warnings = [];
    $('html-board').value = '';
    $('html-standings').value = '';
    try { localStorage.removeItem(STORAGE_KEY); } catch (error) { /* sin persistencia */ }
    render();
    setStatus('status-board', '');
    setStatus('status-standings', '');
  }


  /* ---------- Eventos ---------- */

  /** Clic (o Enter/Espacio) en una cabecera: ordena, o invierte si ya ordenaba. */
  function bindSorting(table) {
    const thead = document.querySelector(SORT_TABLES[table] + ' thead');
    if (!thead) return;

    function toggle(th) {
      const key = th.getAttribute('data-sort');
      const sort = state.sort[table];
      if (sort.key === key) {
        sort.dir = -sort.dir;
      } else {
        sort.key = key;
        sort.dir = defaultDir(key);
      }
      if (table === 'budget') renderBudgets(budgetRows());
      else if (table === 'managers') renderManagers();
      else renderMovements();
    }

    thead.addEventListener('click', function (event) {
      const th = event.target.closest('th[data-sort]');
      if (th) toggle(th);
    });

    thead.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const th = event.target.closest('th[data-sort]');
      if (!th) return;
      event.preventDefault();
      toggle(th);
    });
  }

  function bindEvents() {
    /* 'error' no burbujea, así que se escucha en captura: si la foto de un
       jugador no carga, se prueba el sustituto y, si tampoco, se retira para
       dejar ver las iniciales. */
    document.addEventListener('error', function (event) {
      const img = event.target;
      if (!img || !img.classList || !img.classList.contains('avatar__pic')) return;
      const fallback = img.getAttribute('data-fallback');
      if (fallback && img.getAttribute('src') !== fallback) {
        img.removeAttribute('data-fallback');
        img.src = fallback;
        return;
      }
      img.remove();
    }, true);

    bindSorting('budget');
    bindSorting('moves');

    document.addEventListener('click', function (event) {
      const toggle = event.target.closest('[data-sim]');
      if (!toggle) return;
      const id = toggle.getAttribute('data-sim');
      if (state.sim[id]) delete state.sim[id];
      else state.sim[id] = true;
      renderOffers();
      renderListings();
    });

    $('tabs').addEventListener('click', function (event) {
      const tab = event.target.closest('.tab');
      if (tab) showTab(tab.getAttribute('data-tab'));
    });

    $('brand-home').addEventListener('click', function () {
      /* Tras la pulsación larga el navegador manda igualmente un clic: ese se
         descarta, que si no te lleva a Inicio al soltar. */
      if (temaCambiado) { temaCambiado = false; return; }
      showTab('inicio');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    engancharTemaLargo();

    $('round-toggle').addEventListener('click', function () {
      state.roundOpen = !state.roundOpen;
      renderRound();
    });

    /* Máximo dos gráficos a la vez: al abrir un tercero se cierra el más
       antiguo, así la comparación siempre es de dos en dos. */
    function toggleKpi(key) {
      if (state.kpiCharts[key]) {
        state.kpiCharts[key] = false;
        state.kpiOpen = state.kpiOpen.filter(function (open) { return open !== key; });
      } else {
        state.kpiOpen.push(key);
        state.kpiCharts[key] = true;
        while (state.kpiOpen.length > 2) state.kpiCharts[state.kpiOpen.shift()] = false;
      }
      renderDataKpis();
      renderKpiCharts();
    }

    /* Al girar el móvil o cambiar el tamaño de la ventana los huecos cambian:
       los nombres se vuelven a ajustar. */
    let ajusteEnCola = null;
    window.addEventListener('resize', function () {
      clearTimeout(ajusteEnCola);
      ajusteEnCola = setTimeout(ajustarNombres, 150);
    });

    /* Globito de las barras: vale para el ratón y para el dedo. */
    document.addEventListener('pointermove', function (event) {
      const cuerpo = event.target.closest && event.target.closest('.barras__cuerpo');
      if (cuerpo) tipDeBarras(cuerpo, event.clientX);
    });

    document.addEventListener('pointerdown', function (event) {
      const cuerpo = event.target.closest && event.target.closest('.barras__cuerpo');
      if (cuerpo) { tipDeBarras(cuerpo, event.clientX); return; }
      Array.prototype.forEach.call(document.querySelectorAll('.barras'), ocultarTipDeBarras);
    });

    document.addEventListener('pointerleave', function (event) {
      const caja = event.target.closest && event.target.closest('.barras');
      if (caja) ocultarTipDeBarras(caja);
    }, true);

    $('data-kpis').addEventListener('click', function (event) {
      const row = event.target.closest('[data-kpi]');
      if (row) toggleKpi(row.getAttribute('data-kpi'));
    });

    /* Cada partido despliega las dos alineaciones. */
    $('jornada-partidos').addEventListener('click', function (event) {
      const vista = event.target.closest('[data-vista]');
      if (vista) {
        state.vistaPartido = vista.getAttribute('data-vista');
        renderPartidos();
        return;
      }

      const cab = event.target.closest('[data-partido]');
      if (!cab) return;
      const cual = Number(cab.getAttribute('data-partido'));
      state.partidoAbierto = state.partidoAbierto === cual ? null : cual;
      renderPartidos();
    });

    /* En las clasificaciones de futbolistas, cada uno abre su gráfico. */
    /* Los rankings de la temporada abren la ficha del futbolista con sus
       estadísticas, sin el gráfico de valor de mercado. */
    const pildora = $('rankings-ambito');
    if (pildora) {
      pildora.addEventListener('click', function () {
        state.rankingsAmbito = state.rankingsAmbito === 'liga' ? 'laliga' : 'liga';
        /* Al cambiar de ámbito los números son otros: se cierra lo desplegado
           y la ficha abierta, que ya no dicen lo mismo. */
        state.rankingsAbiertos = {};
        state.datosDetalle = null;
        ensureRecuento();
        renderRankingsTemporada();
      });
    }

    const pildoraPuntos = $('puntos-ambito');
    if (pildoraPuntos) {
      pildoraPuntos.addEventListener('click', function () {
        state.puntosAmbito = state.puntosAmbito === 'liga' ? 'laliga' : 'liga';
        /* Los números son otros: la ficha abierta ya no dice lo mismo. */
        state.puntosDetalle = null;
        if (state.puntosAmbito !== 'liga') ensureLaLiga();
        renderRankings();
      });
    }

    const tandas = $('rankings-temporada');
    if (tandas) {
      tandas.addEventListener('click', function (event) {
        const mas = event.target.closest('[data-mas]');
        if (mas) {
          /* Mismo botón para abrir y para «Ver menos»: los dos llevan el mismo
             data-mas, así que basta con invertir si estaba abierto. */
          const cual = mas.getAttribute('data-mas');
          const plegando = !!state.rankingsAbiertos[cual];
          state.rankingsAbiertos[cual] = !state.rankingsAbiertos[cual];
          renderRankingsTemporada();
          /* Al plegar, la lista encoge y su principio puede quedarse por
             encima de la pantalla: se sube a él. Se busca después de pintar,
             que el botón de antes ya no existe. */
          if (plegando) {
            const nuevo = tandas.querySelector('[data-mas="' + cual + '"]');
            subirA(nuevo && nuevo.closest('.ranking'));
          }
          return;
        }
        const boton = event.target.closest('[data-ficha]');
        if (!boton) return;
        const clave = boton.getAttribute('data-ficha');
        state.datosDetalle = state.datosDetalle === clave ? null : clave;
        if (state.datosDetalle) ensureEstadisticas(clave.split(':')[1]);
        renderRankingsTemporada();
      });
    }

    ['rankings-puntos', 'ambitos-puntos'].forEach(function (id) {
      $(id).addEventListener('click', function (event) {
        const mando = event.target.closest('[data-ambito], [data-puesto]');
        if (mando) {
          const cual = mando.hasAttribute('data-ambito') ? 'ambito' : 'puesto';
          const partes = mando.getAttribute('data-' + cual).split(':');
          state[cual][partes[0]] = partes[1];
          state.puntosDetalle = null;
          renderRankings();
          return;
        }

        /* La cabecera despliega hasta setenta y cinco; el mismo botón y el
           «Ver menos» de abajo lo vuelven a plegar (los dos llevan el mismo
           data-puntos-mas, así que basta con invertir). */
        const mas = event.target.closest('[data-puntos-mas]');
        if (mas) {
          const cual = mas.getAttribute('data-puntos-mas');
          const plegando = !!state.puntosAbiertos[cual];
          state.puntosAbiertos[cual] = !state.puntosAbiertos[cual];
          renderRankings();
          /* Al plegar, subir a su principio si se quedó por encima. */
          if (plegando) {
            const nuevo = document.querySelector('[data-puntos-mas="' + cual + '"]');
            subirA(nuevo && nuevo.closest('.ranking'));
          }
          return;
        }

        const fila = event.target.closest('[data-puntos]');
        if (!fila) return;
        const clave = fila.getAttribute('data-puntos');
        state.puntosDetalle = state.puntosDetalle === clave ? null : clave;
        renderRankings();
      });
    });

    bindSorting('managers');

    /* El botón del sistema abre el mismo panel que los cambios. */
    $('lineup-formation').addEventListener('click', function () {
      ensureXi();
      state.picker = { kind: 'formation' };
      renderPicker();
    });

    engancharArrastre();

    $('pitch').addEventListener('click', function (event) {
      /* Tras arrastrar, el navegador manda igualmente un clic: si no se
         ignora, al soltar se abriría el panel encima. */
      if (huboArrastre) { huboArrastre = false; return; }
      const pick = event.target.closest('[data-slot]');
      if (!pick) return;
      state.picker = {
        kind: 'player',
        slot: pick.getAttribute('data-slot'),
        position: Number(pick.getAttribute('data-position'))
      };
      renderPicker();
    });

    /* Cualquier minigráfica, de la plantilla o del mercado, abre el detalle. */
    document.querySelector('.movers').addEventListener('click', function (event) {
      const boton = event.target.closest('[data-movers]');
      if (!boton) return;
      const clave = boton.getAttribute('data-movers');
      const plegando = !!state.moversAbiertos[clave];
      state.moversAbiertos[clave] = !state.moversAbiertos[clave];
      renderMovers();
      /* Igual que en los rankings: al plegar, subir a su principio si se ha
         quedado por encima de lo que se ve. */
      if (plegando) {
        const titulo = document.querySelector('[data-movers="' + clave + '"].movers__titulo');
        subirA(titulo || $(clave));
      }
    });

    document.addEventListener('click', function (event) {
      const spark = event.target.closest('[data-spark]');
      if (!spark) return;
      /* Desde la minigráfica se pide el precio, no la ficha entera. */
      state.priceModal = { id: spark.getAttribute('data-spark'),
        name: spark.getAttribute('data-spark-name'), soloPrecio: true };
      renderPriceModal();
    });

    /* Si el móvil se desplaza o cambia el zoom con la ficha abierta, se recoloca. */
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', ajustarFichaALaVista);
      window.visualViewport.addEventListener('scroll', ajustarFichaALaVista);
    }

    $('jugadores-buscar').addEventListener('input', renderJugadores);

    /* La ficha se abre pulsando el nombre del futbolista, esté donde esté. */
    ['moves-body', 'market-body', 'squads-body', 'listings-body',
     'movers-up', 'movers-down', 'jugadores-body', 'squad-body'].forEach(function (id) {
      $(id).addEventListener('click', function (event) { abrirFicha(event.target); });
    });

    $('op-modal').addEventListener('input', function (event) {
      if (!event.target || event.target.id !== 'op-importe') return;
      const hueco = $('op-restante');
      const puja = event.target.closest('.op-card').querySelector('[data-op-pujar]');
      if (!hueco || !puja) return;

      const limite = topeDePuja(puja.getAttribute('data-op-pujar'));
      if (limite.tope == null) return;
      const queda = limite.tope - Math.round(Number(event.target.value) || 0);
      hueco.textContent = money(queda);
      /* En rojo en cuanto te pasas de lo que puedes gastar. */
      hueco.classList.toggle('money-neg', queda < 0);
    });

    $('price-modal').addEventListener('input', function (event) {
      if (event.target && event.target.id === 'comparar-buscar') {
        state.priceModal.busca = event.target.value;
        renderPriceModal();
        const campo = $('comparar-buscar');
        if (campo) { campo.focus(); campo.setSelectionRange(campo.value.length, campo.value.length); }
      }
    });

    $('price-modal').addEventListener('click', function (event) {
      if (!state.priceModal) return;

      if (event.target.closest('[data-partidos-de]')) {
        state.priceModal.partidos = !state.priceModal.partidos;
        if (state.priceModal.partidos) {
          ensurePartidosDe(state.priceModal.id);
          /* Comparando, hacen falta los del rival para poder ponerlos al lado. */
          if (state.priceModal.comparar) ensurePartidosDe(state.priceModal.comparar);
        }
        renderPriceModal();
        return;
      }

      if (event.target.closest('[data-comparar]')) {
        /* Si ya hay comparación, la pastilla la quita; si no, abre la lista. */
        if (state.priceModal.comparar) {
          state.priceModal.comparar = null;
          state.priceModal.eligiendo = false;
        } else {
          state.priceModal.eligiendo = !state.priceModal.eligiendo;
          ensureJugadores();
        }
        renderPriceModal();
        return;
      }

      if (event.target.closest('[data-comparar-cerrar]')) {
        state.priceModal.eligiendo = false;
        state.priceModal.busca = '';
        renderPriceModal();
        return;
      }

      const elegido = event.target.closest('[data-comparar-con]');
      if (elegido) {
        state.priceModal.comparar = elegido.getAttribute('data-comparar-con');
        state.priceModal.eligiendo = false;
        state.priceModal.busca = '';
        ensureEstadisticas(state.priceModal.id);
        ensureEstadisticas(state.priceModal.comparar);
        /* Y su serie de precios, para el gráfico de los dos. */
        ensurePriceSeries([state.priceModal.id, state.priceModal.comparar], renderPriceModal);
        /* Si estabas viendo los partidos, se piden ya los del rival para que
           al volver estén los dos y no haya que esperar. */
        if (state.priceModal.partidos) ensurePartidosDe(state.priceModal.comparar);
        renderPriceModal();
        return;
      }

      if (!event.target.closest('[data-price-close]')) return;
      state.priceModal = null;
      renderPriceModal();
    });

    $('lineup-picker').addEventListener('click', function (event) {
      if (event.target.closest('[data-picker-close]')) {
        state.picker = null;
        renderPicker();
        return;
      }

      const sistema = event.target.closest('[data-formation]');
      if (sistema) {
        applyFormation(sistema.getAttribute('data-formation'));
        return;
      }

      const card = event.target.closest('[data-pick]');
      if (!card || !state.picker) return;

      const id = card.getAttribute('data-pick');
      const slot = state.picker.slot;
      // Un jugador no puede estar en dos sitios: se libera su hueco anterior.
      Object.keys(state.xi.slots).forEach(function (key) {
        if (state.xi.slots[key] === id) delete state.xi.slots[key];
      });
      if (id) state.xi.slots[slot] = id;
      else delete state.xi.slots[slot];

      state.picker = null;
      guardarXiMia();
      renderLineup();
      renderPicker();
    });

    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') return;
      if (state.picker) { state.picker = null; renderPicker(); }
      if (state.pickerJornada) { state.pickerJornada = false; renderJornadaPicker(); }
      if (state.priceModal) { state.priceModal = null; renderPriceModal(); }
    });

    $('jornada-pick').addEventListener('click', function () {
      state.pickerJornada = true;
      renderJornadaPicker();
    });

    $('jornada-picker').addEventListener('click', function (event) {
      if (event.target.closest('[data-picker-close]')) {
        state.pickerJornada = false;
        renderJornadaPicker();
        return;
      }
      const carta = event.target.closest('[data-jornada]');
      if (!carta) return;
      state.pickerJornada = false;
      state.jornadaAbierta = null;
      const id = carta.getAttribute('data-jornada');
      /* Se cambia de jornada siempre: los partidos no dependen de que su
         clasificación esté descargada. */
      state.jornadaVista = id;
      renderJornadaPicker();
      ensureJornada(id);
      renderJornadas();
    });

    $('jornada-chart').addEventListener('click', function (event) {
      const chip = event.target.closest('[data-jornada-serie]');
      if (!chip) return;
      const id = chip.getAttribute('data-jornada-serie');
      const abiertos = state.jornadaChart;
      const donde = abiertos.indexOf(id);
      if (donde !== -1) abiertos.splice(donde, 1);
      else {
        abiertos.push(id);
        while (abiertos.length > 4) abiertos.shift();   // cuatro colores, cuatro líneas
      }
      renderJornadaChart();
    });

    document.querySelector('.table--market thead').addEventListener('click', function (event) {
      const th = event.target.closest('[data-market-sort]');
      if (!th) return;
      const key = th.getAttribute('data-market-sort');
      const sort = state.sort.market;
      if (sort.key === key) sort.dir = -sort.dir;
      else { sort.key = key; sort.dir = (key === 'player' || key === 'seller' || key === 'until' || key === 'status') ? 1 : -1; }
      renderMarket();
    });

    $('rounds-body').addEventListener('click', function (event) {
      const fila = event.target.closest('[data-jornada-manager]');
      if (!fila) return;
      const id = fila.getAttribute('data-jornada-manager');
      state.jornadaAbierta = state.jornadaAbierta === id ? null : id;
      renderJornadas();
    });

    document.querySelector('.table--rounds thead').addEventListener('click', function (event) {
      const th = event.target.closest('[data-round-sort]');
      if (!th) return;
      const key = th.getAttribute('data-round-sort');
      const sort = state.sort.rounds;
      if (state.sort.roundsManual && sort.key === key) sort.dir = -sort.dir;
      else { sort.key = key; sort.dir = key === 'name' ? 1 : -1; }
      /* A partir de aquí manda lo que hayas elegido tú. */
      state.sort.roundsManual = true;
      renderJornadas();
    });

    $('squads-body').addEventListener('click', function (event) {
      const header = event.target.closest('[data-squad-sort]');
      if (header) {
        const key = header.getAttribute('data-squad-sort');
        const sort = state.sort.squad;
        if (sort.key === key) sort.dir = -sort.dir;
        else { sort.key = key; sort.dir = key === 'name' || key === 'position' ? 1 : -1; }
        renderSquads();
        return;
      }

      const button = event.target.closest('[data-squad]');
      if (!button) return;
      const id = button.getAttribute('data-squad');
      state.expandedSquad = state.expandedSquad === id ? null : id;
      if (state.expandedSquad) {
        const plantilla = squadList().filter(function (s) { return s.id === id; })[0];
        ensureStartPrices(plantilla);
        ensurePriceSeries((plantilla && plantilla.players || []).map(function (p) { return p.id; }), renderSquads);
      }
      renderSquads();
    });

    ['spend-body', 'income-body'].forEach(function (id) {
      $(id).addEventListener('click', function (event) {
        const button = event.target.closest('[data-spend]');
        if (!button) return;
        const key = button.getAttribute('data-spend');
        state.expandedSpend = state.expandedSpend === key ? null : key;
        renderSpending();
      });
    });

    ['spend-head', 'income-head'].forEach(function (id) {
      $(id).addEventListener('click', function (event) {
        const header = event.target.closest('[data-spend-sort]');
        if (!header) return;
        const parts = header.getAttribute('data-spend-sort').split(':');
        const sort = state.sort[parts[0]];
        if (sort.key === parts[1]) sort.dir = -sort.dir;
        else { sort.key = parts[1]; sort.dir = parts[1] === 'name' ? 1 : -1; }
        renderSpending();
      });
    });

    $('managers-body').addEventListener('click', function (event) {
      const chip = event.target.closest('[data-chart]');
      if (chip) {
        const key = chip.getAttribute('data-chart');
        state.charts[key] = !state.charts[key];
        renderManagers();
        return;
      }
      /* Dentro del desglose, cada futbolista abre su gráfico por jornada. */
      const detalle = event.target.closest('[data-puntos]');
      if (detalle) {
        const clave = detalle.getAttribute('data-puntos');
        state.puntosDetalle = state.puntosDetalle === clave ? null : clave;
        renderManagers();
        return;
      }

      /* Los puntos abren su propio desglose, sin tocar la ficha del mánager. */
      const puntos = event.target.closest('[data-manager-points]');
      if (puntos) {
        const quien = puntos.getAttribute('data-manager-points');
        state.expandedPoints = state.expandedPoints === quien ? null : quien;
        renderManagers();
        return;
      }

      const head = event.target.closest('[data-manager-card]');
      if (!head) return;
      const name = head.getAttribute('data-manager-card');
      state.expandedManager = state.expandedManager === name ? null : name;
      renderManagers();
    });

    $('budget-body').addEventListener('click', function (event) {
      const chip = event.target.closest('[data-chart]');
      if (chip) {
        const key = chip.getAttribute('data-chart');
        state.charts[key] = !state.charts[key];
        renderBudgets(budgetRows());
        return;
      }

      const header = event.target.closest('th[data-detail-sort]');
      if (header) {
        const key = header.getAttribute('data-detail-sort');
        const sort = state.sort.detail;
        if (sort.key === key) sort.dir = -sort.dir;
        else { sort.key = key; sort.dir = defaultDir(key); }
        renderBudgets(budgetRows());
        return;
      }

      const button = event.target.closest('.row-toggle');
      if (!button) return;
      const name = button.getAttribute('data-manager');
      if (state.expanded[name]) delete state.expanded[name];
      else state.expanded[name] = true;
      renderBudgets(budgetRows());
    });

    $('budget-body').addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const header = event.target.closest('th[data-detail-sort]');
      if (!header) return;
      event.preventDefault();
      header.click();
    });

    $('btn-toggle-input').addEventListener('click', function () {
      const panel = $('input-panel');
      panel.hidden = !panel.hidden;
      if (!panel.hidden) $('html-board').focus();
    });

    $('btn-sync').addEventListener('click', function () { syncNow(false); });
    $('btn-sync-top').addEventListener('click', function () { syncNow(false); });
    $('btn-process-board').addEventListener('click', processBoard);
    $('btn-process-standings').addEventListener('click', processStandings);
    $('btn-reset').addEventListener('click', resetAll);

    $('filter-text').addEventListener('input', function (event) {
      state.filters.text = event.target.value;
      renderMovements();
    });
    $('filter-manager').addEventListener('change', function (event) {
      state.filters.manager = event.target.value;
      renderMovements();
    });
    $('filter-type').addEventListener('change', function (event) {
      state.filters.type = event.target.value;
      renderMovements();
    });
  }

  /* ---------- Arranque ---------- */

  function init() {
    renderManagerFilter();
    bindEvents();
    engancharOperaciones();
    engancharPresupuesto();
    ensureVersionWorker();

    const sync = loadSyncConfig();
    $('sync-url').value = sync.url;
    $('sync-key').value = sync.key;
    state.lastSync = sync.lastSync;
    renderLastSync(state.lastSync);

    const hadData = loadStored();
    /* Antes que nada, para que no parpadee con los colores del sistema. */
    cargarTema();
    loadJornadas();
    loadMoveStatus();
    loadXi();
    /* El filtro del mercado, tal como se dejó la última vez. */
    try {
      const guardado = localStorage.getItem(MARKET_FILTER_KEY);
      if (FILTROS_MERCADO.some(function (f) { return f.clave === guardado; })) {
        state.marketFiltro = guardado;
      }
    } catch (error) { /* se queda en «todos» */ }
    /* Al abrir, lo primero es ver si el otro aparato dejó otra alineación. */
    traerXiCompartida();
    render();

    let saved = null;
    try { saved = localStorage.getItem(TAB_KEY); } catch (error) { /* sin persistencia */ }
    showTab(document.querySelector('[data-panel="' + saved + '"]') ? saved : 'inicio');
    if (hadData) {
      $('input-panel').hidden = true;
      setStatus('status-board', '');
      setStatus('status-standings', '');
    }

    if (sync.url && sync.key) {
      $('input-panel').hidden = true;
      syncNow(true);
      startAutoSync();
    }

    setInterval(tickRound, 1000);   // la cuenta atrás corre sola
  }

  document.addEventListener('DOMContentLoaded', init);
})();
