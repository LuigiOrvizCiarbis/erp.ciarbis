// ─────────────────────────────────────────────
//  Snapshot silencioso de cotización — se llama desde cada endpoint que crea una
//  transacción con monto (Ticket, OrdenCompra, Gasto, Ingreso, PagoProveedor,
//  PagoPlanCliente). Completa cotizacionTipo/cotizacionValor/montoUSD SOLO, sin que
//  el frontend tenga que mandar nada — el operario nunca ve un paso extra. El valor
//  guardado no se recalcula después: es el real de ese momento, para que la
//  evolución en USD del negocio no se falsee reconvirtiendo con la cotización de hoy.
// ─────────────────────────────────────────────

import { prisma as prismaDefault } from './prisma.js'

export const CLAVES_COTIZACION = [
  'oficialCompra', 'oficialVenta', 'blueCompra', 'blueVenta',
  'usdtCompra', 'usdtVenta', 'manualCompra', 'manualVenta',
]

// `override` = {tipo, valor} opcional — el usuario eligió otra cotización para ESTA
// operación puntual desde el chip del formulario (ver dashboard.html). Si no hay fila de
// CotizacionDolar todavía, o el valor elegido nunca se cargó (sigue en 0), no rompe la
// transacción — devuelve todo null y el snapshot queda vacío hasta que el tenant cargue una vez.
export async function snapshotCotizacion(tenantId, monto, override, prisma) {
  const client = prisma || prismaDefault
  const montoNum = Number(monto) || 0

  let tipo, valor
  if (override && CLAVES_COTIZACION.includes(override.tipo) && Number(override.valor) > 0) {
    tipo = override.tipo
    valor = Number(override.valor)
  } else {
    const cot = await client.cotizacionDolar.findUnique({ where: { tenantId } })
    if (!cot) return { cotizacionTipo: null, cotizacionValor: null, montoUSD: null }
    tipo = CLAVES_COTIZACION.includes(cot.tipoDefault) ? cot.tipoDefault : 'oficialVenta'
    valor = Number(cot[tipo]) || 0
  }

  if (!valor) return { cotizacionTipo: tipo, cotizacionValor: null, montoUSD: null }

  return {
    cotizacionTipo: tipo,
    cotizacionValor: valor,
    montoUSD: Math.round((montoNum / valor) * 100) / 100,
  }
}
