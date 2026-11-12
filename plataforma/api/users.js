'use strict';
/**
 * Usuarios de MI empresa (solo su administrador).
 * GET  /api/users                       usuarios, invitaciones pendientes y bitácora de la empresa
 * POST /api/users {sub, role}           cambia el rol (admin | operator | observer | blocked)
 * POST /api/users {invitar, role}       invita un correo y le envía la invitación por Gmail: al entrar con Auth0
 *                                       (correo verificado) queda en la empresa. Repetirla reenvía el correo.
 * POST /api/users {cancelar}            borra una invitación pendiente
 */
const A = require('../backend/auth');
const H = require('../backend/http');
const db = require('../backend/db');
const correo = require('../backend/correo');

module.exports = H.endpoint(async (req, res) => {
  const admin = await A.exigir(req, res, { admin: true });
  if (!admin) return;
  const emp = admin.empresaId;

  if (req.method === 'GET') {
    const [users, invitaciones, audit] = await Promise.all([
      db.q(`select sub, email, nombre as name, rol as role, (extract(epoch from ultimo_acceso) * 1000)::float8 as "lastLogin"
              from usuarios where empresa_id = $1 order by creado`, [emp]),
      db.q('select email, rol as role from invitaciones where empresa_id = $1 order by email', [emp]),
      db.q(`select (extract(epoch from t) * 1000)::float8 as t, quien, accion, detalle
              from auditoria where empresa_id = $1 order by t desc limit 50`, [emp]),
    ]);
    return H.send(res, 200, { ok: true, users, invitaciones, audit });
  }

  if (req.method !== 'POST') return H.fail(res, 405, 'Método no permitido');
  if (!H.solicitudSegura(req)) return H.fail(res, 403, 'Solicitud no permitida');
  const b = await H.readBody(req);

  if (b.cancelar !== undefined) {
    await db.q('delete from invitaciones where email = $1 and empresa_id = $2', [A.normalizarEmail(b.cancelar), emp]);
    return H.send(res, 200, { ok: true });
  }
  if (!A.ROLES.includes(b.role)) return H.fail(res, 400, 'Rol no válido');

  if (b.invitar !== undefined) {
    const email = A.normalizarEmail(b.invitar);
    if (!A.emailValido(email)) return H.fail(res, 400, 'Escribe un correo válido');
    const ya = await db.uno('select empresa_id from usuarios where email = $1 and empresa_id is not null', [email]);
    if (ya) return H.fail(res, 409, 'Ese correo ya pertenece a una empresa');
    await db.q(`insert into invitaciones (email, empresa_id, rol) values ($1, $2, $3)
                on conflict (email) do update set empresa_id = $2, rol = $3`, [email, emp, b.role]);
    await A.auditar(emp, admin.email, 'invitación', `${email} como ${b.role}`);
    const enviado = await correo.enviarInvitacion({
      para: email, empresa: admin.empresa, invitadoPor: admin.name, rol: b.role, url: H.baseUrl(req) + '/login',
    });
    return H.send(res, 201, { ok: true, correo: enviado });
  }

  const u = await db.uno('select email, rol from usuarios where sub = $1 and empresa_id = $2', [String(b.sub || ''), emp]);
  if (!u) return H.fail(res, 404, 'Usuario no encontrado en tu empresa');
  if (u.rol === 'admin' && b.role !== 'admin') {
    const { n } = await db.uno(`select count(*)::int n from usuarios where empresa_id = $1 and rol = 'admin'`, [emp]);
    if (n <= 1) return H.fail(res, 409, 'Debe quedar al menos un administrador');
  }
  await db.q('update usuarios set rol = $3 where sub = $1 and empresa_id = $2', [b.sub, emp, b.role]);
  await A.auditar(emp, admin.email, 'cambio de rol', `${u.email}: ${u.rol} → ${b.role}`);
  return H.send(res, 200, { ok: true });
});
