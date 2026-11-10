// BIMS ERP — Servidor principal (Fastify)
// Sin top-level await — compatible con LiteSpeed (Hostinger)

import Fastify from 'fastify'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import rateLimit from '@fastify/rate-limit'
import multipart from '@fastify/multipart'
import { authPlugin } from './plugins/auth.js'
import { tenantPlugin } from './plugins/tenant.js'
import authRoutes from './routes/v1/auth.js'
import productosRoutes from './routes/v1/productos.js'
import clientesRoutes from './routes/v1/clientes.js'
import proveedoresRoutes from './routes/v1/proveedores.js'
import ordenesVentaRoutes from './routes/v1/ordenesVenta.js'
import ordenesCompraRoutes from './routes/v1/ordenesCompra.js'
import ticketsRoutes from './routes/v1/tickets.js'
import inventarioRoutes from './routes/v1/inventario.js'
import reportesRoutes from './routes/v1/reportes.js'
import usersRoutes from './routes/v1/users.js'
import configuracionRoutes from './routes/v1/configuracion.js'
import superadminRoutes from './routes/v1/superadmin.js'
import cajaRoutes from './routes/v1/caja.js'
import empleadosRoutes from './routes/v1/empleados.js'
import rolesRoutes from './routes/v1/roles.js'
import listasPrecioRoutes from './routes/v1/listasPrecio.js'
import auditoriaRoutes from './routes/v1/auditoria.js'
import cuponesRoutes from './routes/v1/cupones.js'
import puntosRoutes from './routes/v1/puntos.js'
import crmRoutes from './routes/v1/crm.js'
import contableRoutes from './routes/v1/contable.js'
import cotizacionDolarRoutes from './routes/v1/cotizacionDolar.js'
import soporteRoutes from './routes/v1/soporte.js'
import tallerRoutes from './routes/v1/taller.js'
import produccionRoutes from './routes/v1/produccion.js'

async function start() {
  const isProd = process.env.NODE_ENV === 'production'

  if (!process.env.DATABASE_URL) {
    console.warn('WARNING: DATABASE_URL no configurada')
  }

  const app = Fastify({
    logger: isProd ? { level: 'warn' } : {
      level: 'info',
      transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
    },
    trustProxy: true,
  })

  await app.register(cors, {
    origin: process.env.CORS_ORIGIN?.split(',') || ['http://localhost:3000'],
    credentials: true,
    // @fastify/cors >=10 (Fastify 5) solo permite GET/HEAD/POST por defecto — se dejan explícitos
    // los mismos métodos que permitía la v9, para que nada cambie.
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
  })

  await app.register(rateLimit, {
    max: 200,
    timeWindow: '1 minute',
    errorResponseBuilder: () => ({
      error: 'too_many_requests',
      message: 'Demasiadas solicitudes. Intente en un momento.',
    }),
  })

  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } }) // 10MB, alcanza de sobra para una lista de precios

  await app.register(jwt, {
    secret: process.env.JWT_SECRET || 'nexoerp-dev-secret-change-in-production-32ch',
    sign: { expiresIn: process.env.JWT_EXPIRES || '7d' },
  })

  await app.register(authPlugin)
  await app.register(tenantPlugin)

  const v1 = { prefix: '/api/v1' }
  await app.register(authRoutes, v1)
  await app.register(usersRoutes, v1)
  await app.register(productosRoutes, v1)
  await app.register(clientesRoutes, v1)
  await app.register(proveedoresRoutes, v1)
  await app.register(ordenesVentaRoutes, v1)
  await app.register(ordenesCompraRoutes, v1)
  await app.register(ticketsRoutes, v1)
  await app.register(inventarioRoutes, v1)
  await app.register(reportesRoutes, v1)
  await app.register(configuracionRoutes, v1)
  await app.register(superadminRoutes, v1)
  await app.register(cajaRoutes, v1)
  await app.register(empleadosRoutes, v1)
  await app.register(rolesRoutes, v1)
  await app.register(listasPrecioRoutes, v1)
  await app.register(auditoriaRoutes, v1)
  await app.register(cuponesRoutes, v1)
  await app.register(puntosRoutes, v1)
  await app.register(crmRoutes, v1)
  await app.register(contableRoutes, v1)
  await app.register(cotizacionDolarRoutes, v1)
  await app.register(soporteRoutes, v1)
  await app.register(tallerRoutes, v1)
  await app.register(produccionRoutes, v1)

  app.get('/health', async () => ({
    status: 'ok',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    db: process.env.DATABASE_URL ? 'configured' : 'not configured',
  }))

  app.get('/', async () => ({ api: 'BIMS ERP', version: '1.0.0' }))

  app.setErrorHandler((error, req, reply) => {
    if (error.validation || error.statusCode === 400) {
      return reply.status(400).send({ error: 'validation_error', message: error.message })
    }
    if (error.code === 'FST_JWT_AUTHORIZATION_TOKEN_EXPIRED') {
      return reply.status(401).send({ error: 'token_expired', message: 'Sesion expirada.' })
    }
    if (error.code?.startsWith('FST_JWT')) {
      return reply.status(401).send({ error: 'unauthorized', message: 'Token invalido.' })
    }
    if (error.statusCode && error.statusCode < 500) {
      return reply.status(error.statusCode).send({ error: error.code || 'client_error', message: error.message })
    }
    req.log.error({ err: error }, 'Unhandled error')
    return reply.status(500).send({ error: 'internal_error', message: 'Error interno del servidor.' })
  })

  try {
    const port = parseInt(process.env.PORT || '4000', 10)
    await app.listen({ port, host: '0.0.0.0' })
    console.log('BIMS ERP API corriendo en puerto ' + port)
  } catch (err) {
    console.error('Error al arrancar:', err.message)
    process.exit(1)
  }
}

start()
