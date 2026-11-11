// ─────────────────────────────────────────────────────────────
//  Rutas: /api/v1/tickets
//  Flujo: Comprobante X → Emitir Factura (ARCA/AFIP) → Enviar
// ─────────────────────────────────────────────────────────────

import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { randomBytes } from 'crypto'
import { registrarAuditoria } from '../../lib/auditoria.js'
import { validarCuponParaVenta } from './cupones.js'
import { calcularYAcreditarPuntos } from './puntos.js'
import { snapshotCotizacion } from '../../lib/cotizacion.js'
import { listaEnPesos } from '../../lib/moneda.js'

const lineaSchema = z.object({
  productoId: z.string().optional(),
  descripcion: z.string().min(1),
  // Tope técnico duro (independiente del aviso configurable del PoS) — última barrera contra
  // un típo tipo OV-126 (201.126.001 kg cargado por error) si algo llega a saltarse el aviso
  // del frontend o pega directo a la API.
  cantidad: z.number().positive().max(999999, 'Cantidad fuera de rango'),
  precioUnit: z.number().min(0),
  // Snapshot del costo vigente en el momento de la venta, para reportes de ganancia
  // históricamente correctos (ver LineaTicket.precioCosto en el schema). El frontend ya lo
  // manda resuelto (incluye el costo propio de la variante si lo tiene, no solo el del
  // producto base) — si no viene, el POST /tickets lo completa server-side desde el costo
  // actual del producto, no se rechaza la venta por esto.
  precioCosto: z.number().min(0).optional(),
  impuesto: z.number().min(0).max(100).default(21),
  subtotal: z.number().min(0),
})

const ticketSchema = z.object({
  ordenId: z.string().optional(),
  clienteId: z.string().optional(),
  sucursalId: z.string().optional(),
  cajaSesionId: z.string().optional(),
  medioPago: z.enum(['EFECTIVO', 'TARJETA_DEBITO', 'TARJETA_CREDITO', 'TRANSFERENCIA', 'QR', 'CUENTA_CORRIENTE', 'MERCADOPAGO', 'CUENTA_DNI', 'POSNET_BANCOS', 'POSNET_BILLETERAS', 'MODO', 'OTRO']).optional(),
  medioPagoDetalle: z.string().max(60).optional(), // nombre del método custom cuando medioPago=OTRO
  // Pago dividido en 2 métodos (ej. mitad efectivo, mitad QR) — pedido explícito del usuario
  // (2026-09-10): una clienta quiso pagar mitad efectivo mitad QR y el PoS no lo dejaba cargar.
  // Cuando viene, reemplaza a medioPago/medioPagoDetalle como fuente de verdad para esta venta.
  pagosSplit: z.array(z.object({
    medioPago: z.enum(['EFECTIVO', 'TARJETA_DEBITO', 'TARJETA_CREDITO', 'TRANSFERENCIA', 'QR', 'CUENTA_CORRIENTE', 'MERCADOPAGO', 'CUENTA_DNI', 'POSNET_BANCOS', 'POSNET_BILLETERAS', 'MODO', 'OTRO']),
    medioPagoDetalle: z.string().max(60).optional(),
    monto: z.number().positive(),
  })).length(2).optional(),
  fecha: z.string().datetime().optional(),
  subtotal: z.number().min(0),
  impuestos: z.number().min(0).default(0),
  total: z.number().min(0),
  lineas: z.array(lineaSchema).min(1),
  // Cupón aplicado (si hubo) — a diferencia de "auditoria" de abajo, ESTO SÍ se revalida
  // server-side antes de confirmar la venta (ver POST /tickets), no se confía en el frontend.
  cuponCodigo: z.string().optional(),
  descuentoCuponMonto: z.number().min(0).optional(),
  // Cotización elegida a mano para ESTA venta puntual (chip opcional en el PoS) — si no viene,
  // se usa el default del tenant en silencio (ver snapshotCotizacion). Nunca bloquea la venta.
  cotizacionOverride: z.object({ tipo: z.string(), valor: z.number().positive() }).optional(),
  // Info opcional solo para auditoría (no afecta el cálculo — el frontend ya mandó los totales
  // finales en subtotal/total/lineas de arriba). Nunca bloquea la venta si falta o es inválida.
  auditoria: z.object({
    lineasEditadas: z.array(z.object({
      productoId: z.string().optional(),
      descripcion: z.string().optional(),
      precioOriginal: z.number().optional(),
      precioNuevo: z.number().optional(),
    })).optional(),
    descuentoTotal: z.object({
      tipo: z.enum(['MONTO', 'PORCENTAJE']).optional(),
      valor: z.number().optional(),
      monto: z.number().optional(),
    }).optional(),
  }).optional(),
})

