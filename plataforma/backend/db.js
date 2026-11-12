'use strict';
/**
 * Base de datos Neon (Postgres serverless por HTTP).
 * Variable: DATABASE_URL (la crea sola la integración Neon de Vercel).
 * Las tablas se crean solas la primera vez. Todo lo de un cliente cuelga de empresa_id.
 */
const URL_BD = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
let sql = globalThis.__sqlPrueba || null;   // las pruebas locales inyectan Postgres local
let listo = null;

const ESQUEMA = [
  `create table if not exists empresas (id serial primary key, nombre text not null, creada timestamptz not null default now())`,
  `create table if not exists usuarios (sub text primary key, email text not null default '', nombre text, verificado boolean not null default false,
     empresa_id int references empresas(id) on delete set null, rol text not null default 'observer',
     creado timestamptz not null default now(), ultimo_acceso timestamptz default now())`,
  `create table if not exists invitaciones (email text primary key, empresa_id int not null references empresas(id) on delete cascade, rol text not null)`,
  `create table if not exists robots (id serial primary key, empresa_id int not null references empresas(id) on delete cascade, nombre text not null,
     clave_hash text not null unique, control jsonb not null default '{}', cmd jsonb, hb float8, ultima jsonb, creado timestamptz not null default now())`,
  `create table if not exists lecturas (robot_id int not null references robots(id) on delete cascade, t timestamptz not null default now(), d jsonb not null)`,
  `create index if not exists lecturas_robot_t on lecturas (robot_id, t desc)`,
  `create table if not exists alertas (robot_id int not null references robots(id) on delete cascade, t timestamptz not null default now(), d jsonb not null)`,
  `create table if not exists auditoria (empresa_id int references empresas(id) on delete cascade, t timestamptz not null default now(), quien text, accion text, detalle text)`,
  `create table if not exists leads (t timestamptz not null default now(), ip text, d jsonb not null)`,
];

const configurada = () => Boolean(sql || URL_BD);

async function q(texto, params = []) {
  if (!sql) {
    if (!URL_BD) { const e = new Error('Falta DATABASE_URL (Neon)'); e.status = 503; throw e; }
    sql = require('@neondatabase/serverless').neon(URL_BD);
  }
  if (!listo) listo = (async () => { for (const t of ESQUEMA) await sql.query(t); })().catch((e) => { listo = null; throw e; });
  await listo;
  return sql.query(texto, params);
}
const uno = async (texto, params) => (await q(texto, params))[0] || null;

module.exports = { q, uno, configurada };
