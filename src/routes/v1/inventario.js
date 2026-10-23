// ─────────────────────────────────────────────────────────────
//  Rutas: /api/v1/inventario
//  Movimientos, ajustes manuales y alertas de stock
// ─────────────────────────────────────────────────────────────

import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { registrarAuditoria } from '../../lib/auditoria.js'
import { resolverSucursalStock, moverStock, stockEnSucursal, fijarStockSucursal, StockError } from '../../lib/stock.js'
import { listaEnPesos } from '../../lib/moneda.js'

const ajusteMasivoSchema = z.object({
  comentario: z.string().min(1, 'El comentario es obligatorio'),
  // Sucursal cuyo stock se está fijando (el número que se carga es "lo que hay en ESTA sucursal");
  // si no viene, la de src/lib/stock.js resolverSucursalStock (asignada al usuario → principal).
  sucursalId: z.string().optional(),
  // varianteId opcional: si viene, el ajuste es sobre el stock propio de esa variante (no el
  // total agregado del producto) — productoId sigue siendo obligatorio (el movimiento de stock
  // se registra contra el producto padre, MovimientoStock no tiene columna de variante propia).
  ajustes: z.array(z.object({
    productoId: z.string(),
    varianteId: z.string().optional(),
    stockNuevo: z.number().min(0),
  })).min(1),
})

const ajusteSchema = z.object({
  productoId: z.string(),
  cantidadNueva: z.number().min(0),
  motivo: z.string().min(1, 'Motivo requerido'),
  sucursalId: z.string().optional(),
})

// Motivos típicos de un rubro con mercadería perecedera/frágil (dietética, almacén, indumentaria)
// que necesita descontar stock por algo que NO es una venta ni una compra — rotura, vencimiento,
// desperdicio. Usa el tipo TipoMovimiento.SALIDA_MERMA que ya existía en el schema pero no tenía
// ningún endpoint/UI que lo usara todavía.
const MERMA_MOTIVOS = ['ROTURA', 'VENCIDO', 'DESPERDICIO', 'OTRO']
const MERMA_MOTIVO_LABEL = { ROTURA: 'Rotura', VENCIDO: 'Vencido/Descartado', DESPERDICIO: 'Desperdicio', OTRO: 'Otro' }
const mermaSchema = z.object({
  productoId: z.string(),
  cantidad: z.number().positive(),
  motivoCategoria: z.enum(MERMA_MOTIVOS),
  detalle: z.string().optional(),
  varianteId: z.string().optional(),
  sucursalId: z.string().optional(),
})

// Transferencia de mercadería entre sucursales — el total de la empresa no cambia, solo se
// mueve de una fila de sucursal a otra (ver src/lib/stock.js, opción soloSucursal).
const transferenciaSchema = z.object({
  origenId: z.string().min(1, 'Elegí la sucursal de origen'),
  destinoId: z.string().min(1, 'Elegí la sucursal de destino'),
  comentario: z.string().optional(),
  items: z.array(z.object({
    productoId: z.string(),
    varianteId: z.string().optional(),
    cantidad: z.number().positive('La cantidad tiene que ser mayor a 0'),
  })).min(1, 'Agregá al menos un producto'),
})

// Etiqueta legible para el log de MovimientoStock (no hay columna de variante propia ahí) —
// no hace falta resolver los labels de CampoVariante acá, los valores crudos ya identifican
// la variante sin ambigüedad para quien lea el historial de movimientos.
function variante_etiqueta_backend(variante) {
  const valores = variante.valores || {}
  return Object.values(valores).filter(Boolean).join('/') || variante.sku
}

