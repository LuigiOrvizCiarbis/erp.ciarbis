// ─────────────────────────────────────────────────────────────
//  Rutas: /api/v1/caja
//  Apertura / cierre de turno de caja del PoS
// ─────────────────────────────────────────────────────────────

import { z } from 'zod'
import bcrypt from 'bcryptjs'
import * as XLSX from 'xlsx'
import { prisma } from '../../lib/prisma.js'
import { resolverSucursalStock, moverStock } from '../../lib/stock.js'

const abrirSchema = z.object({
  sucursalId: z.string(),
  montoApertura: z.number().min(0),
  legajo: z.string().optional(), // quién abre físicamente la caja (independiente del login)
  pin: z.string().optional(),
})

const cerrarSchema = z.object({
  montoCierreDeclarado: z.number().min(0),
  motivoDiferencia: z.string().optional(), // obligatorio sólo si |diferencia| supera el umbral configurado
})

async function getKv(tenantId, clave) {
  const row = await prisma.configuracionEmpresa.findFirst({ where: { tenantId, clave } })
  return row?.valor
}

const comentarioSchema = z.object({
  comentario: z.string().min(1).max(500),
})

const ncLineaSchema = z.object({
  productoId: z.string().optional(),
  descripcion: z.string().min(1),
  cantidad: z.number().positive().max(999999, 'Cantidad fuera de rango'),
  precioUnit: z.number().min(0),
  subtotal: z.number().min(0),
})

const notaCreditoSchema = z.object({
  modo: z.enum(['arbitrario', 'factura']),
  ticketOrigenId: z.string().optional(),
  clienteId: z.string().optional(),
  medioPago: z.enum(['EFECTIVO', 'TARJETA_DEBITO', 'TARJETA_CREDITO', 'TRANSFERENCIA', 'QR', 'CUENTA_CORRIENTE', 'MERCADOPAGO', 'CUENTA_DNI', 'POSNET_BANCOS', 'POSNET_BILLETERAS', 'MODO', 'OTRO']),
  observaciones: z.string().optional(),
  reajustarStock: z.boolean().default(false),
  // Sólo se usan en modo 'arbitrario' — en modo 'factura' se recalculan server-side desde el ticket origen
  lineas: z.array(ncLineaSchema).optional(),
  subtotal: z.number().min(0).optional(),
  impuestos: z.number().min(0).default(0).optional(),
  total: z.number().min(0).optional(),
}).refine(d => d.modo !== 'factura' || d.ticketOrigenId, { message: 'ticketOrigenId requerido en modo factura' })
  .refine(d => d.modo !== 'arbitrario' || (d.lineas?.length && d.subtotal != null && d.total != null), { message: 'lineas/subtotal/total requeridos en modo arbitrario' })

async function getNextNroTicket(tenantId) {
  const last = await prisma.ticket.findFirst({
    where: { tenantId },
    orderBy: { nro: 'desc' },
    select: { nro: true },
  })
  return (last?.nro || 0) + 1
}

// FC_A → NC_A, FC_B → NC_B, FC_C → NC_C, cualquier otra cosa (X, ya NC, etc.) → X
function tipoNotaCredito(tipoOrigen) {
  if (tipoOrigen === 'FC_A') return 'NC_A'
  if (tipoOrigen === 'FC_B') return 'NC_B'
  if (tipoOrigen === 'FC_C') return 'NC_C'
  return 'X'
}

