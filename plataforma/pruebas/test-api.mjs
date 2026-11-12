// Pruebas del backend con Postgres local (en lugar de Neon) y un Auth0 simulado.
//   PGURL=postgres://usuario:clave@127.0.0.1/base_vacia node pruebas/test-api.mjs
// ¡Borra y recrea las tablas de esa base! Usa una base de pruebas.
import http from 'node:http';
import { pgLocal } from './pg-local.mjs';

// ---- Auth0 simulado: el "code" es el perfil del usuario en base64url ----
const auth0 = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    const j = JSON.parse(b || '{}');
    if (req.url !== '/oauth/token' || j.client_secret !== 'secreto-cliente') { res.statusCode = 403; return res.end('{}'); }
    const perfil = JSON.parse(Buffer.from(j.code, 'base64url').toString());
    const p = Object.assign({ iss: AUTH0 + '/', aud: 'cliente-123', exp: Date.now() / 1000 + 600 }, perfil);
    const id_token = ['e30', Buffer.from(JSON.stringify(p)).toString('base64url'), 'firma'].join('.');
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ id_token }));
  });
});
await new Promise((r) => auth0.listen(0, r));
const AUTH0 = `http://localhost:${auth0.address().port}`;
Object.assign(process.env, { AUTH0_DOMAIN: AUTH0, AUTH0_CLIENT_ID: 'cliente-123', AUTH0_CLIENT_SECRET: 'secreto-cliente', SUPERADMIN_EMAILS: 'root@pyxis.co' });

const sql = pgLocal();
for (const t of ['leads', 'auditoria', 'alertas', 'lecturas', 'robots', 'invitaciones', 'usuarios', 'empresas']) await sql.query(`drop table if exists ${t} cascade`);
globalThis.__sqlPrueba = sql;
const correos = [];
globalThis.__correoPrueba = async (m) => { correos.push(m); };
const { crearServidor } = await import('../dev-server.mjs');
const srv = crearServidor();
await new Promise((r) => srv.listen(0, r));
const BASE = `http://localhost:${srv.address().port}`;

let ok = 0, mal = 0;
const verif = (nombre, cond, extra = '') => { cond ? ok++ : mal++; console.log(`  ${cond ? 'OK   ' : 'FALLA'} ${nombre}${cond ? '' : '  → ' + extra}`); };
async function api(metodo, ruta, cuerpo, { cookie, clave, headers = {} } = {}) {
  const h = Object.assign({}, headers);
  if (cuerpo !== undefined) h['content-type'] = 'application/json';
  if (cookie) h.cookie = cookie;
  if (clave) h['x-api-key'] = clave;
  const r = await fetch(BASE + ruta, { method: metodo, headers: h, redirect: 'manual', body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) });
  let j = null; try { j = await r.json(); } catch { /* sin cuerpo */ }
  return { s: r.status, j, loc: r.headers.get('location') || '', sc: r.headers.getSetCookie() };
}
const galleta = (sc, nombre) => (sc.find((c) => c.startsWith(nombre + '=')) || '').split(';')[0];
async function entrar(perfil) {
  const a = await api('GET', '/api/auth?login');
  const state = new URL(a.loc).searchParams.get('state');
  const code = Buffer.from(JSON.stringify(perfil)).toString('base64url');
  const b = await api('GET', `/api/auth?code=${code}&state=${state}`, undefined, { cookie: galleta(a.sc, 'rm_state') });
  const cookie = galleta(b.sc, 'rm_session');
  if (cookie) await api('GET', '/api/auth', undefined, { cookie });   // como el navegador al abrir /dashboard
  return Object.assign(b, { cookie });
}
const persona = (sub, email, verif = true) => ({ sub, email, name: email.split('@')[0], email_verified: verif });

