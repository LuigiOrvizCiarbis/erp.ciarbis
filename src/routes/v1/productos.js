// ─────────────────────────────────────────────────────────────
//  Rutas: /api/v1/productos
// ─────────────────────────────────────────────────────────────

import { z } from 'zod'
import { parcial } from '../../lib/zodUtil.js'
import * as XLSX from 'xlsx'
import { prisma } from '../../lib/prisma.js'
import { registrarAuditoria } from '../../lib/auditoria.js'
import { tituloCase } from '../../lib/textUtils.js'
import { resolverSucursalStock, moverStock, fijarStockSucursal } from '../../lib/stock.js'
import {
  NIVELES_UBICACION, ubicacionesSchema, ubicacionDe, ubicacionEfectiva, guardarUbicaciones,
  filtroUbicacionContiene, compararUbicacion, nivelesUbicacionActivos,
} from '../../lib/ubicacion.js'
import { cotizacionDefault, conPreciosEnPesos, listaEnPesos, desdePesos, aPesos } from '../../lib/moneda.js'

// Include de las filas por sucursal que pide un listado: la de la sucursal en la que se mira el
// stock y/o la de la que se quiere la ubicación (pueden ser la misma). null si no pide ninguna.
function includeSucursales(sucursalId, ubicSucursalId) {
  const ids = [...new Set([sucursalId, ubicSucursalId].filter(Boolean))]
  if (!ids.length) return null
  return { where: { sucursalId: { in: ids } }, select: { sucursalId: true, stock: true, pasillo: true, estante: true, cajon: true } }
}

// Agrega al producto y a cada variante `stockSucursal` (número, si se pidió sucursalId — `stock`
// sigue siendo el total de la empresa) y `ubicacion` ({pasillo,estante,cajon} propia, si se pidió
// ubicSucursalId). La variante además trae `ubicacionEfectiva` (heredando del producto).
function conSucursal(p, sucursalId, ubicSucursalId) {
  if (!sucursalId && !ubicSucursalId) return p
  const fila = (x, id) => (x.stockSucursales || []).find((f) => f.sucursalId === id)
  const agregar = (x) => ({
    ...x,
    ...(sucursalId && { stockSucursal: Number(fila(x, sucursalId)?.stock ?? 0) }),
    ...(ubicSucursalId && { ubicacion: ubicacionDe(fila(x, ubicSucursalId)) }),
  })
  const prod = agregar(p)
  return {
    ...prod,
    variantes: (p.variantes || []).map((v) => {
      const va = agregar(v)
      return ubicSucursalId ? { ...va, ubicacionEfectiva: ubicacionEfectiva(va.ubicacion, prod.ubicacion) } : va
    }),
  }
}

// ─── Importación masiva desde Excel/CSV ────────────────────────
function normalizarHeader(h) {
  return String(h || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '')
}

const ALIAS_COLUMNAS = {
  sku: ['sku', 'codigo', 'cod', 'idproducto', 'codigointerno'],
  codigoBarras: ['codigodebarras', 'codbarras', 'ean', 'barcode', 'codigobarra'],
  nombre: ['nombre', 'producto', 'articulo', 'item'],
  descripcionCorta: ['descripcioncorta', 'resumen', 'teaser'],
  descripcion: ['descripcion', 'detalle', 'descripcionlarga'],
  um: ['um', 'unidad', 'unidaddemedida', 'presentacion', 'tamano', 'medida'],
  precioCosto: ['costo', 'preciocosto', 'costounitario', 'preciocompra', 'costousd', 'costoud', 'costoars', 'costodolares'],
  precioVenta: ['precio', 'precioventa', 'venta', 'preciosugerido', 'valorsugeridoventa', 'pvp', 'preciodeventa', 'preciousd', 'precioud', 'precioars', 'preciodolares', 'precioenusd'],
  stock: ['stock', 'cantidad', 'existencia', 'unidades'],
  pasillo: ['pasillo', 'gondola', 'pas'],
  estante: ['estante', 'estanteria', 'repisa', 'est'],
  cajon: ['cajon', 'cajonera', 'gaveta', 'caj'],
  categoria: ['categoria', 'categorias', 'rubro', 'familia'],
}

// Detecta qué columna del archivo corresponde a cada campo, por nombre de encabezado
function detectarMapeo(headers) {
  const normalizados = headers.map(normalizarHeader)
  const mapeo = {}
  for (const [campo, alias] of Object.entries(ALIAS_COLUMNAS)) {
    const idx = normalizados.findIndex(h => alias.includes(h))
    if (idx !== -1) mapeo[campo] = headers[idx]
  }
  return mapeo
}

// Números en Excel pueden venir ya numéricos, o como texto con formato AR (1.234,56) o US (1,234.56)
function parseNumero(v) {
  if (typeof v === 'number') return v
  if (v === undefined || v === null || v === '') return 0
  let s = String(v).trim().replace(/[^0-9.,-]/g, '')
  if (!s) return 0
  const tieneComa = s.includes(','), tienePunto = s.includes('.')
  if (tieneComa && tienePunto) {
    s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '')
  } else if (tieneComa) {
    s = s.replace(',', '.')
  }
  const n = parseFloat(s)
  return isNaN(n) ? 0 : n
}

const confirmarImportSchema = z.object({
  mapeo: z.object({
    sku: z.string().optional(),
    codigoBarras: z.string().optional(),
    nombre: z.string().min(1, 'Falta mapear la columna Nombre'),
    descripcionCorta: z.string().optional(),
    descripcion: z.string().optional(),
    um: z.string().optional(),
    precioCosto: z.string().optional(),
    precioVenta: z.string().optional(),
    stock: z.string().optional(),
    pasillo: z.string().optional(),
    estante: z.string().optional(),
    cajon: z.string().optional(),
    categoria: z.string().optional(), // "Padre > Hijo" (hasta 4 niveles) — se crean las que falten
  }),
  filas: z.array(z.record(z.any())).min(1, 'El archivo no tiene filas para importar'),
  sucursalId: z.string().optional(), // dónde entra el stock inicial de los productos nuevos
  soloActualizar: z.boolean().optional(), // true = una fila que no matchea un producto existente se saltea (no se crea)
  // Moneda en la que vienen las columnas de costo y de precio del archivo (V2.106.0).
  monedaCosto: z.enum(['ARS', 'USD']).optional(),
  monedaPrecio: z.enum(['ARS', 'USD']).optional(),
})

// SKU legible para un producto que llega sin SKU — mismo estilo que el alta manual (abreviatura +
// número de 3 cifras, ej. "Abre Ojales Chico" → "abreo001"), el primero libre. `usados` es el Set
// de SKUs ya tomados (productos + variantes) y se actualiza acá, así una importación de 2000 filas
// no consulta la base por cada una. Antes era "IMP-<timestamp>-<fila>", ilegible.
function abreviarSku(nombre) {
  return String(nombre || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '').slice(0, 5) || 'prod'
}
function siguienteSkuLibre(base, usados) {
  let n = 1, candidato
  do { candidato = base + String(n).padStart(3, '0'); n++ } while (usados.has(candidato))
  usados.add(candidato)
  return candidato
}

// Moneda final de un producto importado y conversión de cada columna a esa moneda (V2.106.0).
// La moneda la manda la columna de PRECIO si vino; si no, la que ya tenía el producto (o la del
// costo, si es nuevo). Así "Ana manda después los costos en U$D" no le cambia la moneda a nada.
function monedaImportada(mapeo, monedas, existente) {
  if (mapeo.precioVenta) return monedas.precio
  if (existente) return existente.moneda || 'ARS'
  return mapeo.precioCosto ? monedas.costo : 'ARS'
}
function convertirMoneda(monto, de, a, cot) {
  if (monto == null || de === a || Number(monto) === 0) return monto
  if (!(cot > 0)) throw Object.assign(new Error('sin_cotizacion'), { code: 'SIN_COT' })
  return Math.round((a === 'USD' ? Number(monto) / cot : Number(monto) * cot) * 100) / 100
}

// Prisma exige DateTime completo (ISO-8601 con hora) — los <input type=date> del frontend
// mandan solo "AAAA-MM-DD", así que se completa acá antes de llegar a cualquier prisma.create/update.
function normalizarFechaISO(v) {
  if (!v) return null
  return v.length === 10 ? `${v}T00:00:00.000Z` : v
}

// Un producto "por peso" siempre guarda su stock en gramos (ver /productos/kpis más abajo
// y pos_peso_modal en dashboard.html) — permitir um:"unidad" (o cualquier otra cosa) en ese
// estado es justo la combinación que causó el bug real de inventario 1000x inflado en prod.
// Red de seguridad server-side: el form ya acopla el checkbox con el selector de unidad, pero
// esto cubre updates parciales que solo mandan ventaPorPeso sin tocar um explícitamente.
function normalizarUmPorPeso(data) {
  if (data.ventaPorPeso === true && data.um !== undefined && !['g', 'kg'].includes(data.um)) {
    data.um = 'g'
  }
  return data
}

const productoSchema = z.object({
  sku: z.string().min(1),
  codigoBarras: z.string().min(1).optional(),
  nombre: z.string().min(1),
  descripcionCorta: z.string().optional(),
  descripcion: z.string().optional(),
  categoriaId: z.string().nullable().optional(),
  proveedorId: z.string().nullable().optional(),
  um: z.string().default('unidad'),
  ventaPorPeso: z.boolean().default(false),
  vencimiento: z.string().nullable().optional().transform(normalizarFechaISO), // vencimiento "típico" del producto
  precioCosto: z.number().min(0).default(0),
  precioVenta: z.number().min(0).default(0),
  impuesto: z.number().min(0).max(100).default(21),
  stock: z.number().default(0),
  stockMin: z.number().min(0).default(0),
  stockMax: z.number().min(0).optional(),
  usaLotes: z.boolean().default(false),
  usaSerie: z.boolean().default(false),
  publicadoWeb: z.boolean().default(false),
  imagenes: z.array(z.string()).default([]),
  activo: z.boolean().optional(), // permite reactivar un producto pausado vía PUT
  sucursalId: z.string().optional(), // dónde entra el stock inicial (no es una columna de Producto)
  ubicaciones: ubicacionesSchema.optional(), // Pasillo/Estante/Cajón por sucursal (no son columnas de Producto)
  moneda: z.enum(['ARS', 'USD']).optional(), // moneda de precioCosto/precioVenta (V2.106.0)
})

