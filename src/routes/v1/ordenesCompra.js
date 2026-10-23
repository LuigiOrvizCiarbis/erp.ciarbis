// ─────────────────────────────────────────────────────────────
//  Rutas: /api/v1/ordenes-compra
//  Incluye recepción de mercadería con entrada de stock
// ─────────────────────────────────────────────────────────────

import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { resolverSucursalStock, moverStock } from '../../lib/stock.js'
import { registrarMovimientoCuentaInterna, validarCajaParaPago } from '../../lib/cuentasInternas.js'
import { snapshotCotizacion } from '../../lib/cotizacion.js'
import { cotizacionDefault, desdePesos } from '../../lib/moneda.js'

const lineaSchema = z.object({
  productoId: z.string(),
  descripcion: z.string(),
  cantidad: z.number().positive(),
  precioUnit: z.number().min(0),
  impuesto: z.number().min(0).max(100).default(21),
  subtotal: z.number().min(0),
})

const ordenSchema = z.object({
  proveedorId: z.string(),
  fecha: z.string().datetime().optional(),
  fechaEntrega: z.string().datetime().optional(),
  observaciones: z.string().optional(),
  subtotal: z.number().min(0),
  impuestos: z.number().min(0).default(0),
  total: z.number().min(0),
  lineas: z.array(lineaSchema).min(1),
  // Forma de pago al momento de la compra (punto 6, pendiente resuelto 2026-08-06) — ctaCte=true
  // (default) es el comportamiento de siempre: la deuda queda en Proveedor.saldo. ctaCte=false
  // paga en el momento desde Caja/Fondo/Transferencia Dueño, mismo criterio que Gasto/PagoProveedor.
  ctaCte: z.boolean().default(true),
  formaPagoInterno: z.enum(['CAJA', 'FONDO', 'TRANSFERENCIA_DUENO']).optional(),
  cajaSesionId: z.string().optional(),
  cotizacionOverride: z.object({ tipo: z.string(), valor: z.number().positive() }).optional(),
})

const recepcionSchema = z.object({
  observaciones: z.string().optional(),
  items: z.array(z.object({
    productoId: z.string(),
    cantidad: z.number().positive(),
    loteId: z.string().optional(),
  })).min(1),
})

async function getNextNro(tenantId) {
  const last = await prisma.ordenCompra.findFirst({
    where: { tenantId },
    orderBy: { nro: 'desc' },
    select: { nro: true },
  })
  return (last?.nro || 0) + 1
}

