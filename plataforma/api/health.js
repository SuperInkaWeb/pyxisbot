'use strict';
/** GET /api/health: diagnóstico. Nunca muestra valores secretos, solo si están configurados. */
const H = require('../backend/http');
const A = require('../backend/auth');
const db = require('../backend/db');
const correo = require('../backend/correo');

module.exports = H.endpoint(async (req, res) => {
  let dbOk = null;
  if (db.configurada()) {
    try { dbOk = (await db.uno('select 1 as ok')).ok === 1; } catch (e) { console.error('[health]', e.message); dbOk = false; }
  }
  H.send(res, 200, {
    ok: true,
    database: db.configurada() ? 'neon' : 'sin configurar',
    dbOk,
    auth0: A.auth0Listo(),
    authSecret: A.secretoListo(),
    correo: correo.configurado(),
    proveedorCorreo: correo.proveedor,
    problemas: [
      ...(!db.configurada() ? ['Falta DATABASE_URL: conecta Neon en Vercel → Storage (o Integrations) y vuelve a desplegar.'] : []),
      ...(dbOk === false ? ['Neon está configurado pero no responde. Revisa DATABASE_URL.'] : []),
      ...(!A.auth0Listo() ? ['Faltan AUTH0_DOMAIN, AUTH0_CLIENT_ID o AUTH0_CLIENT_SECRET.'] : []),
      ...(!A.secretoListo() ? ['Falta la variable AUTH_SECRET.'] : []),
      ...(correo.proveedor === 'resend-pruebas' ? ['Resend sin dominio (falta RESEND_FROM): solo entrega al dueño de la cuenta de Resend. Configura Gmail o un dominio.'] : []),
      ...(!correo.configurado() ? ['Falta configurar el correo (GMAIL_USER + GMAIL_APP_PASSWORD, o RESEND_API_KEY + RESEND_FROM): las invitaciones se crean pero no se envía el correo.'] : []),
    ],
    time: new Date().toISOString(),
  });
});
