'use strict';
/**
 * Robots de MI empresa.
 * GET  /api/robots               lista (cualquier usuario de la empresa)
 * POST /api/robots {nombre}      registra un robot y devuelve su clave UNA sola vez (admin)
 * POST /api/robots {borrar: id}  elimina un robot y sus datos (admin)
 */
const A = require('../backend/auth');
const H = require('../backend/http');
const C = require('../backend/control');
const db = require('../backend/db');

module.exports = H.endpoint(async (req, res) => {
  if (req.method === 'GET') {
    const u = await A.exigir(req, res);
    if (!u) return;
    const robots = await db.q(`select id, nombre, coalesce((ultima->>'ts')::float8, 0) as visto
                                 from robots where empresa_id = $1 order by id`, [u.empresaId]);
    return H.send(res, 200, { ok: true, robots });
  }
  if (req.method !== 'POST') return H.fail(res, 405, 'Método no permitido');
  if (!H.solicitudSegura(req)) return H.fail(res, 403, 'Solicitud no permitida');
  const admin = await A.exigir(req, res, { admin: true });
  if (!admin) return;
  const b = await H.readBody(req);

  if (b.borrar !== undefined) {
    const r = await db.uno('delete from robots where id = $1 and empresa_id = $2 returning nombre', [Number(b.borrar) || 0, admin.empresaId]);
    if (!r) return H.fail(res, 404, 'Robot no encontrado en tu empresa');
    await A.auditar(admin.empresaId, admin.email, 'robot eliminado', r.nombre);
    return H.send(res, 200, { ok: true });
  }
  const nombre = A.limpiar(b.nombre, 60);
  if (nombre.length < 2) return H.fail(res, 400, 'Escribe un nombre para el robot');
  const r = await C.crear(admin.empresaId, nombre);
  await A.auditar(admin.empresaId, admin.email, 'robot registrado', nombre);
  return H.send(res, 201, { ok: true, robot: r });
});
