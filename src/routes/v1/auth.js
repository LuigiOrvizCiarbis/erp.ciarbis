// ─────────────────────────────────────────────────────────────
//  Rutas: /api/v1/auth
//  Login, logout, refresh, registro de tenant, recupero pass
// ─────────────────────────────────────────────────────────────

import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { invalidarCacheAuth } from '../../lib/authCache.js'
import { randomBytes } from 'crypto'
import { MODULE_CATALOG, RUBRO_MODULE_DEFAULTS, defaultModulosForRubro, sanitizeModulos, OCULTABLE_MODULES } from '../../lib/modulos.js'
import { PERMS_SISTEMA, ROL_LABELS, permisosDesdeModulos } from '../../lib/permisos.js'
import { sendEmail, emailConfirmacionCuenta, emailRecuperoPassword } from '../../lib/email.js'

// ─── Schemas de validación ───────────────────────────────────

const loginSchema = z.object({
  email: z.string().email('Email inválido'),
  password: z.string().min(1, 'Contraseña requerida'),
})

const registerSchema = z.object({
  // Datos de la empresa (tenant)
  empresa: z.string().min(2, 'Nombre de empresa requerido'),
  cuit: z.string().optional(),
  rubro: z.string().optional(),
  modulos: z.array(z.string()).optional(),
  // Datos del admin
  nombre: z.string().min(2, 'Nombre requerido'),
  email: z.string().email('Email inválido'),
  password: z.string().min(8, 'Mínimo 8 caracteres'),
})

const forgotSchema = z.object({
  email: z.string().email('Email inválido'),
})

const resetSchema = z.object({
  token: z.string(),
  password: z.string().min(8, 'Mínimo 8 caracteres'),
})

// ─── Helpers ─────────────────────────────────────────────────

function slugify(str) {
  return str
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
}

async function generateSlug(base) {
  let slug = slugify(base)
  let count = 0
  while (true) {
    const exists = await prisma.tenant.findUnique({ where: { slug: count ? `${slug}-${count}` : slug } })
    if (!exists) return count ? `${slug}-${count}` : slug
    count++
  }
}

async function createToken(fastify, userId, jti) {
  return fastify.jwt.sign(
    { sub: userId, jti },
    { expiresIn: process.env.JWT_EXPIRES || '7d' }
  )
}

// ─── Plugin de rutas ─────────────────────────────────────────

