// ─────────────────────────────────────────────────────────────
//  Rutas: /api/v1/listas-precio
//  V2.108.0 — listas automáticas: la principal (esDefault) calcula y GUARDA Producto.precioVenta
//  desde el costo con sus reglas (% / $ fijo / manual, por producto, categoría, proveedor o
//  categoría+proveedor); las secundarias se calculan al vuelo sobre la principal o el costo.
//  Lógica de cálculo: src/lib/listasPrecio.js. Ver Cliente.listaPrecioId y Ticket.listaPrecioNombre.
// ─────────────────────────────────────────────────────────────

import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { tituloCase } from '../../lib/textUtils.js'
import { invalidarListas, previewPrincipal, aplicarPrincipal } from '../../lib/listasPrecio.js'
import { registrarAuditoria } from '../../lib/auditoria.js'

const listaSchema = z.object({
  nombre: z.string().min(1),
  base: z.enum(['PRINCIPAL', 'COSTO']).optional(),
  redondeo: z.number().min(0).optional(),
})

const TIPOS = ['PCT', 'MONTO', 'MANUAL']
const reglaSchema = z.object({
  tipo: z.enum(TIPOS).default('PCT'),
  valor: z.number(),
  categoriaId: z.string().nullable().optional(),
  proveedorId: z.string().nullable().optional(),
  productoIds: z.array(z.string()).optional(), // varios productos → una regla por producto
})

const reglaEditSchema = z.object({
  tipo: z.enum(TIPOS),
  valor: z.number(),
})

// Compat con el form viejo (V2.27): {categoriaId, margenPct}
const margenSchema = z.object({
  categoriaId: z.string().nullable().optional(),
  margenPct: z.number(),
})

const excluirSchema = z.object({
  productoIds: z.array(z.string()).default([]),
  categoriaIds: z.array(z.string()).default([]),
  proveedorIds: z.array(z.string()).default([]),
}).default({ productoIds: [], categoriaIds: [], proveedorIds: [] })

const INCLUDE_REGLAS = {
  margenes: {
    include: {
      categoria: { select: { id: true, nombre: true, parentId: true } },
      proveedor: { select: { id: true, nombre: true } },
      producto: { select: { id: true, nombre: true, sku: true } },
    },
  },
}

// Autocurativo: si por lo que sea el tenant no tiene una lista "esDefault" (tenants nuevos
// creados después de esta feature, o un backfill que no llegó a correr), se crea acá mismo en
// vez de fallar o dejar que el usuario cree una duplicada sin darse cuenta.
export async function asegurarListaDefault(tenantId) {
  const existente = await prisma.listaPrecio.findFirst({ where: { tenantId, esDefault: true } })
  if (existente) return existente
  return prisma.listaPrecio.create({ data: { tenantId, nombre: 'Consumidor Final', esDefault: true, base: 'COSTO' } })
}

const margenLegado = (tipo, valor) => (tipo === 'PCT' && Math.abs(valor) < 10000 ? valor : 0)

// Crea o actualiza (si ya hay una con el mismo destino) la regla de un destino puntual.
async function guardarRegla(tenantId, listaId, destino, tipo, valor) {
  const where = {
    listaPrecioId: listaId,
    categoriaId: destino.categoriaId || null,
    proveedorId: destino.proveedorId || null,
    productoId: destino.productoId || null,
  }
  const data = { tipo, valor, margenPct: margenLegado(tipo, valor) }
  const existente = await prisma.listaPrecioMargen.findFirst({ where })
  return existente
    ? prisma.listaPrecioMargen.update({ where: { id: existente.id }, data })
    : prisma.listaPrecioMargen.create({ data: { tenantId, ...where, ...data } })
}

