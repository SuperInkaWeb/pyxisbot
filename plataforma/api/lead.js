'use strict';
/**
 * Formulario "Solicitar demo" de la landing.
 * POST /api/lead {name, email, company, sector, message, website}   (público; "website" es una trampa para bots)
 * GET  /api/lead                                                    (SUPERADMIN_EMAILS: el equipo Pyxis-Bot) últimas solicitudes
 */
const H = require('../backend/http');
const A = require('../backend/auth');
const db = require('../backend/db');

const SECTORES = ['mineria', 'tuneles', 'petroleo-gas', 'industria', 'rescate', 'agroindustria', 'otro'];

module.exports = H.endpoint(async (req, res) => {
  if (req.method === 'GET') {
    const u = await A.exigir(req, res, { superadmin: true });
    if (!u) return;
    const leads = (await db.q('select d from leads order by t desc limit 100')).map((x) => x.d);
    return H.send(res, 200, { ok: true, leads });
  }
  if (req.method !== 'POST') return H.fail(res, 405, 'Método no permitido');
  if (!H.solicitudSegura(req)) return H.fail(res, 403, 'Solicitud no permitida');

  const b = await H.readBody(req);
  if (b.website) return H.send(res, 200, { ok: true });          // un bot llenó el campo oculto: se finge éxito

  const name = A.limpiar(b.name, 60);
  const email = A.normalizarEmail(b.email);
  const company = A.limpiar(b.company, 80);
  const message = A.limpiar(b.message, 1000);
  const sector = SECTORES.includes(b.sector) ? b.sector : 'otro';
  if (name.length < 2) return H.fail(res, 400, 'Escribe tu nombre');
  if (!A.emailValido(email)) return H.fail(res, 400, 'Escribe un correo válido');
  if (b.consent !== true) return H.fail(res, 400, 'Debes autorizar el tratamiento de tus datos para poder contactarte');

  const ip = H.ip(req);
  const { n } = await db.uno(`select count(*)::int n from leads where ip = $1 and t > now() - interval '1 hour'`, [ip]);
  if (n >= 5) return H.fail(res, 429, 'Ya recibimos varias solicitudes desde tu red. Inténtalo más tarde', { retryAfter: 3600 });
  await db.q('insert into leads (ip, d) values ($1, $2)', [ip, JSON.stringify({ t: Date.now(), name, email, company, sector, message })]);
  return H.send(res, 201, { ok: true });
});
