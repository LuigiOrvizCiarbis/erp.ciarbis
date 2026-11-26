// ─────────────────────────────────────────────────────────────
//  Listas de precio automáticas (V2.108.0)
//
//  Lista PRINCIPAL (esDefault): calcula Producto.precioVenta desde el costo con sus reglas y lo
//  GUARDA en la base (así Inventario, etiquetas, reportes y e-commerce siguen leyendo precioVenta).
//  Listas SECUNDARIAS: se calculan al vuelo, sobre el precio principal o sobre el costo (ListaPrecio.base).
//
//  Regla (ListaPrecioMargen): a quién aplica = productoId | categoriaId (+ subcategorías) |
//  proveedorId | categoría+proveedor | nada (general). Gana la MÁS ESPECÍFICA:
//    producto > categoría+proveedor > categoría > proveedor > general
//  y entre dos de categoría, la de la subcategoría más profunda.
//  tipo: PCT  → base × (1 + valor/100)
//        MONTO → base + valor        (valor en pesos)
//        MANUAL → valor              (precio fijo en pesos)
//
//  Producto.precioManual = true → la principal NO lo recalcula (precio a mano o excluido al
//  aplicar), pero ese precio sigue siendo la base de las secundarias.
//  Todo se calcula en PESOS; un producto en U$D se convierte con la cotización default y el
//  precio principal se guarda de vuelta en su moneda (ver moneda.js).
// ─────────────────────────────────────────────────────────────

import { prisma as prismaDefault } from './prisma.js'
import { cotizacionDefault, aPesos, desdePesos } from './moneda.js'

const TTL_MS = 60 * 1000
const cache = new Map()
export function invalidarListas(tenantId) {
  if (tenantId) cache.delete(tenantId); else cache.clear()
}

// { listas: [{...lista, reglas:[...]}], principal, padre: Map(catId→parentId) }
export async function cargarConfigListas(tenantId, db) {
  const c = cache.get(tenantId)
  if (c && Date.now() - c.t < TTL_MS) return c.v
  const d = db || prismaDefault
  const [listas, cats] = await Promise.all([
    d.listaPrecio.findMany({
      where: { tenantId, activa: true },
      include: { margenes: true },
      orderBy: [{ esDefault: 'desc' }, { nombre: 'asc' }],
    }),
    d.categoria.findMany({ where: { tenantId }, select: { id: true, parentId: true } }),
  ])
  const padre = new Map(cats.map((k) => [k.id, k.parentId]))
  const v = {
    listas: listas.map((l) => ({ ...l, reglas: l.margenes })),
    principal: listas.find((l) => l.esDefault) || null,
    padre,
  }
  if (v.principal) v.principal = v.listas.find((l) => l.id === v.principal.id)
  cache.set(tenantId, { v, t: Date.now() })
  return v
}

// Cadena categoría → raíz: [cat, padre, abuelo, ...] (con corte por si hay un ciclo raro en datos).
function ancestros(catId, padre) {
  const out = []
  let c = catId
  while (c && out.length < 10) { out.push(c); c = padre.get(c) || null }
  return out
}

// Profundidad de una categoría (raíz = 1).
function nivel(catId, padre) { return ancestros(catId, padre).length }

// Puntaje de especificidad de una regla para un producto; -1 si no aplica.
export function puntajeRegla(r, prod, padre) {
  if (r.productoId) return r.productoId === prod.id ? 10000 : -1
  let s = 0
  if (r.categoriaId) {
    if (!ancestros(prod.categoriaId, padre).includes(r.categoriaId)) return -1
    s += 200 + nivel(r.categoriaId, padre)
  }
  if (r.proveedorId) {
    if (r.proveedorId !== prod.proveedorId) return -1
    s += 100 // cat+prov = 300+nivel > cat = 200+nivel > prov = 100 > general = 0
  }
  return s
}

export function reglaGanadora(reglas, prod, padre) {
  let mejor = null, mejorS = -1
  for (const r of reglas || []) {
    const s = puntajeRegla(r, prod, padre)
    if (s > mejorS) { mejor = r; mejorS = s }
  }
  return mejor
}

function redondear(n, paso) {
  const p = Number(paso) || 0
  if (p > 0) return Math.round(n / p) * p
  return Math.round(n * 100) / 100
}

// Aplica una regla sobre una base (pesos). null si no hay regla.
export function aplicarRegla(regla, base, redondeo) {
  if (!regla) return null
  const v = Number(regla.valor)
  let n
  // V2.110.0: un precio fijo se respeta tal cual (ej. el redondeo "a mano" de una lista importada
  // desde Excel) — el redondeo de la lista es solo para precios calculados (% o $).
  if (regla.tipo === 'MANUAL') return Math.max(0, Math.round(v * 100) / 100)
  if (regla.tipo === 'MONTO') n = Number(base) + v
  else n = Number(base) * (1 + v / 100)
  return Math.max(0, redondear(n, redondeo))
}

