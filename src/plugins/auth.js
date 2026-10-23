import fp from 'fastify-plugin'
import { prisma } from '../lib/prisma.js'
import { cacheSesion, invalidarCacheAuth } from '../lib/authCache.js'
import { PERMS_SISTEMA, tienePermiso } from '../lib/permisos.js'

async function authPluginFn(fastify) {
  if (!fastify.hasRequestDecorator('user')) {
    fastify.decorateRequest('user', null)
  }
  if (!fastify.hasRequestDecorator('tenantId')) {
    fastify.decorateRequest('tenantId', null)
    fastify.decorateRequest('tenantModulos', null)
  }

  if (!fastify.hasDecorator('verifyJWT')) {
    fastify.decorate('verifyJWT', async function (req, reply) {
      try {
        await req.jwtVerify()
        // Caché de 30s (ver lib/authCache.js) — solo se guardan sesiones válidas.
        let sesion = cacheSesion.leer(req.user.jti)
        if (!sesion) {
          sesion = await prisma.sesion.findUnique({
            where: { token: req.user.jti },
            include: {
              user: {
                select: { id: true, tenantId: true, nombre: true, email: true, rol: true, rolId: true, activo: true },
              },
            },
          })
          if (sesion && sesion.activa && sesion.user.activo && sesion.expiresAt >= new Date()) cacheSesion.guardar(req.user.jti, sesion)
        }
        if (!sesion || !sesion.activa) {
          return reply.status(401).send({ error: 'unauthorized', message: 'Sesion invalida o revocada.' })
        }
        if (sesion.expiresAt < new Date()) {
          await prisma.sesion.update({ where: { id: sesion.id }, data: { activa: false } })
          invalidarCacheAuth()
          return reply.status(401).send({ error: 'token_expired', message: 'Sesion expirada.' })
        }
        if (!sesion.user.activo) {
          return reply.status(403).send({ error: 'forbidden', message: 'Usuario desactivado.' })
        }
        // Preservar el jti del JWT al pisar req.user con el registro de la DB — sin esto,
        // cualquier ruta que hiciera req.user.jti más adelante (logout, cerrar-otras-sesiones
        // al cambiar contraseña) siempre leía undefined, y Prisma trata un filtro undefined
        // como "sin filtro": logout terminaba cerrando TODAS las sesiones del usuario en vez de
        // solo la actual, y "cerrar otras sesiones" cerraba también la sesión actual.
        req.user = { ...sesion.user, jti: req.user.jti }
      } catch (err) {
        return reply.status(401).send({ error: 'unauthorized', message: 'Token invalido o expirado.' })
      }
    })
  }

  if (!fastify.hasDecorator('requireRole')) {
    fastify.decorate('requireRole', function (roles) {
      return async function (req, reply) {
        if (!req.user) return reply.status(401).send({ error: 'unauthorized', message: 'No autenticado.' })
        if (!roles.includes(req.user.rol)) {
          return reply.status(403).send({ error: 'forbidden', message: 'Acceso restringido. Rol requerido: ' + roles.join(' o ') + '.' })
        }
      }
    })
  }

  // RBAC configurable: si el usuario tiene un rol custom (User.rolId) asignado, se chequean
  // sus permisos dinámicos; si no, cae al mapeo fijo por RolUsuario (mismo comportamiento que
  // existía antes de esta feature — nadie que no toque roles custom nota el cambio).
  // Se aplica sólo en las rutas más sensibles (ver plan del sprint) — no reemplaza requireRole
  // en todo el backend, que sigue siendo la protección de base en el resto de las rutas.
  if (!fastify.hasDecorator('requirePermiso')) {
    fastify.decorate('requirePermiso', function (modulo, accion) {
      return async function (req, reply) {
        if (!req.user) return reply.status(401).send({ error: 'unauthorized', message: 'No autenticado.' })
        if (req.user.rolId) {
          const rol = await prisma.rol.findUnique({ where: { id: req.user.rolId } })
          if (!rol || !rol.activo || !tienePermiso(rol.permisos, modulo, accion)) {
            return reply.status(403).send({ error: 'forbidden', message: 'Tu rol no tiene permiso de "' + accion + '" en "' + modulo + '".' })
          }
          return
        }
        const modulos = PERMS_SISTEMA[req.user.rol] || []
        if (!modulos.includes(modulo)) {
          return reply.status(403).send({ error: 'forbidden', message: 'Tu rol no tiene acceso a "' + modulo + '".' })
        }
      }
    })
  }
}

export const authPlugin = fp(authPluginFn)
