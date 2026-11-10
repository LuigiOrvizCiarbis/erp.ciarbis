// ─────────────────────────────────────────────────────────────
//  Rutas: /api/v1/produccion — Módulo Producción (V2.107.0)
//  Transversal: indumentaria (curva de talles, tela por metro), alimentos (kg/litro, merma,
//  lote + vencimiento) y cosmética (shampoo = detergente + extracto + envase + tapa + etiqueta).
//  - Recetas (BOM): insumos por tanda de `rendimiento` unidades, % merma, mano de obra/indirectos.
//  - Orden de trabajo: una o varias salidas (producto o variantes). Flujo:
//      PLANIFICADA → iniciar (SALEN los insumos de la sucursal) → EN_PROCESO ⇄ PAUSADA
//      → completar (ENTRA lo producido, costo real, lote opcional) → COMPLETADA
//      CANCELADA (si ya habían salido los insumos, se pueden devolver).
//  - Etapas por empresa (Corte → Costura → Empaque…) = columnas del tablero, con responsable.
//  - Planificación: insumos que faltan para las OT planificadas, agrupados por proveedor.
//  Campos opcionales: Ajustes > Producción (kv produccion.*) — ver CONFIG_DEFAULT.
//  Todo movimiento de stock pasa por src/lib/stock.js (total + sucursal siempre iguales).
// ─────────────────────────────────────────────────────────────

import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { resolverSucursalStock, moverStock, stockEnSucursal } from '../../lib/stock.js'
import { cotizacionDefault, aPesos, desdePesos } from '../../lib/moneda.js'
import { registrarAuditoria } from '../../lib/auditoria.js'

// Interruptores de Ajustes > Producción. Default pensado para que un negocio chico arranque sin
// configurar nada: lo que agrega pasos (lotes, prioridad, producir sin stock) arranca apagado.
export const CONFIG_DEFAULT = {
  etapas: true,           // tablero por etapas/estaciones
  responsable: true,      // responsable por OT y por etapa
  merma: true,            // % de merma por insumo
  costos: true,           // mano de obra + gastos indirectos en la receta, costo real de la OT
  variantes: true,        // producir por variante (curva de talles/colores)
  fechaEst: true,         // fecha estimada de fin
  prioridad: false,       // prioridad de la OT
  lotes: false,           // nº de lote + vencimiento de lo producido
  permitirSinStock: false, // iniciar aunque falten insumos (el stock queda negativo)
  actualizarCosto: true,  // al completar, el costo del producto pasa a ser el costo real
}
const CONFIG_KEYS = Object.keys(CONFIG_DEFAULT)
const PRIORIDADES = ['BAJA', 'NORMAL', 'ALTA', 'URGENTE']
const DIAS_COMPLETADAS_EN_TABLERO = 15

const num = (v) => Number(v) || 0
const r3 = (n) => Math.round(n * 1000) / 1000
const r2 = (n) => Math.round(n * 100) / 100
const vacioANull = (v) => (v === '' || v === undefined ? null : v)
const fechaANull = (v) => (v ? new Date(v) : null)

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra }
}

const itemSchema = z.object({
  insumoId: z.string().min(1),
  varianteId: z.string().nullable().optional(),
  cantidad: z.number().positive('La cantidad de cada insumo tiene que ser mayor a 0'),
  um: z.string().max(20).optional(),
  merma: z.number().min(0).max(99).optional(),
})
const recetaSchema = z.object({
  productoId: z.string().min(1, 'Elegí el producto que se fabrica'),
  varianteId: z.string().nullable().optional(),
  nombre: z.string().max(120).optional(),
  rendimiento: z.number().positive('El rendimiento tiene que ser mayor a 0').optional(),
  costoManoObra: z.number().min(0).optional(),
  costoIndirecto: z.number().min(0).optional(),
  etapas: z.array(z.string()).max(30).optional(),
  notas: z.string().max(4000).optional(),
  items: z.array(itemSchema).min(1, 'La receta necesita al menos un insumo').max(200),
})
const salidaSchema = z.object({ varianteId: z.string().nullable().optional(), cantidad: z.number().positive() })
const lineaSchema = z.object({
  productoId: z.string().min(1),
  varianteId: z.string().nullable().optional(),
  um: z.string().max(20).optional(),
  cantidad: z.number().positive(),
})
const otSchema = z.object({
  bomId: z.string().min(1, 'Elegí una receta'),
  salidas: z.array(salidaSchema).min(1, 'Indicá cuánto se va a producir').max(200),
  lineas: z.array(lineaSchema).max(300).optional(), // insumos editados a mano (si no, salen de la receta)
  sucursalId: z.string().nullable().optional(),
  fechaInicio: z.string().nullable().optional(),
  fechaFinEst: z.string().nullable().optional(),
  prioridad: z.enum(PRIORIDADES).optional(),
  responsableId: z.string().nullable().optional(),
  observaciones: z.string().max(4000).optional(),
})
const completarSchema = z.object({
  salidas: z.array(z.object({ id: z.string(), cantProd: z.number().min(0) })).optional(),
  consumos: z.array(z.object({ id: z.string(), cantReal: z.number().min(0) })).optional(),
  loteNro: z.string().max(60).optional(),
  fechaVenc: z.string().nullable().optional(),
  actualizarCosto: z.boolean().optional(),
  forzar: z.boolean().optional(),
})