// Precio principal calculado (en PESOS) para un producto/variante con costo en pesos.
// Devuelve { precio, regla } o null si no corresponde recalcular (manual o sin regla).
export function calcularPrincipalPesos(cfg, prod, costoPesos) {
  if (!cfg.principal) return null
  const regla = reglaGanadora(cfg.principal.reglas, prod, cfg.padre)
  if (!regla) return null
  return { precio: aplicarRegla(regla, costoPesos, cfg.principal.redondeo), regla }
}

// Precio de una lista secundaria (pesos) dado el precio principal y el costo (ambos en pesos).
export function precioListaPesos(cfg, lista, prod, principalPesos, costoPesos) {
  if (!lista || lista.esDefault) return principalPesos
  const regla = reglaGanadora(lista.reglas, prod, cfg.padre)
  if (!regla) return principalPesos // sin regla: igual que la principal (comportamiento de siempre)
  const base = lista.base === 'COSTO' ? costoPesos : principalPesos
  return aplicarRegla(regla, base, lista.redondeo)
}

// Agrega `preciosListas: {listaId: precioPesos}` al producto y a cada variante (para Caja,
// Inventario y etiquetas). Los productos ya tienen que venir en pesos (listaEnPesos antes).
export async function conPreciosListas(tenantId, productos, db) {
  const cfg = await cargarConfigListas(tenantId, db)
  const secundarias = cfg.listas.filter((l) => !l.esDefault)
  if (!secundarias.length) return productos
  return productos.map((p) => {
    if (!p) return p
    const calc = (x) => {
      const pv = Number(x.precioVenta ?? p.precioVenta ?? 0)
      const pc = Number(x.precioCosto ?? p.precioCosto ?? 0)
      const out = {}
      for (const l of secundarias) out[l.id] = precioListaPesos(cfg, l, p, pv, pc)
      return out
    }
    return {
      ...p,
      preciosListas: calc(p),
      ...(p.variantes && { variantes: p.variantes.map((v) => ({ ...v, preciosListas: calc(v) })) }),
    }
  })
}

// Lo que haría la principal sobre un producto (con variantes con costo propio). Todo en la
// moneda del producto para poder guardarlo directo. Devuelve null si no hay regla.
function nuevosPreciosProducto(cfg, prod, cot) {
  const usd = prod.moneda === 'USD'
  if (usd && !(cot > 0)) return null
  const costoP = Number(aPesos(prod.precioCosto, prod.moneda, cot) || 0)
  const r = calcularPrincipalPesos(cfg, prod, costoP)
  if (!r) return null
  const aMoneda = (n) => (usd ? desdePesos(n, 'USD', cot) : n)
  const variantes = []
  for (const v of prod.variantes || []) {
    if (v.precioCosto == null) continue // sin costo propio: hereda el precio del producto
    const cv = Number(aPesos(v.precioCosto, prod.moneda, cot) || 0)
    const rv = calcularPrincipalPesos(cfg, prod, cv)
    variantes.push({ id: v.id, antes: v.precioVenta == null ? null : Number(v.precioVenta), despues: aMoneda(rv.precio) })
  }
  return { regla: r.regla, despues: aMoneda(r.precio), despuesPesos: r.precio, variantes }
}

const SELECT_RECALC = {
  id: true, sku: true, nombre: true, moneda: true, precioCosto: true, precioVenta: true, precioManual: true,
  categoriaId: true, proveedorId: true,
  categoria: { select: { nombre: true } }, proveedor: { select: { nombre: true } },
  variantes: { select: { id: true, precioCosto: true, precioVenta: true } },
}

// Recalcula la principal de algunos productos (después de cambiar un costo). No hace nada si el
// dueño todavía no activó el cálculo automático (1er "Aplicar" de la vista previa) o si el
// producto es manual. Devuelve cuántos productos cambiaron de precio.
export async function recalcularPrincipal(tenantId, productoIds, db) {
  const d = db || prismaDefault
  const ids = [...new Set((productoIds || []).filter(Boolean))]
  if (!ids.length) return 0
  const cfg = await cargarConfigListas(tenantId, d)
  if (!cfg.principal || !cfg.principal.autoActiva || !cfg.principal.reglas.length) return 0
  const prods = await d.producto.findMany({ where: { tenantId, id: { in: ids }, precioManual: false }, select: SELECT_RECALC })
  const cot = prods.some((p) => p.moneda === 'USD') ? await cotizacionDefault(tenantId, d) : 0
  let n = 0
  for (const p of prods) {
    const r = nuevosPreciosProducto(cfg, p, cot)
    if (!r) continue
    if (r.despues != null && Number(r.despues) !== Number(p.precioVenta)) {
      await d.producto.update({ where: { id: p.id }, data: { precioVenta: r.despues } })
      n++
    }
    for (const v of r.variantes) {
      if (v.despues != null && v.despues !== v.antes) await d.productoVariante.update({ where: { id: v.id }, data: { precioVenta: v.despues } })
    }
  }
  return n
}

