import fp from 'fastify-plugin'
import { prisma } from '../lib/prisma.js'
import { cacheTenant } from '../lib/authCache.js'

async function tenantPluginFn(fastify) {
  if (!fastify.hasDecorator('verifyTenant')) {
    fastify.decorate('verifyTenant', async function (req, reply) {
      if (!req.user?.tenantId) {
        return reply.status(401).send({ error: 'unauthorized', message: 'Sin tenant.' })
      }
      if (req.tenantId === req.user.tenantId) return

      // Caché de 30s (ver lib/authCache.js); las fechas de vencimiento se evalúan igual en cada request.
      let tenant = cacheTenant.leer(req.user.tenantId)
      if (!tenant) {
        tenant = await prisma.tenant.findUnique({
          where: { id: req.user.tenantId },
          select: { id: true, activo: true, plan: true, planVence: true, trialVence: true, facAutoEnabled: true, ptoVta: true, condIVA: true, modulosActivos: true },
        })
        if (tenant) cacheTenant.guardar(req.user.tenantId, tenant)
      }

      if (!tenant || !tenant.activo) {
        // Código propio (no 'forbidden' genérico, que comparten los 403 de RBAC) para que el
        // frontend pueda mostrar el bloqueo de pago sin confundirlo con un simple permiso denegado.
        return reply.status(403).send({ error: 'tenant_inactivo', message: 'Tenant inactivo o no encontrado.' })
      }

      const ahora = new Date()
      if (tenant.plan === 'TRIAL' && tenant.trialVence && tenant.trialVence < ahora) {
        return reply.status(402).send({ error: 'trial_expired', message: 'El periodo de prueba ha vencido.' })
      }
      if (tenant.plan !== 'TRIAL' && tenant.planVence && tenant.planVence < ahora) {
        return reply.status(402).send({ error: 'plan_expired', message: 'El plan ha vencido.' })
      }

      req.tenantId = tenant.id
      req.tenantModulos = tenant.modulosActivos || []
    })
  }
}

export const tenantPlugin = fp(tenantPluginFn)
