// ─────────────────────────────────────────────────────────────
//  Rutas: /api/v1/configuracion
//  Datos de empresa, toggle facturación automática, sucursales
// ─────────────────────────────────────────────────────────────

import { z } from 'zod'
import bcrypt from 'bcryptjs'
import { prisma } from '../../lib/prisma.js'
import { invalidarCacheAuth } from '../../lib/authCache.js'
import { tituloCase } from '../../lib/textUtils.js'
import { SELF_SERVICE_IDS, OCULTABLE_IDS } from '../../lib/modulos.js'

const tenantSchema = z.object({
  nombre: z.string().min(1).optional(),
  cuit: z.string().optional(),
  condIVA: z.string().optional(),
  ptoVta: z.string().optional(),
  iibb: z.string().optional(),
  tel: z.string().optional(),
  direccion: z.string().optional(),
  logo: z.string().max(3_000_000).optional(), // data URI de la imagen (≤2MB en base64 ≈ 2.7M caracteres)
  moneda: z.string().optional(),
  facTipoDefault: z.enum(['X', 'FC']).optional(),
})

const sucursalSchema = z.object({
  nombre: z.string().min(1),
  codigo: z.string().optional(),
  direccion: z.string().optional(),
  tel: z.string().optional(),
  email: z.string().email().optional().or(z.literal('')),
  activa: z.boolean().optional(),
})

const razonSocialSchema = z.object({
  nombre: z.string().min(1),
  cuit: z.string().min(1),
  condIVA: z.string().optional(),
  ptoVta: z.string().optional(),
  esPrincipal: z.boolean().optional(),
})

