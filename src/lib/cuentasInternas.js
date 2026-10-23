// ─────────────────────────────────────────────────────────────
//  Fondo y Transferencia Dueño — dos "cuentas" con el mismo comportamiento (suben y bajan por
//  movimientos), usadas como fuente de pago para Gastos/PagoProveedor cuando no se paga desde
//  una caja. El saldo NO se guarda como campo aparte — se suma de MovimientoCuentaInterna en el
//  momento, para que nunca se pueda desincronizar del historial real.
// ─────────────────────────────────────────────────────────────

import { prisma } from './prisma.js'

export async function asegurarCuentaInterna(tenantId, tipo) {
  const existente = await prisma.cuentaInterna.findUnique({ where: { tenantId_tipo: { tenantId, tipo } } })
  if (existente) return existente
  return prisma.cuentaInterna.create({ data: { tenantId, tipo } })
}

export async function saldoCuentaInterna(cuentaId) {
  const agg = await prisma.movimientoCuentaInterna.groupBy({
    by: ['tipo'],
    where: { cuentaId },
    _sum: { monto: true },
  })
  const ingreso = Number(agg.find(a => a.tipo === 'INGRESO')?._sum.monto || 0)
  const egreso = Number(agg.find(a => a.tipo === 'EGRESO')?._sum.monto || 0)
  return ingreso - egreso
}

// tx opcional — para poder encadenar el movimiento dentro de la misma transacción que crea el
// Gasto/PagoProveedor (si el gasto falla, el movimiento de cuenta tampoco debe quedar).
export async function registrarMovimientoCuentaInterna({ tenantId, tipoCuenta, tipoMovimiento, monto, concepto, usuarioId }, tx = prisma) {
  const cuenta = await asegurarCuentaInterna(tenantId, tipoCuenta)
  return tx.movimientoCuentaInterna.create({
    data: { cuentaId: cuenta.id, tipo: tipoMovimiento, monto, concepto, usuarioId },
  })
}

// Valida que, si formaPago=CAJA, la sesión indicada exista, esté abierta, sea del tenant, y que
// un no-admin solo pueda usar SU PROPIA sesión (nunca la de otro cajero). Devuelve la sesión o
// tira un error con .status/.body listo para responder.
export async function validarCajaParaPago(req, cajaSesionId) {
  if (!cajaSesionId) {
    const e = new Error('cajaSesionId requerido cuando formaPago=CAJA')
    e.status = 400; e.body = { error: 'validation_error', message: e.message }
    throw e
  }
  const caja = await prisma.cajaSesion.findFirst({ where: { id: cajaSesionId, tenantId: req.tenantId } })
  if (!caja) {
    const e = new Error('Caja no encontrada.')
    e.status = 404; e.body = { error: 'not_found', message: e.message }
    throw e
  }
  if (caja.estado !== 'ABIERTA') {
    const e = new Error('Esa caja ya está cerrada.')
    e.status = 409; e.body = { error: 'caja_cerrada', message: e.message }
    throw e
  }
  if (req.user.rol !== 'ADMIN' && caja.usuarioId !== req.user.id) {
    const e = new Error('Solo podés pagar desde tu propia caja.')
    e.status = 403; e.body = { error: 'forbidden', message: e.message }
    throw e
  }
  return caja
}
