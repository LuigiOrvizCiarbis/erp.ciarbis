// Utilidades de Zod 4 (V2.107.1 — migración zod 3 → 4 por CVE de memoria, ver GHSA-mrhx-c7xc-m3w5).
import { z } from 'zod'

// Mensajes de validación por defecto en español (los mensajes propios de cada schema no cambian).
// z.config es global: con importar este archivo una vez al arrancar alcanza (server.cjs / index.js).
z.config(z.locales.es())

// Igual que `schema.partial()` de Zod 3, para los PUT de edición.
// En Zod 4, `.partial()` (y `.default().optional()`) APLICAN el default cuando el campo no viene:
// editar un cliente sin mandar `tipo` lo volvería a MINORISTA. Acá se sacan los defaults
// de cada campo antes de hacerlo opcional, así lo que no se manda no se toca.
function sinDefault(campo) {
  let c = campo
  for (;;) {
    const t = c?._zod?.def?.type
    if (t === 'default' || t === 'prefault' || t === 'optional') c = c._zod.def.innerType
    else return c
  }
}

export function parcial(schema) {
  const shape = {}
  for (const [k, campo] of Object.entries(schema.shape)) shape[k] = sinDefault(campo).optional()
  return z.object(shape)
}
