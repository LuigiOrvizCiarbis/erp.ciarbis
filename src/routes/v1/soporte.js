// ─────────────────────────────────────────────────────────────
//  Rutas: /api/v1/soporte
//  Chat flotante de Ayuda/Soporte — no es mensajería en vivo, es un ticket que llega al
//  panel /superadmin para que alguien de soporte lo responda por fuera (WhatsApp/email).
// ─────────────────────────────────────────────────────────────

import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'

const ticketSchema = z.object({
  mensaje: z.string().min(1).max(2000),
})

export default async function soporteRoutes(fastify) {
  const auth = { preHandler: [fastify.verifyJWT, fastify.verifyTenant] }

  // ── POST /soporte/tickets ──────────────────────────────────
  fastify.post('/soporte/tickets', auth, async (req, reply) => {
    const body = ticketSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.errors[0].message })

    const ticket = await prisma.ticketSoporte.create({
      data: { tenantId: req.tenantId, userId: req.user.id, mensaje: body.data.mensaje },
    })
    return reply.status(201).send(ticket)
  })

  // ── GET /soporte/tickets/mios ──────────────────────────────
  // El usuario ve el estado de lo que mandó (para no dejarlo mandando a ciegas sin feedback).
  fastify.get('/soporte/tickets/mios', auth, async (req) => {
    return prisma.ticketSoporte.findMany({
      where: { tenantId: req.tenantId, userId: req.user.id },
      orderBy: { creadoEn: 'desc' },
      take: 20,
    })
  })
}
