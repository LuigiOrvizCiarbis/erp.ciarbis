// ─────────────────────────────────────────────────────────────
//  Rutas: /api/v1/empleados y /api/v1/fichajes
//  Control de asistencia por legajo — independiente del login (User),
//  porque varios empleados pueden compartir un mismo usuario admin/cajero.
// ─────────────────────────────────────────────────────────────

import { z } from 'zod'
import bcrypt from 'bcryptjs'
import * as XLSX from 'xlsx'
import { prisma } from '../../lib/prisma.js'
import { registrarAuditoria } from '../../lib/auditoria.js'
import { tituloCase } from '../../lib/textUtils.js'

const empleadoSchema = z.object({
  legajo: z.string().min(1),
  nombre: z.string().min(2),
  userId: z.string().optional(),
  pin: z.string().min(4).max(8).optional(), // opcional — si se setea, se exige junto al legajo
})

const fichajeSchema = z.object({
  legajo: z.string().min(1),
  tipo: z.enum(['INGRESO', 'DESCANSO', 'REGRESO', 'SALIDA']),
  sucursalId: z.string().optional(),
  pin: z.string().optional(),
})

const corregirFichajeSchema = z.object({
  tipo: z.enum(['INGRESO', 'DESCANSO', 'REGRESO', 'SALIDA']),
  motivo: z.string().min(3, 'El motivo es obligatorio para una corrección'),
  // Si la corrección implica que el empleado ya no debería tener una caja abierta a su nombre,
  // hay que resolverla en el mismo request: un número (efectivo declarado), o `null` explícito
  // ("no sé cuánto había"). Si la clave ni siquiera viene (undefined), se rechaza con 409 para que
  // el frontend muestre el aviso y reintente con uno de los dos casos anteriores.
  cerrarCajaMonto: z.number().nullable().optional(),
})

// Verifica el PIN sólo si el empleado tiene uno seteado — si no tiene, no se exige (retrocompatible).
async function verificarPin(emp, pinRecibido, reply) {
  if (!emp.pin) return true
  if (!pinRecibido || !(await bcrypt.compare(pinRecibido, emp.pin))) {
    reply.status(401).send({ error: 'pin_invalido', message: 'PIN incorrecto.' })
    return false
  }
  return true
}

// Transiciones válidas: desde qué estado actual se puede pasar a qué tipo de fichaje.
// Sin fichaje hoy = se lo trata como si hubiera "salido" (afuera, puede ingresar).
const TRANSICIONES_VALIDAS = {
  SALIDA: ['INGRESO'],
  INGRESO: ['DESCANSO', 'SALIDA'],
  DESCANSO: ['REGRESO'],
  REGRESO: ['DESCANSO', 'SALIDA'],
}

async function inicioDeHoy() {
  const hoy = new Date()
  hoy.setHours(0, 0, 0, 0)
  return hoy
}

