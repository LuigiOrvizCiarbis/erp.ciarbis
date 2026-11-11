// ─────────────────────────────────────────────────────────────
//  Rutas: /api/v1/proveedores
// ─────────────────────────────────────────────────────────────

import { z } from 'zod'
import { parcial } from '../../lib/zodUtil.js'
import { prisma } from '../../lib/prisma.js'
import { registrarMovimientoCuentaInterna, validarCajaParaPago } from '../../lib/cuentasInternas.js'
import { tituloCase } from '../../lib/textUtils.js'
import { snapshotCotizacion } from '../../lib/cotizacion.js'

const proveedorSchema = z.object({
  nombre: z.string().min(1),
  razonSocial: z.string().optional(),
  cuit: z.string().optional(),
  condIVA: z.string().default('Responsable Inscripto'),
  email: z.string().email().optional().or(z.literal('')),
  tel: z.string().optional(),
  direccion: z.string().optional(),
  condPago: z.string().default('30 días'),
  activo: z.boolean().optional(), // permite reactivar un proveedor pausado vía PUT
})

const pagoProveedorSchema = z.object({
  monto: z.number().positive(),
  formaPago: z.enum(['CAJA', 'FONDO', 'TRANSFERENCIA_DUENO']),
  cajaSesionId: z.string().optional(),
  comentario: z.string().optional(),
  cotizacionOverride: z.object({ tipo: z.string(), valor: z.number().positive() }).optional(),
})

