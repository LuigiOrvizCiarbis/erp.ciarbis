// ─────────────────────────────────────────────────────────────
//  Rutas: /api/v1/cupones
//  Solo el admin los crea/edita. Cada cupón decide si combina o no con:
//  - el descuento total manual del PoS (combinaConDescuentoManual)
//  - el descuento que el cliente ya tiene por su cuenta, sea por Cliente.descuento
//    o por la lista de precios que tenga asignada (combinaConDescuentoCliente)
//  El conteo de usos (total y por cliente) se hace contando Ticket.cuponId — no hay
//  tabla de log aparte, ver prisma/schema.prisma.
// ─────────────────────────────────────────────────────────────

import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'

const cuponSchema = z.object({
  codigo: z.string().min(1).transform(s => s.trim().toUpperCase()),
  tipo: z.enum(['PORCENTAJE', 'MONTO']).default('PORCENTAJE'),
  valor: z.number().positive(),
  fechaDesde: z.string().optional().nullable(),
  fechaHasta: z.string().optional().nullable(),
  montoMinimoCompra: z.number().min(0).optional().nullable(),
  usosMax: z.number().int().positive().optional().nullable(),
  usosMaxPorCliente: z.number().int().positive().optional().nullable(),
  combinaConDescuentoManual: z.boolean().default(false),
  combinaConDescuentoCliente: z.boolean().default(false),
})

function normalizarFecha(s) {
  if (!s) return null
  return s.length === 10 ? new Date(s + 'T00:00:00.000Z') : new Date(s)
}

// Reutilizable desde POST /tickets para re-validar server-side antes de confirmar la venta
// (nunca confiar solo en lo que ya validó el frontend al tipear el código).
export async function validarCuponParaVenta(tenantId, codigo, clienteId, montoCompra) {
  const cupon = await prisma.cupon.findFirst({ where: { tenantId, codigo: String(codigo || '').trim().toUpperCase() } })
  if (!cupon) return { ok: false, error: 'no_encontrado', message: 'Cupón no encontrado.' }
  if (!cupon.activo) return { ok: false, error: 'inactivo', message: 'Este cupón ya no está activo.' }

  const ahora = new Date()
  if (cupon.fechaDesde && ahora < cupon.fechaDesde) return { ok: false, error: 'aun_no_vigente', message: 'Este cupón todavía no está vigente.' }
  if (cupon.fechaHasta && ahora > cupon.fechaHasta) return { ok: false, error: 'vencido', message: 'Este cupón ya venció.' }

  if (cupon.montoMinimoCompra && Number(montoCompra) < Number(cupon.montoMinimoCompra)) {
    return { ok: false, error: 'monto_minimo', message: `La compra mínima para este cupón es $${Number(cupon.montoMinimoCompra).toFixed(2)}.` }
  }

  if (cupon.usosMax != null) {
    const usosTotales = await prisma.ticket.count({ where: { tenantId, cuponId: cupon.id, estado: 'EMITIDO' } })
    if (usosTotales >= cupon.usosMax) return { ok: false, error: 'usos_agotados', message: 'Este cupón ya alcanzó el máximo de usos permitidos.' }
  }

  if (cupon.usosMaxPorCliente != null) {
    if (!clienteId) return { ok: false, error: 'cliente_requerido', message: 'Este cupón tiene un límite de usos por cliente — seleccioná un cliente (no aplica a Consumidor Final).' }
    const usosCliente = await prisma.ticket.count({ where: { tenantId, cuponId: cupon.id, clienteId, estado: 'EMITIDO' } })
    if (usosCliente >= cupon.usosMaxPorCliente) return { ok: false, error: 'usos_cliente_agotados', message: 'Este cliente ya usó este cupón el máximo de veces permitido.' }
  }

  return { ok: true, cupon }
}

export default async function cuponesRoutes(fastify) {
  const auth = { preHandler: [fastify.verifyJWT, fastify.verifyTenant] }
  const adminOnly = { preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN'])] }

  fastify.get('/cupones', adminOnly, async (req) => {
    return prisma.cupon.findMany({ where: { tenantId: req.tenantId }, orderBy: { creadoEn: 'desc' } })
  })

  fastify.post('/cupones', adminOnly, async (req, reply) => {
    const body = cuponSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.errors[0].message })
    const existente = await prisma.cupon.findFirst({ where: { tenantId: req.tenantId, codigo: { equals: body.data.codigo, mode: 'insensitive' } } })
    if (existente) return reply.status(409).send({ error: 'codigo_duplicado', message: 'Ya existe un cupón con ese código.' })
    const cupon = await prisma.cupon.create({
      data: {
        tenantId: req.tenantId,
        ...body.data,
        fechaDesde: normalizarFecha(body.data.fechaDesde),
        fechaHasta: normalizarFecha(body.data.fechaHasta),
      },
    })
    return reply.status(201).send(cupon)
  })

  fastify.put('/cupones/:id', adminOnly, async (req, reply) => {
    const body = cuponSchema.partial().safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.errors[0].message })
    const data = { ...body.data }
    if (data.codigo) {
      const existente = await prisma.cupon.findFirst({ where: { tenantId: req.tenantId, codigo: { equals: data.codigo, mode: 'insensitive' }, id: { not: req.params.id } } })
      if (existente) return reply.status(409).send({ error: 'codigo_duplicado', message: 'Ya existe un cupón con ese código.' })
    }
    if ('fechaDesde' in data) data.fechaDesde = normalizarFecha(data.fechaDesde)
    if ('fechaHasta' in data) data.fechaHasta = normalizarFecha(data.fechaHasta)
    const r = await prisma.cupon.updateMany({ where: { id: req.params.id, tenantId: req.tenantId }, data })
    if (r.count === 0) return reply.status(404).send({ error: 'not_found', message: 'Cupón no encontrado.' })
    return prisma.cupon.findUnique({ where: { id: req.params.id } })
  })

  fastify.delete('/cupones/:id', adminOnly, async (req, reply) => {
    const r = await prisma.cupon.updateMany({ where: { id: req.params.id, tenantId: req.tenantId }, data: { activo: false } })
    if (r.count === 0) return reply.status(404).send({ error: 'not_found', message: 'Cupón no encontrado.' })
    return { message: 'Cupón desactivado.' }
  })

  fastify.patch('/cupones/reactivar-masivo', adminOnly, async (req, reply) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : []
    if (!ids.length) return reply.status(400).send({ error: 'validation_error', message: 'Sin cupones seleccionados.' })
    const r = await prisma.cupon.updateMany({ where: { id: { in: ids }, tenantId: req.tenantId }, data: { activo: true } })
    return { message: r.count + ' cupón(es) reactivado(s).', actualizados: r.count }
  })

  // Validación en vivo desde el PoS al tipear el código — cualquier usuario autenticado
  // (el cajero necesita poder probar el cupón, no solo el admin que lo creó).
  fastify.post('/cupones/validar', auth, async (req, reply) => {
    const { codigo, clienteId, montoCompra } = req.body || {}
    if (!codigo) return reply.status(400).send({ ok: false, error: 'validation_error', message: 'Falta el código.' })
    const r = await validarCuponParaVenta(req.tenantId, codigo, clienteId || null, Number(montoCompra) || 0)
    return r
  })
}
