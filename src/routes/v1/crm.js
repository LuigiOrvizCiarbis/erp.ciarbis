// ─────────────────────────────────────────────────────────────
//  Rutas: /api/v1/crm — Contactos, Etiquetas, Tareas/Agenda, Embudo, Notas, Campos custom
//  Fase 2 del CRM (bajo el módulo "Clientes") — Mensajes (chats) sigue como vitrina sin backend.
// ─────────────────────────────────────────────────────────────

import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { tituloCase } from '../../lib/textUtils.js'

const ETAPAS_EMBUDO = ['NUEVO', 'CONTACTADO', 'PROPUESTA', 'NEGOCIACION', 'GANADO', 'PERDIDO']

const contactoSchema = z.object({
  nombre: z.string().min(1),
  empresa: z.string().optional(),
  cargo: z.string().optional(),
  email: z.string().email().optional().or(z.literal('')),
  tel: z.string().optional(),
  whatsapp: z.string().optional(),
  notas: z.string().optional(),
  clienteId: z.string().nullable().optional(),
  etapa: z.enum(ETAPAS_EMBUDO).optional(),
  valorEstimado: z.number().nonnegative().nullable().optional(),
  camposCustom: z.record(z.string(), z.any()).optional(),
  sucursalId: z.string().nullable().optional(),
  usuarioId: z.string().nullable().optional(),
  activo: z.boolean().optional(),
})

const etapaSchema = z.object({
  etapa: z.enum(ETAPAS_EMBUDO),
})

const embudoMoverSchema = z.object({
  etapaCustomId: z.string().min(1),
})

const notaSchema = z.object({
  texto: z.string().min(1),
})

const campoCustomSchema = z.object({
  clave: z.string().min(1).regex(/^[a-z0-9_]+$/, 'Usá minúsculas, números y guión bajo.'),
  label: z.string().min(1),
  tipo: z.enum(['TEXTO', 'NUMERO', 'FECHA', 'SELECT']).optional(),
  opciones: z.string().nullable().optional(),
  mostrarEnEmbudo: z.boolean().optional(),
})

const etiquetaSchema = z.object({
  nombre: z.string().min(1),
  color: z.string().optional(),
})

const tareaSchema = z.object({
  titulo: z.string().min(1),
  descripcion: z.string().optional(),
  fechaInicio: z.string().nullable().optional(),
  fechaVencimiento: z.string().nullable().optional(),
  prioridad: z.enum(['BAJA', 'MEDIA', 'ALTA']).optional(),
  tipo: z.enum(['LLAMADA', 'REUNION', 'EMAIL', 'SEGUIMIENTO', 'GENERAL']).optional(),
  contactoId: z.string().nullable().optional(),
})

const tipoEmbudoSchema = z.object({
  nombre: z.string().min(1),
  esDefault: z.boolean().optional(),
})

const etapaEmbudoCustomSchema = z.object({
  nombre: z.string().min(1),
  color: z.string().optional(),
})

