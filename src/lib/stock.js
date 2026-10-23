// ─────────────────────────────────────────────────────────────
//  Stock por sucursal (V2.104.0)
//  El producto/variante se da de alta una vez para toda la cuenta; el stock vive por sucursal
//  (productos_sucursales / variantes_sucursales) y Producto.stock / ProductoVariante.stock son
//  siempre la SUMA de esas filas — un caché del total para que todo lo que ya leía el total
//  (PoS, alertas, reportes, valorizado) siga andando igual. Por eso TODO movimiento de stock
//  tiene que pasar por acá: si alguien escribe el total a mano, total y sucursales se desfasan.
// ─────────────────────────────────────────────────────────────

// Sucursal donde impacta un movimiento: la que manda el pedido (si es de la empresa y está
// activa) → la asignada al usuario → la principal → la más vieja activa. null solo si la
// empresa no tiene ninguna sucursal activa (entonces se mueve únicamente el total).
export async function resolverSucursalStock(db, tenantId, sucursalId, user) {
  const activas = await db.sucursal.findMany({
    where: { tenantId, activa: true },
    select: { id: true, esPrincipal: true },
    orderBy: [{ esPrincipal: 'desc' }, { creadoEn: 'asc' }],
  })
  if (!activas.length) return null
  const ids = new Set(activas.map((s) => s.id))
  if (sucursalId && ids.has(sucursalId)) return sucursalId
  if (user?.sucursalId && ids.has(user.sucursalId)) return user.sucursalId
  return activas[0].id
}

// Error con status para que la ruta lo devuelva tal cual (ej. merma/transferencia sin stock).
export class StockError extends Error {
  constructor(message, status = 400) { super(message); this.status = status }
}

// Mueve `delta` unidades (positivo = entra, negativo = sale) de un producto o de una variante
// en una sucursal, y el total en la misma cantidad. Atómico por fila (increment), seguro con
// dos cajas vendiendo a la vez. Devuelve { total, sucursal } ya actualizados.
// opts.soloSucursal: mueve la fila de la sucursal sin tocar el total (lo usa la transferencia,
// que saca de una y pone en otra — el total no cambia).
// opts.marcarMovimiento: variante.tuvoMovimiento = true (no se puede borrar una variante que se movió).
export async function moverStock(tx, { productoId, varianteId, sucursalId, delta }, opts = {}) {
  const d = Number(delta) || 0
  let total = null
  if (!opts.soloSucursal) {
    if (varianteId) {
      const v = await tx.productoVariante.update({
        where: { id: varianteId },
        data: { stock: { increment: d }, ...(opts.marcarMovimiento !== false && { tuvoMovimiento: true }) },
        select: { stock: true },
      })
      total = Number(v.stock)
    } else {
      const p = await tx.producto.update({ where: { id: productoId }, data: { stock: { increment: d } }, select: { stock: true } })
      total = Number(p.stock)
    }
  }
  let sucursal = null
  if (sucursalId) {
    const fila = varianteId
      ? await tx.varianteSucursal.upsert({
        where: { varianteId_sucursalId: { varianteId, sucursalId } },
        create: { varianteId, sucursalId, stock: d },
        update: { stock: { increment: d } },
        select: { stock: true },
      })
      : await tx.productoSucursal.upsert({
        where: { productoId_sucursalId: { productoId, sucursalId } },
        create: { productoId, sucursalId, stock: d },
        update: { stock: { increment: d } },
        select: { stock: true },
      })
    sucursal = Number(fila.stock)
  }
  return { total, sucursal }
}

// Stock actual de un producto/variante en una sucursal (0 si nunca tuvo fila). Sin sucursal
// (empresa sin sucursales activas) devuelve el total.
export async function stockEnSucursal(db, { productoId, varianteId, sucursalId }) {
  if (!sucursalId) {
    const r = varianteId
      ? await db.productoVariante.findUnique({ where: { id: varianteId }, select: { stock: true } })
      : await db.producto.findUnique({ where: { id: productoId }, select: { stock: true } })
    return Number(r?.stock || 0)
  }
  const fila = varianteId
    ? await db.varianteSucursal.findUnique({ where: { varianteId_sucursalId: { varianteId, sucursalId } }, select: { stock: true } })
    : await db.productoSucursal.findUnique({ where: { productoId_sucursalId: { productoId, sucursalId } }, select: { stock: true } })
  return Number(fila?.stock || 0)
}

// "El stock de esta sucursal ahora es N" (inventario físico / Modificar stock): calcula la
// diferencia contra lo que había EN ESA SUCURSAL y la mueve (el total se ajusta solo).
export async function fijarStockSucursal(tx, { productoId, varianteId, sucursalId, valor }, opts = {}) {
  const antes = await stockEnSucursal(tx, { productoId, varianteId, sucursalId })
  const delta = Number(valor) - antes
  const r = delta !== 0 ? await moverStock(tx, { productoId, varianteId, sucursalId, delta }, opts) : await (async () => ({
    total: Number((varianteId
      ? await tx.productoVariante.findUnique({ where: { id: varianteId }, select: { stock: true } })
      : await tx.producto.findUnique({ where: { id: productoId }, select: { stock: true } }))?.stock || 0),
    sucursal: antes,
  }))()
  return { antes, despues: Number(valor), delta, ...r }
}