export default async function proveedoresRoutes(fastify) {
  const auth = { preHandler: [fastify.verifyJWT, fastify.verifyTenant] }

  fastify.get('/proveedores', auth, async (req) => {
    const { page = 1, limit = 50, q, activo } = req.query
    const where = {
      tenantId: req.tenantId,
      ...(activo !== undefined && { activo: activo === 'true' }),
      ...(q && {
        OR: [
          { nombre: { contains: q, mode: 'insensitive' } },
          { razonSocial: { contains: q, mode: 'insensitive' } },
          { cuit: { contains: q } },
        ],
      }),
    }
    const [data, total] = await prisma.$transaction([
      prisma.proveedor.findMany({
        where,
        orderBy: { nombre: 'asc' },
        skip: (Number(page) - 1) * Number(limit),
        take: Number(limit),
      }),
      prisma.proveedor.count({ where }),
    ])
    return { data, meta: { total, page: Number(page), limit: Number(limit) } }
  })

  fastify.get('/proveedores/:id', auth, async (req, reply) => {
    const item = await prisma.proveedor.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } })
    if (!item) return reply.status(404).send({ error: 'not_found', message: 'Proveedor no encontrado.' })
    return item
  })

  fastify.post('/proveedores', {
    preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN', 'DEPOSITO'])],
  }, async (req, reply) => {
    const body = proveedorSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.issues[0].message })
    body.data.nombre = tituloCase(body.data.nombre)
    const { nombre, cuit, tel, email } = body.data
    // Guarda contra doble-submit (doble click) que crea el mismo proveedor 2 veces — mismo
    // criterio que clientes.js: solo bloquea si nombre Y (cuit o tel o email) coinciden con uno
    // ya existente, para no dar falsos positivos entre proveedores distintos que comparten nombre.
    if (cuit || tel || email) {
      const duplicado = await prisma.proveedor.findFirst({
        where: {
          tenantId: req.tenantId,
          nombre: { equals: nombre, mode: 'insensitive' },
          OR: [...(cuit ? [{ cuit }] : []), ...(tel ? [{ tel }] : []), ...(email ? [{ email }] : [])],
        },
      })
      if (duplicado) {
        return reply.status(409).send({ error: 'proveedor_duplicado', message: `Ya existe un proveedor "${duplicado.nombre}" con ese mismo CUIT, teléfono o email.` })
      }
    }
    const prov = await prisma.$transaction(async (tx) => {
      const t = await tx.tenant.update({
        where: { id: req.tenantId },
        data: { seqProveedores: { increment: 1 } },
        select: { seqProveedores: true },
      })
      return tx.proveedor.create({ data: { tenantId: req.tenantId, numero: t.seqProveedores, ...body.data } })
    })
    return reply.status(201).send(prov)
  })

  fastify.put('/proveedores/:id', {
    preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN', 'DEPOSITO'])],
  }, async (req, reply) => {
    const body = parcial(proveedorSchema).safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.issues[0].message })
    if (body.data.nombre) body.data.nombre = tituloCase(body.data.nombre)
    const r = await prisma.proveedor.updateMany({ where: { id: req.params.id, tenantId: req.tenantId }, data: body.data })
    if (r.count === 0) return reply.status(404).send({ error: 'not_found', message: 'Proveedor no encontrado.' })
    return prisma.proveedor.findUnique({ where: { id: req.params.id } })
  })

  fastify.delete('/proveedores/:id', {
    preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN'])],
  }, async (req, reply) => {
    const r = await prisma.proveedor.updateMany({ where: { id: req.params.id, tenantId: req.tenantId }, data: { activo: false } })
    if (r.count === 0) return reply.status(404).send({ error: 'not_found', message: 'Proveedor no encontrado.' })
    return { message: 'Proveedor desactivado.' }
  })

  // ── PATCH /proveedores/reactivar-masivo ────────────────────
  fastify.patch('/proveedores/reactivar-masivo', {
    preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN'])],
  }, async (req, reply) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : []
    if (!ids.length) return reply.status(400).send({ error: 'validation_error', message: 'Sin proveedores seleccionados.' })
    const r = await prisma.proveedor.updateMany({ where: { id: { in: ids }, tenantId: req.tenantId }, data: { activo: true } })
    return { message: r.count + ' proveedor(es) reactivado(s).', actualizados: r.count }
  })

  // ── POST /proveedores/:id/pago ─────────────────────────────
  // Pago a proveedor — siempre "inmediato" por definición (paga algo del saldo que ya se debe,
  // a diferencia de una compra nueva que puede ir a cta cte). Sube Proveedor.saldo (se acerca a
  // 0, negativo=debemos) y, si no es CAJA, genera el egreso correspondiente en Fondo/Transferencia.
  fastify.post('/proveedores/:id/pago', {
    preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN', 'VENDEDOR'])],
  }, async (req, reply) => {
    const body = pagoProveedorSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.issues[0].message })
    const { formaPago, cajaSesionId, monto, comentario, cotizacionOverride } = body.data

    const proveedor = await prisma.proveedor.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } })
    if (!proveedor) return reply.status(404).send({ error: 'not_found', message: 'Proveedor no encontrado.' })

    if ((formaPago === 'FONDO' || formaPago === 'TRANSFERENCIA_DUENO') && req.user.rol !== 'ADMIN') {
      return reply.status(403).send({ error: 'forbidden', message: 'Solo un admin puede pagar desde Fondo o Transferencia Dueño.' })
    }
    let caja = null
    if (formaPago === 'CAJA') {
      try { caja = await validarCajaParaPago(req, cajaSesionId) }
      catch (e) { return reply.status(e.status || 500).send(e.body || { error: 'error', message: e.message }) }
    }
    const cotizacion = await snapshotCotizacion(req.tenantId, monto, cotizacionOverride)

    const pago = await prisma.$transaction(async (tx) => {
      const p = await tx.pagoProveedor.create({
        data: { tenantId: req.tenantId, proveedorId: proveedor.id, monto, formaPago, cajaSesionId: caja?.id, comentario, usuarioId: req.user.id, ...cotizacion },
      })
      await tx.proveedor.update({ where: { id: proveedor.id }, data: { saldo: { increment: monto } } })
      if (formaPago !== 'CAJA') {
        await registrarMovimientoCuentaInterna({
          tenantId: req.tenantId, tipoCuenta: formaPago, tipoMovimiento: 'EGRESO',
          monto, concepto: 'Pago a proveedor: ' + proveedor.nombre, usuarioId: req.user.id,
        }, tx)
      }
      return p
    })
    return reply.status(201).send(pago)
  })

  // ── GET /proveedores/:id/pagos ─────────────────────────────
  // Balance de pagos a este proveedor por rango de fecha — "hace 1 año que le compro y ya le
  // vengo pagando 3M" (pedido explícito del usuario).
  fastify.get('/proveedores/:id/pagos', auth, async (req, reply) => {
    const proveedor = await prisma.proveedor.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } })
    if (!proveedor) return reply.status(404).send({ error: 'not_found', message: 'Proveedor no encontrado.' })
    const { desde, hasta } = req.query
    const where = {
      tenantId: req.tenantId, proveedorId: proveedor.id,
      ...((desde || hasta) && { fecha: { ...(desde && { gte: new Date(desde) }), ...(hasta && { lte: new Date(hasta) }) } }),
    }
    const pagos = await prisma.pagoProveedor.findMany({ where, orderBy: { fecha: 'desc' }, include: { usuario: { select: { nombre: true } } } })
    const totalPeriodo = pagos.reduce((s, p) => s + Number(p.monto), 0)
    const primeraCompra = await prisma.ordenCompra.findFirst({ where: { tenantId: req.tenantId, proveedorId: proveedor.id }, orderBy: { fecha: 'asc' }, select: { fecha: true } })
    return { proveedor: { id: proveedor.id, nombre: proveedor.nombre, saldo: proveedor.saldo }, pagos, totalPeriodo, primeraCompraFecha: primeraCompra?.fecha || null }
  })
}