export default async function ordenesCompraRoutes(fastify) {
  const auth = { preHandler: [fastify.verifyJWT, fastify.verifyTenant] }
  const adminDep = { preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN', 'DEPOSITO'])] }

  // ── GET /ordenes-compra/kpis ───────────────────────────────
  // Antes, la pantalla de Compras traía hasta 10.000 órdenes completas solo para sumar 3 números
  // (cantidad, gasto total, pendientes) — se calcula acá directo en SQL.
  // Nota: el frontend comparaba estado contra 'ENVIADA' o 'PENDIENTE', pero 'PENDIENTE' no es un
  // valor válido del enum EstadoOC (nunca hace match) — se replica el comportamiento real
  // (solo 'ENVIADA' cuenta) en vez de mandarle a Prisma un valor de enum inexistente.
  fastify.get('/ordenes-compra/kpis', auth, async (req) => {
    const where = { tenantId: req.tenantId }
    const [total, sumaTotal, pendientes] = await Promise.all([
      prisma.ordenCompra.count({ where }),
      prisma.ordenCompra.aggregate({ where, _sum: { total: true } }),
      prisma.ordenCompra.count({ where: { ...where, estado: 'ENVIADA' } }),
    ])
    return { total, sumaTotal: Number(sumaTotal._sum.total || 0), pendientes }
  })

  fastify.get('/ordenes-compra', auth, async (req) => {
    const { page = 1, limit = 50, estado, proveedorId, desde, hasta } = req.query
    const where = {
      tenantId: req.tenantId,
      ...(estado && { estado }),
      ...(proveedorId && { proveedorId }),
      ...(desde || hasta) && { fecha: { ...(desde && { gte: new Date(desde) }), ...(hasta && { lte: new Date(hasta) }) } },
    }
    const [data, total] = await prisma.$transaction([
      prisma.ordenCompra.findMany({
        where,
        include: { proveedor: { select: { id: true, nombre: true } }, usuario: { select: { id: true, nombre: true } } },
        orderBy: { fecha: 'desc' },
        skip: (Number(page) - 1) * Number(limit),
        take: Number(limit),
      }),
      prisma.ordenCompra.count({ where }),
    ])
    return { data, meta: { total, page: Number(page), limit: Number(limit) } }
  })

  fastify.get('/ordenes-compra/:id', auth, async (req, reply) => {
    const item = await prisma.ordenCompra.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
      include: {
        proveedor: true,
        usuario: { select: { id: true, nombre: true } },
        lineas: { include: { producto: { select: { id: true, nombre: true, sku: true, um: true } } } },
        recepciones: { include: { items: true } },
      },
    })
    if (!item) return reply.status(404).send({ error: 'not_found', message: 'Orden no encontrada.' })
    return item
  })

  fastify.post('/ordenes-compra', adminDep, async (req, reply) => {
    const body = ordenSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.errors[0].message })
    const { ctaCte, formaPagoInterno, cajaSesionId, lineas, cotizacionOverride, ...ordenData } = body.data

    // Mismo gate que Gasto/PagoProveedor: solo ADMIN puede pagar desde Fondo/Transferencia Dueño
    // (el cajero/depósito no sabe cuánta plata hay ahí).
    if (!ctaCte) {
      if (!formaPagoInterno) return reply.status(400).send({ error: 'validation_error', message: 'formaPagoInterno requerido cuando ctaCte=false.' })
      if (formaPagoInterno !== 'CAJA' && req.user.rol !== 'ADMIN') {
        return reply.status(403).send({ error: 'forbidden', message: 'Solo un admin puede pagar una compra desde el Fondo o por Transferencia Dueño.' })
      }
    }
    let caja = null
    if (!ctaCte && formaPagoInterno === 'CAJA') {
      try { caja = await validarCajaParaPago(req, cajaSesionId) }
      catch (e) { return reply.status(e.status || 500).send(e.body || { error: 'error', message: e.message }) }
    }

    const nro = await getNextNro(req.tenantId)
    const cotizacion = await snapshotCotizacion(req.tenantId, ordenData.total, cotizacionOverride)

    const orden = await prisma.$transaction(async (tx) => {
      const oc = await tx.ordenCompra.create({
        data: {
          tenantId: req.tenantId, nro, usuarioId: req.user.id, ...ordenData, ...cotizacion,
          ctaCte, formaPagoInterno: ctaCte ? null : formaPagoInterno, cajaSesionId: caja?.id,
          lineas: { create: lineas },
        },
        include: { lineas: true, proveedor: { select: { id: true, nombre: true } } },
      })
      if (ctaCte) {
        // Compra a cuenta corriente — la deuda con el proveedor se genera al momento de la
        // compra, no al recibir la mercadería (así lo pidió el usuario explícitamente).
        await tx.proveedor.update({ where: { id: oc.proveedorId }, data: { saldo: { decrement: oc.total } } })
      } else if (formaPagoInterno !== 'CAJA') {
        await registrarMovimientoCuentaInterna({
          tenantId: req.tenantId, tipoCuenta: formaPagoInterno, tipoMovimiento: 'EGRESO',
          monto: Number(oc.total), concepto: 'Compra OC-' + oc.nro + ' a ' + oc.proveedor.nombre, usuarioId: req.user.id,
        }, tx)
      }
      // formaPagoInterno === 'CAJA': no se registra movimiento aparte (mismo criterio que Gasto/
      // PagoProveedor pagados por Caja — el arqueo de esa caja ya sabe qué salió por su cajaSesionId).
      return oc
    })
    return reply.status(201).send(orden)
  })

  fastify.put('/ordenes-compra/:id/estado', adminDep, async (req, reply) => {
    const { estado } = req.body || {}
    const estadosValidos = ['BORRADOR', 'ENVIADA', 'CONFIRMADA', 'PARCIAL', 'RECIBIDA', 'CANCELADA']
    if (!estadosValidos.includes(estado)) {
      return reply.status(400).send({ error: 'validation_error', message: `Estado inválido: ${estado}` })
    }
    const actual = await prisma.ordenCompra.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } })
    if (!actual) return reply.status(404).send({ error: 'not_found', message: 'Orden no encontrada.' })

    const orden = await prisma.$transaction(async (tx) => {
      const oc = await tx.ordenCompra.update({ where: { id: actual.id }, data: { estado } })
      // Cancelar reversa el efecto financiero aplicado al crear la orden (ver POST de arriba) —
      // si no se revierte, Proveedor.saldo o el Fondo/Transferencia quedan desincronizados con una
      // compra que nunca se concretó. Solo revierte una vez (actual.estado ya distinto de CANCELADA,
      // este endpoint es el único lugar que pone estado=CANCELADA).
      if (estado === 'CANCELADA' && actual.estado !== 'CANCELADA') {
        if (oc.ctaCte) {
          await tx.proveedor.update({ where: { id: oc.proveedorId }, data: { saldo: { increment: oc.total } } })
        } else if (oc.formaPagoInterno && oc.formaPagoInterno !== 'CAJA') {
          await registrarMovimientoCuentaInterna({
            tenantId: req.tenantId, tipoCuenta: oc.formaPagoInterno, tipoMovimiento: 'INGRESO',
            monto: Number(oc.total), concepto: 'Cancelación OC-' + oc.nro, usuarioId: req.user.id,
          }, tx)
        }
      }
      return oc
    })
    return orden
  })

  // ── POST /ordenes-compra/:id/recepciones ──────────────────
  // Recibe mercadería parcial o total → sube stock
  fastify.post('/ordenes-compra/:id/recepciones', adminDep, async (req, reply) => {
    const body = recepcionSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.errors[0].message })

    const orden = await prisma.ordenCompra.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
      include: { lineas: true },
    })
    if (!orden) return reply.status(404).send({ error: 'not_found', message: 'Orden no encontrada.' })
    if (['CANCELADA', 'RECIBIDA'].includes(orden.estado)) {
      return reply.status(409).send({ error: 'conflict', message: `No se puede recepcionar una orden en estado ${orden.estado}.` })
    }

    // La mercadería entra en la sucursal que se indica al recibir (o la del usuario / principal)
    const sucursalId = await resolverSucursalStock(prisma, req.tenantId, req.body?.sucursalId, req.user)

    const recepcion = await prisma.$transaction(async (tx) => {
      const rec = await tx.recepcionMercaderia.create({
        data: {
          tenantId: req.tenantId,
          ordenId: orden.id,
          observaciones: body.data.observaciones,
          items: { create: body.data.items },
        },
      })

      // Subir stock por cada ítem recibido
      for (const item of body.data.items) {
        const m = await moverStock(tx, { productoId: item.productoId, sucursalId, delta: Number(item.cantidad) })
        const stockNuevo = m.total

        // El precio pagado ya está en la línea de la OC — antes esto se perdía: recibir
        // mercadería subía el stock pero nunca actualizaba el costo del producto (bug real,
        // solo "Recepción por código de barras" lo hacía). Recibir es el momento real de
        // "confirmar" el costo pagado a este proveedor puntual.
        const lineaOC = orden.lineas.find(l => l.productoId === item.productoId)
        const precioCosto = lineaOC ? Number(lineaOC.precioUnit) : undefined

        if (precioCosto !== undefined) {
          // La OC está en pesos; un producto en dólares guarda el costo en dólares (sin cotización
          // cargada no se puede convertir → el costo del producto queda como estaba).
          const prod = await tx.producto.findUnique({ where: { id: item.productoId }, select: { moneda: true } })
          const costo = prod?.moneda === 'USD' ? desdePesos(precioCosto, 'USD', await cotizacionDefault(req.tenantId, tx)) : precioCosto
          if (costo != null) await tx.producto.update({ where: { id: item.productoId }, data: { precioCosto: costo } })
        }

        // Costo recordado por proveedor — selección única (no checkbox múltiple, pedido
        // explícito del usuario): recibir de ESTE proveedor lo marca como preferido (fuente
        // vigente del costo del producto) y desmarca cualquier otro proveedor guardado para
        // el mismo producto.
        if (precioCosto !== undefined) {
          await tx.productoProveedor.updateMany({
            where: { tenantId: req.tenantId, productoId: item.productoId, proveedorId: { not: orden.proveedorId } },
            data: { preferido: false },
          })
          await tx.productoProveedor.upsert({
            where: { tenantId_productoId_proveedorId: { tenantId: req.tenantId, productoId: item.productoId, proveedorId: orden.proveedorId } },
            update: { ultimoCosto: precioCosto, ultimaCompra: new Date(), preferido: true },
            create: { tenantId: req.tenantId, productoId: item.productoId, proveedorId: orden.proveedorId, ultimoCosto: precioCosto, ultimaCompra: new Date(), preferido: true },
          })
        }

        await tx.movimientoStock.create({
          data: {
            tenantId: req.tenantId,
            productoId: item.productoId,
            usuarioId: req.user.id,
            tipo: 'ENTRADA_COMPRA',
            cantidad: Number(item.cantidad),
            stockPost: stockNuevo,
            ordenCompraId: orden.id,
            loteId: item.loteId,
            sucursalId,
            referencia: `OC-${orden.nro}`,
          },
        })

        // Actualizar cantRecibida en la línea
        await tx.lineaOrdenCompra.updateMany({
          where: { ordenId: orden.id, productoId: item.productoId },
          data: { cantRecibida: { increment: Number(item.cantidad) } },
        })
      }

      // Verificar si está completamente recibida
      const lineasActualizadas = await tx.lineaOrdenCompra.findMany({ where: { ordenId: orden.id } })
      const completa = lineasActualizadas.every(l => Number(l.cantRecibida) >= Number(l.cantidad))

      await tx.ordenCompra.update({
        where: { id: orden.id },
        data: { estado: completa ? 'RECIBIDA' : 'PARCIAL' },
      })

      return rec
    })

    return reply.status(201).send(recepcion)
  })
}
