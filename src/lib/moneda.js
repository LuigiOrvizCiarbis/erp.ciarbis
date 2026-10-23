// ─────────────────────────────────────────────────────────────
//  Precios en dólares (V2.106.0)
//  Un producto con moneda 'USD' guarda precioCosto/precioVenta (y los de sus variantes) en
//  dólares; todo lo que vende, valúa o muestra lo usa en PESOS, convertido con la cotización
//  default del tenant del momento (CotizacionDolar.tipoDefault, ej. la Manual que carga el
//  dueño). Si el dueño cambia la cotización, todos los precios en pesos se mueven solos.
//  Las APIs devuelven precioCosto/precioVenta YA en pesos (así el PoS, las etiquetas, las
//  listas de precio y la Caja no cambian) y los valores originales en precioCostoOrig /
//  precioVentaOrig, que es lo único que un formulario de edición debe mostrar y volver a guardar.
// ─────────────────────────────────────────────────────────────

import { prisma as prismaDefault } from './prisma.js'
import { CLAVES_COTIZACION } from './cotizacion.js'

// Caché corto por tenant: la cotización se lee en casi cada pedido de productos y cada viaje
// a la base de prod cuesta ~200ms. Se invalida al editar/actualizar la cotización.
const TTL_MS = 60 * 1000
const cache = new Map()
export function invalidarCotizacion(tenantId) {
  if (tenantId) cache.delete(tenantId); else cache.clear()
}

// Valor en pesos de 1 dólar según el default del tenant; 0 si nunca se cargó.
export async function cotizacionDefault(tenantId, db) {
  const c = cache.get(tenantId)
  if (c && Date.now() - c.t < TTL_MS) return c.v
  const cot = await (db || prismaDefault).cotizacionDolar.findUnique({ where: { tenantId } })
  const tipo = cot && CLAVES_COTIZACION.includes(cot.tipoDefault) ? cot.tipoDefault : 'oficialVenta'
  const v = cot ? Number(cot[tipo]) || 0 : 0
  cache.set(tenantId, { v, t: Date.now() })
  return v
}

const r2 = (n) => Math.round(n * 100) / 100

// Monto en la moneda del producto → pesos.
export function aPesos(monto, moneda, cot) {
  if (monto == null) return monto
  return moneda === 'USD' ? r2(Number(monto) * (cot || 0)) : monto
}
// Monto en pesos (ej. el costo de una compra) → moneda del producto. Sin cotización no se puede
// pasar a dólares: devuelve null y el que llama decide (en general, no tocar el costo).
export function desdePesos(monto, moneda, cot) {
  if (monto == null || moneda !== 'USD') return monto
  return cot > 0 ? r2(Number(monto) / cot) : null
}

// Producto (con sus variantes si vinieron) listo para el frontend: precios en pesos + originales.
// Un producto en ARS sale igual que siempre (sin campos nuevos más que `moneda`).
export function conPreciosEnPesos(p, cot) {
  if (!p || p.moneda !== 'USD') return p
  const conv = (x) => ({
    ...x,
    precioCostoOrig: x.precioCosto, precioVentaOrig: x.precioVenta,
    precioCosto: aPesos(x.precioCosto, 'USD', cot), precioVenta: aPesos(x.precioVenta, 'USD', cot),
  })
  return {
    ...conv(p),
    cotizacionAplicada: cot,
    ...(p.variantes && { variantes: p.variantes.map((v) => ({ ...conv(v), moneda: 'USD' })) }),
  }
}
export async function listaEnPesos(tenantId, productos, db) {
  if (!productos.some((p) => p?.moneda === 'USD')) return productos
  const cot = await cotizacionDefault(tenantId, db)
  return productos.map((p) => conPreciosEnPesos(p, cot))
}
