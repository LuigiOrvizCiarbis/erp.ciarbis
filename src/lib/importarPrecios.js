// ─────────────────────────────────────────────────────────────
//  Importar precios desde Excel a una o varias listas (V2.110.0)
//
//  Pedido: el cliente manda 2 Excel (Consumidor Final y Farmacias) con precios redondeados a
//  mano. Se cargan en 3 pasos: subir y elegir a qué lista va cada archivo (y si viene "+IVA") →
//  revisar (qué producto matcheó, precio actual → nuevo, avisos) → confirmar.
//
//  SOLO toca precios: nunca stock, costo, nombre ni categoría.
//   - Lista principal → Producto.precioVenta (o el de la variante si el SKU es de una variante)
//     y precioManual=true, así un recálculo automático desde el costo no pisa el redondeo.
//   - Lista secundaria → una regla MANUAL por producto (precio fijo, sin redondeo de lista).
//  Match: SKU / código de barras (producto o variante) → nombre exacto (sin tildes ni mayúsculas)
//  → nombre parecido (único candidato, viene destildado para que lo confirme una persona).
// ─────────────────────────────────────────────────────────────

import { prisma as prismaDefault } from './prisma.js'
import { cotizacionDefault, aPesos, desdePesos } from './moneda.js'
import { cargarConfigListas, invalidarListas, precioListaPesos } from './listasPrecio.js'

export function normalizarTexto(s) {
  return String(s == null ? '' : s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

// "41500", 41500, "$ 41.500", "41.500,50", "41,500.50" → número; null si no se entiende.
export function parsearPrecio(v) {
  if (typeof v === 'number') return isFinite(v) && v >= 0 ? Math.round(v * 100) / 100 : null
  let s = String(v == null ? '' : v).replace(/[^\d.,-]/g, '')
  if (!s) return null
  const ultComa = s.lastIndexOf(','), ultPunto = s.lastIndexOf('.')
  if (ultComa > -1 && ultPunto > -1) {
    // el último separador es el decimal
    s = ultComa > ultPunto ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '')
  } else if (ultComa > -1) {
    s = /,\d{1,2}$/.test(s) ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '')
  } else if (ultPunto > -1 && !/\.\d{1,2}$/.test(s)) {
    s = s.replace(/\./g, '') // "41.500" = miles
  }
  const n = Number(s)
  return isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null
}

function textoCelda(v) {
  if (v == null) return ''
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v)
  return String(v).trim()
}

const AVISO_CAMBIO_PCT = 50

// Precio actual (en pesos) de un producto/variante en una lista.
function precioActual(cfg, lista, prod, variante, cot) {
  const pvProd = Number(aPesos(prod.precioVenta, prod.moneda, cot) || 0)
  const pv = variante && variante.precioVenta != null ? Number(aPesos(variante.precioVenta, prod.moneda, cot) || 0) : pvProd
  if (!lista || lista.esDefault) return pv
  const pc = Number(aPesos(prod.precioCosto, prod.moneda, cot) || 0)
  return precioListaPesos(cfg, lista, prod, pv, pc)
}

