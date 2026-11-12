// SOLO PRUEBAS: imita sql.query() de Neon usando el Postgres local (psql). Nunca se usa en producción.
//   PGURL=postgres://postgres:test@127.0.0.1/pyxis_test
import { execFileSync } from 'node:child_process';

const lit = (v) => v === null || v === undefined ? 'NULL'
  : typeof v === 'number' || typeof v === 'boolean' ? String(v)
  : `'${String(v).replace(/'/g, "''")}'`;

export function pgLocal(url = process.env.PGURL || 'postgres://postgres:test@127.0.0.1/pyxis_test') {
  const correr = (sql) => execFileSync('psql', [url, '-AtqX', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return {
    async query(texto, params = []) {
      const sql = texto.replace(/\$(\d+)/g, (_, n) => lit(params[n - 1]));
      const filas = /^\s*select/i.test(sql) || /\breturning\b/i.test(sql);
      if (!filas) { correr(sql); return []; }
      return JSON.parse(correr(`with __r as (${sql}) select coalesce(json_agg(__r), '[]') from __r`).trim());
    },
  };
}