export default async function listasPrecioRoutes(fastify) {
  const auth = { preHandler: [fastify.verifyJWT, fastify.verifyTenant] }
  const adminOnly = { preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN'])] }

  fastify.get('/listas-precio', auth, async (req) => {
    await asegurarListaDefault(req.tenantId)
    const { activa } = req.query
    const listas = await prisma.listaPrecio.findMany({
      where: { tenantId: req.tenantId, ...(activa !== undefined ? { activa: activa === 'true' } : { activa: true }) },
      include: INCLUDE_REGLAS,
      orderBy: [{ esDefault: 'desc' }, { nombre: 'asc' }],
    })
    return listas.map((l) => ({ ...l, base: l.esDefault ? 'COSTO' : l.base }))
  })

  fastify.post('/listas-precio', adminOnly, async (req, reply) => {
    const body = listaSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.issues[0].message })
    const nombre = tituloCase(body.data.nombre)
    const existe = await prisma.listaPrecio.findFirst({ where: { tenantId: req.tenantId, nombre: { equals: nombre, mode: 'insensitive' } } })
    if (existe) return reply.status(409).send({ error: 'nombre_duplicado', message: 'Ya existe una lista de precios con ese nombre.' })
    const lista = await prisma.listaPrecio.create({
      data: {
        tenantId: req.tenantId, nombre,
        ...(body.data.base && { base: body.data.base }),
        ...(body.data.redondeo !== undefined && { redondeo: body.data.redondeo }),
      },
    })
    invalidarListas(req.tenantId)
    return reply.status(201).send(lista)
  })

  fastify.put('/listas-precio/:id', adminOnly, async (req, reply) => {
    let { nombre, activa, base, redondeo } = req.body || {}
    if (nombre !== undefined) {
      nombre = tituloCase(nombre)
      const existe = await prisma.listaPrecio.findFirst({ where: { tenantId: req.tenantId, nombre: { equals: nombre, mode: 'insensitive' }, id: { not: req.params.id } } })
      if (existe) return reply.status(409).send({ error: 'nombre_duplicado', message: 'Ya existe una lista de precios con ese nombre.' })
    }
    if (base !== undefined && !['PRINCIPAL', 'COSTO'].includes(base)) return reply.status(400).send({ error: 'validation_error', message: 'Base inválida.' })
    if (redondeo !== undefined && !(Number(redondeo) >= 0)) return reply.status(400).send({ error: 'validation_error', message: 'Redondeo inválido.' })
    const r = await prisma.listaPrecio.updateMany({
      where: { id: req.params.id, tenantId: req.tenantId },
      data: {
        ...(nombre !== undefined && { nombre }),
        ...(activa !== undefined && { activa }),
        ...(base !== undefined && { base }),
        ...(redondeo !== undefined && { redondeo: Number(redondeo) }),
      },
    })
    if (r.count === 0) return reply.status(404).send({ error: 'not_found', message: 'Lista de precios no encontrada.' })
    invalidarListas(req.tenantId)
    return prisma.listaPrecio.findUnique({ where: { id: req.params.id } })
  })

  fastify.delete('/listas-precio/:id', adminOnly, async (req, reply) => {
    const lista = await prisma.listaPrecio.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } })
    if (!lista) return reply.status(404).send({ error: 'not_found', message: 'Lista de precios no encontrada.' })
    if (lista.esDefault) return reply.status(400).send({ error: 'validation_error', message: 'No se puede desactivar la lista principal.' })
    await prisma.listaPrecio.update({ where: { id: lista.id }, data: { activa: false } })
    invalidarListas(req.tenantId)
    return { message: 'Lista de precios desactivada.' }
  })

  fastify.patch('/listas-precio/reactivar-masivo', adminOnly, async (req, reply) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : []
    if (!ids.length) return reply.status(400).send({ error: 'validation_error', message: 'Sin listas seleccionadas.' })
    const r = await prisma.listaPrecio.updateMany({ where: { id: { in: ids }, tenantId: req.tenantId }, data: { activa: true } })
    invalidarListas(req.tenantId)
    return { message: r.count + ' lista(s) de precio reactivada(s).', actualizados: r.count }
  })

  // ── Reglas ──────────────────────────────────────────────────
  // Un POST puede crear varias: productoIds → una por producto; si no, una para el destino
  // categoría / proveedor / categoría+proveedor / general (sin nada).
  fastify.post('/listas-precio/:id/reglas', adminOnly, async (req, reply) => {
    const body = reglaSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.issues[0].message })
    const { tipo, valor, categoriaId, proveedorId, productoIds } = body.data
    if (tipo !== 'MONTO' && valor < (tipo === 'PCT' ? -100 : 0)) return reply.status(400).send({ error: 'validation_error', message: tipo === 'PCT' ? 'El % no puede bajar de -100.' : 'El precio no puede ser negativo.' })
    const lista = await prisma.listaPrecio.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } })
    if (!lista) return reply.status(404).send({ error: 'not_found', message: 'Lista de precios no encontrada.' })

    // Los destinos tienen que ser del mismo tenant.
    if (categoriaId && !(await prisma.categoria.count({ where: { id: categoriaId, tenantId: req.tenantId } }))) return reply.status(400).send({ error: 'validation_error', message: 'Categoría inválida.' })
    if (proveedorId && !(await prisma.proveedor.count({ where: { id: proveedorId, tenantId: req.tenantId } }))) return reply.status(400).send({ error: 'validation_error', message: 'Proveedor inválido.' })

    const creadas = []
    if (productoIds && productoIds.length) {
      const validos = await prisma.producto.findMany({ where: { id: { in: productoIds }, tenantId: req.tenantId }, select: { id: true } })
      for (const p of validos) creadas.push(await guardarRegla(req.tenantId, lista.id, { productoId: p.id }, tipo, valor))
    } else {
      creadas.push(await guardarRegla(req.tenantId, lista.id, { categoriaId, proveedorId }, tipo, valor))
    }
    invalidarListas(req.tenantId)
    return reply.status(201).send({ creadas: creadas.length, reglas: creadas })
  })

  fastify.put('/listas-precio/:id/reglas/:reglaId', adminOnly, async (req, reply) => {
    const body = reglaEditSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.issues[0].message })
    const { tipo, valor } = body.data
    const r = await prisma.listaPrecioMargen.updateMany({
      where: { id: req.params.reglaId, listaPrecioId: req.params.id, tenantId: req.tenantId },
      data: { tipo, valor, margenPct: margenLegado(tipo, valor) },
    })
    if (r.count === 0) return reply.status(404).send({ error: 'not_found', message: 'Regla no encontrada.' })
    invalidarListas(req.tenantId)
    return { message: 'Regla actualizada.' }
  })

  const borrarRegla = async (req, reply) => {
    const id = req.params.reglaId || req.params.margenId
    const r = await prisma.listaPrecioMargen.deleteMany({ where: { id, listaPrecioId: req.params.id, tenantId: req.tenantId } })
    if (r.count === 0) return reply.status(404).send({ error: 'not_found', message: 'Regla no encontrada.' })
    invalidarListas(req.tenantId)
    return { message: 'Regla eliminada.' }
  }
  fastify.delete('/listas-precio/:id/reglas/:reglaId', adminOnly, borrarRegla)
  fastify.delete('/listas-precio/:id/margenes/:margenId', adminOnly, borrarRegla) // compat

  // Compat V2.27: margen % por categoría (o general).
  fastify.put('/listas-precio/:id/margenes', adminOnly, async (req, reply) => {
    const body = margenSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.issues[0].message })
    const lista = await prisma.listaPrecio.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } })
    if (!lista) return reply.status(404).send({ error: 'not_found', message: 'Lista de precios no encontrada.' })
    const margen = await guardarRegla(req.tenantId, lista.id, { categoriaId: body.data.categoriaId }, 'PCT', body.data.margenPct)
    invalidarListas(req.tenantId)
    return reply.status(201).send(margen)
  })

  // ── Aplicar la lista principal (vista previa + confirmar) ──
  fastify.post('/listas-precio/principal/preview', adminOnly, async (req, reply) => {
    const ex = excluirSchema.safeParse(req.body?.excluir)
    if (!ex.success) return reply.status(400).send({ error: 'validation_error', message: ex.error.issues[0].message })
    await asegurarListaDefault(req.tenantId)
    invalidarListas(req.tenantId)
    return previewPrincipal(req.tenantId, ex.data)
  })

  fastify.post('/listas-precio/principal/aplicar', adminOnly, async (req, reply) => {
    const ex = excluirSchema.safeParse(req.body?.excluir)
    if (!ex.success) return reply.status(400).send({ error: 'validation_error', message: ex.error.issues[0].message })
    await asegurarListaDefault(req.tenantId)
    invalidarListas(req.tenantId)
    const r = await aplicarPrincipal(req.tenantId, ex.data)
    await registrarAuditoria({
      tenantId: req.tenantId, userId: req.user.id, req,
      accion: 'lista_precio.aplicar', entidad: 'ListaPrecio', entidadId: null,
      detalle: r,
    })
    return { ...r, message: `${r.actualizados} precio(s) actualizado(s)` + (r.excluidos ? `, ${r.excluidos} quedaron con precio manual.` : '.') }
  })
}