export default async function cajaRoutes(fastify) {
  const auth = { preHandler: [fastify.verifyJWT, fastify.verifyTenant] }

  // ── GET /caja/actual ──────────────────────────────────────
  // Sesión abierta del usuario logueado (o null si no tiene ninguna)
  fastify.get('/caja/actual', auth, async (req) => {
    const sesion = await prisma.cajaSesion.findFirst({
      where: { tenantId: req.tenantId, usuarioId: req.user.id, estado: 'ABIERTA' },
      include: {
        sucursal: { select: { id: true, nombre: true } },
        empleado: { select: { id: true, legajo: true, nombre: true } },
      },
    })
    return sesion || null
  })

  // ── GET /caja ──────────────────────────────────────────────
  // Historial de turnos (abiertos y cerrados) del tenant, más recientes primero
  fastify.get('/caja', auth, async (req) => {
    const { page = 1, limit = 30, sucursalId, estado } = req.query
    const where = {
      tenantId: req.tenantId,
      ...(sucursalId && { sucursalId }),
      ...(estado && { estado }),
    }
    const [data, total] = await prisma.$transaction([
      prisma.cajaSesion.findMany({
        where,
        include: {
          sucursal: { select: { id: true, nombre: true } },
          usuario: { select: { id: true, nombre: true } },
          empleado: { select: { id: true, legajo: true, nombre: true } },
        },
        orderBy: { abiertaEn: 'desc' },
        skip: (Number(page) - 1) * Number(limit),
        take: Number(limit),
      }),
      prisma.cajaSesion.count({ where }),
    ])
    return { data, meta: { total, page: Number(page), limit: Number(limit) } }
  })

  // ── GET /caja/export ───────────────────────────────────────
  fastify.get('/caja/export', auth, async (req, reply) => {
    const { sucursalId, estado } = req.query
    const sesiones = await prisma.cajaSesion.findMany({
      where: { tenantId: req.tenantId, ...(sucursalId && { sucursalId }), ...(estado && { estado }) },
      include: {
        sucursal: { select: { nombre: true } },
        usuario: { select: { nombre: true } },
        empleado: { select: { legajo: true, nombre: true } },
      },
      orderBy: { abiertaEn: 'desc' },
    })
    const filas = sesiones.map(s => ({
      Sucursal: s.sucursal?.nombre || '—',
      Empleado: s.empleado ? `${s.empleado.legajo} — ${s.empleado.nombre}` : (s.usuario?.nombre || '—'),
      Estado: s.estado,
      Abierta: s.abiertaEn.toISOString(),
      Cerrada: s.cerradaEn ? s.cerradaEn.toISOString() : '',
      'Monto apertura': Number(s.montoApertura),
      'Monto cierre declarado': s.montoCierreDeclarado != null ? Number(s.montoCierreDeclarado) : '',
      'Efectivo esperado': s.efectivoEsperado != null ? Number(s.efectivoEsperado) : '',
      Diferencia: s.diferencia != null ? Number(s.diferencia) : '',
      'Requiere revisión': s.requiereRevision ? 'Sí' : '',
      Comentario: s.comentario || '',
    }))
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(filas), 'Caja')
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
    reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', 'attachment; filename="caja-historial.xlsx"')
      .send(buf)
  })

  // ── POST /caja/abrir ──────────────────────────────────────
  fastify.post('/caja/abrir', { preHandler: [...auth.preHandler, fastify.requirePermiso('pos', 'crear')] }, async (req, reply) => {
    const body = abrirSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.errors[0].message })

    const existente = await prisma.cajaSesion.findFirst({
      where: { tenantId: req.tenantId, usuarioId: req.user.id, estado: 'ABIERTA' },
    })
    if (existente) {
      return reply.status(409).send({ error: 'caja_ya_abierta', message: 'Ya tenés una caja abierta. Cerrala antes de abrir otra.' })
    }

    let empleadoId
    if (body.data.legajo) {
      const emp = await prisma.empleado.findFirst({
        where: { tenantId: req.tenantId, legajo: body.data.legajo, activo: true },
      })
      if (!emp) return reply.status(404).send({ error: 'not_found', message: 'Legajo no encontrado.' })
      if (emp.pin && !(await bcrypt.compare(body.data.pin || '', emp.pin))) {
        return reply.status(401).send({ error: 'pin_invalido', message: 'PIN incorrecto.' })
      }

      const hoy = new Date(); hoy.setHours(0, 0, 0, 0)
      const ultimoFichaje = await prisma.fichaje.findFirst({
        where: { tenantId: req.tenantId, empleadoId: emp.id, fecha: { gte: hoy } },
        orderBy: { fecha: 'desc' },
      })
      const estadoActual = ultimoFichaje ? ultimoFichaje.tipo : 'SALIDA'
      if (estadoActual !== 'INGRESO' && estadoActual !== 'REGRESO') {
        return reply.status(409).send({ error: 'sin_fichaje', message: 'Tenés que fichar tu ingreso antes de abrir la caja.' })
      }
      empleadoId = emp.id
    }

    const sesion = await prisma.cajaSesion.create({
      data: {
        tenantId: req.tenantId,
        sucursalId: body.data.sucursalId,
        usuarioId: req.user.id,
        empleadoId,
        montoApertura: body.data.montoApertura,
      },
      include: { empleado: { select: { id: true, legajo: true, nombre: true } } },
    })
    return reply.status(201).send(sesion)
  })

  // ── POST /caja/:id/cerrar ──────────────────────────────────
  // Calcula totales reales por medio de pago sobre los tickets de la sesión
  // (el "reporte X" del turno) y marca la sesión como cerrada.
  fastify.post('/caja/:id/cerrar', { preHandler: [...auth.preHandler, fastify.requirePermiso('pos', 'editar')] }, async (req, reply) => {
    const body = cerrarSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.errors[0].message })

    const sesion = await prisma.cajaSesion.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
    })
    if (!sesion) return reply.status(404).send({ error: 'not_found', message: 'Sesión de caja no encontrada.' })
    if (sesion.estado === 'CERRADA') {
      return reply.status(409).send({ error: 'caja_ya_cerrada', message: 'Esta caja ya fue cerrada.' })
    }

    const tickets = await prisma.ticket.findMany({
      where: { cajaSesionId: sesion.id, tenantId: req.tenantId, estado: 'EMITIDO' },
      select: { id: true, nro: true, tipo: true, medioPago: true, medioPagoDetalle: true, pagosSplit: true, total: true, fecha: true, cliente: { select: { nombre: true } } },
      orderBy: { fecha: 'asc' },
    })

    // Una venta dividida en 2 métodos (pagosSplit) NO puede sumar entera a un solo medio — cada
    // pierna va a su propio bucket, si no el arqueo de efectivo queda mal (de más o de menos según
    // qué pierna era la de efectivo). Ver [[project_nexoerp_pago_dividido_pos]].
    const totalesPorMedioPago = tickets.reduce((acc, t) => {
      if (Array.isArray(t.pagosSplit) && t.pagosSplit.length) {
        for (const p of t.pagosSplit) {
          const medio = p.medioPago || 'OTRO'
          acc[medio] = (acc[medio] || 0) + Number(p.monto)
        }
        return acc
      }
      const medio = t.medioPago || 'OTRO'
      acc[medio] = (acc[medio] || 0) + Number(t.total)
      return acc
    }, {})

    // Efectivo esperado = lo que abrió el turno + ventas en efectivo - devoluciones en efectivo
    // (las NC ya están cargadas como montos negativos, así que suman solas al total de EFECTIVO).
    const efectivoVentas = totalesPorMedioPago.EFECTIVO || 0
    const efectivoEsperado = Number(sesion.montoApertura) + efectivoVentas
    const diferencia = Math.round((body.data.montoCierreDeclarado - efectivoEsperado) * 100) / 100

    const umbralRaw = await getKv(req.tenantId, 'caja.umbralDiferencia')
    const umbral = umbralRaw ? Number(umbralRaw) : null
    const requiereRevision = umbral != null && umbral > 0 && Math.abs(diferencia) > umbral
    if (requiereRevision && !body.data.motivoDiferencia) {
      return reply.status(400).send({
        error: 'motivo_requerido',
        message: `La diferencia (${diferencia}) supera el umbral configurado (${umbral}) — indicá un motivo para cerrar.`,
        diferencia, umbral,
      })
    }

    const sesionCerrada = await prisma.cajaSesion.update({
      where: { id: sesion.id },
      data: {
        estado: 'CERRADA',
        cerradaEn: new Date(),
        montoCierreDeclarado: body.data.montoCierreDeclarado,
        totalesPorMedioPago,
        efectivoEsperado,
        diferencia,
        requiereRevision,
        motivoDiferencia: body.data.motivoDiferencia,
      },
    })

    return {
      ...sesionCerrada,
      cantTickets: tickets.length,
      totalVendido: tickets.reduce((s, t) => s + Number(t.total), 0),
      tickets,
    }
  })

  // ── POST /caja/nota-credito ────────────────────────────────
  // Devolución/NC. Se descuenta SIEMPRE del turno que la procesa (no del turno
  // original de la venta) — así nunca falta plata en una caja que ya cerró.
  // Nota: no se agrega requirePermiso acá — CONTADOR está habilitado por requireRole pero no
  // tiene 'pos' en el mapeo de sistema (no debería ver el piso de ventas), así que un chequeo
  // de permiso a nivel módulo rompería este caso legítimo. requireRole ya es el check correcto.
  fastify.post('/caja/nota-credito', {
    preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN', 'VENDEDOR', 'CONTADOR'])],
  }, async (req, reply) => {
    const body = notaCreditoSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.errors[0].message })
    const d = body.data

    const sesion = await prisma.cajaSesion.findFirst({
      where: { tenantId: req.tenantId, usuarioId: req.user.id, estado: 'ABIERTA' },
    })
    if (!sesion) return reply.status(400).send({ error: 'sin_caja_abierta', message: 'Necesitás una caja abierta para registrar una nota de crédito.' })

    let lineas, subtotal, impuestos, total, tipo, clienteId, ticketOrigenId, razonSocialId

    if (d.modo === 'factura') {
      const origen = await prisma.ticket.findFirst({
        where: { id: d.ticketOrigenId, tenantId: req.tenantId, estado: 'EMITIDO', esNotaCredito: false },
        include: { lineas: true },
      })
      if (!origen) return reply.status(404).send({ error: 'not_found', message: 'Comprobante a acreditar no encontrado.' })

      lineas = origen.lineas.map(l => ({
        productoId: l.productoId || undefined,
        descripcion: l.descripcion,
        cantidad: Number(l.cantidad),
        precioUnit: Number(l.precioUnit),
        subtotal: -Math.abs(Number(l.subtotal)),
      }))
      subtotal = -Math.abs(Number(origen.subtotal))
      impuestos = -Math.abs(Number(origen.impuestos))
      total = -Math.abs(Number(origen.total))
      tipo = tipoNotaCredito(origen.tipo)
      clienteId = origen.clienteId || undefined
      ticketOrigenId = origen.id
      razonSocialId = origen.razonSocialId || undefined
    } else {
      lineas = d.lineas.map(l => ({ ...l, subtotal: -Math.abs(l.subtotal) }))
      subtotal = -Math.abs(d.subtotal)
      impuestos = -Math.abs(d.impuestos || 0)
      total = -Math.abs(d.total)
      tipo = 'X' // sin comprobante fiscal de referencia no se puede emitir NC_A/B/C real
      clienteId = d.clienteId || undefined
    }

    const nro = await getNextNroTicket(req.tenantId)

    const ticket = await prisma.$transaction(async (tx) => {
      const nc = await tx.ticket.create({
        data: {
          tenantId: req.tenantId,
          nro,
          usuarioId: req.user.id,
          sucursalId: sesion.sucursalId,
          cajaSesionId: sesion.id,
          medioPago: d.medioPago,
          tipo,
          esNotaCredito: true,
          ticketOrigenId,
          razonSocialId,
          clienteId,
          subtotal, impuestos, total,
          observaciones: d.observaciones,
          lineas: { create: lineas },
        },
        include: { lineas: true, cliente: { select: { id: true, nombre: true } } },
      })

      if (d.reajustarStock) {
        for (const l of lineas) {
          if (!l.productoId) continue
          const producto = await tx.producto.findUnique({ where: { id: l.productoId } })
          if (!producto) continue
          // Vuelve a la sucursal de la caja donde se hizo la devolución
          const sucDev = await resolverSucursalStock(tx, req.tenantId, sesion.sucursalId, req.user)
          const m = await moverStock(tx, { productoId: l.productoId, sucursalId: sucDev, delta: Number(l.cantidad) })
          const stockNuevo = m.total

          await tx.movimientoStock.create({
            data: {
              tenantId: req.tenantId,
              productoId: l.productoId,
              usuarioId: req.user.id,
              tipo: 'ENTRADA_DEVOLUCION',
              cantidad: Number(l.cantidad),
              stockPost: stockNuevo,
              ticketId: nc.id,
              sucursalId: sesion.sucursalId || null,
              referencia: `NC-${nro}`,
            },
          })
        }
      }

      return nc
    })

    return reply.status(201).send(ticket)
  })

  // ── PUT /caja/:id/comentario ────────────────────────────────
  // El cajero (dueño de la sesión) o un admin pueden dejar una nota — nunca se
  // tocan los campos financieros, la sesión ya cerrada queda intacta salvo esto.
  fastify.put('/caja/:id/comentario', auth, async (req, reply) => {
    const body = comentarioSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.errors[0].message })

    const sesion = await prisma.cajaSesion.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } })
    if (!sesion) return reply.status(404).send({ error: 'not_found', message: 'Sesión de caja no encontrada.' })

    const esDueno = sesion.usuarioId === req.user.id
    const esAdmin = req.user.rol === 'ADMIN'
    if (!esDueno && !esAdmin) return reply.status(403).send({ error: 'forbidden', message: 'Sin permisos.' })

    const actualizada = await prisma.cajaSesion.update({
      where: { id: sesion.id },
      data: { comentario: body.data.comentario },
    })
    return actualizada
  })

  // ── GET /caja/:id ──────────────────────────────────────────
  fastify.get('/caja/:id', auth, async (req, reply) => {
    const sesion = await prisma.cajaSesion.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
      include: {
        sucursal: { select: { id: true, nombre: true } },
        empleado: { select: { id: true, legajo: true, nombre: true } },
        tickets: { select: { id: true, nro: true, tipo: true, medioPago: true, medioPagoDetalle: true, pagosSplit: true, total: true, fecha: true, cliente: { select: { nombre: true } } }, orderBy: { fecha: 'asc' } },
      },
    })
    if (!sesion) return reply.status(404).send({ error: 'not_found', message: 'Sesión de caja no encontrada.' })
    return sesion
  })
}
