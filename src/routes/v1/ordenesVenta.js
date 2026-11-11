// ─────────────────────────────────────────────────────────────
//  Rutas: /api/v1/ordenes-venta
//  Incluye descuento de stock al aprobar la orden
// ─────────────────────────────────────────────────────────────

import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { registrarAuditoria } from '../../lib/auditoria.js'
import { resolverSucursalStock, moverStock } from '../../lib/stock.js'
import { listaEnPesos } from '../../lib/moneda.js'

const lineaSchema = z.object({
  productoId: z.string(),
  descripcion: z.string(),
  // Tope técnico duro (independiente del aviso configurable del PoS) — última barrera contra
  // un típo tipo OV-126 (201.126.001 kg cargado por error) si algo llega a saltarse el aviso
  // del frontend o pega directo a la API. Cubre tanto la creación como la edición de la orden
  // (PUT /:id reusa este mismo schema).
  cantidad: z.number().positive().max(999999, 'Cantidad fuera de rango'),
  precioUnit: z.number().min(0),
  descuento: z.number().min(0).max(100).default(0),
  impuesto: z.number().min(0).max(100).default(21),
  subtotal: z.number().min(0),
})

const ordenSchema = z.object({
  clienteId: z.string().optional(), // sin cliente = venta mostrador / consumidor final
  sucursalId: z.string().optional(),
  fecha: z.string().datetime().optional(),
  fechaEntrega: z.string().datetime().optional(),
  observaciones: z.string().optional(),
  subtotal: z.number().min(0),
  descuento: z.number().min(0).default(0),
  impuestos: z.number().min(0).default(0),
  total: z.number().min(0),
  lineas: z.array(lineaSchema).min(1, 'Se requiere al menos una línea'),
})

async function getNextNro(tenantId) {
  const last = await prisma.ordenVenta.findFirst({
    where: { tenantId },
    orderBy: { nro: 'desc' },
    select: { nro: true },
  })
  return (last?.nro || 0) + 1
}

