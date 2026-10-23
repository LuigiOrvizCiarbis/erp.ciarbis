// ─────────────────────────────────────────────────────────────
//  Rutas: /api/v1/configuracion/puntos, /api/v1/reglas-bonus-puntos
//  Fidelización — solo el admin configura. Puntos base = total de la venta × puntosPorMonto
//  (si la venta alcanza compraMinima), multiplicados por la MEJOR regla de bonificación que
//  aplique (no se apilan varias a la vez, para que sea fácil de auditar). Se acreditan solo a
//  clientes reales (no a "Consumidor Final") — ver calcularYAcreditarPuntos, usado desde
//  POST /tickets.
// ─────────────────────────────────────────────────────────────

import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'

const configSchema = z.object({
  activo: z.boolean().optional(),
  puntosPorMonto: z.number().min(0).optional(),
  compraMinima: z.number().min(0).nullable().optional(),
  puntosMaxPorCompra: z.number().int().positive().nullable().optional(),
})

const reglaSchema = z.object({
  tipo: z.enum(['PRODUCTO', 'CATEGORIA', 'DIA_SEMANA', 'HORARIO', 'MONTO_MINIMO']),
  productoId: z.string().optional().nullable(),
  categoriaId: z.string().optional().nullable(),
  diaSemana: z.number().int().min(0).max(6).optional().nullable(),
  horaDesde: z.string().optional().nullable(),
  horaHasta: z.string().optional().nullable(),
  montoMinimo: z.number().min(0).optional().nullable(),
  multiplicador: z.number().positive(),
})

async function getOrCrearConfig(tenantId) {
  const existente = await prisma.configuracionPuntos.findUnique({ where: { tenantId } })
  if (existente) return existente
  return prisma.configuracionPuntos.create({ data: { tenantId } })
}

// Elige la regla de bonificación de multiplicador MÁS ALTO entre las que apliquen a esta venta
// — no se apilan varias reglas, para que sea fácil de explicar/auditar.
function elegirMejorMultiplicador(reglas, { productosIds, categoriasIds, fecha, total }) {
  const dia = fecha.getDay()
  const horaActual = fecha.toTimeString().slice(0, 5)
  let mejor = 1
  for (const r of reglas) {
    if (!r.activo) continue
    let matchea = false
    if (r.tipo === 'PRODUCTO' && r.productoId && productosIds.includes(r.productoId)) matchea = true
    else if (r.tipo === 'CATEGORIA' && r.categoriaId && categoriasIds.includes(r.categoriaId)) matchea = true
    else if (r.tipo === 'DIA_SEMANA' && r.diaSemana === dia) matchea = true
    else if (r.tipo === 'HORARIO' && r.horaDesde && r.horaHasta && horaActual >= r.horaDesde && horaActual <= r.horaHasta) matchea = true
    else if (r.tipo === 'MONTO_MINIMO' && r.montoMinimo != null && total >= Number(r.montoMinimo)) matchea = true
    if (matchea && Number(r.multiplicador) > mejor) mejor = Number(r.multiplicador)
  }
  return mejor
}

// Se llama desde POST /tickets después de confirmar la venta — nunca bloquea ni retrasa la
// venta si algo falla acá (mismo criterio que registrarAuditoria).
export async function calcularYAcreditarPuntos({ tenantId, clienteId, total, lineas, fecha }) {
  try {
    if (!clienteId) return null
    const cliente = await prisma.cliente.findFirst({ where: { id: clienteId, tenantId } })
    if (!cliente || cliente.esConsumidorFinal) return null

    const config = await prisma.configuracionPuntos.findUnique({ where: { tenantId } })
    if (!config || !config.activo || Number(config.puntosPorMonto) <= 0) return null
    if (config.compraMinima && Number(total) < Number(config.compraMinima)) return null

    const productosIds = [...new Set((lineas || []).map(l => l.productoId).filter(Boolean))]
    let categoriasIds = []
    if (productosIds.length) {
      const productos = await prisma.producto.findMany({ where: { id: { in: productosIds }, tenantId }, select: { categoriaId: true } })
      categoriasIds = [...new Set(productos.map(p => p.categoriaId).filter(Boolean))]
    }
    const reglas = await prisma.reglaBonusPuntos.findMany({ where: { tenantId, activo: true } })
    const multiplicador = elegirMejorMultiplicador(reglas, { productosIds, categoriasIds, fecha: fecha || new Date(), total: Number(total) })

    let puntos = Math.floor(Number(total) * Number(config.puntosPorMonto) * multiplicador)
    if (config.puntosMaxPorCompra != null) puntos = Math.min(puntos, config.puntosMaxPorCompra)
    if (puntos <= 0) return null

    await prisma.cliente.update({ where: { id: clienteId }, data: { puntos: { increment: puntos } } })
    return { puntos, multiplicador }
  } catch {
    return null
  }
}

