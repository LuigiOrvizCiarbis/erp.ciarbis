// ─────────────────────────────────────────────────────────────
//  Rutas: /api/v1/reportes
//  KPIs dashboard, ventas, inventario — discriminado X / FC
// ─────────────────────────────────────────────────────────────

import { prisma } from '../../lib/prisma.js'

export default async function reportesRoutes(fastify) {
  const auth = { preHandler: [fastify.verifyJWT, fastify.verifyTenant] }

  // ── GET /reportes/dashboard ───────────────────────────────
  // KPIs principales para el dashboard
  fastify.get('/reportes/dashboard', auth, async (req) => {
    const { desde, hasta } = req.query
    const hoy = new Date()
    const inicioMes = new Date(hoy.getFullYear(), hoy.getMonth(), 1)
    const finMes = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0, 23, 59, 59)

    const dateFilter = {
      gte: desde ? new Date(desde) : inicioMes,
      lte: hasta ? new Date(hasta) : finMes,
    }

    const [ticketsMes, ordenesMes, productosAlerta, clientesActivos] = await Promise.all([
      // Ventas del período
      prisma.ticket.findMany({
        where: { tenantId: req.tenantId, estado: 'EMITIDO', fecha: dateFilter },
        select: { total: true, tipo: true, facturaEmitida: true },
      }),
      // Órdenes de venta del período
      prisma.ordenVenta.count({
        where: { tenantId: req.tenantId, fecha: dateFilter, estado: { not: 'CANCELADA' } },
      }),
      // Productos bajo stock
      prisma.producto.count({
        where: { tenantId: req.tenantId, activo: true },
      }),
      // Clientes activos
      prisma.cliente.count({ where: { tenantId: req.tenantId, activo: true } }),
    ])

    // Calcular totales discriminados por tipo
    const totalVentas = ticketsMes.reduce((s, t) => s + Number(t.total), 0)
    const totalFacturado = ticketsMes.filter(t => t.facturaEmitida).reduce((s, t) => s + Number(t.total), 0)
    const totalX = ticketsMes.filter(t => !t.facturaEmitida).reduce((s, t) => s + Number(t.total), 0)
    const cantTickets = ticketsMes.length
    const cantFacturadas = ticketsMes.filter(t => t.facturaEmitida).length

    // Productos bajo stock
    const productosTotal = await prisma.producto.findMany({
      where: { tenantId: req.tenantId, activo: true },
      select: { stock: true, stockMin: true },
    })
    const enAlerta = productosTotal.filter(p => Number(p.stock) <= Number(p.stockMin)).length

    return {
      periodo: { desde: dateFilter.gte, hasta: dateFilter.lte },
      ventas: {
        total: totalVentas,
        facturas: totalFacturado,
        comprobantesX: totalX,
        cantTickets,
        cantFacturadas,
        promedioTicket: cantTickets > 0 ? totalVentas / cantTickets : 0,
      },
      ordenes: { total: ordenesMes },
      inventario: { totalProductos: productosAlerta, enAlerta },
      clientes: { activos: clientesActivos },
    }
  })

  // ── GET /reportes/finanzas-resumen ────────────────────────
  // Alimenta Finanzas > Contable (punto 3 del pedido grande 2026-08-06): facturado del período
  // discriminado por medio de pago + snapshot de deuda en cuenta corriente (esto último no es
  // "del período", es el saldo actual de cada cliente — pensado para negocios con financiación
  // por cuota que necesitan ver quién debe y cuánto en cualquier momento, no solo lo vendido).
  fastify.get('/reportes/finanzas-resumen', auth, async (req) => {
    const { desde, hasta, sucursalId } = req.query
    const dateFilter = {}
    if (desde) dateFilter.gte = new Date(desde)
    if (hasta) dateFilter.lte = new Date(hasta)
    const tickets = await prisma.ticket.findMany({
      where: { tenantId: req.tenantId, estado: 'EMITIDO', ...(sucursalId && { sucursalId }), ...(desde || hasta ? { fecha: dateFilter } : {}) },
      select: { total: true, medioPago: true },
    })
    const facturado = tickets.reduce((s, t) => s + Number(t.total), 0)
    const porMedioPago = {}
    for (const t of tickets) {
      const m = t.medioPago || 'OTRO'
      porMedioPago[m] = (porMedioPago[m] || 0) + Number(t.total)
    }
    const clientesDeuda = await prisma.cliente.findMany({
      where: { tenantId: req.tenantId, saldo: { not: 0 } },
      select: { id: true, nombre: true, empresa: true, saldo: true, limiteCred: true },
      orderBy: { saldo: 'asc' },
    })
    const pendienteCtaCte = clientesDeuda.reduce((s, c) => s + (Number(c.saldo) < 0 ? -Number(c.saldo) : 0), 0)

    // Egresos del período (punto 6): gastos + pagos a proveedores, ambos ya tienen su propio
    // modelo con fecha/monto — se suman directo, no hace falta pasar por Ticket.
    const [gastos, pagosProveedor, proveedoresDeuda] = await Promise.all([
      prisma.gasto.findMany({
        where: { tenantId: req.tenantId, activo: true, ...(sucursalId && { sucursalId }), ...(desde || hasta ? { fecha: dateFilter } : {}) },
        select: { monto: true },
      }),
      prisma.pagoProveedor.findMany({
        where: { tenantId: req.tenantId, ...(desde || hasta ? { fecha: dateFilter } : {}) },
        select: { monto: true },
      }),
      prisma.proveedor.findMany({
        where: { tenantId: req.tenantId, saldo: { not: 0 } },
        select: { id: true, nombre: true, saldo: true },
        orderBy: { saldo: 'asc' },
      }),
    ])
    const egresosGastos = gastos.reduce((s, g) => s + Number(g.monto), 0)
    const egresosPagoProveedores = pagosProveedor.reduce((s, p) => s + Number(p.monto), 0)
    const ctaCteProveedores = proveedoresDeuda.reduce((s, p) => s + (Number(p.saldo) < 0 ? -Number(p.saldo) : 0), 0)

    return {
      facturado, porMedioPago, pendienteCtaCte, clientesDeuda,
      egresosGastos, egresosPagoProveedores, ctaCteProveedores, proveedoresDeuda,
    }
  })

  // ── GET /reportes/ventas ──────────────────────────────────
  // Ventas por período — discriminado X/FC con totales
  fastify.get('/reportes/ventas', auth, async (req) => {
    const { desde, hasta, agrupar = 'dia', sucursalId } = req.query
    const hoy = new Date()
    const dateFilter = {
      gte: desde ? new Date(desde) : new Date(hoy.getFullYear(), hoy.getMonth(), 1),
      lte: hasta ? new Date(hasta) : hoy,
    }

    const tickets = await prisma.ticket.findMany({
      where: {
        tenantId: req.tenantId,
        estado: 'EMITIDO',
        ...(sucursalId && { sucursalId }),
        fecha: dateFilter,
      },
      select: {
        id: true, nro: true, fecha: true, total: true,
        tipo: true, facturaEmitida: true, facturaNro: true,
        cliente: { select: { id: true, nombre: true } },
      },
      orderBy: { fecha: 'asc' },
    })

    // Totales generales
    const resumen = {
      total: tickets.reduce((s, t) => s + Number(t.total), 0),
      facturas: tickets.filter(t => t.facturaEmitida).reduce((s, t) => s + Number(t.total), 0),
      comprobantesX: tickets.filter(t => !t.facturaEmitida).reduce((s, t) => s + Number(t.total), 0),
      cantTotal: tickets.length,
      cantFacturadas: tickets.filter(t => t.facturaEmitida).length,
      cantX: tickets.filter(t => !t.facturaEmitida).length,
    }

    // Agrupar por día / semana / mes
    const grupos = {}
    for (const t of tickets) {
      let key
      const d = new Date(t.fecha)
      if (agrupar === 'mes') key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      else if (agrupar === 'semana') {
        const w = Math.ceil(d.getDate() / 7)
        key = `${d.getFullYear()}-S${String(w).padStart(2, '0')}`
      } else {
        key = d.toISOString().split('T')[0]
      }

      if (!grupos[key]) grupos[key] = { fecha: key, total: 0, facturas: 0, comprobantesX: 0, cantidad: 0 }
      grupos[key].total += Number(t.total)
      grupos[key].cantidad++
      if (t.facturaEmitida) grupos[key].facturas += Number(t.total)
      else grupos[key].comprobantesX += Number(t.total)
    }

    return {
      resumen,
      serie: Object.values(grupos),
      detalle: tickets,
    }
  })

  // ── GET /reportes/libro-contable ──────────────────────────
  // Una sola tabla (no dos vistas separadas) con filtro de Área (Producto/Servicio/General) y
  // Sucursal — decisión tomada con el usuario 2026-08-10. Junta Gasto (Debe) con los ingresos
  // del área elegida: Ticket.total si area=PRODUCTO (venta de productos, Ticket ya tiene
  // sucursalId), o PagoPlanCliente.monto si area=SERVICIO (cobro de planes/suscripciones) —
  // Haber. Si no se pasa area, junta TODO (gastos de cualquier área + ambos tipos de ingreso).
  // Calcula saldo corrido fila por fila, más los 3 totales del período para el header fijo de
  // la tabla (no tarjetas KPI, una sola fila).
  fastify.get('/reportes/libro-contable', auth, async (req) => {
    const { desde, hasta, area, sucursalId } = req.query
    const dateFilter = {}
    if (desde) dateFilter.gte = new Date(desde)
    if (hasta) dateFilter.lte = new Date(hasta + (hasta.length === 10 ? 'T23:59:59' : ''))

    const gastosWhere = {
      tenantId: req.tenantId, activo: true,
      ...(area && { area }),
      ...(sucursalId && { sucursalId }),
      ...((desde || hasta) && { fecha: dateFilter }),
    }
    const ticketsWhere = {
      tenantId: req.tenantId, estado: 'EMITIDO',
      ...(sucursalId && { sucursalId }),
      ...((desde || hasta) && { fecha: dateFilter }),
    }
    const pagosPlanWhere = {
      plan: { tenantId: req.tenantId },
      ...(sucursalId && { sucursalId }),
      ...((desde || hasta) && { fecha: dateFilter }),
    }
    const ingresosWhere = {
      tenantId: req.tenantId, activo: true,
      ...(area && { area }),
      ...(sucursalId && { sucursalId }),
      ...((desde || hasta) && { fecha: dateFilter }),
    }

    const [gastos, tickets, pagosPlan, ingresos] = await Promise.all([
      prisma.gasto.findMany({
        where: gastosWhere,
        select: { id: true, fecha: true, monto: true, categoria: true, descripcion: true },
      }),
      (!area || area === 'PRODUCTO') ? prisma.ticket.findMany({
        where: ticketsWhere,
        select: { id: true, fecha: true, total: true, nro: true, cliente: { select: { nombre: true } } },
      }) : [],
      (!area || area === 'SERVICIO') ? prisma.pagoPlanCliente.findMany({
        where: pagosPlanWhere,
        select: { id: true, fecha: true, monto: true, plan: { select: { nombre: true, cliente: { select: { nombre: true } } } } },
      }) : [],
      prisma.ingreso.findMany({
        where: ingresosWhere,
        select: { id: true, fecha: true, monto: true, categoria: true, descripcion: true },
      }),
    ])

    const movimientos = [
      ...gastos.map(g => ({
        fecha: g.fecha, debe: Number(g.monto), haber: 0,
        descripcion: g.categoria + (g.descripcion ? ' — ' + g.descripcion : ''),
        origen: 'GASTO', id: g.id,
      })),
      ...tickets.map(t => ({
        fecha: t.fecha, debe: 0, haber: Number(t.total),
        descripcion: 'Venta #' + t.nro + ' — ' + (t.cliente?.nombre || 'Consumidor Final'),
        origen: 'TICKET', id: t.id,
      })),
      ...pagosPlan.map(p => ({
        fecha: p.fecha, debe: 0, haber: Number(p.monto),
        descripcion: 'Pago plan "' + p.plan.nombre + '" — ' + p.plan.cliente.nombre,
        origen: 'PAGO_PLAN', id: p.id,
      })),
      ...ingresos.map(i => ({
        fecha: i.fecha, debe: 0, haber: Number(i.monto),
        descripcion: i.categoria + (i.descripcion ? ' — ' + i.descripcion : ''),
        origen: 'INGRESO', id: i.id,
      })),
    ].sort((a, b) => new Date(a.fecha) - new Date(b.fecha))

    let saldo = 0
    const filas = movimientos.map(m => {
      const saldoAnterior = saldo
      saldo = saldo + m.haber - m.debe
      return { ...m, saldoAnterior, saldoActual: saldo }
    })

    const totalGastos = gastos.reduce((s, g) => s + Number(g.monto), 0)
    const totalIngresos = tickets.reduce((s, t) => s + Number(t.total), 0) + pagosPlan.reduce((s, p) => s + Number(p.monto), 0) + ingresos.reduce((s, i) => s + Number(i.monto), 0)

    return {
      filas,
      totales: { gastos: totalGastos, ingresos: totalIngresos, neto: totalIngresos - totalGastos },
    }
  })

  // ── GET /reportes/historial-ventas ────────────────────────
  // Historial de ventas a nivel línea (no ticket) — para poder responder "¿cuánto vendí el mes
  // pasado de esta prenda / de esta categoría?", algo que ni /reportes/ventas (agregado por
  // ticket) ni /reportes/top-productos (ranking, sin filtro por categoría ni rango libre)
  // permitían. Paginado — puede haber miles de líneas en un mes con buen movimiento.
  fastify.get('/reportes/historial-ventas', auth, async (req) => {
    const { page = 1, limit = 50, desde, hasta, productoId, categoriaId, sucursalId, cajaSesionId, q, montoMin, montoMax } = req.query
    // hasta puede venir solo fecha ("2026-09-02", filtro de día) o fecha+hora completa
    // ("2026-09-02T18:00", el mismo input ahora sirve para acotar por hora dentro del día) —
    // solo se completa el final del día cuando no trae hora propia.
    const ticketWhere = {
      tenantId: req.tenantId,
      estado: 'EMITIDO',
      ...(sucursalId && { sucursalId }),
      ...(cajaSesionId && { cajaSesionId }),
      ...((desde || hasta) && {
        fecha: {
          ...(desde && { gte: new Date(desde) }),
          ...(hasta && { lte: new Date(hasta.includes('T') ? hasta : hasta + 'T23:59:59') }),
        },
      }),
      ...(montoMin || montoMax) && { total: { ...(montoMin && { gte: Number(montoMin) }), ...(montoMax && { lte: Number(montoMax) }) } },
    }
    const where = {
      ticket: ticketWhere,
      ...(productoId && { productoId }),
      ...(categoriaId && { producto: { categoriaId } }),
      // Buscar por N° de ticket, nombre de cliente O nombre del producto/ítem vendido en esa
      // línea — mismo criterio ya aplicado en /tickets y /ordenes-venta.
      ...(q && {
        OR: [
          { ticket: { nro: { equals: parseInt(q) || undefined } } },
          { ticket: { cliente: { nombre: { contains: q, mode: 'insensitive' } } } },
          { descripcion: { contains: q, mode: 'insensitive' } },
        ],
      }),
    }
    const [data, total, agregado, lineasCosto] = await prisma.$transaction([
      prisma.lineaTicket.findMany({
        where,
        include: {
          producto: { select: { id: true, nombre: true, sku: true, categoria: { select: { id: true, nombre: true } } } },
          ticket: { select: { nro: true, fecha: true, cliente: { select: { nombre: true } } } },
        },
        orderBy: { ticket: { fecha: 'desc' } },
        skip: (Number(page) - 1) * Number(limit),
        take: Number(limit),
      }),
      prisma.lineaTicket.count({ where }),
      prisma.lineaTicket.aggregate({ where, _sum: { cantidad: true, subtotal: true } }),
      // Ganancia real del período: suma (subtotal − cantidad×precioCosto) usando el snapshot de
      // costo de cada línea (ver LineaTicket.precioCosto), no el precioCosto *actual* del
      // producto — así una venta vieja sigue dando la ganancia que tuvo en su momento aunque el
      // costo del producto haya cambiado después. Líneas sin snapshot (ventas de antes de este
      // campo, o sin producto asociado) quedan afuera del cálculo de ganancia/margen — no se
      // puede inventar un costo que no se guardó.
      prisma.lineaTicket.findMany({ where, select: { cantidad: true, subtotal: true, precioCosto: true } }),
    ])
    let costoTotal = 0, ventaConCosto = 0
    for (const l of lineasCosto) {
      if (l.precioCosto == null) continue
      costoTotal += Number(l.cantidad) * Number(l.precioCosto)
      ventaConCosto += Number(l.subtotal)
    }
    const gananciaTotal = ventaConCosto - costoTotal
    const margenPct = costoTotal > 0 ? (gananciaTotal / costoTotal) * 100 : 0
    return {
      data,
      meta: { total, page: Number(page), limit: Number(limit) },
      resumen: {
        cantidad: Number(agregado._sum.cantidad || 0),
        total: Number(agregado._sum.subtotal || 0),
        gananciaTotal: Math.round(gananciaTotal * 100) / 100,
        margenPct: Math.round(margenPct * 10) / 10,
      },
    }
  })

  // ── GET /reportes/top-productos ───────────────────────────
  fastify.get('/reportes/top-productos', auth, async (req) => {
    const { desde, hasta, limit = 10 } = req.query
    const hoy = new Date()
    const dateFilter = {
      gte: desde ? new Date(desde) : new Date(hoy.getFullYear(), hoy.getMonth(), 1),
      lte: hasta ? new Date(hasta) : hoy,
    }

    const lineas = await prisma.lineaTicket.findMany({
      where: {
        ticket: { tenantId: req.tenantId, estado: 'EMITIDO', fecha: dateFilter },
        productoId: { not: null },
      },
      select: {
        productoId: true,
        descripcion: true,
        cantidad: true,
        subtotal: true,
        producto: { select: { nombre: true, sku: true } },
      },
    })

    const agrupado = {}
    for (const l of lineas) {
      if (!agrupado[l.productoId]) {
        agrupado[l.productoId] = { productoId: l.productoId, nombre: l.producto?.nombre || l.descripcion, sku: l.producto?.sku, cantidad: 0, total: 0 }
      }
      agrupado[l.productoId].cantidad += Number(l.cantidad)
      agrupado[l.productoId].total += Number(l.subtotal)
    }

    const ranking = Object.values(agrupado)
      .sort((a, b) => b.total - a.total)
      .slice(0, Number(limit))

    return ranking
  })

  // ── GET /reportes/compras ─────────────────────────────────
  fastify.get('/reportes/compras', auth, async (req) => {
    const { desde, hasta } = req.query
    const hoy = new Date()
    const dateFilter = {
      gte: desde ? new Date(desde) : new Date(hoy.getFullYear(), hoy.getMonth(), 1),
      lte: hasta ? new Date(hasta) : hoy,
    }

    const ordenes = await prisma.ordenCompra.findMany({
      where: {
        tenantId: req.tenantId,
        fecha: dateFilter,
        estado: { not: 'CANCELADA' },
      },
      include: { proveedor: { select: { id: true, nombre: true } } },
      orderBy: { fecha: 'asc' },
    })

    const resumen = {
      total: ordenes.reduce((s, o) => s + Number(o.total), 0),
      cantidad: ordenes.length,
    }

    return { resumen, detalle: ordenes }
  })
}
