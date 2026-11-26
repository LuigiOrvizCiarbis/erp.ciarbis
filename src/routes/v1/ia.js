// ─────────────────────────────────────────────────────────────
//  Rutas: /api/v1/ia — BIMS IA (V2.109.0), chat flotante del dashboard.
//  La lógica (herramientas de solo lectura, loop con Claude, medición de consumo por empresa)
//  está en src/lib/bimsIa.js. El consumo y el apagado por empresa se manejan en /superadmin.
// ─────────────────────────────────────────────────────────────

import { chatIa, iaActivaParaTenant, ErrorIa } from '../../lib/bimsIa.js'

export default async function iaRoutes(fastify) {
  const auth = { preHandler: [fastify.verifyJWT, fastify.verifyTenant] }

  // ¿Se muestra el botón flotante? (key configurada en el hosting + empresa no apagada)
  fastify.get('/ia/estado', auth, async (req) => {
    return { disponible: await iaActivaParaTenant(req.tenantId) }
  })

  // Una pregunta: el navegador manda el historial de texto de la conversación (sin datos
  // internos); el server corre las herramientas y devuelve la respuesta final.
  fastify.post('/ia/chat', {
    ...auth,
    config: { rateLimit: { max: 20, timeWindow: '1 minute', keyGenerator: (req) => 'ia:' + (req.user?.id || req.ip) } },
  }, async (req, reply) => {
    try {
      const r = await chatIa({ tenantId: req.tenantId, user: req.user, mensajes: req.body?.mensajes })
      return { respuesta: r.respuesta, consultas: r.consultas }
    } catch (e) {
      if (e instanceof ErrorIa) return reply.status(e.status).send({ error: e.codigo, message: e.message })
      req.log.error(e, 'BIMS IA')
      return reply.status(500).send({ error: 'ia_error', message: 'BIMS IA tuvo un problema. Probá de nuevo en un rato.' })
    }
  })
}
