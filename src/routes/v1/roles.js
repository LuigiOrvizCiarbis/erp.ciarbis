// ─────────────────────────────────────────────────────────────
//  Rutas: /api/v1/roles
//  RBAC configurable — roles de sistema (uno por valor de RolUsuario, sembrados por
//  prisma/seed-roles.js) + roles custom que el tenant crea duplicando y editando uno.
// ─────────────────────────────────────────────────────────────

import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { MODULOS_ROL } from '../../lib/permisos.js'
import { tituloCase } from '../../lib/textUtils.js'

const permisoModuloSchema = z.object({
  ver: z.boolean().default(false),
  crear: z.boolean().default(false),
  editar: z.boolean().default(false),
  eliminar: z.boolean().default(false),
})

const permisosSchema = z.record(z.string(), permisoModuloSchema).refine(
  (p) => Object.keys(p).every((k) => MODULOS_ROL.includes(k)),
  { message: 'Módulo desconocido en los permisos.' },
)

const crearSchema = z.object({
  nombre: z.string().min(2),
  permisos: permisosSchema,
})

const actualizarSchema = z.object({
  nombre: z.string().min(2).optional(),
  permisos: permisosSchema.optional(),
  activo: z.boolean().optional(),
})

export default async function rolesRoutes(fastify) {
  const adminOnly = { preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN'])] }

  // ── GET /roles ──────────────────────────────────────────────
  fastify.get('/roles', adminOnly, async (req) => {
    const { activo } = req.query
    return prisma.rol.findMany({
      where: { tenantId: req.tenantId, ...(activo !== undefined ? { activo: activo === 'true' } : { activo: true }) },
      orderBy: [{ esSistema: 'desc' }, { nombre: 'asc' }],
    })
  })

  // ── GET /roles/modulos ── catálogo de módulos para armar la matriz de permisos ──
  fastify.get('/roles/modulos', adminOnly, async () => {
    return MODULOS_ROL
  })

  // ── POST /roles ── siempre custom (esSistema=false) ────────
  fastify.post('/roles', adminOnly, async (req, reply) => {
    const body = crearSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.errors[0].message })
    const nombre = tituloCase(body.data.nombre)

    const existe = await prisma.rol.findFirst({ where: { tenantId: req.tenantId, nombre: { equals: nombre, mode: 'insensitive' } } })
    if (existe) return reply.status(409).send({ error: 'nombre_taken', message: 'Ya existe un rol con ese nombre.' })

    const rol = await prisma.rol.create({
      data: { tenantId: req.tenantId, nombre, permisos: body.data.permisos, esSistema: false },
    })
    return reply.status(201).send(rol)
  })

  // ── PUT /roles/:id ── sólo roles custom (los de sistema no se editan, se duplican) ──
  fastify.put('/roles/:id', adminOnly, async (req, reply) => {
    const body = actualizarSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.errors[0].message })

    const rol = await prisma.rol.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } })
    if (!rol) return reply.status(404).send({ error: 'not_found', message: 'Rol no encontrado.' })
    if (rol.esSistema) return reply.status(403).send({ error: 'rol_sistema', message: 'Los roles de sistema no se editan — duplicá uno y personalizá la copia.' })

    if (body.data.nombre) {
      body.data.nombre = tituloCase(body.data.nombre)
      const existe = await prisma.rol.findFirst({ where: { tenantId: req.tenantId, nombre: { equals: body.data.nombre, mode: 'insensitive' }, id: { not: rol.id } } })
      if (existe) return reply.status(409).send({ error: 'nombre_taken', message: 'Ya existe un rol con ese nombre.' })
    }

    const actualizado = await prisma.rol.update({ where: { id: rol.id }, data: body.data })
    return actualizado
  })

  // ── DELETE /roles/:id (soft) ── sólo roles custom, y sólo si nadie lo usa ──
  fastify.delete('/roles/:id', adminOnly, async (req, reply) => {
    const rol = await prisma.rol.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } })
    if (!rol) return reply.status(404).send({ error: 'not_found', message: 'Rol no encontrado.' })
    if (rol.esSistema) return reply.status(403).send({ error: 'rol_sistema', message: 'Los roles de sistema no se pueden eliminar.' })

    const enUso = await prisma.user.count({ where: { rolId: rol.id } })
    if (enUso > 0) return reply.status(409).send({ error: 'rol_en_uso', message: `Hay ${enUso} usuario(s) con este rol asignado — reasigná antes de eliminarlo.` })

    await prisma.rol.update({ where: { id: rol.id }, data: { activo: false } })
    return reply.send({ message: 'Rol eliminado.' })
  })

  fastify.patch('/roles/reactivar-masivo', adminOnly, async (req, reply) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : []
    if (!ids.length) return reply.status(400).send({ error: 'validation_error', message: 'Sin roles seleccionados.' })
    const r = await prisma.rol.updateMany({ where: { id: { in: ids }, tenantId: req.tenantId, esSistema: false }, data: { activo: true } })
    return { message: r.count + ' rol(es) reactivado(s).', actualizados: r.count }
  })

  // ── POST /roles/:id/duplicar ── clona un rol (típicamente uno de sistema) como custom ──
  fastify.post('/roles/:id/duplicar', adminOnly, async (req, reply) => {
    const origen = await prisma.rol.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } })
    if (!origen) return reply.status(404).send({ error: 'not_found', message: 'Rol no encontrado.' })

    const nombre = tituloCase((req.body && req.body.nombre) || (origen.nombre + ' (copia)'))
    const existe = await prisma.rol.findFirst({ where: { tenantId: req.tenantId, nombre: { equals: nombre, mode: 'insensitive' } } })
    if (existe) return reply.status(409).send({ error: 'nombre_taken', message: 'Ya existe un rol con ese nombre.' })

    const copia = await prisma.rol.create({
      data: { tenantId: req.tenantId, nombre, permisos: origen.permisos, esSistema: false },
    })
    return reply.status(201).send(copia)
  })
}