console.log('\n1. Estado y Auth0');
let r = await api('GET', '/api/health');
verif('health: base de datos y Auth0 listos', r.j.dbOk === true && r.j.auth0 === true && r.j.problemas.length === 0, JSON.stringify(r.j));
r = await api('GET', '/api/auth');
verif('sin sesión → 401', r.s === 401);
r = await api('GET', '/api/auth?login&signup');
const u0 = new URL(r.loc);
verif('?login redirige a Auth0 /authorize con state y callback /api/auth', r.s === 302 && u0.pathname === '/authorize' && u0.searchParams.get('state') && u0.searchParams.get('redirect_uri') === BASE + '/api/auth' && u0.searchParams.get('screen_hint') === 'signup', r.loc);
r = await api('GET', '/api/auth?code=xx&state=otro', undefined, { cookie: 'rm_state=distinto' });
verif('state distinto → vuelve a /login con error', r.s === 302 && r.loc.startsWith('/login?error='));
r = await api('GET', '/api/auth?error=access_denied&error_description=Cancelado');
verif('error de Auth0 → /login con el mensaje', r.loc === '/login?error=Cancelado');

console.log('\n2. Empresas separadas');
const ana = await entrar(persona('auth0|ana', 'ana@minera-a.co'));
verif('callback → /dashboard con cookie HttpOnly', ana.s === 302 && ana.loc === '/dashboard' && /HttpOnly/.test(ana.sc.join()), ana.loc);
r = await api('GET', '/api/auth', undefined, { cookie: ana.cookie });
verif('usuario nuevo aún sin empresa', r.s === 200 && r.j.user.empresaId === null && !r.j.canControl);
r = await api('GET', '/api/telemetry', undefined, { cookie: ana.cookie });
verif('sin empresa no ve datos → 409 SIN_EMPRESA', r.s === 409 && r.j.code === 'SIN_EMPRESA');
r = await api('POST', '/api/auth', { action: 'empresa', nombre: 'Minera A' }, { cookie: ana.cookie });
verif('registra su empresa → 201', r.s === 201);
r = await api('GET', '/api/auth', undefined, { cookie: ana.cookie });
verif('queda como admin de Minera A', r.j.user.role === 'admin' && r.j.user.empresa === 'Minera A' && r.j.canControl);
r = await api('POST', '/api/auth', { action: 'empresa', nombre: 'Otra' }, { cookie: ana.cookie });
verif('no puede crear una segunda empresa → 409', r.s === 409);

const beto = await entrar(persona('google-oauth2|beto', 'beto@tuneles-b.co'));
await api('POST', '/api/auth', { action: 'empresa', nombre: 'Túneles B' }, { cookie: beto.cookie });

r = await api('POST', '/api/robots', { nombre: 'Pyxis A-1' }, { cookie: ana.cookie });
const KA = r.j.robot.clave, IDA = r.j.robot.id;
verif('admin A registra robot y recibe la clave una vez', r.s === 201 && /^pyx_/.test(KA));
r = await api('POST', '/api/robots', { nombre: 'Pyxis B-1' }, { cookie: beto.cookie });
const KB = r.j.robot.clave, IDB = r.j.robot.id;
const filas = await sql.query('select clave_hash from robots');
verif('en la BD solo queda el hash de la clave', !JSON.stringify(filas).includes(KA));

r = await api('POST', '/api/telemetry', { co: 11, ch4: 0.2, o2: 20.9, h2s: 1, mode: 'manual', state: 'NORMAL' }, { clave: KA });
verif('robot A envía telemetría → 200', r.s === 200 && r.j.overall);
r = await api('POST', '/api/telemetry', { co: 77, ch4: 0.2, o2: 20.9, h2s: 1, mode: 'manual', state: 'NORMAL' }, { clave: KB });
verif('robot B envía telemetría (CO alto) → 200', r.s === 200);
r = await api('POST', '/api/telemetry', { co: 1 }, { clave: 'pyx_falsa' });
verif('clave inválida → 401', r.s === 401);

