// BIMS ERP — SuperAdmin routes
import { existsSync, mkdirSync } from 'fs'
import { appendFile, readFile } from 'fs/promises'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { randomBytes, timingSafeEqual } from 'crypto'
import { prisma } from '../../lib/prisma.js'
import { invalidarCacheAuth } from '../../lib/authCache.js'
import { sanitizeModulos } from '../../lib/modulos.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(__dirname, '../../../data')
const CSV_PATH = join(DATA_DIR, 'onboarding.csv')
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })

// SA_TOKEN se lee de la env (poblada por el loader de .env de server.cjs en prod, o del .env
// local en dev) — nunca hardcodeado acá, para que no quede expuesto en el código fuente ni en
// el zip de deploy. Si por algún motivo falta, se genera uno al azar por arranque (nunca un
// valor conocido) y se loguea una sola vez, en vez de caer a un password fijo predecible.
const SA_TOKEN = process.env.SA_TOKEN || randomBytes(24).toString('hex')
if (!process.env.SA_TOKEN) {
  console.warn(`[superadmin] SA_TOKEN no está seteado — usando uno generado para esta sesión del server: ${SA_TOKEN}\n[superadmin] Definí SA_TOKEN en el .env de producción para que no cambie en cada reinicio.`)
}

function tokensIguales(a, b) {
  const bufA = Buffer.from(String(a || ''))
  const bufB = Buffer.from(String(b || ''))
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

const CSV_COLS = ['timestamp','ip','tenant_id','empresa','cuit','nombre','cargo','email','tel','ciudad','pais','tamano','industria','sucursales','sistema']

function escapeCSV(val) {
  const s = (val ?? '').toString().replace(/"/g, '""')
  return /[,"\n\r]/.test(s) ? `"${s}"` : s
}

async function appendCSV(row) {
  const exists = existsSync(CSV_PATH)
  const line = CSV_COLS.map(c => escapeCSV(row[c] ?? '')).join(',') + '\n'
  if (!exists) await appendFile(CSV_PATH, CSV_COLS.join(',') + '\n' + line, 'utf8')
  else await appendFile(CSV_PATH, line, 'utf8')
}

async function readCSV() {
  if (!existsSync(CSV_PATH)) return []
  const raw = await readFile(CSV_PATH, 'utf8')
  const lines = raw.split('\n').filter(l => l.trim())
  if (lines.length < 2) return []
  const cols = lines[0].split(',').map(c => c.trim())
  return lines.slice(1).reverse().map(line => {
    const vals = []; let cur = '', inQ = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (ch === '"' && !inQ) { inQ = true; continue }
      if (ch === '"' && inQ && line[i+1] === '"') { cur += '"'; i++; continue }
      if (ch === '"' && inQ) { inQ = false; continue }
      if (ch === ',' && !inQ) { vals.push(cur); cur = ''; continue }
      cur += ch
    }
    vals.push(cur)
    return Object.fromEntries(cols.map((c,i) => [c, vals[i] ?? '']))
  })
}

function checkToken(req, reply) {
  // El query string solo lo usa el link de descarga del CSV (window.location.href no puede
  // mandar headers) — todo el resto del frontend ya manda el header x-sa-token.
  const token = req.headers['x-sa-token'] || req.query.token
  if (!tokensIguales(token, SA_TOKEN)) { reply.status(401).send({ error: 'No autorizado' }); return false }
  return true
}

export default async function superadminRoutes(fastify) {

  // Guardar datos de onboarding
  fastify.post('/onboarding/guardar', async (req, reply) => {
    const d = req.body || {}
    try {
      await appendCSV({
        timestamp: new Date().toISOString().replace('T',' ').slice(0,19),
        ip: req.ip, tenant_id: d.tenantId||'', empresa: d.empresa||'',
        cuit: d.cuit||'', nombre: d.nombre||'', cargo: d.cargo||'',
        email: d.email||'', tel: d.tel||'', ciudad: d.ciudad||'',
        pais: d.pais||'', tamano: d.tamano||'', industria: d.industria||'',
        sucursales: d.sucursales||'', sistema: d.sistema||'',
      })
    } catch(e) { /* no bloquear registro si falla CSV */ }
    return { ok: true }
  })

  // Stats del CSV de onboarding
  fastify.get('/superadmin/stats', async (req, reply) => {
    if (!checkToken(req, reply)) return
    const rows = await readCSV()
    const porIndustria = {}, porSucursales = {}, porCiudad = {}, porDia = {}
    for (const r of rows) {
      const ind = r.industria||'otro'; porIndustria[ind] = (porIndustria[ind]||0)+1
      const suc = r.sucursales||'1'; porSucursales[suc] = (porSucursales[suc]||0)+1
      const ciu = r.ciudad||''; if(ciu) porCiudad[ciu] = (porCiudad[ciu]||0)+1
      const dia = (r.timestamp||'').slice(0,10); if(dia) porDia[dia] = (porDia[dia]||0)+1
    }
    return {
      ok: true, total_registros: rows.length,
      por_industria: porIndustria, por_sucursales: porSucursales,
      por_ciudad: Object.fromEntries(Object.entries(porCiudad).sort((a,b)=>b[1]-a[1]).slice(0,10)),
      por_dia: Object.fromEntries(Object.entries(porDia).sort((a,b)=>a[0].localeCompare(b[0])).slice(-30)),
    }
  })

  // Lista de clientes del CSV
  fastify.get('/superadmin/clientes', async (req, reply) => {
    if (!checkToken(req, reply)) return
    let rows = await readCSV()
    const { vertical, q } = req.query
    if (vertical && vertical !== 'all') rows = rows.filter(r => r.industria === vertical)
    if (q) { const ql = q.toLowerCase(); rows = rows.filter(r => [r.empresa,r.email,r.nombre].some(v=>(v||'').toLowerCase().includes(ql))) }
    return { ok: true, total: rows.length, columnas: CSV_COLS, filas: rows.slice(0,500) }
  })

  // Exportar CSV
  fastify.get('/superadmin/export', async (req, reply) => {
    if (!checkToken(req, reply)) return
    if (!existsSync(CSV_PATH)) return reply.status(404).send({ error: 'Sin datos' })
    const fecha = new Date().toISOString().slice(0,10).replace(/-/g,'')
    reply.header('Content-Type', 'text/csv; charset=utf-8')
    reply.header('Content-Disposition', `attachment; filename="bims-erp_onboarding_${fecha}.csv"`)
    return reply.send('\uFEFF' + await readFile(CSV_PATH, 'utf8'))
  })

  // Métricas reales de PostgreSQL
  fastify.get('/superadmin/metricas-erp', async (req, reply) => {
    if (!checkToken(req, reply)) return
    try {
      const [tenants_total, tenants_activos, usuarios_total, productos_total,
             ordenes_venta_total, ordenes_compra_total, tickets_total, clientes_total] = await Promise.all([
        prisma.tenant.count(),
        prisma.tenant.count({ where: { activo: true } }),
        prisma.user.count(),
        prisma.producto.count(),
        prisma.ordenVenta.count(),
        prisma.ordenCompra.count(),
        prisma.ticket.count(),
        prisma.cliente.count(),
      ])
      return { ok: true, data: { tenants_total, tenants_activos, usuarios_total,
        productos_total, ordenes_venta_total, ordenes_compra_total, tickets_total, clientes_total } }
    } catch(e) {
      return { ok: true, data: { tenants_total:0, tenants_activos:0, usuarios_total:0,
        productos_total:0, ordenes_venta_total:0, ordenes_compra_total:0, tickets_total:0, clientes_total:0,
        nota: 'Error conectando DB: ' + e.message } }
    }
  })

  // Todos los tenants desde PostgreSQL
  fastify.get('/superadmin/tenants', async (req, reply) => {
    if (!checkToken(req, reply)) return
    try {
      const { q, plan } = req.query
      const where = {}
      if (plan) where.plan = plan
      if (q) where.OR = [
        { nombre: { contains: q, mode: 'insensitive' } },
        { email:  { contains: q, mode: 'insensitive' } },
      ]
      const tenants = await prisma.tenant.findMany({
        where, orderBy: { creadoEn: 'desc' }, take: 200,
        select: { id:true, nombre:true, slug:true, email:true, plan:true, activo:true,
          creadoEn:true, trialVence:true, planVence:true, rubro:true, modulosActivos:true,
          _count: { select: { users:true, productos:true, clientes:true, ordVentas:true, ordCompras:true } }
        }
      })
      return { ok: true, total: tenants.length, tenants }
    } catch(e) {
      return { ok: true, total: 0, tenants: [], error: e.message }
    }
  })

  // Cambiar plan / vencimientos / activo (suspender-reactivar) de un tenant
  const PLANES_VALIDOS = ['TRIAL', 'STARTER', 'PROFESIONAL', 'ENTERPRISE']
  fastify.patch('/superadmin/tenants/:id/plan', async (req, reply) => {
    if (!checkToken(req, reply)) return
    const { plan, trialVence, planVence, activo } = req.body || {}
    const data = {}
    if (plan !== undefined) {
      if (!PLANES_VALIDOS.includes(plan)) {
        return reply.status(400).send({ error: 'plan_invalido', message: 'Plan no reconocido.' })
      }
      data.plan = plan
    }
    if (trialVence !== undefined) data.trialVence = trialVence ? new Date(trialVence) : null
    if (planVence !== undefined) data.planVence = planVence ? new Date(planVence) : null
    if (activo !== undefined) data.activo = !!activo
    if (!Object.keys(data).length) {
      return reply.status(400).send({ error: 'sin_cambios', message: 'Nada para actualizar.' })
    }
    try {
      const tenant = await prisma.tenant.update({
        where: { id: req.params.id },
        data,
        select: { id: true, nombre: true, plan: true, trialVence: true, planVence: true, activo: true },
      })
      invalidarCacheAuth()
      return { ok: true, tenant }
    } catch (e) {
      return reply.status(404).send({ error: 'not_found', message: 'Tenant no encontrado.' })
    }
  })

  // Activar/desactivar módulos de un tenant
  fastify.patch('/superadmin/tenants/:id/modulos', async (req, reply) => {
    if (!checkToken(req, reply)) return
    const modulos = sanitizeModulos(req.body?.modulos)
    try {
      const tenant = await prisma.tenant.update({
        where: { id: req.params.id },
        data: { modulosActivos: modulos },
        select: { id: true, nombre: true, modulosActivos: true },
      })
      invalidarCacheAuth() // verifyTenant cachea modulosActivos (gating del backend de Taller)
      return { ok: true, tenant }
    } catch (e) {
      return reply.status(404).send({ error: 'not_found', message: 'Tenant no encontrado.' })
    }
  })

  // ── Mensajes de soporte (chat flotante Ayuda/Soporte de cada tenant) ──────
  fastify.get('/superadmin/soporte-tickets', async (req, reply) => {
    if (!checkToken(req, reply)) return
    try {
      const { estado } = req.query
      const where = {}
      if (estado && ['ABIERTO', 'RESUELTO'].includes(estado)) where.estado = estado
      const tickets = await prisma.ticketSoporte.findMany({
        where,
        orderBy: { creadoEn: 'desc' },
        take: 300,
        include: {
          tenant: { select: { id: true, nombre: true, email: true } },
          usuario: { select: { id: true, nombre: true, email: true } },
        },
      })
      return { ok: true, total: tickets.length, tickets }
    } catch (e) {
      return { ok: true, total: 0, tickets: [], error: e.message }
    }
  })

  fastify.patch('/superadmin/soporte-tickets/:id', async (req, reply) => {
    if (!checkToken(req, reply)) return
    const { estado } = req.body || {}
    if (!['ABIERTO', 'RESUELTO'].includes(estado)) {
      return reply.status(400).send({ error: 'validation_error', message: 'Estado inválido.' })
    }
    try {
      const ticket = await prisma.ticketSoporte.update({ where: { id: req.params.id }, data: { estado } })
      return { ok: true, ticket }
    } catch (e) {
      return reply.status(404).send({ error: 'not_found', message: 'Ticket no encontrado.' })
    }
  })
}
