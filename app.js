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
    'José Mário dos Santos Mourinho'
  ];

  const INITIAL_BUDGET = 20000000;
  const TEAM_VALUE_SHARE = 0.25;          // fracción del valor de equipo que suma a la puja
  const STORAGE_KEY = 'biwenger-calc-v2';
  const SYNC_KEY = 'biwenger-calc-sync';
  const HISTORY_KEY = 'biwenger-calc-history';
  const AUTO_SYNC_MS = 5 * 60 * 1000;     // refresco automático

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
        points: teams[name] && teams[name].points != null ? teams[name].points : null,
        // Saldo tal cual lo da Biwenger; incluye cesiones, bonus y cláusulas.
        officialBalance: teams[name] && teams[name].balance != null ? teams[name].balance : null
      };
    });
    const byName = new Map(rows.map(function (row) { return [row.name, row]; }));

    movements.forEach(function (movement) {
      const row = byName.get(movement.manager);
      if (!row) return;
      if (movement.type === 'buy') {
        row.spent += movement.amount;
        row.buys += 1;
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
      maxBid:    function (row) { return row.maxBid; }
    },
    moves: {
      player:  function (m) { return m.player; },
      type:    function (m) { return m.type === 'buy' ? 'Fichado' : 'Vendido'; },
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
        return cmp === 0 ? a.index - b.index : cmp * sort.dir;
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
    listings: [],
    lineup: null,          // mi alineación en Biwenger
    round: null,           // próxima jornada y su hora de inicio
    roundOpen: false,      // lista de partidos desplegada
    picker: null,          // hueco del campo que se está cambiando
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
    lastSync: null,
    // key vacía = orden por defecto de cada tabla (ver más abajo).
    sort: {
      budget: { key: '', dir: -1 },
      moves:  { key: '', dir: -1 },
      managers: { key: '', dir: -1 },
      squad: { key: '', dir: 1 },
      spend: { key: 'total', dir: -1 },
      income: { key: 'total', dir: -1 },
      detail: { key: 'amount', dir: -1 }   // dentro de la ficha de cada jugador
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

  /** Nombre del futbolista con su foto del CDN de Biwenger. */
  function playerName(movement) {
    const id = movement.playerId;
    const pic = id
      ? '<span class="pic-player" style="background-image:url(\'https://cdn.biwenger.com/i/p/' +
        encodeURIComponent(id) + '.png\')" aria-hidden="true"></span>'
      : '';
    return '<span class="player">' + pic + '<span class="player-name">' +
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
    const sells = state.movements.length - buys;
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
    const fmtTick = isCount ? function (v) { return String(Math.round(v)); } : shortMoney;
    const fmtFull = isCount ? function (v) { return Math.round(v) + (v === 1 ? ' movimiento' : ' movimientos'); } : money;
    const fields = multi ? multi.map(function (s) { return s.field; }) : [key];
    const valid = points.filter(function (point) {
      return fields.some(function (field) { return point[field] != null; });
    });
    if (valid.length === 0) {
      return '<p class="viz__empty">Sin datos todavía de ' + escapeHtml(label.toLowerCase()) + '.</p>';
    }

    const W = 600, H = 130, padX = 46, padTop = 14, padBottom = 22;
    const values = [];
    valid.forEach(function (point) {
      fields.forEach(function (field) { if (point[field] != null) values.push(point[field]); });
    });
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
    const area = coords.length > 1
      ? '<path class="viz__area" d="' + path + ' L' + coords[coords.length - 1].x.toFixed(1) + ' ' + (H - padBottom) +
        ' L' + coords[0].x.toFixed(1) + ' ' + (H - padBottom) + ' Z" fill="' + color + '"></path>'
      : '';

    const grid = [min, min + span / 2, max].map(function (v) {
      return '<line class="viz__grid" x1="' + padX + '" x2="' + (W - 12) + '" y1="' + y(v).toFixed(1) +
        '" y2="' + y(v).toFixed(1) + '"></line>' +
        '<text class="viz__tick" x="' + (padX - 6) + '" y="' + (y(v) + 3).toFixed(1) + '" text-anchor="end">' +
        fmtTick(v) + '</text>';
    }).join('');

    const firstLabel = '<text class="viz__tick" x="' + padX + '" y="' + (H - 6) + '">' + shortDay(points[0].day) + '</text>';
    const lastLabel = points.length > 1
      ? '<text class="viz__tick" x="' + (W - 12) + '" y="' + (H - 6) + '" text-anchor="end">' +
        shortDay(points[points.length - 1].day) + '</text>'
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
        return '<path class="viz__line" d="' + d + '" stroke="' + serie.color + '"></path>' +
          points2.map(function (c) {
            return '<circle class="viz__dot" cx="' + c.x.toFixed(1) + '" cy="' + c.y.toFixed(1) +
              '" r="4" fill="' + serie.color + '"><title>' + shortDay(c.point.day) + ' · ' +
              serie.label + ': ' + (isCount ? String(c.point[serie.field]) : money(c.point[serie.field])) +
              '</title></circle>';
          }).join('');
      }).join('');

      return '<svg class="viz__svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' +
        escapeHtml(label) + ' por día">' + grid + body + firstLabel + lastLabel + '</svg>';
    }

    const dots = coords.map(function (c) {
      return '<circle class="viz__dot" cx="' + c.x.toFixed(1) + '" cy="' + c.y.toFixed(1) + '" r="4" fill="' + color +
        '"><title>' + shortDay(c.point.day) + ' · ' + fmtFull(c.point[key]) + '</title></circle>';
    }).join('');

    return '<svg class="viz__svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Evolución de ' +
      escapeHtml(label.toLowerCase()) + '">' + grid + area +
      '<path class="viz__line" d="' + path + '" stroke="' + color + '"></path>' + dots +
      firstLabel + lastLabel + '</svg>';
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
        '<span class="chip__dot" style="background:' + serie.color + '"></span>' + serie.label + '</button>';
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
            '<td>' + playerName(movement) + '</td>' +
            '<td><span class="tag ' + (buy ? 'tag--buy' : 'tag--sell') + '">' +
              (buy ? '↓ Fichado' : '↑ Vendido') + '</span></td>' +
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
      '<td class="num" data-label="Puja máxima"></td>' +
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
        '<td class="col-rank">' + (index + 1) + '</td>' +
        '<td data-label="Futbolista">' + playerName(movement) + '</td>' +
        '<td data-label="Acción"><span class="tag ' + (buy ? 'tag--buy' : 'tag--sell') + '">' +
          (buy ? '↓ Fichado' : '↑ Vendido') + '</span></td>' +
        '<td data-label="Futbolista">' + managerCell + '</td>' +
        '<td class="num" data-label="Importe">' +
          (buy ? '<span class="money-neg">−' + money(movement.amount) + '</span>'
               : '<span class="money-pos">+' + money(movement.amount) + '</span>') + '</td>' +
        '<td data-label="Fecha">' + escapeHtml(movement.date || '—') + '</td>' +
      '</tr>';
    }).join('');

    const empty = $('moves-empty');
    empty.hidden = list.length > 0;
    empty.textContent = state.movements.length === 0
      ? 'Aún no hay movimientos: pega el HTML del tablón arriba.'
      : 'Ningún movimiento coincide con el filtro.';

    $('moves-count').textContent = state.movements.length === 0
      ? 'Sin datos'
      : (list.length === state.movements.length
          ? state.movements.length + ' movimientos en el tablón'
          : list.length + ' de ' + state.movements.length + ' movimientos');
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
        '<td data-label="Futbolista">' + playerName(offer) + '</td>' +
        '<td data-label="Operación"><span class="tag ' + (out ? 'tag--buy' : 'tag--sell') + '">' +
          (out ? '↗ Puja' : '↘ Oferta') + '</span> ' +
          '<span class="sub">' + escapeHtml(offer.other || 'Mercado') + '</span></td>' +
        '<td class="num" data-label="Importe"><strong class="' + (out ? 'money-neg' : 'money-pos') + '">' +
          (out ? '−' : '+') + money(offer.amount) + '</strong></td>' +
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
        '<td data-label="Futbolista">' + playerName(item) + '</td>' +
        '<td class="num" data-label="Valor de mercado"><strong>' + money(market) + '</strong></td>' +
        '<td data-label="Ofertas">' + offerCell + '</td>' +
      '</tr>';
    }).join('');

    const total = list.reduce(function (sum, item) { return sum + listingValue(item); }, 0);
    $('listings-count').textContent = list.length + (list.length === 1 ? ' jugador en venta' : ' jugadores en venta') +
      ' · ' + money(total) + ' de valor de mercado';
  }

  /* ---------- Cuenta atrás de la jornada ---------- */

  function renderRound() {
    const section = $('round-panel');
    const round = state.round;
    if (!round || !round.start) { section.hidden = true; return; }

    section.hidden = false;
    $('round-name').textContent = 'Jornada ' + (round.number || '');
    $('round-when').textContent = dateFormat.format(new Date(round.start));

    const matches = round.matches || [];
    const toggle = $('round-toggle');
    toggle.hidden = false;
    toggle.setAttribute('aria-expanded', state.roundOpen && matches.length ? 'true' : 'false');
    toggle.disabled = matches.length === 0;

    const box = $('round-games');
    box.hidden = !(state.roundOpen && matches.length);
    if (!box.hidden) box.innerHTML = roundGames(matches);
    tickRound();
  }

  /** Los diez partidos, agrupados por día: hora, equipos y dónde se ve. */
  function roundGames(matches) {
    let day = '';
    return matches.map(function (match) {
      const when = new Date(match.start);
      const key = dayFormat.format(when);
      const header = key === day ? '' :
        '<p class="round__day">' + escapeHtml(key) + '</p>';
      day = key;
      return header +
        '<div class="round__game">' +
          '<span class="round__hour">' + timeFormat.format(when) + '</span>' +
          '<span class="round__teams">' + escapeHtml(match.home) +
            '<span class="round__vs">–</span>' + escapeHtml(match.away) + '</span>' +
          '<span class="round__tv">' + (match.tv ? escapeHtml(match.tv) : '—') + '</span>' +
        '</div>';
    }).join('');
  }

  /** Actualiza el reloj; se llama cada segundo. */
  function tickRound() {
    const clock = $('round-clock');
    const round = state.round;
    if (!clock || !round || !round.start) return;

    let left = Math.floor((Date.parse(round.start) - Date.now()) / 1000);
    if (left <= 0) {
      clock.innerHTML = '<span class="round__unit"><span class="round__value">¡Ya!</span>' +
        '<small>en juego</small></span>';
      return;
    }

    const days = Math.floor(left / 86400); left -= days * 86400;
    const hours = Math.floor(left / 3600); left -= hours * 3600;
    const minutes = Math.floor(left / 60);
    const seconds = left - minutes * 60;
    const pad = (n) => (n < 10 ? '0' + n : String(n));

    clock.innerHTML = [
      { value: days, label: days === 1 ? 'día' : 'días' },
      { value: pad(hours), label: 'horas' },
      { value: pad(minutes), label: 'min' },
      { value: pad(seconds), label: 'seg' }
    ].map(function (unit) {
      return '<span class="round__unit"><span class="round__value">' + unit.value + '</span>' +
        '<small>' + unit.label + '</small></span>';
    }).join('');
  }

  /* ---------- Alineación (simulador) ---------- */

  /* Los siete sistemas de Biwenger. El portero va aparte, siempre uno. */
  const FORMATIONS = ['3-4-3', '3-5-2', '4-3-3', '4-4-2', '4-5-1', '5-3-2', '5-4-1'];
  const POSITION_NAMES = { 1: 'POR', 2: 'DEF', 3: 'MED', 4: 'DEL' };

  /** Pide al Worker las plantillas de todos: hacen falta aquí y en Jugadores. */
  function ensureSquads() {
    if (state.squads) return;
    const config = loadSyncConfig();
    if (!config.url || !config.key) return;

    state.squads = { status: 'loading', list: [] };
    fetch(config.url.replace(/\/+$/, '') + '/?key=' + encodeURIComponent(config.key) + '&squads=1',
      { headers: { 'accept': 'application/json' } })
      .then(function (response) { return response.json(); })
      .then(function (payload) {
        if (payload.error) throw new Error(payload.error);
        state.squads = { status: 'ok', list: payload.squads || [] };
        render();
      })
      .catch(function () {
        state.squads = { status: 'error', list: [] };
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
    return { 2: parts[0] || 4, 3: parts[1] || 4, 4: parts[2] || 2 };
  }

  /* El once del simulador arranca con lo que tengas puesto en Biwenger y se
     puede cambiar libremente; no se envía a ningún sitio. */
  function ensureXi() {
    if (state.xi) return;
    const lineup = state.lineup;
    const type = (lineup && lineup.type) || '4-4-2';
    const slots = {};

    if (lineup && lineup.players) {
      const lines = formationLines(type);
      const used = { 1: 0, 2: 0, 3: 0, 4: 0 };
      lineup.players.forEach(function (player) {
        const pos = player.position || 3;
        const limit = pos === 1 ? 1 : lines[pos];
        if (used[pos] < limit) {
          slots[pos + '-' + used[pos]] = String(player.id);
          used[pos] += 1;
        }
      });
    }
    state.xi = { type: type, slots: slots };
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

  /** Foto de un futbolista como fondo; `extra` son clases del sitio donde va. */
  function faceOf(id, extra) {
    return '<span class="pic-player ' + extra + '" style="background-image:url(\'' +
      'https://cdn.biwenger.com/i/p/' + encodeURIComponent(id) + '.png\')"></span>';
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

    return '<div class="pitch__slot">' + face +
      '<span class="pitch__name">' + (player ? escapeHtml(player.name) : '—') + '</span>' +
      '<button type="button" class="pitch__pick" data-slot="' + key + '" data-position="' + position + '"' +
        ' aria-label="Cambiar el ' + POSITION_NAMES[position] +
        (player ? ': ahora ' + escapeHtml(player.name) : '') + '"></button>' +
    '</div>';
  }

  /* El cambio se elige por la cara, no en una lista desplegable. */
  function renderPicker() {
    const box = $('lineup-picker');
    const open = state.picker;
    if (!open || !state.xi) { box.hidden = true; box.innerHTML = ''; return; }

    /* Los de esta misma línea —incluido quien ocupa el hueco— no se listan:
       ahí no hay cambio que hacer. */
    const cards = slotCandidates(open.position).map(function (candidate) {
      return '<button type="button" class="picker__player"' +
        ' data-pick="' + escapeHtml(String(candidate.id)) + '">' +
        faceOf(candidate.id, 'picker__face') +
        '<span class="picker__name">' + escapeHtml(candidate.name) + '</span>' +
        '<span class="picker__meta">' + escapeHtml(candidate.role) +
          (candidate.moving ? ' · ' + escapeHtml(candidate.moving) : '') + '</span>' +
      '</button>';
    }).join('');

    const empty = '<button type="button" class="picker__player picker__player--empty" data-pick="">' +
      '<span class="pic-player picker__face picker__face--empty"></span>' +
      '<span class="picker__name">Dejar vacío</span>' +
      '<span class="picker__meta">sin jugador</span>' +
    '</button>';

    box.hidden = false;
    box.innerHTML =
      '<div class="picker__backdrop" data-picker-close></div>' +
      '<div class="picker__card" role="dialog" aria-modal="true" aria-label="Elegir ' +
        POSITION_NAMES[open.position] + '">' +
        '<div class="picker__head">' +
          '<strong>' + POSITION_NAMES[open.position] + ' · elige quién juega</strong>' +
          '<button type="button" class="btn btn--ghost btn--sm" data-picker-close>Cerrar</button>' +
        '</div>' +
        (cards
          ? '<div class="picker__grid">' + cards + empty + '</div>'
          : '<p class="muted">No queda nadie disponible para esta posición.</p>') +
      '</div>';
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

    $('lineup-formation').innerHTML = FORMATIONS.map(function (formation) {
      return '<option value="' + formation + '"' +
        (formation === state.xi.type ? ' selected' : '') + '>' + formation + '</option>';
    }).join('');

    $('pitch').innerHTML =
      '<span class="pitch__area pitch__area--top" aria-hidden="true"></span>' +
      '<span class="pitch__area pitch__area--bottom" aria-hidden="true"></span>' +
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
          return '<div class="bench__player">' +
            '<span class="pic-player" style="background-image:url(\'https://cdn.biwenger.com/i/p/' +
              encodeURIComponent(player.id) + '.png\')"></span>' +
            '<span class="bench__name">' + escapeHtml(player.name) + '</span>' +
          '</div>';
        }).join('');

    const titulares = Object.keys(state.xi.slots).filter(function (key) { return state.xi.slots[key]; }).length;
    const valor = Object.keys(state.xi.slots).reduce(function (sum, key) {
      const player = playerById(state.xi.slots[key]);
      return sum + ((player && player.marketValue) || 0);
    }, 0);
    $('lineup-count').textContent = titulares + ' de 11 titulares · ' + money(valor) + ' de valor en el campo';
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

  const MANAGER_COLUMNS = 7;

  /** Clasificación: por puntos y, a igualdad, por valor de equipo. */
  function managerRows() {
    const sort = state.sort.managers;
    const rows = computeBudgets(state.movements, state.teams);
    if (sort.key) return sortRows(rows, 'managers', sort);
    return rows.slice().sort(function (a, b) {
      const points = (b.points || 0) - (a.points || 0);
      return points || (b.teamValue || 0) - (a.teamValue || 0);
    });
  }

  function renderManagers() {
    updateSortHeaders('managers', state.sort.managers);

    $('managers-body').innerHTML = managerRows().map(function (row, index) {
      const open = state.expandedManager === row.name;
      return '<tr class="' + (open ? 'row-open' : '') + '">' +
        '<td class="col-rank">' + (index + 1) + '</td>' +
        '<td data-label="Futbolista">' +
          '<button type="button" class="row-toggle" data-manager-card="' + escapeHtml(row.name) + '"' +
            ' aria-expanded="' + (open ? 'true' : 'false') + '">' +
            '<span class="row-toggle__icon" aria-hidden="true">▸</span>' +
            '<span class="manager">' + avatar(row.name) +
              '<span class="manager__name">' + escapeHtml(row.name) + '</span></span>' +
          '</button></td>' +
        '<td class="num" data-label="Puntos"><strong>' + (row.points == null ? '—' : row.points) + '</strong></td>' +
        '<td class="num" data-label="Valor equipo">' +
          (row.teamValue == null ? '<span class="unknown">—</span>' : money(row.teamValue)) + '</td>' +
        '<td class="num" data-label="Jug.">' + (row.players == null ? '—' : row.players) + '</td>' +
        '<td class="num" data-label="Saldo"><span class="' + (row.balance < 0 ? 'money-neg' : '') + '">' +
          money(row.balance) + '</span></td>' +
        '<td class="num" data-label="Puja máxima"><strong class="bid-amount">' +
          (row.maxBid == null ? '—' : money(row.maxBid)) + '</strong></td>' +
      '</tr>' + (open ? managerPanel(row) : '');
    }).join('');
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
          squadColumn('since', 'Desde', '') +
          squadColumn('paid', 'Pagado', 'num') +
          squadColumn('marketValue', 'Valor de mercado', 'num') +
          squadColumn('diff', 'Diferencia', 'num') +
        '</tr></thead><tbody>' +
        sortSquad(squad.players).map(function (player) {
          const diff = player.paid == null || player.marketValue == null
            ? null : player.marketValue - player.paid;
          return '<tr>' +
            '<td class="detail-rank">' + (player.position ? POSITION_NAMES[player.position] : '—') + '</td>' +
            '<td>' + playerName({ playerId: player.id, player: player.name }) + '</td>' +
            '<td class="detail-date">' + shortDay(player.since) + '</td>' +
            '<td class="num">' + (player.paid == null
              ? '<span class="sub">reparto inicial</span>' : money(player.paid)) + '</td>' +
            '<td class="num"><strong>' + (player.marketValue == null ? '—' : money(player.marketValue)) + '</strong></td>' +
            '<td class="num">' + (diff == null ? '<span class="sub">—</span>' :
              '<span class="delta ' + (diff >= 0 ? 'delta--up' : 'delta--down') + '">' +
              (diff >= 0 ? '▲ +' : '▼ −') + money(Math.abs(diff)) + '</span>') + '</td>' +
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
              '<td>' + playerName(movement) + '</td>' +
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

  /* ---------- Pestañas ---------- */

  const TAB_KEY = 'biwenger-calc-tab';

  function showTab(name) {
    state.tab = name;
    // Se recuerda para que al recargar (o al tirar hacia abajo en el móvil)
    // sigas en la pestaña donde estabas.
    try { localStorage.setItem(TAB_KEY, name); } catch (error) { /* sin persistencia */ }
    Array.prototype.forEach.call(document.querySelectorAll('#tabs .tab'), function (tab) {
      tab.setAttribute('aria-selected', tab.getAttribute('data-tab') === name ? 'true' : 'false');
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-panel]'), function (panel) {
      panel.hidden = panel.getAttribute('data-panel') !== name;
    });
    if (name === 'managers') { renderManagers(); renderSquads(); }
    if (name === 'datos') { renderDataKpis(); renderKpiCharts(); renderSpending(); }
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
    renderWarnings();
    if (state.tab === 'managers') { renderManagers(); renderSquads(); }
    if (state.tab === 'datos') { renderDataKpis(); renderKpiCharts(); renderSpending(); }
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

  function loadSyncConfig() {
    try {
      const raw = localStorage.getItem(SYNC_KEY);
      const data = raw ? JSON.parse(raw) : null;
      return {
        url: (data && data.url) || '',
        key: (data && data.key) || '',
        lastSync: (data && data.lastSync) || null
      };
    } catch (error) {
      return { url: '', key: '', lastSync: null };
    }
  }

  function saveSyncConfig(config) {
    try { localStorage.setItem(SYNC_KEY, JSON.stringify(config)); } catch (error) { /* sin persistencia */ }
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
        amount: Math.round(item.amount || 0),
        date: isNaN(time) ? '' : dateFormat.format(new Date(time)),
        timestamp: isNaN(time) ? null : time,
        source: item.source || ''
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
        icon: item.icon || null
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
    state.me = payload.me || null;
    state.leagueStart = (payload.league && payload.league.startDay) || state.leagueStart;
    state.warnings = warnings;
    persist();
    recordSnapshot();
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
        setStatus('status-sync', message, 'err');
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
  function startAutoSync() {
    setInterval(function () {
      if (document.visibilityState === 'visible') syncNow(true);
    }, AUTO_SYNC_MS);

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible') return;
      if (!state.lastSync || Date.now() - state.lastSync > AUTO_SYNC_MS) syncNow(true);
    });
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

  function exportCsv() {
    const rows = budgetRows();
    const header = ['Jugador', 'Fichajes', 'Ventas', 'Inicial', 'Gastado', 'Ingresado', 'Saldo disponible', 'Valor equipo', 'Puja máxima'];
    const lines = [header.join(';')].concat(rows.map(function (row) {
      return [
        row.name,
        row.buys,
        row.sells,
        row.initial,
        row.spent,
        row.earned,
        row.balance,
        row.teamValue == null ? '' : row.teamValue,
        row.maxBid == null ? '' : Math.round(row.maxBid)
      ].join(';');
    }));
    const bom = String.fromCharCode(0xfeff);
    const blob = new Blob([bom + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'presupuestos-biwenger.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
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
      showTab('inicio');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

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

    $('data-kpis').addEventListener('click', function (event) {
      const row = event.target.closest('[data-kpi]');
      if (row) toggleKpi(row.getAttribute('data-kpi'));
    });

    bindSorting('managers');

    $('lineup-formation').addEventListener('change', function (event) {
      ensureXi();
      state.xi.type = event.target.value;
      // Se recolocan los que quepan en la nueva distribución.
      const lines = formationLines(state.xi.type);
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
      // Al cambiar de sistema, el hueco que se estaba eligiendo puede no existir.
      state.picker = null;
      renderLineup();
      renderPicker();
    });

    $('pitch').addEventListener('click', function (event) {
      const pick = event.target.closest('[data-slot]');
      if (!pick) return;
      state.picker = {
        slot: pick.getAttribute('data-slot'),
        position: Number(pick.getAttribute('data-position'))
      };
      renderPicker();
    });

    $('lineup-picker').addEventListener('click', function (event) {
      if (event.target.closest('[data-picker-close]')) {
        state.picker = null;
        renderPicker();
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
      renderLineup();
      renderPicker();
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && state.picker) {
        state.picker = null;
        renderPicker();
      }
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
    $('btn-csv').addEventListener('click', exportCsv);

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

    const sync = loadSyncConfig();
    $('sync-url').value = sync.url;
    $('sync-key').value = sync.key;
    state.lastSync = sync.lastSync;
    renderLastSync(state.lastSync);

    const hadData = loadStored();
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