const emitirFacturaSchema = z.object({
  facturaTipo: z.enum(['A', 'B', 'C', 'M']),
  razonSocialId: z.string().optional(),
})

const envioSchema = z.object({
  canal: z.enum(['email', 'whatsapp', 'ambos']),
  destinatario: z.string(),    // email o número WA
})

async function getNextNro(tenantId) {
  const last = await prisma.ticket.findFirst({
    where: { tenantId },
    orderBy: { nro: 'desc' },
    select: { nro: true },
  })
  return (last?.nro || 0) + 1
}

// Simula la llamada a ARCA/AFIP — reemplazar por integración real
async function solicitarCAE({ facturaTipo, ptoVta, nroFactura, total }) {
  // TODO: integrar con @afipsdk/afip o similar
  await new Promise(r => setTimeout(r, 100)) // simula latencia
  const cae = randomBytes(11).toString('hex').toUpperCase().slice(0, 14).replace(/[A-F]/g, d => d)
  const caeNum = String(Math.floor(Math.random() * 9e13 + 1e13))
  const vto = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000) // 10 días
  return { cae: caeNum, caeVto: vto }
}

export default async function ticketsRoutes(fastify) {
  const auth = { preHandler: [fastify.verifyJWT, fastify.verifyTenant] }

  // ── GET /tickets ──────────────────────────────────────────
  fastify.get('/tickets', auth, async (req) => {
    const { page = 1, limit = 50, tipo, facturaEmitida, clienteId, desde, hasta, q, sucursalId, cajaSesionId, montoMin, montoMax } = req.query
    const where = {
      tenantId: req.tenantId,
      estado: 'EMITIDO',
      ...(tipo && { tipo }),
      ...(facturaEmitida !== undefined && { facturaEmitida: facturaEmitida === 'true' }),
      ...(clienteId && { clienteId }),
      ...(sucursalId && { sucursalId }),
      ...(cajaSesionId && { cajaSesionId }),
      ...(desde || hasta) && { fecha: { ...(desde && { gte: new Date(desde) }), ...(hasta && { lte: new Date(hasta) }) } },
      ...(montoMin || montoMax) && { total: { ...(montoMin && { gte: Number(montoMin) }), ...(montoMax && { lte: Number(montoMax) }) } },
      // Busca por N° de ticket, cliente O el nombre de un producto/ítem vendido en ese ticket
      // (ej. "sugus") — antes solo cubría número/cliente, así que un cajero que quería
      // encontrar una venta por lo que se vendió (el caso más común al hacer una devolución)
      // no encontraba nada aunque el ticket existiera.
      ...(q && {
        OR: [
          { nro: { equals: parseInt(q) || undefined } },
          { cliente: { nombre: { contains: q, mode: 'insensitive' } } },
          { lineas: { some: { descripcion: { contains: q, mode: 'insensitive' } } } },
        ],
      }),
    }
    const [data, total] = await prisma.$transaction([
      prisma.ticket.findMany({
        where,
        include: {
          cliente: { select: { id: true, nombre: true, cuit: true, condIVA: true } },
          usuario: { select: { id: true, nombre: true } },
        },
        orderBy: { fecha: 'desc' },
        skip: (Number(page) - 1) * Number(limit),
        take: Number(limit),
      }),
      prisma.ticket.count({ where }),
    ])
    return { data, meta: { total, page: Number(page), limit: Number(limit) } }
  })

  // ── GET /tickets/:id ──────────────────────────────────────
  fastify.get('/tickets/:id', auth, async (req, reply) => {
    const item = await prisma.ticket.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
      include: {
        cliente: true,
        usuario: { select: { id: true, nombre: true } },
        lineas: true, // LineaTicket no tiene relación viva a Producto — descripcion ya es el snapshot
      },
    })
    if (!item) return reply.status(404).send({ error: 'not_found', message: 'Ticket no encontrado.' })
    return item
  })

  // ── POST /tickets ─── Crear comprobante X ─────────────────
  fastify.post('/tickets', {
    preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN', 'VENDEDOR', 'CONTADOR'])],
  }, async (req, reply) => {
    const body = ticketSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.issues[0].message })

    const nro = await getNextNro(req.tenantId)
    const { lineas, auditoria, cuponCodigo, descuentoCuponMonto, cotizacionOverride, ...ticketData } = body.data

    // La suma de las 2 piernas del pago dividido tiene que dar el total de la venta — se valida
    // acá en vez de confiar ciegamente en lo que mandó el frontend. Redondeo a centavos porque
    // 0.1+0.2 !== 0.3 en floats.
    if (ticketData.pagosSplit) {
      const sumaSplit = ticketData.pagosSplit.reduce((s, p) => s + p.monto, 0)
      if (Math.round((sumaSplit - ticketData.total) * 100) !== 0) {
        return reply.status(400).send({ error: 'validation_error', message: `La suma de los 2 métodos de pago ($${sumaSplit.toFixed(2)}) no coincide con el total de la venta ($${ticketData.total.toFixed(2)}).` })
      }
      // Con split, medioPago único queda sin sentido — el frontend ya no lo manda, pero por las
      // dudas se limpia acá también para que no quede un valor viejo/inconsistente en la fila.
      ticketData.medioPago = undefined
      ticketData.medioPagoDetalle = undefined
    }
    // Monto real que se va a cuenta corriente de este cliente — el total entero si medioPago es
    // CUENTA_CORRIENTE sin split, o la suma de las piernas CUENTA_CORRIENTE si es una venta dividida.
    const montoCtaCte = ticketData.pagosSplit
      ? ticketData.pagosSplit.filter(p => p.medioPago === 'CUENTA_CORRIENTE').reduce((s, p) => s + p.monto, 0)
      : (ticketData.medioPago === 'CUENTA_CORRIENTE' ? ticketData.total : 0)

    // Re-validar el cupón server-side antes de confirmar — nunca confiar en que el descuento
    // que mandó el frontend es el que realmente corresponde (usos/fechas/monto mínimo pueden
    // haber cambiado entre que el cajero lo probó y que finalmente cobra).
    if (cuponCodigo) {
      const r = await validarCuponParaVenta(req.tenantId, cuponCodigo, ticketData.clienteId || null, ticketData.subtotal)
      if (!r.ok) return reply.status(409).send({ error: 'cupon_invalido', message: r.message })
      ticketData.cuponId = r.cupon.id
      ticketData.descuentoCuponMonto = descuentoCuponMonto || 0
    }

    // La caja pudo haberse cerrado entre que se abrió la pantalla de PoS y este submit
    // (ver bug: window._pos_caja quedaba stale en el frontend) — sin esta validación,
    // una venta se posteaba contra una sesión ya CERRADA y desaparecía de todo reporte.
    if (ticketData.cajaSesionId) {
      const caja = await prisma.cajaSesion.findFirst({
        where: { id: ticketData.cajaSesionId, tenantId: req.tenantId },
        select: { estado: true },
      })
      if (!caja) {
        return reply.status(409).send({ error: 'caja_invalida', message: 'La caja indicada no existe.' })
      }
      if (caja.estado !== 'ABIERTA') {
        return reply.status(409).send({ error: 'caja_cerrada', message: 'La caja de esta venta ya fue cerrada. Volvé a abrir el módulo de PoS para refrescar la sesión.' })
      }
    }

    // Cuenta corriente: requiere cliente y no puede superar su límite de crédito (si tiene uno seteado).
    // El chequeo se hace antes de crear el ticket para no dejar una venta a medio confirmar. Con
    // pago dividido, solo la pierna CUENTA_CORRIENTE (montoCtaCte) suma a la deuda, no el total.
    if (montoCtaCte > 0) {
      if (!ticketData.clienteId) {
        return reply.status(400).send({ error: 'cliente_requerido', message: 'Cuenta corriente requiere seleccionar un cliente (no aplica a consumidor final).' })
      }
      const cliente = await prisma.cliente.findFirst({ where: { id: ticketData.clienteId, tenantId: req.tenantId } })
      if (!cliente) return reply.status(404).send({ error: 'not_found', message: 'Cliente no encontrado.' })
      const nuevaDeuda = -(Number(cliente.saldo) - montoCtaCte)
      if (cliente.limiteCred != null && nuevaDeuda > Number(cliente.limiteCred)) {
        return reply.status(409).send({
          error: 'limite_excedido',
          message: `Esta venta dejaría a ${cliente.nombre} debiendo $${nuevaDeuda.toFixed(2)}, por encima de su límite de crédito ($${Number(cliente.limiteCred).toFixed(2)}).`,
        })
      }
    }

    // Verificar facturación automática del tenant
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.tenantId },
      select: { facAutoEnabled: true, ptoVta: true, condIVA: true },
    })

    const cotizacion = await snapshotCotizacion(req.tenantId, ticketData.total, cotizacionOverride)

    // Completar precioCosto server-side para cualquier línea que no lo haya traído (frontend
    // viejo, o línea armada a mano) — nunca se bloquea la venta por esto, en el peor caso queda
    // en null y esa línea simplemente no suma a los reportes de ganancia.
    const idsSinCosto = [...new Set(lineas.filter(l => l.productoId && l.precioCosto === undefined).map(l => l.productoId))]
    let costoPorProducto = {}
    if (idsSinCosto.length) {
      const prods = await prisma.producto.findMany({
        where: { id: { in: idsSinCosto }, tenantId: req.tenantId },
        select: { id: true, precioCosto: true, moneda: true },
      }).then((ps) => listaEnPesos(req.tenantId, ps)) // costo en pesos aunque el producto esté en dólares
      costoPorProducto = Object.fromEntries(prods.map(p => [p.id, p.precioCosto]))
    }
    const lineasConCosto = lineas.map(l => ({
      ...l,
      precioCosto: l.precioCosto !== undefined ? l.precioCosto : (l.productoId ? (costoPorProducto[l.productoId] ?? null) : null),
    }))

    const ticket = await prisma.$transaction(async (tx) => {
      const t = await tx.ticket.create({
        data: {
          tenantId: req.tenantId,
          nro,
          usuarioId: req.user.id,
          tipo: 'X',
          ...ticketData,
          ...cotizacion,
          lineas: { create: lineasConCosto },
        },
        include: { lineas: true, cliente: { select: { id: true, nombre: true } } },
      })
      if (montoCtaCte > 0) {
        await tx.cliente.update({
          where: { id: ticketData.clienteId },
          data: { saldo: { decrement: montoCtaCte } },
        })
      }
      return t
    })

    // Puntos de fidelización — nunca bloquea la venta si falla (ver calcularYAcreditarPuntos).
    if (ticketData.clienteId) {
      await calcularYAcreditarPuntos({
        tenantId: req.tenantId, clienteId: ticketData.clienteId, total: ticketData.total,
        lineas, fecha: ticket.fecha,
      })
    }

    // Auditoría de cambios manuales de precio en esta venta — nunca bloquea ni retrasa la venta ya
    // confirmada si algo de esto falla (registrarAuditoria se traga sus propios errores).
    if (auditoria?.lineasEditadas?.length) {
      for (const l of auditoria.lineasEditadas) {
        await registrarAuditoria({
          tenantId: req.tenantId, userId: req.user.id, req,
          accion: 'venta.precio_linea', entidad: 'Ticket', entidadId: ticket.id,
          detalle: { descripcion: l.descripcion, productoId: l.productoId, antes: l.precioOriginal, despues: l.precioNuevo },
        })
      }
    }
    if (auditoria?.descuentoTotal?.monto > 0) {
      await registrarAuditoria({
        tenantId: req.tenantId, userId: req.user.id, req,
        accion: 'venta.descuento_total', entidad: 'Ticket', entidadId: ticket.id,
        detalle: auditoria.descuentoTotal,
      })
    }

    // Si facturación automática está activa, emitir factura de inmediato
    if (tenant.facAutoEnabled && ticket.clienteId) {
      try {
        const cliente = await prisma.cliente.findUnique({ where: { id: ticket.clienteId } })
        const facturaTipo = cliente?.condIVA === 'Responsable Inscripto' ? 'A' : 'B'
        // Si el tenant tiene varias razones sociales, la automática usa la principal —
        // no hay forma de preguntarle al cajero en medio de una venta.
        const razonSocial = await prisma.razonSocial.findFirst({
          where: { tenantId: req.tenantId, activa: true },
          orderBy: { esPrincipal: 'desc' },
        })
        const ptoVta = razonSocial?.ptoVta || tenant.ptoVta
        const { cae, caeVto } = await solicitarCAE({ facturaTipo, ptoVta, nroFactura: nro, total: ticket.total })
        const facturaNro = `${ptoVta}-${String(nro).padStart(8, '0')}`

        await prisma.ticket.update({
          where: { id: ticket.id },
          data: {
            tipo: `FC_${facturaTipo}`,
            facturaEmitida: true,
            facturaFecha: new Date(),
            facturaCAE: cae,
            facturaCAEVto: caeVto,
            facturaTipo,
            facturaPtoVta: ptoVta,
            facturaNro,
            razonSocialId: razonSocial?.id,
          },
        })
      } catch (err) {
        req.log.error({ err, ticketId: ticket.id }, 'Error en facturación automática — comprobante X creado')
      }
    }

    return reply.status(201).send(ticket)
  })

  // ── POST /tickets/:id/emitir-factura ──────────────────────
  // Convierte un comprobante X en factura electrónica
  fastify.post('/tickets/:id/emitir-factura', {
    preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN', 'CONTADOR'])],
  }, async (req, reply) => {
    const body = emitirFacturaSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.issues[0].message })

    const ticket = await prisma.ticket.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
    })
    if (!ticket) return reply.status(404).send({ error: 'not_found', message: 'Ticket no encontrado.' })

    if (ticket.facturaEmitida) {
      return reply.status(409).send({ error: 'conflict', message: 'Este ticket ya tiene factura emitida.' })
    }

    if (ticket.estado === 'ANULADO') {
      return reply.status(409).send({ error: 'conflict', message: 'No se puede facturar un comprobante anulado.' })
    }

    const { facturaTipo, razonSocialId } = body.data

    let ptoVta, cuit
    if (razonSocialId) {
      const rs = await prisma.razonSocial.findFirst({ where: { id: razonSocialId, tenantId: req.tenantId, activa: true } })
      if (!rs) return reply.status(400).send({ error: 'validation_error', message: 'Razón social inválida.' })
      ptoVta = rs.ptoVta
      cuit = rs.cuit
    } else {
      const tenant = await prisma.tenant.findUnique({ where: { id: req.tenantId }, select: { ptoVta: true, cuit: true } })
      ptoVta = tenant.ptoVta
      cuit = tenant.cuit
    }

    // Solicitar CAE a ARCA
    const { cae, caeVto } = await solicitarCAE({
      facturaTipo,
      ptoVta,
      nroFactura: ticket.nro,
      total: ticket.total,
    })

    const facturaNro = `${ptoVta}-${String(ticket.nro).padStart(8, '0')}`
    const facturaQR = `https://www.afip.gob.ar/fe/qr/?p=${Buffer.from(JSON.stringify({
      ver: 1, fecha: new Date().toISOString().split('T')[0],
      cuit: cuit || '00000000000', ptoVta: Number(ptoVta),
      tipoCmp: facturaTipo === 'A' ? 1 : facturaTipo === 'B' ? 6 : 11,
      nroCmp: ticket.nro, importe: Number(ticket.total),
      moneda: 'PES', ctz: 1, tipoDocRec: 99,
      nroDocRec: 0, tipoCodAut: 'E', codAut: cae,
    })).toString('base64')}`

    const updated = await prisma.ticket.update({
      where: { id: ticket.id },
      data: {
        tipo: `FC_${facturaTipo}`,
        facturaEmitida: true,
        facturaFecha: new Date(),
        facturaCAE: cae,
        facturaCAEVto: caeVto,
        facturaTipo,
        facturaPtoVta: ptoVta,
        facturaNro,
        facturaQR,
        razonSocialId: razonSocialId || undefined,
      },
      include: { cliente: true, lineas: true },
    })

    return reply.send(updated)
  })

  // ── POST /tickets/:id/enviar ──────────────────────────────
  fastify.post('/tickets/:id/enviar', {
    preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN', 'VENDEDOR', 'CONTADOR'])],
  }, async (req, reply) => {
    const body = envioSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.issues[0].message })

    const ticket = await prisma.ticket.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } })
    if (!ticket) return reply.status(404).send({ error: 'not_found', message: 'Ticket no encontrado.' })

    const { canal, destinatario } = body.data
    const update = {}

    if (canal === 'email' || canal === 'ambos') {
      // TODO: await sendEmail({ to: destinatario, template: 'ticket', data: ticket })
      update.enviadoEmail = true
      update.emailEnviadoA = destinatario
      req.log.info({ ticketId: ticket.id, to: destinatario }, 'Email de ticket (pendiente integración Resend)')
    }

    if (canal === 'whatsapp' || canal === 'ambos') {
      // TODO: await sendWhatsApp({ to: destinatario, template: 'ticket', data: ticket })
      update.enviadoWA = true
      update.waEnviadoA = destinatario
      req.log.info({ ticketId: ticket.id, wa: destinatario }, 'WhatsApp de ticket (pendiente integración WA Business API)')
    }

    await prisma.ticket.update({ where: { id: ticket.id }, data: update })
    return { message: `Comprobante enviado por ${canal}.`, ...update }
  })

  // ── PUT /tickets/:id/anular ───────────────────────────────
  fastify.put('/tickets/:id/anular', {
    preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN', 'CONTADOR'])],
  }, async (req, reply) => {
    const ticket = await prisma.ticket.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } })
    if (!ticket) return reply.status(404).send({ error: 'not_found', message: 'Ticket no encontrado.' })
    if (ticket.facturaEmitida) {
      return reply.status(409).send({ error: 'conflict', message: 'No se puede anular un ticket con factura emitida. Emita una nota de crédito.' })
    }
    await prisma.ticket.update({ where: { id: ticket.id }, data: { estado: 'ANULADO' } })
    return { message: 'Ticket anulado.' }
  })
}