r = await api('GET', '/api/telemetry?history=50', undefined, { cookie: ana.cookie });
verif('Ana ve SOLO su robot (CO 11) y su historial', r.j.robot.id === IDA && r.j.last.co === 11 && r.j.online && r.j.history.length === 1 && r.j.alerts.length === 0, JSON.stringify(r.j).slice(0, 200));
r = await api('GET', '/api/telemetry', undefined, { cookie: beto.cookie });
verif('Beto ve SOLO el suyo (CO 77) con su alerta', r.j.robot.id === IDB && r.j.last.co === 77 && r.j.alerts.length >= 1);
r = await api('GET', `/api/telemetry?robot=${IDA}`, undefined, { cookie: beto.cookie });
verif('Beto pidiendo el robot de A → no lo obtiene', r.j.robot === null && r.j.last === null);
r = await api('GET', '/api/robots', undefined, { cookie: beto.cookie });
verif('lista de robots de Beto solo tiene el suyo', r.j.robots.length === 1 && r.j.robots[0].id === IDB);
r = await api('POST', '/api/command', { robot: IDA, type: 'estop' }, { cookie: beto.cookie });
verif('Beto no puede detener el robot de A → 404', r.s === 404);
r = await api('POST', '/api/robots', { borrar: IDA }, { cookie: beto.cookie });
verif('Beto no puede borrar el robot de A → 404', r.s === 404);

console.log('\n3. Invitaciones y roles');
r = await api('POST', '/api/users', { invitar: 'carla@minera-a.co', role: 'operator' }, { cookie: ana.cookie });
verif('Ana invita a Carla como operadora', r.s === 201);
const mail = correos.at(-1) || {};
verif('se envía el correo de invitación a Carla', r.j.correo === true && mail.to[0] === 'carla@minera-a.co' && /Minera A/.test(mail.subject), JSON.stringify(r.j));
verif('el correo trae rol, empresa, quién invita y el enlace', /Operador/.test(mail.html) && /ana/.test(mail.html) && mail.html.includes(BASE + '/login') && mail.text.includes(BASE + '/login'));
await api('POST', '/api/users', { invitar: 'dani@minera-a.co', role: 'observer' }, { cookie: ana.cookie });
let carla = await entrar(persona('auth0|carla', 'carla@minera-a.co', false));
r = await api('GET', '/api/auth', undefined, { cookie: carla.cookie });
verif('correo NO verificado → no se une a la empresa', r.j.user.empresaId === null);
carla = await entrar(persona('auth0|carla', 'carla@minera-a.co', true));
r = await api('GET', '/api/auth', undefined, { cookie: carla.cookie });
verif('correo verificado → entra a Minera A como operadora', r.j.user.empresa === 'Minera A' && r.j.user.role === 'operator');
r = await api('POST', '/api/users', { invitar: 'carla@minera-a.co', role: 'admin' }, { cookie: beto.cookie });
verif('Beto no puede invitar a alguien que ya es de otra empresa → 409', r.s === 409);
const dani = await entrar(persona('auth0|dani', 'dani@minera-a.co'));
r = await api('GET', '/api/users', undefined, { cookie: ana.cookie });
verif('Ana ve sus 3 usuarios y no a Beto', r.j.users.length === 3 && !JSON.stringify(r.j).includes('beto'));
r = await api('GET', '/api/users', undefined, { cookie: carla.cookie });
verif('operadora no administra usuarios → 403', r.s === 403);

