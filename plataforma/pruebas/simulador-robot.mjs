// Simula al robot (la pasarela de la Jetson) contra el servidor: envía telemetría y obedece las órdenes.
//   node pruebas/simulador-robot.mjs URL CLAVE      (la CLAVE se crea en el panel → Administración → Robots)
//   escenario de gas: node pruebas/simulador-robot.mjs URL CLAVE gas
const URL_ = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');
const KEY = process.argv[3] || process.env.ROBOT_API_KEY;
if (!KEY) { console.log('Falta la clave del robot: créala en el panel → Administración → Robots'); process.exit(1); }
const ESC = process.argv[4] || 'normal';
const H = { 'X-Api-Key': KEY, 'Content-Type': 'application/json' };
let x = 0, y = 0, th = 0, bat = 92, modo = 'manual', arm = [0, 0, 0], grip = 50, lin = 0, ang = 0;
const seq = {}; let primera = true; const t0 = Date.now();

const lidar = () => Array.from({ length: 72 }, (_, i) => Math.round(250 + 120 * Math.sin(i / 5 + th) + 60 * Math.sin(i / 2)));
function lectura() {
  const t = (Date.now() - t0) / 1000;
  let co = 8 + 3 * Math.sin(t / 5), ch4 = 0.3 + 0.05 * Math.sin(t / 7), o2 = 20.8, h2s = 1;
  if (ESC === 'gas' && t > 5) { co = 62; h2s = 12; }
  return { co, ch4, o2, h2s, temp: 27 + Math.sin(t / 30), hum: 70, pres: 1013, bat, bat_v: 11 + bat / 100,
    speed: lin, heading: ((th * 180 / Math.PI) % 360 + 360) % 360, inc: 3, mode: modo, state: 'NORMAL', alert: 0,
    x, y, points: 1 + Math.floor(Math.hypot(x, y) / 0.25), arm, grip, lidar: lidar() };
}
async function enviar() {
  try { await fetch(URL_ + '/api/telemetry', { method: 'POST', headers: H, body: JSON.stringify(lectura()) }); }
  catch (e) { console.log('telemetría:', e.message); }
}
async function recibir() {
  try {
    const r = await (await fetch(URL_ + '/api/command', { headers: H })).json();
    const cambia = (k, v) => { const p = seq[k]; seq[k] = v; return p !== undefined && p !== v; };
    const e = cambia('e', r.estopSeq), m = cambia('m', r.modeSeq), a = cambia('a', r.arm.seq), g = cambia('g', r.grip.seq);
    if (primera) { primera = false; if (r.estop) { lin = ang = 0; } return; }
    if (r.estop) { lin = ang = 0; if (e) console.log('ESTOP'); return; }
    if (m) { modo = r.mode; console.log('modo ->', modo); }
    if (a) { arm = r.arm.v; console.log('brazo ->', arm); }
    if (g) { grip = r.grip.v; console.log('pinza ->', grip); }
    lin = r.cmd ? r.cmd.lin : 0; ang = r.cmd ? r.cmd.ang : 0;
  } catch (e) { console.log('órdenes:', e.message); }
}
setInterval(() => { th += ang * 0.1; x += Math.cos(th) * lin * 0.1; y += Math.sin(th) * lin * 0.1; bat = Math.max(5, bat - 0.001); }, 100);
setInterval(enviar, 1000); setInterval(recibir, 250);
console.log('Robot simulado →', URL_, '· escenario:', ESC);
