'use strict';
/**
 * Órdenes al robot.
 *
 * POST /api/command   (sesión; operador/administrador salvo "hb" y "estop", que puede enviar cualquier usuario)
 *   Todas aceptan "robot": id (por defecto, el primer robot de la empresa).
 *   {type:'hb'}                              latido: "hay un operador con el panel abierto"
 *   {type:'drive', lin, ang}                 conducción continua (m/s, rad/s). Caduca a los 2 s
 *   {type:'move', dir:'F|B|L|R|S', speed}    atajo por dirección
 *   {type:'mode', value:'manual|auto'}
 *   {type:'estop'}                           parada de emergencia (queda activa hasta 'reset')
 *   {type:'reset'}                           libera la parada de emergencia
 *   {type:'arm', v:[base, hombro, codo, muñeca]}  grados, -90..90 (acepta 3 sin muñeca)
 *   {type:'grip', v:0..100}                  0 cerrada, 100 abierta
 *
 * GET /api/command    (robot, X-Api-Key)  lo que la pasarela debe aplicar (ver backend/control.js)
 * GET /api/command[?robot=id] (sesión)    estado de control para el panel
 */
const H = require('../backend/http');
const A = require('../backend/auth');
const C = require('../backend/control');
const db = require('../backend/db');

async function ordenar(req, res) {
  if (!H.solicitudSegura(req)) return H.fail(res, 403, 'Solicitud no permitida');
  const user = await A.exigir(req, res);
  if (!user) return;
  const b = await H.readBody(req);
  const tipo = String(b.type || '');
  const robot = await C.deUsuario(user, b.robot);
  if (!robot) return H.fail(res, 404, 'Tu empresa aún no tiene robots registrados');

  if (tipo === 'hb') {
    await db.q('update robots set hb = $2 where id = $1', [robot.id, Date.now()]);
    return H.send(res, 200, { ok: true });
  }

  const st = C.estado(robot);

  if (tipo === 'estop') {      // detener siempre es seguro: lo puede pedir cualquier usuario con sesión
    st.estop = true; st.estopSeq++; st.estopBy = user.name;
    st.mode = 'manual'; st.modeSeq++;
    await Promise.all([C.guardar(robot.id, st), C.ordenar(robot.id, null), A.auditar(user.empresaId, user.email, 'parada de emergencia', robot.nombre)]);
    return H.send(res, 200, { ok: true, estop: true });
  }

  if (!user.canControl) {
    return H.fail(res, 403, 'Tu rol es observador: solo lectura. Pide al administrador el rol de operador');
  }

  if (tipo === 'reset') {
    if (st.estop) {
      st.estop = false; st.estopSeq++; st.estopBy = null;
      await Promise.all([C.guardar(robot.id, st), A.auditar(user.empresaId, user.email, 'parada de emergencia liberada', robot.nombre)]);
    }
    return H.send(res, 200, { ok: true, estop: false });
  }

  if (st.estop) return H.fail(res, 423, 'Parada de emergencia activa. Libérala para volver a controlar el robot');

  switch (tipo) {
    case 'mode': {
      const v = String(b.value || '').toLowerCase();
      if (v !== 'manual' && !v.startsWith('auto')) return H.fail(res, 400, 'Modo no válido');
      const nuevo = v === 'manual' ? 'manual' : 'auto';
      if (nuevo === 'auto') {
        const ult = robot.ultima;
        if (ult && Date.now() - ult.ts < 15000 && ult.overall === 'danger') {
          return H.fail(res, 409, 'No se puede pasar a automático: hay una alerta de gas o temperatura');
        }
      }
      if (st.mode !== nuevo) {
        st.mode = nuevo; st.modeSeq++;
        await Promise.all([C.guardar(robot.id, st), C.ordenar(robot.id, null), A.auditar(user.empresaId, user.email, 'cambio de modo', `${robot.nombre}: ${nuevo}`)]);
      }
      return H.send(res, 200, { ok: true, mode: nuevo });
    }
    case 'drive':
    case 'move': {
      if (st.mode !== 'manual') return H.fail(res, 409, 'El robot está en modo automático. Cambia a manual para conducir');
      let lin, ang;
      if (tipo === 'move') {
        const v = C.dirAVelocidad(b.dir, b.speed);
        if (!v) return H.fail(res, 400, 'Dirección no válida');
        ({ lin, ang } = v);
      } else {
        lin = Number(b.lin); ang = Number(b.ang);
        if (!Number.isFinite(lin) || !Number.isFinite(ang)) return H.fail(res, 400, 'Velocidades no válidas');
        lin = C.acotar(lin, -C.MAX_LIN, C.MAX_LIN); ang = C.acotar(ang, -C.MAX_ANG, C.MAX_ANG);
      }
      await C.ordenar(robot.id, { lin, ang, ts: Date.now(), by: user.name });
      return H.send(res, 200, { ok: true, lin, ang });
    }
    case 'arm': {
      if (st.mode !== 'manual') return H.fail(res, 409, 'El brazo solo se mueve en modo manual');
      if (!Array.isArray(b.v) || b.v.length < 3) return H.fail(res, 400, 'Se esperan 4 ángulos: base, hombro, codo y muñeca');
      const v = b.v.slice(0, 4).map((x) => Math.round(C.acotar(Number(x), -90, 90)));
      if (v.some((x) => !Number.isFinite(x))) return H.fail(res, 400, 'Ángulos no válidos');
      st.arm = v; st.armSeq++;
      await C.guardar(robot.id, st);
      return H.send(res, 200, { ok: true, arm: v });
    }
    case 'grip': {
      if (st.mode !== 'manual') return H.fail(res, 409, 'La pinza solo se mueve en modo manual');
      const v = Number(b.v);
      if (!Number.isFinite(v)) return H.fail(res, 400, 'Valor no válido');
      st.grip = Math.round(C.acotar(v, 0, 100)); st.gripSeq++;
      await C.guardar(robot.id, st);
      return H.send(res, 200, { ok: true, grip: st.grip });
    }
    default: return H.fail(res, 400, 'Tipo de orden desconocido');
  }
}

module.exports = H.endpoint(async (req, res) => {
  if (req.method === 'POST') return ordenar(req, res);
  if (req.method !== 'GET') return H.fail(res, 405, 'Método no permitido');
  if (req.headers['x-api-key']) {
    const robot = await C.porClave(req);
    if (!robot) return H.fail(res, 401, 'Clave del robot incorrecta');
    return H.send(res, 200, Object.assign({ ok: true }, C.paraRobot(robot)));
  }
  const u = await A.exigir(req, res);
  if (!u) return;
  const robot = await C.deUsuario(u, H.consulta(req).robot);
  if (!robot) return H.fail(res, 404, 'Tu empresa aún no tiene robots registrados');
  const st = C.estado(robot);
  return H.send(res, 200, { ok: true, mode: st.mode, estop: st.estop, estopBy: st.estopBy });
});
