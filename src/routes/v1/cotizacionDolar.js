// ─────────────────────────────────────────────────────────────
//  Rutas: /api/v1/cotizacion-dolar
//  Cotización del dólar por tenant — auto-fetch desde dolarapi.com (sin API key) con
//  override manual por campo, más un "manual compra/venta" (8va/7ma cotización, ver
//  CLAVES_COTIZACION en src/lib/cotizacion.js) para cuando ninguna de las 6 automáticas
//  coincide con lo que efectivamente se cobró/pagó. Un cron externo (cron-job.org, cada
//  10/12/14/17hs ART) pega a /cotizacion-dolar/cron-actualizar para refrescar TODOS los
//  tenants de una sola vez sin depender de que un usuario abra la app — ver ese endpoint
//  más abajo para el detalle de por qué es un endpoint global, no por-tenant.
// ─────────────────────────────────────────────────────────────

import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { invalidarCotizacion } from '../../lib/moneda.js'

const SA_TOKEN = process.env.SA_TOKEN || 'nexo-super-admin-2025'

const cotizacionSchema = z.object({
  oficialCompra: z.number().min(0).optional(),
  oficialVenta: z.number().min(0).optional(),
  blueCompra: z.number().min(0).optional(),
  blueVenta: z.number().min(0).optional(),
  usdtCompra: z.number().min(0).optional(),
  usdtVenta: z.number().min(0).optional(),
  manualCompra: z.number().min(0).optional(),
  manualVenta: z.number().min(0).optional(),
  tipoDefault: z.enum([
    'oficialCompra', 'oficialVenta', 'blueCompra', 'blueVenta',
    'usdtCompra', 'usdtVenta', 'manualCompra', 'manualVenta',
  ]).optional(),
})

async function asegurarCotizacion(tenantId) {
  const existente = await prisma.cotizacionDolar.findUnique({ where: { tenantId } })
  if (existente) return existente
  return prisma.cotizacionDolar.create({ data: { tenantId } })
}

// Trae oficial/blue/cripto(≈usdt) de dolarapi.com UNA sola vez — el valor de mercado es el
// mismo para todos los tenants, no hay razón para pedirlo repetido. Lanza si falla; el
// llamador decide cómo responder (502 en el endpoint por-tenant, log silencioso en el cron).
async function fetchDolarApi() {
  const r = await fetch('https://dolarapi.com/v1/dolares', { signal: AbortSignal.timeout(8000) })
  if (!r.ok) throw new Error('HTTP ' + r.status)
  const datos = await r.json()
  const porCasa = {}
  for (const d of datos) porCasa[d.casa] = d
  const oficial = porCasa.oficial, blue = porCasa.blue, cripto = porCasa.cripto
  if (!oficial || !blue) throw new Error('La respuesta de dolarapi.com no tuvo el formato esperado.')
  return {
    oficialCompra: oficial.compra, oficialVenta: oficial.venta,
    blueCompra: blue.compra, blueVenta: blue.venta,
    // dolarapi no expone un endpoint dedicado de USDT — se usa su cotización "cripto"
    // agregada como aproximación; el manual está para cuando difiere.
    usdtCompra: cripto?.compra ?? 0, usdtVenta: cripto?.venta ?? 0,
  }
}

export default async function cotizacionDolarRoutes(fastify) {
  const auth = { preHandler: [fastify.verifyJWT, fastify.verifyTenant] }
  const adminOnly = { preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN'])] }

  fastify.get('/cotizacion-dolar', auth, async (req) => {
    return asegurarCotizacion(req.tenantId)
  })

  // Override manual — el usuario tipea el valor que efectivamente tomó ese día si difiere
  // del auto-fetch, o marca cuál de las 8 claves es el default (tipoDefault, usado por
  // snapshotCotizacion en cada transacción nueva). Nunca se pisa solo, únicamente cuando el
  // usuario aprieta "Actualizar" o edita un campo / elige un default a mano.
  fastify.put('/cotizacion-dolar', adminOnly, async (req, reply) => {
    const body = cotizacionSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.errors[0].message })
    await asegurarCotizacion(req.tenantId)
    invalidarCotizacion(req.tenantId) // los precios en dólares se recalculan con el valor nuevo
    return prisma.cotizacionDolar.update({
      where: { tenantId: req.tenantId },
      data: { ...body.data, ...(body.data.tipoDefault ? {} : { fuente: 'MANUAL' }) },
    })
  })

  // Trae oficial/blue/cripto de dolarapi.com y pisa los 6 valores automáticos con fuente:'API'
  // para EL TENANT actual — usado por el botón "🔄 Actualizar" del widget. Cualquier usuario
  // autenticado puede pedirlo (es de solo-lectura sobre un servicio externo).
  fastify.post('/cotizacion-dolar/actualizar', auth, async (req, reply) => {
    let valores
    try {
      valores = await fetchDolarApi()
    } catch (e) {
      return reply.status(502).send({ error: 'fetch_error', message: 'No se pudo obtener la cotización externa (' + e.message + '). El último valor guardado sigue disponible.' })
    }
    await asegurarCotizacion(req.tenantId)
    invalidarCotizacion(req.tenantId)
    return prisma.cotizacionDolar.update({
      where: { tenantId: req.tenantId },
      data: { ...valores, fuente: 'API' },
    })
  })

  // ── POST /cotizacion-dolar/cron-actualizar ─────────────────
  // Endpoint GLOBAL (no requiere tenant/login) para el cron externo (cron-job.org, configurado
  // una única vez del lado del hosting — no es algo que cada usuario/dispositivo tenga que
  // repetir). Protegido con el mismo SA_TOKEN que ya usa /superadmin, así se evita agregar una
  // env var nueva (en este hosting, cualquier cambio de env var exige un redeploy completo del
  // zip para tomar efecto — ver nota de deploy mechanics). Se llama 4x/día (10/12/14/17hs ART).
  // Pega a dolarapi.com UNA vez, guarda una fila en el histórico global
  // (CotizacionDolarHistorial, sin tenantId — el valor de mercado es el mismo para todos) y
  // actualiza los 6 campos automáticos de TODOS los tenants de un solo saque — el manual y el
  // tipoDefault de cada tenant no se tocan acá, son decisión propia de cada uno.
  fastify.post('/cotizacion-dolar/cron-actualizar', async (req, reply) => {
    const token = req.headers['x-sa-token'] || req.query.token
    if (token !== SA_TOKEN) return reply.status(401).send({ error: 'No autorizado' })

    let valores
    try {
      valores = await fetchDolarApi()
    } catch (e) {
      return reply.status(502).send({ error: 'fetch_error', message: 'No se pudo obtener la cotización externa (' + e.message + ').' })
    }

    await prisma.cotizacionDolarHistorial.create({ data: valores })

    // updateMany actualiza a todos los tenants que YA tienen una fila (rápido, una sola query);
    // los que nunca abrieron el widget de dólar todavía no tienen fila y no hace falta crearles
    // una acá — se las crea asegurarCotizacion() la primera vez que alguien de ese tenant entra.
    const actualizados = await prisma.cotizacionDolar.updateMany({
      data: { ...valores, fuente: 'API' },
    })
    invalidarCotizacion() // todos los tenants

    return { ok: true, tenantsActualizados: actualizados.count, valores }
  })
}
