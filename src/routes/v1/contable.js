// ─────────────────────────────────────────────────────────────
//  Rutas: /api/v1/gastos, /api/v1/cuentas-internas
//  Punto 6 del pedido 2026-08-06: gastos, Fondo, Transferencia Dueño — ver
//  project_nexoerp_roadmap_20260806 en memoria del asistente para el contexto completo.
// ─────────────────────────────────────────────────────────────

import { z } from 'zod'
import { parcial } from '../../lib/zodUtil.js'
import { prisma } from '../../lib/prisma.js'
import { asegurarCuentaInterna, saldoCuentaInterna, registrarMovimientoCuentaInterna, validarCajaParaPago } from '../../lib/cuentasInternas.js'
import { tituloCase } from '../../lib/textUtils.js'
import { snapshotCotizacion } from '../../lib/cotizacion.js'

const servicioContratadoSchema = z.object({
  nombre: z.string().min(1),
})

// Prisma exige DateTime completo (ISO-8601 con hora) — <input type="datetime-local"> del
// frontend manda "AAAA-MM-DDTHH:mm" sin segundos/timezone, así que se completa acá antes de
// llegar a cualquier prisma.create/update (mismo criterio que normalizarFechaISO en productos.js).
function normalizarFechaISO(v) {
  if (!v) return undefined
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${v}T00:00:00.000Z`
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) return `${v}:00.000Z`
  return v
}

const gastoSchema = z.object({
  categoria: z.string().min(1),
  descripcion: z.string().optional(),
  monto: z.number().positive(),
  fecha: z.string().optional().transform(normalizarFechaISO), // opcional — si no viene, Prisma usa @default(now())
  formaPago: z.enum(['CAJA', 'FONDO', 'TRANSFERENCIA_DUENO']),
  cajaSesionId: z.string().optional(),
  area: z.enum(['PRODUCTO', 'SERVICIO', 'GENERAL']).optional(),
  sucursalId: z.string().nullable().optional(),
  empleadoId: z.string().nullable().optional(),
  servicioContratadoId: z.string().nullable().optional(),
  activo: z.boolean().optional(), // permite reactivar un gasto pausado vía PUT
  cotizacionOverride: z.object({ tipo: z.string(), valor: z.number().positive() }).optional(),
})

// Ingreso manual (Feature 3b) — espejo exacto de gastoSchema para el lado "Haber": ingresos
// que no vienen de una venta (Ticket) ni de un cobro de plan (PagoPlanCliente).
const ingresoSchema = z.object({
  categoria: z.string().min(1),
  descripcion: z.string().optional(),
  monto: z.number().positive(),
  fecha: z.string().optional().transform(normalizarFechaISO),
  formaPago: z.enum(['CAJA', 'FONDO', 'TRANSFERENCIA_DUENO']),
  cajaSesionId: z.string().optional(),
  area: z.enum(['PRODUCTO', 'SERVICIO', 'GENERAL']).optional(),
  sucursalId: z.string().nullable().optional(),
  clienteId: z.string().nullable().optional(),
  activo: z.boolean().optional(),
  cotizacionOverride: z.object({ tipo: z.string(), valor: z.number().positive() }).optional(),
})

export default async function contableRoutes(fastify) {
  const auth = { preHandler: [fastify.verifyJWT, fastify.verifyTenant] }
  // Alta de gasto habilitada para ADMIN y VENDEDOR (mismo criterio que Clientes/PoS) — un cajero
  // tiene que poder registrar un gasto chico (ej. compra de insumos de limpieza) sin depender de
  // un admin, pero solo puede pagarlo desde SU caja (ver validarCajaParaPago), nunca desde Fondo
  // ni Transferencia Dueño (esos dos filtran el saldo en el GET de abajo).
  const puedeGastar = { preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN', 'VENDEDOR'])] }
  const adminOnly = { preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN'])] }

  // ── GET /gastos ────────────────────────────────────────────
  fastify.get('/gastos', auth, async (req) => {
    const { desde, hasta, limit = 200, activo, area, sucursalId } = req.query
    const where = {
      tenantId: req.tenantId,
      ...(activo !== undefined && { activo: activo === 'true' }),
      ...(area && { area }),
      ...(sucursalId && { sucursalId }),
      ...((desde || hasta) && { fecha: { ...(desde && { gte: new Date(desde) }), ...(hasta && { lte: new Date(hasta) }) } }),
    }
    return prisma.gasto.findMany({
      where, orderBy: { fecha: 'desc' }, take: Number(limit),
      include: {
        usuario: { select: { nombre: true } },
        sucursal: { select: { id: true, nombre: true } },
        empleado: { select: { id: true, nombre: true } },
        servicioContratado: { select: { id: true, nombre: true } },
      },
    })
  })

  // ── POST /gastos ───────────────────────────────────────────
  fastify.post('/gastos', puedeGastar, async (req, reply) => {
    const body = gastoSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.issues[0].message })
    const { formaPago, cajaSesionId, activo, cotizacionOverride, ...data } = body.data

    if (formaPago === 'FONDO' && req.user.rol !== 'ADMIN') {
      return reply.status(403).send({ error: 'forbidden', message: 'Solo un admin puede pagar gastos desde el Fondo.' })
    }
    if (formaPago === 'TRANSFERENCIA_DUENO' && req.user.rol !== 'ADMIN') {
      return reply.status(403).send({ error: 'forbidden', message: 'Solo un admin puede pagar gastos por Transferencia Dueño.' })
    }
    let caja = null
    if (formaPago === 'CAJA') {
      try { caja = await validarCajaParaPago(req, cajaSesionId) }
      catch (e) { return reply.status(e.status || 500).send(e.body || { error: 'error', message: e.message }) }
    }
    const cotizacion = await snapshotCotizacion(req.tenantId, data.monto, cotizacionOverride)

    const gasto = await prisma.$transaction(async (tx) => {
      const g = await tx.gasto.create({
        data: { tenantId: req.tenantId, usuarioId: req.user.id, formaPago, cajaSesionId: caja?.id, ...data, ...cotizacion },
      })
      if (formaPago !== 'CAJA') {
        await registrarMovimientoCuentaInterna({
          tenantId: req.tenantId, tipoCuenta: formaPago, tipoMovimiento: 'EGRESO',
          monto: data.monto, concepto: 'Gasto: ' + data.categoria, usuarioId: req.user.id,
        }, tx)
      }
      return g
    })
    return reply.status(201).send(gasto)
  })

  // ── PUT /gastos/:id ─────────────────────────────────────────
  // No permite cambiar formaPago/cajaSesionId (ya movió el saldo de Fondo/Transferencia/Caja al
  // crearse — reabrir eso queda fuera de alcance) — solo los campos descriptivos + reactivar.
  fastify.put('/gastos/:id', puedeGastar, async (req, reply) => {
    const body = parcial(gastoSchema).safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.issues[0].message })
    const { formaPago, cajaSesionId, ...data } = body.data
    const r = await prisma.gasto.updateMany({ where: { id: req.params.id, tenantId: req.tenantId }, data })
    if (r.count === 0) return reply.status(404).send({ error: 'not_found', message: 'Gasto no encontrado.' })
    return prisma.gasto.findUnique({ where: { id: req.params.id } })
  })

  // ── DELETE /gastos/:id (soft) ───────────────────────────────
  fastify.delete('/gastos/:id', puedeGastar, async (req, reply) => {
    const r = await prisma.gasto.updateMany({ where: { id: req.params.id, tenantId: req.tenantId }, data: { activo: false } })
    if (r.count === 0) return reply.status(404).send({ error: 'not_found', message: 'Gasto no encontrado.' })
    return { message: 'Gasto desactivado.' }
  })

  fastify.patch('/gastos/reactivar-masivo', puedeGastar, async (req, reply) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : []
    if (!ids.length) return reply.status(400).send({ error: 'validation_error', message: 'Sin gastos seleccionados.' })
    const r = await prisma.gasto.updateMany({ where: { id: { in: ids }, tenantId: req.tenantId }, data: { activo: true } })
    return { message: r.count + ' gasto(s) reactivado(s).', actualizados: r.count }
  })

  // ── Servicios contratados — catálogo liviano para asociar a un Gasto (ej. "Créditos IA",
  // "Servidor/hosting") — se usa en el libro contable de servicios para saber qué se pagó. ──
  fastify.get('/servicios-contratados', auth, async (req) => {
    const { activo } = req.query
    return prisma.servicioContratado.findMany({
      where: { tenantId: req.tenantId, ...(activo !== undefined ? { activo: activo === 'true' } : { activo: true }) },
      orderBy: { nombre: 'asc' },
    })
  })

  fastify.post('/servicios-contratados', puedeGastar, async (req, reply) => {
    const body = servicioContratadoSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.issues[0].message })
    const nombre = tituloCase(body.data.nombre)
    const existe = await prisma.servicioContratado.findFirst({ where: { tenantId: req.tenantId, nombre: { equals: nombre, mode: 'insensitive' } } })
    if (existe) return reply.status(409).send({ error: 'nombre_duplicado', message: 'Ya existe un servicio contratado con ese nombre.' })
    const servicio = await prisma.servicioContratado.create({ data: { tenantId: req.tenantId, nombre } })
    return reply.status(201).send(servicio)
  })

  fastify.put('/servicios-contratados/:id', puedeGastar, async (req, reply) => {
    let { nombre, activo } = req.body || {}
    if (nombre !== undefined) {
      nombre = tituloCase(nombre)
      const existe = await prisma.servicioContratado.findFirst({ where: { tenantId: req.tenantId, nombre: { equals: nombre, mode: 'insensitive' }, id: { not: req.params.id } } })
      if (existe) return reply.status(409).send({ error: 'nombre_duplicado', message: 'Ya existe un servicio contratado con ese nombre.' })
    }
    const r = await prisma.servicioContratado.updateMany({
      where: { id: req.params.id, tenantId: req.tenantId },
      data: { ...(nombre !== undefined && { nombre }), ...(activo !== undefined && { activo }) },
    })
    if (r.count === 0) return reply.status(404).send({ error: 'not_found', message: 'Servicio contratado no encontrado.' })
    return prisma.servicioContratado.findUnique({ where: { id: req.params.id } })
  })

  fastify.delete('/servicios-contratados/:id', puedeGastar, async (req, reply) => {
    const r = await prisma.servicioContratado.updateMany({ where: { id: req.params.id, tenantId: req.tenantId }, data: { activo: false } })
    if (r.count === 0) return reply.status(404).send({ error: 'not_found', message: 'Servicio contratado no encontrado.' })
    return { message: 'Servicio contratado desactivado.' }
  })

  fastify.patch('/servicios-contratados/reactivar-masivo', puedeGastar, async (req, reply) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : []
    if (!ids.length) return reply.status(400).send({ error: 'validation_error', message: 'Sin servicios seleccionados.' })
    const r = await prisma.servicioContratado.updateMany({ where: { id: { in: ids }, tenantId: req.tenantId }, data: { activo: true } })
    return { message: r.count + ' servicio(s) reactivado(s).', actualizados: r.count }
  })

  // ── Ingresos manuales (Feature 3b) — espejo exacto de Gastos para el lado "Haber" ──
  fastify.get('/ingresos', auth, async (req) => {
    const { desde, hasta, limit = 200, activo, area, sucursalId } = req.query
    const where = {
      tenantId: req.tenantId,
      ...(activo !== undefined && { activo: activo === 'true' }),
      ...(area && { area }),
      ...(sucursalId && { sucursalId }),
      ...((desde || hasta) && { fecha: { ...(desde && { gte: new Date(desde) }), ...(hasta && { lte: new Date(hasta) }) } }),
    }
    return prisma.ingreso.findMany({
      where, orderBy: { fecha: 'desc' }, take: Number(limit),
      include: {
        usuario: { select: { nombre: true } },
        sucursal: { select: { id: true, nombre: true } },
        cliente: { select: { id: true, nombre: true } },
      },
    })
  })

  fastify.post('/ingresos', puedeGastar, async (req, reply) => {
    const body = ingresoSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.issues[0].message })
    const { formaPago, cajaSesionId, activo, cotizacionOverride, ...data } = body.data

    if (formaPago === 'FONDO' && req.user.rol !== 'ADMIN') {
      return reply.status(403).send({ error: 'forbidden', message: 'Solo un admin puede registrar ingresos al Fondo.' })
    }
    if (formaPago === 'TRANSFERENCIA_DUENO' && req.user.rol !== 'ADMIN') {
      return reply.status(403).send({ error: 'forbidden', message: 'Solo un admin puede registrar ingresos por Transferencia Dueño.' })
    }
    let caja = null
    if (formaPago === 'CAJA') {
      try { caja = await validarCajaParaPago(req, cajaSesionId) }
      catch (e) { return reply.status(e.status || 500).send(e.body || { error: 'error', message: e.message }) }
    }
    const cotizacion = await snapshotCotizacion(req.tenantId, data.monto, cotizacionOverride)

    const ingreso = await prisma.$transaction(async (tx) => {
      const i = await tx.ingreso.create({
        data: { tenantId: req.tenantId, usuarioId: req.user.id, formaPago, cajaSesionId: caja?.id, ...data, ...cotizacion },
      })
      if (formaPago !== 'CAJA') {
        await registrarMovimientoCuentaInterna({
          tenantId: req.tenantId, tipoCuenta: formaPago, tipoMovimiento: 'INGRESO',
          monto: data.monto, concepto: 'Ingreso: ' + data.categoria, usuarioId: req.user.id,
        }, tx)
      }
      return i
    })
    return reply.status(201).send(ingreso)
  })

  fastify.put('/ingresos/:id', puedeGastar, async (req, reply) => {
    const body = parcial(ingresoSchema).safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.issues[0].message })
    const { formaPago, cajaSesionId, ...data } = body.data
    const r = await prisma.ingreso.updateMany({ where: { id: req.params.id, tenantId: req.tenantId }, data })
    if (r.count === 0) return reply.status(404).send({ error: 'not_found', message: 'Ingreso no encontrado.' })
    return prisma.ingreso.findUnique({ where: { id: req.params.id } })
  })

  fastify.delete('/ingresos/:id', puedeGastar, async (req, reply) => {
    const r = await prisma.ingreso.updateMany({ where: { id: req.params.id, tenantId: req.tenantId }, data: { activo: false } })
    if (r.count === 0) return reply.status(404).send({ error: 'not_found', message: 'Ingreso no encontrado.' })
    return { message: 'Ingreso desactivado.' }
  })

  fastify.patch('/ingresos/reactivar-masivo', puedeGastar, async (req, reply) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : []
    if (!ids.length) return reply.status(400).send({ error: 'validation_error', message: 'Sin ingresos seleccionados.' })
    const r = await prisma.ingreso.updateMany({ where: { id: { in: ids }, tenantId: req.tenantId }, data: { activo: true } })
    return { message: r.count + ' ingreso(s) reactivado(s).', actualizados: r.count }
  })

  // ── GET /cuentas-internas ──────────────────────────────────
  // Solo ADMIN — "el cajero/vendedor, con su permiso no sabe cuánto hay ahí" (pedido explícito
  // del usuario). Devuelve el saldo actual de Fondo y Transferencia Dueño.
  fastify.get('/cuentas-internas', adminOnly, async (req) => {
    const fondo = await asegurarCuentaInterna(req.tenantId, 'FONDO')
    const transferencia = await asegurarCuentaInterna(req.tenantId, 'TRANSFERENCIA_DUENO')
    const [saldoFondo, saldoTransferencia] = await Promise.all([
      saldoCuentaInterna(fondo.id), saldoCuentaInterna(transferencia.id),
    ])
    return { fondo: saldoFondo, transferenciaDueno: saldoTransferencia }
  })

  // ── POST /cuentas-internas/:tipo/carga ─────────────────────
  // Carga manual (ej. el dueño deposita $50.000 en el Fondo desde su bolsillo) — el único modo de
  // que el saldo de Fondo/Transferencia suba sin pasar por un gasto/pago.
  fastify.post('/cuentas-internas/:tipo/carga', adminOnly, async (req, reply) => {
    const tipo = req.params.tipo === 'fondo' ? 'FONDO' : (req.params.tipo === 'transferencia' ? 'TRANSFERENCIA_DUENO' : null)
    if (!tipo) return reply.status(400).send({ error: 'validation_error', message: 'Tipo de cuenta inválido.' })
    const monto = Number(req.body?.monto)
    if (!monto || monto <= 0) return reply.status(400).send({ error: 'validation_error', message: 'Monto inválido.' })
    const concepto = req.body?.concepto ? String(req.body.concepto) : 'Carga manual'
    await registrarMovimientoCuentaInterna({
      tenantId: req.tenantId, tipoCuenta: tipo, tipoMovimiento: 'INGRESO', monto, concepto, usuarioId: req.user.id,
    })
    const cuenta = await asegurarCuentaInterna(req.tenantId, tipo)
    return { saldo: await saldoCuentaInterna(cuenta.id) }
  })
}
