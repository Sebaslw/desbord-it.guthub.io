/* ==================================================================
 * MOTOR LOCAL (modo demo)
 * Reemplaza al servidor de Apps Script: motor de tickets, deduplicación,
 * detección de propiedad, clasificación, SLA, alertas, reportes y permisos.
 * Los datos se guardan en localStorage de este navegador.
 * Expone google.script.run con las mismas funciones que Api.gs para que la
 * interfaz sea idéntica a la versión conectada.
 * ================================================================== */
(function () {
  'use strict';

  var TZ = 'America/Bogota';
  var STORE_KEY = 'hd_helpdesk_v2';
  var USER_KEY = 'hd_demo_user';
  var ESTADOS = { PENDIENTE: 'PENDIENTE', EN_PROCESO: 'EN PROCESO', CERRADO: 'CERRADO' };
  var ESTADOS_LISTA = ['PENDIENTE', 'EN PROCESO', 'CERRADO'];
  var PRIORIDADES = ['Crítica', 'Alta', 'Media', 'Baja'];
  var ROLES = { ADMIN: 'ADMIN', SUPERVISOR: 'SUPERVISOR', TECNICO: 'TECNICO', LECTOR: 'LECTOR' };
  var ROLES_EDICION = ['ADMIN', 'SUPERVISOR', 'TECNICO'];
  var ROLES_GESTION = ['ADMIN', 'SUPERVISOR'];
  var PLAT = { GOOGLE: 'GOOGLE', M365: 'M365', MANUAL: 'MANUAL' };
  var SLA = { EN_TIEMPO: 'EN TIEMPO', PROXIMO: 'PRÓXIMO A VENCER', VENCIDO: 'VENCIDO', PAUSADO: 'PAUSADO', CUMPLIDO: 'CUMPLIDO', INCUMPLIDO: 'INCUMPLIDO', SIN_SLA: 'SIN SLA' };
  var RES = { CREADO: 'CREADO', ACTUALIZADO: 'ACTUALIZADO', DUPLICADO: 'DUPLICADO', IGNORADO: 'IGNORADO', INVALIDO: 'INVALIDO' };
  var VIS = { INTERNO: 'INTERNO', PUBLICO: 'PUBLICO', AUDITORIA: 'AUDITORIA' };
  var POR_ID = 'POR_IDENTIFICAR';
  var BUZON_G = 'ticsirenis@oxohotel.com';
  var BUZON_M = 'sistemas.co@sirenishotels.com';
  var TICKET_ID_RE = /\bIT-(\d{4})-(\d{5,})\b/i;

  var DB = null;
  var CLOCK = null;                       // reloj controlado al generar datos de ejemplo
  function now() { return CLOCK ? new Date(CLOCK.getTime()) : new Date(); }

  /* ---------------------------------------------------------------- */
  /* Utilidades                                                        */
  /* ---------------------------------------------------------------- */
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }
  function S(v) { return v === undefined || v === null ? '' : String(v); }
  function normText(s) { return S(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim(); }
  function normSubject(s) {
    var x = S(s).trim(), prev;
    do { prev = x; x = x.replace(/^\s*(re|rv|fw|fwd|resp|aw|tr|reenviar|responder)\s*(\[\d+\])?\s*:\s*/i, ''); } while (x !== prev);
    return normText(x);
  }
  function escapeRegex(s) { return S(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function containsWord(text, kw) { return !!kw && new RegExp('(^|[^a-z0-9])' + escapeRegex(kw) + '([^a-z0-9]|$)').test(text); }
  function parseList(v) { return S(v).split(/[,;\n]/).map(function (x) { return x.trim(); }).filter(Boolean); }
  function isTrue(v) { return v === true || /^(true|verdadero|si|sí|1|yes|x)$/i.test(S(v).trim()); }
  function isValidEmail(e) { return /^[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+\.[^\s@<>"'(),;:]+$/.test(S(e)); }
  function truncate(s, n) { s = S(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function cleanMessageId(v) { var s = S(v).trim(); var m = s.match(/<([^>]+)>/); return (m ? m[1] : s).trim().toLowerCase(); }
  function toDate(v) { if (v === null || v === undefined || v === '') return null; var d = v instanceof Date ? v : new Date(v); return isNaN(d.getTime()) ? null : d; }
  function iso(v) { var d = toDate(v); return d ? d.toISOString() : ''; }
  function cleanReplyBody(body) {
    var lines = S(body).replace(/\r\n/g, '\n').split('\n'), out = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (/^\s*(El|On)\s.+(escribió|wrote)\s*:\s*$/i.test(line)) break;
      if (/^\s*-{2,}\s*(Original Message|Mensaje original)\s*-{2,}/i.test(line)) break;
      if (/^\s*>/.test(line)) continue;
      out.push(line);
    }
    return out.join('\n').trim() || S(body).trim();
  }
  var dtf = new Intl.DateTimeFormat('es-CO', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  function fmtDateTime(v) { var d = toDate(v); return d ? dtf.format(d) : ''; }
  function err(msg) { return new Error(msg); }
  function requireText(v, campo, min, max) {
    var s = S(v).trim();
    if (s.length < (min || 0)) throw err(campo + ' es obligatorio' + (min > 1 ? ' (mínimo ' + min + ' caracteres)' : '') + '.');
    if (s.length > max) throw err(campo + ' supera ' + max + ' caracteres.');
    return s;
  }
  function requireIn(v, list, campo) { if (list.indexOf(v) < 0) throw err('Valor no permitido para ' + campo + ': ' + v); }

  /* Zona horaria con Intl (equivale a Utilities.formatDate) */
  var partsFmt = {};
  function tzParts(date, tz) {
    var f = partsFmt[tz] || (partsFmt[tz] = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' }));
    var p = {};
    f.formatToParts(date).forEach(function (x) { p[x.type] = x.value; });
    var asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute);
    return {
      ymd: p.year + '-' + p.month + '-' + p.day,
      minutes: (+p.hour % 24) * 60 + (+p.minute),
      dow: { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[p.weekday],
      offsetMin: Math.round((asUtc - Math.floor(date.getTime() / 60000) * 60000) / 60000)
    };
  }
  function localToDate(ymd, minutesOfDay, tz) {
    var a = ymd.split('-').map(Number);
    var naive = Date.UTC(a[0], a[1] - 1, a[2]) + minutesOfDay * 60000;
    var off = tzParts(new Date(naive), tz).offsetMin;
    var ts = naive - off * 60000;
    var off2 = tzParts(new Date(ts), tz).offsetMin;
    if (off2 !== off) ts = naive - off2 * 60000;
    return new Date(ts);
  }
  function nextYmd(ymd) { var a = ymd.split('-').map(Number); return new Date(Date.UTC(a[0], a[1] - 1, a[2] + 1)).toISOString().slice(0, 10); }
  function parseHourMin(v, def) {
    var m = S(v).trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return def;
    var n = +m[1] * 60 + +m[2];
    return n >= 0 && n <= 1440 ? n : def;
  }

  /* ---------------------------------------------------------------- */
  /* Persistencia                                                      */
  /* ---------------------------------------------------------------- */
  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) { DB = JSON.parse(raw); if (DB && DB.v === 1) return; }
    } catch (e) { /* datos dañados o almacenamiento bloqueado */ }
    DB = seed();
    save();
  }
  var memoryOnly = false;
  function save() {
    if (memoryOnly) return;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(DB)); }
    catch (e) { memoryOnly = true; console.warn('Sin almacenamiento local: los cambios se pierden al recargar.'); }
  }

  /* ---------------------------------------------------------------- */
  /* Contexto (catálogos)                                              */
  /* ---------------------------------------------------------------- */
  function context() {
    var props = DB.props.map(function (p) { return Object.assign({}, p, { inicioMin: parseHourMin(p.horaInicio, 0), finMin: parseHourMin(p.horaFin, 1440) }); });
    var c = { props: props, propMap: {}, catalogs: DB.catalogs, policies: DB.policies, policyMap: {}, techs: DB.techs, techMap: {}, holidays: DB.catalogs.filter(function (x) { return x.tipo === 'FESTIVO' && isTrue(x.activo); }).map(function (x) { return x.valor; }) };
    props.forEach(function (p) { c.propMap[p.propiedadId] = p; });
    DB.policies.forEach(function (p) { c.policyMap[p.politicaId] = p; });
    DB.techs.forEach(function (t) { c.techMap[t.email.toLowerCase()] = t; });
    return c;
  }
  function catalogValues(ctx, tipo) {
    return ctx.catalogs.filter(function (c) { return c.tipo === tipo && isTrue(c.activo); })
      .sort(function (a, b) { return (a.orden || 0) - (b.orden || 0); }).map(function (c) { return c.valor; });
  }
  function cfg(key, def) { var v = DB.config[key]; return v === undefined || v === '' ? def : v; }
  function propertyName(ctx, pid) { var p = ctx.propMap[pid]; return p ? (p.nombreCorto || p.nombre) : 'Por identificar'; }

  /* ---------------------------------------------------------------- */
  /* Motor de tickets                                                  */
  /* ---------------------------------------------------------------- */
  function dedupeKey(plataforma, id) { return S(plataforma).toUpperCase() + ':' + S(id).trim(); }

  function validateMessage(m) {
    var errs = [];
    if ([PLAT.GOOGLE, PLAT.M365, PLAT.MANUAL].indexOf(m.plataforma) < 0) errs.push('plataforma inválida');
    if (!m.mensajeId) errs.push('sin identificador de mensaje');
    if (!isValidEmail(m.remitenteEmail)) errs.push('remitente inválido (' + (m.remitenteEmail || 'vacío') + ')');
    if (!toDate(m.fechaRecepcion)) errs.push('fecha inválida');
    return errs.length ? { ok: false, error: errs.join('; ') } : { ok: true };
  }

  function ignoreReason(m) {
    var from = S(m.remitenteEmail).toLowerCase();
    var own = parseList(cfg('BUZONES_PROPIOS', '')).map(function (x) { return x.toLowerCase(); });
    if (own.indexOf(from) >= 0) return 'Mensaje enviado por un buzón propio del Help Desk';
    if (/^(mailer-daemon|postmaster|no-?reply|do-?not-?reply)@/i.test(from)) return 'Remitente automático (' + from + ')';
    var auto = S(m.autoSubmitted).trim().toLowerCase();
    if (auto && auto !== 'no') return 'Respuesta automática (Auto-Submitted: ' + auto + ')';
    return '';
  }

  function detectProperty(m, props) {
    var subject = S(m.asunto);
    var text = ' ' + normText(subject + ' ' + S(m.cuerpo).slice(0, 8000)) + ' ';
    var domain = (S(m.remitenteEmail).split('@')[1] || '').toLowerCase();
    var buzon = S(m.buzon).toLowerCase();
    var cands = props.filter(function (p) { return p.propiedadId !== POR_ID && isTrue(p.activo); });
    for (var i = 0; i < cands.length; i++) {
      var code = S(cands[i].codigo || cands[i].propiedadId);
      if (code && new RegExp('\\[\\s*' + escapeRegex(code) + '\\s*\\]', 'i').test(subject)) return { propiedadId: cands[i].propiedadId, metodo: 'ETIQUETA_ASUNTO' };
    }
    var hits = {};
    cands.forEach(function (p) {
      var r = [];
      parseList(p.palabrasClave).forEach(function (k) { if (containsWord(text, normText(k))) r.push('palabra:' + k); });
      if (domain && parseList(p.dominiosRemitente).map(function (d) { return d.toLowerCase(); }).indexOf(domain) >= 0) r.push('dominio:' + domain);
      if (buzon && parseList(p.buzonesAsignados).map(function (d) { return d.toLowerCase(); }).indexOf(buzon) >= 0) r.push('buzon:' + buzon);
      if (r.length) hits[p.propiedadId] = r;
    });
    var ids = Object.keys(hits);
    if (ids.length === 1) return { propiedadId: ids[0], metodo: hits[ids[0]].slice(0, 3).join(',') };
    return { propiedadId: POR_ID, metodo: ids.length ? 'AMBIGUO:' + ids.join('|') : 'SIN_COINCIDENCIAS' };
  }

  function classifyMessage(m, catalogs, prioDefault) {
    var text = ' ' + normText(S(m.asunto) + ' ' + S(m.cuerpo).slice(0, 6000)) + ' ';
    var sinNeg = text.replace(/\bno (es |muy |tan )?urgente\b/g, ' ');
    function best(tipo, def) {
      var win = null, ws = 0;
      catalogs.filter(function (c) { return c.tipo === tipo && isTrue(c.activo); }).forEach(function (c) {
        var sc = parseList(c.palabrasClave).reduce(function (s, k) { return s + (containsWord(text, normText(k)) ? 1 : 0); }, 0);
        if (sc > ws) { win = c.valor; ws = sc; }
      });
      return win || def;
    }
    var prioridad = PRIORIDADES.indexOf(prioDefault) >= 0 ? prioDefault : 'Media';
    var reglas = catalogs.filter(function (c) { return c.tipo === 'PRIORIDAD_REGLA' && isTrue(c.activo); })
      .sort(function (a, b) { return PRIORIDADES.indexOf(a.valor) - PRIORIDADES.indexOf(b.valor); });
    for (var i = 0; i < reglas.length; i++) {
      if (parseList(reglas[i].palabrasClave).some(function (k) { return containsWord(sinNeg, normText(k)); })) { prioridad = reglas[i].valor; break; }
    }
    return { tipoCaso: best('TIPO_CASO', 'Por clasificar'), categoria: best('CATEGORIA', 'Otro / Por clasificar'), area: best('AREA', 'Por identificar'), prioridad: prioridad };
  }

  function nextTicketId(at) {
    var year = tzParts(at, TZ).ymd.slice(0, 4);
    var n = (DB.seq[year] || 0) + 1;
    DB.seq[year] = n;
    return 'IT-' + year + '-' + ('0000' + n).slice(-Math.max(5, String(n).length));
  }

  function pickTech(pid, ctx) {
    var covers = function (t) { var l = parseList(t.propiedades); return isTrue(t.activo) && (l.indexOf('*') >= 0 || l.indexOf(pid) >= 0 || pid === POR_ID); };
    var def = ctx.techMap[S(cfg('TECNICO_PREDETERMINADO_EMAIL', '')).toLowerCase()];
    if (def && covers(def)) return { email: def.email, nombre: def.nombre };
    var any = ctx.techs.filter(covers)[0];
    return any ? { email: any.email, nombre: any.nombre } : { email: '', nombre: 'Sin asignar' };
  }

  function getTicketById(id) { id = S(id).toUpperCase(); return DB.tickets.filter(function (t) { return t.ticketId === id; })[0] || null; }

  function ev(ticketId, usuario, accion, campo, ant, nuevo, comentario, vis) {
    var f = function (v) { return v instanceof Date ? fmtDateTime(v) : S(v); };
    return { eventoId: uuid(), ticketId: ticketId, fecha: now().toISOString(), usuario: usuario || 'sistema', accion: accion, campo: campo || '', valorAnterior: truncate(f(ant), 500), valorNuevo: truncate(f(nuevo), 500), comentario: truncate(comentario || '', 5000), visibilidad: vis || VIS.AUDITORIA };
  }
  function addHistory(events) { events.forEach(function (e) { DB.historial.push(e); }); }
  function addReview(tipo, ticketId, rel, clave, detalle) {
    DB.revision.push({ revisionId: uuid().slice(0, 13), fecha: now().toISOString(), tipo: tipo, ticketId: ticketId || '', ticketRelacionado: rel || '', claveDeduplicacion: clave || '', detalle: truncate(detalle, 1000), estado: 'PENDIENTE' });
  }
  function logAuto(proceso, nivel, mensaje, detalle) {
    DB.log.push({ fecha: now().toISOString(), proceso: proceso, nivel: nivel, mensaje: mensaje, detalle: detalle || '' });
    if (DB.log.length > 500) DB.log.splice(0, DB.log.length - 500);
  }

  function findLinked(m, ctx) {
    if (m.hiloId) {
      var h = DB.index.filter(function (r) { return r.hiloId === m.hiloId && r.plataforma === m.plataforma && r.ticketId; })[0];
      if (h && getTicketById(h.ticketId)) return { ticket: getTicketById(h.ticketId), metodo: 'HILO' };
    }
    var refs = [m.inReplyTo].concat(m.referencias || []).filter(Boolean).reverse();
    for (var i = 0; i < refs.length; i++) {
      var r = DB.index.filter(function (x) { return x.internetMessageId === refs[i] && x.ticketId; })[0];
      if (r && getTicketById(r.ticketId)) return { ticket: getTicketById(r.ticketId), metodo: 'REFERENCIA' };
    }
    var mm = S(m.asunto).match(TICKET_ID_RE);
    if (mm) {
      var t = getTicketById(mm[0]);
      if (t) {
        var from = S(m.remitenteEmail).toLowerCase();
        if (from === S(t.solicitanteEmail).toLowerCase() || ctx.techMap[from]) return { ticket: t, metodo: 'ID_EN_ASUNTO' };
        return { ticket: null, revision: { tipo: 'REFERENCIA_REMITENTE_DISTINTO', ticketId: t.ticketId, detalle: 'El asunto menciona ' + t.ticketId + ' pero el remitente (' + from + ') no es el solicitante original. Se creó un ticket nuevo.' } };
      }
    }
    return { ticket: null };
  }

  function findSuspect(m) {
    var ventana = Number(cfg('VENTANA_DUPLICADO_MIN', 10)) * 60000;
    var from = S(m.remitenteEmail).toLowerCase(), subj = normSubject(m.asunto), f = toDate(m.fechaRecepcion);
    for (var i = DB.index.length - 1; i >= 0 && i >= DB.index.length - 400; i--) {
      var r = DB.index[i];
      if (r.plataforma === m.plataforma || !r.ticketId || r.remitente !== from || r.asuntoNormalizado !== subj) continue;
      var d = toDate(r.fechaRecepcion);
      if (d && Math.abs(d - f) <= ventana) return { ticketId: r.ticketId, plataforma: r.plataforma, minutos: Math.round(Math.abs(d - f) / 60000) };
    }
    return null;
  }

  /** Punto de entrada único para mensajes de ambos buzones y tickets manuales. */
  function processIncoming(m, opts) {
    opts = opts || {};
    var v = validateMessage(m);
    if (!v.ok) return { resultado: RES.INVALIDO, detalle: v.error };
    var key = dedupeKey(m.plataforma, m.mensajeId);
    var at = now();
    var existing = DB.index.filter(function (r) { return r.claveDeduplicacion === key; })[0];
    if (existing) return { resultado: RES.DUPLICADO, ticketId: existing.ticketId, detalle: 'Mensaje ya procesado (' + existing.resultado + ')' };

    var entry = { claveDeduplicacion: key, plataforma: m.plataforma, buzon: m.buzon || '', mensajeId: m.mensajeId, internetMessageId: m.internetMessageId || '', hiloId: m.hiloId || '', remitente: S(m.remitenteEmail).toLowerCase(), asuntoNormalizado: truncate(normSubject(m.asunto), 200), fechaRecepcion: iso(m.fechaRecepcion) };
    function saveIndex(resultado, ticketId, detalle) { DB.index.push(Object.assign(entry, { resultado: resultado, ticketId: ticketId || '', detalle: truncate(detalle || '', 500), fechaProcesado: at.toISOString() })); }

    var reason = ignoreReason(m);
    if (reason) { saveIndex(RES.IGNORADO, '', reason); return { resultado: RES.IGNORADO, detalle: reason }; }

    if (m.internetMessageId) {
      var twin = DB.index.filter(function (r) { return r.internetMessageId === m.internetMessageId && r.claveDeduplicacion !== key && r.ticketId; })[0];
      if (twin) {
        saveIndex(RES.DUPLICADO, twin.ticketId, 'Mismo Message-ID ya recibido por ' + twin.plataforma);
        addHistory([ev(twin.ticketId, 'sistema', 'DUPLICADO_ENTRE_BUZONES', '', '', '', 'El mismo correo llegó también a ' + m.buzon + ' (' + m.plataforma + '). No se creó un ticket adicional.', VIS.AUDITORIA)]);
        return { resultado: RES.DUPLICADO, ticketId: twin.ticketId, detalle: 'Duplicado entre plataformas' };
      }
    }

    var ctx = context();
    var link = findLinked(m, ctx);
    if (link.ticket) {
      var t0 = link.ticket;
      addHistory([ev(t0.ticketId, S(m.remitenteEmail).toLowerCase(), 'RESPUESTA_RECIBIDA', '', '', '', truncate(cleanReplyBody(m.cuerpo), 3000), VIS.PUBLICO)]);
      t0.fechaActualizacion = at.toISOString(); t0.version = (t0.version || 0) + 1; t0.actualizadoPor = 'sistema';
      if (t0.estado === ESTADOS.CERRADO) addReview('RESPUESTA_EN_TICKET_CERRADO', t0.ticketId, '', key, 'El solicitante respondió a un ticket cerrado (' + link.metodo + '). Revise si debe reabrirse.');
      saveIndex(RES.ACTUALIZADO, t0.ticketId, 'Vinculado por ' + link.metodo);
      return { resultado: RES.ACTUALIZADO, ticketId: t0.ticketId, detalle: 'Vinculado por ' + link.metodo };
    }

    var ov = opts.overrides || {};
    var det = ov.propiedadId ? { propiedadId: ov.propiedadId, metodo: 'MANUAL' } : detectProperty(m, ctx.props);
    var cls = classifyMessage(m, ctx.catalogs, cfg('PRIORIDAD_PREDETERMINADA', 'Media'));
    var tech = ov.tecnicoEmail && ctx.techMap[ov.tecnicoEmail] ? { email: ov.tecnicoEmail, nombre: ctx.techMap[ov.tecnicoEmail].nombre } : pickTech(det.propiedadId, ctx);
    var t = {
      ticketId: nextTicketId(toDate(m.fechaRecepcion)), propiedadId: det.propiedadId, propiedadMetodo: det.metodo,
      plataformaOrigen: m.plataforma, buzonOrigen: m.buzon || '', mensajeId: m.mensajeId, internetMessageId: m.internetMessageId || '', hiloId: m.hiloId || '', claveDeduplicacion: key,
      asunto: truncate(S(m.asunto || '(sin asunto)').trim(), 300), detalle: truncate(S(m.cuerpo).trim(), 20000),
      tipoCaso: ov.tipoCaso || cls.tipoCaso, categoria: ov.categoria || cls.categoria, prioridad: ov.prioridad || cls.prioridad, area: ov.area || cls.area,
      solicitanteNombre: truncate(m.remitenteNombre || S(m.remitenteEmail).split('@')[0], 120), solicitanteEmail: S(m.remitenteEmail).toLowerCase(),
      tecnicoEmail: tech.email, tecnicoNombre: tech.nombre, estado: ESTADOS.PENDIENTE,
      fechaSolicitud: iso(m.fechaRecepcion), fechaRegistro: at.toISOString(), fechaPrimeraRespuesta: '', fechaCierre: '', fechaActualizacion: at.toISOString(),
      slaPausadoDesde: '', slaMinutosPausa: 0, reaperturas: 0, posibleDuplicado: '', notasCierre: '', version: 1,
      creadoPor: opts.creadoPor || ('sistema:' + m.plataforma), actualizadoPor: opts.creadoPor || 'sistema'
    };
    Object.assign(t, computeSlaFields(t, ctx, at));
    var suspect = findSuspect(m);
    if (suspect) t.posibleDuplicado = suspect.ticketId;
    DB.tickets.push(t);
    addHistory([ev(t.ticketId, opts.creadoPor || 'sistema', 'CREADO', '', '', ESTADOS.PENDIENTE,
      'Origen: ' + m.plataforma + ' / ' + (m.buzon || '-') + ' | Propiedad: ' + t.propiedadId + ' (' + t.propiedadMetodo + ') | Clasificación: ' + t.tipoCaso + ' · ' + t.categoria + ' · ' + t.prioridad + ' | SLA: ' + (t.slaPoliticaId || 'sin política'), VIS.AUDITORIA)]);
    saveIndex(RES.CREADO, t.ticketId, 'Propiedad: ' + t.propiedadMetodo);
    if (suspect) addReview('POSIBLE_DUPLICADO', t.ticketId, suspect.ticketId, key, 'Mismo remitente y asunto recibido por ' + suspect.plataforma + ' con ' + suspect.minutos + ' min de diferencia, pero con distinto Message-ID. Verifique y cierre uno si corresponde.');
    if (link.revision) addReview(link.revision.tipo, t.ticketId, link.revision.ticketId, key, link.revision.detalle);
    if (!opts.sinConfirmacion && isTrue(cfg('CONFIRMACION_HABILITADA', true))) {
      addHistory([ev(t.ticketId, 'sistema', 'CONFIRMACION_ENVIADA', '', '', '', 'Acuse de recibo automático [simulado en la demo: no se envía correo]. No cuenta como primera respuesta técnica.', VIS.PUBLICO)]);
    }
    return { resultado: RES.CREADO, ticketId: t.ticketId };
  }

  /* ---------------------------------------------------------------- */
  /* SLA                                                               */
  /* ---------------------------------------------------------------- */
  function buildCalendar(tipo, prop, holidays) {
    var tz = (prop && prop.zonaHoraria) || TZ;
    if (S(tipo).toUpperCase() !== 'HABIL') return { type: '24x7', tz: tz };
    var days = parseList((prop && prop.diasServicio) || '1,2,3,4,5,6,7').map(Number).filter(function (n) { return n >= 1 && n <= 7; });
    if (!prop || prop.finMin <= prop.inicioMin || !days.length) return { type: '24x7', tz: tz };
    return { type: 'HABIL', tz: tz, startMin: prop.inicioMin, endMin: prop.finMin, days: days, holidays: holidays || [] };
  }
  function calendarFor(tipo, pid, ctx) { return buildCalendar(tipo, ctx.propMap[pid] || ctx.propMap[POR_ID], ctx.holidays); }
  function isServiceDay(p, cal) { return cal.days.indexOf(p.dow) >= 0 && cal.holidays.indexOf(p.ymd) < 0; }

  function addServiceMinutes(start, minutes, cal) {
    start = toDate(start);
    if (!start) return null;
    if (cal.type !== 'HABIL') return new Date(start.getTime() + minutes * 60000);
    var remaining = minutes, cur = start;
    for (var i = 0; i < 1500; i++) {
      var p = tzParts(cur, cal.tz);
      if (isServiceDay(p, cal)) {
        var ws = localToDate(p.ymd, cal.startMin, cal.tz), we = localToDate(p.ymd, cal.endMin, cal.tz);
        if (cur < ws) cur = ws;
        if (cur < we) {
          var avail = (we - cur) / 60000;
          if (remaining <= avail) return new Date(cur.getTime() + remaining * 60000);
          remaining -= avail;
        }
      }
      cur = localToDate(nextYmd(p.ymd), 0, cal.tz);
    }
    throw err('El calendario de servicio no tiene horas disponibles.');
  }
  function serviceMinutesBetween(a, b, cal) {
    a = toDate(a); b = toDate(b);
    if (!a || !b || b <= a) return 0;
    if (cal.type !== 'HABIL') return (b - a) / 60000;
    var total = 0, cur = a;
    for (var i = 0; i < 1500 && cur < b; i++) {
      var p = tzParts(cur, cal.tz);
      if (isServiceDay(p, cal)) {
        var ws = localToDate(p.ymd, cal.startMin, cal.tz).getTime(), we = localToDate(p.ymd, cal.endMin, cal.tz).getTime();
        var s = Math.max(cur.getTime(), ws), e = Math.min(b.getTime(), we);
        if (e > s) total += (e - s) / 60000;
      }
      cur = localToDate(nextYmd(p.ymd), 0, cal.tz);
    }
    return total;
  }

  function resolvePolicy(t, policies) {
    var spec = function (p) { return (p.categoria !== '*' ? 2 : 0) + (p.propiedadId !== '*' ? 1 : 0); };
    return policies.filter(function (p) {
      return isTrue(p.activo) && p.prioridad === t.prioridad && (p.categoria === '*' || p.categoria === t.categoria) && (p.propiedadId === '*' || p.propiedadId === t.propiedadId);
    }).sort(function (a, b) { return spec(b) - spec(a); })[0] || null;
  }

  function computeSlaFields(t, ctx, at) {
    var pol = resolvePolicy(t, ctx.policies);
    if (!pol || !toDate(t.fechaSolicitud)) return { slaPoliticaId: '', slaCalendario: '', slaRespuestaObjetivoMin: '', slaResolucionObjetivoMin: '', slaRespuestaVence: '', slaResolucionVence: '', slaEstado: SLA.SIN_SLA, slaRespuestaCumplida: '', slaResolucionCumplida: '' };
    var cal = calendarFor(pol.calendario, t.propiedadId, ctx);
    var out = {
      slaPoliticaId: pol.politicaId, slaCalendario: cal.type,
      slaRespuestaObjetivoMin: +pol.respuestaMin, slaResolucionObjetivoMin: +pol.resolucionMin,
      slaRespuestaVence: iso(addServiceMinutes(t.fechaSolicitud, +pol.respuestaMin, cal)),
      slaResolucionVence: iso(addServiceMinutes(t.fechaSolicitud, +pol.resolucionMin + (+t.slaMinutosPausa || 0), cal))
    };
    var e = evaluateSla(Object.assign({}, t, out), at, cal, pol.umbralAlertaPct);
    out.slaEstado = e.estado; out.slaRespuestaCumplida = e.respuestaCumplida; out.slaResolucionCumplida = e.resolucionCumplida;
    return out;
  }

  function evaluateSla(t, at, cal, umbralPct) {
    var respV = toDate(t.slaRespuestaVence), resV = toDate(t.slaResolucionVence);
    if (!respV || !resV) return { estado: SLA.SIN_SLA, respuestaCumplida: '', resolucionCumplida: '', pctRespuesta: 0, pctResolucion: 0, minutosRespuesta: null, minutosResolucion: null };
    var start = toDate(t.fechaSolicitud), cerrado = t.estado === ESTADOS.CERRADO;
    var cierre = cerrado ? toDate(t.fechaCierre) : null;
    var fr = toDate(t.fechaPrimeraRespuesta) || cierre;
    var pausado = cerrado ? null : toDate(t.slaPausadoDesde);
    var umbral = (+umbralPct || 75) / 100;
    var rc = fr ? (fr <= respV ? 'SI' : 'NO') : (at > respV ? 'NO' : '');
    var sc = cierre ? (cierre <= resV ? 'SI' : 'NO') : (!pausado && at > resV ? 'NO' : '');
    var minResp = serviceMinutesBetween(start, fr || at, cal);
    var minRes = Math.max(0, serviceMinutesBetween(start, cierre || pausado || at, cal) - (+t.slaMinutosPausa || 0));
    var pR = t.slaRespuestaObjetivoMin ? minResp / t.slaRespuestaObjetivoMin : 0;
    var pS = t.slaResolucionObjetivoMin ? minRes / t.slaResolucionObjetivoMin : 0;
    var estado;
    if (cerrado) estado = sc === 'SI' && rc !== 'NO' ? SLA.CUMPLIDO : SLA.INCUMPLIDO;
    else if (rc === 'NO' || sc === 'NO') estado = SLA.VENCIDO;
    else if (pausado) estado = SLA.PAUSADO;
    else if ((!fr && pR >= umbral) || pS >= umbral) estado = SLA.PROXIMO;
    else estado = SLA.EN_TIEMPO;
    return { estado: estado, respuestaCumplida: rc, resolucionCumplida: sc, pctRespuesta: pR, pctResolucion: pS, minutosRespuesta: fr ? minResp : null, minutosResolucion: cierre ? minRes : null };
  }

  function liveEval(t, at, ctx) {
    if (!t.slaRespuestaVence) return evaluateSla(t, at, { type: '24x7' }, 75);
    var pol = ctx.policyMap[t.slaPoliticaId];
    return evaluateSla(t, at, calendarFor(t.slaCalendario, t.propiedadId, ctx), pol ? pol.umbralAlertaPct : 75);
  }

  function refreshSla(t, ctx, at) {
    if (!t.slaRespuestaVence) return;
    var e = liveEval(t, at, ctx);
    t.slaEstado = e.estado; t.slaRespuestaCumplida = e.respuestaCumplida; t.slaResolucionCumplida = e.resolucionCumplida;
  }

  /* Alertas y escalamiento (en la demo se registran, no se envían) */
  var ALERTA_TXT = { PROX_RESPUESTA: 'Primera respuesta próxima a vencer', VENC_RESPUESTA: 'Primera respuesta VENCIDA', PROX_RESOLUCION: 'Resolución próxima a vencer', VENC_RESOLUCION: 'Resolución VENCIDA' };
  function alertLabel(tipo) { if (ALERTA_TXT[tipo]) return ALERTA_TXT[tipo]; var m = S(tipo).match(/^ESC_N(\d+)_(VENC_RESPUESTA|VENC_RESOLUCION)$/); return m ? 'Escalamiento nivel ' + m[1] + ' · ' + ALERTA_TXT[m[2]] : tipo; }

  function collectAlerts(t, e, at, rules, ctx) {
    var out = [], respV = toDate(t.slaRespuestaVence), resV = toDate(t.slaResolucionVence), fr = toDate(t.fechaPrimeraRespuesta), paus = !!toDate(t.slaPausadoDesde);
    var pol = ctx.policyMap[t.slaPoliticaId], umbral = ((pol && +pol.umbralAlertaPct) || 75) / 100;
    var tech = ctx.techMap[S(t.tecnicoEmail).toLowerCase()];
    var techTo = tech && isTrue(tech.activo) && isTrue(tech.recibeAlertas) ? [tech.email] : parseList(cfg('ALERTAS_ADMIN_EMAILS', ''));
    var add = function (tipo, vence, to) { out.push({ clave: t.ticketId + '|' + tipo + '|' + vence.getTime(), ticketId: t.ticketId, tipo: tipo, vence: vence, destinatarios: to }); };
    if (!fr && respV) { if (at >= respV) add('VENC_RESPUESTA', respV, techTo); else if (e.pctRespuesta >= umbral) add('PROX_RESPUESTA', respV, techTo); }
    if (!paus && resV) { if (at >= resV) add('VENC_RESOLUCION', resV, techTo); else if (e.pctResolucion >= umbral) add('PROX_RESOLUCION', resV, techTo); }
    var match = function (lista, val) { var l = parseList(lista); return !l.length || l.indexOf('*') >= 0 || l.indexOf(val) >= 0; };
    rules.forEach(function (r) {
      var cond = S(r.condicion).toUpperCase();
      var due = cond === 'VENC_RESPUESTA' ? (fr ? null : respV) : cond === 'VENC_RESOLUCION' ? (paus ? null : resV) : null;
      if (!due || !match(r.prioridades, t.prioridad) || !match(r.propiedadId, t.propiedadId)) return;
      if (at.getTime() >= due.getTime() + (+r.minutosDespuesVencimiento || 0) * 60000) add('ESC_N' + (+r.nivel || 1) + '_' + cond, due, parseList(r.destinatarios));
    });
    return out;
  }

  function monitorSla() {
    var at = now(), ctx = context();
    var rules = DB.escalation.filter(function (r) { return isTrue(r.activo); });
    var sent = {};
    DB.alerts.forEach(function (a) { sent[a.claveAlerta] = true; });
    var nuevas = 0;
    DB.tickets.forEach(function (t) {
      var abierto = t.estado !== ESTADOS.CERRADO;
      if (!abierto && [SLA.CUMPLIDO, SLA.INCUMPLIDO, SLA.SIN_SLA].indexOf(t.slaEstado) >= 0) return;
      refreshSla(t, ctx, at);
      if (!abierto || !t.slaRespuestaVence) return;
      collectAlerts(t, liveEval(t, at, ctx), at, rules, ctx).forEach(function (a) {
        if (sent[a.clave]) return;
        sent[a.clave] = true;
        nuevas++;
        DB.alerts.push({ claveAlerta: a.clave, ticketId: a.ticketId, tipo: a.tipo, fecha: at.toISOString(), destinatarios: a.destinatarios.join(', '), estado: a.destinatarios.length ? 'SIMULADA' : 'SIN DESTINATARIO', detalle: alertLabel(a.tipo) + ' · vence ' + fmtDateTime(a.vence) });
      });
    });
    if (nuevas) logAuto('monitorSla', 'INFO', nuevas + ' alerta(s) nuevas registradas (modo demo: no se envían correos)');
    return nuevas;
  }

  /* ---------------------------------------------------------------- */
  /* Reportes                                                          */
  /* ---------------------------------------------------------------- */
  function computeKpis(tickets, at, ctx) {
    var k = { pendiente: 0, enProceso: 0, cerrado: 0, total: 0, vencidos: 0, proximos: 0, pausados: 0, porIdentificar: 0, slaCumplidos: 0, slaEvaluables: 0, respATiempo: 0, respEvaluables: 0, cumplimientoPct: null, cumplimientoRespuestaPct: null, tmprMin: null, tmrMin: null };
    var sFr = 0, nFr = 0, sRes = 0, nRes = 0;
    tickets.forEach(function (t) {
      var e = t._sla || (t._sla = liveEval(t, at, ctx));
      k.total++;
      if (t.estado === ESTADOS.PENDIENTE) k.pendiente++; else if (t.estado === ESTADOS.EN_PROCESO) k.enProceso++; else if (t.estado === ESTADOS.CERRADO) k.cerrado++;
      if (t.propiedadId === POR_ID) k.porIdentificar++;
      if (e.estado === SLA.VENCIDO) k.vencidos++;
      if (e.estado === SLA.PROXIMO) k.proximos++;
      if (e.estado === SLA.PAUSADO) k.pausados++;
      if (e.estado === SLA.CUMPLIDO || e.estado === SLA.INCUMPLIDO) { k.slaEvaluables++; if (e.estado === SLA.CUMPLIDO) k.slaCumplidos++; }
      if (e.respuestaCumplida === 'SI' || e.respuestaCumplida === 'NO') { k.respEvaluables++; if (e.respuestaCumplida === 'SI') k.respATiempo++; }
      if (e.minutosRespuesta !== null) { sFr += e.minutosRespuesta; nFr++; }
      if (e.minutosResolucion !== null) { sRes += e.minutosResolucion; nRes++; }
    });
    var pct = function (a, b) { return b ? Math.round(a / b * 1000) / 10 : null; };
    k.cumplimientoPct = pct(k.slaCumplidos, k.slaEvaluables);
    k.cumplimientoRespuestaPct = pct(k.respATiempo, k.respEvaluables);
    k.tmprMin = nFr ? Math.round(sFr / nFr) : null;
    k.tmrMin = nRes ? Math.round(sRes / nRes) : null;
    return k;
  }
  var DIMS = {
    propiedad: { titulo: 'Por propiedad', key: function (t, ctx) { return propertyName(ctx, t.propiedadId); } },
    tecnico: { titulo: 'Por técnico', key: function (t) { return t.tecnicoNombre || 'Sin asignar'; } },
    prioridad: { titulo: 'Por prioridad', key: function (t) { return t.prioridad || '—'; } },
    categoria: { titulo: 'Por categoría', key: function (t) { return t.categoria || '—'; } },
    periodo: { titulo: 'Por mes', key: function (t) { var d = toDate(t.fechaSolicitud); return d ? tzParts(d, TZ).ymd.slice(0, 7) : '—'; } }
  };
  function buildReport(tickets, f, at, ctx) {
    var d = f.desde ? localToDate(f.desde, 0, TZ) : null, h = f.hasta ? localToDate(nextYmd(f.hasta), 0, TZ) : null;
    var sel = tickets.filter(function (t) { var x = toDate(t.fechaSolicitud); return x && (!d || x >= d) && (!h || x < h); });
    return {
      filtros: f, generado: at.toISOString(), kpis: computeKpis(sel, at, ctx),
      grupos: Object.keys(DIMS).map(function (dim) {
        var g = {};
        sel.forEach(function (t) { var k = DIMS[dim].key(t, ctx); (g[k] = g[k] || []).push(t); });
        var filas = Object.keys(g).map(function (k) {
          var kp = computeKpis(g[k], at, ctx);
          return { grupo: k, total: kp.total, pendiente: kp.pendiente, enProceso: kp.enProceso, cerrado: kp.cerrado, vencidos: kp.vencidos, cumplimientoPct: kp.cumplimientoPct, cumplimientoRespuestaPct: kp.cumplimientoRespuestaPct, tmprMin: kp.tmprMin, tmrMin: kp.tmrMin };
        });
        if (dim === 'prioridad') filas.sort(function (a, b) { return PRIORIDADES.indexOf(a.grupo) - PRIORIDADES.indexOf(b.grupo); });
        else if (dim === 'periodo') filas.sort(function (a, b) { return a.grupo < b.grupo ? 1 : -1; });
        else filas.sort(function (a, b) { return b.total - a.total; });
        return { dimension: dim, titulo: DIMS[dim].titulo, filas: filas };
      })
    };
  }

  /* ---------------------------------------------------------------- */
  /* Usuarios y permisos                                               */
  /* ---------------------------------------------------------------- */
  function currentUser() {
    var email = '';
    try { email = localStorage.getItem(USER_KEY) || ''; } catch (e) { /* sin almacenamiento */ }
    var row = DB.users.filter(function (u) { return u.email === email && isTrue(u.activo); })[0] || DB.users[0];
    return { email: row.email, nombre: row.nombre, rol: row.rol, propiedades: parseList(row.propiedades || '*'), tecnicoEmail: S(row.tecnicoEmail).toLowerCase() };
  }
  function hasRole(u, roles) { return roles.indexOf(u.rol) >= 0; }
  function requireRole(roles) { var u = currentUser(); if (!hasRole(u, roles)) throw err('No tiene permisos para realizar esta operación.'); return u; }
  function canSeeProperty(u, pid) { return u.propiedades.indexOf('*') >= 0 || u.propiedades.indexOf(pid) >= 0 || (pid === POR_ID && u.rol !== ROLES.LECTOR); }
  function canEdit(u, t) { return hasRole(u, ROLES_EDICION) && canSeeProperty(u, t.propiedadId); }
  function permissions(u) {
    var g = hasRole(u, ROLES_GESTION);
    return { editar: hasRole(u, ROLES_EDICION), crearTicket: hasRole(u, ROLES_EDICION), reasignar: g, prioridad: g, pausarSla: g, verInternos: u.rol !== ROLES.LECTOR, conectores: g, ejecutarConectores: u.rol === ROLES.ADMIN, exportarReportes: g, administrar: u.rol === ROLES.ADMIN };
  }

  /* ---------------------------------------------------------------- */
  /* API (mismas funciones que Api.gs)                                 */
  /* ---------------------------------------------------------------- */
  function validateId(id) { var s = S(id).trim().toUpperCase(); if (!/^IT-\d{4}-\d{5,}$/.test(s)) throw err('Identificador de ticket no válido.'); return s; }
  function slaClient(e) {
    return { estado: e.estado, respuestaCumplida: e.respuestaCumplida, resolucionCumplida: e.resolucionCumplida, pctRespuesta: Math.round((e.pctRespuesta || 0) * 100), pctResolucion: Math.round((e.pctResolucion || 0) * 100), minutosRespuesta: e.minutosRespuesta === null ? null : Math.round(e.minutosRespuesta), minutosResolucion: e.minutosResolucion === null ? null : Math.round(e.minutosResolucion) };
  }
  function summarize(t, ctx, at) {
    var e = t._sla || liveEval(t, at, ctx);
    return { ticketId: t.ticketId, asunto: t.asunto, resumen: truncate(S(t.detalle).replace(/\s+/g, ' '), 140), tipoCaso: t.tipoCaso, categoria: t.categoria, solicitanteNombre: t.solicitanteNombre, solicitanteEmail: t.solicitanteEmail, area: t.area, propiedadId: t.propiedadId, propiedadNombre: propertyName(ctx, t.propiedadId), plataformaOrigen: t.plataformaOrigen, tecnicoNombre: t.tecnicoNombre, estado: t.estado, prioridad: t.prioridad, fechaSolicitud: t.fechaSolicitud, fechaPrimeraRespuesta: t.fechaPrimeraRespuesta, fechaCierre: t.fechaCierre, slaRespuestaVence: t.slaRespuestaVence, slaResolucionVence: t.slaResolucionVence, posibleDuplicado: t.posibleDuplicado, sla: slaClient(e) };
  }
  function serialize(t, ctx) {
    var o = {};
    Object.keys(t).forEach(function (k) { if (k.charAt(0) !== '_') o[k] = t[k] === null || t[k] === undefined ? '' : t[k]; });
    o.propiedadNombre = propertyName(ctx, t.propiedadId);
    o.sla = slaClient(liveEval(t, now(), ctx));
    return JSON.parse(JSON.stringify(o));
  }
  function visibleTickets(u, pid, ctx, at) {
    pid = S(pid || '*');
    if (pid !== '*' && !ctx.propMap[pid]) throw err('Propiedad desconocida.');
    if (pid !== '*' && !canSeeProperty(u, pid)) throw err('No tiene acceso a esa propiedad.');
    return DB.tickets.filter(function (t) {
      if (!canSeeProperty(u, t.propiedadId) || (pid !== '*' && t.propiedadId !== pid)) return false;
      t._sla = liveEval(t, at, ctx);
      return true;
    });
  }
  function clean() { DB.tickets.forEach(function (t) { delete t._sla; }); }

  /** Cambio con control de versión, igual que mutateTicket_ en Api.gs. */
  function mutate(id, version, u, fn, noVersion) {
    var t = getTicketById(validateId(id));
    if (!t || !canSeeProperty(u, t.propiedadId)) throw err('Ticket no encontrado o sin acceso.');
    if (!canEdit(u, t)) throw err('No tiene permisos para modificar este ticket.');
    if (version !== null && version !== undefined && +t.version !== +version) throw err('Otra persona modificó este ticket. Se recargará con los cambios más recientes.');
    var draft = JSON.parse(JSON.stringify(t)), events = [], at = now();
    fn(draft, events, at);
    draft.fechaActualizacion = at.toISOString(); draft.actualizadoPor = u.email;
    if (!noVersion) draft.version = (+t.version || 0) + 1;
    Object.keys(draft).forEach(function (k) { t[k] = draft[k]; });
    addHistory(events);
    return t;
  }
  function change(t, events, u, campo, valor) {
    if (S(t[campo]) === S(valor)) return false;
    events.push(ev(t.ticketId, u.email, 'CAMBIO', campo, t[campo], valor, '', VIS.AUDITORIA));
    t[campo] = valor;
    return true;
  }
  function reopen(t, at, ctx) {
    var cal = calendarFor(t.slaCalendario, t.propiedadId, ctx);
    var pausa = (+t.slaMinutosPausa || 0) + serviceMinutesBetween(t.fechaCierre, at, cal);
    t.estado = ESTADOS.PENDIENTE; t.fechaCierre = ''; t.reaperturas = (+t.reaperturas || 0) + 1; t.slaMinutosPausa = Math.round(pausa); t.slaResolucionCumplida = '';
    if (t.slaResolucionObjetivoMin !== '') t.slaResolucionVence = iso(addServiceMinutes(t.fechaSolicitud, +t.slaResolucionObjetivoMin + pausa, cal));
  }

  var API = {
    getBootstrap: function () {
      var u = currentUser(), ctx = context();
      return {
        app: { nombre: 'Help Desk IT', dashboard: 'DESBORD IT', version: '1.0.0' },
        timezone: TZ,
        demo: true,
        usuario: { email: u.email, nombre: u.nombre, rol: u.rol, tecnicoEmail: u.tecnicoEmail },
        usuariosDemo: DB.users.map(function (x) { return { email: x.email, nombre: x.nombre, rol: x.rol, propiedades: x.propiedades }; }),
        permisos: permissions(u),
        propiedades: ctx.props.filter(function (p) { return isTrue(p.activo) && canSeeProperty(u, p.propiedadId); }).map(function (p) { return { id: p.propiedadId, codigo: p.codigo, nombre: p.nombre, nombreCorto: p.nombreCorto }; }),
        logos: ctx.props.filter(function (p) { return p.propiedadId !== POR_ID && p.logoUrl; }).map(function (p) { return { nombre: p.nombreCorto, url: p.logoUrl }; }),
        catalogos: { tiposCaso: catalogValues(ctx, 'TIPO_CASO'), categorias: catalogValues(ctx, 'CATEGORIA'), areas: catalogValues(ctx, 'AREA'), prioridades: PRIORIDADES, estados: ESTADOS_LISTA, slaEstados: Object.keys(SLA).map(function (k) { return SLA[k]; }), plataformas: [PLAT.GOOGLE, PLAT.M365, PLAT.MANUAL] },
        tecnicos: ctx.techs.filter(function (t) { return isTrue(t.activo); }).map(function (t) { return { email: t.email, nombre: t.nombre }; }),
        slaValidado: false,
        sheetUrl: ''
      };
    },

    getDashboard: function (pid) {
      var u = currentUser(), ctx = context(), at = now();
      var ts = visibleTickets(u, pid, ctx, at), k = computeKpis(ts, at, ctx);
      var ab = ts.filter(function (t) { return t.estado !== ESTADOS.CERRADO; });
      var vence = function (t) { return toDate(!t.fechaPrimeraRespuesta ? t.slaRespuestaVence : t.slaResolucionVence) || new Date(8.64e15); };
      var byV = function (a, b) { return vence(a) - vence(b); };
      var count = function (campo) { var m = {}; ts.forEach(function (t) { var x = t[campo] || '—'; m[x] = (m[x] || 0) + 1; }); return Object.keys(m).map(function (x) { return { etiqueta: x, valor: m[x] }; }).sort(function (a, b) { return b.valor - a.valor; }).slice(0, 8); };
      var sm = function (t) { return summarize(t, ctx, at); };
      var r = {
        kpis: k,
        vencidos: ab.filter(function (t) { return t._sla.estado === SLA.VENCIDO; }).sort(byV).slice(0, 10).map(sm),
        proximos: ab.filter(function (t) { return t._sla.estado === SLA.PROXIMO; }).sort(byV).slice(0, 10).map(sm),
        recientes: ts.slice().sort(function (a, b) { return toDate(b.fechaSolicitud) - toDate(a.fechaSolicitud); }).slice(0, 8).map(sm),
        porCategoria: count('categoria'),
        porPrioridadAbiertos: PRIORIDADES.map(function (p) { return { etiqueta: p, valor: ab.filter(function (t) { return t.prioridad === p; }).length }; }),
        conectores: permissions(u).conectores ? DB.connectors.map(function (c) { return { plataforma: c.plataforma, buzon: c.buzon, estadoConexion: c.estadoConexion, ultimaEjecucion: c.ultimaEjecucion, ultimoResultadoCorrecto: c.ultimoResultadoCorrecto }; }) : null,
        slaValidado: false, generado: at.toISOString()
      };
      clean();
      return r;
    },

    listTickets: function (q) {
      var u = currentUser(), ctx = context(), at = now();
      q = q || {};
      var size = Math.min(100, Math.max(5, +q.pageSize || 25)), page = Math.max(1, +q.page || 1), texto = normText(S(q.texto).slice(0, 100));
      var rows = visibleTickets(u, q.propiedadId, ctx, at).filter(function (t) {
        return (!q.estado || t.estado === q.estado) && (!q.prioridad || t.prioridad === q.prioridad) && (!q.sla || t._sla.estado === q.sla) &&
          (!q.plataforma || t.plataformaOrigen === q.plataforma) && (!q.tecnico || S(t.tecnicoEmail).toLowerCase() === S(q.tecnico).toLowerCase()) &&
          (!texto || normText([t.ticketId, t.asunto, t.solicitanteNombre, t.solicitanteEmail, t.area, t.categoria, S(t.detalle).slice(0, 2000)].join(' ')).indexOf(texto) >= 0);
      }).sort(function (a, b) { return toDate(b.fechaSolicitud) - toDate(a.fechaSolicitud); });
      var r = { total: rows.length, page: page, pageSize: size, pages: Math.max(1, Math.ceil(rows.length / size)), items: rows.slice((page - 1) * size, page * size).map(function (t) { return summarize(t, ctx, at); }) };
      clean();
      return r;
    },

    getTicket: function (id) {
      var u = currentUser(), ctx = context();
      var t = getTicketById(validateId(id));
      if (!t || !canSeeProperty(u, t.propiedadId)) throw err('Ticket no encontrado o sin acceso.');
      var internos = u.rol !== ROLES.LECTOR, p = permissions(u), ed = canEdit(u, t);
      return {
        ticket: serialize(t, ctx),
        historial: DB.historial.filter(function (h) { return h.ticketId === t.ticketId && (internos || h.visibilidad !== VIS.INTERNO); }).slice().sort(function (a, b) { return a.fecha < b.fecha ? -1 : 1; }),
        permisos: { editar: ed, reasignar: ed && p.reasignar, prioridad: ed && p.prioridad, pausarSla: ed && p.pausarSla, verInternos: internos }
      };
    },

    updateTicket: function (id, version, c) {
      var u = requireRole(ROLES_EDICION), ctx = context(), perm = permissions(u);
      c = c || {};
      var t = mutate(id, version, u, function (t, events, at) {
        var slaAfectado = false;
        if ('tipoCaso' in c) { requireIn(c.tipoCaso, catalogValues(ctx, 'TIPO_CASO'), 'tipo de caso'); change(t, events, u, 'tipoCaso', c.tipoCaso); }
        if ('categoria' in c) { requireIn(c.categoria, catalogValues(ctx, 'CATEGORIA'), 'categoría'); slaAfectado = change(t, events, u, 'categoria', c.categoria) || slaAfectado; }
        if ('area' in c) change(t, events, u, 'area', requireText(c.area, 'Área', 1, 100));
        if ('solicitanteNombre' in c) change(t, events, u, 'solicitanteNombre', requireText(c.solicitanteNombre, 'Nombre del solicitante', 1, 120));
        if ('prioridad' in c && c.prioridad !== t.prioridad) {
          if (!perm.prioridad) throw err('Solo un supervisor o administrador puede cambiar la prioridad.');
          requireIn(c.prioridad, PRIORIDADES, 'prioridad');
          slaAfectado = change(t, events, u, 'prioridad', c.prioridad) || slaAfectado;
        }
        if ('propiedadId' in c && c.propiedadId !== t.propiedadId) {
          if (!ctx.propMap[c.propiedadId]) throw err('Propiedad no válida.');
          if (!canSeeProperty(u, c.propiedadId)) throw err('No tiene acceso a esa propiedad.');
          change(t, events, u, 'propiedadId', c.propiedadId);
          t.propiedadMetodo = 'MANUAL:' + u.email;
          slaAfectado = true;
        }
        if ('tecnicoEmail' in c && S(c.tecnicoEmail).toLowerCase() !== S(t.tecnicoEmail).toLowerCase()) {
          var email = S(c.tecnicoEmail).toLowerCase(), tech = ctx.techMap[email];
          if (!tech || !isTrue(tech.activo)) throw err('Técnico no válido.');
          if (!perm.reasignar && email !== u.tecnicoEmail) throw err('Solo puede asignarse el ticket a sí mismo.');
          events.push(ev(t.ticketId, u.email, 'ASIGNACION', 'tecnicoEmail', t.tecnicoNombre, tech.nombre + ' <' + email + '>', '', VIS.AUDITORIA));
          t.tecnicoEmail = email; t.tecnicoNombre = tech.nombre;
        }
        if (slaAfectado && t.estado !== ESTADOS.CERRADO) {
          var antes = (t.slaPoliticaId || '—') + ' · resp. ' + fmtDateTime(t.slaRespuestaVence) + ' · resol. ' + fmtDateTime(t.slaResolucionVence);
          var sla = computeSlaFields(t, ctx, at);
          var despues = (sla.slaPoliticaId || '—') + ' · resp. ' + fmtDateTime(sla.slaRespuestaVence) + ' · resol. ' + fmtDateTime(sla.slaResolucionVence);
          if (antes !== despues) { Object.assign(t, sla); events.push(ev(t.ticketId, u.email, 'SLA_RECALCULADO', 'objetivos', antes, despues, 'Cambio de clasificación', VIS.AUDITORIA)); }
        }
      });
      save();
      return serialize(t, ctx);
    },

    changeStatus: function (id, version, nuevo, o) {
      var u = requireRole(ROLES_EDICION), ctx = context();
      o = o || {};
      requireIn(nuevo, ESTADOS_LISTA, 'estado');
      var t = mutate(id, version, u, function (t, events, at) {
        if (t.estado === nuevo) throw err('El ticket ya está en estado ' + nuevo + '.');
        var cal = calendarFor(t.slaCalendario, t.propiedadId, ctx);
        if (t.estado === ESTADOS.CERRADO) {
          var motivo = requireText(o.comentario, 'Motivo de reapertura', 5, 5000);
          reopen(t, at, ctx);
          t.estado = nuevo;
          refreshSla(t, ctx, at);
          events.push(ev(t.ticketId, u.email, 'REAPERTURA', 'estado', ESTADOS.CERRADO, nuevo, motivo, VIS.AUDITORIA));
          return;
        }
        if (nuevo === ESTADOS.CERRADO) {
          var notas = requireText(o.notasCierre, 'Notas de cierre', 5, 5000);
          if (toDate(t.slaPausadoDesde)) {
            t.slaMinutosPausa = Math.round((+t.slaMinutosPausa || 0) + serviceMinutesBetween(t.slaPausadoDesde, at, cal));
            t.slaPausadoDesde = '';
            t.slaResolucionVence = iso(addServiceMinutes(t.fechaSolicitud, +t.slaResolucionObjetivoMin + t.slaMinutosPausa, cal));
            events.push(ev(t.ticketId, u.email, 'SLA_REANUDADO', '', '', '', 'Reanudado automáticamente al cerrar.', VIS.AUDITORIA));
          }
          events.push(ev(t.ticketId, u.email, 'ESTADO', 'estado', t.estado, ESTADOS.CERRADO, 'Cierre: ' + notas, VIS.AUDITORIA));
          t.estado = ESTADOS.CERRADO; t.fechaCierre = at.toISOString(); t.notasCierre = notas;
          if (!t.fechaPrimeraRespuesta) t.fechaPrimeraRespuesta = at.toISOString();
          refreshSla(t, ctx, at);
          if (o.notificar !== false) events.push(ev(t.ticketId, u.email, 'NOTIFICACION_CIERRE', '', '', '', 'Aviso de cierre al solicitante [simulado en la demo: no se envía correo]', VIS.PUBLICO));
          return;
        }
        events.push(ev(t.ticketId, u.email, 'ESTADO', 'estado', t.estado, nuevo, S(o.comentario), VIS.AUDITORIA));
        t.estado = nuevo;
        if (nuevo === ESTADOS.EN_PROCESO && !t.tecnicoEmail && ctx.techMap[u.tecnicoEmail]) { t.tecnicoEmail = u.tecnicoEmail; t.tecnicoNombre = ctx.techMap[u.tecnicoEmail].nombre; }
      });
      save();
      return serialize(t, ctx);
    },

    replyToRequester: function (id, version, texto, pasar) {
      var u = requireRole(ROLES_EDICION), ctx = context(), body = requireText(texto, 'Respuesta', 2, 5000);
      var t = mutate(id, version, u, function (t, events, at) {
        if (t.estado === ESTADOS.CERRADO) throw err('Reabra el ticket antes de responder.');
        events.push(ev(t.ticketId, u.email, 'RESPUESTA_ENVIADA', '', '', '', body + '\n\n[Simulado en la demo: no se envía correo a ' + t.solicitanteEmail + ']', VIS.PUBLICO));
        if (!t.fechaPrimeraRespuesta) { t.fechaPrimeraRespuesta = at.toISOString(); events.push(ev(t.ticketId, u.email, 'PRIMERA_RESPUESTA', 'fechaPrimeraRespuesta', '', at, 'Respuesta escrita al solicitante', VIS.AUDITORIA)); }
        if (pasar !== false && t.estado === ESTADOS.PENDIENTE) { events.push(ev(t.ticketId, u.email, 'ESTADO', 'estado', t.estado, ESTADOS.EN_PROCESO, '', VIS.AUDITORIA)); t.estado = ESTADOS.EN_PROCESO; }
        refreshSla(t, ctx, at);
      });
      save();
      return serialize(t, ctx);
    },

    registerContact: function (id, version, medio, nota) {
      var u = requireRole(ROLES_EDICION), ctx = context(), m = requireText(medio, 'Medio de contacto', 2, 40), n = requireText(nota, 'Nota', 0, 5000);
      var t = mutate(id, version, u, function (t, events, at) {
        if (t.fechaPrimeraRespuesta) throw err('El ticket ya tiene primera respuesta registrada.');
        t.fechaPrimeraRespuesta = at.toISOString();
        events.push(ev(t.ticketId, u.email, 'PRIMERA_RESPUESTA', 'fechaPrimeraRespuesta', '', at, 'Contacto por ' + m + (n ? ': ' + n : ''), VIS.INTERNO));
        if (t.estado === ESTADOS.PENDIENTE) { events.push(ev(t.ticketId, u.email, 'ESTADO', 'estado', t.estado, ESTADOS.EN_PROCESO, '', VIS.AUDITORIA)); t.estado = ESTADOS.EN_PROCESO; }
        refreshSla(t, ctx, at);
      });
      save();
      return serialize(t, ctx);
    },

    addInternalNote: function (id, texto) {
      var u = requireRole(ROLES_EDICION), body = requireText(texto, 'Nota', 2, 5000);
      var t = mutate(id, null, u, function (t, events) { events.push(ev(t.ticketId, u.email, 'NOTA_INTERNA', '', '', '', body, VIS.INTERNO)); }, true);
      save();
      return serialize(t, context());
    },

    pauseSla: function (id, version, motivo) {
      var u = requireRole(ROLES_GESTION), ctx = context(), m = requireText(motivo, 'Motivo de la pausa', 5, 500);
      var t = mutate(id, version, u, function (t, events, at) {
        if (t.estado === ESTADOS.CERRADO) throw err('No se puede pausar un ticket cerrado.');
        if (t.slaPausadoDesde) throw err('El SLA ya está pausado.');
        if (!t.slaResolucionVence) throw err('El ticket no tiene SLA.');
        t.slaPausadoDesde = at.toISOString(); t.slaEstado = SLA.PAUSADO;
        events.push(ev(t.ticketId, u.email, 'SLA_PAUSA', 'slaPausadoDesde', '', at, m, VIS.AUDITORIA));
      });
      save();
      return serialize(t, ctx);
    },

    resumeSla: function (id, version) {
      var u = requireRole(ROLES_GESTION), ctx = context();
      var t = mutate(id, version, u, function (t, events, at) {
        if (!t.slaPausadoDesde) throw err('El SLA no está pausado.');
        var cal = calendarFor(t.slaCalendario, t.propiedadId, ctx), extra = serviceMinutesBetween(t.slaPausadoDesde, at, cal), ant = t.slaResolucionVence;
        t.slaMinutosPausa = Math.round((+t.slaMinutosPausa || 0) + extra); t.slaPausadoDesde = '';
        t.slaResolucionVence = iso(addServiceMinutes(t.fechaSolicitud, +t.slaResolucionObjetivoMin + t.slaMinutosPausa, cal));
        events.push(ev(t.ticketId, u.email, 'SLA_REANUDADO', 'slaResolucionVence', fmtDateTime(ant), fmtDateTime(t.slaResolucionVence), 'Pausa de ' + Math.round(extra) + ' min de servicio', VIS.AUDITORIA));
        refreshSla(t, ctx, at);
      });
      save();
      return serialize(t, ctx);
    },

    createManualTicket: function (d) {
      var u = requireRole(ROLES_EDICION), ctx = context();
      d = d || {};
      var email = S(d.solicitanteEmail).trim().toLowerCase();
      if (!isValidEmail(email)) throw err('Correo del solicitante no válido.');
      var ov = {};
      if (d.propiedadId) { if (!ctx.propMap[d.propiedadId] || !canSeeProperty(u, d.propiedadId)) throw err('Propiedad no válida.'); ov.propiedadId = d.propiedadId; }
      if (d.prioridad) { requireIn(d.prioridad, PRIORIDADES, 'prioridad'); ov.prioridad = d.prioridad; }
      if (d.categoria) { requireIn(d.categoria, catalogValues(ctx, 'CATEGORIA'), 'categoría'); ov.categoria = d.categoria; }
      if (d.area) ov.area = requireText(d.area, 'Área', 1, 100);
      if (ctx.techMap[u.tecnicoEmail]) ov.tecnicoEmail = u.tecnicoEmail;
      var r = processIncoming({ plataforma: PLAT.MANUAL, buzon: 'manual:' + u.email, mensajeId: uuid(), remitenteEmail: email, remitenteNombre: requireText(d.solicitanteNombre, 'Nombre del solicitante', 2, 120), asunto: requireText(d.asunto, 'Asunto', 3, 300), cuerpo: requireText(d.detalle, 'Detalle', 3, 20000), fechaRecepcion: now() }, { overrides: ov, creadoPor: u.email, sinConfirmacion: d.enviarConfirmacion !== true });
      if (r.resultado !== RES.CREADO) throw err('No se pudo crear el ticket: ' + (r.detalle || r.resultado));
      save();
      return { ticketId: r.ticketId };
    },

    getReport: function (f) {
      var u = currentUser(), ctx = context(), at = now();
      f = f || {};
      var ymd = function (v) { return /^\d{4}-\d{2}-\d{2}$/.test(S(v)) ? S(v) : ''; };
      f = { desde: ymd(f.desde), hasta: ymd(f.hasta), propiedadId: S(f.propiedadId || '*') };
      var r = buildReport(visibleTickets(u, f.propiedadId, ctx, at), f, at, ctx);
      clean();
      return r;
    },

    /** En la demo, "exportar" descarga un CSV con los tickets del filtro. */
    exportReport: function (f) {
      var u = requireRole(ROLES_GESTION), ctx = context(), at = now();
      f = f || {};
      var d = /^\d{4}-\d{2}-\d{2}$/.test(S(f.desde)) ? localToDate(f.desde, 0, TZ) : null;
      var h = /^\d{4}-\d{2}-\d{2}$/.test(S(f.hasta)) ? localToDate(nextYmd(f.hasta), 0, TZ) : null;
      var rows = visibleTickets(u, f.propiedadId, ctx, at).filter(function (t) { var x = toDate(t.fechaSolicitud); return (!d || x >= d) && (!h || x < h); });
      var cols = ['ticketId', 'asunto', 'tipoCaso', 'categoria', 'solicitanteNombre', 'solicitanteEmail', 'area', 'propiedadId', 'plataformaOrigen', 'tecnicoNombre', 'estado', 'prioridad', 'fechaSolicitud', 'fechaPrimeraRespuesta', 'fechaCierre', 'slaRespuestaVence', 'slaResolucionVence'];
      var q = function (v) { v = S(v); if (/^[=+\-@]/.test(v)) v = "'" + v; return '"' + v.replace(/"/g, '""') + '"'; };
      var csv = '﻿' + cols.concat(['estadoSLA']).join(';') + '\n' + rows.map(function (t) { return cols.map(function (c) { return q(t[c]); }).concat([q(t._sla.estado)]).join(';'); }).join('\n');
      clean();
      return { csv: csv, nombre: 'tickets-' + tzParts(at, TZ).ymd + '.csv', hoja: rows.length + ' tickets' };
    },

    getConnectorsPanel: function () {
      requireRole(ROLES_GESTION);
      return JSON.parse(JSON.stringify({
        conectores: DB.connectors,
        errores: DB.log.filter(function (r) { return r.nivel !== 'INFO'; }).slice(-25).reverse(),
        revision: DB.revision.filter(function (r) { return r.estado === 'PENDIENTE'; }).slice().reverse(),
        alertas: DB.alerts.slice(-30).reverse(),
        bandeja: { GOOGLE: DB.inbox.GOOGLE.length, M365: DB.inbox.M365.length },
        habilitados: { GOOGLE: true, M365: true }
      }));
    },

    /** Simula una consulta del buzón: procesa los correos pendientes de la bandeja de ejemplo. */
    runConnectorNow: function (plataforma) {
      requireRole(['ADMIN']);
      if (!DB.inbox[plataforma]) throw err('Plataforma no válida.');
      var r = runConnector(plataforma);
      monitorSla();
      save();
      return r;
    },

    testGraphConnection: function () {
      requireRole(['ADMIN']);
      var c = DB.connectors.filter(function (x) { return x.plataforma === PLAT.M365; })[0];
      c.estadoConexion = 'CONEXIÓN VERIFICADA'; c.ultimoError = ''; c.ultimaEjecucion = now().toISOString();
      logAuto('graph', 'INFO', 'Prueba de conexión simulada (demo)');
      save();
      return { buzon: BUZON_M, token: true, carpeta: { nombre: 'Bandeja de entrada (simulada)', total: DB.inbox.M365.length }, error: null };
    },

    resolveReviewItem: function (rid, nota) {
      var u = requireRole(ROLES_GESTION), n = requireText(nota, 'Nota de resolución', 3, 1000);
      var r = DB.revision.filter(function (x) { return x.revisionId === rid; })[0];
      if (!r) throw err('Elemento de revisión no encontrado.');
      r.estado = 'RESUELTO'; r.resueltoPor = u.email; r.fechaResolucion = now().toISOString(); r.notaResolucion = n;
      if (r.ticketId) addHistory([ev(r.ticketId, u.email, 'REVISION_RESUELTA', '', r.tipo, '', n, VIS.INTERNO)]);
      save();
      return true;
    },

    /* --- Exclusivas de la demo --- */
    simulateIncoming: function (d) {
      requireRole(ROLES_EDICION);
      d = d || {};
      var plat = d.plataforma === PLAT.M365 ? PLAT.M365 : PLAT.GOOGLE;
      var email = S(d.remitenteEmail).trim().toLowerCase();
      if (!isValidEmail(email)) throw err('Correo del remitente no válido.');
      var base = { remitenteEmail: email, remitenteNombre: requireText(d.remitenteNombre, 'Nombre', 1, 120), asunto: requireText(d.asunto, 'Asunto', 1, 300), cuerpo: requireText(d.cuerpo, 'Cuerpo', 1, 20000), fechaRecepcion: now().toISOString(), internetMessageId: uuid() + '@demo.mail' };
      var targets = d.ambosBuzones ? [PLAT.GOOGLE, PLAT.M365] : [plat];
      targets.forEach(function (p) { DB.inbox[p].push(Object.assign({}, base, { id: uuid() })); });
      var out = targets.map(function (p) { return Object.assign({ plataforma: p }, runConnector(p)); });
      monitorSla();
      save();
      return out;
    },
    setDemoUser: function (email) {
      if (!DB.users.some(function (u) { return u.email === email; })) throw err('Usuario no válido.');
      try { localStorage.setItem(USER_KEY, email); } catch (e) { /* sin almacenamiento */ }
      return true;
    },
    resetDemo: function () {
      try { localStorage.removeItem(STORE_KEY); localStorage.removeItem(USER_KEY); } catch (e) { /* sin almacenamiento */ }
      DB = seed(); save();
      return true;
    }
  };

  /** Consulta simulada de un buzón: normaliza y entrega cada mensaje al motor. */
  function runConnector(plataforma) {
    var c = DB.connectors.filter(function (x) { return x.plataforma === plataforma; })[0];
    var st = { consultados: 0, creados: 0, actualizados: 0, duplicados: 0, ignorados: 0, errores: 0 };
    var queue = DB.inbox[plataforma].splice(0);
    queue.forEach(function (raw) {
      st.consultados++;
      var r = processIncoming({
        plataforma: plataforma, buzon: plataforma === PLAT.GOOGLE ? BUZON_G : BUZON_M, mensajeId: raw.id,
        internetMessageId: cleanMessageId(raw.internetMessageId), hiloId: raw.hiloId || '', inReplyTo: raw.inReplyTo || '',
        remitenteEmail: raw.remitenteEmail, remitenteNombre: raw.remitenteNombre, asunto: raw.asunto, cuerpo: raw.cuerpo,
        fechaRecepcion: raw.fechaRecepcion, autoSubmitted: raw.autoSubmitted || ''
      });
      ({ CREADO: function () { st.creados++; }, ACTUALIZADO: function () { st.actualizados++; }, DUPLICADO: function () { st.duplicados++; }, IGNORADO: function () { st.ignorados++; }, INVALIDO: function () { st.ignorados++; } }[r.resultado] || function () { st.errores++; })();
      if (r.resultado === RES.INVALIDO) logAuto('conector:' + plataforma, 'WARN', 'Mensaje descartado por validación', r.detalle);
    });
    var at = now().toISOString();
    Object.assign(c, { estadoConexion: 'OK', ultimaEjecucion: at, ultimoResultadoCorrecto: at, mensajesConsultados: st.consultados, ticketsCreados: st.creados, ticketsActualizados: st.actualizados, duplicados: st.duplicados, errores: st.errores, erroresConsecutivos: 0, totalTicketsCreados: (c.totalTicketsCreados || 0) + st.creados });
    if (queue.length) c.ultimoMensajeFecha = queue[queue.length - 1].fechaRecepcion;
    if (st.consultados) logAuto('conector:' + plataforma, 'INFO', 'Consultados ' + st.consultados + ' · creados ' + st.creados + ' · actualizados ' + st.actualizados + ' · duplicados ' + st.duplicados + ' · ignorados ' + st.ignorados);
    return st;
  }

  /* ---------------------------------------------------------------- */
  /* Datos de ejemplo                                                  */
  /* ---------------------------------------------------------------- */
  function seed() {
    DB = {
      v: 1, seq: {}, tickets: [], historial: [], index: [], revision: [], alerts: [], log: [], inbox: { GOOGLE: [], M365: [] },
      config: { TECNICO_PREDETERMINADO_EMAIL: BUZON_M, BUZONES_PROPIOS: BUZON_G + ', ' + BUZON_M, PRIORIDAD_PREDETERMINADA: 'Media', VENTANA_DUPLICADO_MIN: 10, CONFIRMACION_HABILITADA: true, ALERTAS_ADMIN_EMAILS: BUZON_M },
      props: [
        { propiedadId: 'GSSA', codigo: 'GSSA', nombre: 'Grand Sirenis San Andrés by Oxo Hotel', nombreCorto: 'Grand Sirenis San Andrés', logoUrl: 'https://b2b2c.cdnpt.com/grand-sirenis-san-andres-by-oxo-hotel/images/logo-splash.gif', zonaHoraria: TZ, horaInicio: '07:00', horaFin: '19:00', diasServicio: '1,2,3,4,5,6,7', palabrasClave: 'grand sirenis san andres, grand sirenis san andrés, gssa', dominiosRemitente: '', buzonesAsignados: '', activo: true },
        { propiedadId: 'SLV', codigo: 'SLV', nombre: 'San Luis Village', nombreCorto: 'San Luis Village', logoUrl: 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcS5OOFS3NZZUYRNSm5l9mxNGLmeDms66HtF5RGRI023nw&s=10', zonaHoraria: TZ, horaInicio: '07:00', horaFin: '19:00', diasServicio: '1,2,3,4,5,6,7', palabrasClave: 'san luis village, slv', dominiosRemitente: '', buzonesAsignados: '', activo: true },
        { propiedadId: POR_ID, codigo: 'N/D', nombre: 'Por identificar', nombreCorto: 'Por identificar', logoUrl: '', zonaHoraria: TZ, horaInicio: '07:00', horaFin: '19:00', diasServicio: '1,2,3,4,5,6,7', palabrasClave: '', activo: true }
      ],
      catalogs: [],
      policies: [
        { politicaId: 'SLA-CRITICA', prioridad: 'Crítica', categoria: '*', propiedadId: '*', respuestaMin: 15, resolucionMin: 240, calendario: 'HABIL', umbralAlertaPct: 75, activo: true },
        { politicaId: 'SLA-ALTA', prioridad: 'Alta', categoria: '*', propiedadId: '*', respuestaMin: 30, resolucionMin: 480, calendario: 'HABIL', umbralAlertaPct: 75, activo: true },
        { politicaId: 'SLA-MEDIA', prioridad: 'Media', categoria: '*', propiedadId: '*', respuestaMin: 120, resolucionMin: 1440, calendario: 'HABIL', umbralAlertaPct: 75, activo: true },
        { politicaId: 'SLA-BAJA', prioridad: 'Baja', categoria: '*', propiedadId: '*', respuestaMin: 240, resolucionMin: 2880, calendario: 'HABIL', umbralAlertaPct: 75, activo: true }
      ],
      escalation: [
        { reglaId: 'ESC-1-RESP', nivel: 1, condicion: 'VENC_RESPUESTA', minutosDespuesVencimiento: 0, prioridades: 'Crítica, Alta', propiedadId: '*', destinatarios: BUZON_M, activo: true },
        { reglaId: 'ESC-1-RESO', nivel: 1, condicion: 'VENC_RESOLUCION', minutosDespuesVencimiento: 0, prioridades: '*', propiedadId: '*', destinatarios: BUZON_M, activo: true }
      ],
      techs: [
        { email: BUZON_M, nombre: 'Sebastian Lopez', propiedades: '*', activo: true, recibeAlertas: true },
        { email: 'soporte.slv@oxohotel.com', nombre: 'Técnico San Luis Village', propiedades: 'SLV', activo: true, recibeAlertas: true }
      ],
      users: [
        { email: 'ticsirenis@oxohotel.com', nombre: 'Sebastian Lopez', rol: 'ADMIN', propiedades: '*', tecnicoEmail: BUZON_M, activo: true },
        { email: 'supervisor@oxohotel.com', nombre: 'Supervisor de TI', rol: 'SUPERVISOR', propiedades: '*', tecnicoEmail: '', activo: true },
        { email: 'soporte.slv@oxohotel.com', nombre: 'Técnico San Luis Village', rol: 'TECNICO', propiedades: 'SLV', tecnicoEmail: 'soporte.slv@oxohotel.com', activo: true },
        { email: 'gerencia@oxohotel.com', nombre: 'Gerencia (solo lectura)', rol: 'LECTOR', propiedades: '*', tecnicoEmail: '', activo: true }
      ],
      connectors: [
        { conectorId: 'GOOGLE-ticsirenis', plataforma: PLAT.GOOGLE, buzon: BUZON_G, estadoConexion: 'SIN PROBAR', totalTicketsCreados: 0, erroresConsecutivos: 0 },
        { conectorId: 'M365-sistemas', plataforma: PLAT.M365, buzon: BUZON_M, estadoConexion: 'SIN PROBAR', totalTicketsCreados: 0, erroresConsecutivos: 0 }
      ]
    };
    var cat = function (tipo, valor, palabras, orden) { DB.catalogs.push({ tipo: tipo, valor: valor, palabrasClave: palabras, orden: orden, activo: true }); };
    cat('TIPO_CASO', 'Incidente', 'no funciona, no sirve, error, falla, fallo, caido, caído, dañado, no enciende, no imprime, no conecta, no carga, lento, bloqueado, no puedo, se cayo, se cayó, no abre', 1);
    cat('TIPO_CASO', 'Solicitud de servicio', 'solicito, solicitamos, necesito, necesitamos, requiero, requerimos, crear usuario, instalar, instalacion, instalación, configurar, habilitar, acceso, permiso, cambio de clave, nuevo equipo, favor', 2);
    cat('TIPO_CASO', 'Consulta', 'consulta, pregunta, duda, como hago, cómo hago, informacion, información', 3);
    cat('TIPO_CASO', 'Por clasificar', '', 9);
    cat('CATEGORIA', 'Hardware / Equipos', 'computador, pc, portatil, portátil, laptop, monitor, pantalla, teclado, mouse, equipo, cpu, ups', 1);
    cat('CATEGORIA', 'Impresoras', 'impresora, imprimir, impresion, impresión, toner, tóner, escaner, escáner', 2);
    cat('CATEGORIA', 'Red / Internet / WiFi', 'internet, wifi, wi-fi, red, conexion, conexión, switch, router, access point, sin señal', 3);
    cat('CATEGORIA', 'Correo electrónico', 'correo, email, outlook, gmail, buzon, buzón', 4);
    cat('CATEGORIA', 'PMS / Sistemas hoteleros', 'opera, pms, sistema hotelero, check in, check-in, check out, check-out, reserva, folio, interfaz', 5);
    cat('CATEGORIA', 'Punto de venta (POS)', 'pos, punto de venta, micros, simphony, comanda, datafono, datáfono', 6);
    cat('CATEGORIA', 'Telefonía', 'telefono, teléfono, extension, extensión, planta telefonica, planta telefónica, llamadas', 7);
    cat('CATEGORIA', 'Usuarios y accesos', 'usuario, clave, contraseña, password, acceso, permiso, bloqueado, desbloquear, cuenta', 8);
    cat('CATEGORIA', 'Software / Aplicaciones', 'programa, aplicacion, aplicación, software, office, excel, word, licencia, actualizacion, actualización, windows', 9);
    cat('CATEGORIA', 'CCTV / Seguridad', 'camara, cámara, cctv, dvr, nvr, videovigilancia', 10);
    cat('CATEGORIA', 'TV / Entretenimiento', 'television, televisión, tv, iptv, chromecast, control remoto', 11);
    cat('CATEGORIA', 'Otro / Por clasificar', '', 99);
    cat('AREA', 'Recepción / Front Desk', 'recepcion, recepción, front desk, recepcionista', 1);
    cat('AREA', 'Reservas', 'reservas, reservaciones', 2);
    cat('AREA', 'Ama de llaves', 'ama de llaves, housekeeping, lavanderia, lavandería', 3);
    cat('AREA', 'Alimentos y Bebidas', 'alimentos y bebidas, restaurante, bar, cocina, chef, room service', 4);
    cat('AREA', 'Mantenimiento', 'mantenimiento, ingenieria, ingeniería', 5);
    cat('AREA', 'Contabilidad / Finanzas', 'contabilidad, contador, finanzas, tesoreria, tesorería, auditoria, auditoría, compras, almacen, almacén', 6);
    cat('AREA', 'Talento Humano', 'recursos humanos, talento humano, rrhh, nomina, nómina', 7);
    cat('AREA', 'Gerencia', 'gerencia, gerente general', 8);
    cat('AREA', 'Ventas / Mercadeo', 'ventas, mercadeo, marketing, eventos', 9);
    cat('AREA', 'Seguridad', 'seguridad, vigilancia', 10);
    cat('AREA', 'Spa / Recreación', 'spa, animacion, animación, recreacion, recreación', 11);
    cat('AREA', 'Por identificar', '', 99);
    cat('PRIORIDAD_REGLA', 'Crítica', 'sistema caido, sistema caído, opera caido, opera caído, pms caido, pms caído, todo el hotel, toda la propiedad, no hay sistema, servidor caido, servidor caído, emergencia', 1);
    cat('PRIORIDAD_REGLA', 'Alta', 'urgente, urgencia, prioridad alta, huesped, huésped, vip, no puedo trabajar, check in, check-in', 2);
    cat('PRIORIDAD_REGLA', 'Baja', 'cuando puedan, cuando tengan tiempo, sugerencia, no es urgente, a futuro', 4);

    // Sistema desde cero: sin tickets, historial, alertas ni correos pendientes.
    CLOCK = null;
    return DB;
  }

  /* ---------------------------------------------------------------- */
  /* Arranque y puente google.script.run                               */
  /* ---------------------------------------------------------------- */
  load();
  monitorSla();
  save();
  setInterval(function () { monitorSla(); save(); }, 60000);

  window.__BOOT__ = API.getBootstrap();
  window.__DEMO__ = API;
  function runner() {
    var ok = function () {}, fail = function (e) { console.error(e); };
    var r = {
      withSuccessHandler: function (fn) { ok = fn; return p; },
      withFailureHandler: function (fn) { fail = fn; return p; }
    };
    var p = new Proxy(r, {
      get: function (t, name) {
        if (name in t) return t[name];
        if (!API[name]) return undefined;
        return function () {
          var args = arguments;
          setTimeout(function () {
            var out;
            try { out = API[name].apply(null, args); }
            catch (e) { fail(e instanceof Error ? e : new Error(String(e))); return; }
            ok(out);
          }, 60);
        };
      }
    });
    return p;
  }
  window.google = { script: { get run() { return runner(); } } };
})();
