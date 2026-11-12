'use strict';
/**
 * POST /api/telemetry   (el robot / pasarela Jetson, cabecera X-Api-Key)
 *      {co, ch4, o2, h2s, temp, hum, pres, bat, bat_v, speed, rssi, heading, inc, mode, state, alert,
 *       x, y, points, arm:[b,h,c,m], grip, lidar:[cm × 72]}
 *      → {ok, overall, mode, estop}
 * GET  /api/telemetry?history=300[&robot=id]   (sesión) última lectura, historial, alertas y umbrales
 *      Solo de robots de la empresa del usuario.
 */
const H = require('../backend/http');
const A = require('../backend/auth');
const S = require('../backend/safety');
const C = require('../backend/control');
const db = require('../backend/db');

const HIST_MAX = 3600;     // máximo de lecturas que se envían al panel por consulta 
const ESTADOS = ['NORMAL', 'RTH', 'ESPERA'];

function limpiarLectura(b) {
  const n = H.num;
  const modo = String(b.mode || '').toLowerCase();
  const r = {
    co: n(b.co, 0, 5000), ch4: n(b.ch4, 0, 100), o2: n(b.o2, 0, 100), h2s: n(b.h2s, 0, 1000),
    temp: n(b.temp, -40, 150), hum: n(b.hum, 0, 100), pres: n(b.pres, 300, 1200),
    bat: n(b.bat, 0, 100), bat_v: n(b.bat_v, 0, 80),
    speed: n(b.speed, -5, 5), rssi: n(b.rssi, -130, 0), heading: n(b.heading, 0, 360), inc: n(b.inc, 0, 180),
    x: n(b.x, -100000, 100000), y: n(b.y, -100000, 100000), grip: n(b.grip, 0, 100),
    points: n(b.points, 0, 100000),
    mode: modo.startsWith('auto') ? 'auto' : modo.startsWith('man') ? 'manual' : null,
    state: ESTADOS.includes(String(b.state).toUpperCase()) ? String(b.state).toUpperCase() : null,
    alert: b.alert ? 1 : 0,
  };
  if (Array.isArray(b.arm) && b.arm.length >= 3) {
    const a = b.arm.slice(0, 4).map((v) => n(v, -180, 180));
    if (a.every((v) => v !== null)) r.arm = a;
  }
  if (Array.isArray(b.lidar)) {
    r.lidar = b.lidar.slice(0, 72).map((v) => { const c = n(v, 0, 5000); return c === null ? 0 : Math.round(c); });
  }
  return r;
}

async function recibir(req, res, robot) {
  const b = await H.readBody(req);
  const lect = limpiarLectura(b);
  const ev = S.evaluar(lect);
  const ahora = Date.now();
  const previo = robot.ultima;
  lect.ts = ahora;
  lect.levels = ev.niveles;
  lect.overall = ev.general;

  // Alertas: solo cuando un nivel empeora (no una por cada lectura)
  const nuevas = [];
  for (const [k, nv] of Object.entries(ev.niveles)) {
    const antes = previo && previo.levels ? previo.levels[k] || 0 : 0;
    if (nv > antes && nv >= 1) nuevas.push({ t: ahora, key: k, level: nv, value: lect[k] });
  }
  if (previo && lect.state && previo.state !== lect.state && lect.state !== 'NORMAL') {
    nuevas.push({ t: ahora, key: 'state', level: 1, value: lect.state });
  }
  const hist = { t: ahora };
  for (const k of ['co', 'ch4', 'o2', 'h2s', 'temp', 'hum', 'pres', 'bat', 'bat_v']) if (lect[k] !== null) hist[k] = lect[k];

  const ops = [
    db.q('update robots set ultima = $2 where id = $1', [robot.id, JSON.stringify(lect)]),
    db.q('insert into lecturas (robot_id, d) values ($1, $2)', [robot.id, JSON.stringify(hist)]),
    ...nuevas.map((a) => db.q('insert into alertas (robot_id, d) values ($1, $2)', [robot.id, JSON.stringify(a)])),
  ];
  if (Math.random() < 0.01) {     // limpieza ocasional: 7 días de lecturas, 90 de alertas
    ops.push(db.q(`delete from lecturas where robot_id = $1 and t < now() - interval '7 days'`, [robot.id]));
    ops.push(db.q(`delete from alertas where robot_id = $1 and t < now() - interval '90 days'`, [robot.id]));
  }
  await Promise.all(ops);

  const st = C.estado(robot);
  return H.send(res, 200, { ok: true, overall: ev.general, mode: st.mode, estop: st.estop });
}

async function leer(req, res) {
  const u = await A.exigir(req, res);
  if (!u) return;
  const q = H.consulta(req);
  const robot = await C.deUsuario(u, q.robot);
  if (!robot) return H.send(res, 200, { ok: true, robot: null, online: false, last: null, alerts: [], thresholds: S.LIMITES, control: { mode: 'manual', estop: false }, serverTime: Date.now() });
  const n = Math.max(0, Math.min(HIST_MAX, parseInt(q.history, 10) || 0));
  const [alertas, hist] = await Promise.all([
    db.q('select d from alertas where robot_id = $1 order by t desc limit 30', [robot.id]),
    n ? db.q('select d from lecturas where robot_id = $1 order by t desc limit $2', [robot.id, n]) : null,
  ]);
  const ultimo = robot.ultima;
  const edad = ultimo ? Math.round((Date.now() - ultimo.ts) / 100) / 10 : null;
  const st = C.estado(robot);
  return H.send(res, 200, {
    ok: true,
    robot: { id: robot.id, nombre: robot.nombre },
    online: edad !== null && edad < 10,
    age: edad,
    last: ultimo,
    history: hist ? hist.map((x) => x.d).reverse() : undefined,
    alerts: alertas.map((x) => x.d),
    thresholds: S.LIMITES,
    control: { mode: st.mode, estop: st.estop, estopBy: st.estopBy },
    serverTime: Date.now(),
  });
}

module.exports = H.endpoint(async (req, res) => {
  if (req.method === 'POST') {
    const robot = await C.porClave(req);
    if (!robot) return H.fail(res, 401, 'Clave del robot incorrecta (créala en el panel → Administración → Robots)');
    return recibir(req, res, robot);
  }
  if (req.method === 'GET') return leer(req, res);
  return H.fail(res, 405, 'Método no permitido');
});
