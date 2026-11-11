// ─────────────────────────────────────────────────────────────
//  Rutas: /api/v1/clientes
// ─────────────────────────────────────────────────────────────

import { z } from 'zod'
import { parcial } from '../../lib/zodUtil.js'
import { prisma } from '../../lib/prisma.js'
import { asegurarListaDefault } from './listasPrecio.js'
import { tituloCase } from '../../lib/textUtils.js'
import { snapshotCotizacion } from '../../lib/cotizacion.js'
import { registrarMovimientoCuentaInterna, validarCajaParaPago } from '../../lib/cuentasInternas.js'

const clienteSchema = z.object({
  nombre: z.string().min(1),
  razonSocial: z.string().optional(),
  cuit: z.string().optional(),
  dni: z.string().optional(),
  condIVA: z.string().default('Consumidor Final'),
  tipo: z.enum(['MINORISTA', 'MAYORISTA', 'EMPRESA', 'GOBIERNO']).default('MINORISTA'),
  empresa: z.string().optional(),
  rubro: z.string().optional(),
  email: z.string().email().optional().or(z.literal('')),
  tel: z.string().optional(),
  whatsapp: z.string().optional(),
  direccion: z.string().optional(),
  ciudad: z.string().optional(),
  provincia: z.string().optional(),
  emailFac: z.string().email().optional().or(z.literal('')),
  condPago: z.string().default('Contado'),
  limiteCred: z.number().nullable().optional(),
  descuento: z.number().min(0).max(100).optional(),
  descuentoTipo: z.enum(['PORCENTAJE', 'COSTO']).default('PORCENTAJE'),
  listaPrecioId: z.string().nullable().optional(),
  activo: z.boolean().optional(), // permite reactivar un cliente pausado vía PUT
  // Fidelización — cumpleDia/cumpleMes separados de anioNacimiento a propósito: el cliente
  // puede querer avisar su cumpleaños sin decir la edad.
  cumpleDia: z.number().int().min(1).max(31).nullable().optional(),
  cumpleMes: z.number().int().min(1).max(12).nullable().optional(),
  anioNacimiento: z.number().int().min(1900).max(new Date().getFullYear()).nullable().optional(),
})

const planClienteSchema = z.object({
  nombre: z.string().min(1),
  precio: z.number().positive(),
  moneda: z.enum(['ARS', 'USD']).default('ARS'),
  frecuenciaDias: z.number().int().positive().default(30),
  proximoVencimiento: z.string().datetime(),
  activo: z.boolean().optional(), // permite reactivar un plan pausado vía PUT
  diasGracia: z.number().int().min(0).default(0),
  templateId: z.string().nullable().optional(),
})

const pagoCtaCteSchema = z.object({
  monto: z.number().positive(),
  formaPago: z.enum(['CAJA', 'FONDO', 'TRANSFERENCIA_DUENO']),
  cajaSesionId: z.string().optional(),
  comentario: z.string().optional(),
  cotizacionOverride: z.object({ tipo: z.string(), valor: z.number().positive() }).optional(),
})

const pagoPlanSchema = z.object({
  monto: z.number().positive(),
  fecha: z.string().optional(), // opcional — pago retroactivo; si no viene, ahora
  periodosCubiertos: z.number().int().positive().default(1),
  medioPagoId: z.string().nullable().optional(),
  cotizacionAplicada: z.number().positive().nullable().optional(), // solo si el plan es USD
  comprobantePdf: z.string().max(4_000_000).nullable().optional(), // data URI, tope ~4MB
  // Chip opcional "cambiar cotización para esta operación puntual" — solo se usa cuando el plan
  // es ARS (para USD ya existe cotizacionAplicada de arriba, con su propio manejo abajo).
  cotizacionOverride: z.object({ tipo: z.string(), valor: z.number().positive() }).optional(),
})

