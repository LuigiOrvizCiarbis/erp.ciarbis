// ─────────────────────────────────────────────────────────────
//  Rutas: /api/v1/listas-precio
//  Margen ganancial bruto por categoría, distinto por lista — ver Cliente.listaPrecioId.
//  La lista "esDefault" (Consumidor Final) nunca pisa Producto.precioVenta; solo las listas
//  no-default recalculan el precio de línea en el momento de la venta (PoS, dashboard.html).
// ─────────────────────────────────────────────────────────────

import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { tituloCase } from '../../lib/textUtils.js'

const listaSchema = z.object({
  nombre: z.string().min(1),
})

const margenSchema = z.object({
  categoriaId: z.string().nullable().optional(),
  margenPct: z.number(),
})

// Autocurativo: si por lo que sea el tenant no tiene una lista "esDefault" (tenants nuevos
// creados después de esta feature, o un backfill que no llegó a correr), se crea acá mismo en
// vez de fallar o dejar que el usuario cree una duplicada sin darse cuenta.
export async function asegurarListaDefault(tenantId) {
  const existente = await prisma.listaPrecio.findFirst({ where: { tenantId, esDefault: true } })
  if (existente) return existente
  return prisma.listaPrecio.create({ data: { tenantId, nombre: 'Consumidor Final', esDefault: true } })
}

export default async function listasPrecioRoutes(fastify) {
  const auth = { preHandler: [fastify.verifyJWT, fastify.verifyTenant] }
  const adminOnly = { preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN'])] }

  fastify.get('/listas-precio', auth, async (req) => {
    await asegurarListaDefault(req.tenantId)
    const { activa } = req.query
    return prisma.listaPrecio.findMany({
      where: { tenantId: req.tenantId, ...(activa !== undefined ? { activa: activa === 'true' } : { activa: true }) },
      include: { margenes: { include: { categoria: { select: { id: true, nombre: true } } } } },
      orderBy: [{ esDefault: 'desc' }, { nombre: 'asc' }],
    })
  })

  fastify.post('/listas-precio', adminOnly, async (req, reply) => {
    const body = listaSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.errors[0].message })
    const nombre = tituloCase(body.data.nombre)
    const existe = await prisma.listaPrecio.findFirst({ where: { tenantId: req.tenantId, nombre: { equals: nombre, mode: 'insensitive' } } })
    if (existe) return reply.status(409).send({ error: 'nombre_duplicado', message: 'Ya existe una lista de precios con ese nombre.' })
    const lista = await prisma.listaPrecio.create({ data: { tenantId: req.tenantId, nombre } })
    return reply.status(201).send(lista)
  })

  fastify.put('/listas-precio/:id', adminOnly, async (req, reply) => {
    let { nombre, activa } = req.body || {}
    if (nombre !== undefined) {
      nombre = tituloCase(nombre)
      const existe = await prisma.listaPrecio.findFirst({ where: { tenantId: req.tenantId, nombre: { equals: nombre, mode: 'insensitive' }, id: { not: req.params.id } } })
      if (existe) return reply.status(409).send({ error: 'nombre_duplicado', message: 'Ya existe una lista de precios con ese nombre.' })
    }
    const r = await prisma.listaPrecio.updateMany({
      where: { id: req.params.id, tenantId: req.tenantId },
      data: { ...(nombre !== undefined && { nombre }), ...(activa !== undefined && { activa }) },
    })
    if (r.count === 0) return reply.status(404).send({ error: 'not_found', message: 'Lista de precios no encontrada.' })
    return prisma.listaPrecio.findUnique({ where: { id: req.params.id } })
  })

  fastify.delete('/listas-precio/:id', adminOnly, async (req, reply) => {
    const lista = await prisma.listaPrecio.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } })
    if (!lista) return reply.status(404).send({ error: 'not_found', message: 'Lista de precios no encontrada.' })
    if (lista.esDefault) return reply.status(400).send({ error: 'validation_error', message: 'No se puede desactivar la lista por defecto (Consumidor Final).' })
    await prisma.listaPrecio.update({ where: { id: lista.id }, data: { activa: false } })
    return { message: 'Lista de precios desactivada.' }
  })

  fastify.patch('/listas-precio/reactivar-masivo', adminOnly, async (req, reply) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : []
    if (!ids.length) return reply.status(400).send({ error: 'validation_error', message: 'Sin listas seleccionadas.' })
    const r = await prisma.listaPrecio.updateMany({ where: { id: { in: ids }, tenantId: req.tenantId }, data: { activa: true } })
    return { message: r.count + ' lista(s) de precio reactivada(s).', actualizadas: r.count }
  })

  // ── Margen por categoría dentro de una lista ──────────────
  fastify.put('/listas-precio/:id/margenes', adminOnly, async (req, reply) => {
    const body = margenSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.errors[0].message })
    const lista = await prisma.listaPrecio.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } })
    if (!lista) return reply.status(404).send({ error: 'not_found', message: 'Lista de precios no encontrada.' })

    // No se puede usar upsert() con el índice compuesto acá — Prisma no acepta `null` en el
    // `where` de un @@unique compuesto (categoriaId es nullable). Se resuelve a mano.
    const categoriaId = body.data.categoriaId || null
    const existente = await prisma.listaPrecioMargen.findFirst({ where: { listaPrecioId: lista.id, categoriaId } })
    const margen = existente
      ? await prisma.listaPrecioMargen.update({ where: { id: existente.id }, data: { margenPct: body.data.margenPct } })
      : await prisma.listaPrecioMargen.create({ data: { tenantId: req.tenantId, listaPrecioId: lista.id, categoriaId, margenPct: body.data.margenPct } })
    return reply.status(201).send(margen)
  })

  fastify.delete('/listas-precio/:id/margenes/:margenId', adminOnly, async (req, reply) => {
    const r = await prisma.listaPrecioMargen.deleteMany({
      where: { id: req.params.margenId, listaPrecioId: req.params.id, tenantId: req.tenantId },
    })
    if (r.count === 0) return reply.status(404).send({ error: 'not_found', message: 'Margen no encontrado.' })
    return { message: 'Margen eliminado.' }
  })
}
