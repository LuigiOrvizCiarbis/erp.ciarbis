// ─────────────────────────────────────────────────────────────
//  Rutas: /api/v1/auditoria — admin-only, solo lectura
// ─────────────────────────────────────────────────────────────

import { prisma } from '../../lib/prisma.js'

export default async function auditoriaRoutes(fastify) {
  const adminOnly = { preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN'])] }

  fastify.get('/auditoria', adminOnly, async (req) => {
    const { page = 1, limit = 50, accion, entidad, desde, hasta } = req.query
    const where = {
      tenantId: req.tenantId,
      ...(accion && { accion }),
      ...(entidad && { entidad }),
      ...(desde || hasta) && { createdAt: { ...(desde && { gte: new Date(desde) }), ...(hasta && { lte: new Date(hasta) }) } },
    }
    const [data, total] = await prisma.$transaction([
      prisma.auditLog.findMany({
        where,
        include: { user: { select: { id: true, nombre: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (Number(page) - 1) * Number(limit),
        take: Number(limit),
      }),
      prisma.auditLog.count({ where }),
    ])
    return { data, meta: { total, page: Number(page), limit: Number(limit) } }
  })
}