// archivos: [{ listaId, masIva, mapeo: {sku, nombre, precio}, filas: [{col: valor}] }]
export async function revisarImportPrecios(tenantId, archivos, db) {
  const d = db || prismaDefault
  const cfg = await cargarConfigListas(tenantId, d)
  const prods = await d.producto.findMany({
    where: { tenantId, activo: true },
    select: {
      id: true, sku: true, codigoBarras: true, nombre: true, moneda: true, precioVenta: true, precioCosto: true,
      impuesto: true, categoriaId: true, proveedorId: true,
      variantes: { where: { activo: true }, select: { id: true, sku: true, codigoBarras: true, precioVenta: true, valores: true } },
    },
  })
  const cot = prods.some((p) => p.moneda === 'USD') ? await cotizacionDefault(tenantId, d) : 0

  const porCodigo = new Map() // sku / código de barras → {prod, variante}
  const porNombre = new Map() // nombre normalizado → [prod]
  const nombresNorm = []
  for (const p of prods) {
    if (p.sku) porCodigo.set(String(p.sku).trim().toLowerCase(), { prod: p, variante: null })
    if (p.codigoBarras && !porCodigo.has(String(p.codigoBarras).trim().toLowerCase())) porCodigo.set(String(p.codigoBarras).trim().toLowerCase(), { prod: p, variante: null })
    for (const v of p.variantes) {
      for (const c of [v.sku, v.codigoBarras]) {
        const k = c && String(c).trim().toLowerCase()
        if (k && !porCodigo.has(k)) porCodigo.set(k, { prod: p, variante: v })
      }
    }
    const n = normalizarTexto(p.nombre)
    if (!porNombre.has(n)) porNombre.set(n, [])
    porNombre.get(n).push(p)
    nombresNorm.push([n, p])
  }

  const out = []
  for (const a of archivos) {
    const lista = cfg.listas.find((l) => l.id === a.listaId)
    if (!lista) throw Object.assign(new Error('Una de las listas elegidas no existe o está desactivada.'), { statusCode: 400 })
    const mapeo = a.mapeo || {}
    const vistos = new Map()
    const items = []
    const resumen = { total: 0, matchean: 0, sinMatch: 0, aConfirmar: 0, cambian: 0, iguales: 0, conAviso: 0, invalidos: 0 }
    ;(a.filas || []).forEach((fila, i) => {
      const skuExcel = mapeo.sku ? textoCelda(fila[mapeo.sku]) : ''
      const nombreExcel = mapeo.nombre ? textoCelda(fila[mapeo.nombre]) : ''
      if (!skuExcel && !nombreExcel) return // fila vacía
      resumen.total++
      const precio = parsearPrecio(fila[mapeo.precio])
      const item = { fila: i + 2, skuExcel, nombreExcel, precio, avisos: [], match: null, incluir: false }

      let m = skuExcel ? porCodigo.get(skuExcel.toLowerCase()) : null
      if (m) item.match = 'codigo'
      if (!m && nombreExcel) {
        const n = normalizarTexto(nombreExcel)
        const exactos = porNombre.get(n) || []
        if (exactos.length === 1) { m = { prod: exactos[0], variante: null }; item.match = 'nombre' }
        else if (exactos.length > 1) item.avisos.push('Hay ' + exactos.length + ' productos con ese mismo nombre: no se puede saber cuál es.')
        else if (n.length >= 6) {
          const cand = nombresNorm.filter(([pn]) => pn.includes(n) || n.includes(pn))
          if (cand.length === 1) { m = { prod: cand[0][1], variante: null }; item.match = 'parecido' }
        }
      }

      if (precio == null) { item.avisos.push('El precio no es un número.'); resumen.invalidos++ }
      if (m) {
        const { prod, variante } = m
        item.productoId = prod.id
        item.varianteId = variante ? variante.id : null
        item.nombreSistema = prod.nombre + (variante ? ' — ' + Object.values(variante.valores || {}).join(' / ') : '')
        item.skuSistema = variante ? variante.sku : prod.sku
        item.moneda = prod.moneda
        item.impuesto = Number(prod.impuesto)
        item.actual = precioActual(cfg, lista, prod, variante, cot)
        if (variante && !lista.esDefault) item.avisos.push('Es una variante: en esta lista el precio se aplica al producto entero.')
        if (prod.moneda === 'USD' && lista.esDefault && !(cot > 0)) item.avisos.push('Producto en U$D sin cotización cargada: no se puede actualizar.')
        const clave = (variante && lista.esDefault ? variante.id : prod.id)
        if (vistos.has(clave)) item.avisos.push('Repetido: ya aparece en la fila ' + vistos.get(clave) + ' (queda la última).')
        vistos.set(clave, item.fila)
        if (precio != null && item.actual > 0 && Math.abs(precio / item.actual - 1) * 100 > AVISO_CAMBIO_PCT) {
          item.avisos.push('Cambia más de ' + AVISO_CAMBIO_PCT + '% (' + Math.round((precio / item.actual - 1) * 100) + '%). ¿Está bien?')
        }
        if (precio != null && Math.round(precio * 100) === Math.round(Number(item.actual) * 100) && lista.masIva === !!a.masIva) resumen.iguales++
        else if (precio != null) resumen.cambian++
        if (item.match === 'parecido') resumen.aConfirmar++
        resumen.matchean++
        // Se tilda solo lo seguro: match por código o nombre exacto, con precio válido y sin
        // problemas que impidan guardarlo. Lo "parecido" lo confirma una persona.
        item.incluir = precio != null && item.match !== 'parecido' &&
          !item.avisos.some((x) => x.startsWith('Producto en U$D'))
      } else {
        resumen.sinMatch++
        item.avisos.unshift('No se encontró en el sistema (ni por SKU ni por nombre).')
      }
      if (item.avisos.length) resumen.conAviso++
      items.push(item)
    })
    out.push({
      listaId: lista.id, listaNombre: lista.nombre, esPrincipal: !!lista.esDefault,
      masIva: !lista.esDefault && !!a.masIva, masIvaActual: !!lista.masIva, items, resumen,
    })
  }
  return out
}