// Vista previa de "aplicar la lista principal" sobre todo el catálogo activo.
// excluir = { productoIds, categoriaIds, proveedorIds } → esos quedan manuales con su precio actual.
export async function previewPrincipal(tenantId, excluir = {}, db) {
  const d = db || prismaDefault
  const cfg = await cargarConfigListas(tenantId, d)
  if (!cfg.principal) return { items: [], resumen: { cambian: 0, iguales: 0, manuales: 0, sinRegla: 0, excluidos: 0, sinCotizacion: 0 } }
  const prods = await d.producto.findMany({ where: { tenantId, activo: true }, select: SELECT_RECALC, orderBy: { nombre: 'asc' } })
  const cot = await cotizacionDefault(tenantId, d)
  const exP = new Set(excluir.productoIds || [])
  const exC = new Set(excluir.categoriaIds || [])
  const exV = new Set(excluir.proveedorIds || [])
  const esExcluido = (p) => exP.has(p.id) || (p.proveedorId && exV.has(p.proveedorId)) ||
    ancestros(p.categoriaId, cfg.padre).some((c) => exC.has(c))
  const items = []
  const resumen = { cambian: 0, iguales: 0, manuales: 0, sinRegla: 0, excluidos: 0, sinCotizacion: 0 }
  for (const p of prods) {
    const antesPesos = Number(aPesos(p.precioVenta, p.moneda, cot) || 0)
    const base = {
      id: p.id, sku: p.sku, nombre: p.nombre, moneda: p.moneda,
      categoria: p.categoria?.nombre || null, proveedor: p.proveedor?.nombre || null,
      costo: Number(aPesos(p.precioCosto, p.moneda, cot) || 0), antes: antesPesos,
    }
    if (p.precioManual) { resumen.manuales++; items.push({ ...base, estado: 'manual', despues: antesPesos }); continue }
    if (p.moneda === 'USD' && !(cot > 0)) { resumen.sinCotizacion++; items.push({ ...base, estado: 'sin_cotizacion', despues: antesPesos }); continue }
    const r = nuevosPreciosProducto(cfg, p, cot)
    if (!r) { resumen.sinRegla++; items.push({ ...base, estado: 'sin_regla', despues: antesPesos }); continue }
    if (esExcluido(p)) { resumen.excluidos++; items.push({ ...base, estado: 'excluido', despues: antesPesos, reglaId: r.regla.id }); continue }
    const cambia = Number(r.despues) !== Number(p.precioVenta) || r.variantes.some((v) => v.despues !== v.antes)
    if (cambia) resumen.cambian++; else resumen.iguales++
    items.push({ ...base, estado: cambia ? 'cambia' : 'igual', despues: r.despuesPesos, reglaId: r.regla.id })
  }
  return { items, resumen }
}

// Aplica la principal: excluidos → precioManual=true (conservan su precio); el resto se recalcula.
// Activa el cálculo automático (autoActiva) para que los próximos cambios de costo recalculen solos.
export async function aplicarPrincipal(tenantId, excluir = {}, db) {
  const d = db || prismaDefault
  const cfg = await cargarConfigListas(tenantId, d)
  if (!cfg.principal) return { actualizados: 0, excluidos: 0 }
  const prev = await previewPrincipal(tenantId, excluir, d)
  const aExcluir = prev.items.filter((i) => i.estado === 'excluido').map((i) => i.id)
  const aCambiar = prev.items.filter((i) => i.estado === 'cambia').map((i) => i.id)
  if (aExcluir.length) await d.producto.updateMany({ where: { tenantId, id: { in: aExcluir } }, data: { precioManual: true } })
  await d.listaPrecio.update({ where: { id: cfg.principal.id }, data: { autoActiva: true } })
  invalidarListas(tenantId)
  // Se recalcula en tandas para no armar una transacción gigante contra la base remota.
  let actualizados = 0
  for (let i = 0; i < aCambiar.length; i += 200) {
    actualizados += await recalcularPrincipal(tenantId, aCambiar.slice(i, i + 200), d)
  }
  return { actualizados, excluidos: aExcluir.length }
}
