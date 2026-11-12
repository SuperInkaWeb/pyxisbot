'use strict';
/**
 * GET  /api/auth?login[&signup]        → redirige a Auth0 (iniciar sesión o crear cuenta)
 * GET  /api/auth?code=..&state=..      ← Auth0 vuelve aquí (Callback URL en Auth0: https://TU-DOMINIO/api/auth)
 * GET  /api/auth                       usuario de la sesión actual
 * POST /api/auth {action:'empresa', nombre}   el usuario sin empresa registra la suya y queda como admin
 * POST /api/auth {action:'logout'}     → {logoutUrl} para cerrar también la sesión de Auth0
 */
const A = require('../backend/auth');
const H = require('../backend/http');
const db = require('../backend/db');

const base = H.baseUrl;
const alLogin = (res, msg, extra) => H.redirigir(res, '/login?error=' + encodeURIComponent(msg), extra);

function iniciar(req, res, q) {
  if (!A.auth0Listo()) return alLogin(res, 'Auth0 no está configurado (AUTH0_DOMAIN, AUTH0_CLIENT_ID, AUTH0_CLIENT_SECRET)');
  const state = require('crypto').randomBytes(16).toString('hex');
  const p = new URLSearchParams({
    response_type: 'code', client_id: A.CLIENT_ID, redirect_uri: base(req) + '/api/auth',
    scope: 'openid profile email', state,
  });
  if (q.signup !== undefined) p.set('screen_hint', 'signup');
  return H.redirigir(res, `${A.AUTH0}/authorize?${p}`, { 'Set-Cookie': A.cookie(req, 'rm_state', state, 600) });
}

async function volver(req, res, q) {
  const borrarState = A.cookie(req, 'rm_state', '', 0);
  if (q.error) return alLogin(res, q.error_description || q.error, { 'Set-Cookie': borrarState });
  const st = H.cookies(req).rm_state;
  if (!st || !q.state || !H.iguales(st, q.state)) return alLogin(res, 'La sesión de inicio expiró. Inténtalo de nuevo', { 'Set-Cookie': borrarState });

  // Cambiar el código por el id_token. Llega directo de Auth0 por HTTPS con nuestro client_secret,
  // por eso basta validar emisor, audiencia y vencimiento (OpenID Connect Core §3.1.3.7).
  const r = await fetch(A.AUTH0 + '/oauth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'authorization_code', client_id: A.CLIENT_ID, client_secret: A.CLIENT_SECRET, code: q.code, redirect_uri: base(req) + '/api/auth' }),
  });
  const tok = await r.json().catch(() => ({}));
  let p = null;
  try { p = JSON.parse(Buffer.from(String(tok.id_token).split('.')[1], 'base64url').toString('utf8')); } catch { /* inválido */ }
  const aud = p && (Array.isArray(p.aud) ? p.aud : [p.aud]);
  if (!r.ok || !p || p.iss !== A.AUTH0 + '/' || !aud.includes(A.CLIENT_ID) || !(p.exp > Date.now() / 1000) || !p.sub) {
    return alLogin(res, 'No se pudo validar el inicio de sesión con Auth0', { 'Set-Cookie': borrarState });
  }

  const email = A.normalizarEmail(p.email);
  const nombre = A.limpiar(p.name || p.nickname || email, 60);
  const u = await db.uno(
    `insert into usuarios (sub, email, nombre, verificado) values ($1, $2, $3, $4)
     on conflict (sub) do update set email = $2, nombre = $3, verificado = $4, ultimo_acceso = now()
     returning rol, empresa_id`, [p.sub, email, nombre, p.email_verified === true]);
  if (u.rol === 'blocked') return alLogin(res, 'Tu cuenta está bloqueada. Contacta al administrador de tu empresa', { 'Set-Cookie': borrarState });
  return H.redirigir(res, '/dashboard', { 'Set-Cookie': [A.cookieSesion(req, p.sub), borrarState] });
}

async function crearEmpresa(req, res, b) {
  const u = await A.usuarioActual(req);
  if (!u) return H.fail(res, 401, 'Inicia sesión para continuar');
  if (u.empresaId != null) return H.fail(res, 409, 'Ya perteneces a una empresa');
  const nombre = A.limpiar(b.nombre, 80);
  if (nombre.length < 2) return H.fail(res, 400, 'Escribe el nombre de la empresa');
  const e = await db.uno('insert into empresas (nombre) values ($1) returning id', [nombre]);
  await db.q(`update usuarios set empresa_id = $2, rol = 'admin' where sub = $1`, [u.sub, e.id]);
  await A.auditar(e.id, u.email, 'empresa creada', nombre);
  return H.send(res, 201, { ok: true, empresa: nombre });
}

module.exports = H.endpoint(async (req, res) => {
  if (!A.secretoListo()) return H.fail(res, 503, 'El servidor no tiene configurada la variable AUTH_SECRET');
  if (req.method === 'GET') {
    const q = H.consulta(req);
    if (q.login !== undefined) return iniciar(req, res, q);
    if (q.code || q.error) return volver(req, res, q);
    const u = await A.usuarioActual(req);
    if (!u) return H.fail(res, 401, 'No hay sesión');
    return H.send(res, 200, { ok: true, user: u, canControl: u.canControl });
  }
  if (req.method !== 'POST') return H.fail(res, 405, 'Método no permitido');
  if (!H.solicitudSegura(req)) return H.fail(res, 403, 'Solicitud no permitida');
  const b = await H.readBody(req);
  if (b.action === 'empresa') return crearEmpresa(req, res, b);
  if (b.action === 'logout') {
    const logoutUrl = A.auth0Listo()
      ? `${A.AUTH0}/v2/logout?${new URLSearchParams({ client_id: A.CLIENT_ID, returnTo: base(req) + '/login' })}`
      : '/login';
    return H.send(res, 200, { ok: true, logoutUrl }, { 'Set-Cookie': A.cookieBorrar(req) });
  }
  return H.fail(res, 400, 'Acción desconocida');
});
