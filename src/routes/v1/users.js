// ─────────────────────────────────────────────────────────────
//  Rutas: /api/v1/users
//  CRUD de usuarios dentro del tenant
// ─────────────────────────────────────────────────────────────

import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { invalidarCacheAuth } from '../../lib/authCache.js'

const createSchema = z.object({
  nombre: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8),
  rol: z.enum(['ADMIN', 'VENDEDOR', 'DEPOSITO', 'CONTADOR', 'PRODUCCION', 'LOGISTICA']),
})

const updateSchema = z.object({
  nombre: z.string().min(2).optional(),
  email: z.string().email().optional(),
  rol: z.enum(['ADMIN', 'VENDEDOR', 'DEPOSITO', 'CONTADOR', 'PRODUCCION', 'LOGISTICA']).optional(),
  rolId: z.string().nullable().optional(), // rol RBAC custom — null para volver al enum `rol` de sistema
  activo: z.boolean().optional(),
  avatar: z.string().max(3_000_000).optional(), // iniciales o data URI de la foto (≤2MB en base64 ≈ 2.7M caracteres)
})

// passwordActual es opcional a propósito: un admin reseteando la contraseña de OTRO usuario no
// tiene por qué conocerla (ver chequeo isAdmin más abajo); un usuario cambiando la propia sí.
const changePassSchema = z.object({
  passwordActual: z.string().min(1).optional(),
  passwordNuevo: z.string().min(8),
})

const SELECT_USER = {
  id: true, nombre: true, email: true, rol: true, rolId: true, activo: true,
  avatar: true, ultimoAcceso: true, creadoEn: true,
  rolCustom: { select: { id: true, nombre: true } },
}

export default async function usersRoutes(fastify) {
  const auth = { preHandler: [fastify.verifyJWT, fastify.verifyTenant] }

  // ── GET /users ────────────────────────────────────────────
  fastify.get('/users', auth, async (req) => {
    return prisma.user.findMany({
      where: { tenantId: req.tenantId },
      select: SELECT_USER,
      orderBy: { nombre: 'asc' },
    })
  })

  // ── GET /users/:id ────────────────────────────────────────
  fastify.get('/users/:id', auth, async (req, reply) => {
    const user = await prisma.user.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
      select: SELECT_USER,
    })
    if (!user) return reply.status(404).send({ error: 'not_found', message: 'Usuario no encontrado.' })
    return user
  })

  // ── POST /users ── Solo ADMIN ─────────────────────────────
  fastify.post('/users', {
    preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN']), fastify.requirePermiso('config', 'crear')],
  }, async (req, reply) => {
    const body = createSchema.safeParse(req.body)
    if (!body.success) {
      return reply.status(400).send({ error: 'validation_error', message: body.error.errors[0].message })
    }

    const { email, password, nombre, rol } = body.data

    const exists = await prisma.user.findFirst({
      where: { email: email.toLowerCase(), tenantId: req.tenantId },
    })
    if (exists) return reply.status(409).send({ error: 'email_taken', message: 'El email ya está en uso.' })

    const passHash = await bcrypt.hash(password, 12)
    const user = await prisma.user.create({
      data: { tenantId: req.tenantId, nombre, email: email.toLowerCase(), passHash, rol },
      select: SELECT_USER,
    })

    return reply.status(201).send(user)
  })

  // ── PUT /users/:id ── ADMIN o el propio usuario ───────────
  fastify.put('/users/:id', auth, async (req, reply) => {
    const isAdmin = req.user.rol === 'ADMIN'
    const isSelf = req.user.id === req.params.id

    if (!isAdmin && !isSelf) {
      return reply.status(403).send({ error: 'forbidden', message: 'Sin permisos.' })
    }

    const body = updateSchema.safeParse(req.body)
    if (!body.success) {
      return reply.status(400).send({ error: 'validation_error', message: body.error.errors[0].message })
    }

    // Un no-admin no puede cambiar su propio rol ni desactivarse
    const data = { ...body.data }
    if (!isAdmin) {
      delete data.rol
      delete data.rolId
      delete data.activo
    }

    if (data.email) {
      data.email = data.email.toLowerCase()
      const enUso = await prisma.user.findFirst({
        where: { email: data.email, tenantId: req.tenantId, id: { not: req.params.id } },
      })
      if (enUso) return reply.status(409).send({ error: 'email_taken', message: 'El email ya está en uso.' })
    }

    const user = await prisma.user.updateMany({
      where: { id: req.params.id, tenantId: req.tenantId },
      data,
    })
    if (user.count === 0) return reply.status(404).send({ error: 'not_found', message: 'Usuario no encontrado.' })
    invalidarCacheAuth() // rol/activo pueden haber cambiado

    return prisma.user.findUnique({ where: { id: req.params.id }, select: SELECT_USER })
  })

  // ── POST /users/:id/change-password ───────────────────────
  fastify.post('/users/:id/change-password', auth, async (req, reply) => {
    const isSelf = req.user.id === req.params.id
    const isAdmin = req.user.rol === 'ADMIN'

    if (!isSelf && !isAdmin) {
      return reply.status(403).send({ error: 'forbidden', message: 'Sin permisos.' })
    }

    const body = changePassSchema.safeParse(req.body)
    if (!body.success) {
      return reply.status(400).send({ error: 'validation_error', message: body.error.errors[0].message })
    }

    const user = await prisma.user.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } })
    if (!user) return reply.status(404).send({ error: 'not_found', message: 'Usuario no encontrado.' })

    if (!isAdmin) {
      if (!body.data.passwordActual) return reply.status(400).send({ error: 'validation_error', message: 'Contraseña actual requerida.' })
      const valid = await bcrypt.compare(body.data.passwordActual, user.passHash)
      if (!valid) return reply.status(400).send({ error: 'invalid_password', message: 'Contraseña actual incorrecta.' })
    }

    const passHash = await bcrypt.hash(body.data.passwordNuevo, 12)
    await prisma.user.update({ where: { id: user.id }, data: { passHash } })

    // Invalidar otras sesiones
    await prisma.sesion.updateMany({
      where: { userId: user.id, token: { not: req.user.jti } },
      data: { activa: false },
    })
    invalidarCacheAuth()

    return reply.send({ message: 'Contraseña actualizada.' })
  })
}