export default async function produccionRoutes(fastify) {
  const moduloActivo = async (req, reply) => {
    if (!(req.tenantModulos || []).includes('produccion')) {
      return reply.status(403).send({ error: 'modulo_inactivo', message: 'El módulo Producción no está activo para tu empresa.' })
    }
  }
  const auth = { preHandler: [fastify.verifyJWT, fastify.verifyTenant, moduloActivo] }
  const admin = { preHandler: [fastify.verifyJWT, fastify.verifyTenant, moduloActivo, fastify.requireRole(['ADMIN'])] }

  // Envuelve un handler: HttpError → respuesta prolija; el resto sube como 500.
  const h = (fn) => async (req, reply) => {
    try { return await fn(req, reply) } catch (e) {
      if (e instanceof HttpError) return reply.status(e.status).send({ error: 'produccion', message: e.message, ...(e.extra || {}) })
      throw e
    }
  }

  async function leerConfig(tenantId) {
    const filas = await prisma.configuracionEmpresa.findMany({ where: { tenantId, clave: { startsWith: 'produccion.' } } })
    const c = { ...CONFIG_DEFAULT }
    filas.forEach((f) => {
      const k = f.clave.slice('produccion.'.length)
      if (CONFIG_KEYS.includes(k)) c[k] = f.valor === 'true'
    })
    return c
  }

  async function nombreUsuario(tenantId, userId) {
    if (!userId) return null
    const u = await prisma.user.findFirst({ where: { id: userId, tenantId }, select: { nombre: true } })
    if (!u) throw new HttpError(400, 'El responsable elegido no existe.')
    return u.nombre
  }

  // Productos + variantes por id, para armar nombres/um/costos sin N consultas.
  async function mapaProductos(tenantId, productoIds, varianteIds = []) {
    const [prods, vars] = await Promise.all([
      productoIds.length ? prisma.producto.findMany({
        where: { tenantId, id: { in: [...new Set(productoIds)] } },
        select: { id: true, nombre: true, sku: true, um: true, precioCosto: true, moneda: true, stock: true, proveedorId: true, activo: true, proveedor: { select: { id: true, nombre: true } } },
      }) : [],
      varianteIds.filter(Boolean).length ? prisma.productoVariante.findMany({
        where: { tenantId, id: { in: [...new Set(varianteIds.filter(Boolean))] } },
        select: { id: true, productoId: true, sku: true, valores: true, precioCosto: true, stock: true },
      }) : [],
    ])
    return { p: new Map(prods.map((x) => [x.id, x])), v: new Map(vars.map((x) => [x.id, x])) }
  }
  const varianteTxt = (v) => (v ? Object.values(v.valores || {}).filter(Boolean).join(' / ') || v.sku : null)

  // Costo unitario en pesos de un insumo (variante con costo propio → ese; si no, el del producto).
  function costoPesos(prod, vari, cot) {
    if (!prod) return 0
    const base = vari && vari.precioCosto != null ? vari.precioCosto : prod.precioCosto
    return num(aPesos(base, prod.moneda, cot))
  }

  // Mueve stock de un producto o variante (la variante arrastra también al producto padre, igual
  // que la venta y la merma) y deja el MovimientoStock de auditoría.
  async function mover(tx, req, { productoId, varianteId, sucursalId, delta, tipo, ot, referencia }) {
    if (!delta) return
    let m
    if (varianteId) {
      await moverStock(tx, { productoId, varianteId, sucursalId, delta })
      m = await moverStock(tx, { productoId, sucursalId, delta })
    } else {
      m = await moverStock(tx, { productoId, sucursalId, delta })
    }
    await tx.movimientoStock.create({
      data: {
        tenantId: req.tenantId, productoId, usuarioId: req.user.id, tipo, cantidad: delta,
        stockPost: m.total ?? 0, sucursalId, ordenTrabajoId: ot.id,
        referencia: referencia || `Producción OT #${ot.nro}`,
      },
    })
  }

  async function recetaDelTenant(tenantId, id) {
    const r = await prisma.bOM.findFirst({ where: { id, tenantId, activa: true }, include: { items: { orderBy: { orden: 'asc' } } } })
    if (!r) throw new HttpError(404, 'Receta no encontrada.')
    return r
  }
  async function otDelTenant(tenantId, id, include) {
    const o = await prisma.ordenTrabajo.findFirst({ where: { id, tenantId, activo: true }, include })
    if (!o) throw new HttpError(404, 'Orden de trabajo no encontrada.')
    return o
  }

  // Receta con nombres y costo estimado por tanda y por unidad (en pesos).
  async function recetaDetalle(tenantId, recetas) {
    const pIds = []; const vIds = []
    recetas.forEach((r) => { pIds.push(r.productoId); vIds.push(r.varianteId); r.items.forEach((i) => { pIds.push(i.insumoId); vIds.push(i.varianteId) }) })
    const mp = await mapaProductos(tenantId, pIds, vIds)
    const cot = await cotizacionDefault(tenantId)
    return recetas.map((r) => {
      const prod = mp.p.get(r.productoId)
      const items = r.items.map((i) => {
        const ip = mp.p.get(i.insumoId); const iv = i.varianteId ? mp.v.get(i.varianteId) : null
        const cu = costoPesos(ip, iv, cot)
        const cantConMerma = num(i.cantidad) * (1 + num(i.merma) / 100)
        return {
          ...i, insumoNombre: ip?.nombre || '(producto borrado)', insumoSku: ip?.sku, varianteTxt: varianteTxt(iv),
          costoUnit: cu, costo: r2(cu * cantConMerma), stock: num(iv ? iv.stock : ip?.stock),
        }
      })
      const costoInsumos = r2(items.reduce((s, i) => s + i.costo, 0))
      const costoTanda = r2(costoInsumos + num(r.costoManoObra) + num(r.costoIndirecto))
      return {
        ...r, productoNombre: prod?.nombre || '(producto borrado)', productoSku: prod?.sku, productoUm: prod?.um,
        varianteTxt: varianteTxt(r.varianteId ? mp.v.get(r.varianteId) : null),
        items, costoInsumos, costoTanda, costoUnitario: r2(costoTanda / (num(r.rendimiento) || 1)),
      }
    })
  }

  // Insumos de una OT a partir de su(s) receta(s): por cada salida busca la receta propia de esa
  // variante (si existe) o usa la elegida; cantidad = insumo × (salida / rendimiento) × (1 + merma).
  async function calcularLineas(tenantId, receta, salidas, usarMerma) {
    const variantesConReceta = salidas.some((s) => s.varianteId)
      ? await prisma.bOM.findMany({
        where: { tenantId, productoId: receta.productoId, activa: true, varianteId: { in: salidas.map((s) => s.varianteId).filter(Boolean) } },
        include: { items: true }, orderBy: { creadoEn: 'desc' },
      })
      : []
    const acc = new Map()
    let tandas = 0
    for (const s of salidas) {
      const r = (s.varianteId && variantesConReceta.find((x) => x.varianteId === s.varianteId)) || receta
      const factor = num(s.cantidad) / (num(r.rendimiento) || 1)
      tandas += factor
      for (const i of r.items) {
        const k = i.insumoId + '|' + (i.varianteId || '')
        const cant = num(i.cantidad) * factor * (usarMerma ? 1 + num(i.merma) / 100 : 1)
        const prev = acc.get(k)
        acc.set(k, { productoId: i.insumoId, varianteId: i.varianteId || null, um: i.um, cantidad: (prev?.cantidad || 0) + cant })
      }
    }
    return { lineas: [...acc.values()].map((l) => ({ ...l, cantidad: r3(l.cantidad) })), tandas }
  }

  // Disponibilidad de los insumos de una OT en su sucursal.
  async function faltantesDe(lineas, sucursalId) {
    const out = []
    for (const l of lineas) {
      const necesita = num(l.cantPlanif ?? l.cantidad)
      const hay = await stockEnSucursal(prisma, { productoId: l.productoId, varianteId: l.varianteId, sucursalId })
      if (hay < necesita) out.push({ productoId: l.productoId, varianteId: l.varianteId, necesita: r3(necesita), hay: r3(hay), falta: r3(necesita - hay) })
    }
    return out
  }

  // ═════════ Configuración ═════════
  fastify.get('/produccion/config', auth, async (req) => leerConfig(req.tenantId))
  fastify.put('/produccion/config', admin, async (req) => {
    const body = req.body || {}
    const cambios = CONFIG_KEYS.filter((k) => typeof body[k] === 'boolean')
    await prisma.$transaction(cambios.map((k) => prisma.configuracionEmpresa.upsert({
      where: { tenantId_clave: { tenantId: req.tenantId, clave: 'produccion.' + k } },
      update: { valor: String(body[k]) },
      create: { tenantId: req.tenantId, clave: 'produccion.' + k, valor: String(body[k]) },
    })))
    return leerConfig(req.tenantId)
  })

  // Usuarios activos para elegir responsable (cualquier rol con acceso a Producción).
  fastify.get('/produccion/responsables', auth, async (req) => {
    return prisma.user.findMany({ where: { tenantId: req.tenantId, activo: true }, select: { id: true, nombre: true, rol: true }, orderBy: { nombre: 'asc' } })
  })

  // ═════════ Etapas ═════════
  fastify.get('/produccion/etapas', auth, async (req) => {
    return prisma.etapaProduccion.findMany({ where: { tenantId: req.tenantId, activa: true }, orderBy: [{ orden: 'asc' }, { creadoEn: 'asc' }] })
  })
  // Reemplaza la lista completa (alta/baja/renombrar/reordenar en un solo guardado). Las que no
  // vienen se dan de baja (activa=false): las OT viejas conservan el nombre en su recorrido.
  fastify.put('/produccion/etapas', admin, h(async (req) => {
    const body = z.array(z.object({
      id: z.string().optional(), nombre: z.string().trim().min(1, 'Cada etapa necesita un nombre').max(40), color: z.string().max(20).optional(),
    })).max(20, 'Máximo 20 etapas').safeParse(req.body?.etapas)
    if (!body.success) throw new HttpError(400, body.error.errors[0].message)
    const actuales = await prisma.etapaProduccion.findMany({ where: { tenantId: req.tenantId, activa: true } })
    const idsActuales = new Set(actuales.map((e) => e.id))
    await prisma.$transaction(async (tx) => {
      const quedan = new Set()
      for (const [i, e] of body.data.entries()) {
        if (e.id && idsActuales.has(e.id)) {
          quedan.add(e.id)
          await tx.etapaProduccion.update({ where: { id: e.id }, data: { nombre: e.nombre, color: e.color || '#1E40FF', orden: i } })
        } else {
          await tx.etapaProduccion.create({ data: { tenantId: req.tenantId, nombre: e.nombre, color: e.color || '#1E40FF', orden: i } })
        }
      }
      const bajas = actuales.filter((e) => !quedan.has(e.id)).map((e) => e.id)
      if (bajas.length) await tx.etapaProduccion.updateMany({ where: { id: { in: bajas } }, data: { activa: false } })
    })
    return prisma.etapaProduccion.findMany({ where: { tenantId: req.tenantId, activa: true }, orderBy: { orden: 'asc' } })
  }))

  // ═════════ Recetas ═════════
  fastify.get('/produccion/recetas', auth, async (req) => {
    const { q, productoId } = req.query
    const recetas = await prisma.bOM.findMany({
      where: { tenantId: req.tenantId, activa: true, ...(productoId && { productoId }) },
      include: { items: { orderBy: { orden: 'asc' } } },
      orderBy: { creadoEn: 'desc' },
    })
    let data = await recetaDetalle(req.tenantId, recetas)
    if (q) {
      const t = String(q).toLowerCase()
      data = data.filter((r) => [r.nombre, r.productoNombre, r.productoSku].some((x) => x && String(x).toLowerCase().includes(t)))
    }
    return data
  })
  fastify.get('/produccion/recetas/:id', auth, h(async (req) => {
    const r = await recetaDelTenant(req.tenantId, req.params.id)
    return (await recetaDetalle(req.tenantId, [r]))[0]
  }))

  async function validarReceta(req, d) {
    const ids = [d.productoId, ...d.items.map((i) => i.insumoId)]
    const vIds = [d.varianteId, ...d.items.map((i) => i.varianteId)].filter(Boolean)
    const mp = await mapaProductos(req.tenantId, ids, vIds)
    if (!mp.p.get(d.productoId)) throw new HttpError(400, 'El producto a fabricar no existe.')
    for (const i of d.items) {
      if (!mp.p.get(i.insumoId)) throw new HttpError(400, 'Uno de los insumos no existe.')
      if (i.insumoId === d.productoId) throw new HttpError(400, 'Un producto no puede ser insumo de su propia receta.')
    }
    for (const vid of vIds) {
      const v = mp.v.get(vid)
      if (!v) throw new HttpError(400, 'Una de las variantes elegidas no existe.')
    }
    if (d.varianteId && mp.v.get(d.varianteId).productoId !== d.productoId) throw new HttpError(400, 'La variante no es de ese producto.')
    return mp
  }
  const recetaData = (d, mp) => ({
    productoId: d.productoId,
    varianteId: vacioANull(d.varianteId),
    nombre: vacioANull(d.nombre?.trim()),
    rendimiento: d.rendimiento ?? 1,
    costoManoObra: d.costoManoObra ?? 0,
    costoIndirecto: d.costoIndirecto ?? 0,
    etapas: d.etapas || [],
    notas: vacioANull(d.notas),
  })
  const itemsData = (d, mp) => d.items.map((i, idx) => ({
    insumoId: i.insumoId, varianteId: vacioANull(i.varianteId), cantidad: i.cantidad,
    um: i.um || mp.p.get(i.insumoId)?.um || 'unidad', merma: i.merma ?? 0, orden: idx,
  }))

  fastify.post('/produccion/recetas', auth, h(async (req, reply) => {
    const body = recetaSchema.safeParse(req.body)
    if (!body.success) throw new HttpError(400, body.error.errors[0].message)
    const mp = await validarReceta(req, body.data)
    const r = await prisma.bOM.create({
      data: { tenantId: req.tenantId, ...recetaData(body.data, mp), version: String(Date.now()), items: { create: itemsData(body.data, mp) } },
      include: { items: { orderBy: { orden: 'asc' } } },
    })
    registrarAuditoria({ tenantId: req.tenantId, userId: req.user.id, accion: 'produccion.receta.crear', entidad: 'BOM', entidadId: r.id, detalle: { productoId: r.productoId }, req })
    return reply.status(201).send((await recetaDetalle(req.tenantId, [r]))[0])
  }))
  // Editar reemplaza los insumos. Las OT ya creadas no cambian (guardan sus propias líneas).
  fastify.put('/produccion/recetas/:id', auth, h(async (req) => {
    await recetaDelTenant(req.tenantId, req.params.id)
    const body = recetaSchema.safeParse(req.body)
    if (!body.success) throw new HttpError(400, body.error.errors[0].message)
    const mp = await validarReceta(req, body.data)
    const r = await prisma.$transaction(async (tx) => {
      await tx.bOMItem.deleteMany({ where: { bomId: req.params.id } })
      return tx.bOM.update({
        where: { id: req.params.id },
        data: { ...recetaData(body.data, mp), items: { create: itemsData(body.data, mp) } },
        include: { items: { orderBy: { orden: 'asc' } } },
      })
    })
    return (await recetaDetalle(req.tenantId, [r]))[0]
  }))
  fastify.post('/produccion/recetas/:id/duplicar', auth, h(async (req, reply) => {
    const o = await recetaDelTenant(req.tenantId, req.params.id)
    const r = await prisma.bOM.create({
      data: {
        tenantId: req.tenantId, productoId: o.productoId, varianteId: o.varianteId, nombre: (o.nombre || 'Receta') + ' (copia)',
        version: String(Date.now()), rendimiento: o.rendimiento, costoManoObra: o.costoManoObra, costoIndirecto: o.costoIndirecto,
        etapas: o.etapas, notas: o.notas,
        items: { create: o.items.map((i) => ({ insumoId: i.insumoId, varianteId: i.varianteId, cantidad: i.cantidad, um: i.um, merma: i.merma, orden: i.orden })) },
      },
      include: { items: true },
    })
    return reply.status(201).send((await recetaDetalle(req.tenantId, [r]))[0])
  }))
  fastify.delete('/produccion/recetas/:id', auth, h(async (req) => {
    await recetaDelTenant(req.tenantId, req.params.id)
    await prisma.bOM.update({ where: { id: req.params.id }, data: { activa: false } })
    return { ok: true }
  }))

  // Vista previa de insumos/costo para "Nueva OT" antes de guardarla (no escribe nada).
  fastify.post('/produccion/recetas/:id/calcular', auth, h(async (req) => {
    const receta = await recetaDelTenant(req.tenantId, req.params.id)
    const salidas = z.array(salidaSchema).min(1).safeParse(req.body?.salidas)
    if (!salidas.success) throw new HttpError(400, 'Indicá cuánto se va a producir.')
    const cfg = await leerConfig(req.tenantId)
    const sucursalId = await resolverSucursalStock(prisma, req.tenantId, req.body?.sucursalId, req.user)
    const { lineas, tandas } = await calcularLineas(req.tenantId, receta, salidas.data, cfg.merma)
    const mp = await mapaProductos(req.tenantId, lineas.map((l) => l.productoId), lineas.map((l) => l.varianteId))
    const cot = await cotizacionDefault(req.tenantId)
    const out = []
    for (const l of lineas) {
      const p = mp.p.get(l.productoId); const v = l.varianteId ? mp.v.get(l.varianteId) : null
      const hay = await stockEnSucursal(prisma, { productoId: l.productoId, varianteId: l.varianteId, sucursalId })
      const cu = costoPesos(p, v, cot)
      out.push({ ...l, nombre: p?.nombre, sku: p?.sku, varianteTxt: varianteTxt(v), stock: r3(hay), falta: r3(Math.max(0, l.cantidad - hay)), costoUnit: cu, costo: r2(cu * l.cantidad) })
    }
    const costoInsumos = r2(out.reduce((s, l) => s + l.costo, 0))
    const costoExtra = cfg.costos ? r2((num(receta.costoManoObra) + num(receta.costoIndirecto)) * tandas) : 0
    const unidades = salidas.data.reduce((s, x) => s + x.cantidad, 0)
    return { lineas: out, costoInsumos, costoExtra, costoTotal: r2(costoInsumos + costoExtra), costoUnitario: unidades ? r2((costoInsumos + costoExtra) / unidades) : 0, faltan: out.filter((l) => l.falta > 0).length }
  }))

  // ═════════ Órdenes de trabajo ═════════
  async function otEnriquecida(tenantId, ots) {
    const pIds = []; const vIds = []
    ots.forEach((o) => {
      if (o.productoId) pIds.push(o.productoId)
      ;(o.salidas || []).forEach((s) => { pIds.push(s.productoId); vIds.push(s.varianteId) })
      ;(o.lineas || []).forEach((l) => { pIds.push(l.productoId); vIds.push(l.varianteId) })
    })
    const mp = await mapaProductos(tenantId, pIds, vIds)
    return ots.map((o) => ({
      ...o,
      productoNombre: mp.p.get(o.productoId)?.nombre || '—',
      productoUm: mp.p.get(o.productoId)?.um || 'unidad',
      salidas: (o.salidas || []).map((s) => ({ ...s, varianteTxt: varianteTxt(mp.v.get(s.varianteId)) })),
      ...(o.lineas && {
        lineas: o.lineas.map((l) => ({ ...l, nombre: mp.p.get(l.productoId)?.nombre || '—', sku: mp.p.get(l.productoId)?.sku, varianteTxt: varianteTxt(mp.v.get(l.varianteId)) })),
      }),
    }))
  }

  fastify.get('/produccion/ordenes', auth, async (req) => {
    const { estado, q, tablero, page = 1, limit = 50 } = req.query
    const lim = Math.min(Number(limit) || 50, 500)
    const and = []
    if (tablero) {
      const desde = new Date(Date.now() - DIAS_COMPLETADAS_EN_TABLERO * 86400000)
      and.push({ estado: { not: 'CANCELADA' } })
      and.push({ OR: [{ estado: { not: 'COMPLETADA' } }, { fechaFin: { gte: desde } }] })
    }
    if (q) {
      const txt = String(q).trim()
      const n = Number(txt.replace(/^#?(OT)?-?0*/i, ''))
      const prods = await prisma.producto.findMany({ where: { tenantId: req.tenantId, OR: [{ nombre: { contains: txt, mode: 'insensitive' } }, { sku: { contains: txt, mode: 'insensitive' } }] }, select: { id: true }, take: 200 })
      and.push({ OR: [
        ...(Number.isInteger(n) && n > 0 ? [{ nro: n }] : []),
        { productoId: { in: prods.map((p) => p.id) } },
        { loteNro: { contains: txt, mode: 'insensitive' } },
        { responsableNombre: { contains: txt, mode: 'insensitive' } },
      ] })
    }
    const where = { tenantId: req.tenantId, activo: true, ...(estado && { estado }), ...(and.length && { AND: and }) }
    const [data, total] = await Promise.all([
      prisma.ordenTrabajo.findMany({
        where, orderBy: { nro: 'desc' }, skip: (Number(page) - 1) * lim, take: lim,
        include: { salidas: true, etapas: { orderBy: { posicion: 'asc' } } },
      }),
      prisma.ordenTrabajo.count({ where }),
    ])
    return { data: await otEnriquecida(req.tenantId, data), total, page: Number(page), limit: lim }
  })

  fastify.get('/produccion/kpis', auth, async (req) => {
    const t = req.tenantId
    const inicioMes = new Date(); inicioMes.setDate(1); inicioMes.setHours(0, 0, 0, 0)
    const [planificadas, enProceso, pausadas, demoradas, completadasMes, recetas] = await Promise.all([
      prisma.ordenTrabajo.count({ where: { tenantId: t, activo: true, estado: 'PLANIFICADA' } }),
      prisma.ordenTrabajo.count({ where: { tenantId: t, activo: true, estado: 'EN_PROCESO' } }),
      prisma.ordenTrabajo.count({ where: { tenantId: t, activo: true, estado: 'PAUSADA' } }),
      prisma.ordenTrabajo.count({ where: { tenantId: t, activo: true, estado: { in: ['PLANIFICADA', 'EN_PROCESO', 'PAUSADA'] }, fechaFinEst: { lt: new Date() } } }),
      prisma.ordenTrabajo.aggregate({ where: { tenantId: t, activo: true, estado: 'COMPLETADA', fechaFin: { gte: inicioMes } }, _count: true, _sum: { cantProd: true, costoTotal: true } }),
      prisma.bOM.count({ where: { tenantId: t, activa: true } }),
    ])
    return {
      planificadas, enProceso, pausadas, demoradas, recetas,
      completadasMes: completadasMes._count, unidadesMes: num(completadasMes._sum.cantProd), costoMes: num(completadasMes._sum.costoTotal),
    }
  })

  fastify.get('/produccion/ordenes/:id', auth, h(async (req) => {
    const o = await otDelTenant(req.tenantId, req.params.id, { salidas: true, lineas: true, etapas: { orderBy: { posicion: 'asc' } }, bom: { select: { id: true, nombre: true, rendimiento: true, notas: true, costoManoObra: true, costoIndirecto: true } } })
    const [enr] = await otEnriquecida(req.tenantId, [o])
    const movimientos = await prisma.movimientoStock.findMany({
      where: { tenantId: req.tenantId, ordenTrabajoId: o.id }, orderBy: { fecha: 'asc' },
      select: { id: true, productoId: true, tipo: true, cantidad: true, fecha: true, referencia: true, usuario: { select: { nombre: true } } },
    })
    // Disponibilidad actual (solo útil mientras no se descontaron los insumos).
    const faltantes = o.insumosDescontados ? [] : await faltantesDe(o.lineas, o.sucursalId)
    return { ...enr, movimientos, faltantes }
  }))

  async function prepararOT(req, d, cfg) {
    const receta = await recetaDelTenant(req.tenantId, d.bomId)
    // Variantes de salida: tienen que ser del producto de la receta.
    const vIds = d.salidas.map((s) => s.varianteId).filter(Boolean)
    if (vIds.length) {
      const n = await prisma.productoVariante.count({ where: { tenantId: req.tenantId, productoId: receta.productoId, id: { in: vIds } } })
      if (n !== new Set(vIds).size) throw new HttpError(400, 'Alguna variante no corresponde al producto de la receta.')
    }
    let lineas
    let tandas
    if (d.lineas && d.lineas.length) {
      lineas = d.lineas.map((l) => ({ productoId: l.productoId, varianteId: vacioANull(l.varianteId), um: l.um || 'unidad', cantidad: r3(l.cantidad) }))
      const ok = await prisma.producto.count({ where: { tenantId: req.tenantId, id: { in: [...new Set(lineas.map((l) => l.productoId))] } } })
      if (ok !== new Set(lineas.map((l) => l.productoId)).size) throw new HttpError(400, 'Uno de los insumos no existe.')
      tandas = d.salidas.reduce((s, x) => s + x.cantidad, 0) / (num(receta.rendimiento) || 1)
    } else {
      ({ lineas, tandas } = await calcularLineas(req.tenantId, receta, d.salidas, cfg.merma))
    }
    return { receta, lineas, tandas }
  }

  fastify.post('/produccion/ordenes', auth, h(async (req, reply) => {
    const body = otSchema.safeParse(req.body)
    if (!body.success) throw new HttpError(400, body.error.errors[0].message)
    const d = body.data
    const cfg = await leerConfig(req.tenantId)
    const { receta, lineas } = await prepararOT(req, d, cfg)
    const sucursalId = await resolverSucursalStock(prisma, req.tenantId, d.sucursalId, req.user)
    const responsableNombre = await nombreUsuario(req.tenantId, d.responsableId)
    // Recorrido: etapas de la receta (en su orden) o todas las activas de la empresa.
    let etapas = []
    if (cfg.etapas) {
      const todas = await prisma.etapaProduccion.findMany({ where: { tenantId: req.tenantId, activa: true }, orderBy: { orden: 'asc' } })
      etapas = receta.etapas?.length ? receta.etapas.map((id) => todas.find((e) => e.id === id)).filter(Boolean) : todas
    }
    const cantPlanif = r3(d.salidas.reduce((s, x) => s + x.cantidad, 0))
    const ot = await prisma.$transaction(async (tx) => {
      const t = await tx.tenant.update({ where: { id: req.tenantId }, data: { seqOT: { increment: 1 } }, select: { seqOT: true } })
      return tx.ordenTrabajo.create({
        data: {
          tenantId: req.tenantId, nro: t.seqOT, bomId: receta.id, productoId: receta.productoId, sucursalId,
          cantPlanif, fechaInicio: fechaANull(d.fechaInicio), fechaFinEst: fechaANull(d.fechaFinEst),
          prioridad: d.prioridad || 'NORMAL', responsableId: vacioANull(d.responsableId), responsableNombre,
          observaciones: vacioANull(d.observaciones), creadoPorId: req.user.id, creadoPorNombre: req.user.nombre || null,
          salidas: { create: d.salidas.map((s) => ({ productoId: receta.productoId, varianteId: vacioANull(s.varianteId), cantPlanif: s.cantidad })) },
          lineas: { create: lineas.map((l) => ({ productoId: l.productoId, varianteId: l.varianteId, um: l.um, cantPlanif: l.cantidad })) },
          etapas: { create: etapas.map((e, i) => ({ etapaId: e.id, nombre: e.nombre, posicion: i })) },
        },
        include: { salidas: true, lineas: true, etapas: true },
      })
    })
    registrarAuditoria({ tenantId: req.tenantId, userId: req.user.id, accion: 'produccion.ot.crear', entidad: 'OrdenTrabajo', entidadId: ot.id, detalle: { nro: ot.nro, cantPlanif }, req })
    return reply.status(201).send((await otEnriquecida(req.tenantId, [ot]))[0])
  }))

  // Editar: datos generales siempre; salidas/insumos solo mientras está PLANIFICADA.
  fastify.put('/produccion/ordenes/:id', auth, h(async (req) => {
    const o = await otDelTenant(req.tenantId, req.params.id)
    if (['COMPLETADA', 'CANCELADA'].includes(o.estado)) throw new HttpError(409, 'La orden ya está cerrada.')
    const b = req.body || {}
    const data = {}
    if (b.fechaFinEst !== undefined) data.fechaFinEst = fechaANull(b.fechaFinEst)
    if (b.fechaInicio !== undefined) data.fechaInicio = fechaANull(b.fechaInicio)
    if (b.prioridad !== undefined && PRIORIDADES.includes(b.prioridad)) data.prioridad = b.prioridad
    if (b.observaciones !== undefined) data.observaciones = vacioANull(b.observaciones)
    if (b.responsableId !== undefined) { data.responsableId = vacioANull(b.responsableId); data.responsableNombre = await nombreUsuario(req.tenantId, data.responsableId) }
    if (b.salidas || b.lineas) {
      if (o.estado !== 'PLANIFICADA') throw new HttpError(409, 'Las cantidades e insumos solo se cambian antes de iniciar la orden.')
      const body = otSchema.safeParse({ ...b, bomId: o.bomId, salidas: b.salidas || [] })
      if (!body.success) throw new HttpError(400, body.error.errors[0].message)
      const cfg = await leerConfig(req.tenantId)
      const { lineas } = await prepararOT(req, body.data, cfg)
      if (b.sucursalId !== undefined) data.sucursalId = await resolverSucursalStock(prisma, req.tenantId, b.sucursalId, req.user)
      await prisma.$transaction([
        prisma.ordenTrabajoSalida.deleteMany({ where: { ordenId: o.id } }),
        prisma.lineaOrdenTrabajo.deleteMany({ where: { ordenId: o.id } }),
        prisma.ordenTrabajo.update({
          where: { id: o.id },
          data: {
            ...data, cantPlanif: r3(body.data.salidas.reduce((s, x) => s + x.cantidad, 0)),
            salidas: { create: body.data.salidas.map((s) => ({ productoId: o.productoId, varianteId: vacioANull(s.varianteId), cantPlanif: s.cantidad })) },
            lineas: { create: lineas.map((l) => ({ productoId: l.productoId, varianteId: l.varianteId, um: l.um, cantPlanif: l.cantidad })) },
          },
        }),
      ])
    } else if (Object.keys(data).length) {
      await prisma.ordenTrabajo.update({ where: { id: o.id }, data })
    }
    return { ok: true }
  }))

  // Descuenta los insumos (dentro de una transacción ya abierta). Valida stock salvo permiso.
  async function descontarInsumos(tx, req, o, cfg, forzar) {
    if (!cfg.permitirSinStock && !forzar) {
      const faltan = await faltantesDe(o.lineas, o.sucursalId)
      if (faltan.length) {
        const mp = await mapaProductos(req.tenantId, faltan.map((f) => f.productoId), faltan.map((f) => f.varianteId))
        throw new HttpError(409, 'No alcanzan los insumos para iniciar la orden.', {
          code: 'sin_stock',
          faltantes: faltan.map((f) => ({ ...f, nombre: mp.p.get(f.productoId)?.nombre, varianteTxt: varianteTxt(mp.v.get(f.varianteId)) })),
        })
      }
    }
    const mp = await mapaProductos(req.tenantId, o.lineas.map((l) => l.productoId), o.lineas.map((l) => l.varianteId))
    const cot = await cotizacionDefault(req.tenantId)
    for (const l of o.lineas) {
      const cant = num(l.cantPlanif)
      await mover(tx, req, { productoId: l.productoId, varianteId: l.varianteId, sucursalId: o.sucursalId, delta: -cant, tipo: 'SALIDA_PRODUCCION', ot: o, referencia: `Insumo OT #${o.nro}` })
      await tx.lineaOrdenTrabajo.update({ where: { id: l.id }, data: { cantConsumida: cant, costoUnit: costoPesos(mp.p.get(l.productoId), mp.v.get(l.varianteId), cot) } })
    }
  }

  fastify.post('/produccion/ordenes/:id/iniciar', auth, h(async (req) => {
    const o = await otDelTenant(req.tenantId, req.params.id, { lineas: true, etapas: { orderBy: { posicion: 'asc' } } })
    if (o.estado !== 'PLANIFICADA') throw new HttpError(409, 'Solo se puede iniciar una orden planificada.')
    const cfg = await leerConfig(req.tenantId)
    const forzar = req.body?.forzar === true && req.user.rol === 'ADMIN'
    const etapaId = req.body?.etapaId
    await prisma.$transaction(async (tx) => {
      await descontarInsumos(tx, req, o, cfg, forzar)
      const primera = (etapaId && o.etapas.find((e) => e.etapaId === etapaId)) || o.etapas[0]
      if (primera) {
        await tx.ordenTrabajoEtapa.updateMany({ where: { ordenId: o.id, posicion: { lt: primera.posicion } }, data: { estado: 'HECHA', fin: new Date() } })
        await tx.ordenTrabajoEtapa.update({ where: { id: primera.id }, data: { estado: 'EN_CURSO', inicio: new Date() } })
      }
      await tx.ordenTrabajo.update({
        where: { id: o.id },
        data: { estado: 'EN_PROCESO', insumosDescontados: true, fechaInicio: o.fechaInicio || new Date(), etapaId: primera?.etapaId || null },
      })
    }, { timeout: 30000 })
    registrarAuditoria({ tenantId: req.tenantId, userId: req.user.id, accion: 'produccion.ot.iniciar', entidad: 'OrdenTrabajo', entidadId: o.id, detalle: { nro: o.nro, forzar }, req })
    return { ok: true }
  }))

  fastify.patch('/produccion/ordenes/:id/estado', auth, h(async (req) => {
    const o = await otDelTenant(req.tenantId, req.params.id)
    const estado = req.body?.estado
    const ok = (o.estado === 'EN_PROCESO' && estado === 'PAUSADA') || (o.estado === 'PAUSADA' && estado === 'EN_PROCESO')
    if (!ok) throw new HttpError(409, 'Cambio de estado no permitido. Para iniciar, completar o cancelar usá sus botones.')
    await prisma.ordenTrabajo.update({ where: { id: o.id }, data: { estado } })
    return { ok: true }
  }))

  // Mover la OT a otra etapa del tablero: las anteriores quedan hechas, la elegida en curso.
  fastify.patch('/produccion/ordenes/:id/etapa', auth, h(async (req) => {
    const o = await otDelTenant(req.tenantId, req.params.id, { etapas: { orderBy: { posicion: 'asc' } } })
    if (!['EN_PROCESO', 'PAUSADA'].includes(o.estado)) throw new HttpError(409, 'La orden tiene que estar en proceso para moverla de etapa.')
    const destino = o.etapas.find((e) => e.etapaId === req.body?.etapaId)
    if (!destino) throw new HttpError(400, 'Esa etapa no forma parte del recorrido de esta orden.')
    const ahora = new Date()
    await prisma.$transaction([
      prisma.ordenTrabajoEtapa.updateMany({ where: { ordenId: o.id, posicion: { lt: destino.posicion }, estado: { not: 'HECHA' } }, data: { estado: 'HECHA', fin: ahora } }),
      prisma.ordenTrabajoEtapa.updateMany({ where: { ordenId: o.id, posicion: { gt: destino.posicion } }, data: { estado: 'PENDIENTE', inicio: null, fin: null } }),
      prisma.ordenTrabajoEtapa.update({ where: { id: destino.id }, data: { estado: 'EN_CURSO', inicio: destino.inicio || ahora, fin: null } }),
      prisma.ordenTrabajo.update({ where: { id: o.id }, data: { etapaId: destino.etapaId } }),
    ])
    return { ok: true }
  }))

  // Responsable / nota de una etapa puntual del recorrido.
  fastify.put('/produccion/ordenes/:id/etapas/:etapaRowId', auth, h(async (req) => {
    const o = await otDelTenant(req.tenantId, req.params.id)
    const fila = await prisma.ordenTrabajoEtapa.findFirst({ where: { id: req.params.etapaRowId, ordenId: o.id } })
    if (!fila) throw new HttpError(404, 'Etapa no encontrada.')
    const b = req.body || {}
    const data = {}
    if (b.responsableId !== undefined) { data.responsableId = vacioANull(b.responsableId); data.responsableNombre = await nombreUsuario(req.tenantId, data.responsableId) }
    if (b.nota !== undefined) data.nota = vacioANull(b.nota)
    return prisma.ordenTrabajoEtapa.update({ where: { id: fila.id }, data })
  }))

  fastify.post('/produccion/ordenes/:id/completar', auth, h(async (req) => {
    const body = completarSchema.safeParse(req.body || {})
    if (!body.success) throw new HttpError(400, body.error.errors[0].message)
    const d = body.data
    let o = await otDelTenant(req.tenantId, req.params.id, { lineas: true, salidas: true, bom: true })
    if (!['PLANIFICADA', 'EN_PROCESO', 'PAUSADA'].includes(o.estado)) throw new HttpError(409, 'La orden ya está cerrada.')
    const cfg = await leerConfig(req.tenantId)
    const forzar = d.forzar === true && req.user.rol === 'ADMIN'
    if (cfg.lotes && d.loteNro) {
      const dup = await prisma.lote.findFirst({ where: { tenantId: req.tenantId, productoId: o.productoId, nroLote: d.loteNro.trim() } })
      if (dup) throw new HttpError(409, `Ya existe el lote "${d.loteNro.trim()}" para este producto.`)
    }
    const prodPorSalida = new Map((d.salidas || []).map((s) => [s.id, s.cantProd]))
    const realPorLinea = new Map((d.consumos || []).map((c) => [c.id, c.cantReal]))
    const ahora = new Date()

    const res = await prisma.$transaction(async (tx) => {
      // "Producir ya": completar una planificada descuenta los insumos en el mismo paso.
      if (!o.insumosDescontados) {
        await descontarInsumos(tx, req, o, cfg, forzar)
        o = { ...o, lineas: await tx.lineaOrdenTrabajo.findMany({ where: { ordenId: o.id } }) }
      }
      // Consumo real distinto del planificado: se devuelve el sobrante o se descuenta lo extra.
      let costoInsumos = 0
      for (const l of o.lineas) {
        let consumida = num(l.cantConsumida)
        if (realPorLinea.has(l.id)) {
          const real = r3(realPorLinea.get(l.id))
          const diff = r3(real - consumida)
          if (diff !== 0) {
            await mover(tx, req, {
              productoId: l.productoId, varianteId: l.varianteId, sucursalId: o.sucursalId, delta: -diff,
              tipo: diff > 0 ? 'SALIDA_PRODUCCION' : 'ENTRADA_PRODUCCION', ot: o,
              referencia: diff > 0 ? `Consumo extra OT #${o.nro}` : `Sobrante devuelto OT #${o.nro}`,
            })
            await tx.lineaOrdenTrabajo.update({ where: { id: l.id }, data: { cantConsumida: real } })
            consumida = real
          }
        }
        costoInsumos += consumida * num(l.costoUnit)
      }
      // Entra lo producido.
      let unidades = 0
      for (const s of o.salidas) {
        const cant = r3(prodPorSalida.has(s.id) ? prodPorSalida.get(s.id) : num(s.cantPlanif))
        unidades += cant
        await tx.ordenTrabajoSalida.update({ where: { id: s.id }, data: { cantProd: cant } })
        if (cant > 0) {
          await mover(tx, req, { productoId: s.productoId, varianteId: s.varianteId, sucursalId: o.sucursalId, delta: cant, tipo: 'ENTRADA_PRODUCCION', ot: o, referencia: `Producido OT #${o.nro}` })
        }
      }
      if (unidades <= 0) throw new HttpError(400, 'Indicá cuánto se produjo (tiene que ser más de 0). Si no se produjo nada, cancelá la orden.')
      const tandas = num(o.cantPlanif) / (num(o.bom.rendimiento) || 1)
      const costoManoObra = cfg.costos ? r2(num(o.bom.costoManoObra) * tandas) : 0
      const costoIndirecto = cfg.costos ? r2(num(o.bom.costoIndirecto) * tandas) : 0
      costoInsumos = r2(costoInsumos)
      const costoTotal = r2(costoInsumos + costoManoObra + costoIndirecto)
      const costoUnitario = Math.round((costoTotal / unidades) * 10000) / 10000

      // Lote de lo producido (con vencimiento) — FEFO lo usa el resto del sistema.
      let loteNro = null
      if (cfg.lotes && d.loteNro?.trim()) {
        loteNro = d.loteNro.trim()
        await tx.lote.create({
          data: { tenantId: req.tenantId, productoId: o.productoId, nroLote: loteNro, cantidad: unidades, cantDisponible: unidades, fechaElab: ahora, fechaVenc: fechaANull(d.fechaVenc), observaciones: `Producción OT #${o.nro}` },
        })
      }
      // Costo del producto = costo real de esta tanda (en la moneda del producto).
      const actualizar = d.actualizarCosto ?? cfg.actualizarCosto
      if (actualizar && costoUnitario > 0) {
        const prod = await tx.producto.findUnique({ where: { id: o.productoId }, select: { moneda: true } })
        const cot = await cotizacionDefault(req.tenantId)
        const valor = desdePesos(r2(costoUnitario), prod.moneda, cot)
        if (valor != null) {
          const conVarianteCostoPropio = o.salidas.filter((s) => s.varianteId).map((s) => s.varianteId)
          if (conVarianteCostoPropio.length) {
            await tx.productoVariante.updateMany({ where: { id: { in: conVarianteCostoPropio }, precioCosto: { not: null } }, data: { precioCosto: valor } })
          }
          await tx.producto.update({ where: { id: o.productoId }, data: { precioCosto: valor } })
        }
      }
      await tx.ordenTrabajoEtapa.updateMany({ where: { ordenId: o.id, estado: { not: 'HECHA' } }, data: { estado: 'HECHA', fin: ahora } })
      return tx.ordenTrabajo.update({
        where: { id: o.id },
        data: {
          estado: 'COMPLETADA', cantProd: r3(unidades), fechaFin: ahora, etapaId: null, insumosDescontados: true,
          costoInsumos, costoManoObra, costoIndirecto, costoTotal, costoUnitario,
          ...(loteNro && { loteNro, fechaVenc: fechaANull(d.fechaVenc) }),
        },
      })
    }, { timeout: 30000 })
    registrarAuditoria({ tenantId: req.tenantId, userId: req.user.id, accion: 'produccion.ot.completar', entidad: 'OrdenTrabajo', entidadId: o.id, detalle: { nro: o.nro, cantProd: num(res.cantProd), costoTotal: num(res.costoTotal) }, req })
    return res
  }))

  fastify.post('/produccion/ordenes/:id/cancelar', auth, h(async (req) => {
    const o = await otDelTenant(req.tenantId, req.params.id, { lineas: true })
    if (!['PLANIFICADA', 'EN_PROCESO', 'PAUSADA'].includes(o.estado)) throw new HttpError(409, 'La orden ya está cerrada.')
    const devolver = req.body?.devolver !== false
    await prisma.$transaction(async (tx) => {
      if (o.insumosDescontados && devolver) {
        for (const l of o.lineas) {
          const cant = num(l.cantConsumida)
          if (cant > 0) await mover(tx, req, { productoId: l.productoId, varianteId: l.varianteId, sucursalId: o.sucursalId, delta: cant, tipo: 'ENTRADA_PRODUCCION', ot: o, referencia: `Devolución por cancelación OT #${o.nro}` })
        }
      }
      await tx.ordenTrabajo.update({ where: { id: o.id }, data: { estado: 'CANCELADA', fechaFin: new Date(), etapaId: null } })
    }, { timeout: 30000 })
    registrarAuditoria({ tenantId: req.tenantId, userId: req.user.id, accion: 'produccion.ot.cancelar', entidad: 'OrdenTrabajo', entidadId: o.id, detalle: { nro: o.nro, devolver }, req })
    return { ok: true }
  }))

  // Eliminar: solo si nunca movió stock (planificada) o ya está cancelada.
  fastify.delete('/produccion/ordenes/:id', admin, h(async (req) => {
    const o = await otDelTenant(req.tenantId, req.params.id)
    if (!(o.estado === 'CANCELADA' || (o.estado === 'PLANIFICADA' && !o.insumosDescontados))) {
      throw new HttpError(409, 'Solo se eliminan órdenes planificadas o canceladas. Cancelala primero.')
    }
    await prisma.ordenTrabajo.update({ where: { id: o.id }, data: { activo: false } })
    return { ok: true }
  }))

  // ═════════ Planificación ═════════
  // Insumos que hacen falta para las OT planificadas (todas o las elegidas) contra el stock de
  // su sucursal, agrupados por proveedor preferido — listo para armar las órdenes de compra.
  fastify.get('/produccion/planificacion', auth, async (req) => {
    const ids = req.query.ids ? String(req.query.ids).split(',').filter(Boolean) : null
    const ots = await prisma.ordenTrabajo.findMany({
      where: { tenantId: req.tenantId, activo: true, estado: 'PLANIFICADA', insumosDescontados: false, ...(ids && { id: { in: ids } }) },
      include: { lineas: true }, orderBy: { nro: 'asc' },
    })
    const acc = new Map()
    for (const o of ots) {
      for (const l of o.lineas) {
        const k = l.productoId + '|' + (l.varianteId || '') + '|' + (o.sucursalId || '')
        const prev = acc.get(k) || { productoId: l.productoId, varianteId: l.varianteId, sucursalId: o.sucursalId, um: l.um, necesita: 0, ots: [] }
        prev.necesita += num(l.cantPlanif)
        if (!prev.ots.includes(o.nro)) prev.ots.push(o.nro)
        acc.set(k, prev)
      }
    }
    const filas = [...acc.values()]
    const mp = await mapaProductos(req.tenantId, filas.map((f) => f.productoId), filas.map((f) => f.varianteId))
    const cot = await cotizacionDefault(req.tenantId)
    const items = []
    for (const f of filas) {
      const p = mp.p.get(f.productoId); const v = f.varianteId ? mp.v.get(f.varianteId) : null
      const hay = await stockEnSucursal(prisma, { productoId: f.productoId, varianteId: f.varianteId, sucursalId: f.sucursalId })
      const falta = r3(Math.max(0, f.necesita - hay))
      const costoUnit = costoPesos(p, v, cot)
      items.push({
        ...f, necesita: r3(f.necesita), stock: r3(hay), falta, nombre: p?.nombre, sku: p?.sku, varianteTxt: varianteTxt(v),
        proveedorId: p?.proveedor?.id || null, proveedorNombre: p?.proveedor?.nombre || null, costoUnit, costoFalta: r2(falta * costoUnit),
      })
    }
    items.sort((a, b) => (b.falta > 0) - (a.falta > 0) || String(a.nombre).localeCompare(String(b.nombre)))
    return {
      ots: ots.map((o) => ({ id: o.id, nro: o.nro })),
      items,
      faltantes: items.filter((i) => i.falta > 0).length,
      costoFaltante: r2(items.reduce((s, i) => s + i.costoFalta, 0)),
    }
  })
}
