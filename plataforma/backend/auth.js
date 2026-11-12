'use strict';
/**
 * Sesión con Auth0 + permisos por empresa.
 *
 *  - Auth0 (Universal Login) verifica la identidad. Aquí NO se guardan contraseñas.
 *  - Tras volver de Auth0 se crea una cookie HttpOnly firmada (AUTH_SECRET) con el "sub" del usuario.
 *  - Cada petición relee al usuario en Neon: si lo bloquean o le cambian el rol, se aplica de inmediato.
 *  - Cada usuario pertenece a UNA empresa y solo ve sus robots, usuarios y datos.
 *  - Roles: admin (todo en su empresa) · operator (ve y controla) · observer (solo ve) · blocked.
 */
const crypto = require('crypto');
const H = require('./http');
const db = require('./db');

const ROLES = ['admin', 'operator', 'observer', 'blocked'];
const COOKIE = 'rm_session';
const DURACION_S = 12 * 3600;    // un turno

const D = (process.env.AUTH0_DOMAIN || '').replace(/\/$/, '');
const AUTH0 = D && !/^https?:\/\//.test(D) ? 'https://' + D : D;
const CLIENT_ID = process.env.AUTH0_CLIENT_ID || '';
const CLIENT_SECRET = process.env.AUTH0_CLIENT_SECRET || '';
const auth0Listo = () => Boolean(AUTH0 && CLIENT_ID && CLIENT_SECRET);
const SUPER = (process.env.SUPERADMIN_EMAILS || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);

const normalizarEmail = (e) => String(e || '').trim().toLowerCase();
const emailValido = (e) => e.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
const limpiar = (s, max) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);
const puedeControlar = (rol) => rol === 'admin' || rol === 'operator';

// ---------- Cookie de sesión firmada ----------
const secreto = () => process.env.AUTH_SECRET || (H.EN_VERCEL ? '' : 'secreto-solo-para-desarrollo-local');
const secretoListo = () => Boolean(secreto());
const hmac = (s) => crypto.createHmac('sha256', secreto()).update(s).digest('base64url');

function firmar(payload) {
  const cuerpo = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return cuerpo + '.' + hmac(cuerpo);
}
function leerToken(token) {
  if (!token || !secretoListo()) return null;
  const [cuerpo, firma] = String(token).split('.');
  if (!cuerpo || !firma || !H.iguales(firma, hmac(cuerpo))) return null;
  try {
    const p = JSON.parse(Buffer.from(cuerpo, 'base64url').toString('utf8'));
    return p && p.exp > Date.now() / 1000 ? p : null;
  } catch { return null; }
}
const cookie = (req, nombre, valor, maxAge) =>
  `${nombre}=${valor}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${H.esHttps(req) ? '; Secure' : ''}`;
const cookieSesion = (req, sub) => cookie(req, COOKIE, firmar({ sub, exp: Math.floor(Date.now() / 1000) + DURACION_S }), DURACION_S);
const cookieBorrar = (req) => cookie(req, COOKIE, '', 0);

// ---------- Usuario actual ----------
async function usuarioActual(req) {
  const p = leerToken(H.cookies(req)[COOKIE]);
  if (!p) return null;
  let u = await db.uno(
    `select u.sub, u.email, u.nombre, u.verificado, u.rol, u.empresa_id, e.nombre empresa
       from usuarios u left join empresas e on e.id = u.empresa_id where u.sub = $1`, [p.sub]);
  if (!u || u.rol === 'blocked') return null;
  if (u.empresa_id == null && u.verificado && u.email) {          // ¿lo invitaron a una empresa?
    const inv = await db.uno('delete from invitaciones where email = $1 returning empresa_id, rol', [u.email]);
    if (inv) {
      await db.q('update usuarios set empresa_id = $2, rol = $3 where sub = $1', [u.sub, inv.empresa_id, inv.rol]);
      await auditar(inv.empresa_id, u.email, 'se unió por invitación', inv.rol);
      return usuarioActual(req);
    }
  }
  return {
    sub: u.sub, email: u.email, name: u.nombre || u.email, role: u.rol,
    empresaId: u.empresa_id, empresa: u.empresa || null,
    canControl: u.empresa_id != null && puedeControlar(u.rol),
    superadmin: Boolean(u.verificado && SUPER.includes(u.email)),
  };
}

/** Exige sesión con empresa (y opcionalmente un permiso). Si falla ya respondió y devuelve null. */
async function exigir(req, res, { control = false, admin = false, superadmin = false } = {}) {
  const u = await usuarioActual(req);
  if (!u) { H.fail(res, 401, 'Inicia sesión para continuar'); return null; }
  if (superadmin) { if (!u.superadmin) { H.fail(res, 403, 'No autorizado'); return null; } return u; }
  if (u.empresaId == null) { H.fail(res, 409, 'Primero registra tu empresa', { code: 'SIN_EMPRESA' }); return null; }
  if (admin && u.role !== 'admin') { H.fail(res, 403, 'Solo el administrador de la empresa puede hacer esto'); return null; }
  if (control && !u.canControl) { H.fail(res, 403, 'Tu rol es observador: solo lectura. Pide al administrador el rol de operador'); return null; }
  return u;
}

const auditar = (empresaId, quien, accion, detalle) =>
  db.q('insert into auditoria (empresa_id, quien, accion, detalle) values ($1, $2, $3, $4)', [empresaId, quien, accion, detalle || '']);

module.exports = {
  ROLES, AUTH0, CLIENT_ID, CLIENT_SECRET, auth0Listo, normalizarEmail, emailValido, limpiar, puedeControlar,
  secretoListo, cookie, cookieSesion, cookieBorrar, usuarioActual, exigir, auditar,
};
