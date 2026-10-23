'use strict'

// BIMS ERP — Entry point Hostinger Cloud Node.js
// Sirve páginas HTML estáticas + API Fastify en /api/v1/

const path = require('path')
const fs = require('fs')
process.env.NODE_ENV = process.env.NODE_ENV || 'production'

// Loader mínimo de .env — este hosting (Hostinger + LiteSpeed Node.js Selector) inyecta
// PORT/NODE_ENV/etc. directo al proceso vía su propio panel, pero NO lee ningún .env de la app
// (no hay ninguna dependencia dotenv en package.json). Esto permite guardar secretos (ej.
// SA_TOKEN) en un .env real en el server, fuera del código fuente y del zip de deploy (está en
// .gitignore), sin depender de tener acceso al panel de variables de entorno de hPanel. Nunca
// pisa una env var que ya venga seteada por el host — el .env es solo un fallback.
;(function loadDotEnv() {
  const envPath = path.join(__dirname, '.env')
  if (!fs.existsSync(envPath)) return
  const raw = fs.readFileSync(envPath, 'utf8')
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (key && !(key in process.env)) process.env[key] = value
  }
})()

async function main() {
  const Fastify       = (await import('fastify')).default
  const cors          = (await import('@fastify/cors')).default
  const jwt           = (await import('@fastify/jwt')).default
  const rateLimit     = (await import('@fastify/rate-limit')).default
  const multipart     = (await import('@fastify/multipart')).default
  const fastifyStatic = (await import('@fastify/static')).default

  const { authPlugin }      = await import('./src/plugins/auth.js')
  const { tenantPlugin }    = await import('./src/plugins/tenant.js')
  const authRoutes          = (await import('./src/routes/v1/auth.js')).default
  const usersRoutes         = (await import('./src/routes/v1/users.js')).default
  const productosRoutes     = (await import('./src/routes/v1/productos.js')).default
  const clientesRoutes      = (await import('./src/routes/v1/clientes.js')).default
  const proveedoresRoutes   = (await import('./src/routes/v1/proveedores.js')).default
  const ordenesVentaRoutes  = (await import('./src/routes/v1/ordenesVenta.js')).default
  const ordenesCompraRoutes = (await import('./src/routes/v1/ordenesCompra.js')).default
  const ticketsRoutes       = (await import('./src/routes/v1/tickets.js')).default
  const inventarioRoutes    = (await import('./src/routes/v1/inventario.js')).default
  const reportesRoutes      = (await import('./src/routes/v1/reportes.js')).default
  const configuracionRoutes = (await import('./src/routes/v1/configuracion.js')).default
  const superadminRoutes    = (await import('./src/routes/v1/superadmin.js')).default
  const cajaRoutes          = (await import('./src/routes/v1/caja.js')).default
  const empleadosRoutes     = (await import('./src/routes/v1/empleados.js')).default
  const rolesRoutes         = (await import('./src/routes/v1/roles.js')).default
  const listasPrecioRoutes  = (await import('./src/routes/v1/listasPrecio.js')).default
  const auditoriaRoutes     = (await import('./src/routes/v1/auditoria.js')).default
  const cuponesRoutes       = (await import('./src/routes/v1/cupones.js')).default
  const puntosRoutes        = (await import('./src/routes/v1/puntos.js')).default
  const crmRoutes           = (await import('./src/routes/v1/crm.js')).default
  const contableRoutes      = (await import('./src/routes/v1/contable.js')).default
  const cotizacionDolarRoutes = (await import('./src/routes/v1/cotizacionDolar.js')).default
  const soporteRoutes = (await import('./src/routes/v1/soporte.js')).default
  const tallerRoutes = (await import('./src/routes/v1/taller.js')).default

  const app = Fastify({ logger: { level: 'warn' }, trustProxy: true })

  await app.register(cors, {
    origin: (process.env.CORS_ORIGIN || 'https://erp.ciarbis.com').split(','),
    credentials: true,
    // @fastify/cors >=10 (Fastify 5) solo permite GET/HEAD/POST por defecto — se dejan explícitos
    // los mismos métodos que permitía la v9, para que nada cambie.
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
  })
  await app.register(rateLimit, { max: 200, timeWindow: '1 minute' })
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } }) // 10MB, alcanza de sobra para una lista de precios
  await app.register(jwt, {
    secret: process.env.JWT_SECRET || 'nexoerp-dev-secret-change-in-prod-32ch',
    sign: { expiresIn: '7d' },
  })
  await app.register(authPlugin)
  await app.register(tenantPlugin)

  // Sirve /img/*, /favicon.ico, etc. — index:false para no pisar las rutas de
  // páginas de abajo (si no, intentaría servir public/index.html también en "/").
  await app.register(fastifyStatic, {
    root: path.join(__dirname, 'public'),
    prefix: '/',
    index: false,
  })

  // ── Páginas HTML ───────────────────────────────────────────
  // sendFile (vía @fastify/static, ya registrado arriba) en vez de leer+mandar el archivo a mano:
  // agrega ETag/Last-Modified automáticos, así el navegador puede revalidar con un 304 (barato)
  // en vez de volver a bajar los ~450KB de dashboard.html en cada carga — antes salía con
  // Cache-Control: no-store (el default de Fastify para una respuesta armada a mano), forzando
  // la descarga completa siempre.
  app.get('/',          async (req, reply) => reply.type('text/html').sendFile('index.html'))
  app.get('/login',     async (req, reply) => reply.type('text/html').sendFile('login.html'))
  app.get('/register',  async (req, reply) => reply.type('text/html').sendFile('register.html'))
  app.get('/forgot-password', async (req, reply) => reply.type('text/html').sendFile('forgot-password.html'))
  app.get('/reset-password',  async (req, reply) => reply.type('text/html').sendFile('reset-password.html'))
  app.get('/superadmin',async (req, reply) => reply.type('text/html').sendFile('superadmin/index.html'))
  // Manual de uso interno — sin link desde la landing ni desde el ERP, solo accesible por URL directa.
  app.get('/manual',    async (req, reply) => reply.type('text/html').sendFile('manual.html'))
  app.get('/dashboard', async (req, reply) => reply.type('text/html').sendFile('dashboard.html'))
  // Catch-all para las URLs por sección (/dashboard/inventario, /dashboard/ventas, etc.) — el
  // routing real vive en el frontend (History API, ver showModule/ruta_a_modulo en dashboard.html),
  // acá solo hace falta servir el mismo HTML para que un bookmark/pestaña nueva/refresh funcione
  // en vez de tirar 404.
  app.get('/dashboard/*', async (req, reply) => reply.type('text/html').sendFile('dashboard.html'))

  // ── API ─────────────────────────────────────────────────────
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

  app.get('/health', async () => ({
    status: 'ok', version: '2.0.0',
    timestamp: new Date().toISOString(),
    db: process.env.DATABASE_URL ? 'configured' : 'not configured',
  }))

  app.setErrorHandler((error, req, reply) => {
    if (error.statusCode && error.statusCode < 500) {
      return reply.status(error.statusCode).send({ error: error.code || 'error', message: error.message })
    }
    console.error('Error:', error.message)
    return reply.status(500).send({ error: 'internal_error', message: 'Error interno.' })
  })

  const port = parseInt(process.env.PORT || '3000', 10)
  await app.listen({ port, host: '0.0.0.0' })
  console.log('BIMS ERP corriendo en puerto ' + port)
}

main().catch(err => { console.error('Error fatal:', err.message); process.exit(1) })
