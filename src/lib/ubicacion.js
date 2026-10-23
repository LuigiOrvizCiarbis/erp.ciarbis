// ─────────────────────────────────────────────────────────────
//  Ubicación en depósito (V2.105.0)
//  Pasillo / Estante / Cajón de un producto o de una variante, POR SUCURSAL: vive en las mismas
//  filas que el stock por sucursal (productos_sucursales / variantes_sucursales). Una variante
//  con un nivel vacío hereda ese nivel del producto (ej. mismo pasillo y estante, otro cajón)
//  — la herencia se resuelve al mostrar, acá se guarda solo lo que se cargó.
// ─────────────────────────────────────────────────────────────

import { z } from 'zod'

export const NIVELES_UBICACION = ['pasillo', 'estante', 'cajon']

const nivel = z.string().max(30).nullable().optional()
export const ubicacionesSchema = z.array(z.object({
  sucursalId: z.string().min(1),
  pasillo: nivel,
  estante: nivel,
  cajon: nivel,
})).max(50)

// "  p1 " → "P1"; vacío → null (borra el nivel). undefined = no se mandó, no se toca.
function limpiar(v) {
  if (v === undefined) return undefined
  const s = String(v ?? '').trim().toUpperCase()
  return s || null
}

// {pasillo, estante, cajon} de una fila por sucursal, o null si no tiene ningún nivel cargado.
export function ubicacionDe(fila) {
  if (!fila) return null
  const u = {}
  let alguno = false
  NIVELES_UBICACION.forEach((n) => { u[n] = fila[n] || null; if (u[n]) alguno = true })
  return alguno ? u : null
}

// Variante: cada nivel vacío cae al del producto.
export function ubicacionEfectiva(propia, delProducto) {
  if (!propia) return delProducto || null
  if (!delProducto) return propia
  const u = {}
  NIVELES_UBICACION.forEach((n) => { u[n] = propia[n] || delProducto[n] || null })
  return u
}

// Guarda la ubicación de un producto (o de una variante si viene varianteId) en una o más
// sucursales. Crea la fila por sucursal si no existía (stock 0: no mueve stock ni el total).
// Solo acepta sucursales de la empresa — una ajena se ignora en silencio.
export async function guardarUbicaciones(tx, tenantId, { productoId, varianteId }, ubicaciones) {
  if (!ubicaciones?.length) return
  const validas = await tx.sucursal.findMany({
    where: { tenantId, id: { in: ubicaciones.map((u) => u.sucursalId) } },
    select: { id: true },
  })
  const ids = new Set(validas.map((s) => s.id))
  for (const u of ubicaciones) {
    if (!ids.has(u.sucursalId)) continue
    const data = {}
    NIVELES_UBICACION.forEach((n) => { const v = limpiar(u[n]); if (v !== undefined) data[n] = v })
    if (!Object.keys(data).length) continue
    if (varianteId) {
      await tx.varianteSucursal.upsert({
        where: { varianteId_sucursalId: { varianteId, sucursalId: u.sucursalId } },
        create: { varianteId, sucursalId: u.sucursalId, ...data },
        update: data,
      })
    } else {
      await tx.productoSucursal.upsert({
        where: { productoId_sucursalId: { productoId, sucursalId: u.sucursalId } },
        create: { productoId, sucursalId: u.sucursalId, ...data },
        update: data,
      })
    }
  }
}

// Filtro Prisma "esta fila por sucursal tiene algún nivel que contiene q" (buscador de Inventario).
export function filtroUbicacionContiene(sucursalId, q) {
  return {
    sucursalId,
    OR: NIVELES_UBICACION.map((n) => ({ [n]: { contains: q, mode: 'insensitive' } })),
  }
}

// Niveles visibles con su nombre (Configuración > Variantes, kv "variantes.ubicacionNiveles":
// {pasillo:{label,activo}, ...}) — default Pasillo/Estante/Cajón, los 3 visibles.
const LABELS_DEFAULT = { pasillo: 'Pasillo', estante: 'Estante', cajon: 'Cajón' }
export async function nivelesUbicacionActivos(db, tenantId) {
  const kv = await db.configuracionEmpresa.findFirst({ where: { tenantId, clave: 'variantes.ubicacionNiveles' } })
  let cfg = {}
  try { cfg = JSON.parse(kv?.valor || '{}') || {} } catch (e) {}
  return NIVELES_UBICACION
    .map((n) => ({ clave: n, label: cfg[n]?.label || LABELS_DEFAULT[n], activo: cfg[n]?.activo !== false }))
    .filter((n) => n.activo)
}

// Orden "natural" (P2 antes que P10) para ordenar/agrupar por ubicación.
export function compararUbicacion(a, b) {
  for (const n of NIVELES_UBICACION) {
    const va = a?.[n] || '', vb = b?.[n] || ''
    if (va === vb) continue
    if (!va) return 1 // sin ubicación al final
    if (!vb) return -1
    return va.localeCompare(vb, 'es', { numeric: true })
  }
  return 0
}
