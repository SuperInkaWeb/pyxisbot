// Servidor local sin dependencias: sirve /frontend y ejecuta los endpoints de /api como lo hace Vercel.
//   node dev-server.mjs            -> http://localhost:3000
//   PORT=4000 node dev-server.mjs
// Sin variables de entorno usa memoria (los usuarios se borran al reiniciar) y claves de desarrollo:
//   ROBOT_API_KEY = dev-robot-key
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const RAIZ = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(RAIZ, 'frontend');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml',
  '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2',
};

// Las mismas cabeceras de seguridad que vercel.json
const vj = JSON.parse(fs.readFileSync(path.join(RAIZ, 'vercel.json'), 'utf8'));
const CABECERAS = Object.fromEntries((vj.headers.find((h) => h.source === '/(.*)') || { headers: [] }).headers.map((h) => [h.key, h.value]));
delete CABECERAS['Strict-Transport-Security'];

function estatico(req, res, ruta) {
  let rel = decodeURIComponent(ruta);
  if (rel.endsWith('/')) rel += 'index';
  let archivo = path.join(PUBLIC, rel);
  if (!archivo.startsWith(PUBLIC)) { res.statusCode = 403; return res.end('Prohibido'); }
  const candidatos = [archivo, archivo + '.html', path.join(archivo, 'index.html')];
  const real = candidatos.find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
  const cab = Object.assign({}, CABECERAS);
  if (!real) {
    res.writeHead(404, Object.assign(cab, { 'Content-Type': MIME['.html'] }));
    return res.end(fs.existsSync(path.join(PUBLIC, '404.html')) ? fs.readFileSync(path.join(PUBLIC, '404.html')) : 'No encontrado');
  }
  cab['Content-Type'] = MIME[path.extname(real)] || 'application/octet-stream';
  cab['Cache-Control'] = 'no-cache';
  res.writeHead(200, cab);
  fs.createReadStream(real).pipe(res);
}

export function crearServidor() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    if (url.pathname.startsWith('/api/')) {
      const nombre = url.pathname.slice(5).replace(/\/$/, '');
      const archivo = path.join(RAIZ, 'api', nombre + '.js');
      if (!/^[a-z0-9_-]+$/i.test(nombre) || !fs.existsSync(archivo)) {
        res.statusCode = 404; res.setHeader('Content-Type', 'application/json');
        return res.end('{"ok":false,"error":"Endpoint no encontrado"}');
      }
      // Igual que Vercel: si el cuerpo es JSON, llega ya convertido en req.body
      if (['POST', 'PUT', 'PATCH'].includes(req.method) && /json/i.test(req.headers['content-type'] || '')) {
        const trozos = [];
        for await (const t of req) trozos.push(t);
        const txt = Buffer.concat(trozos).toString('utf8');
        try { req.body = txt ? JSON.parse(txt) : {}; } catch { req.body = Buffer.from(txt); }
      }
      return require(archivo)(req, res);
    }
    return estatico(req, res, url.pathname);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const puerto = Number(process.env.PORT) || 3000;
  crearServidor().listen(puerto, () => console.log(`Servidor local en http://localhost:${puerto}   (clave del robot: ${process.env.ROBOT_API_KEY || 'dev-robot-key'})`));
}
