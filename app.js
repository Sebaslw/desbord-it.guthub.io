(function () {
  'use strict';

  /* ================================================================
   * Estado y utilidades
   * ================================================================ */
  var BOOT = window.__BOOT__;
  var PERM = BOOT.permisos;
  var S = {
    view: 'dashboard',
    prop: '*',
    q: { texto: '', estado: '', prioridad: '', sla: '', tecnico: '', plataforma: '', page: 1, pageSize: 25 },
    rep: { desde: '', hasta: '' },
    ticket: null
  };
  try { S.prop = localStorage.getItem('hd_prop') || '*'; } catch (e) { /* almacenamiento no disponible */ }
  if (S.prop !== '*' && !BOOT.propiedades.some(function (p) { return p.id === S.prop; })) S.prop = '*';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function api(fn) {
    var args = Array.prototype.slice.call(arguments, 1);
    return new Promise(function (resolve, reject) {
      var runner = google.script.run.withSuccessHandler(resolve).withFailureHandler(function (e) {
        reject(e && e.message ? e : new Error(String(e)));
      });
      runner[fn].apply(runner, args);
    });
  }

  var TZ = BOOT.timezone;
  function fmt(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('es-CO', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  }
  function fmtShort(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('es-CO', { timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  }
  function dur(m) {
    if (m === null || m === undefined || m === '' || isNaN(m)) return '—';
    m = Math.round(m);
    if (m < 60) return m + ' min';
    var h = Math.floor(m / 60), r = m % 60;
    if (h < 24) return h + ' h' + (r ? ' ' + r + ' min' : '');
    var d = Math.floor(h / 24), hh = h % 24;
    return d + ' d' + (hh ? ' ' + hh + ' h' : '');
  }
  function pct(v) { return v === null || v === undefined ? '—' : String(v).replace('.', ',') + ' %'; }

  var ESTADO_CLASS = { 'PENDIENTE': 'b-red', 'EN PROCESO': 'b-amber', 'CERRADO': 'b-green' };
  var SLA_CLASS = { 'EN TIEMPO': 'b-green', 'PRÓXIMO A VENCER': 'b-amber', 'VENCIDO': 'b-red', 'PAUSADO': 'b-blue', 'CUMPLIDO': 'b-green', 'INCUMPLIDO': 'b-red', 'SIN SLA': 'b-gray' };
  var PLAT_LABEL = { GOOGLE: 'Google', M365: 'Microsoft 365', MANUAL: 'Manual', PRUEBA: 'Prueba' };

  function estadoBadge(e) { return '<span class="badge ' + (ESTADO_CLASS[e] || 'b-gray') + '">' + esc(e) + '</span>'; }
  function slaBadge(e) { return '<span class="badge ' + (SLA_CLASS[e] || 'b-gray') + '">' + esc(e || '—') + '</span>'; }
  function prioTag(p) { return '<span class="prio prio-' + esc(p) + '">' + esc(p) + '</span>'; }
  function options(list, selected, emptyLabel) {
    var html = emptyLabel !== undefined ? '<option value="">' + esc(emptyLabel) + '</option>' : '';
    return html + list.map(function (o) {
      var v = typeof o === 'object' ? o.value : o, l = typeof o === 'object' ? o.label : o;
      return '<option value="' + esc(v) + '"' + (String(v) === String(selected) ? ' selected' : '') + '>' + esc(l) + '</option>';
    }).join('');
  }

  function toast(msg, kind) {
    var el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(function () { el.remove(); }, kind === 'error' ? 7000 : 3500);
  }
  function loadingHtml(msg) { return '<div class="loading"><div class="spinner"></div>' + esc(msg || 'Cargando…') + '</div>'; }
  function errorHtml(err, retryId) {
    return '<div class="error-box"><span>' + esc(err.message || err) + '</span>' +
      (retryId ? '<button class="btn small" id="' + retryId + '">Reintentar</button>' : '') + '</div>';
  }

  var ICONS = {
    dashboard: '<path d="M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
    tickets: '<path d="M4 7h16M4 12h16M4 17h10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    reports: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    connectors: '<path d="M9 7V3M15 7V3M7 7h10v4a5 5 0 0 1-10 0zM12 16v5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>'
  };
  function icon(name) { return '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' + ICONS[name] + '</svg>'; }

  /* ================================================================
   * Shell: navegación, logos, selector de propiedad
   * ================================================================ */
  var NAV = [
    { id: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
    { id: 'tickets', label: 'Mesa de ayuda', icon: 'tickets' },
    { id: 'reports', label: 'Reportes', icon: 'reports' }
  ];
  if (PERM.conectores) NAV.push({ id: 'connectors', label: 'Conectores', icon: 'connectors' });

  function renderShell() {
    $('#nav').innerHTML = NAV.map(function (n) {
      return '<button data-nav="' + n.id + '"' + (S.view === n.id ? ' aria-current="page"' : '') + '>' + icon(n.icon) + '<span>' + esc(n.label) + '</span></button>';
    }).join('');
    $('#bottomnav').innerHTML = NAV.map(function (n) {
      return '<button data-nav="' + n.id + '"' + (S.view === n.id ? ' aria-current="page"' : '') + '>' + icon(n.icon) + '<span>' + esc(n.label) + '</span></button>';
    }).join('');
    $('#sidebarFoot').innerHTML = '<div class="demo-box"><label for="demoUser">Usuario</label><select id="demoUser">' +
      options(BOOT.usuariosDemo.map(function (u) { return { value: u.email, label: u.nombre + ' · ' + u.rol }; }), BOOT.usuario.email) +
      '</select><button class="demo-reset" id="demoReset">Borrar todos los datos</button></div>v' + esc(BOOT.app.version);
    $('#demoUser').addEventListener('change', function () { window.__DEMO__.setDemoUser(this.value); location.reload(); });
    $('#demoReset').addEventListener('click', function () {
      if (confirm('¿Borrar todos los tickets, historial y alertas guardados en este navegador? Esta acción no se puede deshacer.')) { window.__DEMO__.resetDemo(); location.reload(); }
    });
  }

  function renderHeader() {
    $('#logos').innerHTML = BOOT.logos.map(function (l, i) {
      return (i ? '<span class="logo-sep" aria-hidden="true"></span>' : '') +
        '<span class="logo-box"><img src="' + esc(l.url) + '" alt="' + esc(l.nombre) + '" referrerpolicy="no-referrer" loading="eager" data-fallback="' + esc(l.nombre) + '"></span>';
    }).join('');
    $$('#logos img').forEach(function (img) {
      img.addEventListener('error', function () {
        var span = document.createElement('span');
        span.className = 'logo-fallback';
        span.textContent = img.getAttribute('data-fallback');
        img.replaceWith(span);
      });
    });
    var opts = [{ value: '*', label: 'Todas las propiedades' }].concat(BOOT.propiedades.map(function (p) { return { value: p.id, label: p.nombreCorto }; }));
    $('#propSelect').innerHTML = options(opts, S.prop);
    var initials = (BOOT.usuario.nombre || BOOT.usuario.email).split(/\s+/).map(function (w) { return w.charAt(0); }).slice(0, 2).join('').toUpperCase();
    $('#userChip').innerHTML = '<span class="avatar" title="' + esc(BOOT.usuario.email) + '">' + esc(initials) + '</span>' +
      '<span class="u-name">' + esc(BOOT.usuario.nombre) + '</span><span class="role-pill">' + esc(BOOT.usuario.rol) + '</span>';
    $('#banner').innerHTML = '<div class="banner demo"><b>Versión local.</b> Los tickets se guardan solo en este navegador. Los buzones se simulan (Conectores → Simular correo entrante) y no se envía ningún correo. Los tiempos SLA son los de la tabla de ejemplo.</div>';
  }

  function go(view) {
    S.view = view;
    closeSidebar();
    renderShell();
    var v = $('#view');
    v.focus();
    if (view === 'dashboard') renderDashboard();
    else if (view === 'tickets') renderTickets();
    else if (view === 'reports') renderReports();
    else if (view === 'connectors') renderConnectors();
  }

  function openSidebar() { $('#sidebar').classList.add('open'); $('#scrim').hidden = false; $('#menuBtn').setAttribute('aria-expanded', 'true'); }
  function closeSidebar() { $('#sidebar').classList.remove('open'); $('#scrim').hidden = true; $('#menuBtn').setAttribute('aria-expanded', 'false'); }

  document.addEventListener('click', function (e) {
    var nav = e.target.closest('[data-nav]');
    if (nav) { go(nav.getAttribute('data-nav')); return; }
    var open = e.target.closest('[data-open]');
    if (open) { openTicket(open.getAttribute('data-open')); }
  });
  $('#menuBtn').addEventListener('click', openSidebar);
  $('#scrim').addEventListener('click', closeSidebar);
  $('#propSelect').addEventListener('change', function () {
    S.prop = this.value;
    S.q.page = 1;
    try { localStorage.setItem('hd_prop', S.prop); } catch (e) { /* sin almacenamiento */ }
    go(S.view);
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });

  /* ================================================================
   * Dashboard DESBORD IT
   * ================================================================ */
  function donut(segs, total) {
    var r = 66, c = 2 * Math.PI * r, off = 0;
    var arcs = segs.map(function (s) {
      var len = total ? s.value / total * c : 0;
      var a = len > 0 ? '<circle r="' + r + '" cx="95" cy="95" fill="none" stroke="' + s.color + '" stroke-width="28" stroke-dasharray="' + len.toFixed(2) + ' ' + (c - len).toFixed(2) + '" stroke-dashoffset="' + (-off).toFixed(2) + '" transform="rotate(-90 95 95)"><title>' + esc(s.label + ': ' + s.value) + '</title></circle>' : '';
      off += len;
      return a;
    }).join('');
    return '<svg viewBox="0 0 190 190" class="donut" role="img" aria-label="Estado general: ' + segs.map(function (s) { return s.label + ' ' + s.value; }).join(', ') + '">' +
      '<circle r="' + r + '" cx="95" cy="95" fill="none" stroke="#EEF1F5" stroke-width="28"/>' + arcs +
      '<text x="95" y="96" text-anchor="middle" class="donut-num">' + total + '</text><text x="95" y="116" text-anchor="middle" class="donut-lbl">tickets</text></svg>';
  }

  function bars(items) {
    if (!items.length) return '<div class="empty">Sin datos</div>';
    var max = Math.max.apply(null, items.map(function (i) { return i.valor; })) || 1;
    return '<div class="bars">' + items.map(function (i) {
      return '<div class="bar-row"><span class="b-label" title="' + esc(i.etiqueta) + '">' + esc(i.etiqueta) + '</span>' +
        '<span class="bar-track"><span class="bar-fill" style="width:' + (i.valor / max * 100).toFixed(1) + '%"></span></span><span class="b-val">' + i.valor + '</span></div>';
    }).join('') + '</div>';
  }

  function miniList(items, emptyMsg, kind) {
    if (!items.length) return '<div class="empty">' + esc(emptyMsg) + '</div>';
    return '<ul class="mini-list">' + items.map(function (t) {
      var pendResp = !t.fechaPrimeraRespuesta;
      var v = pendResp ? t.slaRespuestaVence : t.slaResolucionVence;
      return '<li data-open="' + esc(t.ticketId) + '"><span class="ml-id">' + esc(t.ticketId) + '</span>' +
        '<span class="ml-body"><div class="ml-title">' + esc(t.asunto) + '</div><div class="ml-meta">' +
        esc(t.solicitanteNombre) + ' · ' + esc(t.propiedadNombre) + ' · ' + (kind ? (pendResp ? 'Respuesta ' : 'Resolución ') + 'vence ' + fmtShort(v) : fmtShort(t.fechaSolicitud)) +
        '</div></span>' + (kind ? prioTag(t.prioridad) : estadoBadge(t.estado)) + '</li>';
    }).join('') + '</ul>';
  }

  function renderDashboard() {
    var v = $('#view');
    v.innerHTML = '<div class="page-head"><div><h1>DESBORD IT</h1><p>' + esc(propLabel()) + '</p></div>' +
      (PERM.crearTicket ? '<button class="btn primary" id="newTicketBtn">+ Nuevo ticket</button>' : '') + '</div>' +
      '<div class="grid kpis">' + [1, 2, 3, 4].map(function () { return '<div class="card skeleton"></div>'; }).join('') + '</div>' + loadingHtml('Calculando indicadores…');
    bindNewTicket();
    var prop = S.prop;
    api('getDashboard', prop).then(function (d) {
      if (S.view !== 'dashboard' || S.prop !== prop) return;
      var k = d.kpis, total = k.total;
      var segs = [
        { label: 'PENDIENTE', value: k.pendiente, color: '#D93A3A' },
        { label: 'EN PROCESO', value: k.enProceso, color: '#E5A100' },
        { label: 'CERRADO', value: k.cerrado, color: '#22995A' }
      ];
      var p = function (n) { return total ? (n / total * 100).toFixed(1).replace('.', ',') + ' %' : '0 %'; };
      var kpi = function (cls, label, value, sub, estado) {
        return '<div class="card kpi ' + cls + '" role="button" tabindex="0" data-kpi="' + esc(estado) + '"><div class="kpi-label">' + label + '</div><div class="kpi-value">' + value + '</div><div class="kpi-sub">' + sub + '</div></div>';
      };
      v.innerHTML = '<div class="page-head"><div><h1>DESBORD IT</h1><p>' + esc(propLabel()) + ' · actualizado ' + fmtShort(d.generado) + '</p></div>' +
        '<div class="actions"><button class="btn" id="refreshBtn">Actualizar</button>' +
        (PERM.crearTicket ? '<button class="btn primary" id="newTicketBtn">+ Nuevo ticket</button>' : '') + '</div></div>' +
        '<div class="grid kpis">' +
          kpi('red', 'Pendiente', k.pendiente, p(k.pendiente) + ' del total', 'PENDIENTE') +
          kpi('amber', 'En proceso', k.enProceso, p(k.enProceso) + ' del total', 'EN PROCESO') +
          kpi('green', 'Cerrado', k.cerrado, p(k.cerrado) + ' del total', 'CERRADO') +
          kpi('navy', 'Total de tickets', total, k.porIdentificar + ' por identificar propiedad', '') +
        '</div>' +
        '<div class="grid metrics">' +
          '<div class="card metric alert" role="button" tabindex="0" data-sla="VENCIDO"><div class="m-label">Vencidos por SLA</div><div class="m-value">' + k.vencidos + '</div></div>' +
          '<div class="card metric warn" role="button" tabindex="0" data-sla="PRÓXIMO A VENCER"><div class="m-label">Próximos a vencer</div><div class="m-value">' + k.proximos + '</div></div>' +
          '<div class="card metric ok"><div class="m-label">Cumplimiento SLA</div><div class="m-value">' + pct(k.cumplimientoPct) + '</div><div class="kpi-sub">' + k.slaCumplidos + ' de ' + k.slaEvaluables + ' cerrados</div></div>' +
          '<div class="card metric"><div class="m-label">T. medio 1ª respuesta</div><div class="m-value">' + dur(k.tmprMin) + '</div><div class="kpi-sub">1ª resp. a tiempo: ' + pct(k.cumplimientoRespuestaPct) + '</div></div>' +
          '<div class="card metric"><div class="m-label">T. medio de resolución</div><div class="m-value">' + dur(k.tmrMin) + '</div><div class="kpi-sub">tiempo de servicio</div></div>' +
        '</div>' +
        '<div class="grid dash-row">' +
          '<section class="card"><h2 class="section-title">Estado general de tickets</h2><div class="donut-wrap">' + donut(segs, total) +
            '<ul class="legend">' + segs.map(function (s) {
              return '<li><span class="swatch" style="background:' + s.color + '"></span><span class="l-name">' + s.label + '</span><span class="l-val">' + s.value + '</span><span class="l-pct">' + p(s.value) + '</span></li>';
            }).join('') + '</ul></div></section>' +
          '<section class="card"><h2 class="section-title">Tickets por categoría</h2>' + bars(d.porCategoria) +
            '<h2 class="section-title" style="margin-top:20px">Abiertos por prioridad</h2>' + bars(d.porPrioridadAbiertos) + '</section>' +
        '</div>' +
        '<div class="grid lists">' +
          '<section class="card"><h2 class="section-title">Vencidos por SLA</h2>' + miniList(d.vencidos, 'No hay tickets vencidos.', 'sla') + '</section>' +
          '<section class="card"><h2 class="section-title">Próximos a vencer</h2>' + miniList(d.proximos, 'No hay tickets próximos a vencer.', 'sla') + '</section>' +
          '<section class="card"><h2 class="section-title">Solicitudes recientes</h2>' + miniList(d.recientes, 'Aún no hay tickets.') + '</section>' +
          (d.conectores ? '<section class="card"><h2 class="section-title">Conectores de correo</h2>' + connectorMini(d.conectores) + '</section>' : '') +
        '</div>';
      bindNewTicket();
      $('#refreshBtn').addEventListener('click', renderDashboard);
      $$('[data-kpi]', v).forEach(function (el) { activate(el, function () { S.q = Object.assign({}, S.q, { estado: el.getAttribute('data-kpi'), sla: '', page: 1 }); go('tickets'); }); });
      $$('[data-sla]', v).forEach(function (el) { activate(el, function () { S.q = Object.assign({}, S.q, { estado: '', sla: el.getAttribute('data-sla'), page: 1 }); go('tickets'); }); });
    }).catch(function (err) {
      v.innerHTML = '<div class="page-head"><h1>DESBORD IT</h1></div>' + errorHtml(err, 'retryDash');
      $('#retryDash').addEventListener('click', renderDashboard);
    });
  }

  function activate(el, fn) {
    el.addEventListener('click', fn);
    el.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } });
  }

  function connectorMini(list) {
    if (!list.length) return '<div class="empty">Sin conectores registrados.</div>';
    return '<ul class="mini-list">' + list.map(function (c) {
      return '<li data-nav="connectors"><span class="ml-body"><div class="ml-title">' + esc(PLAT_LABEL[c.plataforma] || c.plataforma) + ' · ' + esc(c.buzon) + '</div>' +
        '<div class="ml-meta">Última ejecución ' + fmtShort(c.ultimaEjecucion) + ' · último éxito ' + fmtShort(c.ultimoResultadoCorrecto) + '</div></span>' + connBadge(c.estadoConexion) + '</li>';
    }).join('') + '</ul>';
  }
  function connBadge(s) {
    s = String(s || 'SIN PROBAR');
    var cls = /^OK$|VERIFICADA/.test(s) ? 'b-green' : /ERROR/.test(s) ? 'b-red' : /CON ERRORES/.test(s) ? 'b-amber' : 'b-gray';
    return '<span class="badge ' + cls + '">' + esc(s) + '</span>';
  }

  function propLabel() {
    if (S.prop === '*') return 'Todas las propiedades';
    var p = BOOT.propiedades.filter(function (x) { return x.id === S.prop; })[0];
    return p ? p.nombreCorto : S.prop;
  }

  /* ================================================================
   * Mesa de ayuda
   * ================================================================ */
  var searchTimer = null;

  function renderTickets() {
    var v = $('#view');
    var q = S.q;
    var techOpts = BOOT.tecnicos.map(function (t) { return { value: t.email, label: t.nombre }; });
    var platOpts = BOOT.catalogos.plataformas.map(function (p) { return { value: p, label: PLAT_LABEL[p] || p }; });
    v.innerHTML = '<div class="page-head"><div><h1>Mesa de ayuda</h1><p>' + esc(propLabel()) + '</p></div>' +
      (PERM.crearTicket ? '<button class="btn primary" id="newTicketBtn">+ Nuevo ticket</button>' : '') + '</div>' +
      '<div class="toolbar">' +
        '<label class="search"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M20 20l-3.5-3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>' +
        '<input id="fTexto" type="search" placeholder="Buscar por ID, asunto, solicitante, correo…" value="' + esc(q.texto) + '" aria-label="Buscar tickets"></label>' +
        '<select class="select" id="fEstado" aria-label="Estado">' + options(BOOT.catalogos.estados, q.estado, 'Todos los estados') + '</select>' +
        '<select class="select" id="fPrioridad" aria-label="Prioridad">' + options(BOOT.catalogos.prioridades, q.prioridad, 'Todas las prioridades') + '</select>' +
        '<select class="select" id="fSla" aria-label="Estado SLA">' + options(BOOT.catalogos.slaEstados, q.sla, 'Todo SLA') + '</select>' +
        '<select class="select" id="fTecnico" aria-label="Técnico">' + options(techOpts, q.tecnico, 'Todos los técnicos') + '</select>' +
        '<select class="select" id="fPlataforma" aria-label="Origen">' + options(platOpts, q.plataforma, 'Todo origen') + '</select>' +
        '<button class="btn" id="fClear">Limpiar</button>' +
      '</div>' +
      '<div class="card table-card" id="ticketTable">' + loadingHtml('Cargando tickets…') + '</div>';
    bindNewTicket();
    var update = function (key, val) { S.q[key] = val; S.q.page = 1; loadTickets(); };
    $('#fTexto').addEventListener('input', function () {
      var val = this.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () { update('texto', val.trim()); }, 350);
    });
    [['fEstado', 'estado'], ['fPrioridad', 'prioridad'], ['fSla', 'sla'], ['fTecnico', 'tecnico'], ['fPlataforma', 'plataforma']].forEach(function (p) {
      $('#' + p[0]).addEventListener('change', function () { update(p[1], this.value); });
    });
    $('#fClear').addEventListener('click', function () {
      S.q = { texto: '', estado: '', prioridad: '', sla: '', tecnico: '', plataforma: '', page: 1, pageSize: 25 };
      renderTickets();
    });
    loadTickets();
  }

  var listSeq = 0;
  function loadTickets() {
    var box = $('#ticketTable');
    if (!box) return;
    var seq = ++listSeq;
    box.style.opacity = '.6';
    api('listTickets', Object.assign({}, S.q, { propiedadId: S.prop })).then(function (r) {
      if (seq !== listSeq || !$('#ticketTable')) return;
      box.style.opacity = '';
      if (!r.items.length) { box.innerHTML = '<div class="empty">No hay tickets que coincidan con los filtros.</div>'; return; }
      box.innerHTML = '<div class="table-wrap"><table class="tickets"><thead><tr>' +
        ['ID', 'Detalle de la solicitud', 'Tipo de caso', 'Solicitante', 'Correo', 'Área', 'Propiedad', 'Origen', 'Técnico', 'Estado', 'Prioridad', 'Solicitud', '1ª respuesta', 'Cierre', 'SLA']
          .map(function (h) { return '<th scope="col">' + h + '</th>'; }).join('') +
        '</tr></thead><tbody>' + r.items.map(function (t) {
          return '<tr data-open="' + esc(t.ticketId) + '" tabindex="0">' +
            '<td class="t-id" data-label="ID">' + esc(t.ticketId) + (t.posibleDuplicado ? ' <span class="chip" title="Posible duplicado de ' + esc(t.posibleDuplicado) + '">¿dup?</span>' : '') + '</td>' +
            '<td class="t-detail" data-label="Detalle"><div class="t-subject">' + esc(t.asunto) + '</div><div class="t-snippet">' + esc(t.resumen) + '</div></td>' +
            '<td data-label="Tipo">' + esc(t.tipoCaso) + '</td>' +
            '<td data-label="Solicitante">' + esc(t.solicitanteNombre) + '</td>' +
            '<td class="muted" data-label="Correo">' + esc(t.solicitanteEmail) + '</td>' +
            '<td data-label="Área">' + esc(t.area) + '</td>' +
            '<td class="nowrap" data-label="Propiedad">' + esc(t.propiedadNombre) + '</td>' +
            '<td data-label="Origen"><span class="chip">' + esc(PLAT_LABEL[t.plataformaOrigen] || t.plataformaOrigen) + '</span></td>' +
            '<td class="nowrap" data-label="Técnico">' + esc(t.tecnicoNombre || 'Sin asignar') + '</td>' +
            '<td data-label="Estado">' + estadoBadge(t.estado) + '</td>' +
            '<td data-label="Prioridad">' + prioTag(t.prioridad) + '</td>' +
            '<td class="nowrap" data-label="Solicitud">' + fmt(t.fechaSolicitud) + '</td>' +
            '<td class="nowrap" data-label="1ª respuesta">' + fmt(t.fechaPrimeraRespuesta) + '</td>' +
            '<td class="nowrap" data-label="Cierre">' + fmt(t.fechaCierre) + '</td>' +
            '<td data-label="SLA">' + slaBadge(t.sla.estado) + '</td></tr>';
        }).join('') + '</tbody></table></div>' +
        '<div class="pager"><span>' + r.total + ' ticket(s) · página ' + r.page + ' de ' + r.pages + '</span><span class="btns">' +
          '<button class="btn small" id="pgPrev"' + (r.page <= 1 ? ' disabled' : '') + '>‹ Anterior</button>' +
          '<button class="btn small" id="pgNext"' + (r.page >= r.pages ? ' disabled' : '') + '>Siguiente ›</button></span></div>';
      $('#pgPrev').addEventListener('click', function () { S.q.page--; loadTickets(); });
      $('#pgNext').addEventListener('click', function () { S.q.page++; loadTickets(); });
      $$('tr[data-open]', box).forEach(function (tr) {
        tr.addEventListener('keydown', function (e) { if (e.key === 'Enter') openTicket(tr.getAttribute('data-open')); });
      });
    }).catch(function (err) {
      if (seq !== listSeq) return;
      box.style.opacity = '';
      box.innerHTML = errorHtml(err, 'retryList');
      $('#retryList').addEventListener('click', loadTickets);
    });
  }

  /* ================================================================
   * Modal genérico
   * ================================================================ */
  var lastFocus = null;
  function openModal(html, narrow) {
    lastFocus = document.activeElement;
    $('#modalRoot').innerHTML = '<div class="modal-back" id="modalBack"><div class="modal' + (narrow ? ' narrow' : '') + '" role="dialog" aria-modal="true">' + html + '</div></div>';
    $('#modalBack').addEventListener('mousedown', function (e) { if (e.target.id === 'modalBack') closeModal(); });
    document.body.style.overflow = 'hidden';
    var first = $('#modalRoot [autofocus]') || $('#modalRoot .close-x');
    if (first) first.focus();
  }
  function closeModal() {
    if (!$('#modalRoot').innerHTML) return;
    $('#modalRoot').innerHTML = '';
    document.body.style.overflow = '';
    S.ticket = null;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  function closeBtn() { return '<button class="icon-btn close-x" aria-label="Cerrar" data-close>✕</button>'; }
  document.addEventListener('click', function (e) { if (e.target.closest('[data-close]')) closeModal(); });

  /** Diálogo de confirmación con campo opcional; devuelve Promise con los valores o null. */
  function promptDialog(opts) {
    return new Promise(function (resolve) {
      openModal('<div class="modal-head"><div><h2>' + esc(opts.title) + '</h2>' + (opts.sub ? '<div class="sub">' + esc(opts.sub) + '</div>' : '') + '</div>' + closeBtn() + '</div>' +
        '<div class="modal-body">' + (opts.fields || []).map(function (f) {
          if (f.type === 'checkbox') return '<label style="display:flex;gap:8px;align-items:center;margin-top:10px"><input type="checkbox" id="pd_' + f.name + '"' + (f.value ? ' checked' : '') + '> ' + esc(f.label) + '</label>';
          if (f.type === 'select') return '<div class="field" style="margin-bottom:10px"><label for="pd_' + f.name + '">' + esc(f.label) + '</label><select class="select" id="pd_' + f.name + '">' + options(f.options, f.value) + '</select></div>';
          return '<div class="field" style="margin-bottom:10px"><label for="pd_' + f.name + '">' + esc(f.label) + '</label><textarea class="textarea" id="pd_' + f.name + '" maxlength="5000"' + (f.autofocus ? ' autofocus' : '') + ' placeholder="' + esc(f.placeholder || '') + '"></textarea></div>';
        }).join('') + '</div>' +
        '<div class="modal-foot"><button class="btn" data-close>Cancelar</button><button class="btn ' + (opts.btnClass || 'primary') + '" id="pdOk">' + esc(opts.ok || 'Confirmar') + '</button></div>', true);
      var done = false;
      $('#pdOk').addEventListener('click', function () {
        var out = {};
        (opts.fields || []).forEach(function (f) {
          var el = $('#pd_' + f.name);
          out[f.name] = f.type === 'checkbox' ? el.checked : el.value.trim();
        });
        var invalid = (opts.fields || []).filter(function (f) { return f.required && !out[f.name]; })[0];
        if (invalid) { toast(invalid.label + ' es obligatorio.', 'error'); return; }
        done = true;
        closeModal();
        resolve(out);
      });
      var obs = new MutationObserver(function () { if (!$('#pdOk')) { obs.disconnect(); if (!done) resolve(null); } });
      obs.observe($('#modalRoot'), { childList: true });
    });
  }

  /* ================================================================
   * Detalle del ticket
   * ================================================================ */
  function openTicket(id) {
    openModal('<div class="modal-head"><div><h2>' + esc(id) + '</h2></div>' + closeBtn() + '</div><div class="modal-body">' + loadingHtml('Abriendo ticket…') + '</div>');
    api('getTicket', id).then(function (r) { S.ticket = r; renderTicket(); })
      .catch(function (err) {
        $('#modalRoot .modal-body').innerHTML = errorHtml(err);
      });
  }

  function reloadTicket(msg) {
    if (!S.ticket) return;
    var id = S.ticket.ticket.ticketId;
    return api('getTicket', id).then(function (r) {
      S.ticket = r; renderTicket();
      if (msg) toast(msg, 'ok');
      refreshBackground();
    });
  }
  function refreshBackground() {
    if (S.view === 'tickets') loadTickets();
    else if (S.view === 'dashboard') renderDashboard();
  }

  function ticketAction(promise, okMsg) {
    $$('#modalRoot .btn').forEach(function (b) { b.setAttribute('disabled', ''); });
    return promise.then(function () { return reloadTicket(okMsg); }).catch(function (err) {
      toast(err.message, 'error');
      if (/modificó este ticket/.test(err.message)) return reloadTicket();
      $$('#modalRoot .btn').forEach(function (b) { b.removeAttribute('disabled'); });
    });
  }

  function renderTicket() {
    var r = S.ticket, t = r.ticket, pm = r.permisos, sla = t.sla, cat = BOOT.catalogos;
    var cerrado = t.estado === 'CERRADO';
    var pausado = !!t.slaPausadoDesde;
    var meter = function (p) {
      var color = p >= 100 ? 'var(--red)' : p >= 75 ? 'var(--amber)' : 'var(--green)';
      return '<div class="sla-meter"><span style="width:' + Math.min(100, p) + '%;background:' + color + '"></span></div>';
    };
    var techOpts = BOOT.tecnicos.map(function (x) { return { value: x.email, label: x.nombre }; });
    if (!pm.reasignar) techOpts = techOpts.filter(function (x) { return x.value === t.tecnicoEmail || x.value === BOOT.usuario.tecnicoEmail; });
    var propOpts = BOOT.propiedades.map(function (p) { return { value: p.id, label: p.nombreCorto }; });
    var dis = pm.editar ? '' : ' disabled';

    var actions = [];
    if (pm.editar) {
      if (t.estado === 'PENDIENTE') actions.push('<button class="btn warn" data-act="enproceso">Tomar · EN PROCESO</button>');
      if (!cerrado && !t.fechaPrimeraRespuesta) actions.push('<button class="btn" data-act="contacto">Registrar contacto</button>');
      if (!cerrado) actions.push('<button class="btn success" data-act="cerrar">Cerrar ticket</button>');
      if (t.estado === 'EN PROCESO') actions.push('<button class="btn" data-act="pendiente">Volver a PENDIENTE</button>');
      if (cerrado) actions.push('<button class="btn danger" data-act="reabrir">Reabrir</button>');
      if (pm.pausarSla && !cerrado && t.slaResolucionVence) actions.push(pausado ? '<button class="btn" data-act="reanudar">Reanudar SLA</button>' : '<button class="btn" data-act="pausar">Pausar SLA</button>');
    }

    var composer = pm.editar && !cerrado ?
      '<div class="box"><div class="tabs" role="tablist">' +
        '<button role="tab" aria-selected="true" data-tab="interno">Nota interna</button>' +
        '<button role="tab" aria-selected="false" data-tab="publico">Responder al solicitante</button></div>' +
        '<p class="hint internal" id="composerHint">Solo visible para el equipo de TI. Nunca se envía al solicitante.</p>' +
        '<textarea class="textarea" id="composerText" maxlength="5000" placeholder="Escriba aquí…"></textarea>' +
        '<div class="actions" style="margin-top:10px;justify-content:flex-end"><button class="btn primary" id="composerSend">Guardar nota</button></div></div>'
      : (pm.editar && cerrado ? '<div class="box"><p class="hint">El ticket está cerrado. Reábralo para responder.</p>' +
        '<textarea class="textarea" id="composerText" maxlength="5000" placeholder="Nota interna…"></textarea>' +
        '<div class="actions" style="margin-top:10px;justify-content:flex-end"><button class="btn" id="composerSend">Guardar nota interna</button></div></div>' : '');

    var timeline = r.historial.slice().reverse().map(function (h) {
      var cls = h.visibilidad === 'INTERNO' ? 'internal' : h.visibilidad === 'PUBLICO' ? 'public' : '';
      var change = h.campo && (h.valorAnterior || h.valorNuevo) ? '<div class="tl-body">' + esc(h.campo) + ': ' + esc(h.valorAnterior || '∅') + ' → ' + esc(h.valorNuevo || '∅') + '</div>' : '';
      return '<li class="' + esc(h.visibilidad) + '"><div class="tl-head"><b>' + esc(actionLabel(h.accion)) + '</b> · ' + esc(h.usuario) + ' · ' + fmt(h.fecha) +
        (h.visibilidad === 'INTERNO' ? ' · <span class="chip">interno</span>' : '') + '</div>' + change +
        (h.comentario ? '<div class="tl-body ' + cls + '">' + esc(h.comentario) + '</div>' : '') + '</li>';
    }).join('');

    var html =
      '<div class="modal-head"><div style="min-width:0"><h2>' + esc(t.ticketId) + ' · ' + esc(t.asunto) + '</h2>' +
        '<div class="sub">' + esc(t.solicitanteNombre) + ' &lt;' + esc(t.solicitanteEmail) + '&gt; · ' + esc(PLAT_LABEL[t.plataformaOrigen] || t.plataformaOrigen) + (t.buzonOrigen ? ' · ' + esc(t.buzonOrigen) : '') + '</div>' +
        '<div class="badges">' + estadoBadge(t.estado) + slaBadge(sla.estado) + '<span class="badge b-gray">' + esc(t.prioridad) + '</span><span class="badge b-blue">' + esc(t.propiedadNombre) + '</span>' +
        (t.posibleDuplicado ? '<span class="badge b-amber">Posible duplicado de ' + esc(t.posibleDuplicado) + '</span>' : '') + '</div></div>' + closeBtn() + '</div>' +
      '<div class="modal-body"><div class="detail-grid"><div>' +
        '<div class="box"><h3>Detalle de la solicitud</h3><div class="request-text">' + esc(t.detalle || '(sin contenido)') + '</div></div>' +
        (actions.length ? '<div class="box"><h3>Acciones</h3><div class="actions">' + actions.join('') + '</div></div>' : '') +
        '<div class="box"><h3>Clasificación y asignación</h3><div class="form-grid">' +
          field('Tipo de caso', '<select class="select" id="eTipo"' + dis + '>' + options(cat.tiposCaso, t.tipoCaso) + '</select>') +
          field('Categoría', '<select class="select" id="eCategoria"' + dis + '>' + options(cat.categorias, t.categoria) + '</select>') +
          field('Prioridad', '<select class="select" id="ePrioridad"' + (pm.prioridad ? '' : ' disabled') + '>' + options(cat.prioridades, t.prioridad) + '</select>') +
          field('Propiedad', '<select class="select" id="ePropiedad"' + dis + '>' + options(propOpts, t.propiedadId) + '</select>') +
          field('Área / departamento', '<input class="input" id="eArea" list="areasList" maxlength="100" value="' + esc(t.area) + '"' + dis + '><datalist id="areasList">' + options(cat.areas) + '</datalist>') +
          field('Técnico asignado', '<select class="select" id="eTecnico"' + dis + '>' + options(techOpts, t.tecnicoEmail, t.tecnicoEmail ? undefined : 'Sin asignar') + '</select>') +
          field('Nombre del solicitante', '<input class="input" id="eSolicitante" maxlength="120" value="' + esc(t.solicitanteNombre) + '"' + dis + '>', true) +
        '</div>' + (pm.editar ? '<div class="actions" style="margin-top:12px;justify-content:flex-end"><button class="btn primary" id="saveBtn">Guardar cambios</button></div>' : '') + '</div>' +
      '</div><div>' +
        '<div class="box"><h3>SLA</h3>' +
          '<dl class="kv"><dt>Política</dt><dd>' + esc(t.slaPoliticaId || 'Sin política') + ' · ' + esc(t.slaCalendario || '—') + '</dd>' +
          '<dt>Solicitud</dt><dd>' + fmt(t.fechaSolicitud) + '</dd>' +
          '<dt>1ª respuesta</dt><dd>' + (t.fechaPrimeraRespuesta ? fmt(t.fechaPrimeraRespuesta) + ' · ' + (sla.respuestaCumplida === 'SI' ? 'a tiempo' : 'tarde') : 'pendiente · vence ' + fmt(t.slaRespuestaVence)) + '</dd></dl>' +
          (!t.fechaPrimeraRespuesta && t.slaRespuestaVence ? meter(sla.pctRespuesta) : '<div style="height:10px"></div>') +
          '<dl class="kv"><dt>Resolución</dt><dd>' + (cerrado ? fmt(t.fechaCierre) + ' · ' + (sla.resolucionCumplida === 'SI' ? 'a tiempo' : 'tarde') : 'vence ' + fmt(t.slaResolucionVence)) + '</dd>' +
          (Number(t.slaMinutosPausa) ? '<dt>Pausas</dt><dd>' + dur(Number(t.slaMinutosPausa)) + '</dd>' : '') +
          (pausado ? '<dt>Pausado desde</dt><dd>' + fmt(t.slaPausadoDesde) + '</dd>' : '') +
          (Number(t.reaperturas) ? '<dt>Reaperturas</dt><dd>' + esc(t.reaperturas) + '</dd>' : '') + '</dl>' +
          (!cerrado && t.slaResolucionVence && !pausado ? meter(sla.pctResolucion) : '') +
          (cerrado && t.notasCierre ? '<dl class="kv"><dt>Cierre</dt><dd>' + esc(t.notasCierre) + '</dd></dl>' : '') +
        '</div>' + composer +
        '<div class="box"><h3>Historial</h3><ul class="timeline">' + (timeline || '<li>Sin eventos</li>') + '</ul></div>' +
      '</div></div></div>';

    var modal = $('#modalRoot .modal');
    if (!modal) return;
    modal.innerHTML = html;
    bindTicket();
  }

  function field(label, control, full) {
    return '<div class="field' + (full ? ' full' : '') + '"><label>' + esc(label) + '</label>' + control + '</div>';
  }

  var ACTION_LABELS = {
    CREADO: 'Ticket creado', CAMBIO: 'Cambio', ASIGNACION: 'Asignación', ESTADO: 'Cambio de estado', REAPERTURA: 'Reapertura',
    NOTA_INTERNA: 'Nota interna', RESPUESTA_ENVIADA: 'Respuesta al solicitante', RESPUESTA_RECIBIDA: 'Respuesta del solicitante',
    PRIMERA_RESPUESTA: 'Primera respuesta', CONFIRMACION_ENVIADA: 'Acuse de recibo', CONFIRMACION_ERROR: 'Error de acuse',
    SLA_PAUSA: 'SLA pausado', SLA_REANUDADO: 'SLA reanudado', SLA_RECALCULADO: 'SLA recalculado',
    DUPLICADO_ENTRE_BUZONES: 'Copia en otro buzón', NOTIFICACION_CIERRE: 'Aviso de cierre', NOTIFICACION_ERROR: 'Error de notificación',
    REVISION_RESUELTA: 'Revisión resuelta'
  };
  function actionLabel(a) { return ACTION_LABELS[a] || a; }

  function bindTicket() {
    var t = S.ticket.ticket, id = t.ticketId, ver = t.version;
    var save = $('#saveBtn');
    if (save) save.addEventListener('click', function () {
      var cambios = {
        tipoCaso: $('#eTipo').value, categoria: $('#eCategoria').value, propiedadId: $('#ePropiedad').value,
        area: $('#eArea').value.trim(), solicitanteNombre: $('#eSolicitante').value.trim()
      };
      if (S.ticket.permisos.prioridad) cambios.prioridad = $('#ePrioridad').value;
      if ($('#eTecnico').value) cambios.tecnicoEmail = $('#eTecnico').value;
      ticketAction(api('updateTicket', id, ver, cambios), 'Cambios guardados');
    });

    $$('[data-act]').forEach(function (b) {
      b.addEventListener('click', function () {
        var act = b.getAttribute('data-act');
        if (act === 'enproceso') ticketAction(api('changeStatus', id, ver, 'EN PROCESO', {}), 'Ticket en proceso');
        else if (act === 'pendiente') ticketAction(api('changeStatus', id, ver, 'PENDIENTE', {}), 'Ticket devuelto a pendiente');
        else if (act === 'cerrar') {
          var back = S.ticket;
          promptDialog({ title: 'Cerrar ' + id, sub: 'Describa la solución aplicada.', ok: 'Cerrar ticket', btnClass: 'success',
            fields: [{ name: 'notas', label: 'Notas de cierre', required: true, autofocus: true }, { name: 'notificar', label: 'Notificar al solicitante por correo (incluye las notas)', type: 'checkbox', value: true }]
          }).then(function (v) {
            reopenDetail(back);
            if (v) ticketAction(api('changeStatus', id, ver, 'CERRADO', { notasCierre: v.notas, notificar: v.notificar }), 'Ticket cerrado');
          });
        } else if (act === 'reabrir') {
          var back2 = S.ticket;
          promptDialog({ title: 'Reabrir ' + id, ok: 'Reabrir', btnClass: 'danger',
            fields: [{ name: 'motivo', label: 'Motivo de la reapertura', required: true, autofocus: true }, { name: 'estado', label: 'Nuevo estado', type: 'select', options: ['PENDIENTE', 'EN PROCESO'], value: 'EN PROCESO' }]
          }).then(function (v) {
            reopenDetail(back2);
            if (v) ticketAction(api('changeStatus', id, ver, v.estado, { comentario: v.motivo }), 'Ticket reabierto');
          });
        } else if (act === 'contacto') {
          var back3 = S.ticket;
          promptDialog({ title: 'Registrar primera respuesta', sub: 'Use esta opción cuando atendió al solicitante por otro medio.', ok: 'Registrar',
            fields: [{ name: 'medio', label: 'Medio', type: 'select', options: ['Teléfono', 'Presencial', 'Chat corporativo', 'Otro'], value: 'Teléfono' }, { name: 'nota', label: 'Nota (interna)', autofocus: true }]
          }).then(function (v) {
            reopenDetail(back3);
            if (v) ticketAction(api('registerContact', id, ver, v.medio, v.nota), 'Primera respuesta registrada');
          });
        } else if (act === 'pausar') {
          var back4 = S.ticket;
          promptDialog({ title: 'Pausar SLA de ' + id, sub: 'La pausa detiene el reloj de resolución y queda en el historial.', ok: 'Pausar',
            fields: [{ name: 'motivo', label: 'Motivo autorizado (p. ej. esperando repuesto del proveedor)', required: true, autofocus: true }]
          }).then(function (v) {
            reopenDetail(back4);
            if (v) ticketAction(api('pauseSla', id, ver, v.motivo), 'SLA pausado');
          });
        } else if (act === 'reanudar') ticketAction(api('resumeSla', id, ver), 'SLA reanudado');
      });
    });

    var mode = 'interno';
    $$('[data-tab]').forEach(function (tab) {
      tab.addEventListener('click', function () {
        mode = tab.getAttribute('data-tab');
        $$('[data-tab]').forEach(function (x) { x.setAttribute('aria-selected', String(x === tab)); });
        var hint = $('#composerHint');
        hint.className = 'hint' + (mode === 'interno' ? ' internal' : '');
        hint.textContent = mode === 'interno' ? 'Solo visible para el equipo de TI. Nunca se envía al solicitante.'
          : 'Se enviará por correo a ' + t.solicitanteEmail + '. Cuenta como primera respuesta técnica.';
        $('#composerSend').textContent = mode === 'interno' ? 'Guardar nota' : 'Enviar respuesta';
      });
    });
    var send = $('#composerSend');
    if (send) send.addEventListener('click', function () {
      var text = $('#composerText').value.trim();
      if (text.length < 2) { toast('Escriba un mensaje.', 'error'); return; }
      if (mode === 'publico') ticketAction(api('replyToRequester', id, ver, text, true), 'Respuesta enviada al solicitante');
      else ticketAction(api('addInternalNote', id, text), 'Nota interna guardada');
    });
  }

  /** Tras un diálogo, vuelve a mostrar el detalle del ticket que estaba abierto. */
  function reopenDetail(snapshot) {
    if (!snapshot) return;
    openModal('<div class="modal-head"><div><h2>' + esc(snapshot.ticket.ticketId) + '</h2></div>' + closeBtn() + '</div><div class="modal-body"></div>');
    S.ticket = snapshot;
    renderTicket();
  }

  /* ================================================================
   * Nuevo ticket manual
   * ================================================================ */
  function bindNewTicket() {
    var b = $('#newTicketBtn');
    if (b) b.addEventListener('click', openNewTicket);
  }

  function openNewTicket() {
    var cat = BOOT.catalogos;
    var propOpts = BOOT.propiedades.map(function (p) { return { value: p.id, label: p.nombreCorto }; });
    openModal('<div class="modal-head"><div><h2>Nuevo ticket</h2><div class="sub">Para solicitudes recibidas por teléfono o en persona. Usa el mismo motor que los correos.</div></div>' + closeBtn() + '</div>' +
      '<div class="modal-body"><div class="form-grid">' +
        field('Nombre del solicitante *', '<input class="input" id="nNombre" maxlength="120" autofocus>') +
        field('Correo del solicitante *', '<input class="input" id="nEmail" type="email" maxlength="200">') +
        field('Asunto *', '<input class="input" id="nAsunto" maxlength="300">', true) +
        field('Detalle *', '<textarea class="textarea" id="nDetalle" maxlength="20000"></textarea>', true) +
        field('Propiedad', '<select class="select" id="nProp">' + options(propOpts, S.prop !== '*' ? S.prop : '', 'Detectar automáticamente') + '</select>') +
        field('Prioridad', '<select class="select" id="nPrio">' + options(cat.prioridades, '', 'Detectar automáticamente') + '</select>') +
        field('Categoría', '<select class="select" id="nCat">' + options(cat.categorias, '', 'Detectar automáticamente') + '</select>') +
        field('Área / departamento', '<input class="input" id="nArea" list="areasList2" maxlength="100"><datalist id="areasList2">' + options(cat.areas) + '</datalist>') +
      '</div><label style="display:flex;gap:8px;align-items:center;margin-top:12px"><input type="checkbox" id="nConfirm"> Enviar acuse de recibo al solicitante</label></div>' +
      '<div class="modal-foot"><button class="btn" data-close>Cancelar</button><button class="btn primary" id="nCreate">Crear ticket</button></div>', true);
    $('#nCreate').addEventListener('click', function () {
      var btn = this;
      var data = {
        solicitanteNombre: $('#nNombre').value.trim(), solicitanteEmail: $('#nEmail').value.trim(),
        asunto: $('#nAsunto').value.trim(), detalle: $('#nDetalle').value.trim(),
        propiedadId: $('#nProp').value, prioridad: $('#nPrio').value, categoria: $('#nCat').value,
        area: $('#nArea').value.trim(), enviarConfirmacion: $('#nConfirm').checked
      };
      if (!data.solicitanteNombre || !data.solicitanteEmail || !data.asunto || !data.detalle) { toast('Complete los campos obligatorios.', 'error'); return; }
      btn.setAttribute('disabled', '');
      api('createManualTicket', data).then(function (r) {
        toast('Ticket ' + r.ticketId + ' creado', 'ok');
        closeModal();
        refreshBackground();
        openTicket(r.ticketId);
      }).catch(function (err) { btn.removeAttribute('disabled'); toast(err.message, 'error'); });
    });
  }

  /* ================================================================
   * Reportes
   * ================================================================ */
  function renderReports() {
    var v = $('#view');
    v.innerHTML = '<div class="page-head"><div><h1>Reportes y mejora continua</h1><p>' + esc(propLabel()) + '</p></div></div>' +
      '<div class="card" style="margin-bottom:16px"><div class="toolbar" style="margin:0">' +
        '<div class="field"><label for="rDesde">Desde</label><input class="input" type="date" id="rDesde" value="' + esc(S.rep.desde) + '"></div>' +
        '<div class="field"><label for="rHasta">Hasta</label><input class="input" type="date" id="rHasta" value="' + esc(S.rep.hasta) + '"></div>' +
        '<div class="actions" style="align-self:flex-end"><button class="btn primary" id="rGo">Generar</button>' +
        (PERM.exportarReportes ? '<button class="btn" id="rExport">Exportar CSV</button>' : '') + '</div></div></div>' +
      '<div id="repBody">' + loadingHtml('Calculando reporte…') + '</div>';
    var run = function () {
      S.rep.desde = $('#rDesde').value; S.rep.hasta = $('#rHasta').value;
      var body = $('#repBody');
      body.innerHTML = loadingHtml('Calculando reporte…');
      api('getReport', { desde: S.rep.desde, hasta: S.rep.hasta, propiedadId: S.prop }).then(function (r) {
        if (!$('#repBody')) return;
        var k = r.kpis;
        body.innerHTML = '<div class="grid metrics" style="margin-top:0">' +
          metricCard('Tickets', k.total) + metricCard('Cerrados', k.cerrado) + metricCard('Cumplimiento SLA', pct(k.cumplimientoPct), 'ok') +
          metricCard('T. medio 1ª respuesta', dur(k.tmprMin)) + metricCard('T. medio resolución', dur(k.tmrMin)) + '</div>' +
          '<div class="grid lists">' + r.grupos.map(function (g) {
            return '<section class="card"><h2 class="section-title">' + esc(g.titulo) + '</h2>' + (g.filas.length ?
              '<div class="table-wrap"><table class="report-table"><thead><tr><th>Grupo</th><th>Total</th><th>Abiertos</th><th>Vencidos</th><th>Cumpl. SLA</th><th>1ª resp.</th><th>Resolución</th></tr></thead><tbody>' +
              g.filas.map(function (f) {
                return '<tr><td>' + esc(f.grupo) + '</td><td>' + f.total + '</td><td>' + (f.pendiente + f.enProceso) + '</td><td>' + f.vencidos + '</td><td>' + pct(f.cumplimientoPct) + '</td><td>' + dur(f.tmprMin) + '</td><td>' + dur(f.tmrMin) + '</td></tr>';
              }).join('') + '</tbody></table></div>' : '<div class="empty">Sin datos en el periodo.</div>') + '</section>';
          }).join('') + '</div>' +
          '<p class="hint">Cumplimiento SLA: tickets cerrados con SLA cumplido sobre tickets cerrados con SLA. Tiempos en horas de servicio según el calendario de cada propiedad.</p>';
      }).catch(function (err) { body.innerHTML = errorHtml(err); });
    };
    $('#rGo').addEventListener('click', run);
    var ex = $('#rExport');
    if (ex) ex.addEventListener('click', function () {
      ex.setAttribute('disabled', '');
      api('exportReport', { desde: $('#rDesde').value, hasta: $('#rHasta').value, propiedadId: S.prop }).then(function (r) {
        ex.removeAttribute('disabled');
        var blob = new Blob([r.csv], { type: 'text/csv;charset=utf-8' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = r.nombre;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
        toast('Descargado ' + r.nombre + ' (' + r.hoja + ')', 'ok');
      }).catch(function (err) { ex.removeAttribute('disabled'); toast(err.message, 'error'); });
    });
    run();
  }

  function metricCard(label, value, cls) {
    return '<div class="card metric ' + (cls || '') + '"><div class="m-label">' + esc(label) + '</div><div class="m-value">' + esc(value) + '</div></div>';
  }

  /* ================================================================
   * Conectores y revisión manual
   * ================================================================ */

/* ================================================================
 * Simulador de correo entrante (solo demo)
 * ================================================================ */
var EJEMPLOS = [
  { nombre: 'Laura Hudgson', email: 'recepcion.slv@oxohotel.com', asunto: '[SLV] La impresora de recepción no imprime', cuerpo: 'Buenos días, la impresora de recepción no imprime las facturas. Muestra error de tóner.' },
  { nombre: 'Night Auditor', email: 'auditoria@sirenishotels.com', asunto: 'Sistema caído: el PMS no responde', cuerpo: 'Opera no abre en todo el hotel Grand Sirenis San Andrés. Es una emergencia.' },
  { nombre: 'Pedro Hawkins', email: 'compras@oxohotel.com', asunto: 'Solicito instalar Excel en el equipo nuevo', cuerpo: 'Necesito instalar Office en el portátil nuevo de compras. No es urgente, cuando puedan.', ambos: true }
];
var ejemploIdx = 0;
function openSimulator() {
  openModal('<div class="modal-head"><div><h2>Simular correo entrante</h2><div class="sub">El mensaje entra a la bandeja simulada y el conector lo procesa con el mismo motor: deduplicación, propiedad, clasificación y SLA.</div></div>' + closeBtn() + '</div>' +
    '<div class="modal-body"><div class="form-grid">' +
      field('Buzón de destino', '<select class="select" id="sPlat"><option value="GOOGLE">ticsirenis@oxohotel.com (Google)</option><option value="M365">sistemas.co@sirenishotels.com (Microsoft 365)</option></select>') +
      field('Copia', '<label style="display:flex;gap:8px;align-items:center;min-height:40px"><input type="checkbox" id="sAmbos"> Enviar el mismo correo a ambos buzones</label>') +
      field('Nombre del remitente', '<input class="input" id="sNombre" maxlength="120" autofocus>') +
      field('Correo del remitente', '<input class="input" id="sEmail" type="email" maxlength="200">') +
      field('Asunto', '<input class="input" id="sAsunto" maxlength="300">', true) +
      field('Cuerpo', '<textarea class="textarea" id="sCuerpo" maxlength="20000"></textarea>', true) +
    '</div><p class="hint">Pruebe: <b>[GSSA]</b> o <b>[SLV]</b> en el asunto asigna la propiedad; "urgente" o "sistema caído" sube la prioridad; con copia a ambos buzones se crea un solo ticket; responder con <b>RE: [IT-…]</b> desde el mismo remitente se agrega al ticket existente.</p></div>' +
    '<div class="modal-foot"><button class="btn" id="sEjemplo">Cargar ejemplo</button><span style="flex:1"></span><button class="btn" data-close>Cancelar</button><button class="btn primary" id="sEnviar">Recibir correo</button></div>', true);
  $('#sEjemplo').addEventListener('click', function () {
    var e = EJEMPLOS[ejemploIdx++ % EJEMPLOS.length];
    $('#sNombre').value = e.nombre; $('#sEmail').value = e.email; $('#sAsunto').value = e.asunto; $('#sCuerpo').value = e.cuerpo; $('#sAmbos').checked = !!e.ambos;
  });
  $('#sEnviar').addEventListener('click', function () {
    var btn = this;
    btn.setAttribute('disabled', '');
    api('simulateIncoming', { plataforma: $('#sPlat').value, ambosBuzones: $('#sAmbos').checked, remitenteNombre: $('#sNombre').value, remitenteEmail: $('#sEmail').value, asunto: $('#sAsunto').value, cuerpo: $('#sCuerpo').value })
      .then(function (res) {
        var txt = res.map(function (r) {
          return (PLAT_LABEL[r.plataforma] || r.plataforma) + ': ' + (r.creados ? 'ticket creado' : r.actualizados ? 'agregado a un ticket existente' : r.duplicados ? 'duplicado (sin ticket nuevo)' : r.ignorados ? 'ignorado' : 'sin cambios');
        }).join(' · ');
        toast(txt, 'ok');
        closeModal();
        renderConnectors();
      }).catch(function (err) { btn.removeAttribute('disabled'); toast(err.message, 'error'); });
  });
}

function renderConnectors() {
    var v = $('#view');
    v.innerHTML = '<div class="page-head"><div><h1>Conectores y revisión</h1><p>Estado de los buzones, errores recientes y casos para revisión manual.</p></div>' +
      '<div class="actions"><button class="btn" id="cRefresh">Actualizar</button>' + (PERM.crearTicket ? '<button class="btn primary" id="cSimular">Simular correo entrante</button>' : '') + '</div></div><div id="connBody">' + loadingHtml('Consultando estado…') + '</div>';
    $('#cRefresh').addEventListener('click', renderConnectors);
    if ($('#cSimular')) $('#cSimular').addEventListener('click', openSimulator);
    api('getConnectorsPanel').then(function (d) {
      var body = $('#connBody');
      if (!body) return;
      body.innerHTML = '<div class="grid lists" style="margin-top:0">' + d.conectores.map(function (c) {
        var hab = d.habilitados[c.plataforma];
        return '<section class="card conn-card"><div class="conn-head"><h3>' + esc(PLAT_LABEL[c.plataforma] || c.plataforma) + '</h3>' + connBadge(hab ? c.estadoConexion : 'DESACTIVADO') + '</div>' +
          '<dl class="kv">' +
          '<dt>Buzón</dt><dd>' + esc(c.buzon) + '</dd>' +
          '<dt>En bandeja</dt><dd>' + esc(d.bandeja[c.plataforma] || 0) + ' correo(s) sin consultar</dd>' +
          '<dt>Última ejecución</dt><dd>' + fmt(c.ultimaEjecucion) + '</dd>' +
          '<dt>Último éxito</dt><dd>' + fmt(c.ultimoResultadoCorrecto) + '</dd>' +
          '<dt>Último mensaje</dt><dd>' + fmt(c.ultimoMensajeFecha) + '</dd>' +
          '<dt>Última consulta</dt><dd>' + esc(c.mensajesConsultados || 0) + ' consultados · ' + esc(c.ticketsCreados || 0) + ' creados · ' + esc(c.ticketsActualizados || 0) + ' actualizados · ' + esc(c.duplicados || 0) + ' duplicados · ' + esc(c.errores || 0) + ' errores</dd>' +
          '<dt>Total creados</dt><dd>' + esc(c.totalTicketsCreados || 0) + '</dd>' +
          '<dt>Errores seguidos</dt><dd>' + esc(c.erroresConsecutivos || 0) + '</dd>' +
          (c.ultimoError ? '<dt>Último error</dt><dd style="color:var(--red-ink);font-weight:500">' + esc(c.ultimoError) + '</dd>' : '') + '</dl>' +
          (PERM.ejecutarConectores ? '<div class="actions" style="margin-top:12px">' +
            '<button class="btn small" data-run="' + esc(c.plataforma) + '"' + (hab ? '' : ' disabled') + '>Ejecutar ahora</button>' +
            (c.plataforma === 'M365' ? '<button class="btn small" id="testGraph">Probar conexión</button>' : '') + '</div>' : '') +
          '</section>';
      }).join('') + '</div>' +
        '<section class="card" style="margin-top:16px"><h2 class="section-title">Revisión manual (' + d.revision.length + ')</h2>' +
        (d.revision.length ? '<ul class="mini-list">' + d.revision.map(function (r) {
          return '<li style="cursor:default"><span class="ml-body"><div class="ml-title"><b>' + esc(r.tipo) + '</b>' +
            (r.ticketId ? ' · <a href="#" data-open="' + esc(r.ticketId) + '">' + esc(r.ticketId) + '</a>' : '') +
            (r.ticketRelacionado ? ' ↔ <a href="#" data-open="' + esc(r.ticketRelacionado) + '">' + esc(r.ticketRelacionado) + '</a>' : '') + '</div>' +
            '<div class="ml-meta">' + fmt(r.fecha) + ' · ' + esc(r.detalle) + '</div></span>' +
            '<button class="btn small" data-review="' + esc(r.revisionId) + '">Resolver</button></li>';
        }).join('') + '</ul>' : '<div class="empty">No hay elementos pendientes de revisión.</div>') + '</section>' +
        '<section class="card" style="margin-top:16px"><h2 class="section-title">Errores y advertencias recientes</h2>' +
        (d.errores.length ? '<ul class="mini-list">' + d.errores.map(function (e) {
          return '<li style="cursor:default"><span class="ml-body"><div class="ml-title"><span class="badge ' + (e.nivel === 'ERROR' ? 'b-red' : 'b-amber') + '">' + esc(e.nivel) + '</span> ' + esc(e.proceso) + ' · ' + esc(e.mensaje) + '</div>' +
            '<div class="ml-meta">' + fmt(e.fecha) + (e.detalle ? ' · ' + esc(e.detalle) : '') + '</div></span></li>';
        }).join('') + '</ul>' : '<div class="empty">Sin errores recientes.</div>') + '</section>' +
        '<section class="card" style="margin-top:16px"><h2 class="section-title">Alertas SLA registradas</h2>' +
        (d.alertas.length ? '<ul class="mini-list">' + d.alertas.map(function (a) {
          return '<li data-open="' + esc(a.ticketId) + '"><span class="ml-id">' + esc(a.ticketId) + '</span><span class="ml-body"><div class="ml-title">' + esc(a.detalle) + '</div>' +
            '<div class="ml-meta">' + fmt(a.fecha) + ' · para ' + esc(a.destinatarios || '—') + '</div></span><span class="badge b-gray">' + esc(a.estado) + '</span></li>';
        }).join('') + '</ul>' : '<div class="empty">Sin alertas.</div>') + '</section>';

      $$('[data-run]', body).forEach(function (b) {
        b.addEventListener('click', function () {
          b.setAttribute('disabled', '');
          b.textContent = 'Ejecutando…';
          api('runConnectorNow', b.getAttribute('data-run')).then(function (r) {
            toast(r && r.omitido ? 'Ya hay una ejecución en curso.' : 'Ejecución completada' + (r && r.consultados !== undefined ? ': ' + r.consultados + ' mensaje(s) nuevos, ' + r.creados + ' ticket(s) creados' : ''), 'ok');
            renderConnectors();
          }).catch(function (err) { toast(err.message, 'error'); renderConnectors(); });
        });
      });
      var tg = $('#testGraph');
      if (tg) tg.addEventListener('click', function () {
        tg.setAttribute('disabled', '');
        tg.textContent = 'Probando…';
        api('testGraphConnection').then(function (r) {
          if (r.error) toast('Falló la conexión: ' + r.error, 'error');
          else toast('Conexión correcta con ' + r.buzon + ' · carpeta "' + r.carpeta.nombre + '" (' + r.carpeta.total + ' mensajes)', 'ok');
          renderConnectors();
        }).catch(function (err) { toast(err.message, 'error'); renderConnectors(); });
      });
      $$('[data-review]', body).forEach(function (b) {
        b.addEventListener('click', function () {
          var rid = b.getAttribute('data-review');
          promptDialog({ title: 'Resolver revisión', ok: 'Marcar como resuelto', fields: [{ name: 'nota', label: 'Qué se hizo', required: true, autofocus: true }] })
            .then(function (v) {
              if (!v) return;
              api('resolveReviewItem', rid, v.nota).then(function () { toast('Revisión resuelta', 'ok'); renderConnectors(); })
                .catch(function (err) { toast(err.message, 'error'); });
            });
        });
      });
      $$('a[data-open]', body).forEach(function (a) { a.addEventListener('click', function (e) { e.preventDefault(); }); });
    }).catch(function (err) {
      var body = $('#connBody');
      if (body) body.innerHTML = errorHtml(err);
    });
  }

  /* ================================================================
   * Inicio
   * ================================================================ */
  renderShell();
  renderHeader();
  go('dashboard');
})();