export default async function empleadosRoutes(fastify) {
  const auth = { preHandler: [fastify.verifyJWT, fastify.verifyTenant] }
  const adminOnly = { preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN'])] }

  // ── GET /empleados ─────────────────────────────────────────
  fastify.get('/empleados', adminOnly, async (req) => {
    const { activo } = req.query
    const empleados = await prisma.empleado.findMany({
      where: { tenantId: req.tenantId, ...(activo !== undefined ? { activo: activo === 'true' } : { activo: true }) },
      orderBy: { nombre: 'asc' },
    })
    return empleados.map(e => ({ ...e, pin: undefined, tienePin: !!e.pin }))
  })

  // ── POST /empleados ────────────────────────────────────────
  fastify.post('/empleados', adminOnly, async (req, reply) => {
    const body = empleadoSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.errors[0].message })
    body.data.nombre = tituloCase(body.data.nombre)

    const existe = await prisma.empleado.findFirst({ where: { tenantId: req.tenantId, legajo: body.data.legajo } })
    if (existe) return reply.status(409).send({ error: 'legajo_taken', message: 'Ese legajo ya existe.' })

    const { pin, ...rest } = body.data
    const emp = await prisma.empleado.create({
      data: { tenantId: req.tenantId, ...rest, ...(pin && { pin: await bcrypt.hash(pin, 10) }) },
    })
    return reply.status(201).send({ ...emp, pin: undefined })
  })

  // ── PUT /empleados/:id ─────────────────────────────────────
  fastify.put('/empleados/:id', adminOnly, async (req, reply) => {
    const body = empleadoSchema.partial().safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.errors[0].message })
    if (body.data.nombre) body.data.nombre = tituloCase(body.data.nombre)
    const { pin, ...rest } = body.data
    const data = { ...rest, ...(pin && { pin: await bcrypt.hash(pin, 10) }) }
    const r = await prisma.empleado.updateMany({ where: { id: req.params.id, tenantId: req.tenantId }, data })
    if (r.count === 0) return reply.status(404).send({ error: 'not_found', message: 'Empleado no encontrado.' })
    const updated = await prisma.empleado.findUnique({ where: { id: req.params.id } })
    return { ...updated, pin: undefined }
  })

  // ── DELETE /empleados/:id (soft) ───────────────────────────
  fastify.delete('/empleados/:id', adminOnly, async (req, reply) => {
    const r = await prisma.empleado.updateMany({ where: { id: req.params.id, tenantId: req.tenantId }, data: { activo: false } })
    if (r.count === 0) return reply.status(404).send({ error: 'not_found', message: 'Empleado no encontrado.' })
    return reply.send({ message: 'Empleado desactivado.' })
  })

  fastify.patch('/empleados/reactivar-masivo', adminOnly, async (req, reply) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : []
    if (!ids.length) return reply.status(400).send({ error: 'validation_error', message: 'Sin empleados seleccionados.' })
    const r = await prisma.empleado.updateMany({ where: { id: { in: ids }, tenantId: req.tenantId }, data: { activo: true } })
    return { message: r.count + ' empleado(s) reactivado(s).', actualizados: r.count }
  })

  // ── GET /empleados/buscar-legajo/:legajo ───────────────────
  // Cualquier usuario logueado del tenant puede consultarlo (para fichar o abrir caja)
  fastify.get('/empleados/buscar-legajo/:legajo', auth, async (req, reply) => {
    const emp = await prisma.empleado.findFirst({
      where: { tenantId: req.tenantId, legajo: req.params.legajo, activo: true },
    })
    if (!emp) return reply.status(404).send({ error: 'not_found', message: 'Legajo no encontrado.' })

    const hoy = await inicioDeHoy()
    const ultimoFichaje = await prisma.fichaje.findFirst({
      where: { tenantId: req.tenantId, empleadoId: emp.id, fecha: { gte: hoy } },
      orderBy: { fecha: 'desc' },
    })
    const cajaAbierta = await prisma.cajaSesion.findFirst({
      where: { tenantId: req.tenantId, empleadoId: emp.id, estado: 'ABIERTA' },
    })
    return { empleado: { ...emp, pin: undefined }, requierePin: !!emp.pin, ultimoFichaje, cajaAbierta, estadoActual: ultimoFichaje ? ultimoFichaje.tipo : 'SALIDA' }
  })

  // ── POST /fichajes ──────────────────────────────────────────
  fastify.post('/fichajes', auth, async (req, reply) => {
    const body = fichajeSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.errors[0].message })
    const { legajo, tipo, sucursalId, pin } = body.data

    const emp = await prisma.empleado.findFirst({ where: { tenantId: req.tenantId, legajo, activo: true } })
    if (!emp) return reply.status(404).send({ error: 'not_found', message: 'Legajo no encontrado.' })
    if (!(await verificarPin(emp, pin, reply))) return

    const hoy = await inicioDeHoy()
    const ultimo = await prisma.fichaje.findFirst({
      where: { tenantId: req.tenantId, empleadoId: emp.id, fecha: { gte: hoy } },
      orderBy: { fecha: 'desc' },
    })
    const estadoActual = ultimo ? ultimo.tipo : 'SALIDA'

    if (!TRANSICIONES_VALIDAS[estadoActual]?.includes(tipo)) {
      return reply.status(409).send({
        error: 'transicion_invalida',
        message: 'No podés fichar "' + tipo + '" ahora — tu último estado es "' + estadoActual + '".',
      })
    }

    // La caja no puede quedar abierta cuando el empleado se va a descansar o se retira.
    if (tipo === 'DESCANSO' || tipo === 'SALIDA') {
      const cajaAbierta = await prisma.cajaSesion.findFirst({
        where: { tenantId: req.tenantId, empleadoId: emp.id, estado: 'ABIERTA' },
      })
      if (cajaAbierta) {
        return reply.status(409).send({ error: 'caja_abierta', message: 'Tenés una caja abierta a tu nombre. Cerrala antes de fichar ' + (tipo === 'DESCANSO' ? 'descanso' : 'salida') + '.' })
      }
    }

    const fichaje = await prisma.fichaje.create({
      data: { tenantId: req.tenantId, empleadoId: emp.id, tipo, sucursalId },
    })
    return reply.status(201).send({ fichaje, empleado: emp })
  })

  // ── GET /fichajes/planilla ── sólo ADMIN ───────────────────
  // Agrupa por empleado + día: una fila por combinación, con la lista cronológica de eventos.
  fastify.get('/fichajes/planilla', adminOnly, async (req) => {
    const { desde, hasta, sucursalId } = req.query
    const where = {
      tenantId: req.tenantId,
      ...(sucursalId && { sucursalId }),
      ...(desde || hasta) && {
        fecha: {
          ...(desde && { gte: new Date(desde) }),
          ...(hasta && { lte: new Date(hasta) }),
        },
      },
    }
    const fichajes = await prisma.fichaje.findMany({
      where,
      include: { empleado: { select: { id: true, legajo: true, nombre: true } } },
      orderBy: { fecha: 'asc' },
    })

    const grupos = {}
    for (const f of fichajes) {
      const dia = f.fecha.toISOString().slice(0, 10)
      const key = f.empleadoId + '|' + dia
      if (!grupos[key]) {
        grupos[key] = { empleadoId: f.empleadoId, legajo: f.empleado.legajo, nombre: f.empleado.nombre, fecha: dia, eventos: [] }
      }
      grupos[key].eventos.push({ id: f.id, tipo: f.tipo, hora: f.fecha, corrigeId: f.corrigeId, motivo: f.motivo })
    }
    return Object.values(grupos).sort((a, b) => (b.fecha + a.legajo).localeCompare(a.fecha + b.legajo))
  })

  // ── POST /fichajes/:id/corregir ── sólo ADMIN ──────────────
  // El log de fichajes es append-only (nunca se edita/borra) — una corrección es un
  // fichaje NUEVO que referencia al incorrecto, con motivo obligatorio, sin pasar por
  // la máquina de estados normal (es un override explícito de admin).
  fastify.post('/fichajes/:id/corregir', adminOnly, async (req, reply) => {
    const body = corregirFichajeSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.errors[0].message })

    const original = await prisma.fichaje.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } })
    if (!original) return reply.status(404).send({ error: 'not_found', message: 'Fichaje no encontrado.' })

    // Si el tipo corregido implica que el empleado ya no debería tener una caja abierta a su
    // nombre (DESCANSO/SALIDA), esa caja tiene que resolverse en el mismo request — si el
    // frontend todavía no mandó `cerrarCajaMonto` (ni siquiera la clave), se lo pedimos primero.
    let cajaAbierta = null
    if (body.data.tipo === 'DESCANSO' || body.data.tipo === 'SALIDA') {
      cajaAbierta = await prisma.cajaSesion.findFirst({
        where: { tenantId: req.tenantId, empleadoId: original.empleadoId, estado: 'ABIERTA' },
      })
      if (cajaAbierta && body.data.cerrarCajaMonto === undefined) {
        const empleado = await prisma.empleado.findUnique({ where: { id: original.empleadoId }, select: { nombre: true } })
        return reply.status(409).send({
          error: 'caja_abierta_requiere_cierre',
          message: `Esta corrección va a cerrar la caja abierta de ${empleado?.nombre || 'este empleado'}. Indicá el efectivo en caja o marcá que no lo sabés.`,
        })
      }
    }

    const resultado = await prisma.$transaction(async (tx) => {
      const corregido = await tx.fichaje.create({
        data: {
          tenantId: req.tenantId,
          empleadoId: original.empleadoId,
          sucursalId: original.sucursalId,
          tipo: body.data.tipo,
          corrigeId: original.id,
          motivo: body.data.motivo,
        },
      })

      let cajaCerrada = null
      if (cajaAbierta) {
        const monto = body.data.cerrarCajaMonto
        const tickets = await tx.ticket.findMany({
          where: { cajaSesionId: cajaAbierta.id, tenantId: req.tenantId, estado: 'EMITIDO' },
          select: { medioPago: true, total: true },
        })
        const efectivoVentas = tickets.reduce((s, t) => s + (t.medioPago === 'EFECTIVO' ? Number(t.total) : 0), 0)
        const efectivoEsperado = Number(cajaAbierta.montoApertura) + efectivoVentas
        cajaCerrada = await tx.cajaSesion.update({
          where: { id: cajaAbierta.id },
          data: {
            estado: 'CERRADA',
            cerradaEn: new Date(),
            montoCierreDeclarado: monto,
            efectivoEsperado,
            diferencia: monto != null ? Math.round((monto - efectivoEsperado) * 100) / 100 : null,
            requiereRevision: true,
            cierreForzado: true,
            comentario: `Cierre forzado por corrección de fichaje — motivo: ${body.data.motivo}`,
          },
        })
      }

      return { corregido, cajaCerrada }
    })

    await registrarAuditoria({
      tenantId: req.tenantId, userId: req.user.id, req,
      accion: 'fichaje.correccion', entidad: 'Fichaje', entidadId: original.id,
      detalle: { motivo: body.data.motivo, antes: original.tipo, despues: body.data.tipo },
    })
    if (resultado.cajaCerrada) {
      await registrarAuditoria({
        tenantId: req.tenantId, userId: req.user.id, req,
        accion: 'caja.cierre_forzado', entidad: 'CajaSesion', entidadId: resultado.cajaCerrada.id,
        detalle: { motivo: body.data.motivo, montoCierreDeclarado: resultado.cajaCerrada.montoCierreDeclarado },
      })
    }

    return reply.status(201).send(resultado.corregido)
  })

  // ── GET /fichajes/planilla/export ── sólo ADMIN ────────────
  fastify.get('/fichajes/planilla/export', adminOnly, async (req, reply) => {
    const { desde, hasta, sucursalId } = req.query
    const where = {
      tenantId: req.tenantId,
      ...(sucursalId && { sucursalId }),
      ...(desde || hasta) && {
        fecha: { ...(desde && { gte: new Date(desde) }), ...(hasta && { lte: new Date(hasta) }) },
      },
    }
    const fichajes = await prisma.fichaje.findMany({
      where,
      include: { empleado: { select: { legajo: true, nombre: true } } },
      orderBy: { fecha: 'asc' },
    })
    const filas = fichajes.map(f => ({
      Legajo: f.empleado.legajo,
      Nombre: f.empleado.nombre,
      Fecha: f.fecha.toISOString().slice(0, 10),
      Hora: f.fecha.toISOString().slice(11, 19),
      Tipo: f.tipo,
      Corrección: f.corrigeId ? 'Sí' : '',
      Motivo: f.motivo || '',
    }))
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(filas), 'Fichajes')
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
    reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', 'attachment; filename="fichajes.xlsx"')
      .send(buf)
  })
}