// archivos: [{ listaId, masIva, items: [{ productoId, varianteId, precio }] }]
export async function confirmarImportPrecios(tenantId, archivos, db) {
  const d = db || prismaDefault
  const cfg = await cargarConfigListas(tenantId, d)
  const ids = [...new Set(archivos.flatMap((a) => a.items.map((i) => i.productoId)))]
  const prods = await d.producto.findMany({
    where: { tenantId, id: { in: ids } },
    select: { id: true, moneda: true, variantes: { select: { id: true } } },
  })
  const prodMap = new Map(prods.map((p) => [p.id, p]))
  const cot = prods.some((p) => p.moneda === 'USD') ? await cotizacionDefault(tenantId, d) : 0
  const resultado = []

  for (const a of archivos) {
    const lista = cfg.listas.find((l) => l.id === a.listaId)
    if (!lista) throw Object.assign(new Error('Una de las listas elegidas no existe o está desactivada.'), { statusCode: 400 })
    let actualizados = 0, salteados = 0
    if (!lista.esDefault && !!a.masIva !== !!lista.masIva) {
      await d.listaPrecio.update({ where: { id: lista.id }, data: { masIva: !!a.masIva } })
    }
    // Reglas MANUAL existentes de esta lista (por producto) para actualizar en vez de duplicar.
    const reglasProd = new Map(
      (lista.reglas || []).filter((r) => r.productoId && !r.categoriaId && !r.proveedorId).map((r) => [r.productoId, r]),
    )
    for (let i = 0; i < a.items.length; i += 100) {
      const tanda = a.items.slice(i, i + 100)
      await d.$transaction(async (tx) => {
        for (const it of tanda) {
          const p = prodMap.get(it.productoId)
          const precio = Number(it.precio)
          if (!p || !(precio >= 0)) { salteados++; continue }
          if (lista.esDefault) {
            const enMoneda = desdePesos(precio, p.moneda, cot)
            if (enMoneda == null) { salteados++; continue }
            if (it.varianteId && p.variantes.some((v) => v.id === it.varianteId)) {
              await tx.productoVariante.update({ where: { id: it.varianteId }, data: { precioVenta: enMoneda } })
              await tx.producto.update({ where: { id: p.id }, data: { precioManual: true } })
            } else {
              await tx.producto.update({ where: { id: p.id }, data: { precioVenta: enMoneda, precioManual: true } })
            }
          } else {
            const data = { tipo: 'MANUAL', valor: precio, margenPct: 0 }
            const ex = reglasProd.get(p.id)
            if (ex) await tx.listaPrecioMargen.update({ where: { id: ex.id }, data })
            else {
              const r = await tx.listaPrecioMargen.create({ data: { tenantId, listaPrecioId: lista.id, productoId: p.id, ...data } })
              reglasProd.set(p.id, r)
            }
          }
          actualizados++
        }
      }, { timeout: 60000 })
    }
    resultado.push({ listaId: lista.id, listaNombre: lista.nombre, actualizados, salteados, masIva: !lista.esDefault && !!a.masIva })
  }
  invalidarListas(tenantId)
  return resultado
}
