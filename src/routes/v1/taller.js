// ─────────────────────────────────────────────────────────────
//  Rutas: /api/v1/taller — Módulo Taller (V2.102.0): órdenes de Armado / Reparación / Garantía.
//  Pipeline fijo (no configurable a propósito — el usuario típico es un técnico, no un admin):
//  Ingresado → En taller → Presupuesto enviado → Aprobado | No aprobado → Listo para retirar → Entregado
//  Módulo "selfService" (ver src/lib/modulos.js): solo responde si el tenant lo tiene activo.
// ─────────────────────────────────────────────────────────────

import { z } from 'zod'
import { parcial } from '../../lib/zodUtil.js'
import { prisma } from '../../lib/prisma.js'
import { tituloCase } from '../../lib/textUtils.js'
import { registrarAuditoria } from '../../lib/auditoria.js'

export const TIPOS_TALLER = ['ARMADO', 'REPARACION', 'GARANTIA']
export const ESTADOS_TALLER = ['INGRESADO', 'EN_REVISION', 'PRESUPUESTADO', 'APROBADO', 'RECHAZADO', 'LISTO', 'ENTREGADO']
// Estados en los que el equipo todavía está "en trabajo" — los que cuentan como demorados si
// pasó la fecha prometida.
const ESTADOS_EN_CURSO = ['INGRESADO', 'EN_REVISION', 'PRESUPUESTADO', 'APROBADO']
const DIAS_ENTREGADOS_EN_TABLERO = 15

const fechaOpt = z.string().nullable().optional()
const montoOpt = z.number().nonnegative().nullable().optional()
const accesorioSchema = z.object({ nombre: z.string().min(1).max(80), deja: z.boolean() })

const ordenSchema = z.object({
  tipo: z.enum(TIPOS_TALLER),
  clienteId: z.string().nullable().optional(),
  clienteNombre: z.string().min(1, 'Falta el nombre del cliente'),
  clienteTel: z.string().optional(),
  clienteEmail: z.string().email().optional().or(z.literal('')),
  clienteDni: z.string().optional(),
  equipoTipo: z.string().optional(),
  marca: z.string().optional(),
  modelo: z.string().optional(),
  nroSerie: z.string().optional(),
  productoId: z.string().nullable().optional(),
  falla: z.string().optional(),
  estadoFisico: z.string().optional(),
  accesorios: z.array(accesorioSchema).max(40).optional(),
  claveAcceso: z.string().optional(),
  comprobanteCompra: z.string().optional(),
  fechaCompra: fechaOpt,
  fechaPrometida: fechaOpt,
  tecnicoId: z.string().nullable().optional(),
  sucursalId: z.string().nullable().optional(),
  sena: montoOpt,
})

const estadoSchema = z.object({ estado: z.enum(ESTADOS_TALLER), texto: z.string().optional() })
const comentarioSchema = z.object({ texto: z.string().min(1) })
const presupuestoSchema = z.object({ presupuesto: z.number().nonnegative(), presupuestoDetalle: z.string().optional() })
const informeSchema = z.object({ informe: z.string() })
const entregaSchema = z.object({
  total: z.number().nonnegative(),
  medioPago: z.string().optional(),
  garantiaDias: z.number().int().nonnegative().nullable().optional(),
  nota: z.string().optional(),
})

const vacioANull = (v) => (v === '' || v === undefined ? null : v)
const fechaANull = (v) => (v ? new Date(v) : null)

