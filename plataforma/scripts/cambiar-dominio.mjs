// Cambia el dominio público del sitio en el frontend (canonical, Open Graph, sitemap, robots, JSON-LD).
//   node scripts/cambiar-dominio.mjs https://www.tudominio.com
import fs from 'node:fs';
import path from 'node:path';

const ACTUAL = 'https://robotmineropyxis-bot-dashboard.vercel.app';
const nuevo = (process.argv[2] || '').replace(/\/$/, '');
if (!/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}$/i.test(nuevo)) {
  console.error('Uso: node scripts/cambiar-dominio.mjs https://www.tudominio.com');
  process.exit(1);
}

const raiz = path.resolve(import.meta.dirname, '..', 'frontend');
let cambiados = 0;
for (const archivo of fs.readdirSync(raiz, { recursive: true })) {
  const ruta = path.join(raiz, archivo);
  if (!/\.(html|xml|txt|webmanifest)$/.test(ruta)) continue;
  const texto = fs.readFileSync(ruta, 'utf8');
  if (!texto.includes(ACTUAL)) continue;
  fs.writeFileSync(ruta, texto.replaceAll(ACTUAL, nuevo));
  console.log('  actualizado', path.relative(raiz, ruta));
  cambiados++;
}
console.log(cambiados ? `Listo: ${cambiados} archivos. Actualiza también ACTUAL en este script.` : 'No se encontró el dominio actual.');