export default async function puntosRoutes(fastify) {
  const auth = { preHandler: [fastify.verifyJWT, fastify.verifyTenant] }
  const adminOnly = { preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN'])] }

  fastify.get('/configuracion/puntos', auth, async (req) => {
    return getOrCrearConfig(req.tenantId)
  })

  fastify.put('/configuracion/puntos', adminOnly, async (req, reply) => {
    const body = configSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.errors[0].message })
    await getOrCrearConfig(req.tenantId)
    const item = await prisma.configuracionPuntos.update({ where: { tenantId: req.tenantId }, data: body.data })
    return item
  })

  fastify.get('/reglas-bonus-puntos', adminOnly, async (req) => {
    return prisma.reglaBonusPuntos.findMany({
      where: { tenantId: req.tenantId },
      include: { },
      orderBy: { creadoEn: 'desc' },
    })
  })

  // No hay campo "nombre" en esta entidad — la regla se identifica por tipo + su target
  // (producto/categoría/día/horario/monto). El duplicado real acá es la MISMA combinación
  // dos veces, no un nombre repetido.
  function reglaDuplicadaWhere(tenantId, data, excluirId) {
    const base = { tenantId, tipo: data.tipo, ...(excluirId && { id: { not: excluirId } }) }
    switch (data.tipo) {
      case 'PRODUCTO': return { ...base, productoId: data.productoId }
      case 'CATEGORIA': return { ...base, categoriaId: data.categoriaId }
      case 'DIA_SEMANA': return { ...base, diaSemana: data.diaSemana }
      case 'HORARIO': return { ...base, horaDesde: data.horaDesde, horaHasta: data.horaHasta }
      case 'MONTO_MINIMO': return { ...base, montoMinimo: data.montoMinimo }
      default: return null
    }
  }

  fastify.post('/reglas-bonus-puntos', adminOnly, async (req, reply) => {
    const body = reglaSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.errors[0].message })
    const where = reglaDuplicadaWhere(req.tenantId, body.data)
    if (where) {
      const existe = await prisma.reglaBonusPuntos.findFirst({ where })
      if (existe) return reply.status(409).send({ error: 'regla_duplicada', message: 'Ya existe una regla de bonus igual a esta.' })
    }
    const regla = await prisma.reglaBonusPuntos.create({ data: { tenantId: req.tenantId, ...body.data } })
    return reply.status(201).send(regla)
  })

  fastify.put('/reglas-bonus-puntos/:id', adminOnly, async (req, reply) => {
    const body = reglaSchema.partial().safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.errors[0].message })
    const r = await prisma.reglaBonusPuntos.updateMany({ where: { id: req.params.id, tenantId: req.tenantId }, data: body.data })
    if (r.count === 0) return reply.status(404).send({ error: 'not_found', message: 'Regla no encontrada.' })
    return prisma.reglaBonusPuntos.findUnique({ where: { id: req.params.id } })
  })

  fastify.delete('/reglas-bonus-puntos/:id', adminOnly, async (req, reply) => {
    const r = await prisma.reglaBonusPuntos.updateMany({ where: { id: req.params.id, tenantId: req.tenantId }, data: { activo: false } })
    if (r.count === 0) return reply.status(404).send({ error: 'not_found', message: 'Regla no encontrada.' })
    return { message: 'Regla desactivada.' }
  })

  fastify.patch('/reglas-bonus-puntos/reactivar-masivo', adminOnly, async (req, reply) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : []
    if (!ids.length) return reply.status(400).send({ error: 'validation_error', message: 'Sin reglas seleccionadas.' })
    const r = await prisma.reglaBonusPuntos.updateMany({ where: { id: { in: ids }, tenantId: req.tenantId }, data: { activo: true } })
    return { message: r.count + ' regla(s) reactivada(s).', actualizadas: r.count }
  })
}
