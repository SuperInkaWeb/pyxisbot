'use strict';
/**
 * Correos del sistema (por ahora: invitaciones) enviados con Resend (https://resend.com), sin librerías.
 * Variables:
 *   RESEND_API_KEY  clave de API de Resend (obligatoria para enviar).
 *   RESEND_FROM     remitente, p. ej. "Pyxis-Bot Robotics <invitaciones@tudominio.com>" (dominio verificado en Resend).
 *                   Sin dominio verificado se usa onboarding@resend.dev, que SOLO entrega al dueño de la cuenta de Resend.
 * Sin RESEND_API_KEY no se envía nada y la invitación igual queda creada.
 */
const KEY = process.env.RESEND_API_KEY || '';
const FROM = process.env.RESEND_FROM || 'Pyxis-Bot Robotics <onboarding@resend.dev>';
const enviar = globalThis.__correoPrueba || (async (m) => {    // las pruebas inyectan un envío falso
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(m),
  });
  if (!r.ok) throw new Error('Resend HTTP ' + r.status + ': ' + (await r.text()).slice(0, 200));
});

const configurado = () => Boolean(globalThis.__correoPrueba || KEY);
const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ROLES = {
  admin: ['Administrador', 'gestionar los usuarios y robots de la empresa, consultar la información y controlar los robots'],
  operator: ['Operador', 'consultar la información en tiempo real y controlar los robots (conducción, modos, brazo y pinza)'],
  observer: ['Observador', 'consultar la información en tiempo real (gases, mapa LiDAR, alertas e historial) y activar la parada de emergencia'],
};

function invitacion({ para, empresa, invitadoPor, rol, url }) {
  const [nombreRol, permisos] = ROLES[rol] || ROLES.observer;
  const asunto = `Invitación al Centro de Control Pyxis-Bot · ${empresa}`;
  const texto = [
    'Cordial saludo:',
    '',
    `${invitadoPor}, de ${empresa}, le ha invitado a acceder al Centro de Control Pyxis-Bot con el rol de ${nombreRol}.`,
    `Con este rol usted podrá ${permisos}.`,
    '',
    'Para ingresar:',
    `1. Abra ${url}`,
    `2. Seleccione "Crear cuenta" (o "Iniciar sesión" si ya tiene una) y utilice este mismo correo: ${para}`,
    '3. Verifique su correo electrónico cuando el sistema se lo solicite.',
    '',
    'Si no esperaba esta invitación, puede ignorar este mensaje.',
    '',
    'Atentamente,',
    'Equipo Pyxis-Bot Robotics',
  ].join('\n');
  const html = `<!doctype html><html lang="es"><body style="margin:0;background:#f4f1e6;font-family:Arial,Helvetica,sans-serif;color:#2d3329">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #d9d1bf;border-radius:10px">
<tr><td style="background:#232a22;color:#f4f1e6;padding:20px 28px;border-radius:10px 10px 0 0;font-size:20px;font-weight:bold">Pyxis-Bot · Centro de Control</td></tr>
<tr><td style="padding:28px;font-size:15px;line-height:1.6">
<p style="margin:0 0 14px">Cordial saludo:</p>
<p style="margin:0 0 14px"><b>${esc(invitadoPor)}</b>, de <b>${esc(empresa)}</b>, le ha invitado a acceder al Centro de Control Pyxis-Bot con el rol de <b>${esc(nombreRol)}</b>.</p>
<p style="margin:0 0 20px">Con este rol usted podrá ${esc(permisos)}.</p>
<p style="margin:0 0 24px;text-align:center"><a href="${esc(url)}" style="display:inline-block;background:#5d7a52;color:#ffffff;text-decoration:none;font-weight:bold;padding:13px 28px;border-radius:8px">Ingresar al Centro de Control</a></p>
<p style="margin:0 0 8px"><b>Para ingresar:</b></p>
<ol style="margin:0 0 20px;padding-left:20px">
<li>Haga clic en el botón anterior.</li>
<li>Seleccione <b>Crear cuenta</b> (o <b>Iniciar sesión</b> si ya tiene una) y utilice este mismo correo: <b>${esc(para)}</b>.</li>
<li>Verifique su correo electrónico cuando el sistema se lo solicite.</li>
</ol>
<p style="margin:0 0 20px;font-size:13px;color:#68705c">Si el botón no funciona, copie este enlace en su navegador: <a href="${esc(url)}" style="color:#5d7a52">${esc(url)}</a></p>
<p style="margin:0">Atentamente,<br><b>Equipo Pyxis-Bot Robotics</b></p>
</td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid #ece7da;font-size:12px;color:#68705c">Si no esperaba esta invitación, puede ignorar este mensaje. Mensaje enviado automáticamente desde el Centro de Control Pyxis-Bot.</td></tr>
</table></td></tr></table></body></html>`;
  return { asunto, texto, html };
}

/** Envía la invitación. Devuelve true si salió; nunca lanza error (la invitación ya quedó guardada). */
async function enviarInvitacion(datos) {
  if (!configurado()) return false;
  try {
    const m = invitacion(datos);
    await enviar({ from: FROM, to: [datos.para], subject: m.asunto, html: m.html, text: m.texto });
    return true;
  } catch (e) {
    console.error('[correo]', e.message);
    return false;
  }
}

module.exports = { enviarInvitacion, invitacion, configurado };