export default async function authRoutes(fastify) {

  // ── GET /auth/modulos-catalogo ────────────────────────────
  // Pública (sin auth) — la usa register.html antes de tener token,
  // y dashboard.html/superadmin para pintar los mismos catálogos.
  fastify.get('/auth/modulos-catalogo', async () => ({
    catalogo: MODULE_CATALOG,
    ocultables: OCULTABLE_MODULES,
    rubroDefaults: RUBRO_MODULE_DEFAULTS,
  }))

  // ── POST /auth/login ──────────────────────────────────────
  fastify.post('/auth/login', {
    config: {
      rateLimit: { max: 10, timeWindow: '1 minute' }
    }
  }, async (req, reply) => {
    const body = loginSchema.safeParse(req.body)
    if (!body.success) {
      return reply.status(400).send({ error: 'validation_error', message: body.error.issues[0].message })
    }

    const { email, password } = body.data

    const user = await prisma.user.findFirst({
      where: { email: email.toLowerCase() },
      include: {
        tenant: { select: { id: true, nombre: true, slug: true, activo: true, plan: true, trialVence: true, facAutoEnabled: true, ptoVta: true, rubro: true, modulosActivos: true, modulosOcultos: true, logo: true } },
        rolCustom: { select: { id: true, nombre: true, permisos: true } },
      },
    })

    // Timing-safe: siempre hacer bcrypt aunque no exista el user
    const hash = user?.passHash || '$2a$12$invalidhashtopreventtimingattack'
    const valid = await bcrypt.compare(password, hash)

    if (!user || !valid) {
      return reply.status(401).send({ error: 'invalid_credentials', message: 'Email o contraseña incorrectos.' })
    }

    if (!user.activo) {
      return reply.status(403).send({ error: 'forbidden', message: 'Usuario desactivado.' })
    }

    if (!user.tenant.activo) {
      return reply.status(403).send({ error: 'forbidden', message: 'Empresa inactiva.' })
    }

    // Crear sesión en DB
    const jti = randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 días

    await prisma.sesion.create({
      data: {
        userId: user.id,
        token: jti,
        userAgent: req.headers['user-agent'],
        ip: req.ip,
        expiresAt,
      },
    })

    // Actualizar último acceso
    await prisma.user.update({
      where: { id: user.id },
      data: { ultimoAcceso: new Date() },
    })

    const token = await createToken(fastify, user.id, jti)

    return reply.status(200).send({
      token,
      user: {
        id: user.id,
        nombre: user.nombre,
        email: user.email,
        rol: user.rol,
        rolPermisos: user.rolCustom ? user.rolCustom.permisos : null,
        avatar: user.avatar,
        tenantId: user.tenantId,
        sucursalId: user.sucursalId,
        tenant: {
          id: user.tenant.id,
          nombre: user.tenant.nombre,
          slug: user.tenant.slug,
          plan: user.tenant.plan,
          facAutoEnabled: user.tenant.facAutoEnabled,
          ptoVta: user.tenant.ptoVta,
          rubro: user.tenant.rubro,
          modulosActivos: user.tenant.modulosActivos,
          modulosOcultos: user.tenant.modulosOcultos || [],
          logo: user.tenant.logo,
        },
      },
    })
  })

  // ── POST /auth/logout ─────────────────────────────────────
  fastify.post('/auth/logout', {
    preHandler: [fastify.verifyJWT],
  }, async (req, reply) => {
    await prisma.sesion.updateMany({
      where: { token: req.user.jti, userId: req.user.id },
      data: { activa: false },
    })
    invalidarCacheAuth()
    return reply.status(200).send({ message: 'Sesión cerrada correctamente.' })
  })

  // ── GET /auth/me ──────────────────────────────────────────
  fastify.get('/auth/me', {
    preHandler: [fastify.verifyJWT],
  }, async (req, reply) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true, nombre: true, email: true, rol: true, avatar: true,
        ultimoAcceso: true, sucursalId: true,
        rolCustom: { select: { id: true, nombre: true, permisos: true } },
        tenant: {
          select: {
            id: true, nombre: true, slug: true, plan: true,
            facAutoEnabled: true, ptoVta: true, condIVA: true,
            rubro: true, modulosActivos: true, modulosOcultos: true, logo: true,
          },
        },
      },
    })
    return reply.send(user)
  })

  // ── POST /auth/register ───────────────────────────────────
  // Registra una nueva empresa + usuario admin
  fastify.post('/auth/register', async (req, reply) => {
    const body = registerSchema.safeParse(req.body)
    if (!body.success) {
      return reply.status(400).send({ error: 'validation_error', message: body.error.issues[0].message })
    }

    const { empresa, cuit, rubro, modulos, nombre, email, password } = body.data

    // Verificar que el email no esté en uso
    const emailExists = await prisma.user.findFirst({ where: { email: email.toLowerCase() } })
    if (emailExists) {
      return reply.status(409).send({ error: 'email_taken', message: 'El email ya está registrado.' })
    }

    const slug = await generateSlug(empresa)
    const passHash = await bcrypt.hash(password, 12)

    // Trial de 14 días
    const trialVence = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)

    // Módulos: los que eligió el usuario en el onboarding (saneados contra el catálogo real),
    // o si no mandó nada, la sugerencia por rubro.
    const modulosElegidos = modulos?.length ? sanitizeModulos(modulos) : defaultModulosForRubro(rubro)

    // Crear tenant + admin en una transacción
    const { tenant, user } = await prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: {
          nombre: empresa,
          slug,
          cuit,
          rubro,
          modulosActivos: modulosElegidos,
          email: email.toLowerCase(),
          plan: 'TRIAL',
          trialVence,
        },
      })

      const emailVerifToken = randomBytes(32).toString('hex')

      const user = await tx.user.create({
        data: {
          tenantId: tenant.id,
          nombre,
          email: email.toLowerCase(),
          passHash,
          rol: 'ADMIN',
          emailVerifToken,
        },
      })

      // Sucursal principal
      await tx.sucursal.create({
        data: { tenantId: tenant.id, nombre: 'Principal', esPrincipal: true },
      })

      // Roles de sistema — uno por valor del enum RolUsuario, listos para duplicar/personalizar
      // desde Configuración → Roles sin dejar al tenant nuevo con la lista vacía.
      for (const [rolEnum, modulos] of Object.entries(PERMS_SISTEMA)) {
        await tx.rol.create({
          data: { tenantId: tenant.id, nombre: ROL_LABELS[rolEnum] || rolEnum, esSistema: true, permisos: permisosDesdeModulos(modulos) },
        })
      }

      return { tenant, user }
    })

    // Crear sesión
    const jti = randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

    await prisma.sesion.create({
      data: { userId: user.id, token: jti, userAgent: req.headers['user-agent'], ip: req.ip, expiresAt },
    })

    const token = await createToken(fastify, user.id, jti)

    // No bloquear la respuesta si el email tarda o falla — la cuenta ya quedó creada
    // y utilizable, esto es solo el mail de bienvenida (informativo, no gatea nada).
    const verifUrl = `${process.env.APP_URL || 'https://erp.ciarbis.com'}/api/v1/auth/verificar-email?token=${user.emailVerifToken}`
    sendEmail({
      to: user.email,
      subject: 'Confirmá tu cuenta de BIMS ERP',
      html: emailConfirmacionCuenta({ nombre: user.nombre, empresa: tenant.nombre, email: user.email, password, url: verifUrl }),
    }).catch((err) => req.log.error({ err }, 'No se pudo enviar el email de bienvenida'))

    return reply.status(201).send({
      token,
      user: {
        id: user.id, nombre: user.nombre, email: user.email, rol: user.rol,
        tenantId: tenant.id, sucursalId: user.sucursalId,
        tenant: {
          id: tenant.id, nombre: tenant.nombre, slug: tenant.slug, plan: tenant.plan,
          rubro: tenant.rubro, modulosActivos: tenant.modulosActivos, modulosOcultos: [],
        },
      },
    })
  })

  // ── GET /auth/verificar-email ─────────────────────────────
  // Link del mail de bienvenida. No requiere login — es solo para marcar el email como
  // verificado (informativo, no bloquea nada). Responde HTML directo, lo abre el navegador.
  fastify.get('/auth/verificar-email', async (req, reply) => {
    const token = req.query.token
    const user = token ? await prisma.user.findFirst({ where: { emailVerifToken: token } }) : null

    reply.type('text/html')
    if (!user) {
      return reply.send('<body style="font-family:Arial;text-align:center;padding:60px 20px"><h2>Link inválido</h2><p>Este link de confirmación ya no es válido.</p></body>')
    }

    await prisma.user.update({ where: { id: user.id }, data: { emailVerificado: true, emailVerifToken: null } })

    return reply.send('<body style="font-family:Arial;text-align:center;padding:60px 20px"><h2>✅ Email confirmado</h2><p>Ya podés cerrar esta pestaña e iniciar sesión con normalidad.</p></body>')
  })

  // ── POST /auth/forgot-password ────────────────────────────
  fastify.post('/auth/forgot-password', {
    config: { rateLimit: { max: 5, timeWindow: '5 minutes' } }
  }, async (req, reply) => {
    const body = forgotSchema.safeParse(req.body)
    if (!body.success) {
      return reply.status(400).send({ error: 'validation_error', message: body.error.issues[0].message })
    }

    const user = await prisma.user.findFirst({ where: { email: body.data.email.toLowerCase() } })

    // Siempre responder OK para no revelar si el email existe
    if (!user) {
      return reply.send({ message: 'Si el email existe, recibirá instrucciones.' })
    }

    const token = randomBytes(32).toString('hex')
    const exp = new Date(Date.now() + 60 * 60 * 1000) // 1 hora

    await prisma.user.update({
      where: { id: user.id },
      data: { resetToken: token, resetTokenExp: exp },
    })

    const resetUrl = `${process.env.APP_URL || 'https://erp.ciarbis.com'}/reset-password?token=${token}`
    sendEmail({
      to: user.email,
      subject: 'Recuperar contraseña — BIMS ERP',
      html: emailRecuperoPassword({ nombre: user.nombre, url: resetUrl }),
    }).catch((err) => req.log.error({ err }, 'No se pudo enviar el email de recupero'))

    return reply.send({ message: 'Si el email existe, recibirá instrucciones.' })
  })

  // ── POST /auth/reset-password ─────────────────────────────
  fastify.post('/auth/reset-password', async (req, reply) => {
    const body = resetSchema.safeParse(req.body)
    if (!body.success) {
      return reply.status(400).send({ error: 'validation_error', message: body.error.issues[0].message })
    }

    const { token, password } = body.data

    const user = await prisma.user.findFirst({
      where: {
        resetToken: token,
        resetTokenExp: { gt: new Date() },
      },
    })

    if (!user) {
      return reply.status(400).send({ error: 'invalid_token', message: 'Token inválido o expirado.' })
    }

    const passHash = await bcrypt.hash(password, 12)

    await prisma.user.update({
      where: { id: user.id },
      data: { passHash, resetToken: null, resetTokenExp: null },
    })

    // Invalidar todas las sesiones activas
    await prisma.sesion.updateMany({ where: { userId: user.id }, data: { activa: false } })
    invalidarCacheAuth()

    return reply.send({ message: 'Contraseña actualizada. Inicie sesión nuevamente.' })
  })
}
