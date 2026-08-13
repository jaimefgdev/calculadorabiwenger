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
   * Localiza un mánager de la liga dentro de un texto. La búsqueda arranca en
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

    // El mánager viene en la tarjeta (fichajes) o en el title / autor del post
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
      warnings.push('No se ha identificado al mánager en el movimiento de «' + player + '» (' + money(amount) + ').');
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
     entre mánagers empatados manda el saldo más alto. */
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
    expanded: {},          // mánagers con la ficha de jugadores desplegada
    charts: { saldo: true, value: true, bid: true },
    kpiCharts: { moves: false, spent: false, earned: false, balance: false },
    kpiOpen: [],           // orden de apertura, para cerrar el más antiguo
    kpi: null,             // últimos valores de cabecera
    tab: 'inicio',
    expandedManager: null,
    listings: [],
    sim: {},               // operaciones marcadas para simular
    history: {},           // valor de equipo día a día, por mánager
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
      detail: { key: 'amount', dir: -1 }   // dentro de la ficha de cada mánager
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

  /* Colores propios de algunos mánagers; el resto tira de la paleta automática. */
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
    const team = state.teams[name];
    const photo = team && team.icon
      ? '<i class="avatar__pic" style="background-image:url(\'' + escapeHtml(team.icon) + '\')"></i>'
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
        label: 'Total gastado', value: money(spent), modifier: 'kpi--out',
        foot: buys > 0 ? 'Media por fichaje: ' + money(spent / buys) : 'Sin fichajes'
      },
      earned: {
        label: 'Total ingresado', value: money(earned), modifier: 'kpi--in',
        foot: sells > 0 ? 'Media por venta: ' + money(earned / sells) : 'Sin ventas'
      },
      balance: {
        label: 'Saldo total en liga', value: money(balance), modifier: '',
        foot: negatives > 0
          ? negatives + (negatives === 1 ? ' mánager en números rojos' : ' mánagers en números rojos')
          : 'Ningún mánager en números rojos'
      }
    };
  }

  /** Las tarjetas de la pestaña Datos, pulsables para abrir su gráfico. */
  function renderDataKpis() {
    const kpi = state.kpi || kpiValues(budgetRows());

    $('data-kpis').innerHTML = KPI_SERIES.map(function (serie) {
      const info = kpi[serie.key];
      const on = state.kpiCharts[serie.key];
      return '<article class="kpi ' + info.modifier + '" data-kpi="' + serie.key + '" role="button" tabindex="0"' +
        ' aria-pressed="' + (on ? 'true' : 'false') + '" title="Ver evolución por días">' +
        '<span class="kpi__label">' + info.label + '</span>' +
        '<strong class="kpi__value">' + info.value + '</strong>' +
        '<span class="kpi__foot">' + info.foot + '</span>' +
      '</article>';
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

  /** Guarda el valor de equipo de hoy de cada mánager (una foto por día). */
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
    { key: 'value',  label: 'Valor equipo', color: 'var(--viz-2)' },
    { key: 'bid',    label: 'Puja máxima',  color: 'var(--viz-3)' }
  ];

  /**
   * Pide al Worker el valor de equipo día a día de un mánager. Se reconstruye
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

  /** Serie diaria de saldo, valor de equipo y puja máxima de un mánager. */
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

      return {
        day: day,
        saldo: balance,
        value: value,
        bid: value != null ? balance + value * TEAM_VALUE_SHARE : null
      };
    });
  }

  const shortDay = (day) => day.slice(8, 10) + '/' + day.slice(5, 7);
  const shortMoney = (n) => (Math.round(n / 100000) / 10).toFixed(1).replace('.', ',') + 'M';

  /**
   * Gráfico de líneas en SVG, sin librerías. Ancho fijo en el viewBox y
   * escalado por CSS; el trazo se mantiene a 2 px reales.
   */
  function lineChart(points, key, color, label, options) {
    const opts = options || {};
    const isCount = !!opts.count;
    const isBars = !!opts.bars;
    const fmtTick = isCount ? function (v) { return String(Math.round(v)); } : shortMoney;
    const fmtFull = isCount ? function (v) { return Math.round(v) + (v === 1 ? ' movimiento' : ' movimientos'); } : money;
    const valid = points.filter(function (point) { return point[key] != null; });
    if (valid.length === 0) {
      return '<p class="viz__empty">Sin datos todavía de ' + escapeHtml(label.toLowerCase()) + '.</p>';
    }

    const W = 600, H = 130, padX = 46, padTop = 14, padBottom = 22;
    const values = valid.map(function (point) { return point[key]; });
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
    { key: 'moves',   field: 'movesDay',  label: 'Movimientos',         color: 'var(--viz-1)', count: true },
    { key: 'spent',   field: 'spentDay',  label: 'Gastado',             color: 'var(--viz-4)' },
    { key: 'earned',  field: 'earnedDay', label: 'Ingresado',           color: 'var(--viz-2)' },
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
      let movesDay = 0, spentDay = 0, earnedDay = 0;
      while (index < moves.length && dayKey(moves[index].timestamp) <= day) {
        movesDay += 1;
        if (moves[index].type === 'buy') spentDay += moves[index].amount;
        else earnedDay += moves[index].amount;
        index += 1;
      }
      spent += spentDay;
      earned += earnedDay;
      return {
        day: day,
        movesDay: movesDay,
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
      return '<figure class="viz panel viz--kpi">' +
        '<figcaption class="viz__head">' + caption + '<strong>' + value + '</strong></figcaption>' +
        lineChart(points, serie.field, serie.color, serie.label, { count: serie.count, bars: serie.bars }) +
      '</figure>';
    }).join('');
  }

  /**
   * Orden dentro de la ficha de un mánager. Por «Acción» agrupa compras y
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

  /** Ficha desplegable de un mánager con sus jugadores. */
  function managerDetail(name) {
    const moves = sortDetail(
      state.movements.filter(function (movement) { return movement.manager === name; }),
      state.sort.detail
    );

    const inner = moves.length === 0
      ? '<p class="muted">Este mánager no tiene movimientos en el tablón.</p>'
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
       Mánagers, dentro de la ficha de cada uno. */
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
        '<td data-label="Mánager">' +
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
        '<td data-label="Jugador">' + playerName(movement) + '</td>' +
        '<td data-label="Acción"><span class="tag ' + (buy ? 'tag--buy' : 'tag--sell') + '">' +
          (buy ? '↓ Fichado' : '↑ Vendido') + '</span></td>' +
        '<td data-label="Mánager">' + managerCell + '</td>' +
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

  /** Mi mánager, el dueño del token con el que sincronizamos. */
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
    state.offers.concat(marketSales()).forEach(function (offer) {
      if (!state.sim[offer.id]) return;
      count += 1;
      delta += offer.direction === 'out' ? -offer.amount : offer.amount;
    });

    const teamValue = mine ? mine.teamValue : null;
    return {
      name: name,
      base: base,
      delta: delta,
      count: count,
      balance: base + delta,
      maxBid: teamValue == null ? null : base + delta + teamValue * TEAM_VALUE_SHARE
    };
  }

  function simToggle(id, checked) {
    return '<button type="button" class="switch" data-sim="' + escapeHtml(id) + '" aria-pressed="' +
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
        '<td data-label="Jugador">' + playerName(offer) + '</td>' +
        '<td data-label="Tipo"><span class="tag ' + (out ? 'tag--buy' : 'tag--sell') + '">' +
          (out ? '↗ Puja enviada' : '↘ Oferta recibida') + '</span></td>' +
        '<td data-label="Con">' + escapeHtml(offer.other || 'Mercado') + '</td>' +
        '<td class="num" data-label="Importe"><strong>' + (out ? '−' : '+') + money(offer.amount) + '</strong></td>' +
        '<td data-label="Simular">' + simToggle(offer.id, on) + '</td>' +
      '</tr>';
    }).join('');

    const outgoing = list.filter(function (offer) { return offer.direction === 'out'; });
    const committed = outgoing.reduce(function (sum, offer) { return sum + offer.amount; }, 0);
    const incoming = list.length - outgoing.length;

    const parts = [];
    if (outgoing.length) {
      parts.push(outgoing.length + (outgoing.length === 1 ? ' puja enviada' : ' pujas enviadas') +
        ' · ' + money(committed) + ' comprometidos');
    }
    if (incoming) parts.push(incoming + (incoming === 1 ? ' oferta recibida' : ' ofertas recibidas'));
    $('offers-count').textContent = parts.join(' · ');

    renderSimulation();
  }

  /** Resumen de cómo quedaría el dinero con lo marcado. */
  function renderSimulation() {
    const note = $('offers-note');
    const sim = simulation();

    if (sim.count === 0) {
      note.hidden = !(state.me && state.me.balance != null);
      if (!note.hidden) {
        note.innerHTML = 'Tu saldo es <strong>' + money(sim.base) +
          '</strong>. Marca pujas u ofertas para simular cómo te quedaría.';
      }
      return;
    }

    note.hidden = false;
    note.innerHTML = 'Con ' + sim.count + (sim.count === 1 ? ' operación marcada' : ' operaciones marcadas') +
      ': saldo <strong>' + money(sim.base) + '</strong> → ' +
      '<strong class="' + (sim.balance < 0 ? 'money-neg' : 'money-pos') + '">' + money(sim.balance) + '</strong>' +
      (sim.maxBid == null ? '' : ' · puja máxima <strong>' + money(sim.maxBid) + '</strong>') +
      (sim.balance < 0 ? ' — te quedarías en números rojos.' : '');
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
            return '<span class="bid' + (on ? ' bid--on' : '') + '">' +
              '<strong class="money-market">' + money(market) + '</strong> ' +
              '<span class="sub">valor de mercado</span> ' + simToggle(id, on) + '</span>';
          })()
        : bids.map(function (offer) {
            const on = !!state.sim[offer.id];
            // Verde si mejora el valor de mercado, rojo si lo empeora.
            const tone = offer.amount > market ? 'money-pos' : (offer.amount < market ? 'money-neg' : '');
            return '<span class="bid' + (on ? ' bid--on' : '') + '">' +
              '<strong class="' + tone + '">' + money(offer.amount) + '</strong> ' +
              '<span class="sub">' + escapeHtml(offer.other || 'Mercado') + '</span> ' +
              simToggle(offer.id, on) + '</span>';
          }).join('');

      return '<tr>' +
        '<td data-label="Jugador">' + playerName(item) + '</td>' +
        '<td class="num" data-label="Valor de mercado"><strong>' + money(market) + '</strong></td>' +
        '<td class="num" data-label="Precio pedido"><span class="sub">' + money(item.price) + '</span></td>' +
        '<td data-label="Ofertas">' + offerCell + '</td>' +
      '</tr>';
    }).join('');

    const total = list.reduce(function (sum, item) { return sum + listingValue(item); }, 0);
    $('listings-count').textContent = list.length + (list.length === 1 ? ' jugador en venta' : ' jugadores en venta') +
      ' · ' + money(total) + ' de valor de mercado';
  }

  /* ---------- Pestaña de mánagers ---------- */

  /** Récords de un mánager: sus operaciones extremas. */
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
        '<td data-label="Mánager">' +
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

  /** Ficha completa de un mánager: cifras, récords y gráficos. */
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
    if (name === 'managers') renderManagers();
    if (name === 'datos') { renderDataKpis(); renderKpiCharts(); }
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
    select.innerHTML = '<option value="">Todos los mánagers</option>' +
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
    renderWarnings();
    if (state.tab === 'managers') renderManagers();
    if (state.tab === 'datos') { renderDataKpis(); renderKpiCharts(); }
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
    const header = ['Mánager', 'Fichajes', 'Ventas', 'Inicial', 'Gastado', 'Ingresado', 'Saldo disponible', 'Valor equipo', 'Puja máxima'];
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
      const card = event.target.closest('[data-kpi]');
      if (card) toggleKpi(card.getAttribute('data-kpi'));
    });

    $('data-kpis').addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const card = event.target.closest('[data-kpi]');
      if (!card) return;
      event.preventDefault();
      toggleKpi(card.getAttribute('data-kpi'));
    });

    bindSorting('managers');

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
  }

  document.addEventListener('DOMContentLoaded', init);
})();