// Prisma exige DateTime completo — <input type="datetime-local"> manda "AAAA-MM-DDTHH:mm"
// sin segundos/timezone (mismo criterio ya usado en Gastos).
function normalizarFechaISO(v) {
  if (!v) return undefined
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${v}T00:00:00.000Z`
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) return `${v}:00.000Z`
  return v
}

// Estado derivado de la fecha de vencimiento — no se guarda en DB (mismo criterio que el saldo de
// CuentaInterna) para que nunca se desincronice. VENCIDO si pasó el vencimiento + días de gracia,
// EN_GRACIA si pasó el vencimiento pero todavía está dentro de los días de gracia, PENDIENTE si
// vence en los próximos 5 días (aviso), AL_DIA si falta más, PAUSADO si el plan está inactivo.
const PLAN_DIAS_AVISO = 5
function planEstado(plan) {
  if (!plan.activo) return 'PAUSADO'
  const hoy = new Date()
  const vencimiento = new Date(plan.proximoVencimiento)
  const diasGracia = plan.diasGracia || 0
  if (vencimiento < hoy) {
    const finGracia = new Date(vencimiento)
    finGracia.setDate(finGracia.getDate() + diasGracia)
    if (diasGracia > 0 && hoy <= finGracia) return 'EN_GRACIA'
    return 'VENCIDO'
  }
  const diffDias = (vencimiento - hoy) / 86400000
  if (diffDias <= PLAN_DIAS_AVISO) return 'PENDIENTE'
  return 'AL_DIA'
}

// Cuotas atrasadas — se DERIVA de vencimiento+frecuencia en vez de guardarse aparte, para que
// nunca se desincronice (mismo criterio que planEstado). Ej: plan vencido hace 62 días con
// frecuencia de 30 = 2 cuotas atrasadas (floor(62/30)).
function planCuotasAtrasadas(plan) {
  if (!plan.activo) return 0
  const hoy = new Date()
  const vencimiento = new Date(plan.proximoVencimiento)
  if (vencimiento >= hoy) return 0
  return Math.floor((hoy - vencimiento) / (plan.frecuenciaDias * 86400000))
}
function planConEstado(plan) {
  return { ...plan, estado: planEstado(plan), cuotasAtrasadas: planCuotasAtrasadas(plan) }
}

// Autocurativo — mismo criterio que asegurarListaDefault: si el tenant no tiene un cliente
// "Consumidor Final" (tenants nuevos, o backfill que no llegó a correr), se crea acá para que
// no aparezca vacío en el selector del PoS ni el usuario termine creando uno a mano (y duplicado).
async function asegurarClienteConsumidorFinal(tenantId) {
  const existente = await prisma.cliente.findFirst({ where: { tenantId, esConsumidorFinal: true } })
  if (existente) return existente
  const listaDefault = await asegurarListaDefault(tenantId)
  return prisma.cliente.create({
    data: { tenantId, nombre: 'Consumidor Final', tipo: 'MINORISTA', listaPrecioId: listaDefault.id, esConsumidorFinal: true },
  })
}

export default async function clientesRoutes(fastify) {
  const auth = { preHandler: [fastify.verifyJWT, fastify.verifyTenant] }

  fastify.get('/clientes', auth, async (req) => {
    await asegurarClienteConsumidorFinal(req.tenantId)
    const { page = 1, limit = 50, q, tipo, activo } = req.query
    const where = {
      tenantId: req.tenantId,
      ...(activo !== undefined && { activo: activo === 'true' }),
      ...(tipo && { tipo }),
      ...(q && {
        OR: [
          { nombre: { contains: q, mode: 'insensitive' } },
          { razonSocial: { contains: q, mode: 'insensitive' } },
          { empresa: { contains: q, mode: 'insensitive' } },
          { cuit: { contains: q } },
          { dni: { contains: q } },
          { tel: { contains: q } },
          { email: { contains: q, mode: 'insensitive' } },
        ],
      }),
    }
    const [data, total] = await prisma.$transaction([
      prisma.cliente.findMany({
        where,
        include: { listaPrecio: { include: { margenes: true } } },
        orderBy: [{ esConsumidorFinal: 'desc' }, { nombre: 'asc' }],
        skip: (Number(page) - 1) * Number(limit),
        take: Number(limit),
      }),
      prisma.cliente.count({ where }),
    ])
    return { data, meta: { total, page: Number(page), limit: Number(limit) } }
  })

  // Revenue histórico por cliente para un rango de fechas — suma Ticket.total (ya neto de notas
  // de crédito, que se guardan en negativo) agrupado por clienteId. No usa OrdenVenta porque no
  // todas las órdenes terminan en un ticket real (algunas quedan en borrador/canceladas) — Ticket
  // es el único comprobante real de venta.
  fastify.get('/clientes/facturacion', auth, async (req) => {
    const { desde, hasta } = req.query
    const grouped = await prisma.ticket.groupBy({
      by: ['clienteId'],
      where: {
        tenantId: req.tenantId,
        clienteId: { not: null },
        ...(desde || hasta ? { fecha: { ...(desde && { gte: new Date(desde) }), ...(hasta && { lte: new Date(hasta) }) } } : {}),
      },
      _sum: { total: true },
    })
    const porCliente = {}
    for (const g of grouped) porCliente[g.clienteId] = g._sum.total || 0
    return porCliente
  })

  fastify.get('/clientes/:id', auth, async (req, reply) => {
    const item = await prisma.cliente.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } })
    if (!item) return reply.status(404).send({ error: 'not_found', message: 'Cliente no encontrado.' })
    return item
  })

  fastify.post('/clientes', {
    preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN', 'VENDEDOR'])],
  }, async (req, reply) => {
    const body = clienteSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.issues[0].message })
    body.data.nombre = tituloCase(body.data.nombre)
    const { nombre, tel, email } = body.data
    // Guarda contra doble-submit (doble click, doble tap) que crea el mismo cliente 2 veces:
    // solo bloquea si nombre Y (tel o email) coinciden con uno ya existente — evita falsos
    // positivos entre clientes distintos que comparten nombre pero no tel/email.
    if (tel || email) {
      const duplicado = await prisma.cliente.findFirst({
        where: {
          tenantId: req.tenantId,
          nombre: { equals: nombre, mode: 'insensitive' },
          OR: [...(tel ? [{ tel }] : []), ...(email ? [{ email }] : [])],
        },
      })
      if (duplicado) {
        return reply.status(409).send({ error: 'cliente_duplicado', message: `Ya existe un cliente "${duplicado.nombre}" con ese mismo teléfono o email.` })
      }
    }
    const cliente = await prisma.cliente.create({ data: { tenantId: req.tenantId, ...body.data } })
    return reply.status(201).send(cliente)
  })

  fastify.put('/clientes/:id', {
    preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN', 'VENDEDOR'])],
  }, async (req, reply) => {
    const body = parcial(clienteSchema).safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.issues[0].message })
    if (body.data.nombre) body.data.nombre = tituloCase(body.data.nombre)

    // El cliente "Consumidor Final" tiene que seguir existiendo siempre — no se puede pausar
    // por esta vía (para eso ya existe el gate de DELETE, que también lo bloquea).
    if (body.data.activo === false) {
      const actual = await prisma.cliente.findFirst({ where: { id: req.params.id, tenantId: req.tenantId }, select: { esConsumidorFinal: true } })
      if (actual?.esConsumidorFinal) {
        return reply.status(400).send({ error: 'validation_error', message: 'El cliente "Consumidor Final" no se puede pausar.' })
      }
    }

    const r = await prisma.cliente.updateMany({ where: { id: req.params.id, tenantId: req.tenantId }, data: body.data })
    if (r.count === 0) return reply.status(404).send({ error: 'not_found', message: 'Cliente no encontrado.' })
    return prisma.cliente.findUnique({ where: { id: req.params.id } })
  })

  fastify.delete('/clientes/:id', {
    preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN'])],
  }, async (req, reply) => {
    const actual = await prisma.cliente.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } })
    if (!actual) return reply.status(404).send({ error: 'not_found', message: 'Cliente no encontrado.' })
    if (actual.esConsumidorFinal) {
      return reply.status(400).send({ error: 'validation_error', message: 'El cliente "Consumidor Final" no se puede pausar ni eliminar.' })
    }
    await prisma.cliente.update({ where: { id: actual.id }, data: { activo: false } })
    return { message: 'Cliente desactivado.' }
  })

  // ── PATCH /clientes/reactivar-masivo ───────────────────────
  fastify.patch('/clientes/reactivar-masivo', {
    preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN'])],
  }, async (req, reply) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : []
    if (!ids.length) return reply.status(400).send({ error: 'validation_error', message: 'Sin clientes seleccionados.' })
    const r = await prisma.cliente.updateMany({ where: { id: { in: ids }, tenantId: req.tenantId }, data: { activo: true } })
    return { message: r.count + ' cliente(s) reactivado(s).', actualizados: r.count }
  })

  // ── POST /clientes/:id/pago — saldar cuenta corriente ──────
  // Cobro de saldo cta cte — espejo exacto de /proveedores/:id/pago pero en la dirección
  // contraria (acá el dinero entra). Sube Cliente.saldo (negativo=debe, así que sumar el monto
  // acerca a 0; si el pago supera la deuda, el saldo queda positivo = a favor del cliente para
  // el próximo consumo) y, si no es CAJA, genera el ingreso correspondiente en Fondo/Transferencia.
  fastify.post('/clientes/:id/pago', {
    preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN', 'VENDEDOR'])],
  }, async (req, reply) => {
    const body = pagoCtaCteSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.issues[0].message })
    const { formaPago, cajaSesionId, monto, comentario, cotizacionOverride } = body.data

    const cliente = await prisma.cliente.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } })
    if (!cliente) return reply.status(404).send({ error: 'not_found', message: 'Cliente no encontrado.' })

    if ((formaPago === 'FONDO' || formaPago === 'TRANSFERENCIA_DUENO') && req.user.rol !== 'ADMIN') {
      return reply.status(403).send({ error: 'forbidden', message: 'Solo un admin puede cobrar a Fondo o Transferencia Dueño.' })
    }
    let caja = null
    if (formaPago === 'CAJA') {
      try { caja = await validarCajaParaPago(req, cajaSesionId) }
      catch (e) { return reply.status(e.status || 500).send(e.body || { error: 'error', message: e.message }) }
    }
    const cotizacion = await snapshotCotizacion(req.tenantId, monto, cotizacionOverride)

    const pago = await prisma.$transaction(async (tx) => {
      const p = await tx.pagoCliente.create({
        data: { tenantId: req.tenantId, clienteId: cliente.id, monto, formaPago, cajaSesionId: caja?.id, comentario, usuarioId: req.user.id, ...cotizacion },
      })
      await tx.cliente.update({ where: { id: cliente.id }, data: { saldo: { increment: monto } } })
      if (formaPago !== 'CAJA') {
        await registrarMovimientoCuentaInterna({
          tenantId: req.tenantId, tipoCuenta: formaPago, tipoMovimiento: 'INGRESO',
          monto, concepto: 'Cobro cta cte: ' + cliente.nombre, usuarioId: req.user.id,
        }, tx)
      }
      return p
    })
    return reply.status(201).send(pago)
  })

  // ── GET /clientes/:id/pagos — historial de cobros cta cte ──
  fastify.get('/clientes/:id/pagos', auth, async (req, reply) => {
    const cliente = await prisma.cliente.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } })
    if (!cliente) return reply.status(404).send({ error: 'not_found', message: 'Cliente no encontrado.' })
    const { desde, hasta } = req.query
    const where = {
      tenantId: req.tenantId, clienteId: cliente.id,
      ...((desde || hasta) && { fecha: { ...(desde && { gte: new Date(desde) }), ...(hasta && { lte: new Date(hasta) }) } }),
    }
    const pagos = await prisma.pagoCliente.findMany({ where, orderBy: { fecha: 'desc' }, include: { usuario: { select: { nombre: true } } } })
    const totalPeriodo = pagos.reduce((s, p) => s + Number(p.monto), 0)
    return { cliente: { id: cliente.id, nombre: cliente.nombre, saldo: cliente.saldo }, pagos, totalPeriodo }
  })

  // ── Plan por cliente (punto 3, mejora 2026-08-06) — agenda de vencimientos para negocios con
  // financiación por cuota o planes mensuales. Ver planEstado() arriba para el cálculo de estado. ──

  // Resumen cross-cliente para la tabla de Finanzas > Contable — solo planes activos, con nombre
  // del cliente ya incluido para no forzar N llamadas desde el frontend.
  fastify.get('/clientes/planes/resumen', auth, async (req) => {
    const planes = await prisma.planCliente.findMany({
      where: { tenantId: req.tenantId, activo: true },
      include: { cliente: { select: { id: true, nombre: true, empresa: true } } },
      orderBy: { proximoVencimiento: 'asc' },
    })
    return planes.map(planConEstado)
  })

  // Historial completo de pagos de planes del tenant (todos los clientes, no uno solo) — usado
  // por Adm. Clientes para calcular revenue por período en el navegador (mismo criterio que
  // adm_clientes_filas: el backend entrega la lista cruda, el frontend agrupa/suma). Antes,
  // "Revenue a la fecha" en Adm. Clientes usaba /clientes/facturacion (ventas de Ticket), que da
  // $0,00 para negocios que cobran por plan/suscripción y no tienen tickets de venta — este
  // endpoint separa esa métrica de la de ventas.
  fastify.get('/clientes/planes/pagos', auth, async (req) => {
    const pagos = await prisma.pagoPlanCliente.findMany({
      where: { plan: { tenantId: req.tenantId } },
      select: { monto: true, fecha: true, plan: { select: { clienteId: true } } },
      orderBy: { fecha: 'desc' },
    })
    return pagos.map((p) => ({ clienteId: p.plan.clienteId, monto: p.monto, fecha: p.fecha }))
  })

  fastify.get('/clientes/:id/planes', auth, async (req) => {
    const planes = await prisma.planCliente.findMany({
      where: { clienteId: req.params.id, tenantId: req.tenantId },
      include: { pagos: { orderBy: { fecha: 'desc' }, take: 10, include: { medioPago: { select: { id: true, nombre: true } } } } },
      orderBy: { creadoEn: 'desc' },
    })
    return planes.map(planConEstado)
  })

  fastify.post('/clientes/:id/planes', {
    preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN', 'VENDEDOR'])],
  }, async (req, reply) => {
    const body = planClienteSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.issues[0].message })
    const cliente = await prisma.cliente.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } })
    if (!cliente) return reply.status(404).send({ error: 'not_found', message: 'Cliente no encontrado.' })
    const plan = await prisma.planCliente.create({
      data: { tenantId: req.tenantId, clienteId: cliente.id, ...body.data, proximoVencimiento: new Date(body.data.proximoVencimiento) },
    })
    return reply.status(201).send(planConEstado(plan))
  })

  fastify.put('/clientes/planes/:planId', {
    preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN', 'VENDEDOR'])],
  }, async (req, reply) => {
    const body = parcial(planClienteSchema).safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.issues[0].message })
    const { proximoVencimiento, ...resto } = body.data
    const r = await prisma.planCliente.updateMany({
      where: { id: req.params.planId, tenantId: req.tenantId },
      data: { ...resto, ...(proximoVencimiento && { proximoVencimiento: new Date(proximoVencimiento) }) },
    })
    if (r.count === 0) return reply.status(404).send({ error: 'not_found', message: 'Plan no encontrado.' })
    const plan = await prisma.planCliente.findUnique({ where: { id: req.params.planId } })
    return planConEstado(plan)
  })

  // "Eliminar" un plan lo pausa (activo=false) en vez de borrarlo — mismo criterio que pausar un
  // cliente: conserva el historial de pagos y permite reactivarlo con PUT { activo: true }.
  fastify.delete('/clientes/planes/:planId', {
    preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN', 'VENDEDOR'])],
  }, async (req, reply) => {
    const r = await prisma.planCliente.updateMany({ where: { id: req.params.planId, tenantId: req.tenantId }, data: { activo: false } })
    if (r.count === 0) return reply.status(404).send({ error: 'not_found', message: 'Plan no encontrado.' })
    return { message: 'Plan pausado.' }
  })

  // Registrar pago — crea el registro de pago y avanza el próximo vencimiento
  // `periodosCubiertos * frecuenciaDias` (antes siempre avanzaba 1 ciclo fijo sin importar a
  // cuántos períodos correspondía el pago — causaba resultados confusos, ej. pagaba el mes 9 y
  // quedaba "al día" para el mes 10). `periodoDesde/periodoHasta` quedan como registro
  // informativo de qué rango cubrió este pago puntual.
  fastify.post('/clientes/planes/:planId/pago', {
    preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN', 'VENDEDOR'])],
  }, async (req, reply) => {
    const plan = await prisma.planCliente.findFirst({ where: { id: req.params.planId, tenantId: req.tenantId } })
    if (!plan) return reply.status(404).send({ error: 'not_found', message: 'Plan no encontrado.' })
    const body = pagoPlanSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.issues[0].message })
    const { monto, periodosCubiertos, medioPagoId, cotizacionAplicada, comprobantePdf, cotizacionOverride } = body.data
    const fechaPago = normalizarFechaISO(body.data.fecha) ? new Date(normalizarFechaISO(body.data.fecha)) : new Date()

    const periodoDesde = new Date(plan.proximoVencimiento)
    const periodoHasta = new Date(plan.proximoVencimiento)
    periodoHasta.setDate(periodoHasta.getDate() + plan.frecuenciaDias * periodosCubiertos)
    const nuevoVencimiento = new Date(periodoHasta)

    // cotizacionAplicada ya existía (valor libre que tipea el frontend cuando el plan es USD,
    // solo para sugerir el monto en pesos — ver dashboard.html) — se sigue guardando igual. El
    // snapshot nuevo (cotizacionTipo/montoUSD) es independiente: prioriza el override explícito
    // del chip (planes ARS); si no vino pero sí cotizacionAplicada (planes USD, mecanismo previo)
    // se usa ESE valor como override (tag 'manualVenta'); si no vino ninguno, usa el default.
    const cotizacion = await snapshotCotizacion(
      req.tenantId, monto,
      cotizacionOverride || (cotizacionAplicada ? { tipo: 'manualVenta', valor: cotizacionAplicada } : undefined),
    )

    const [pago, planActualizado] = await prisma.$transaction([
      prisma.pagoPlanCliente.create({
        data: {
          planId: plan.id, monto, usuarioId: req.user.id, fecha: fechaPago,
          periodosCubiertos, periodoDesde, periodoHasta,
          medioPagoId: medioPagoId || undefined,
          cotizacionAplicada: cotizacionAplicada || undefined,
          comprobantePdf: comprobantePdf || undefined,
          cotizacionTipo: cotizacion.cotizacionTipo,
          montoUSD: cotizacion.montoUSD,
        },
      }),
      prisma.planCliente.update({ where: { id: plan.id }, data: { proximoVencimiento: nuevoVencimiento } }),
    ])
    return { ...planConEstado(planActualizado), pago }
  })

  // ── Plantillas de plan (catálogo reutilizable) ─────────────
  fastify.get('/plan-templates', auth, async (req) => {
    const { activo } = req.query
    return prisma.planTemplate.findMany({
      where: { tenantId: req.tenantId, ...(activo !== undefined ? { activo: activo === 'true' } : { activo: true }) },
      orderBy: { nombre: 'asc' },
    })
  })

  fastify.post('/plan-templates', {
    preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN'])],
  }, async (req, reply) => {
    const schema = z.object({
      nombre: z.string().min(1),
      precio: z.number().positive(),
      moneda: z.enum(['ARS', 'USD']).default('ARS'),
      frecuenciaDias: z.number().int().positive().default(30),
    })
    const body = schema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.issues[0].message })
    const template = await prisma.planTemplate.create({ data: { tenantId: req.tenantId, ...body.data } })
    return reply.status(201).send(template)
  })

  fastify.put('/plan-templates/:id', {
    preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN'])],
  }, async (req, reply) => {
    const schema = z.object({
      nombre: z.string().min(1).optional(),
      precio: z.number().positive().optional(),
      moneda: z.enum(['ARS', 'USD']).optional(),
      frecuenciaDias: z.number().int().positive().optional(),
      activo: z.boolean().optional(),
    })
    const body = schema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.issues[0].message })
    const r = await prisma.planTemplate.updateMany({ where: { id: req.params.id, tenantId: req.tenantId }, data: body.data })
    if (r.count === 0) return reply.status(404).send({ error: 'not_found', message: 'Plantilla no encontrada.' })
    return prisma.planTemplate.findUnique({ where: { id: req.params.id } })
  })

  fastify.delete('/plan-templates/:id', {
    preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN'])],
  }, async (req, reply) => {
    const r = await prisma.planTemplate.updateMany({ where: { id: req.params.id, tenantId: req.tenantId }, data: { activo: false } })
    if (r.count === 0) return reply.status(404).send({ error: 'not_found', message: 'Plantilla no encontrada.' })
    return { message: 'Plantilla desactivada.' }
  })

  fastify.patch('/plan-templates/reactivar-masivo', {
    preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN'])],
  }, async (req, reply) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : []
    if (!ids.length) return reply.status(400).send({ error: 'validation_error', message: 'Sin plantillas seleccionadas.' })
    const r = await prisma.planTemplate.updateMany({ where: { id: { in: ids }, tenantId: req.tenantId }, data: { activo: true } })
    return { message: r.count + ' plantilla(s) reactivada(s).', actualizadas: r.count }
  })

  // ── Medios de pago propios de Planes/Servicios (catálogo separado del de Caja/PoS) ──
  const MEDIOS_PAGO_SERVICIO_DEFAULT = ['Efectivo Pesos', 'Efectivo USD', 'Transferencia Pesos', 'Transferencia USDT', 'Pago con tarjeta', 'Débito automático']
  async function asegurarMediosPagoServicio(tenantId) {
    const existentes = await prisma.medioPagoServicio.findMany({ where: { tenantId } })
    if (existentes.length) return existentes
    await prisma.medioPagoServicio.createMany({ data: MEDIOS_PAGO_SERVICIO_DEFAULT.map((nombre) => ({ tenantId, nombre })) })
    return prisma.medioPagoServicio.findMany({ where: { tenantId } })
  }

  fastify.get('/medios-pago-servicio', auth, async (req) => {
    const { activo } = req.query
    await asegurarMediosPagoServicio(req.tenantId)
    return prisma.medioPagoServicio.findMany({
      where: { tenantId: req.tenantId, ...(activo !== undefined ? { activo: activo === 'true' } : { activo: true }) },
      orderBy: { nombre: 'asc' },
    })
  })

  fastify.post('/medios-pago-servicio', {
    preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN'])],
  }, async (req, reply) => {
    const nombre = tituloCase(String(req.body?.nombre || '').trim())
    if (!nombre) return reply.status(400).send({ error: 'validation_error', message: 'Nombre requerido.' })
    const existe = await prisma.medioPagoServicio.findFirst({ where: { tenantId: req.tenantId, nombre: { equals: nombre, mode: 'insensitive' } } })
    if (existe) return reply.status(409).send({ error: 'nombre_duplicado', message: 'Ya existe un medio de pago con ese nombre.' })
    const medio = await prisma.medioPagoServicio.create({ data: { tenantId: req.tenantId, nombre } })
    return reply.status(201).send(medio)
  })

  fastify.put('/medios-pago-servicio/:id', {
    preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN'])],
  }, async (req, reply) => {
    let { nombre, activo } = req.body || {}
    if (nombre !== undefined) {
      nombre = tituloCase(nombre)
      const existe = await prisma.medioPagoServicio.findFirst({ where: { tenantId: req.tenantId, nombre: { equals: nombre, mode: 'insensitive' }, id: { not: req.params.id } } })
      if (existe) return reply.status(409).send({ error: 'nombre_duplicado', message: 'Ya existe un medio de pago con ese nombre.' })
    }
    const r = await prisma.medioPagoServicio.updateMany({
      where: { id: req.params.id, tenantId: req.tenantId },
      data: { ...(nombre !== undefined && { nombre }), ...(activo !== undefined && { activo }) },
    })
    if (r.count === 0) return reply.status(404).send({ error: 'not_found', message: 'Medio de pago no encontrado.' })
    return prisma.medioPagoServicio.findUnique({ where: { id: req.params.id } })
  })

  fastify.delete('/medios-pago-servicio/:id', {
    preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN'])],
  }, async (req, reply) => {
    const r = await prisma.medioPagoServicio.updateMany({ where: { id: req.params.id, tenantId: req.tenantId }, data: { activo: false } })
    if (r.count === 0) return reply.status(404).send({ error: 'not_found', message: 'Medio de pago no encontrado.' })
    return { message: 'Medio de pago desactivado.' }
  })

  fastify.patch('/medios-pago-servicio/reactivar-masivo', {
    preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN'])],
  }, async (req, reply) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : []
    if (!ids.length) return reply.status(400).send({ error: 'validation_error', message: 'Sin medios seleccionados.' })
    const r = await prisma.medioPagoServicio.updateMany({ where: { id: { in: ids }, tenantId: req.tenantId }, data: { activo: true } })
    return { message: r.count + ' medio(s) reactivado(s).', actualizados: r.count }
  })
}