export default async function inventarioRoutes(fastify) {
  const auth = { preHandler: [fastify.verifyJWT, fastify.verifyTenant] }

  // ── GET /inventario/movimientos ───────────────────────────
  fastify.get('/inventario/movimientos', auth, async (req) => {
    const { page = 1, limit = 50, productoId, tipo, desde, hasta, sucursalId } = req.query
    const where = {
      tenantId: req.tenantId,
      ...(productoId && { productoId }),
      ...(sucursalId && { sucursalId }),
      ...(tipo && { tipo }),
      ...(desde || hasta) && { fecha: { ...(desde && { gte: new Date(desde) }), ...(hasta && { lte: new Date(hasta) }) } },
    }
    const [data, total] = await prisma.$transaction([
      prisma.movimientoStock.findMany({
        where,
        include: {
          producto: { select: { id: true, nombre: true, sku: true, um: true } },
          usuario: { select: { id: true, nombre: true } },
        },
        orderBy: { fecha: 'desc' },
        skip: (Number(page) - 1) * Number(limit),
        take: Number(limit),
      }),
      prisma.movimientoStock.count({ where }),
    ])
    return { data, meta: { total, page: Number(page), limit: Number(limit) } }
  })

  // ── POST /inventario/ajuste ───────────────────────────────
  // Ajuste manual de stock (inventario físico)
  fastify.post('/inventario/ajuste', {
    preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN', 'DEPOSITO'])],
  }, async (req, reply) => {
    const body = ajusteSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.errors[0].message })

    const { productoId, cantidadNueva, motivo } = body.data

    const producto = await prisma.producto.findFirst({
      where: { id: productoId, tenantId: req.tenantId },
    })
    if (!producto) return reply.status(404).send({ error: 'not_found', message: 'Producto no encontrado.' })

    const sucursalId = await resolverSucursalStock(prisma, req.tenantId, body.data.sucursalId, req.user)

    const r = await prisma.$transaction(async (tx) => {
      const f = await fijarStockSucursal(tx, { productoId, sucursalId, valor: cantidadNueva })
      const tipo = f.delta >= 0 ? 'ENTRADA_AJUSTE' : 'SALIDA_AJUSTE'
      if (f.delta !== 0) {
        await tx.movimientoStock.create({
          data: {
            tenantId: req.tenantId, productoId, usuarioId: req.user.id, tipo,
            cantidad: f.delta, stockPost: f.total, sucursalId,
            referencia: `Ajuste manual: ${motivo}`,
          },
        })
      }
      return { ...f, tipo }
    })

    return reply.status(201).send({
      productoId,
      sucursalId,
      stockAnterior: r.antes,
      stockNuevo: cantidadNueva,
      diferencia: r.delta,
      stockTotal: r.total,
      tipo: r.tipo,
    })
  })

  // ── POST /inventario/ajuste-stock-masivo ──────────────────
  // Modificación de stock a mano por un admin, sobre 1 o varios productos a la vez — gateada por
  // el mismo PIN de seguridad que el resto de las acciones sensibles del PoS (el frontend ya lo
  // verificó contra /configuracion/verificar-pin-descuentos antes de llamar acá, mismo patrón que
  // pos_con_pin). Solo ADMIN — a diferencia de /inventario/ajuste (un solo producto, sin PIN,
  // también habilitado para DEPOSITO), este es el flujo masivo con comentario obligatorio y
  // registro individual en auditoría por producto tocado.
  fastify.post('/inventario/ajuste-stock-masivo', {
    preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN'])],
  }, async (req, reply) => {
    const body = ajusteMasivoSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.errors[0].message })
    const { comentario, ajustes } = body.data
    const sucursalId = await resolverSucursalStock(prisma, req.tenantId, body.data.sucursalId, req.user)

    const productos = await prisma.producto.findMany({
      where: { tenantId: req.tenantId, id: { in: ajustes.map((a) => a.productoId) } },
    })
    const porId = Object.fromEntries(productos.map((p) => [p.id, p]))
    const faltanteProd = ajustes.find((a) => !porId[a.productoId])
    if (faltanteProd) return reply.status(404).send({ error: 'not_found', message: 'Uno de los productos no existe.' })

    const varianteIds = ajustes.filter((a) => a.varianteId).map((a) => a.varianteId)
    const variantes = varianteIds.length
      ? await prisma.productoVariante.findMany({ where: { tenantId: req.tenantId, id: { in: varianteIds } } })
      : []
    const variantePorId = Object.fromEntries(variantes.map((v) => [v.id, v]))
    const faltanteVar = ajustes.find((a) => a.varianteId && (!variantePorId[a.varianteId] || variantePorId[a.varianteId].productoId !== a.productoId))
    if (faltanteVar) return reply.status(404).send({ error: 'not_found', message: 'Una de las variantes no existe.' })

    // "Anterior" = lo que había en ESTA sucursal (el número que el admin está corrigiendo es
    // el de la sucursal en la que está parado, no el total de la empresa).
    const cambios = []
    for (const a of ajustes) {
      const variante = a.varianteId ? variantePorId[a.varianteId] : null
      const stockAnterior = await stockEnSucursal(prisma, { productoId: a.productoId, varianteId: a.varianteId, sucursalId })
      if (a.stockNuevo !== stockAnterior) cambios.push({ ...a, producto: porId[a.productoId], variante, stockAnterior })
    }
    if (!cambios.length) return reply.status(400).send({ error: 'sin_cambios', message: 'Ningún producto tuvo cambios de stock.' })

    await prisma.$transaction(async (tx) => {
      for (const c of cambios) {
        const f = await fijarStockSucursal(tx, { productoId: c.productoId, varianteId: c.varianteId, sucursalId, valor: c.stockNuevo })
        const etiquetaVariante = c.variante ? variante_etiqueta_backend(c.variante) : null
        await tx.movimientoStock.create({
          data: {
            tenantId: req.tenantId,
            productoId: c.productoId,
            usuarioId: req.user.id,
            tipo: f.delta >= 0 ? 'ENTRADA_AJUSTE' : 'SALIDA_AJUSTE',
            cantidad: f.delta,
            stockPost: f.total,
            sucursalId,
            referencia: etiquetaVariante
              ? `Modificación de stock (admin, variante ${etiquetaVariante}): ${comentario}`
              : `Modificación de stock (admin): ${comentario}`,
          },
        })
      }
    }, { timeout: 30000 })

    for (const c of cambios) {
      await registrarAuditoria({
        tenantId: req.tenantId, userId: req.user.id, req,
        accion: 'producto.stock_manual',
        entidad: c.variante ? 'ProductoVariante' : 'Producto',
        entidadId: c.variante ? c.varianteId : c.productoId,
        detalle: { comentario, antes: c.stockAnterior, despues: c.stockNuevo, productoId: c.productoId, sucursalId },
      })
    }

    return reply.status(201).send({
      ok: true,
      sucursalId,
      resumen: cambios.map((c) => ({
        productoId: c.productoId, varianteId: c.varianteId || null, nombre: c.producto.nombre,
        stockAnterior: c.stockAnterior, stockNuevo: c.stockNuevo, diferencia: c.stockNuevo - c.stockAnterior,
      })),
    })
  })

  // ── GET /inventario/merma/motivos ─────────────────────────
  fastify.get('/inventario/merma/motivos', auth, async () => {
    return MERMA_MOTIVOS.map((m) => ({ value: m, label: MERMA_MOTIVO_LABEL[m] }))
  })

  // ── POST /inventario/merma ─────────────────────────────────
  // Descuento de stock por rotura/vencimiento/desperdicio — fuera del circuito de venta/compra.
  // No deja bajar el stock de un producto por debajo de 0 (si se rompió más de lo que figura en
  // sistema, primero hay que hacer un ajuste de inventario físico, no una merma).
  fastify.post('/inventario/merma', {
    preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN', 'DEPOSITO'])],
  }, async (req, reply) => {
    const body = mermaSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.errors[0].message })

    const { productoId, varianteId, cantidad, motivoCategoria, detalle } = body.data

    const producto = await prisma.producto.findFirst({ where: { id: productoId, tenantId: req.tenantId } })
    if (!producto) return reply.status(404).send({ error: 'not_found', message: 'Producto no encontrado.' })
    let variante = null
    if (varianteId) {
      variante = await prisma.productoVariante.findFirst({ where: { id: varianteId, productoId, tenantId: req.tenantId } })
      if (!variante) return reply.status(404).send({ error: 'not_found', message: 'Variante no encontrada.' })
    }
    const sucursalId = await resolverSucursalStock(prisma, req.tenantId, body.data.sucursalId, req.user)

    // El tope es lo que hay en ESTA sucursal — no se puede romper en Güemes mercadería que está en Tejedor.
    const stockActual = await stockEnSucursal(prisma, { productoId, varianteId, sucursalId })
    if (cantidad > stockActual) {
      return reply.status(400).send({ error: 'validation_error', message: `No podés descontar ${cantidad} — el stock actual${sucursalId ? ' en esta sucursal' : ''} es ${stockActual}.` })
    }
    const referencia = `Merma (${MERMA_MOTIVO_LABEL[motivoCategoria]})` + (variante ? ` variante ${variante_etiqueta_backend(variante)}` : '') + (detalle ? `: ${detalle}` : '')

    const r = await prisma.$transaction(async (tx) => {
      const m = await moverStock(tx, { productoId, varianteId, sucursalId, delta: -cantidad })
      // Merma de un talle/color: también baja el stock general del producto (igual que una venta).
      if (varianteId) await moverStock(tx, { productoId, sucursalId, delta: -cantidad })
      await tx.movimientoStock.create({
        data: {
          tenantId: req.tenantId,
          productoId,
          usuarioId: req.user.id,
          tipo: 'SALIDA_MERMA',
          cantidad: -cantidad,
          stockPost: m.total,
          sucursalId,
          referencia,
        },
      })
      return m
    })

    return reply.status(201).send({ productoId, varianteId: varianteId || null, sucursalId, stockAnterior: stockActual, stockNuevo: stockActual - cantidad, stockTotal: r.total, cantidad, motivoCategoria })
  })

  // ── POST /inventario/transferencia ────────────────────────
  // "Paso 3 del talle M de Güemes a Tejedor": sale de una sucursal y entra en la otra, en una
  // sola transacción. No deja sacar más de lo que hay en el origen. Queda en el historial de
  // movimientos (TRANSFERENCIA_SALIDA en el origen + TRANSFERENCIA_ENTRADA en el destino).
  fastify.post('/inventario/transferencia', {
    preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN', 'DEPOSITO'])],
  }, async (req, reply) => {
    const body = transferenciaSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.errors[0].message })
    const { origenId, destinoId, comentario, items } = body.data
    if (origenId === destinoId) return reply.status(400).send({ error: 'validation_error', message: 'El origen y el destino tienen que ser sucursales distintas.' })

    const sucs = await prisma.sucursal.findMany({ where: { tenantId: req.tenantId, activa: true, id: { in: [origenId, destinoId] } }, select: { id: true, nombre: true } })
    const origen = sucs.find((s) => s.id === origenId), destino = sucs.find((s) => s.id === destinoId)
    if (!origen || !destino) return reply.status(404).send({ error: 'not_found', message: 'Sucursal no encontrada.' })

    const productos = await prisma.producto.findMany({ where: { tenantId: req.tenantId, id: { in: items.map((i) => i.productoId) } }, select: { id: true, nombre: true } })
    const prodPorId = Object.fromEntries(productos.map((p) => [p.id, p]))
    const varIds = items.filter((i) => i.varianteId).map((i) => i.varianteId)
    const variantes = varIds.length ? await prisma.productoVariante.findMany({ where: { tenantId: req.tenantId, id: { in: varIds } } }) : []
    const varPorId = Object.fromEntries(variantes.map((v) => [v.id, v]))
    for (const i of items) {
      if (!prodPorId[i.productoId]) return reply.status(404).send({ error: 'not_found', message: 'Uno de los productos no existe.' })
      if (i.varianteId && (!varPorId[i.varianteId] || varPorId[i.varianteId].productoId !== i.productoId)) return reply.status(404).send({ error: 'not_found', message: 'Una de las variantes no existe.' })
    }

    try {
      const resumen = await prisma.$transaction(async (tx) => {
        const out = []
        for (const i of items) {
          const nombre = prodPorId[i.productoId].nombre + (i.varianteId ? ' (' + variante_etiqueta_backend(varPorId[i.varianteId]) + ')' : '')
          const disponible = await stockEnSucursal(tx, { productoId: i.productoId, varianteId: i.varianteId, sucursalId: origenId })
          if (i.cantidad > disponible) throw new StockError(`${nombre}: en ${origen.nombre} hay ${disponible}, no alcanza para pasar ${i.cantidad}.`)
          const sale = await moverStock(tx, { productoId: i.productoId, varianteId: i.varianteId, sucursalId: origenId, delta: -i.cantidad }, { soloSucursal: true })
          const entra = await moverStock(tx, { productoId: i.productoId, varianteId: i.varianteId, sucursalId: destinoId, delta: i.cantidad }, { soloSucursal: true })
          // Mismo criterio que una venta de variante (descuenta la variante Y el producto padre):
          // el stock general del producto acompaña al talle/color que se mudó de sucursal.
          if (i.varianteId) {
            await moverStock(tx, { productoId: i.productoId, sucursalId: origenId, delta: -i.cantidad }, { soloSucursal: true })
            await moverStock(tx, { productoId: i.productoId, sucursalId: destinoId, delta: i.cantidad }, { soloSucursal: true })
          }
          const total = await stockEnSucursal(tx, { productoId: i.productoId, varianteId: i.varianteId, sucursalId: null })
          const ref = `Transferencia ${origen.nombre} → ${destino.nombre}` + (i.varianteId ? ` (variante ${variante_etiqueta_backend(varPorId[i.varianteId])})` : '') + (comentario ? `: ${comentario}` : '')
          await tx.movimientoStock.createMany({
            data: [
              { tenantId: req.tenantId, productoId: i.productoId, usuarioId: req.user.id, tipo: 'TRANSFERENCIA_SALIDA', cantidad: -i.cantidad, stockPost: total, sucursalId: origenId, referencia: ref },
              { tenantId: req.tenantId, productoId: i.productoId, usuarioId: req.user.id, tipo: 'TRANSFERENCIA_ENTRADA', cantidad: i.cantidad, stockPost: total, sucursalId: destinoId, referencia: ref },
            ],
          })
          if (i.varianteId) await tx.productoVariante.update({ where: { id: i.varianteId }, data: { tuvoMovimiento: true } })
          out.push({ productoId: i.productoId, varianteId: i.varianteId || null, nombre, cantidad: i.cantidad, origenQueda: sale.sucursal, destinoQueda: entra.sucursal })
        }
        return out
      }, { timeout: 30000 })

      await registrarAuditoria({
        tenantId: req.tenantId, userId: req.user.id, req,
        accion: 'stock.transferencia', entidad: 'Sucursal', entidadId: destinoId,
        detalle: { origen: origen.nombre, destino: destino.nombre, comentario, items: resumen },
      })
      return reply.status(201).send({ ok: true, origen, destino, resumen })
    } catch (e) {
      if (e instanceof StockError) return reply.status(e.status).send({ error: 'stock_insuficiente', message: e.message })
      throw e
    }
  })

  // ── GET /inventario/alertas ───────────────────────────────
  // Productos con stock <= stockMin (necesitan reposición)
  fastify.get('/inventario/alertas', auth, async (req) => {
    const productos = await prisma.producto.findMany({
      where: { tenantId: req.tenantId, activo: true },
      select: { id: true, sku: true, nombre: true, stock: true, stockMin: true, um: true, categoria: { select: { nombre: true, color: true } } },
      orderBy: { nombre: 'asc' },
    })

    const bajoStock = productos.filter(p => Number(p.stock) <= Number(p.stockMin))
    const sinStock = productos.filter(p => Number(p.stock) === 0)

    return {
      bajoStock,
      sinStock,
      resumen: {
        totalProductos: productos.length,
        enAlerta: bajoStock.length,
        sinStock: sinStock.length,
      },
    }
  })

  // ── GET /inventario/valorizado ────────────────────────────
  // Valor total del inventario (stock × precio costo)
  fastify.get('/inventario/valorizado', auth, async (req) => {
    const productos = await prisma.producto.findMany({
      where: { tenantId: req.tenantId, activo: true, stock: { gt: 0 } },
      select: { id: true, sku: true, nombre: true, stock: true, um: true, precioCosto: true, precioVenta: true, moneda: true, ventaPorPeso: true, categoria: { select: { nombre: true } } },
      orderBy: { nombre: 'asc' },
    }).then((ps) => listaEnPesos(req.tenantId, ps)) // productos en dólares, valuados en pesos

    // precioCosto/precioVenta siempre son por kg, pero el stock se guarda en la unidad que
    // tenga el producto (um: "g" o "kg") — un mismo tenant puede tener productos por peso en
    // cualquiera de las dos. Solo hay que dividir por 1000 cuando el stock está en gramos.
    const items = productos.map(p => {
      const factor = p.um === 'g' ? 1000 : 1
      return {
        ...p,
        valorCosto: (Number(p.stock) / factor) * Number(p.precioCosto),
        valorVenta: (Number(p.stock) / factor) * Number(p.precioVenta),
      }
    })

    const totales = items.reduce((acc, p) => ({
      costo: acc.costo + p.valorCosto,
      venta: acc.venta + p.valorVenta,
    }), { costo: 0, venta: 0 })

    return { items, totales: { ...totales, margenBruto: totales.venta - totales.costo } }
  })
}