const updateSchema = parcial(productoSchema)

const varianteSchema = z.object({
  // {clave: valor} según el catálogo CampoVariante del tenant (ver GET /productos/campos-variante)
  // — reemplaza los antiguos campos fijos talle/color/tamano.
  valores: z.record(z.string()).optional().default({}),
  sku: z.string().min(1),
  codigoBarras: z.string().optional(),
  imagen: z.string().nullable().optional(), // null = hereda la portada del producto
  precioCosto: z.number().min(0).nullable().optional(), // null = hereda el costo del producto base
  precioVenta: z.number().min(0).nullable().optional(),
  stock: z.number().min(0).default(0),
  tuvoMovimiento: z.boolean().optional(), // lo setea el PoS al vender, no lo toca el form de edición
  // El stock que se carga/edita en el form de variante es el de ESTA sucursal (no una columna).
  sucursalId: z.string().optional(),
  ubicaciones: ubicacionesSchema.optional(), // vacío por nivel = hereda la del producto
})

const productoProveedorSchema = z.object({
  ultimoCosto: z.number().min(0),
  preferido: z.boolean().optional(),
})

const campoVarianteSchema = z.object({
  label: z.string().min(1).max(40),
})

const campoVarianteOpcionSchema = z.object({
  valor: z.string().min(1),
})

const bulkSchema = z.object({
  ids: z.array(z.string()).min(1),
  accion: z.enum(['categoria', 'margen', 'aumento', 'vencimiento', 'reactivar']),
  payload: z.record(z.any()).default({}),
})

const bulkCrearVariantesSchema = z.object({
  productoIds: z.array(z.string()).min(1),
  // {clave: [valor1, valor2, ...]} — una entrada por cada CampoVariante activo con al menos un
  // valor cargado. Se genera el producto cartesiano de todas las listas no vacías.
  campos: z.record(z.array(z.string())).default({}),
})

// Slug estable a partir del label (mismo criterio que sku_abreviar/tituloCase del resto de la
// app) — es la "clave" con la que se guarda el valor en ProductoVariante.valores, independiente
// de si después el usuario le cambia el nombre visible (label).
function slugClave(label) {
  return String(label || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 30) || 'campo'
}

// Autocurativo (mismo criterio que "Consumidor Final"/asegurarListaDefault): la primera vez que
// un tenant pide sus campos de variante y no tiene ninguno, se le siembran Talle/Color/Tamaño
// (el comportamiento de siempre), recuperando los catálogos viejos de productos.talles/colores
// si existían (kv genérica) para no perder las opciones ya cargadas.
async function asegurarCamposVarianteDefault(tenantId) {
  const existentes = await prisma.campoVariante.count({ where: { tenantId } })
  if (existentes > 0) return
  const kv = await prisma.configuracionEmpresa.findMany({
    where: { tenantId, clave: { in: ['productos.talles', 'productos.colores'] } },
  })
  const map = {}
  kv.forEach(r => { map[r.clave] = r.valor })
  let talles = [], colores = []
  try { talles = JSON.parse(map['productos.talles'] || '[]') } catch (e) {}
  try { colores = JSON.parse(map['productos.colores'] || '[]') } catch (e) {}
  await prisma.campoVariante.createMany({
    data: [
      { tenantId, clave: 'talle', label: 'Talle', opciones: JSON.stringify(talles), orden: 0 },
      { tenantId, clave: 'color', label: 'Color', opciones: JSON.stringify(colores), orden: 1 },
      { tenantId, clave: 'tamano', label: 'Tamaño', opciones: JSON.stringify([]), orden: 2 },
    ],
  })
}

const ingresoStockSchema = z.object({
  cantidad: z.number().positive(),
  precioCosto: z.number().min(0).optional(), // permite actualizar el costo en la misma recepción
  proveedor: z.string().optional(),
  observaciones: z.string().optional(),
  // Si viene, la recepción es de UNA variante puntual (escaneada por su propio SKU/código de
  // barras) — el stock sube en la variante, no en el total agregado del producto.
  varianteId: z.string().optional(),
  sucursalId: z.string().optional(), // sucursal donde entra la mercadería
})

// nroLote legible y prácticamente único sin necesitar un contador transaccional aparte:
// fecha + hora + 3 caracteres random (colisión sólo posible si dos ingresos del MISMO producto
// caen en el mismo milisegundo, cubierto igual por el @@unique como red de seguridad).
function generarNroLote() {
  const d = new Date()
  const pad = n => String(n).padStart(2, '0')
  const fecha = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  const suf = Math.random().toString(36).slice(2, 5).toUpperCase()
  return `${fecha}-${suf}`
}