console.log('\n4. Órdenes por robot');
r = await api('POST', '/api/command', { type: 'drive', lin: 0.3, ang: 0 }, { cookie: carla.cookie });
verif('Carla conduce su robot', r.s === 200);
r = await api('GET', '/api/command', undefined, { clave: KA });
verif('robot A recibe la orden', r.j.cmd && r.j.cmd.lin === 0.3, JSON.stringify(r.j));
r = await api('GET', '/api/command', undefined, { clave: KB });
verif('robot B NO recibe la orden de A', r.j.cmd === null);
r = await api('POST', '/api/command', { type: 'drive', lin: 0.3, ang: 0 }, { cookie: dani.cookie });
verif('observador no conduce → 403', r.s === 403);
r = await api('POST', '/api/command', { type: 'estop' }, { cookie: dani.cookie });
verif('observador sí puede activar la parada de emergencia', r.s === 200);
r = await api('GET', '/api/command', undefined, { clave: KA });
const rb = await api('GET', '/api/command', undefined, { clave: KB });
verif('E-STOP solo afecta al robot A', r.j.estop === true && r.j.cmd === null && rb.j.estop === false);
r = await api('POST', '/api/command', { type: 'reset' }, { cookie: carla.cookie });
verif('operadora libera la parada', r.s === 200 && r.j.estop === false);
r = await api('POST', '/api/command', { type: 'mode', value: 'auto' }, { cookie: beto.cookie });
verif('Beto (B con CO alto) no puede pasar a automático', r.s === 409);
r = await api('POST', '/api/command', { type: 'hb' }, { cookie: ana.cookie });
const hb = await api('GET', '/api/command', undefined, { clave: KA });
verif('latido del operador llega al robot A', r.s === 200 && hb.j.hbAge !== null && hb.j.hbAge < 2);

console.log('\n5. Permisos de administrador');
r = await api('POST', '/api/users', { sub: 'auth0|ana', role: 'observer' }, { cookie: ana.cookie });
verif('no puede quedar la empresa sin admin → 409', r.s === 409);
r = await api('POST', '/api/users', { sub: 'auth0|ana', role: 'blocked' }, { cookie: beto.cookie });
verif('Beto no puede cambiar el rol de Ana → 404', r.s === 404);
r = await api('POST', '/api/users', { sub: 'auth0|carla', role: 'blocked' }, { cookie: ana.cookie });
const rc = await api('GET', '/api/auth', undefined, { cookie: carla.cookie });
verif('bloquear a Carla corta su sesión de inmediato', r.s === 200 && rc.s === 401);
r = await entrar(persona('auth0|carla', 'carla@minera-a.co'));
verif('Carla bloqueada no puede volver a entrar', r.loc.startsWith('/login?error='));
r = await api('GET', '/api/users', undefined, { cookie: ana.cookie });
verif('bitácora de A sin acciones de B', r.j.audit.length > 0 && !JSON.stringify(r.j.audit).includes('Túneles'));

console.log('\n6. Solicitudes de demo y seguridad');
r = await api('POST', '/api/lead', { name: 'Eva', email: 'eva@x.co', company: 'X', sector: 'mineria', message: 'hola', consent: true });
verif('landing recibe solicitud de demo', r.s === 201);
r = await api('GET', '/api/lead', undefined, { cookie: ana.cookie });
verif('admin de un cliente NO ve las solicitudes → 403', r.s === 403);
const root = await entrar(persona('auth0|root', 'root@pyxis.co'));
r = await api('GET', '/api/lead', undefined, { cookie: root.cookie });
verif('equipo Pyxis-Bot (SUPERADMIN_EMAILS) sí las ve', r.s === 200 && r.j.leads.length === 1);
r = await api('POST', '/api/auth', { action: 'empresa', nombre: 'X' }, { cookie: ana.cookie, headers: { origin: 'https://sitio-malo.com' } });
verif('Origin ajeno (CSRF) → 403', r.s === 403);
r = await api('GET', '/api/auth', undefined, { cookie: ana.cookie.slice(0, -3) + 'xyz' });
verif('cookie manipulada → 401', r.s === 401);
r = await api('POST', '/api/auth', { action: 'logout' }, { cookie: ana.cookie });
verif('logout borra la cookie y cierra Auth0', /Max-Age=0/.test(r.sc.join()) && r.j.logoutUrl.startsWith(AUTH0 + '/v2/logout'));

console.log(`\n${ok} correctas, ${mal} fallidas\n`);
srv.close(); auth0.close();
process.exit(mal ? 1 : 0);
