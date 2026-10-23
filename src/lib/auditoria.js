// ─────────────────────────────────────────────
//  Auditoría — registro automático de cambios manuales sensibles
//  (precio de producto, precio total de venta, corrección de fichaje, cierre forzado de caja).
//  El modelo AuditLog ya existía en el schema, nada lo usaba hasta ahora.
// ─────────────────────────────────────────────

import { prisma as prismaDefault } from './prisma.js'

// Nunca debe romper el flujo principal (una venta, una edición de precio) por un error
// de logging — se traga cualquier excepción y solo la deja en el logger de Fastify si se pasa `req`.
export async function registrarAuditoria({ tenantId, userId, accion, entidad, entidadId, detalle, req, prisma }) {
  try {
    const client = prisma || prismaDefault
    await client.auditLog.create({
      data: {
        tenantId,
        userId: userId || null,
        accion,
        entidad: entidad || null,
        entidadId: entidadId || null,
        detalle: detalle || undefined,
        ip: req?.ip || null,
        userAgent: req?.headers?.['user-agent'] || null,
      },
    })
  } catch (err) {
    if (req?.log) req.log.error({ err, accion }, 'No se pudo registrar la auditoría')
  }
}
