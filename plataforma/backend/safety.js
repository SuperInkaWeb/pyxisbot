'use strict';
/**
 * UMBRALES DE SEGURIDAD (edítalos aquí).
 * Deben ser IGUALES a los del firmware del ESP32 (robot/esp32/src/main.cpp) y a los del objeto WID del dashboard
 * (plataforma/frontend/assets/dashboard.js). El firmware es quien detiene el robot; este archivo solo decide los estados
 * que se muestran y si el servidor acepta pasar a modo automático.
 *
 * Son valores de referencia. Valídalos con el área HSE y con la normativa minera aplicable
 * (en Colombia, el Decreto 1886 de 2015) antes de operar.
 *
 * dir 'alto': el peligro es un valor alto (CO, CH4, H2S, temperatura, humedad).
 * dir 'bajo': el peligro es un valor bajo (oxígeno, batería).
 * nivel: 0 normal, 1 precaución, 2 peligro.
 */
const LIMITES = {
  co:   { aviso: 25,   peligro: 50,   dir: 'alto', unidad: 'ppm', nombre: 'Monóxido de carbono (CO)', parada: true },
  ch4:  { aviso: 1.0,  peligro: 1.5,  dir: 'alto', unidad: '%',   nombre: 'Metano (CH₄)',             parada: true },
  o2:   { aviso: 20.0, peligro: 19.5, dir: 'bajo', unidad: '%',   nombre: 'Oxígeno (O₂)',             parada: true },
  h2s:  { aviso: 5,    peligro: 10,   dir: 'alto', unidad: 'ppm', nombre: 'Sulfuro de hidrógeno (H₂S)', parada: true },
  temp: { aviso: 40,   peligro: 65,   dir: 'alto', unidad: '°C',  nombre: 'Temperatura',              parada: true },
  hum:  { aviso: 85,   peligro: 95,   dir: 'alto', unidad: '%',   nombre: 'Humedad',                  parada: false },
  bat:  { aviso: 30,   peligro: 15,   dir: 'bajo', unidad: '%',   nombre: 'Batería',                  parada: false },
};

function nivel(clave, v) {
  const l = LIMITES[clave];
  if (!l || typeof v !== 'number' || !Number.isFinite(v)) return null;
  if (l.dir === 'alto') return v >= l.peligro ? 2 : v >= l.aviso ? 1 : 0;
  return v <= l.peligro ? 2 : v <= l.aviso ? 1 : 0;
}

/**
 * Evalúa una lectura. `general` solo cuenta lo que detiene al robot (gases y temperatura):
 * 'ok' | 'warn' | 'danger'. Batería y humedad se informan aparte en `niveles`.
 */
function evaluar(lectura) {
  const niveles = {};
  let peor = 0;
  const peligros = [];
  for (const k of Object.keys(LIMITES)) {
    const n = nivel(k, lectura[k]);
    if (n === null) continue;
    niveles[k] = n;
    if (LIMITES[k].parada) {
      if (n > peor) peor = n;
      if (n === 2) peligros.push(k);
    }
  }
  return { niveles, general: ['ok', 'warn', 'danger'][peor], peligros };
}

module.exports = { LIMITES, nivel, evaluar };
