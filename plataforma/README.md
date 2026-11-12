# Plataforma web · Centro de control Pyxis-Bot

Página comercial, inicio de sesión (Auth0), panel de control multiempresa y API. Base de datos Neon; invitaciones por correo con Gmail o Resend.
Se publica en Vercel con **Root Directory = `plataforma`** (los archivos estáticos salen de `frontend/`, ver `vercel.json`).

## Estructura
| Carpeta | Qué contiene |
|---|---|
| `frontend/` | Navegador: `index.html` (página comercial), `login.html`, `dashboard.html`, `guias/`, `terminos`, `privacidad`, `404`, SEO (`robots.txt`, `sitemap.xml`) y `assets/` (CSS, JS, imágenes) |
| `backend/` | Servidor: `db.js` (Neon + tablas), `auth.js` (sesión y permisos por empresa), `control.js` (robots y órdenes), `safety.js` (umbrales de gases), `correo.js` (Gmail o Resend), `http.js` |
| `api/` | Endpoints: `auth`, `users`, `robots`, `telemetry`, `command`, `lead`, `health` |
| `pruebas/` | `test-api.mjs` + `pg-local.mjs` (pruebas), `simulador-robot.mjs` |
| `scripts/` | `cambiar-dominio.mjs`: actualiza el dominio público en el frontend (`node scripts/cambiar-dominio.mjs https://www.tudominio.com`) |

## Cómo funciona
- **Auth0** gestiona el inicio de sesión; aquí no se guardan contraseñas.
- **Neon (PostgreSQL)** guarda empresas, usuarios, robots, lecturas (7 días), alertas (90 días) y bitácora. Las tablas se crean solas.
- **Multiempresa:** cada usuario pertenece a una empresa y solo ve y controla lo suyo.
  - El primero de una empresa entra con Auth0, registra la empresa y queda como **administrador**.
  - El administrador **invita** por correo (operador / observador / admin). Le llega un correo con su rol y el enlace; entra con Auth0 usando ese correo **verificado**.
  - El administrador **registra cada robot** y recibe su **clave una sola vez** → va en la Jetson (`CLOUD_KEY`).
  - Las solicitudes de demo de la página comercial solo las ve el equipo Pyxis-Bot (`SUPERADMIN_EMAILS`).

Roles: **administrador** (usuarios, robots, bitácora), **operador** (controla el robot), **observador** (solo lectura). La parada de emergencia la activa cualquiera con sesión; solo operador o administrador la libera.

## Variables de entorno (Vercel → Settings → Environment Variables)
| Variable | Para qué |
|---|---|
| `DATABASE_URL` | Conexión a Neon |
| `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET` | Aplicación *Regular Web Application* de Auth0. Callback: `https://TU-DOMINIO/api/auth`; Logout: `https://TU-DOMINIO/login` |
| `AUTH_SECRET` | Firma de la cookie de sesión (cadena aleatoria larga) |
| `SUPERADMIN_EMAILS` | Correos del equipo Pyxis-Bot que ven las solicitudes de demo |
| `GMAIL_USER`, `GMAIL_APP_PASSWORD` | Correo de invitaciones sin dominio propio: un Gmail y su contraseña de aplicación (https://myaccount.google.com/apppasswords) |
| `RESEND_API_KEY` | Clave de Resend; tiene prioridad sobre Gmail cuando también existe `RESEND_FROM` |
| `RESEND_FROM` | Remitente con dominio verificado en Resend, p. ej. `Pyxis-Bot Robotics <invitaciones@tudominio.com>`. Sin dominio, Resend solo entrega al dueño de la cuenta |

Después de cambiarlas: *Redeploy*. Revisa `/api/health`: debe decir `"dbOk": true, "auth0": true, "correo": true, "problemas": []`.

## Probar en local
```
npm install
DATABASE_URL=... AUTH0_DOMAIN=... AUTH0_CLIENT_ID=... AUTH0_CLIENT_SECRET=... node dev-server.mjs   # http://localhost:3000
node pruebas/simulador-robot.mjs http://localhost:3000 pyx_CLAVE_DEL_ROBOT                         # robot simulado
PGURL=postgres://usuario:clave@127.0.0.1/base_de_pruebas node pruebas/test-api.mjs                # 50 pruebas (Postgres local, Auth0 y Resend simulados)
```

## Costos a vigilar
Cada robot hace ~5 consultas/s a Neon (telemetría 1 Hz + órdenes 4 Hz). Resend gratis: 3.000 correos/mes, 100/día. Gmail: unos 500 correos al día. Para uso comercial, Vercel exige plan Pro.

## Seguridad
Auth0 (contraseñas, MFA y bloqueo por intentos), cookie HttpOnly firmada (12 h), `state` anti-falsificación en el login, defensa CSRF, claves de robot guardadas como SHA-256, aislamiento por empresa en cada consulta, CSP sin scripts en línea, bitácora y trampa anti-bots. Los umbrales de gases están en `backend/safety.js`, el firmware y el panel: mantenlos iguales.

## SEO
HTML semántico en `es-CO`, Open Graph, JSON-LD, `sitemap.xml`, `robots.txt` (bloquea `/dashboard`, `/login`, `/api`) y la guía `guias/gases-peligrosos-mineria`. Revisa `terminos.html` y `privacidad.html` con un abogado (Ley 1581 de 2012).