export default async function configuracionRoutes(fastify) {
  const adminOnly = { preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN'])] }
  const auth = { preHandler: [fastify.verifyJWT, fastify.verifyTenant] }

  // ── PUT /configuracion/modulos/:id ── el admin prende/apaga un módulo "selfService"
  // (hoy solo Taller) sin pasar por soporte. El resto del catálogo lo sigue manejando el
  // superadmin. Devuelve la lista nueva para que el frontend actualice el menú sin re-login.
  fastify.put('/configuracion/modulos/:id', adminOnly, async (req, reply) => {
    const id = req.params.id
    // Módulos base (fichaje/auditoría): no se activan por plan, se muestran u ocultan.
    // Un solo UPDATE atómico (array_remove + append): dos toggles tocados casi a la vez no se
    // pisan entre sí (leer-modificar-escribir perdía uno de los dos cambios).
    const ocultable = OCULTABLE_IDS.includes(id)
    if (!ocultable && !SELF_SERVICE_IDS.includes(id)) {
      return reply.status(403).send({ error: 'no_self_service', message: 'Este módulo lo activa nuestro equipo — contactanos.' })
    }
    const activo = !!req.body?.activo
    const agregar = ocultable ? !activo : activo // en ocultos se agrega al ocultar; en activos al activar
    const col = ocultable ? 'modulosOcultos' : 'modulosActivos'
    await prisma.$executeRawUnsafe(
      `UPDATE "tenants" SET "${col}" = array_remove(COALESCE("${col}", ARRAY[]::text[]), $1) || CASE WHEN $2 THEN ARRAY[$1]::text[] ELSE ARRAY[]::text[] END WHERE "id" = $3`,
      id, agregar, req.tenantId,
    )
    const tenant = await prisma.tenant.findUnique({ where: { id: req.tenantId }, select: { modulosActivos: true, modulosOcultos: true } })
    invalidarCacheAuth()
    return { ok: true, modulosActivos: tenant.modulosActivos, ...(ocultable && { modulosOcultos: tenant.modulosOcultos }) }
  })

  // ── GET /configuracion ────────────────────────────────────
  fastify.get('/configuracion', auth, async (req) => {
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.tenantId },
      include: {
        sucursales: { where: { activa: true }, orderBy: { esPrincipal: 'desc' } },
        users: {
          where: { activo: true },
          select: { id: true, nombre: true, email: true, rol: true, activo: true, ultimoAcceso: true },
          orderBy: { nombre: 'asc' },
        },
      },
    })
    // No exponer campos sensibles
    const { stripeId, ...safeTenant } = tenant
    return safeTenant
  })

  // ── PUT /configuracion/empresa ────────────────────────────
  fastify.put('/configuracion/empresa', adminOnly, async (req, reply) => {
    const body = tenantSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.errors[0].message })

    const tenant = await prisma.tenant.update({
      where: { id: req.tenantId },
      data: body.data,
    })
    invalidarCacheAuth()
    return tenant
  })

  // ── PUT /configuracion/facturacion-auto ───────────────────
  // Toggle facturación automática — solo ADMIN
  fastify.put('/configuracion/facturacion-auto', adminOnly, async (req, reply) => {
    const { enabled } = req.body || {}
    if (typeof enabled !== 'boolean') {
      return reply.status(400).send({ error: 'validation_error', message: '"enabled" debe ser boolean.' })
    }

    const tenant = await prisma.tenant.update({
      where: { id: req.tenantId },
      data: { facAutoEnabled: enabled },
      select: { id: true, facAutoEnabled: true },
    })
    invalidarCacheAuth()

    return {
      facAutoEnabled: tenant.facAutoEnabled,
      message: `Facturación automática ${enabled ? 'activada' : 'desactivada'}.`,
    }
  })

  // ── Sucursales ────────────────────────────────────────────

  fastify.get('/configuracion/sucursales', auth, async (req) => {
    const { activa } = req.query
    return prisma.sucursal.findMany({
      where: { tenantId: req.tenantId, ...(activa !== undefined ? { activa: activa === 'true' } : { activa: true }) },
      orderBy: [{ esPrincipal: 'desc' }, { nombre: 'asc' }],
    })
  })

  fastify.post('/configuracion/sucursales', adminOnly, async (req, reply) => {
    const body = sucursalSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.errors[0].message })
    body.data.nombre = tituloCase(body.data.nombre)

    const existe = await prisma.sucursal.findFirst({ where: { tenantId: req.tenantId, nombre: { equals: body.data.nombre, mode: 'insensitive' } } })
    if (existe) return reply.status(409).send({ error: 'nombre_duplicado', message: 'Ya existe una sucursal con ese nombre.' })

    const suc = await prisma.sucursal.create({ data: { tenantId: req.tenantId, ...body.data } })
    return reply.status(201).send(suc)
  })

  fastify.put('/configuracion/sucursales/:id', adminOnly, async (req, reply) => {
    const body = sucursalSchema.partial().safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.errors[0].message })
    if (body.data.nombre) {
      body.data.nombre = tituloCase(body.data.nombre)
      const existe = await prisma.sucursal.findFirst({ where: { tenantId: req.tenantId, nombre: { equals: body.data.nombre, mode: 'insensitive' }, id: { not: req.params.id } } })
      if (existe) return reply.status(409).send({ error: 'nombre_duplicado', message: 'Ya existe una sucursal con ese nombre.' })
    }

    // Desactivar una sucursal que todavía tiene mercadería la "escondería": su stock sigue
    // sumando al total pero ya no se puede ver ni mover por sucursal. Primero hay que pasarla.
    if (body.data.activa === false) {
      const [ps, vs] = await Promise.all([
        prisma.productoSucursal.count({ where: { sucursalId: req.params.id, stock: { gt: 0 }, sucursal: { tenantId: req.tenantId } } }),
        prisma.varianteSucursal.count({ where: { sucursalId: req.params.id, stock: { gt: 0 }, sucursal: { tenantId: req.tenantId } } }),
      ])
      if (ps + vs > 0) {
        return reply.status(409).send({ error: 'sucursal_con_stock', message: 'Esta sucursal todavía tiene stock cargado. Pasalo a otra sucursal desde Inventario → Transferir antes de desactivarla.' })
      }
    }

    const r = await prisma.sucursal.updateMany({
      where: { id: req.params.id, tenantId: req.tenantId },
      data: body.data,
    })
    if (r.count === 0) return reply.status(404).send({ error: 'not_found', message: 'Sucursal no encontrada.' })
    return prisma.sucursal.findUnique({ where: { id: req.params.id } })
  })

  fastify.patch('/configuracion/sucursales/reactivar-masivo', adminOnly, async (req, reply) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : []
    if (!ids.length) return reply.status(400).send({ error: 'validation_error', message: 'Sin sucursales seleccionadas.' })
    const r = await prisma.sucursal.updateMany({ where: { id: { in: ids }, tenantId: req.tenantId }, data: { activa: true } })
    return { message: r.count + ' sucursal(es) reactivada(s).', actualizadas: r.count }
  })

  // ── Razones sociales (un tenant puede facturar bajo más de un CUIT) ──

  fastify.get('/configuracion/razones-sociales', auth, async (req) => {
    const { activa } = req.query
    return prisma.razonSocial.findMany({
      where: { tenantId: req.tenantId, ...(activa !== undefined ? { activa: activa === 'true' } : { activa: true }) },
      orderBy: [{ esPrincipal: 'desc' }, { nombre: 'asc' }],
    })
  })

  fastify.post('/configuracion/razones-sociales', adminOnly, async (req, reply) => {
    const body = razonSocialSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.errors[0].message })
    body.data.nombre = tituloCase(body.data.nombre)

    const existe = await prisma.razonSocial.findFirst({ where: { tenantId: req.tenantId, cuit: body.data.cuit } })
    if (existe) return reply.status(409).send({ error: 'cuit_taken', message: 'Ya existe una razón social con ese CUIT.' })

    const rs = await prisma.razonSocial.create({ data: { tenantId: req.tenantId, ...body.data } })
    return reply.status(201).send(rs)
  })

  fastify.put('/configuracion/razones-sociales/:id', adminOnly, async (req, reply) => {
    const body = razonSocialSchema.partial().safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.errors[0].message })
    if (body.data.nombre) body.data.nombre = tituloCase(body.data.nombre)

    const r = await prisma.razonSocial.updateMany({
      where: { id: req.params.id, tenantId: req.tenantId },
      data: body.data,
    })
    if (r.count === 0) return reply.status(404).send({ error: 'not_found', message: 'Razón social no encontrada.' })
    return prisma.razonSocial.findUnique({ where: { id: req.params.id } })
  })

  fastify.delete('/configuracion/razones-sociales/:id', adminOnly, async (req, reply) => {
    const r = await prisma.razonSocial.updateMany({
      where: { id: req.params.id, tenantId: req.tenantId },
      data: { activa: false },
    })
    if (r.count === 0) return reply.status(404).send({ error: 'not_found', message: 'Razón social no encontrada.' })
    return reply.send({ message: 'Razón social desactivada.' })
  })

  fastify.patch('/configuracion/razones-sociales/reactivar-masivo', adminOnly, async (req, reply) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : []
    if (!ids.length) return reply.status(400).send({ error: 'validation_error', message: 'Sin razones sociales seleccionadas.' })
    const r = await prisma.razonSocial.updateMany({ where: { id: { in: ids }, tenantId: req.tenantId }, data: { activa: true } })
    return { message: r.count + ' razón(es) social(es) reactivada(s).', actualizadas: r.count }
  })

  // ── Configuraciones clave-valor ───────────────────────────

  fastify.get('/configuracion/kv', adminOnly, async (req) => {
    return prisma.configuracionEmpresa.findMany({ where: { tenantId: req.tenantId } })
  })

  fastify.put('/configuracion/kv/:clave', adminOnly, async (req, reply) => {
    const { valor } = req.body || {}
    if (valor === undefined) return reply.status(400).send({ error: 'validation_error', message: '"valor" requerido.' })

    const item = await prisma.configuracionEmpresa.upsert({
      where: { tenantId_clave: { tenantId: req.tenantId, clave: req.params.clave } },
      update: { valor: String(valor) },
      create: { tenantId: req.tenantId, clave: req.params.clave, valor: String(valor) },
    })
    return item
  })

  // ── Layout de tablas configurables (columnas: visibilidad/orden/ancho/fijadas) ──
  // Un tableKey por tabla (ej. "inventario_productos", "ventas_ovs") — se guarda como JSON
  // en la misma tabla kv genérica, clave "tabla.cols.<tableKey>". El layout es compartido por
  // todo el tenant (no por navegador) y solo lo edita el admin, pero cualquier usuario logueado
  // necesita LEERLO para que su tabla se pinte igual que la del resto — mismo criterio que
  // medios-pago/tema/pos-layout de arriba (GET no admin-gated, PUT sí).
  const TABLA_COLS_KEYS = [
    'inventario_productos', 'ventas_ovs', 'adm_clientes', 'contactos_crm',
    'clientes', 'compras_ocs', 'compras_pvs', 'pos_lista_productos',
  ]
  fastify.get('/configuracion/tabla-cols', auth, async (req) => {
    const rows = await prisma.configuracionEmpresa.findMany({
      where: { tenantId: req.tenantId, clave: { startsWith: 'tabla.cols.' } },
    })
    const out = {}
    for (const r of rows) {
      const tableKey = r.clave.slice('tabla.cols.'.length)
      try { out[tableKey] = JSON.parse(r.valor) } catch (e) { /* ignora fila corrupta */ }
    }
    return out
  })

  fastify.put('/configuracion/tabla-cols/:tableKey', adminOnly, async (req, reply) => {
    const { tableKey } = req.params
    if (!TABLA_COLS_KEYS.includes(tableKey)) {
      return reply.status(400).send({ error: 'validation_error', message: 'Tabla no reconocida.' })
    }
    const { cols, order, widths, pinned } = req.body || {}
    if (!order || !Array.isArray(order)) {
      return reply.status(400).send({ error: 'validation_error', message: '"order" requerido (array).' })
    }
    const valor = JSON.stringify({ cols: cols || {}, order, widths: widths || {}, pinned: (pinned || []).slice(0, 4) })
    await prisma.configuracionEmpresa.upsert({
      where: { tenantId_clave: { tenantId: req.tenantId, clave: 'tabla.cols.' + tableKey } },
      update: { valor },
      create: { tenantId: req.tenantId, clave: 'tabla.cols.' + tableKey, valor },
    })
    return { tableKey, cols: cols || {}, order, widths: widths || {}, pinned: (pinned || []).slice(0, 4) }
  })

  // ── Métodos de pago activos en Caja/PoS ────────────────────
  // Igual criterio que pos-layout: cualquier usuario autenticado necesita LEER esto (el cajero
  // arma el selector de cobro con esta lista), pero solo el admin la edita — así no le "recargan"
  // la caja al cajero con métodos que el negocio no usa. Los 6 medios ya existentes (EFECTIVO...
  // CUENTA_CORRIENTE) quedan activos por default para no romper el comportamiento de tenants ya
  // en producción; los 5 nuevos (Mercado Pago, Cuenta DNI, Posnet Bancos/Billeteras, Modo) arrancan
  // apagados — el tenant los prende a mano si los usa. "custom" son métodos con nombre libre que el
  // tenant agrega; en el ticket se guardan como medioPago=OTRO + medioPagoDetalle=<nombre>.
  const MEDIOS_PAGO_DEFAULT_ACTIVOS = ['EFECTIVO', 'TARJETA_DEBITO', 'TARJETA_CREDITO', 'TRANSFERENCIA', 'QR', 'CUENTA_CORRIENTE']

  fastify.get('/configuracion/medios-pago', auth, async (req) => {
    const [activosRow, customRow] = await Promise.all([
      prisma.configuracionEmpresa.findFirst({ where: { tenantId: req.tenantId, clave: 'caja.mediosPagoActivos' } }),
      prisma.configuracionEmpresa.findFirst({ where: { tenantId: req.tenantId, clave: 'caja.mediosPagoCustom' } }),
    ])
    return {
      activos: activosRow ? JSON.parse(activosRow.valor) : MEDIOS_PAGO_DEFAULT_ACTIVOS,
      custom: customRow ? JSON.parse(customRow.valor) : [],
    }
  })

  fastify.put('/configuracion/medios-pago', adminOnly, async (req, reply) => {
    const activos = Array.isArray(req.body?.activos) ? req.body.activos : null
    const custom = Array.isArray(req.body?.custom) ? req.body.custom.map(String).filter(Boolean) : null
    if (!activos) return reply.status(400).send({ error: 'validation_error', message: '"activos" requerido (array).' })
    await prisma.$transaction([
      prisma.configuracionEmpresa.upsert({
        where: { tenantId_clave: { tenantId: req.tenantId, clave: 'caja.mediosPagoActivos' } },
        update: { valor: JSON.stringify(activos) },
        create: { tenantId: req.tenantId, clave: 'caja.mediosPagoActivos', valor: JSON.stringify(activos) },
      }),
      prisma.configuracionEmpresa.upsert({
        where: { tenantId_clave: { tenantId: req.tenantId, clave: 'caja.mediosPagoCustom' } },
        update: { valor: JSON.stringify(custom || []) },
        create: { tenantId: req.tenantId, clave: 'caja.mediosPagoCustom', valor: JSON.stringify(custom || []) },
      }),
    ])
    return { activos, custom: custom || [] }
  })

  // ── Tema visual del tenant (Configuración > Temas) ─────────
  // Mismo criterio de auth/adminOnly que medios-pago: cualquier usuario logueado necesita LEER
  // esto para que la app se pinte con los colores del tenant apenas loguea, pero solo el admin
  // lo edita. Se guarda como un solo blob JSON (clave 'tema.custom') en vez de una fila por
  // color — son 4 valores como mucho, no vale la pena una tabla dedicada para esto.
  fastify.get('/configuracion/tema', auth, async (req) => {
    const row = await prisma.configuracionEmpresa.findFirst({ where: { tenantId: req.tenantId, clave: 'tema.custom' } })
    return row ? JSON.parse(row.valor) : {}
  })

  fastify.put('/configuracion/tema', adminOnly, async (req, reply) => {
    const permitido = ['headerBg', 'bgDark', 'accent', 'iconColor']
    const valor = {}
    for (const k of permitido) {
      if (typeof req.body?.[k] === 'string' && req.body[k]) valor[k] = req.body[k]
    }
    await prisma.configuracionEmpresa.upsert({
      where: { tenantId_clave: { tenantId: req.tenantId, clave: 'tema.custom' } },
      update: { valor: JSON.stringify(valor) },
      create: { tenantId: req.tenantId, clave: 'tema.custom', valor: JSON.stringify(valor) },
    })
    return valor
  })

  // ── Ancho del panel de caja en el PoS ──────────────────────
  // Cualquier usuario autenticado necesita LEER este valor (todos ven el mismo ancho), pero
  // solo el admin lo puede arrastrar/cambiar — por eso el GET no es adminOnly, a diferencia
  // del resto de la tabla kv genérica de arriba.
  fastify.get('/configuracion/pos-layout', auth, async (req) => {
    const item = await prisma.configuracionEmpresa.findFirst({ where: { tenantId: req.tenantId, clave: 'pos.anchoCaja' } })
    return { anchoCaja: item ? Number(item.valor) : null }
  })

  fastify.put('/configuracion/pos-layout', adminOnly, async (req, reply) => {
    const anchoCaja = Number(req.body?.anchoCaja)
    if (!anchoCaja || anchoCaja < 280 || anchoCaja > 700) {
      return reply.status(400).send({ error: 'validation_error', message: 'Ancho inválido (entre 280 y 700px).' })
    }
    await prisma.configuracionEmpresa.upsert({
      where: { tenantId_clave: { tenantId: req.tenantId, clave: 'pos.anchoCaja' } },
      update: { valor: String(anchoCaja) },
      create: { tenantId: req.tenantId, clave: 'pos.anchoCaja', valor: String(anchoCaja) },
    })
    return { anchoCaja }
  })

  // ── PIN de seguridad para descuentos / eliminar líneas del carrito ────────
  // Un solo PIN compartido por tenant (no uno por cajero) — lo define el admin y lo puede
  // cambiar cuando quiera. Se guarda hasheado en la misma tabla kv, nunca se devuelve el hash.
  fastify.put('/configuracion/pin-descuentos', adminOnly, async (req, reply) => {
    const { pin } = req.body || {}
    if (!pin || String(pin).length < 4) return reply.status(400).send({ error: 'validation_error', message: 'El PIN debe tener al menos 4 caracteres.' })
    const hash = await bcrypt.hash(String(pin), 10)
    await prisma.configuracionEmpresa.upsert({
      where: { tenantId_clave: { tenantId: req.tenantId, clave: 'pos.pinDescuentosHash' } },
      update: { valor: hash },
      create: { tenantId: req.tenantId, clave: 'pos.pinDescuentosHash', valor: hash },
    })
    return { message: 'PIN actualizado.' }
  })

  fastify.post('/configuracion/verificar-pin-descuentos', {
    preHandler: auth.preHandler,
    config: { rateLimit: { max: 15, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const { pin } = req.body || {}
    const row = await prisma.configuracionEmpresa.findUnique({
      where: { tenantId_clave: { tenantId: req.tenantId, clave: 'pos.pinDescuentosHash' } },
    })
    if (!row) return reply.status(400).send({ error: 'no_configurado', message: 'Todavía no se configuró un PIN de seguridad.' })
    const ok = !!pin && await bcrypt.compare(String(pin), row.valor)
    return { ok }
  })

  // ── Nombres de cada nivel de la jerarquía de categorías (ej: Rubro/Marca/Categoría/
  // Subcategoría) — el cliente los renombra a su gusto (ej: Fenólicos y OSB → Marcas → ...).
  // Guardado como JSON en la misma tabla kv, sin migración nueva.
  const CATEGORIAS_NIVELES_DEFAULT = ['Rubro', 'Categoría', 'Subcategoría', 'Sub-subcategoría']
  fastify.get('/configuracion/categorias-niveles', auth, async (req) => {
    const row = await prisma.configuracionEmpresa.findUnique({
      where: { tenantId_clave: { tenantId: req.tenantId, clave: 'categorias.nivelLabels' } },
    })
    let labels = CATEGORIAS_NIVELES_DEFAULT
    if (row) { try { labels = JSON.parse(row.valor) } catch (e) { /* fallback al default */ } }
    return { labels }
  })
  fastify.put('/configuracion/categorias-niveles', adminOnly, async (req, reply) => {
    const labels = Array.isArray(req.body?.labels) ? req.body.labels.map((l) => String(l || '').trim()).slice(0, 4) : null
    if (!labels || labels.length !== 4 || labels.some((l) => !l)) {
      return reply.status(400).send({ error: 'validation_error', message: 'Se necesitan los 4 nombres de nivel.' })
    }
    await prisma.configuracionEmpresa.upsert({
      where: { tenantId_clave: { tenantId: req.tenantId, clave: 'categorias.nivelLabels' } },
      update: { valor: JSON.stringify(labels) },
      create: { tenantId: req.tenantId, clave: 'categorias.nivelLabels', valor: JSON.stringify(labels) },
    })
    return { labels }
  })
}