export default async function crmRoutes(fastify) {
  const auth = { preHandler: [fastify.verifyJWT, fastify.verifyTenant] }

  // ── Contactos ──────────────────────────────────────────────
  fastify.get('/crm/contactos', auth, async (req) => {
    const { q, incluirInactivos, tipoEmbudoId, sucursalId, usuarioId, desde, hasta } = req.query
    const where = {
      tenantId: req.tenantId,
      ...(incluirInactivos !== 'true' && { activo: true }),
      ...(tipoEmbudoId && { tipoEmbudoId }),
      ...(sucursalId && { sucursalId }),
      ...(usuarioId && { usuarioId }),
      ...((desde || hasta) && { creadoEn: { ...(desde && { gte: new Date(desde) }), ...(hasta && { lte: new Date(hasta) }) } }),
      ...(q && {
        OR: [
          { nombre: { contains: q, mode: 'insensitive' } },
          { empresa: { contains: q, mode: 'insensitive' } },
          { email: { contains: q, mode: 'insensitive' } },
        ],
      }),
    }
    const contactos = await prisma.contacto.findMany({
      where,
      include: { etiquetas: { include: { etiqueta: true } } },
      orderBy: { creadoEn: 'desc' },
    })
    return contactos.map((c) => ({ ...c, etiquetas: c.etiquetas.map((e) => e.etiqueta) }))
  })

  fastify.post('/crm/contactos', auth, async (req, reply) => {
    const body = contactoSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.errors[0].message })
    body.data.nombre = tituloCase(body.data.nombre)
    const { nombre, tel, email } = body.data
    // Guarda contra doble-submit — mismo criterio que clientes.js/proveedores.js.
    if (tel || email) {
      const duplicado = await prisma.contacto.findFirst({
        where: {
          tenantId: req.tenantId,
          nombre: { equals: nombre, mode: 'insensitive' },
          OR: [...(tel ? [{ tel }] : []), ...(email ? [{ email }] : [])],
        },
      })
      if (duplicado) {
        return reply.status(409).send({ error: 'contacto_duplicado', message: `Ya existe un contacto "${duplicado.nombre}" con ese mismo teléfono o email.` })
      }
    }
    const contacto = await prisma.contacto.create({ data: { tenantId: req.tenantId, ...body.data } })
    return reply.status(201).send(contacto)
  })

  fastify.put('/crm/contactos/:id', auth, async (req, reply) => {
    const body = contactoSchema.partial().safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.errors[0].message })
    if (body.data.nombre) body.data.nombre = tituloCase(body.data.nombre)
    const r = await prisma.contacto.updateMany({ where: { id: req.params.id, tenantId: req.tenantId }, data: body.data })
    if (r.count === 0) return reply.status(404).send({ error: 'not_found', message: 'Contacto no encontrado.' })
    return prisma.contacto.findUnique({ where: { id: req.params.id } })
  })

  fastify.delete('/crm/contactos/:id', auth, async (req, reply) => {
    const r = await prisma.contacto.updateMany({ where: { id: req.params.id, tenantId: req.tenantId }, data: { activo: false } })
    if (r.count === 0) return reply.status(404).send({ error: 'not_found', message: 'Contacto no encontrado.' })
    return { message: 'Contacto desactivado.' }
  })

  fastify.patch('/crm/contactos/reactivar-masivo', auth, async (req, reply) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : []
    if (!ids.length) return reply.status(400).send({ error: 'validation_error', message: 'Sin contactos seleccionados.' })
    const r = await prisma.contacto.updateMany({ where: { id: { in: ids }, tenantId: req.tenantId }, data: { activo: true } })
    return { message: r.count + ' contacto(s) reactivado(s).', actualizados: r.count }
  })

  // Reemplaza el set completo de etiquetas de un contacto (más simple que agregar/quitar una por una)
  fastify.put('/crm/contactos/:id/etiquetas', auth, async (req, reply) => {
    const contacto = await prisma.contacto.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } })
    if (!contacto) return reply.status(404).send({ error: 'not_found', message: 'Contacto no encontrado.' })
    const etiquetaIds = Array.isArray(req.body?.etiquetaIds) ? req.body.etiquetaIds : []
    await prisma.$transaction([
      prisma.etiquetaContacto.deleteMany({ where: { contactoId: contacto.id } }),
      ...(etiquetaIds.length ? [prisma.etiquetaContacto.createMany({ data: etiquetaIds.map((etiquetaId) => ({ contactoId: contacto.id, etiquetaId })) })] : []),
    ])
    return { message: 'Etiquetas actualizadas.' }
  })

  // Legacy — el Dashboard todavía usa el campo `etapa` (enum fijo) para el funnel-chart.
  fastify.patch('/crm/contactos/:id/etapa', auth, async (req, reply) => {
    const body = etapaSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.errors[0].message })
    const r = await prisma.contacto.updateMany({ where: { id: req.params.id, tenantId: req.tenantId }, data: { etapa: body.data.etapa } })
    if (r.count === 0) return reply.status(404).send({ error: 'not_found', message: 'Contacto no encontrado.' })
    return { message: 'Etapa actualizada.' }
  })

  // Mover de etapa en el Kanban de Embudo (drag-and-drop) — deriva tipoEmbudoId de la etapa
  // destino, así el frontend solo manda el id de la columna donde soltó la card.
  fastify.patch('/crm/contactos/:id/embudo', auth, async (req, reply) => {
    const body = embudoMoverSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.errors[0].message })
    const etapaDestino = await prisma.etapaEmbudoCustom.findFirst({ where: { id: body.data.etapaCustomId, tenantId: req.tenantId } })
    if (!etapaDestino) return reply.status(404).send({ error: 'not_found', message: 'Etapa no encontrada.' })
    const r = await prisma.contacto.updateMany({
      where: { id: req.params.id, tenantId: req.tenantId },
      data: { etapaCustomId: etapaDestino.id, tipoEmbudoId: etapaDestino.tipoEmbudoId },
    })
    if (r.count === 0) return reply.status(404).send({ error: 'not_found', message: 'Contacto no encontrado.' })
    return { message: 'Contacto movido.' }
  })

  // ── Notas del lead (bitácora, solo alta y lectura) ────────
  fastify.get('/crm/contactos/:id/notas', auth, async (req) => {
    return prisma.notaContacto.findMany({
      where: { tenantId: req.tenantId, contactoId: req.params.id },
      orderBy: { creadoEn: 'desc' },
    })
  })

  fastify.post('/crm/contactos/:id/notas', auth, async (req, reply) => {
    const body = notaSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.errors[0].message })
    const contacto = await prisma.contacto.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } })
    if (!contacto) return reply.status(404).send({ error: 'not_found', message: 'Contacto no encontrado.' })
    const nota = await prisma.notaContacto.create({
      data: { tenantId: req.tenantId, contactoId: contacto.id, texto: body.data.texto, usuarioId: req.user.id },
    })
    return reply.status(201).send(nota)
  })

  // ── Campos custom de Contactos (definición de columnas por tenant) ──
  fastify.get('/crm/campos-custom', auth, async (req) => {
    return prisma.campoCustomContacto.findMany({ where: { tenantId: req.tenantId }, orderBy: { orden: 'asc' } })
  })

  fastify.post('/crm/campos-custom', auth, async (req, reply) => {
    const body = campoCustomSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.errors[0].message })
    const existente = await prisma.campoCustomContacto.findFirst({ where: { tenantId: req.tenantId, clave: body.data.clave } })
    if (existente) return reply.status(409).send({ error: 'clave_duplicada', message: 'Ya existe un campo con esa clave.' })
    const max = await prisma.campoCustomContacto.aggregate({ where: { tenantId: req.tenantId }, _max: { orden: true } })
    const campo = await prisma.campoCustomContacto.create({ data: { tenantId: req.tenantId, ...body.data, orden: (max._max.orden ?? -1) + 1 } })
    return reply.status(201).send(campo)
  })

  fastify.put('/crm/campos-custom/:id', auth, async (req, reply) => {
    const body = campoCustomSchema.partial().safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.errors[0].message })
    const r = await prisma.campoCustomContacto.updateMany({ where: { id: req.params.id, tenantId: req.tenantId }, data: body.data })
    if (r.count === 0) return reply.status(404).send({ error: 'not_found', message: 'Campo no encontrado.' })
    return prisma.campoCustomContacto.findUnique({ where: { id: req.params.id } })
  })

  fastify.delete('/crm/campos-custom/:id', auth, async (req, reply) => {
    const r = await prisma.campoCustomContacto.deleteMany({ where: { id: req.params.id, tenantId: req.tenantId } })
    if (r.count === 0) return reply.status(404).send({ error: 'not_found', message: 'Campo no encontrado.' })
    return { message: 'Campo eliminado.' }
  })

  // Reordena de una: recibe el array completo de ids en el orden final
  fastify.put('/crm/campos-custom/orden', auth, async (req, reply) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : []
    await prisma.$transaction(ids.map((id, i) => prisma.campoCustomContacto.updateMany({ where: { id, tenantId: req.tenantId }, data: { orden: i } })))
    return { message: 'Orden actualizado.' }
  })

  // ── Etiquetas ──────────────────────────────────────────────
  fastify.get('/crm/etiquetas', auth, async (req) => {
    return prisma.etiqueta.findMany({ where: { tenantId: req.tenantId }, orderBy: { nombre: 'asc' } })
  })

  fastify.post('/crm/etiquetas', auth, async (req, reply) => {
    const body = etiquetaSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.errors[0].message })
    const existente = await prisma.etiqueta.findFirst({ where: { tenantId: req.tenantId, nombre: body.data.nombre } })
    if (existente) return reply.status(409).send({ error: 'nombre_duplicado', message: 'Ya existe una etiqueta con ese nombre.' })
    const etiqueta = await prisma.etiqueta.create({ data: { tenantId: req.tenantId, ...body.data } })
    return reply.status(201).send(etiqueta)
  })

  fastify.put('/crm/etiquetas/:id', auth, async (req, reply) => {
    const body = etiquetaSchema.partial().safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.errors[0].message })
    const r = await prisma.etiqueta.updateMany({ where: { id: req.params.id, tenantId: req.tenantId }, data: body.data })
    if (r.count === 0) return reply.status(404).send({ error: 'not_found', message: 'Etiqueta no encontrada.' })
    return prisma.etiqueta.findUnique({ where: { id: req.params.id } })
  })

  fastify.delete('/crm/etiquetas/:id', auth, async (req, reply) => {
    const r = await prisma.etiqueta.deleteMany({ where: { id: req.params.id, tenantId: req.tenantId } })
    if (r.count === 0) return reply.status(404).send({ error: 'not_found', message: 'Etiqueta no encontrada.' })
    return { message: 'Etiqueta eliminada.' }
  })

  // ── Tareas / Agenda ────────────────────────────────────────
  fastify.get('/crm/tareas', auth, async (req) => {
    const { estado } = req.query
    const tareas = await prisma.tarea.findMany({
      where: { tenantId: req.tenantId, ...(estado && { estado }) },
      orderBy: [{ estado: 'asc' }, { fechaVencimiento: 'asc' }],
    })
    const contactoIds = [...new Set(tareas.map((t) => t.contactoId).filter(Boolean))]
    const contactos = contactoIds.length
      ? await prisma.contacto.findMany({ where: { id: { in: contactoIds } }, select: { id: true, nombre: true } })
      : []
    const contactoPorId = Object.fromEntries(contactos.map((c) => [c.id, c]))
    return tareas.map((t) => ({ ...t, contacto: t.contactoId ? contactoPorId[t.contactoId] || null : null }))
  })

  fastify.post('/crm/tareas', auth, async (req, reply) => {
    const body = tareaSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.errors[0].message })
    const { fechaInicio, fechaVencimiento, ...resto } = body.data
    const tarea = await prisma.tarea.create({
      data: { tenantId: req.tenantId, ...resto, fechaInicio: fechaInicio ? new Date(fechaInicio) : null, fechaVencimiento: fechaVencimiento ? new Date(fechaVencimiento) : null },
    })
    return reply.status(201).send(tarea)
  })

  fastify.put('/crm/tareas/:id', auth, async (req, reply) => {
    const body = tareaSchema.partial().safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.errors[0].message })
    const { fechaInicio, fechaVencimiento, ...resto } = body.data
    const r = await prisma.tarea.updateMany({
      where: { id: req.params.id, tenantId: req.tenantId },
      data: {
        ...resto,
        ...(fechaInicio !== undefined && { fechaInicio: fechaInicio ? new Date(fechaInicio) : null }),
        ...(fechaVencimiento !== undefined && { fechaVencimiento: fechaVencimiento ? new Date(fechaVencimiento) : null }),
      },
    })
    if (r.count === 0) return reply.status(404).send({ error: 'not_found', message: 'Tarea no encontrada.' })
    return prisma.tarea.findUnique({ where: { id: req.params.id } })
  })

  fastify.patch('/crm/tareas/:id/completar', auth, async (req, reply) => {
    const { estado } = req.body || {}
    const nuevoEstado = estado === 'PENDIENTE' ? 'PENDIENTE' : 'HECHA'
    const r = await prisma.tarea.updateMany({ where: { id: req.params.id, tenantId: req.tenantId }, data: { estado: nuevoEstado } })
    if (r.count === 0) return reply.status(404).send({ error: 'not_found', message: 'Tarea no encontrada.' })
    return { message: 'Tarea actualizada.' }
  })

  fastify.delete('/crm/tareas/:id', auth, async (req, reply) => {
    const r = await prisma.tarea.deleteMany({ where: { id: req.params.id, tenantId: req.tenantId } })
    if (r.count === 0) return reply.status(404).send({ error: 'not_found', message: 'Tarea no encontrada.' })
    return { message: 'Tarea eliminada.' }
  })

  // ── Embudo custom: pipelines (TipoEmbudo) y sus etapas ────
  fastify.get('/crm/tipos-embudo', auth, async (req) => {
    return prisma.tipoEmbudo.findMany({
      where: { tenantId: req.tenantId },
      include: { etapas: { orderBy: { orden: 'asc' } } },
      orderBy: { creadoEn: 'asc' },
    })
  })

  fastify.post('/crm/tipos-embudo', auth, async (req, reply) => {
    const body = tipoEmbudoSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.errors[0].message })
    const tipo = await prisma.tipoEmbudo.create({ data: { tenantId: req.tenantId, nombre: body.data.nombre } })
    return reply.status(201).send({ ...tipo, etapas: [] })
  })

  fastify.put('/crm/tipos-embudo/:id', auth, async (req, reply) => {
    const body = tipoEmbudoSchema.partial().safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.errors[0].message })
    if (body.data.esDefault) {
      await prisma.tipoEmbudo.updateMany({ where: { tenantId: req.tenantId }, data: { esDefault: false } })
    }
    const r = await prisma.tipoEmbudo.updateMany({ where: { id: req.params.id, tenantId: req.tenantId }, data: body.data })
    if (r.count === 0) return reply.status(404).send({ error: 'not_found', message: 'Pipeline no encontrado.' })
    return prisma.tipoEmbudo.findUnique({ where: { id: req.params.id }, include: { etapas: { orderBy: { orden: 'asc' } } } })
  })

  fastify.delete('/crm/tipos-embudo/:id', auth, async (req, reply) => {
    const total = await prisma.tipoEmbudo.count({ where: { tenantId: req.tenantId } })
    if (total <= 1) return reply.status(409).send({ error: 'ultimo_pipeline', message: 'No podés borrar el único pipeline de embudo.' })
    const r = await prisma.tipoEmbudo.deleteMany({ where: { id: req.params.id, tenantId: req.tenantId } })
    if (r.count === 0) return reply.status(404).send({ error: 'not_found', message: 'Pipeline no encontrado.' })
    return { message: 'Pipeline eliminado.' }
  })

  fastify.post('/crm/tipos-embudo/:id/etapas', auth, async (req, reply) => {
    const body = etapaEmbudoCustomSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.errors[0].message })
    const tipo = await prisma.tipoEmbudo.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } })
    if (!tipo) return reply.status(404).send({ error: 'not_found', message: 'Pipeline no encontrado.' })
    const max = await prisma.etapaEmbudoCustom.aggregate({ where: { tipoEmbudoId: tipo.id }, _max: { orden: true } })
    const etapa = await prisma.etapaEmbudoCustom.create({
      data: { tenantId: req.tenantId, tipoEmbudoId: tipo.id, ...body.data, orden: (max._max.orden ?? -1) + 1 },
    })
    return reply.status(201).send(etapa)
  })

  fastify.put('/crm/etapas-embudo/:id', auth, async (req, reply) => {
    const body = etapaEmbudoCustomSchema.partial().safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.errors[0].message })
    const r = await prisma.etapaEmbudoCustom.updateMany({ where: { id: req.params.id, tenantId: req.tenantId }, data: body.data })
    if (r.count === 0) return reply.status(404).send({ error: 'not_found', message: 'Etapa no encontrada.' })
    return prisma.etapaEmbudoCustom.findUnique({ where: { id: req.params.id } })
  })

  fastify.delete('/crm/etapas-embudo/:id', auth, async (req, reply) => {
    const r = await prisma.etapaEmbudoCustom.deleteMany({ where: { id: req.params.id, tenantId: req.tenantId } })
    if (r.count === 0) return reply.status(404).send({ error: 'not_found', message: 'Etapa no encontrada.' })
    return { message: 'Etapa eliminada.' }
  })

  fastify.put('/crm/tipos-embudo/:id/etapas/orden', auth, async (req, reply) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : []
    await prisma.$transaction(ids.map((id, i) => prisma.etapaEmbudoCustom.updateMany({ where: { id, tenantId: req.tenantId, tipoEmbudoId: req.params.id }, data: { orden: i } })))
    return { message: 'Orden actualizado.' }
  })

  // ── Métricas del dashboard del CRM ────────────────────────
  // No incluye planes/facturación: eso se pide aparte a GET /clientes/planes/resumen (clientes.js),
  // que ya calcula el estado de cada plan — evita duplicar esa lógica acá.
  fastify.get('/crm/metricas', auth, async (req) => {
    const hace30 = new Date(Date.now() - 30 * 86400000)
    const hoy = new Date()
    const [totalActivos, nuevos30d, porEtapa, tareasPendientes, tareasVencidas] = await Promise.all([
      prisma.contacto.count({ where: { tenantId: req.tenantId, activo: true } }),
      prisma.contacto.count({ where: { tenantId: req.tenantId, activo: true, creadoEn: { gte: hace30 } } }),
      prisma.contacto.groupBy({ by: ['etapa'], where: { tenantId: req.tenantId, activo: true }, _count: { _all: true } }),
      prisma.tarea.count({ where: { tenantId: req.tenantId, estado: 'PENDIENTE' } }),
      prisma.tarea.count({ where: { tenantId: req.tenantId, estado: 'PENDIENTE', fechaVencimiento: { lt: hoy } } }),
    ])
    return {
      totalActivos,
      nuevos30d,
      porEtapa: Object.fromEntries(ETAPAS_EMBUDO.map((e) => [e, porEtapa.find((p) => p.etapa === e)?._count._all || 0])),
      tareasPendientes,
      tareasVencidas,
    }
  })
}