export default async function ordenesVentaRoutes(fastify) {
  const auth = { preHandler: [fastify.verifyJWT, fastify.verifyTenant] }

  // ── GET /ordenes-venta/kpis ────────────────────────────────
  // Antes, la pantalla de Ventas traía hasta 10.000 órdenes completas solo para sumar 3 números
  // (cantidad, total acumulado, total de hoy) — se calcula acá directo en SQL en vez de mandar
  // todo el dataset al navegador. "Hoy" se calcula en horario de Argentina (UTC-3) sin importar
  // en qué zona horaria esté corriendo el servidor.
  fastify.get('/ordenes-venta/kpis', auth, async (req) => {
    const { sucursalId } = req.query
    const AR_OFFSET_MS = 3 * 60 * 60 * 1000
    const nowAr = new Date(Date.now() - AR_OFFSET_MS)
    const hoyInicio = new Date(Date.UTC(nowAr.getUTCFullYear(), nowAr.getUTCMonth(), nowAr.getUTCDate(), 3, 0, 0))
    const hoyFin = new Date(hoyInicio.getTime() + 24 * 60 * 60 * 1000)
    const where = { tenantId: req.tenantId, ...(sucursalId && { sucursalId }) }
    const [total, sumaTotal, sumaHoy] = await Promise.all([
      prisma.ordenVenta.count({ where }),
      prisma.ordenVenta.aggregate({ where, _sum: { total: true } }),
      prisma.ordenVenta.aggregate({ where: { ...where, fecha: { gte: hoyInicio, lt: hoyFin } }, _sum: { total: true } }),
    ])
    return { total, sumaTotal: Number(sumaTotal._sum.total || 0), ventasHoy: Number(sumaHoy._sum.total || 0) }
  })

  // ── GET /ordenes-venta ────────────────────────────────────
  fastify.get('/ordenes-venta', auth, async (req) => {
    const { page = 1, limit = 50, q, estado, clienteId, desde, hasta, sucursalId, montoMin, montoMax } = req.query
    const where = {
      tenantId: req.tenantId,
      ...(estado && { estado }),
      ...(clienteId && { clienteId }),
      ...(sucursalId && { sucursalId }),
      ...(desde || hasta) && {
        fecha: {
          ...(desde && { gte: new Date(desde) }),
          ...(hasta && { lte: new Date(hasta) }),
        },
      },
      ...(montoMin || montoMax) && { total: { ...(montoMin && { gte: Number(montoMin) }), ...(montoMax && { lte: Number(montoMax) }) } },
      // Igual que en /tickets — buscar también por nombre de producto/ítem vendido, no solo
      // N° de orden o cliente.
      ...(q && {
        OR: [
          { nro: { equals: parseInt(q) || undefined } },
          { cliente: { nombre: { contains: q, mode: 'insensitive' } } },
          { lineas: { some: { descripcion: { contains: q, mode: 'insensitive' } } } },
        ],
      }),
    }
    const [data, total] = await prisma.$transaction([
      prisma.ordenVenta.findMany({
        where,
        include: { cliente: { select: { id: true, nombre: true, cuit: true } }, usuario: { select: { id: true, nombre: true } } },
        orderBy: { fecha: 'desc' },
        skip: (Number(page) - 1) * Number(limit),
        take: Number(limit),
      }),
      prisma.ordenVenta.count({ where }),
    ])
    return { data, meta: { total, page: Number(page), limit: Number(limit) } }
  })

  // ── GET /ordenes-venta/:id ────────────────────────────────
  fastify.get('/ordenes-venta/:id', auth, async (req, reply) => {
    const item = await prisma.ordenVenta.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
      include: {
        cliente: true,
        usuario: { select: { id: true, nombre: true } },
        lineas: { include: { producto: { select: { id: true, nombre: true, sku: true, um: true } } } },
        tickets: { select: { id: true, nro: true, tipo: true, facturaEmitida: true, total: true } },
      },
    })
    if (!item) return reply.status(404).send({ error: 'not_found', message: 'Orden no encontrada.' })
    return item
  })

  // ── POST /ordenes-venta ───────────────────────────────────
  fastify.post('/ordenes-venta', {
    preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN', 'VENDEDOR'])],
  }, async (req, reply) => {
    const body = ordenSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.issues[0].message })

    const nro = await getNextNro(req.tenantId)
    const { lineas, ...ordenData } = body.data

    const orden = await prisma.ordenVenta.create({
      data: {
        tenantId: req.tenantId,
        nro,
        usuarioId: req.user.id,
        ...ordenData,
        lineas: { create: lineas },
      },
      include: { lineas: true, cliente: { select: { id: true, nombre: true } } },
    })

    return reply.status(201).send(orden)
  })

  // ── PUT /ordenes-venta/:id/estado ─────────────────────────
  // Al pasar a APROBADA: descuenta stock automáticamente
  fastify.put('/ordenes-venta/:id/estado', {
    preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN', 'VENDEDOR'])],
  }, async (req, reply) => {
    const { estado } = req.body || {}
    // Variantes vendidas (talle/color) — la línea de la orden es del producto padre, así que el
    // PoS manda acá qué variante salió para descontarla en la misma transacción (antes el
    // navegador pisaba el stock de la variante con un PUT aparte, con el número que tenía en
    // pantalla: dos cajas vendiendo a la vez se pisaban).
    const variantesVendidas = Array.isArray(req.body?.variantes)
      ? req.body.variantes.filter((v) => v && typeof v.varianteId === 'string' && Number(v.cantidad) > 0)
      : []
    const estadosValidos = ['BORRADOR', 'PENDIENTE', 'APROBADA', 'ENVIADA', 'ENTREGADA', 'CANCELADA']
    if (!estadosValidos.includes(estado)) {
      return reply.status(400).send({ error: 'validation_error', message: `Estado inválido: ${estado}` })
    }

    const orden = await prisma.ordenVenta.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
      include: { lineas: { include: { producto: true } } },
    })
    if (!orden) return reply.status(404).send({ error: 'not_found', message: 'Orden no encontrada.' })

    // Descuento de stock solo al aprobar (y si no fue ya aprobada)
    if (estado === 'APROBADA' && orden.estado !== 'APROBADA') {
      // Sale de la sucursal de la venta (la de la caja); una OV sin sucursal sale de la del
      // usuario / la principal, para que el total y las sucursales no se desfasen nunca.
      const sucursalId = await resolverSucursalStock(prisma, req.tenantId, orden.sucursalId, req.user)
      const variantes = variantesVendidas.length
        ? await prisma.productoVariante.findMany({ where: { tenantId: req.tenantId, id: { in: variantesVendidas.map((v) => v.varianteId) } }, select: { id: true, productoId: true } })
        : []
      const varOk = new Map(variantes.map((v) => [v.id, v.productoId]))
      await prisma.$transaction(async (tx) => {
        for (const linea of orden.lineas) {
          const m = await moverStock(tx, { productoId: linea.productoId, sucursalId, delta: -Number(linea.cantidad) })

          await tx.movimientoStock.create({
            data: {
              tenantId: req.tenantId,
              productoId: linea.productoId,
              usuarioId: req.user.id,
              tipo: 'SALIDA_VENTA',
              cantidad: -Number(linea.cantidad),
              stockPost: m.total,
              ordenVentaId: orden.id,
              sucursalId,
              referencia: `OV-${orden.nro}`,
            },
          })
        }
        for (const vv of variantesVendidas) {
          const productoId = varOk.get(vv.varianteId)
          if (!productoId) continue
          await moverStock(tx, { productoId, varianteId: vv.varianteId, sucursalId, delta: -Number(vv.cantidad) })
        }

        await tx.ordenVenta.update({ where: { id: orden.id }, data: { estado, ...(!orden.sucursalId && sucursalId && { sucursalId }) } })
      })
    } else {
      await prisma.ordenVenta.update({ where: { id: orden.id }, data: { estado } })
    }

    return prisma.ordenVenta.findUnique({
      where: { id: orden.id },
      include: { cliente: { select: { id: true, nombre: true } } },
    })
  })

  // ── PUT /ordenes-venta/:id ────────────────────────────────
  // Corrección manual de una venta ya cargada (ej. el cajero puso mal una cantidad/precio).
  // Solo ADMIN (el dueño) — mismo criterio que el DELETE de acá abajo: rol fijo, no pasa por
  // RBAC custom, para que nadie sin ese rol pueda tocar una venta ya facturada/con caja cerrada
  // sin pasar por soporte. Reemplaza todas las líneas de la orden y, si hay un ticket asociado,
  // propaga el cambio a sus líneas/totales y —si la caja de ese ticket ya cerró— corrige el
  // snapshot financiero (totalesPorMedioPago / efectivoEsperado / diferencia) para que el cierre
  // ya hecho no quede con un número que no cierra más. Todo queda en AuditLog con antes/después.
  fastify.put('/ordenes-venta/:id', {
    preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN'])],
  }, async (req, reply) => {
    const body = z.object({ lineas: z.array(lineaSchema).min(1, 'Se requiere al menos una línea') }).safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.issues[0].message })

    const orden = await prisma.ordenVenta.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
      include: { lineas: true, tickets: { include: { lineas: true, cajaSesion: true } } },
    })
    if (!orden) return reply.status(404).send({ error: 'not_found', message: 'Orden no encontrada.' })
    if (orden.estado === 'CANCELADA') {
      return reply.status(409).send({ error: 'conflict', message: 'No se puede editar una orden cancelada.' })
    }
    if (orden.tickets.length > 1) {
      return reply.status(409).send({ error: 'conflict', message: 'Esta orden tiene más de un comprobante asociado, no se puede editar automáticamente.' })
    }
    if (orden.tickets.some((t) => t.facturaEmitida)) {
      return reply.status(409).send({ error: 'conflict', message: 'Ya tiene factura electrónica emitida — no se puede editar, hacé una nota de crédito.' })
    }

    const nuevasLineas = body.data.lineas
    const nuevoTotal = nuevasLineas.reduce((acc, l) => acc + l.subtotal, 0)
    const ticket = orden.tickets[0] || null

    const antes = {
      lineas: orden.lineas.map((l) => ({ productoId: l.productoId, descripcion: l.descripcion, cantidad: l.cantidad.toString(), precioUnit: l.precioUnit.toString(), subtotal: l.subtotal.toString() })),
      total: orden.total.toString(),
    }

    const resultado = await prisma.$transaction(async (tx) => {
      // Reponer/ajustar stock solo si la orden ya estaba aprobada (ahí sí se descontó de verdad)
      if (orden.estado === 'APROBADA') {
        const sucursalId = await resolverSucursalStock(tx, req.tenantId, orden.sucursalId, req.user)
        const cantidadPorProducto = (lineas) => lineas.reduce((map, l) => {
          const cant = Number(l.cantidad)
          map.set(l.productoId, (map.get(l.productoId) || 0) + cant)
          return map
        }, new Map())
        const antesPorProd = cantidadPorProducto(orden.lineas)
        const despuesPorProd = cantidadPorProducto(nuevasLineas)
        const productoIds = new Set([...antesPorProd.keys(), ...despuesPorProd.keys()])

        for (const productoId of productoIds) {
          const delta = (despuesPorProd.get(productoId) || 0) - (antesPorProd.get(productoId) || 0)
          if (delta === 0) continue

          const m = await moverStock(tx, { productoId, sucursalId, delta: -delta })
          const stockNuevo = m.total

          await tx.movimientoStock.create({
            data: {
              tenantId: req.tenantId,
              productoId,
              usuarioId: req.user.id,
              tipo: 'SALIDA_VENTA',
              cantidad: -delta,
              stockPost: stockNuevo,
              ordenVentaId: orden.id,
              sucursalId,
              referencia: `OV-${orden.nro} (corrección)`,
            },
          })
        }
      }

      await tx.lineaOrdenVenta.deleteMany({ where: { ordenId: orden.id } })
      await tx.ordenVenta.update({
        where: { id: orden.id },
        data: { subtotal: nuevoTotal, total: nuevoTotal, lineas: { create: nuevasLineas } },
      })

      if (ticket) {
        const costosPrevios = new Map(ticket.lineas.map((l) => [l.productoId, l.precioCosto]))
        const productosFaltantes = nuevasLineas.map((l) => l.productoId).filter((id) => !costosPrevios.has(id))
        if (productosFaltantes.length) {
          const productos = await listaEnPesos(req.tenantId, await tx.producto.findMany({ where: { id: { in: productosFaltantes } } }), tx)
          for (const p of productos) costosPrevios.set(p.id, p.precioCosto)
        }

        await tx.lineaTicket.deleteMany({ where: { ticketId: ticket.id } })
        await tx.lineaTicket.createMany({
          data: nuevasLineas.map((l) => ({
            ticketId: ticket.id,
            productoId: l.productoId,
            descripcion: l.descripcion,
            cantidad: l.cantidad,
            precioUnit: l.precioUnit,
            impuesto: l.impuesto,
            subtotal: l.subtotal,
            precioCosto: costosPrevios.get(l.productoId) ?? null,
          })),
        })
        const nuevoMontoUSD = ticket.cotizacionValor ? nuevoTotal / Number(ticket.cotizacionValor) : null
        await tx.ticket.update({
          where: { id: ticket.id },
          data: { subtotal: nuevoTotal, total: nuevoTotal, ...(nuevoMontoUSD != null && { montoUSD: nuevoMontoUSD }) },
        })

        const deltaTotal = nuevoTotal - Number(ticket.total)
        if (deltaTotal !== 0 && ticket.cajaSesion && ticket.cajaSesion.estado === 'CERRADA' && ticket.medioPago) {
          const caja = ticket.cajaSesion
          const totalesActual = caja.totalesPorMedioPago || {}
          const medioActual = Number(totalesActual[ticket.medioPago] || 0)
          const nuevoTotalesPorMedioPago = { ...totalesActual, [ticket.medioPago]: medioActual + deltaTotal }

          const dataCaja = { totalesPorMedioPago: nuevoTotalesPorMedioPago }
          if (ticket.medioPago === 'EFECTIVO') {
            dataCaja.efectivoEsperado = Number(caja.efectivoEsperado || 0) + deltaTotal
            if (caja.montoCierreDeclarado != null) {
              dataCaja.diferencia = Number(caja.montoCierreDeclarado) - dataCaja.efectivoEsperado
            }
          }
          await tx.cajaSesion.update({ where: { id: caja.id }, data: dataCaja })
        }
      }

      return tx.ordenVenta.findUnique({
        where: { id: orden.id },
        include: { lineas: true, cliente: { select: { id: true, nombre: true } }, tickets: true },
      })
    }, { timeout: 20000, maxWait: 10000 })

    await registrarAuditoria({
      tenantId: req.tenantId, userId: req.user.id, req,
      accion: 'venta.edicion', entidad: 'OrdenVenta', entidadId: orden.id,
      detalle: { antes, despues: { lineas: nuevasLineas.map((l) => ({ productoId: l.productoId, descripcion: l.descripcion, cantidad: l.cantidad, precioUnit: l.precioUnit, subtotal: l.subtotal })), total: nuevoTotal } },
    })

    return resultado
  })

  // ── DELETE /ordenes-venta/:id ─────────────────────────────
  fastify.delete('/ordenes-venta/:id', {
    preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN'])],
  }, async (req, reply) => {
    const orden = await prisma.ordenVenta.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
    })
    if (!orden) return reply.status(404).send({ error: 'not_found', message: 'Orden no encontrada.' })

    if (['APROBADA', 'ENTREGADA'].includes(orden.estado)) {
      return reply.status(409).send({ error: 'conflict', message: 'No se puede eliminar una orden aprobada o entregada.' })
    }

    await prisma.ordenVenta.update({ where: { id: orden.id }, data: { estado: 'CANCELADA' } })
    return { message: 'Orden cancelada.' }
  })
}