export default async function productosRoutes(fastify) {
  const auth = { preHandler: [fastify.verifyJWT, fastify.verifyTenant] }

  // ── GET /productos/kpis ────────────────────────────────────
  // Antes, la pantalla de Inventario traía hasta 10.000 productos completos solo para sumar 4
  // números en el navegador — pesado siempre, y mucho peor contra la base remota de producción
  // (Supabase) que en localhost. Estos 4 números se calculan acá directo en SQL.
  fastify.get('/productos/kpis', auth, async (req) => {
    const { sucursalId } = req.query
    // Productos en dólares valen en pesos con la cotización default (ver src/lib/moneda.js).
    const cot = await cotizacionDefault(req.tenantId)
    // precioCosto/precioVenta siempre son por kg, pero el stock se guarda en la unidad que
    // tenga el producto (um: "g" o "kg") — un mismo tenant puede tener productos por peso en
    // cualquiera de las dos (no alcanza con mirar ventaPorPeso solo). Dividir por 1000 solo
    // cuando um es "g"; si es "kg" (o cualquier otra unidad no-peso), usar el stock directo.
    // `p."activo" = true` — la consulta original no filtraba esto (arrastrado de un cálculo
    // viejo del frontend), así que un producto en la Papelera seguía sumando a "Total
    // productos"/"Valor inventario" aunque no aparezca en ningún listado activo. Bug real
    // reportado: el valor de inventario incluía stock de productos ya desactivados.
    if (sucursalId) {
      const rows = await prisma.$queryRaw`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE COALESCE(ps.stock, 0) <= 0)::int AS "sinStock",
          COUNT(*) FILTER (WHERE COALESCE(ps.stock, 0) < p."stockMin")::int AS bajos,
          COALESCE(SUM((CASE WHEN p."um" = 'g' THEN COALESCE(ps.stock, 0) * p."precioCosto" / 1000.0 ELSE COALESCE(ps.stock, 0) * p."precioCosto" END) * CASE WHEN p."moneda" = 'USD' THEN ${cot}::numeric ELSE 1 END), 0)::float AS valor,
          COALESCE(SUM((CASE WHEN p."um" = 'g' THEN COALESCE(ps.stock, 0) * p."precioVenta" / 1000.0 ELSE COALESCE(ps.stock, 0) * p."precioVenta" END) * CASE WHEN p."moneda" = 'USD' THEN ${cot}::numeric ELSE 1 END), 0)::float AS "valorVenta"
        FROM productos p
        LEFT JOIN productos_sucursales ps ON ps."productoId" = p.id AND ps."sucursalId" = ${sucursalId}
        WHERE p."tenantId" = ${req.tenantId} AND p."activo" = true
      `
      return rows[0]
    }
    const rows = await prisma.$queryRaw`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE p.stock <= 0)::int AS "sinStock",
        COUNT(*) FILTER (WHERE p.stock < p."stockMin")::int AS bajos,
        COALESCE(SUM((CASE WHEN p."um" = 'g' THEN p.stock * p."precioCosto" / 1000.0 ELSE p.stock * p."precioCosto" END) * CASE WHEN p."moneda" = 'USD' THEN ${cot}::numeric ELSE 1 END), 0)::float AS valor,
        COALESCE(SUM((CASE WHEN p."um" = 'g' THEN p.stock * p."precioVenta" / 1000.0 ELSE p.stock * p."precioVenta" END) * CASE WHEN p."moneda" = 'USD' THEN ${cot}::numeric ELSE 1 END), 0)::float AS "valorVenta"
      FROM productos p
      WHERE p."tenantId" = ${req.tenantId} AND p."activo" = true
    `
    return rows[0]
  })

  // ── GET /productos/sku-sugerido ────────────────────────────
  // Devuelve el primer SKU realmente libre a partir de un candidato ("base"), chequeando contra
  // Producto Y ProductoVariante del tenant (las dos tablas donde un SKU puede colisionar — antes
  // el autogenerado del frontend solo miraba cuántos productos tenía la categoría, sin chequear
  // los SKUs reales, así que sugería duplicados apenas la numeración se desincronizaba de la
  // cantidad real de productos, ej. por productos borrados/importados). Si "base" ya está libre,
  // se devuelve tal cual — sirve tanto para autogenerar de entrada como para resolver un 409
  // "sku_taken" después de que el usuario ya tipeó algo a mano.
  fastify.get('/productos/sku-sugerido', auth, async (req) => {
    const base = String(req.query.base || '').trim()
    if (!base) return { sku: '' }
    const m = base.match(/^(.*?)(\d+)$/)
    const prefijo = m ? m[1] : base
    const anchoOriginal = m ? m[2].length : 0
    let numero = m ? parseInt(m[2], 10) : 0

    const [productos, variantes] = await Promise.all([
      prisma.producto.findMany({ where: { tenantId: req.tenantId, sku: { startsWith: prefijo } }, select: { sku: true } }),
      prisma.productoVariante.findMany({ where: { tenantId: req.tenantId, sku: { startsWith: prefijo } }, select: { sku: true } }),
    ])
    const usados = new Set([...productos, ...variantes].map(r => r.sku))

    let candidato = base
    let intentos = 0
    while (usados.has(candidato) && intentos < 10000) {
      numero += 1
      candidato = prefijo + String(numero).padStart(anchoOriginal, '0')
      intentos += 1
    }
    return { sku: candidato }
  })

  // ── GET /productos ────────────────────────────────────────
  fastify.get('/productos', auth, async (req) => {
    const {
      page = 1, limit = 50,
      q, categoriaId, proveedorId, activo,
      codigoBarras, // match exacto — usado por el lector de códigos de barra del PoS
      stockBajo, // true = solo con stock bajo mínimo
      conCodigo, // 'true' = con código de barras (propio o en alguna variante activa), 'false' = sin ninguno
      sucursalId, // si viene, además de filtrar se pisa el stock mostrado por el de esa sucursal
      ubicSucursalId: ubicPedida, // si viene, cada producto/variante trae su ubicación (pasillo/estante/cajón) en esa sucursal ('auto' = la del usuario/principal)
      orderBy = 'nombre', order = 'asc',
    } = req.query
    const ubicSucursalId = ubicPedida === 'auto' ? await resolverSucursalStock(prisma, req.tenantId, null, req.user) : ubicPedida

    // Un string vacío cuenta como "sin código" (datos viejos/importados pueden tenerlo así).
    // Va dentro de AND porque `q` ya usa el OR de nivel superior.
    const tieneCodigoPropio = { AND: [{ codigoBarras: { not: null } }, { NOT: { codigoBarras: '' } }] }
    const tieneCodigoVariante = { variantes: { some: { activo: true, codigoBarras: { not: null }, NOT: { codigoBarras: '' } } } }
    const filtroCodigo = conCodigo === 'true'
      ? { OR: [tieneCodigoPropio, tieneCodigoVariante] }
      : conCodigo === 'false'
        ? { NOT: { OR: [tieneCodigoPropio, tieneCodigoVariante] } }
        : null

    const where = {
      tenantId: req.tenantId,
      ...(filtroCodigo && { AND: [filtroCodigo] }),
      ...(activo !== undefined && { activo: activo === 'true' }),
      ...(categoriaId && { categoriaId }),
      ...(proveedorId && { proveedorId }),
      ...(codigoBarras && { codigoBarras }),
      ...(q && {
        OR: [
          { nombre: { contains: q, mode: 'insensitive' } },
          { sku: { contains: q, mode: 'insensitive' } },
          { codigoBarras: { contains: q, mode: 'insensitive' } },
          { descripcionCorta: { contains: q, mode: 'insensitive' } },
          { descripcion: { contains: q, mode: 'insensitive' } },
          // "P3" / "C102" también encuentra lo que está en esa ubicación (del producto o de una variante)
          ...(ubicSucursalId ? [
            { stockSucursales: { some: filtroUbicacionContiene(ubicSucursalId, q) } },
            { variantes: { some: { activo: true, stockSucursales: { some: filtroUbicacionContiene(ubicSucursalId, q) } } } },
          ] : []),
        ],
      }),
    }

    const incSuc = includeSucursales(sucursalId, ubicSucursalId)
    const [items, total] = await prisma.$transaction([
      prisma.producto.findMany({
        where,
        include: {
          categoria: { select: { id: true, nombre: true, color: true } },
          proveedor: { select: { id: true, nombre: true } },
          variantes: incSuc
            ? { where: { activo: true }, include: { stockSucursales: incSuc } }
            : { where: { activo: true } },
          ...(incSuc && { stockSucursales: incSuc }),
        },
        orderBy: { [orderBy]: order },
        skip: (Number(page) - 1) * Number(limit),
        take: Number(limit),
      }),
      prisma.producto.count({ where }),
    ])

    // Filtro post-query para stock bajo (necesita comparar dos campos) — parado en una
    // sucursal, cuenta el stock de esa sucursal.
    const conSuc = items.map((p) => conSucursal(p, sucursalId, ubicSucursalId))
    const result = stockBajo === 'true'
      ? conSuc.filter(p => Number(sucursalId ? p.stockSucursal : p.stock) <= Number(p.stockMin))
      : conSuc

    return {
      data: await listaEnPesos(req.tenantId, result),
      meta: { total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / Number(limit)) },
    }
  })

  // ── GET /productos/buscar-codigo ──────────────────────────
  // Respaldo del escaneo de Caja/PoS y Recepción por código: esas pantallas precargan hasta 500
  // productos activos en memoria y buscan ahí primero (rápido, sin roundtrip por cada escaneo)
  // — pero un tenant con más de 500 productos activos tiene productos que NUNCA están en esa
  // lista precargada, así que escanear su código de barras fallaba en silencio como "no
  // encontrado" aunque el producto existiera. Este endpoint hace la misma búsqueda (SKU o
  // código de barras, del producto O de cualquiera de sus variantes) directo contra la base,
  // para usarlo como fallback cuando la búsqueda en memoria no encuentra nada.
  fastify.get('/productos/buscar-codigo', auth, async (req, reply) => {
    const codigo = String(req.query.codigo || '').trim()
    if (!codigo) return reply.status(400).send({ error: 'validation_error', message: 'Falta el código.' })
    const { sucursalId, ubicSucursalId: ubicPedida } = req.query
    const ubicSucursalId = ubicPedida === 'auto' ? await resolverSucursalStock(prisma, req.tenantId, null, req.user) : ubicPedida
    const incSuc = includeSucursales(sucursalId, ubicSucursalId)

    const producto = await prisma.producto.findFirst({
      where: { tenantId: req.tenantId, activo: true, OR: [{ sku: codigo }, { codigoBarras: codigo }] },
      include: { variantes: { where: { activo: true }, ...(incSuc && { include: { stockSucursales: incSuc } }) }, ...(incSuc && { stockSucursales: incSuc }) },
    })
    if (producto) return { producto: (await listaEnPesos(req.tenantId, [conSucursal(producto, sucursalId, ubicSucursalId)]))[0], variante: null }

    const variante = await prisma.productoVariante.findFirst({
      where: { tenantId: req.tenantId, activo: true, OR: [{ sku: codigo }, { codigoBarras: codigo }] },
    })
    if (variante) {
      const productoDeVariante = await prisma.producto.findFirst({
        where: { id: variante.productoId, activo: true },
        include: { variantes: { where: { id: variante.id }, ...(incSuc && { include: { stockSucursales: incSuc } }) }, ...(incSuc && { stockSucursales: incSuc }) },
      })
      if (productoDeVariante) {
        const [enPesos] = await listaEnPesos(req.tenantId, [conSucursal(productoDeVariante, sucursalId, ubicSucursalId)])
        const { variantes: [varConSuc], ...prod } = enPesos
        return { producto: prod, variante: varConSuc || variante }
      }
    }
    return reply.status(404).send({ error: 'not_found', message: 'Ningún producto o variante con ese código.' })
  })

  // ── GET /productos/exportar-stock ─────────────────────────
  // Planilla para control físico de inventario: stock según el sistema + una columna en
  // blanco para tildar/anotar lo contado en el local, pensada para imprimir o llevar en
  // Excel/tablet mientras se recorre el depósito. Filtrable igual que el listado normal
  // (categoría, proveedor, sucursal) para poder contar de a partes en vez de todo junto.
  // Un producto con variantes activas se discrimina en una fila por variante (antes solo
  // aparecía el total agregado del producto, sin desglosar qué talle/color hay que contar).
  // `agruparPor` ('categoria'|'proveedor') ordena la planilla por ese campo e inserta
  // subtotales (productos + unidades) al cierre de cada grupo, más el total general al final.
  // `ubicSucursalId` (si la empresa usa Ubicación en depósito) suma las columnas Pasillo/Estante/
  // Cajón de esa sucursal, y agruparPor='ubicacion' ordena la planilla para recorrer el local
  // pasillo por pasillo (estante y cajón dentro), con subtotal por pasillo.
  fastify.get('/productos/exportar-stock', auth, async (req, reply) => {
    const { categoriaId, proveedorId, sucursalId, agruparPor, ubicSucursalId } = req.query
    const incSuc = includeSucursales(sucursalId, ubicSucursalId)
    const productosCrudos = await prisma.producto.findMany({
      where: {
        tenantId: req.tenantId,
        activo: true,
        ...(categoriaId && { categoriaId }),
        ...(proveedorId && { proveedorId }),
      },
      include: {
        categoria: { select: { nombre: true } },
        proveedor: { select: { nombre: true } },
        variantes: incSuc
          ? { where: { activo: true }, include: { stockSucursales: incSuc } }
          : { where: { activo: true } },
        ...(incSuc && { stockSucursales: incSuc }),
      },
      orderBy: { nombre: 'asc' },
    })
    const productos = productosCrudos.map((p) => conSucursal(p, sucursalId, ubicSucursalId))
    const niveles = ubicSucursalId ? await nivelesUbicacionActivos(prisma, req.tenantId) : []
    const nivelPrincipal = niveles[0]
    const columnasUbic = (u) => Object.fromEntries(niveles.map((n) => [n.label, u?.[n.clave] || '']))

    const grupoDe = (p, u) => agruparPor === 'proveedor' ? (p.proveedor?.nombre || 'Sin proveedor')
      : agruparPor === 'categoria' ? (p.categoria?.nombre || 'Sin categoría')
      : agruparPor === 'ubicacion' && nivelPrincipal ? (u?.[nivelPrincipal.clave] ? `${nivelPrincipal.label} ${u[nivelPrincipal.clave]}` : `Sin ${nivelPrincipal.label.toLowerCase()}`)
      : null

    // Filas por producto — una por variante activa si tiene, si no una sola con el stock
    // agregado. `_grupo`/`_stock` son metadata interna para armar subtotales, no van a la
    // planilla final (se descartan antes de mandar a XLSX).
    // Las columnas de ubicación van entre Producto y Categoría; las filas de subtotal/total las
    // dejan vacías (mismo objeto de claves, así XLSX arma una sola cabecera).
    const vacioUbic = columnasUbic(null)
    let filas = []
    productos.forEach((p) => {
      const stockProducto = Number(sucursalId ? p.stockSucursal : p.stock)
      const base = {
        Categoría: p.categoria?.nombre || '—',
        Proveedor: p.proveedor?.nombre || '—',
        Unidad: p.um,
      }
      if (p.variantes.length) {
        p.variantes.forEach((v) => {
          const etiqueta = Object.values(v.valores || {}).filter(Boolean).join('/') || v.sku
          const stockVar = Number(sucursalId ? v.stockSucursal : (v.stock || 0))
          const u = v.ubicacionEfectiva
          filas.push({
            SKU: v.sku,
            Producto: `${p.nombre} — ${etiqueta}`,
            ...columnasUbic(u),
            ...base,
            'Stock sistema': stockVar,
            'Stock contado (completar)': '',
            Diferencia: '',
            Observaciones: '',
            _grupo: grupoDe(p, u),
            _ubic: u,
            _stock: stockVar,
          })
        })
      } else {
        filas.push({
          SKU: p.sku,
          Producto: p.nombre,
          ...columnasUbic(p.ubicacion),
          ...base,
          'Stock sistema': stockProducto,
          'Stock contado (completar)': '',
          Diferencia: '',
          Observaciones: '',
          _grupo: grupoDe(p, p.ubicacion),
          _ubic: p.ubicacion,
          _stock: stockProducto,
        })
      }
    })

    const totalProductos = productos.length
    const totalUnidades = filas.reduce((s, f) => s + f._stock, 0)

    if (agruparPor) {
      if (agruparPor === 'ubicacion') filas.sort((a, b) => compararUbicacion(a._ubic, b._ubic) || a.Producto.localeCompare(b.Producto))
      else filas.sort((a, b) => (a._grupo || '').localeCompare(b._grupo || ''))
      const conSubtotales = []
      let grupoActual = null, subProductos = 0, subUnidades = 0
      const cerrarGrupo = () => {
        if (grupoActual === null) return
        conSubtotales.push({
          SKU: '', Producto: `Subtotal ${grupoActual}`, ...vacioUbic, Categoría: '', Proveedor: '', Unidad: '',
          'Stock sistema': subUnidades, 'Stock contado (completar)': `${subProductos} producto(s)`, Diferencia: '', Observaciones: '',
        })
      }
      filas.forEach((f) => {
        if (f._grupo !== grupoActual) { cerrarGrupo(); grupoActual = f._grupo; subProductos = 0; subUnidades = 0 }
        subProductos += 1; subUnidades += f._stock
        conSubtotales.push(f)
      })
      cerrarGrupo()
      filas = conSubtotales
    }
    filas.push({
      SKU: '', Producto: 'TOTAL GENERAL', ...vacioUbic, Categoría: '', Proveedor: '', Unidad: '',
      'Stock sistema': totalUnidades, 'Stock contado (completar)': `${totalProductos} producto(s)`, Diferencia: '', Observaciones: '',
    })
    filas.forEach((f) => { delete f._grupo; delete f._stock; delete f._ubic })

    const wb = XLSX.utils.book_new()
    const encabezado = [[`Total productos: ${totalProductos}`], [`Total unidades: ${totalUnidades}`], []]
    const ws = XLSX.utils.aoa_to_sheet(encabezado)
    XLSX.utils.sheet_add_json(ws, filas, { origin: -1 })
    ws['!cols'] = [{ wch: 14 }, { wch: 32 }, ...niveles.map(() => ({ wch: 9 })), { wch: 18 }, { wch: 18 }, { wch: 10 }, { wch: 13 }, { wch: 20 }, { wch: 12 }, { wch: 24 }]
    XLSX.utils.book_append_sheet(wb, ws, 'Stock')
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
    reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', 'attachment; filename="control-stock.xlsx"')
      .send(buf)
  })

  // ── GET /productos/:id ────────────────────────────────────
  fastify.get('/productos/:id', auth, async (req, reply) => {
    const item = await prisma.producto.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
      include: {
        categoria: { select: { id: true, nombre: true, color: true } },
        proveedor: { select: { id: true, nombre: true } },
        // Acá se traen TODAS las variantes (activas e inactivas) — a diferencia del listado de
        // productos usado por el PoS, esta es la vista de edición/administración: el admin tiene
        // que poder ver y reactivar una variante pausada.
        variantes: { orderBy: { creadoEn: 'asc' }, include: { stockSucursales: { select: { sucursalId: true, stock: true, pasillo: true, estante: true, cajon: true } } } },
        stockSucursales: { include: { sucursal: { select: { id: true, nombre: true } } } },
      },
    })
    if (!item) return reply.status(404).send({ error: 'not_found', message: 'Producto no encontrado.' })
    return (await listaEnPesos(req.tenantId, [item]))[0]
  })

  // ── POST /productos ───────────────────────────────────────
  fastify.post('/productos', {
    preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN', 'DEPOSITO'])],
  }, async (req, reply) => {
    const body = productoSchema.safeParse(req.body)
    if (!body.success) {
      return reply.status(400).send({ error: 'validation_error', message: body.error.issues[0].message })
    }
    body.data.nombre = tituloCase(body.data.nombre)
    normalizarUmPorPeso(body.data)

    // activo:true en las 3 — un producto en Papelera "no existe realmente" para quien está
    // dando de alta uno nuevo (mismo criterio que el resto de la app desde el fix de Papelera
    // de V2.67.1, que había cubierto 8 pantallas pero no estas 3 validaciones de duplicado).
    const skuExists = await prisma.producto.findFirst({
      where: { tenantId: req.tenantId, sku: body.data.sku, activo: true },
    })
    if (skuExists) return reply.status(409).send({ error: 'sku_taken', message: 'El SKU ya existe.' })

    if (body.data.codigoBarras) {
      const cbExists = await prisma.producto.findFirst({
        where: { tenantId: req.tenantId, codigoBarras: body.data.codigoBarras, activo: true },
      })
      if (cbExists) return reply.status(409).send({ error: 'codigo_barras_taken', message: 'Ese código de barras ya está asignado a otro producto.' })
    }

    const nombreExists = await prisma.producto.findFirst({
      where: { tenantId: req.tenantId, nombre: { equals: body.data.nombre, mode: 'insensitive' }, activo: true },
    })
    if (nombreExists) return reply.status(409).send({ error: 'nombre_duplicado', message: `Ya existe un producto llamado "${nombreExists.nombre}" (${nombreExists.sku}).` })

    // El stock inicial entra en una sucursal (la que manda el alta, o la del usuario/principal)
    // — se crea en 0 y se mueve con moverStock para que total y sucursal queden iguales.
    const { sucursalId: sucPedida, stock: stockInicial, ubicaciones, ...datosProducto } = body.data
    const sucursalId = stockInicial ? await resolverSucursalStock(prisma, req.tenantId, sucPedida, req.user) : null

    const producto = await prisma.$transaction(async (tx) => {
      const t = await tx.tenant.update({
        where: { id: req.tenantId },
        data: { seqProductos: { increment: 1 } },
        select: { seqProductos: true },
      })
      let p = await tx.producto.create({
        data: { tenantId: req.tenantId, numero: t.seqProductos, ...datosProducto, stock: 0 },
      })

      // Si tiene stock inicial, registrar movimiento
      if (stockInicial) {
        await moverStock(tx, { productoId: p.id, sucursalId, delta: stockInicial })
        p = { ...p, stock: stockInicial }
        await tx.movimientoStock.create({
          data: {
            tenantId: req.tenantId,
            productoId: p.id,
            usuarioId: req.user.id,
            tipo: 'ENTRADA_INICIAL',
            cantidad: stockInicial,
            stockPost: stockInicial,
            sucursalId,
            referencia: 'Stock inicial al crear producto',
          },
        })
      }
      await guardarUbicaciones(tx, req.tenantId, { productoId: p.id }, ubicaciones)

      return p
    })

    return reply.status(201).send(producto)
  })

  // ── PUT /productos/:id ────────────────────────────────────
  fastify.put('/productos/:id', {
    preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN', 'DEPOSITO'])],
  }, async (req, reply) => {
    const body = updateSchema.safeParse(req.body)
    if (!body.success) {
      return reply.status(400).send({ error: 'validation_error', message: body.error.issues[0].message })
    }
    normalizarUmPorPeso(body.data)

    // Si cambia SKU, verificar unicidad
    // activo:true — mismo criterio que en el POST, ver comentario ahí.
    if (body.data.sku) {
      const skuExists = await prisma.producto.findFirst({
        where: { tenantId: req.tenantId, sku: body.data.sku, activo: true, id: { not: req.params.id } },
      })
      if (skuExists) return reply.status(409).send({ error: 'sku_taken', message: 'El SKU ya existe.' })
    }

    if (body.data.codigoBarras) {
      const cbExists = await prisma.producto.findFirst({
        where: { tenantId: req.tenantId, codigoBarras: body.data.codigoBarras, activo: true, id: { not: req.params.id } },
      })
      if (cbExists) return reply.status(409).send({ error: 'codigo_barras_taken', message: 'Ese código de barras ya está asignado a otro producto.' })
    }

    if (body.data.nombre) {
      body.data.nombre = tituloCase(body.data.nombre)
      const nombreExists = await prisma.producto.findFirst({
        where: { tenantId: req.tenantId, nombre: { equals: body.data.nombre, mode: 'insensitive' }, activo: true, id: { not: req.params.id } },
      })
      if (nombreExists) return reply.status(409).send({ error: 'nombre_duplicado', message: `Ya existe un producto llamado "${nombreExists.nombre}" (${nombreExists.sku}).` })
    }

    // No actualizar stock directamente desde aquí — usar /inventario/ajuste
    const { stock, sucursalId: _suc, ubicaciones, ...safeData } = body.data

    // Se lee el precio actual ANTES de pisarlo para poder auditar el cambio (si lo hay).
    const antes = safeData.precioVenta !== undefined || safeData.moneda !== undefined
      ? await prisma.producto.findFirst({ where: { id: req.params.id, tenantId: req.tenantId }, select: { precioVenta: true, precioCosto: true, moneda: true } })
      : null

    // Cambio de moneda: lo que se mandó ya viene en la moneda nueva; lo que NO se mandó (costo o
    // precio sueltos, y los precios propios de las variantes) se convierte para no cambiar de valor.
    if (antes && safeData.moneda && safeData.moneda !== antes.moneda) {
      const cot = await cotizacionDefault(req.tenantId)
      if (!(cot > 0)) return reply.status(400).send({ error: 'sin_cotizacion', message: 'Para pasar precios a dólares (o de dólares a pesos) primero cargá la cotización del dólar.' })
      const conv = (n) => n == null ? n : (safeData.moneda === 'USD' ? Math.round(Number(n) / cot * 100) / 100 : Math.round(Number(n) * cot * 100) / 100)
      if (safeData.precioCosto === undefined) safeData.precioCosto = conv(antes.precioCosto)
      if (safeData.precioVenta === undefined) safeData.precioVenta = conv(antes.precioVenta)
      const vs = await prisma.productoVariante.findMany({ where: { productoId: req.params.id, tenantId: req.tenantId, OR: [{ precioCosto: { not: null } }, { precioVenta: { not: null } }] } })
      for (const v of vs) await prisma.productoVariante.update({ where: { id: v.id }, data: { precioCosto: conv(v.precioCosto), precioVenta: conv(v.precioVenta) } })
    }

    // Sin datos propios del producto (ej. solo cambia la ubicación) updateMany no toca ninguna
    // fila y daría count 0 aunque el producto exista — ahí se chequea que exista y listo.
    const result = Object.keys(safeData).length
      ? await prisma.producto.updateMany({ where: { id: req.params.id, tenantId: req.tenantId }, data: safeData })
      : { count: await prisma.producto.count({ where: { id: req.params.id, tenantId: req.tenantId } }) }
    if (result.count === 0) return reply.status(404).send({ error: 'not_found', message: 'Producto no encontrado.' })
    await guardarUbicaciones(prisma, req.tenantId, { productoId: req.params.id }, ubicaciones)

    if (antes && safeData.precioVenta !== undefined && Number(antes.precioVenta) !== Number(safeData.precioVenta)) {
      await registrarAuditoria({
        tenantId: req.tenantId, userId: req.user.id, req,
        accion: 'producto.precio', entidad: 'Producto', entidadId: req.params.id,
        detalle: { antes: antes.precioVenta, despues: safeData.precioVenta },
      })
    }

    return prisma.producto.findUnique({ where: { id: req.params.id } })
  })

  // ── POST /productos/:id/ingreso-stock ──────────────────────
  // Recepción de mercadería (alta manual o vía escaneo de código en Inventario): suma stock,
  // deja un Lote para trazabilidad de etiqueta y un MovimientoStock en el libro mayor.
  fastify.post('/productos/:id/ingreso-stock', {
    preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN', 'DEPOSITO'])],
  }, async (req, reply) => {
    const body = ingresoStockSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.issues[0].message })

    const producto = await prisma.producto.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } })
    if (!producto) return reply.status(404).send({ error: 'not_found', message: 'Producto no encontrado.' })

    const { cantidad, proveedor, observaciones, varianteId } = body.data
    // El costo de una recepción se carga en pesos; en un producto en dólares se guarda en dólares
    // (sin cotización no se puede convertir → no se toca el costo).
    let { precioCosto } = body.data
    if (precioCosto !== undefined && producto.moneda === 'USD') precioCosto = desdePesos(precioCosto, 'USD', await cotizacionDefault(req.tenantId)) ?? undefined
    const sucursalId = await resolverSucursalStock(prisma, req.tenantId, body.data.sucursalId, req.user)

    let variante = null
    if (varianteId) {
      variante = await prisma.productoVariante.findFirst({ where: { id: varianteId, productoId: producto.id, tenantId: req.tenantId } })
      if (!variante) return reply.status(404).send({ error: 'not_found', message: 'Variante no encontrada.' })
    }
    const result = await prisma.$transaction(async (tx) => {
      let p = producto, v = null
      const m = await moverStock(tx, { productoId: producto.id, varianteId: variante?.id, sucursalId, delta: cantidad })
      const nuevoStock = m.total
      if (variante) {
        v = precioCosto !== undefined
          ? await tx.productoVariante.update({ where: { id: variante.id }, data: { precioCosto } })
          : await tx.productoVariante.findUnique({ where: { id: variante.id } })
      } else {
        p = precioCosto !== undefined
          ? await tx.producto.update({ where: { id: producto.id }, data: { precioCosto } })
          : await tx.producto.findUnique({ where: { id: producto.id } })
      }
      // El lote (trazabilidad de la entrega física + vencimiento) siempre queda contra el
      // producto padre, independiente de qué variante puntual se haya escaneado — un lote
      // representa "llegó este envío", no el desglose de qué variantes traía.
      const lote = await tx.lote.create({
        data: {
          tenantId: req.tenantId,
          productoId: producto.id,
          nroLote: generarNroLote(),
          cantidad,
          cantDisponible: cantidad,
          proveedor,
          observaciones,
        },
      })
      await tx.movimientoStock.create({
        data: {
          tenantId: req.tenantId,
          productoId: producto.id,
          usuarioId: req.user.id,
          tipo: 'ENTRADA_COMPRA',
          cantidad,
          stockPost: nuevoStock,
          loteId: lote.id,
          sucursalId,
          referencia: variante
            ? `Recepción por código de barras (variante ${Object.values(variante.valores || {}).filter(Boolean).join('/') || variante.sku})`
            : 'Recepción por código de barras',
        },
      })
      return { producto: p, variante: v, lote, stockSucursal: m.sucursal, sucursalId }
    })

    return reply.status(201).send(result)
  })

  // ── GET /productos/:id/lotes ───────────────────────────────
  fastify.get('/productos/:id/lotes', auth, async (req) => {
    const { limit = 20 } = req.query
    return prisma.lote.findMany({
      where: { productoId: req.params.id, tenantId: req.tenantId },
      orderBy: { creadoEn: 'desc' },
      take: Number(limit),
    })
  })

  // ── GET /lotes/por-vencer ───────────────────────────────────
  // Para la campanita de alertas: lotes activos con stock disponible cuyo fechaVenc cae
  // dentro de la ventana pedida (default 30 días).
  fastify.get('/lotes/por-vencer', auth, async (req) => {
    const dias = Number(req.query.dias) || 30
    const limite = new Date(Date.now() + dias * 24 * 60 * 60 * 1000)
    return prisma.lote.findMany({
      where: { tenantId: req.tenantId, activo: true, cantDisponible: { gt: 0 }, fechaVenc: { not: null, lte: limite } },
      include: { producto: { select: { id: true, nombre: true } } },
      orderBy: { fechaVenc: 'asc' },
      take: 100,
    })
  })

  // ── PATCH /productos/bulk ──────────────────────────────────
  // Acciones masivas sobre varios productos a la vez: asignar categoría, aplicar margen/aumento
  // de precio, o setear vencimiento. margen/aumento van uno por uno en la misma transacción
  // porque necesitan leer precioCosto/precioVenta de cada producto (Prisma no permite
  // expresiones tipo "precioVenta = precioCosto * x" en un updateMany).
  fastify.patch('/productos/bulk', {
    preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN', 'DEPOSITO'])],
  }, async (req, reply) => {
    const body = bulkSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.issues[0].message })
    const { ids, accion, payload } = body.data

    if (accion === 'categoria') {
      const r = await prisma.producto.updateMany({
        where: { id: { in: ids }, tenantId: req.tenantId },
        data: { categoriaId: payload.categoriaId || null },
      })
      return { actualizados: r.count }
    }

    if (accion === 'vencimiento') {
      const r = await prisma.producto.updateMany({
        where: { id: { in: ids }, tenantId: req.tenantId },
        data: { vencimiento: normalizarFechaISO(payload.vencimiento) },
      })
      return { actualizados: r.count }
    }

    if (accion === 'reactivar') {
      const r = await prisma.producto.updateMany({
        where: { id: { in: ids }, tenantId: req.tenantId },
        data: { activo: true },
      })
      return { actualizados: r.count }
    }

    if (accion === 'margen' || accion === 'aumento') {
      const pct = Number(payload.pct)
      if (isNaN(pct)) return reply.status(400).send({ error: 'validation_error', message: 'Falta el porcentaje.' })
      const productos = await prisma.producto.findMany({ where: { id: { in: ids }, tenantId: req.tenantId } })
      let actualizados = 0
      await prisma.$transaction(async (tx) => {
        for (const p of productos) {
          const nuevoPrecio = accion === 'margen'
            ? Number(p.precioCosto) * (1 + pct / 100)
            : Number(p.precioVenta) * (1 + pct / 100)
          await tx.producto.update({ where: { id: p.id }, data: { precioVenta: Math.round(nuevoPrecio * 100) / 100 } })
          actualizados++
        }
      })
      return { actualizados }
    }

    return reply.status(400).send({ error: 'validation_error', message: 'Acción no reconocida.' })
  })

  // ── GET /productos/:id/variantes ───────────────────────────
  fastify.get('/productos/:id/variantes', auth, async (req) => {
    return prisma.productoVariante.findMany({
      where: { productoId: req.params.id, tenantId: req.tenantId, activo: true },
      orderBy: { creadoEn: 'asc' },
    })
  })

  // ── POST /productos/:id/variantes ──────────────────────────
  fastify.post('/productos/:id/variantes', {
    preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN', 'DEPOSITO'])],
  }, async (req, reply) => {
    const body = varianteSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.issues[0].message })

    const producto = await prisma.producto.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } })
    if (!producto) return reply.status(404).send({ error: 'not_found', message: 'Producto no encontrado.' })

    const skuExists = await prisma.productoVariante.findFirst({ where: { tenantId: req.tenantId, sku: body.data.sku } })
    if (skuExists) return reply.status(409).send({ error: 'sku_taken', message: 'El SKU de variante ya existe.' })

    const { sucursalId: sucPedida, stock: stockInicial, ubicaciones, ...datosVariante } = body.data
    const sucursalId = stockInicial ? await resolverSucursalStock(prisma, req.tenantId, sucPedida, req.user) : null
    const variante = await prisma.$transaction(async (tx) => {
      const v = await tx.productoVariante.create({
        data: { tenantId: req.tenantId, productoId: producto.id, ...datosVariante, stock: 0 },
      })
      await guardarUbicaciones(tx, req.tenantId, { productoId: producto.id, varianteId: v.id }, ubicaciones)
      if (!stockInicial) return v
      // marcarMovimiento:false — cargar stock al crearla no es "haberse movido" (igual no se
      // puede borrar mientras tenga stock).
      await moverStock(tx, { productoId: producto.id, varianteId: v.id, sucursalId, delta: stockInicial }, { marcarMovimiento: false })
      return { ...v, stock: stockInicial }
    })
    return reply.status(201).send(variante)
  })

  // ── PUT /productos/:id/variantes/:varianteId ───────────────
  fastify.put('/productos/:id/variantes/:varianteId', {
    preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN', 'DEPOSITO'])],
  }, async (req, reply) => {
    const body = parcial(varianteSchema).safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.issues[0].message })

    // `stock` acá es "lo que hay de esta variante en la sucursal" — se fija con
    // fijarStockSucursal (mueve la diferencia y el total se ajusta solo), nunca pisando el total.
    const { stock, sucursalId: sucPedida, ubicaciones, ...datos } = body.data
    const actual = await prisma.productoVariante.findFirst({ where: { id: req.params.varianteId, productoId: req.params.id, tenantId: req.tenantId } })
    if (!actual) return reply.status(404).send({ error: 'not_found', message: 'Variante no encontrada.' })
    await prisma.$transaction(async (tx) => {
      if (Object.keys(datos).length) await tx.productoVariante.update({ where: { id: actual.id }, data: datos })
      await guardarUbicaciones(tx, req.tenantId, { productoId: actual.productoId, varianteId: actual.id }, ubicaciones)
      if (stock !== undefined) {
        const sucursalId = await resolverSucursalStock(tx, req.tenantId, sucPedida, req.user)
        const f = await fijarStockSucursal(tx, { productoId: actual.productoId, varianteId: actual.id, sucursalId, valor: stock })
        if (f.delta !== 0) {
          await tx.movimientoStock.create({
            data: {
              tenantId: req.tenantId, productoId: actual.productoId, usuarioId: req.user.id,
              tipo: f.delta >= 0 ? 'ENTRADA_AJUSTE' : 'SALIDA_AJUSTE', cantidad: f.delta, stockPost: f.total, sucursalId,
              referencia: `Edición de variante ${Object.values(actual.valores || {}).filter(Boolean).join('/') || actual.sku}`,
            },
          })
        }
      }
    })
    return prisma.productoVariante.findUnique({ where: { id: req.params.varianteId } })
  })

  // ── PATCH /productos/:id/variantes/:varianteId/pausar ──────
  // Reemplaza al viejo "eliminar" para el caso normal: deja de venderse en el PoS pero se
  // puede reactivar en cualquier momento (ej. talle/color que por ahora no está entrando).
  fastify.patch('/productos/:id/variantes/:varianteId/pausar', {
    preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN', 'DEPOSITO'])],
  }, async (req, reply) => {
    const r = await prisma.productoVariante.updateMany({
      where: { id: req.params.varianteId, productoId: req.params.id, tenantId: req.tenantId },
      data: { activo: false },
    })
    if (r.count === 0) return reply.status(404).send({ error: 'not_found', message: 'Variante no encontrada.' })
    return { message: 'Variante pausada.' }
  })

  // ── PATCH /productos/:id/variantes/:varianteId/reactivar ───
  fastify.patch('/productos/:id/variantes/:varianteId/reactivar', {
    preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN', 'DEPOSITO'])],
  }, async (req, reply) => {
    const r = await prisma.productoVariante.updateMany({
      where: { id: req.params.varianteId, productoId: req.params.id, tenantId: req.tenantId },
      data: { activo: true },
    })
    if (r.count === 0) return reply.status(404).send({ error: 'not_found', message: 'Variante no encontrada.' })
    return { message: 'Variante reactivada.' }
  })

  // ── DELETE /productos/:id/variantes/:varianteId (eliminación real) ──
  // Solo se puede borrar de verdad si nunca tuvo stock ni se vendió — si no, hay que pausarla
  // (arriba) para no perder trazabilidad de algo que sí tuvo movimiento real.
  fastify.delete('/productos/:id/variantes/:varianteId', {
    preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN', 'DEPOSITO'])],
  }, async (req, reply) => {
    const variante = await prisma.productoVariante.findFirst({
      where: { id: req.params.varianteId, productoId: req.params.id, tenantId: req.tenantId },
    })
    if (!variante) return reply.status(404).send({ error: 'not_found', message: 'Variante no encontrada.' })
    if (variante.tuvoMovimiento || Number(variante.stock) > 0) {
      return reply.status(409).send({
        error: 'tiene_movimiento',
        message: 'Esta variante tiene stock cargado o ya tuvo ventas — no se puede eliminar. Pausala en vez de borrarla.',
      })
    }
    await prisma.productoVariante.delete({ where: { id: variante.id } })
    return { message: 'Variante eliminada.' }
  })

  // ── Talles/colores reutilizables (lista por tenant, no por producto) ──
  // Guardado en la tabla kv genérica (ConfiguracionEmpresa) pero con su propio endpoint —el
  // genérico GET/PUT /configuracion/kv es admin-only y esto lo necesita cualquiera que pueda
  // cargar productos/variantes (ADMIN o DEPOSITO).
  // ── Campos de variante configurables por tenant (Talle/Color/Tamaño por defecto, más lo que
  // cada tenant quiera agregar/ocultar — ver Configuración > Variantes) ──
  fastify.get('/productos/campos-variante', auth, async (req) => {
    await asegurarCamposVarianteDefault(req.tenantId)
    return prisma.campoVariante.findMany({ where: { tenantId: req.tenantId }, orderBy: { orden: 'asc' } })
  })

  fastify.post('/productos/campos-variante', {
    preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN', 'DEPOSITO'])],
  }, async (req, reply) => {
    const body = campoVarianteSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.issues[0].message })
    const clave = slugClave(body.data.label)
    const existe = await prisma.campoVariante.findUnique({ where: { tenantId_clave: { tenantId: req.tenantId, clave } } })
    if (existe) return reply.status(409).send({ error: 'clave_taken', message: 'Ya existe un campo con ese nombre.' })
    const max = await prisma.campoVariante.aggregate({ where: { tenantId: req.tenantId }, _max: { orden: true } })
    const campo = await prisma.campoVariante.create({
      data: { tenantId: req.tenantId, clave, label: body.data.label, opciones: '[]', orden: (max._max.orden ?? -1) + 1 },
    })
    return reply.status(201).send(campo)
  })

  fastify.put('/productos/campos-variante/:id', {
    preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN', 'DEPOSITO'])],
  }, async (req, reply) => {
    const body = z.object({
      label: z.string().min(1).max(40).optional(),
      activo: z.boolean().optional(),
      orden: z.number().int().optional(),
    }).safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.issues[0].message })
    const r = await prisma.campoVariante.updateMany({ where: { id: req.params.id, tenantId: req.tenantId }, data: body.data })
    if (r.count === 0) return reply.status(404).send({ error: 'not_found', message: 'Campo no encontrado.' })
    return prisma.campoVariante.findUnique({ where: { id: req.params.id } })
  })

  // Catálogo de valores sugeridos de un campo (el "+" de siempre, ej. agregar "XXL" a Talle) —
  // mismo mecanismo que antes tenía /opciones-variante, ahora genérico para cualquier campo.
  fastify.post('/productos/campos-variante/:id/opciones', {
    preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN', 'DEPOSITO'])],
  }, async (req, reply) => {
    const body = campoVarianteOpcionSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.issues[0].message })
    const campo = await prisma.campoVariante.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } })
    if (!campo) return reply.status(404).send({ error: 'not_found', message: 'Campo no encontrado.' })
    let lista = []
    try { lista = JSON.parse(campo.opciones || '[]') } catch (e) {}
    if (!lista.includes(body.data.valor)) lista.push(body.data.valor)
    const actualizado = await prisma.campoVariante.update({ where: { id: campo.id }, data: { opciones: JSON.stringify(lista) } })
    return reply.status(201).send(actualizado)
  })

  // ── PATCH /productos/variantes/bulk-crear ──────────────────
  // Crea el producto cartesiano de todos los campos cargados (ej. Talle×Color, o Peso×Gusto)
  // para cada producto seleccionado. Cualquier campo con lista vacía se omite de la combinación.
  fastify.patch('/productos/variantes/bulk-crear', {
    preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN', 'DEPOSITO'])],
  }, async (req, reply) => {
    const body = bulkCrearVariantesSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.issues[0].message })
    const { productoIds, campos } = body.data

    const claves = Object.keys(campos).filter(k => Array.isArray(campos[k]) && campos[k].length)
    if (!claves.length) return reply.status(400).send({ error: 'validation_error', message: 'Cargá al menos un valor en algún campo.' })

    // Producto cartesiano genérico de N listas (antes era 3 anidados fijos talle×color×tamano)
    let combinaciones = [{}]
    for (const clave of claves) {
      const siguiente = []
      for (const combo of combinaciones) {
        for (const valor of campos[clave]) {
          siguiente.push({ ...combo, [clave]: valor })
        }
      }
      combinaciones = siguiente
    }

    const productos = await prisma.producto.findMany({ where: { id: { in: productoIds }, tenantId: req.tenantId } })
    let creadas = 0
    const errores = []

    for (const producto of productos) {
      for (const combo of combinaciones) {
        const abrev = Object.values(combo).filter(Boolean).map(v => String(v).slice(0, 3).toUpperCase()).join('-')
        const sku = `${producto.sku}-${abrev}`
        try {
          await prisma.productoVariante.create({
            data: { tenantId: req.tenantId, productoId: producto.id, sku, valores: combo },
          })
          creadas++
        } catch (err) {
          errores.push(`${producto.nombre} — ${abrev}: ${err.code === 'P2002' ? 'SKU duplicado' : 'error al crear'}`)
        }
      }
    }
    return { creadas, errores }
  })

  // ── DELETE /productos/:id (soft delete) ───────────────────
  fastify.delete('/productos/:id', {
    preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN']), fastify.requirePermiso('inventario', 'eliminar')],
  }, async (req, reply) => {
    const result = await prisma.producto.updateMany({
      where: { id: req.params.id, tenantId: req.tenantId },
      data: { activo: false },
    })
    if (result.count === 0) return reply.status(404).send({ error: 'not_found', message: 'Producto no encontrado.' })
    return reply.status(200).send({ message: 'Producto desactivado.' })
  })

  // ── POST /productos/importar-excel/preview ────────────────
  // Sube un Excel/CSV, lo parsea y detecta automáticamente qué columna es cada campo.
  // No toca la base de datos — el cliente confirma después con /confirmar.
  fastify.post('/productos/importar-excel/preview', {
    preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN', 'DEPOSITO'])],
  }, async (req, reply) => {
    const data = await req.file()
    if (!data) return reply.status(400).send({ error: 'validation_error', message: 'No se recibió ningún archivo.' })
    const buffer = await data.toBuffer()

    let workbook
    try {
      workbook = XLSX.read(buffer, { type: 'buffer' })
    } catch (err) {
      return reply.status(400).send({ error: 'validation_error', message: 'No se pudo leer el archivo. ¿Es un Excel o CSV válido?' })
    }

    const sheet = workbook.Sheets[workbook.SheetNames[0]]
    const filasCrudas = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' })
    if (filasCrudas.length < 2) {
      return reply.status(400).send({ error: 'validation_error', message: 'El archivo no tiene filas de datos (sólo encabezado, o está vacío).' })
    }

    const headers = filasCrudas[0].map(h => String(h || '').trim()).filter(Boolean)
    const filas = filasCrudas.slice(1)
      .filter(fila => fila.some(c => String(c).trim() !== ''))
      .map(fila => Object.fromEntries(headers.map((h, i) => [h, fila[i]])))

    return {
      columnas: headers,
      mapeoDetectado: detectarMapeo(headers),
      filas,
      totalFilas: filas.length,
    }
  })

  // ── POST /productos/importar-excel/confirmar ──────────────
  // Crea productos nuevos y actualiza los existentes. Un existente se reconoce por SKU, o —si el
  // archivo no trae columna SKU (ej. una planilla de ubicaciones con solo el nombre)— por nombre
  // exacto. Al actualizar se tocan SOLO las columnas mapeadas (V2.105.1: antes una columna no
  // mapeada pisaba el precio con 0 y la unidad con "unidad"). Nunca pisa el stock de un producto
  // ya existente — sólo carga stock inicial en productos NUEVOS creados por la importación.
  fastify.post('/productos/importar-excel/confirmar', {
    preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN', 'DEPOSITO'])],
  }, async (req, reply) => {
    const body = confirmarImportSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.issues[0].message })
    const { mapeo, filas } = body.data
    const sucursalId = await resolverSucursalStock(prisma, req.tenantId, body.data.sucursalId, req.user)

    let creados = 0, actualizados = 0
    const errores = []
    const [skusProd, skusVar] = await Promise.all([
      prisma.producto.findMany({ where: { tenantId: req.tenantId }, select: { sku: true } }),
      prisma.productoVariante.findMany({ where: { tenantId: req.tenantId }, select: { sku: true } }),
    ])
    const skusUsados = new Set([...skusProd, ...skusVar].map((r) => r.sku))
    const monedas = { costo: body.data.monedaCosto || 'ARS', precio: body.data.monedaPrecio || 'ARS' }
    const cot = await cotizacionDefault(req.tenantId)

    // Categoría "Prensatelas > Singer": se busca nivel por nivel (sin importar mayúsculas) y se
    // crea lo que falte, con su número correlativo. Caché por ruta para no repetir consultas.
    const catCache = new Map()
    const categoriaDeRuta = async (ruta) => {
      const partes = String(ruta || '').split('>').map((x) => tituloCase(x.trim())).filter(Boolean).slice(0, CATEGORIA_MAX_NIVELES)
      if (!partes.length) return null
      let parentId = null, clave = ''
      for (const nombreCat of partes) {
        clave += '>' + nombreCat.toLowerCase()
        if (catCache.has(clave)) { parentId = catCache.get(clave); continue }
        let cat = await prisma.categoria.findFirst({ where: { tenantId: req.tenantId, parentId, nombre: { equals: nombreCat, mode: 'insensitive' } }, select: { id: true, activa: true } })
        if (cat && !cat.activa) await prisma.categoria.update({ where: { id: cat.id }, data: { activa: true } })
        if (!cat) {
          cat = await prisma.$transaction(async (tx) => {
            const t = await tx.tenant.update({ where: { id: req.tenantId }, data: { seqCategorias: { increment: 1 } }, select: { seqCategorias: true } })
            return tx.categoria.create({ data: { tenantId: req.tenantId, numero: t.seqCategorias, nombre: nombreCat, parentId }, select: { id: true } })
          })
        }
        catCache.set(clave, cat.id)
        parentId = cat.id
      }
      return parentId
    }

    for (let i = 0; i < filas.length; i++) {
      const fila = filas[i]
      const numeroFila = i + 2 // +1 por índice 0, +1 por la fila de encabezado
      try {
        const nombre = tituloCase(String(fila[mapeo.nombre] || '').trim())
        if (!nombre) { errores.push('Fila ' + numeroFila + ': sin nombre, se omitió.'); continue }

        let sku = mapeo.sku ? String(fila[mapeo.sku] || '').trim() : ''
        const skuDelArchivo = !!sku

        const precioCosto = mapeo.precioCosto ? parseNumero(fila[mapeo.precioCosto]) : 0
        const precioVenta = mapeo.precioVenta ? parseNumero(fila[mapeo.precioVenta]) : 0
        const stockInicial = mapeo.stock ? parseNumero(fila[mapeo.stock]) : 0
        const um = mapeo.um ? (String(fila[mapeo.um] || '').trim() || 'unidad') : 'unidad'
        const descripcionCorta = mapeo.descripcionCorta ? (String(fila[mapeo.descripcionCorta] || '').trim() || undefined) : undefined
        const descripcion = mapeo.descripcion ? (String(fila[mapeo.descripcion] || '').trim() || undefined) : undefined
        const codigoBarras = mapeo.codigoBarras ? (String(fila[mapeo.codigoBarras] || '').trim() || undefined) : undefined
        // Ubicación: solo los niveles mapeados y con valor — una celda vacía no borra lo que ya había.
        const ubic = { sucursalId }
        NIVELES_UBICACION.forEach((n) => { const v = mapeo[n] ? String(fila[mapeo[n]] ?? '').trim() : ''; if (v) ubic[n] = v })
        const ubicaciones = sucursalId && Object.keys(ubic).length > 1 ? [ubic] : null

        let existente
        if (skuDelArchivo) {
          existente = await prisma.producto.findFirst({ where: { tenantId: req.tenantId, sku } })
        } else {
          // Sin SKU: por nombre (el mismo tituloCase con el que se guardó). Activos primero; si hay
          // más de uno con ese nombre no se adivina cuál es.
          const porNombre = await prisma.producto.findMany({
            where: { tenantId: req.tenantId, nombre: { equals: nombre, mode: 'insensitive' } },
            orderBy: { activo: 'desc' }, select: { id: true, activo: true, moneda: true, precioCosto: true, precioVenta: true }, take: 3,
          })
          const activos = porNombre.filter((p) => p.activo)
          if (activos.length > 1 || (!activos.length && porNombre.length > 1)) {
            errores.push('Fila ' + numeroFila + ': hay más de un producto llamado "' + nombre + '" — agregá la columna SKU para distinguirlos.'); continue
          }
          existente = porNombre[0] || null
        }

        const moneda = monedaImportada(mapeo, monedas, existente)
        const categoriaId = mapeo.categoria && String(fila[mapeo.categoria] ?? '').trim() ? await categoriaDeRuta(fila[mapeo.categoria]) : undefined

        if (existente) {
          // Solo lo que vino mapeado en el archivo; el nombre se reescribe solo si se encontró por SKU.
          const data = {}
          if (skuDelArchivo) data.nombre = nombre
          if (mapeo.descripcionCorta) data.descripcionCorta = descripcionCorta
          if (mapeo.descripcion) data.descripcion = descripcion
          if (mapeo.precioCosto) data.precioCosto = convertirMoneda(precioCosto, monedas.costo, moneda, cot)
          if (mapeo.precioVenta) data.precioVenta = convertirMoneda(precioVenta, monedas.precio, moneda, cot)
          if (categoriaId) data.categoriaId = categoriaId
          // Cambia de moneda: lo que no vino en el archivo (y los precios propios de las variantes)
          // se convierte para que no cambie de valor.
          if (moneda !== (existente.moneda || 'ARS')) {
            data.moneda = moneda
            if (!mapeo.precioCosto) data.precioCosto = convertirMoneda(existente.precioCosto, existente.moneda, moneda, cot)
            if (!mapeo.precioVenta) data.precioVenta = convertirMoneda(existente.precioVenta, existente.moneda, moneda, cot)
            const vs = await prisma.productoVariante.findMany({ where: { productoId: existente.id, OR: [{ precioCosto: { not: null } }, { precioVenta: { not: null } }] } })
            for (const v of vs) await prisma.productoVariante.update({ where: { id: v.id }, data: { precioCosto: convertirMoneda(v.precioCosto, existente.moneda, moneda, cot), precioVenta: convertirMoneda(v.precioVenta, existente.moneda, moneda, cot) } })
          }
          if (mapeo.um) data.um = um
          if (mapeo.codigoBarras) data.codigoBarras = codigoBarras
          if (Object.keys(data).length) await prisma.producto.update({ where: { id: existente.id }, data })
          await guardarUbicaciones(prisma, req.tenantId, { productoId: existente.id }, ubicaciones)
          actualizados++
        } else if (body.data.soloActualizar) {
          errores.push('Fila ' + numeroFila + ': "' + nombre + '" no está cargado — se salteó (no se crean productos nuevos).')
        } else {
          if (!skuDelArchivo) sku = siguienteSkuLibre(abreviarSku(nombre), skusUsados)
          else skusUsados.add(sku)
          // Antes no incrementaba seqProductos como sí hace POST /productos (línea ~311) — todo
          // producto creado por esta vía quedaba con numero:0, la causa real de la columna "#"
          // rota en Inventario (ver bug real encontrado en prod, hoy corregido acá).
          await prisma.$transaction(async (tx) => {
            const t = await tx.tenant.update({
              where: { id: req.tenantId },
              data: { seqProductos: { increment: 1 } },
              select: { seqProductos: true },
            })
            const p = await tx.producto.create({
              data: {
                tenantId: req.tenantId, numero: t.seqProductos, sku, nombre, descripcionCorta, descripcion, stock: 0, um, codigoBarras, moneda,
                precioCosto: convertirMoneda(precioCosto, monedas.costo, moneda, cot),
                precioVenta: convertirMoneda(precioVenta, monedas.precio, moneda, cot),
                ...(categoriaId && { categoriaId }),
              },
            })
            if (stockInicial > 0) {
              await moverStock(tx, { productoId: p.id, sucursalId, delta: stockInicial })
              await tx.movimientoStock.create({
                data: {
                  tenantId: req.tenantId, productoId: p.id, usuarioId: req.user.id,
                  tipo: 'ENTRADA_INICIAL', cantidad: stockInicial, stockPost: stockInicial, sucursalId,
                  referencia: 'Importación masiva desde Excel',
                },
              })
            }
            await guardarUbicaciones(tx, req.tenantId, { productoId: p.id }, ubicaciones)
          })
          creados++
        }
      } catch (err) {
        if (err.code === 'SIN_COT') return reply.status(400).send({ error: 'sin_cotizacion', message: 'Para importar con una columna en otra moneda primero cargá la cotización del dólar (no se importó nada a partir de la fila ' + numeroFila + ').', creados, actualizados, errores })
        errores.push('Fila ' + numeroFila + ': ' + (err.code === 'P2002' ? 'SKU o código de barras duplicado.' : 'error al guardar.'))
      }
    }

    return { creados, actualizados, errores, totalProcesadas: filas.length }
  })

  // ── GET /productos/categorias ─────────────────────────────
  // incluirInactivas=true: para la pantalla de gestión (Inventario → Categorías); el combo
  // de alta de producto sigue llamando sin el param y solo ve las activas.
  // Devuelve plana (con parentId) — el árbol se arma en el frontend — más productosCount
  // (cantidad de productos asignados DIRECTAMENTE a esa categoría; el acumulado por rama se
  // suma en el frontend recorriendo el árbol).
  fastify.get('/categorias', auth, async (req) => {
    const { incluirInactivas } = req.query
    const [cats, conteos] = await Promise.all([
      prisma.categoria.findMany({
        where: { tenantId: req.tenantId, ...(incluirInactivas !== 'true' && { activa: true }) },
        orderBy: { numero: 'asc' },
      }),
      prisma.producto.groupBy({
        by: ['categoriaId'],
        where: { tenantId: req.tenantId, categoriaId: { not: null } },
        _count: true,
      }),
    ])
    const conteoPorId = Object.fromEntries(conteos.map((c) => [c.categoriaId, c._count]))
    return cats.map((c) => ({ ...c, productosCount: conteoPorId[c.id] || 0 }))
  })

  // Profundidad máxima de la jerarquía: 4 niveles (rubro → marca → categoría → sub-categoría).
  const CATEGORIA_MAX_NIVELES = 4
  async function categoriaProfundidad(tenantId, categoriaId) {
    let profundidad = 1
    let actual = categoriaId
    while (actual) {
      const c = await prisma.categoria.findFirst({ where: { id: actual, tenantId }, select: { parentId: true } })
      if (!c) break
      if (!c.parentId) break
      profundidad += 1
      actual = c.parentId
    }
    return profundidad
  }

  // ── POST /categorias ──────────────────────────────────────
  fastify.post('/categorias', {
    preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN'])],
  }, async (req, reply) => {
    let { nombre, descripcion, color, parentId } = req.body || {}
    if (!nombre) return reply.status(400).send({ error: 'validation_error', message: 'Nombre requerido.' })
    nombre = tituloCase(nombre)

    if (parentId) {
      const padre = await prisma.categoria.findFirst({ where: { id: parentId, tenantId: req.tenantId } })
      if (!padre) return reply.status(400).send({ error: 'validation_error', message: 'Categoría padre no encontrada.' })
      const profundidadPadre = await categoriaProfundidad(req.tenantId, parentId)
      if (profundidadPadre >= CATEGORIA_MAX_NIVELES) {
        return reply.status(400).send({ error: 'validation_error', message: 'Se alcanzó el máximo de ' + CATEGORIA_MAX_NIVELES + ' niveles.' })
      }
    }

    const existente = await prisma.categoria.findFirst({ where: { tenantId: req.tenantId, parentId: parentId || null, nombre: { equals: nombre, mode: 'insensitive' } } })
    if (existente) return reply.status(409).send({ error: 'nombre_duplicado', message: 'Ya existe una categoría con ese nombre en el mismo nivel.' })

    const cat = await prisma.$transaction(async (tx) => {
      const t = await tx.tenant.update({
        where: { id: req.tenantId },
        data: { seqCategorias: { increment: 1 } },
        select: { seqCategorias: true },
      })
      return tx.categoria.create({
        data: { tenantId: req.tenantId, numero: t.seqCategorias, nombre, descripcion, color, parentId: parentId || null },
      })
    })
    return reply.status(201).send(cat)
  })

  // ── PUT /categorias/:id ────────────────────────────────────
  fastify.put('/categorias/:id', {
    preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN'])],
  }, async (req, reply) => {
    let { nombre, descripcion, color, activa } = req.body || {}
    if (nombre !== undefined && !nombre) return reply.status(400).send({ error: 'validation_error', message: 'Nombre requerido.' })
    if (nombre !== undefined) {
      nombre = tituloCase(nombre)
      const actual = await prisma.categoria.findFirst({ where: { id: req.params.id, tenantId: req.tenantId }, select: { parentId: true } })
      const dup = await prisma.categoria.findFirst({ where: { tenantId: req.tenantId, parentId: actual?.parentId || null, nombre: { equals: nombre, mode: 'insensitive' }, id: { not: req.params.id } } })
      if (dup) return reply.status(409).send({ error: 'nombre_duplicado', message: 'Ya existe una categoría con ese nombre en el mismo nivel.' })
    }

    const r = await prisma.categoria.updateMany({
      where: { id: req.params.id, tenantId: req.tenantId },
      data: {
        ...(nombre !== undefined && { nombre }),
        ...(descripcion !== undefined && { descripcion }),
        ...(color !== undefined && { color }),
        ...(activa !== undefined && { activa }),
      },
    })
    if (r.count === 0) return reply.status(404).send({ error: 'not_found', message: 'Categoría no encontrada.' })
    return prisma.categoria.findUnique({ where: { id: req.params.id } })
  })

  // ── DELETE /categorias/:id ─────────────────────────────────
  fastify.delete('/categorias/:id', {
    preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN'])],
  }, async (req, reply) => {
    const r = await prisma.categoria.updateMany({
      where: { id: req.params.id, tenantId: req.tenantId },
      data: { activa: false },
    })
    if (r.count === 0) return reply.status(404).send({ error: 'not_found', message: 'Categoría no encontrada.' })
    return { message: 'Categoría desactivada.' }
  })

  // ── PATCH /categorias/reactivar-masivo ─────────────────────
  fastify.patch('/categorias/reactivar-masivo', {
    preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN'])],
  }, async (req, reply) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : []
    if (!ids.length) return reply.status(400).send({ error: 'validation_error', message: 'Sin categorías seleccionadas.' })
    const r = await prisma.categoria.updateMany({ where: { id: { in: ids }, tenantId: req.tenantId }, data: { activa: true } })
    return { message: r.count + ' categoría(s) reactivada(s).', actualizadas: r.count }
  })

  // ── Costo recordado por proveedor ("le compro a A cuando tiene stock, a B si no") ──────────
  // GET /productos/:id/proveedores-costo
  fastify.get('/productos/:id/proveedores-costo', auth, async (req) => {
    return prisma.productoProveedor.findMany({
      where: { productoId: req.params.id, tenantId: req.tenantId },
      include: { proveedor: { select: { id: true, nombre: true } } },
      orderBy: { actuEn: 'desc' },
    })
  })

  // ── PUT /productos/:id/proveedores-costo/:proveedorId ─────
  // Alta/edición manual (no hace falta haber comprado antes) del costo recordado de un
  // proveedor puntual. `preferido:true` lo marca como la fuente vigente del costo del
  // producto — selección única (desmarca cualquier otro proveedor de este producto) — y
  // actualiza Producto.precioCosto al toque, mismo efecto que recibir una Orden de Compra.
  fastify.put('/productos/:id/proveedores-costo/:proveedorId', {
    preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN', 'DEPOSITO'])],
  }, async (req, reply) => {
    const body = productoProveedorSchema.safeParse(req.body)
    if (!body.success) return reply.status(400).send({ error: 'validation_error', message: body.error.issues[0].message })

    const producto = await prisma.producto.findFirst({ where: { id: req.params.id, tenantId: req.tenantId } })
    if (!producto) return reply.status(404).send({ error: 'not_found', message: 'Producto no encontrado.' })
    const proveedor = await prisma.proveedor.findFirst({ where: { id: req.params.proveedorId, tenantId: req.tenantId } })
    if (!proveedor) return reply.status(404).send({ error: 'not_found', message: 'Proveedor no encontrado.' })

    const { ultimoCosto, preferido } = body.data

    const result = await prisma.$transaction(async (tx) => {
      const row = await tx.productoProveedor.upsert({
        where: { tenantId_productoId_proveedorId: { tenantId: req.tenantId, productoId: producto.id, proveedorId: proveedor.id } },
        update: { ultimoCosto, ...(preferido !== undefined && { preferido }) },
        create: { tenantId: req.tenantId, productoId: producto.id, proveedorId: proveedor.id, ultimoCosto, preferido: !!preferido },
      })
      if (preferido) {
        await tx.productoProveedor.updateMany({
          where: { tenantId: req.tenantId, productoId: producto.id, proveedorId: { not: proveedor.id } },
          data: { preferido: false },
        })
        // El costo por proveedor está en pesos; en un producto en dólares se pasa a dólares.
        const costo = producto.moneda === 'USD' ? desdePesos(ultimoCosto, 'USD', await cotizacionDefault(req.tenantId, tx)) : ultimoCosto
        if (costo != null) await tx.producto.update({ where: { id: producto.id }, data: { precioCosto: costo } })
      }
      return row
    })
    return result
  })

  // ── DELETE /productos/:id/proveedores-costo/:proveedorId ──
  fastify.delete('/productos/:id/proveedores-costo/:proveedorId', {
    preHandler: [fastify.verifyJWT, fastify.verifyTenant, fastify.requireRole(['ADMIN', 'DEPOSITO'])],
  }, async (req, reply) => {
    const r = await prisma.productoProveedor.deleteMany({
      where: { productoId: req.params.id, proveedorId: req.params.proveedorId, tenantId: req.tenantId },
    })
    if (r.count === 0) return reply.status(404).send({ error: 'not_found', message: 'No encontrado.' })
    return { message: 'Eliminado.' }
  })
}
