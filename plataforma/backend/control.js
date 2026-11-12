'use strict';
/**
 * Robots y su estado de control (tabla robots en Neon).
 *
 *  control  {mode, modeSeq, estop, estopSeq, estopBy, arm, armSeq, grip, gripSeq}   estado persistente
 *  cmd      {lin, ang, ts, by}   última orden de conducción (la pasarela la ignora tras 2 s)
 *  hb       ms del último latido de un operador con el panel abierto (señal de la estación base)
 *
 * El robot se identifica con su clave (cabecera X-Api-Key). En la BD solo se guarda su SHA-256.
 * Cada robot pertenece a una empresa: un usuario solo puede leer/mandar a los robots de la suya.
 */
const crypto = require('crypto');
const db = require('./db');
const H = require('./http');

const VIDA_CMD_MS = 2000;
const MAX_LIN = 0.6;    // m/s
const MAX_ANG = 1.2;    // rad/s
const COLS = 'id, empresa_id, nombre, control, cmd, hb, ultima';

const inicial = () => ({ mode: 'manual', modeSeq: 0, estop: false, estopSeq: 0, estopBy: null, arm: null, armSeq: 0, grip: null, gripSeq: 0 });
const estado = (robot) => Object.assign(inicial(), robot.control);
const guardar = (id, st) => db.q('update robots set control = $2 where id = $1', [id, JSON.stringify(st)]);
const ordenar = (id, cmd) => db.q('update robots set cmd = $2 where id = $1', [id, cmd ? JSON.stringify(cmd) : null]);
const acotar = (v, min, max) => Math.max(min, Math.min(max, v));

/** Robot dueño de la clave X-Api-Key (o null). */
async function porClave(req) {
  const k = req.headers['x-api-key'];
  return k ? db.uno(`select ${COLS} from robots where clave_hash = $1`, [H.sha256(k)]) : null;
}
/** Robot de la empresa del usuario: el pedido (?robot=id) o el primero. */
function deUsuario(user, id) {
  return Number(id) > 0
    ? db.uno(`select ${COLS} from robots where id = $1 and empresa_id = $2`, [Number(id), user.empresaId])
    : db.uno(`select ${COLS} from robots where empresa_id = $1 order by id limit 1`, [user.empresaId]);
}
/** Crea un robot y devuelve su clave (solo se muestra esta vez). */
async function crear(empresaId, nombre) {
  const clave = 'pyx_' + crypto.randomBytes(24).toString('hex');
  const r = await db.uno('insert into robots (empresa_id, nombre, clave_hash) values ($1, $2, $3) returning id, nombre',
    [empresaId, nombre, H.sha256(clave)]);
  return Object.assign(r, { clave });
}

/** Convierte una dirección simple (F, B, L, R, S) en velocidades lineal y angular. */
function dirAVelocidad(dir, velocidad) {
  const v = acotar(Number(velocidad) || 0.3, 0.05, MAX_LIN);
  switch (String(dir).toUpperCase()) {
    case 'F': return { lin: v, ang: 0 };
    case 'B': return { lin: -v, ang: 0 };
    case 'L': return { lin: 0, ang: acotar(v * 2, 0, MAX_ANG) };
    case 'R': return { lin: 0, ang: -acotar(v * 2, 0, MAX_ANG) };
    case 'S': return { lin: 0, ang: 0 };
    default: return null;
  }
}

/** Vista para la pasarela del robot: todo lo que debe aplicar, sin más consultas. */
function paraRobot(robot) {
  const st = estado(robot), cmd = robot.cmd, ahora = Date.now();
  const edad = cmd ? ahora - cmd.ts : null;
  return {
    serverTime: ahora,
    mode: st.mode, modeSeq: st.modeSeq,
    estop: st.estop, estopSeq: st.estopSeq,
    arm: { v: st.arm, seq: st.armSeq },
    grip: { v: st.grip, seq: st.gripSeq },
    cmd: cmd && edad < VIDA_CMD_MS && !st.estop && st.mode === 'manual' ? { lin: cmd.lin, ang: cmd.ang, age_ms: edad } : null,
    hbAge: robot.hb ? Math.round((ahora - robot.hb) / 100) / 10 : null,
  };
}

module.exports = { estado, guardar, ordenar, acotar, porClave, deUsuario, crear, dirAVelocidad, paraRobot, MAX_LIN, MAX_ANG, VIDA_CMD_MS };