export default async function tallerRoutes(fastify) {
  const moduloActivo = async (req, reply) => {
    if (!(req.tenantModulos || []).includes('taller')) {
      return reply.status(403).send({ error: 'modulo_inactivo', message: 'El módulo Taller no está activo para tu empresa.' })
    }
  }
  const auth = { preHandler: [fastify.verifyJWT, fastify.verifyTenant, moduloActivo] }

  async function evento(ordenId, req, data) {
    return prisma.ordenTallerEvento.create({
      data: { tenantId: req.tenantId, ordenId, usuarioId: req.user.id, usuarioNombre: req.user.nombre || null, ...data },
    })
  }
  async function ordenDelTenant(req, reply) {
    const orden = await prisma.ordenTaller.findFirst({ where: { id: req.params.id, tenantId: req.tenantId, activo: true } })
    if (!orden) reply.status(404).send({ error: 'not_found', message: 'Orden no encontrada.' })
    return orden
  }
  async function tecnicoNombre(req, tecnicoId) {
    if (!tecnicoId) return null
    const u = await prisma.user.findFirst({ where: { id: tecnicoId, tenantId: req.tenantId }, select: { nombre: true } })
    return u ? u.nombre : null
  }

  // ── GET /taller/ordenes ── lista / tablero. tablero=1 → todo lo no entregado + lo entregado
  // en los últimos 15 días (el tablero no crece para siempre; el histórico está en la lista).
  fastify.get('/taller/ordenes', auth, async (req) => {
    const { tipo, estado, q, clienteId, tablero, page = 1, limit = 50 } = req.query
    const lim = Math.min(Number(limit) || 50, 500)
    const and = []
    if (tablero) {
      const desde = new Date(Date.now() - DIAS_ENTREGADOS_EN_TABLERO * 86400000)
      and.push({ OR: [{ estado: { not: 'ENTREGADO' } }, { entregadoEn: { gte: desde } }] })
    }
    if (q) {
      const txt = String(q).trim()
      const num = Number(txt.replace(/^#?T?-?0*/i, ''))
      and.push({
        OR: [
          ...(Number.isInteger(num) && num > 0 ? [{ numero: num }] : []),
          { clienteNombre: { contains: txt, mode: 'insensitive' } },
          { clienteTel: { contains: txt } },
          { nroSerie: { contains: txt, mode: 'insensitive' } },
          { marca: { contains: txt, mode: 'insensitive' } },
          { modelo: { contains: txt, mode: 'insensitive' } },
          { equipoTipo: { contains: txt, mode: 'insensitive' } },
        ],
      })
    }
    const where = {
      tenantId: req.tenantId,
      activo: true,
      ...(tipo && TIPOS_TALLER.includes(tipo) && { tipo }),
      ...(estado && ESTADOS_TALLER.includes(estado) && { estado }),
      ...(clienteId && { clienteId }),
      ...(and.length && { AND: and }),
    }
    const [data, total] = await Promise.all([
      prisma.ordenTaller.findMany({
        where,
        orderBy: { numero: 'desc' },
        skip: (Number(page) - 1) * lim,
        take: lim,
        select: {
          id: true, numero: true, tipo: true, estado: true, clienteId: true, clienteNombre: true, clienteTel: true,
          equipoTipo: true, marca: true, modelo: true, nroSerie: true, falla: true, fechaPrometida: true,
          tecnicoNombre: true, presupuesto: true, sena: true, total: true, creadoEn: true, actuEn: true, entregadoEn: true,
        },
      }),
      prisma.ordenTaller.count({ where }),
    ])
    return { data, total, page: Number(page), limit: lim }
  })

  // ── GET /taller/kpis ── contadores para la tira de arriba del tablero
  fastify.get('/taller/kpis', auth, async (req) => {
    const { tipo } = req.query
    const base = { tenantId: req.tenantId, activo: true, ...(tipo && TIPOS_TALLER.includes(tipo) && { tipo }) }
    const [porEstado, demorados, porTipo] = await Promise.all([
      prisma.ordenTaller.groupBy({ by: ['estado'], where: base, _count: { _all: true } }),
      prisma.ordenTaller.count({ where: { ...base, estado: { in: ESTADOS_EN_CURSO }, fechaPrometida: { lt: new Date() } } }),
      prisma.ordenTaller.groupBy({ by: ['tipo'], where: { tenantId: req.tenantId, activo: true, estado: { not: 'ENTREGADO' } }, _count: { _all: true } }),
    ])
    const estados = Object.fromEntries(porEstado.map((r) => [r.estado, r._count._all]))
    return {
      estados,
      enTaller: ESTADOS_EN_CURSO.reduce((a, e) => a + (estados[e] || 0), 0),
      esperandoAprobacion: estados.PRESUPUESTADO || 0,
      paraRetirar: (estados.LISTO || 0) + (estados.RECHAZADO || 0),
      demorados,
      abiertasPorTipo: Object.fromEntries(porTipo.map((r) => [r.tipo, r._count._all])),
    }
  })

  // ── GET /taller/clientes?q= ── autocompletar cliente en el ingreso (busca también por teléfono)
  fastify.get('/taller/clientes', auth, async (req) => {
    const q = String(req.query.q || '').trim()
    if (q.length < 2) return []
    return prisma.cliente.findMany({
      where: {
        tenantId: req.tenantId,
        activo: true,
        OR: [
          { nombre: { contains: q, mode: 'insensitive' } },
          { tel: { contains: q } },
          { whatsapp: { contains: q } },
          { dni: { contains: q } },
          { email: { contains: q, mode: 'insensitive' } },
        ],
      },
      select: { id: true, nombre: true, tel: true, whatsapp: true, email: true, dni: true },
      orderBy: { nombre: 'asc' },
      take: 8,
    })
  })

  // ── GET /taller/ordenes/:id ── ficha completa con historial
  fastify.get('/taller/ordenes/:id', auth, async (req, reply) => {
    const orden = await prisma.ordenTaller.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId, activo: true },
      include: { eventos: { orderBy: { creadoEn: 'desc' } } },
    })
    if (!orden) return reply.status(404).send({ error: 'not_found', message: 'Orden no encontrada.' })
    const otras = orden.clienteId
      ? await prisma.ordenTaller.count({ where: { tenantId: req.tenantId, activo: true, clienteId: orden.clienteId, id: { not: orden.id } } })
      : 0
    return { ...orden, otrasDelCliente: otras }
  })

  // ── POST /taller/ordenes ── ingreso de un equipo. Si no viene clienteId, se reusa un cliente
  // con el mismo teléfono/DNI o se crea uno nuevo (todo el que deja un equipo es un cliente).
  fastify.post('/taller/ordenes', auth, async (req, reply) => {
    const body = ordenSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.issues[0]?.message, details: body.error.flatten() })
    const d = body.data
    const nombre = tituloCase(d.clienteNombre.trim())

    let clienteId = d.clienteId || null
    if (clienteId) {
      const c = await prisma.cliente.findFirst({ where: { id: clienteId, tenantId: req.tenantId }, select: { id: true } })
      if (!c) clienteId = null
    }
    if (!clienteId) {
      const tel = vacioANull(d.clienteTel?.trim())
      const dni = vacioANull(d.clienteDni?.trim())
      const existente = (tel || dni) ? await prisma.cliente.findFirst({
        where: { tenantId: req.tenantId, activo: true, OR: [...(tel ? [{ tel }, { whatsapp: tel }] : []), ...(dni ? [{ dni }] : [])] },
        select: { id: true },
      }) : null
      if (existente) clienteId = existente.id
      else {
        const nuevo = await prisma.cliente.create({
          data: { tenantId: req.tenantId, nombre, tel, whatsapp: tel, email: vacioANull(d.clienteEmail), dni },
          select: { id: true },
        })
        clienteId = nuevo.id
      }
    }

    const tecNombre = await tecnicoNombre(req, d.tecnicoId)
    const orden = await prisma.$transaction(async (tx) => {
      const t = await tx.tenant.update({ where: { id: req.tenantId }, data: { seqTaller: { increment: 1 } }, select: { seqTaller: true } })
      return tx.ordenTaller.create({
        data: {
          tenantId: req.tenantId,
          numero: t.seqTaller,
          tipo: d.tipo,
          clienteId,
          clienteNombre: nombre,
          clienteTel: vacioANull(d.clienteTel?.trim()),
          clienteEmail: vacioANull(d.clienteEmail),
          clienteDni: vacioANull(d.clienteDni?.trim()),
          equipoTipo: vacioANull(d.equipoTipo),
          marca: vacioANull(d.marca),
          modelo: vacioANull(d.modelo),
          nroSerie: vacioANull(d.nroSerie?.trim()),
          productoId: d.productoId || null,
          falla: vacioANull(d.falla),
          estadoFisico: vacioANull(d.estadoFisico),
          accesorios: d.accesorios || [],
          claveAcceso: vacioANull(d.claveAcceso),
          comprobanteCompra: vacioANull(d.comprobanteCompra),
          fechaCompra: fechaANull(d.fechaCompra),
          fechaPrometida: fechaANull(d.fechaPrometida),
          tecnicoId: d.tecnicoId || null,
          tecnicoNombre: tecNombre,
          sucursalId: d.sucursalId || null,
          sena: d.sena ?? null,
          usuarioId: req.user.id,
        },
      })
    })
    await evento(orden.id, req, { tipo: 'ESTADO', estado: 'INGRESADO', texto: 'Ingreso del equipo' })
    registrarAuditoria({ tenantId: req.tenantId, userId: req.user.id, accion: 'taller.ingreso', entidad: 'OrdenTaller', entidadId: orden.id, detalle: { numero: orden.numero, tipo: orden.tipo }, req })
    return reply.status(201).send(orden)
  })

  // ── PUT /taller/ordenes/:id ── editar datos del ingreso (no toca estado/presupuesto/entrega)
  fastify.put('/taller/ordenes/:id', auth, async (req, reply) => {
    const body = parcial(ordenSchema).safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.issues[0]?.message })
    const orden = await ordenDelTenant(req, reply); if (!orden) return
    const d = body.data
    const data = {}
    for (const k of ['tipo', 'clienteNombre', 'clienteTel', 'clienteEmail', 'clienteDni', 'equipoTipo', 'marca', 'modelo', 'nroSerie', 'falla', 'estadoFisico', 'claveAcceso', 'comprobanteCompra']) {
      if (k in d) data[k] = k === 'tipo' ? d.tipo : vacioANull(typeof d[k] === 'string' ? d[k].trim() : d[k])
    }
    if (data.clienteNombre) data.clienteNombre = tituloCase(data.clienteNombre)
    if ('accesorios' in d) data.accesorios = d.accesorios || []
    if ('fechaCompra' in d) data.fechaCompra = fechaANull(d.fechaCompra)
    if ('fechaPrometida' in d) data.fechaPrometida = fechaANull(d.fechaPrometida)
    if ('sena' in d) data.sena = d.sena ?? null
    if ('tecnicoId' in d) { data.tecnicoId = d.tecnicoId || null; data.tecnicoNombre = await tecnicoNombre(req, d.tecnicoId) }
    const r = await prisma.ordenTaller.update({ where: { id: orden.id }, data })
    return r
  })

  // ── PATCH /taller/ordenes/:id/estado ── mover en el pipeline (stepper o drag del tablero)
  fastify.patch('/taller/ordenes/:id/estado', auth, async (req, reply) => {
    const body = estadoSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: 'Estado inválido.' })
    const orden = await ordenDelTenant(req, reply); if (!orden) return
    const { estado, texto } = body.data
    if (estado === 'ENTREGADO') return reply.status(400).send({ error: 'usar_entregar', message: 'Para entregar el equipo usá el botón "Entregar" (registra el cobro y el comprobante).' })
    if (orden.estado === estado) return orden
    const data = { estado }
    if (estado === 'APROBADO' && !orden.aprobadoEn) data.aprobadoEn = new Date()
    // Volver a "trabajo" desde Entregado (ej. el cliente lo trae de vuelta enseguida) limpia la entrega.
    if (orden.estado === 'ENTREGADO') { data.entregadoEn = null }
    const r = await prisma.ordenTaller.update({ where: { id: orden.id }, data })
    await evento(orden.id, req, { tipo: 'ESTADO', estado, texto: texto || null })
    return r
  })

  // ── POST /taller/ordenes/:id/comentarios ──
  fastify.post('/taller/ordenes/:id/comentarios', auth, async (req, reply) => {
    const body = comentarioSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: 'Escribí un comentario.' })
    const orden = await ordenDelTenant(req, reply); if (!orden) return
    const ev = await evento(orden.id, req, { tipo: 'COMENTARIO', texto: body.data.texto.trim() })
    await prisma.ordenTaller.update({ where: { id: orden.id }, data: { actuEn: new Date() } })
    return reply.status(201).send(ev)
  })

  // ── PUT /taller/ordenes/:id/presupuesto ── cargar/actualizar presupuesto. Si el equipo
  // todavía estaba en Ingresado/En taller, pasa solo a "Presupuesto enviado".
  fastify.put('/taller/ordenes/:id/presupuesto', auth, async (req, reply) => {
    const body = presupuestoSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: 'Monto de presupuesto inválido.' })
    const orden = await ordenDelTenant(req, reply); if (!orden) return
    const data = { presupuesto: body.data.presupuesto, presupuestoDetalle: vacioANull(body.data.presupuestoDetalle?.trim()), presupuestoEn: new Date() }
    const avanza = ['INGRESADO', 'EN_REVISION'].includes(orden.estado)
    if (avanza) data.estado = 'PRESUPUESTADO'
    const r = await prisma.ordenTaller.update({ where: { id: orden.id }, data })
    await evento(orden.id, req, { tipo: 'PRESUPUESTO', texto: '$ ' + body.data.presupuesto.toLocaleString('es-AR') + (data.presupuestoDetalle ? ' — ' + data.presupuestoDetalle : '') })
    if (avanza) await evento(orden.id, req, { tipo: 'ESTADO', estado: 'PRESUPUESTADO' })
    return r
  })

  // ── PUT /taller/ordenes/:id/informe ── informe técnico / trabajo realizado
  fastify.put('/taller/ordenes/:id/informe', auth, async (req, reply) => {
    const body = informeSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: 'Informe inválido.' })
    const orden = await ordenDelTenant(req, reply); if (!orden) return
    const informe = vacioANull(body.data.informe.trim())
    const r = await prisma.ordenTaller.update({ where: { id: orden.id }, data: { informe } })
    if (informe && informe !== orden.informe) await evento(orden.id, req, { tipo: 'INFORME', texto: informe.length > 140 ? informe.slice(0, 140) + '…' : informe })
    return r
  })

  // ── POST /taller/ordenes/:id/entregar ── el cliente retira: cobro + garantía + estado Entregado
  fastify.post('/taller/ordenes/:id/entregar', auth, async (req, reply) => {
    const body = entregaSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: 'Datos de entrega inválidos.' })
    const orden = await ordenDelTenant(req, reply); if (!orden) return
    if (orden.estado === 'ENTREGADO') return reply.status(400).send({ error: 'ya_entregado', message: 'Este equipo ya figura como entregado.' })
    const d = body.data
    const r = await prisma.ordenTaller.update({
      where: { id: orden.id },
      data: { estado: 'ENTREGADO', entregadoEn: new Date(), total: d.total, medioPago: vacioANull(d.medioPago), garantiaDias: d.garantiaDias ?? null },
    })
    await evento(orden.id, req, { tipo: 'ENTREGA', estado: 'ENTREGADO', texto: 'Total $ ' + d.total.toLocaleString('es-AR') + (d.medioPago ? ' (' + d.medioPago + ')' : '') + (d.nota ? ' — ' + d.nota : '') })
    registrarAuditoria({ tenantId: req.tenantId, userId: req.user.id, accion: 'taller.entrega', entidad: 'OrdenTaller', entidadId: orden.id, detalle: { numero: orden.numero, total: d.total }, req })
    return r
  })

  // ── DELETE /taller/ordenes/:id ── baja lógica (solo admin; queda en auditoría)
  fastify.delete('/taller/ordenes/:id', { preHandler: [fastify.verifyJWT, fastify.verifyTenant, moduloActivo, fastify.requireRole(['ADMIN'])] }, async (req, reply) => {
    const orden = await ordenDelTenant(req, reply); if (!orden) return
    await prisma.ordenTaller.update({ where: { id: orden.id }, data: { activo: false } })
    registrarAuditoria({ tenantId: req.tenantId, userId: req.user.id, accion: 'taller.baja', entidad: 'OrdenTaller', entidadId: orden.id, detalle: { numero: orden.numero }, req })
    return { ok: true }
  })
}
