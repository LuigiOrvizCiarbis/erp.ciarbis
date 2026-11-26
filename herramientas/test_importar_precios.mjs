// Test de punta a punta de "Actualizar precios desde Excel" + listas +IVA (V2.110.0).
// Uso: node herramientas/test_importar_precios.mjs <baseUrl> <excelConsFinal> <excelFarmacias>
// Corre contra un server LOCAL con base de prueba: crea una empresa nueva, no toca otras.
import fs from 'node:fs'
import path from 'node:path'

const [BASE = 'http://127.0.0.1:4010', XCF, XFA] = process.argv.slice(2)
let token = ''
let ok = 0, fail = 0
const check = (cond, msg) => { if (cond) { ok++; console.log('  ✓', msg) } else { fail++; console.log('  ✗', msg) } }
async function api(method, url, body) {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(token && { Authorization: 'Bearer ' + token }) }, body: body ? JSON.stringify(body) : undefined })
  const t = await r.text()
  try {
    const j = JSON.parse(t)
    return Array.isArray(j) ? Object.assign(j, { status: r.status }) : { status: r.status, ...j }
  } catch { return { status: r.status, raw: t } }
}
async function upload(file) {
  const fd = new FormData()
  fd.append('file', new Blob([fs.readFileSync(file)]), path.basename(file))
  const r = await fetch(BASE + '/api/v1/productos/importar-excel/preview', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd })
  return r.json()
}
const lista = (r) => r.data || r

const email = 'qa.precios.' + Date.now() + '@example.com'
const pass = 'QaPrecios2026!'
let r = await api('POST', '/api/v1/auth/register', { empresa: 'Veterini QA ' + Date.now(), nombre: 'QA', email, password: pass })
check(r.status < 300, 'registro empresa de prueba (' + r.status + ')')
r = await api('POST', '/api/v1/auth/login', { email, password: pass })
token = r.token || r.accessToken || (r.data && r.data.token)
check(!!token, 'login')

// 1) Productos de base: los 21 del Excel, creados con precio viejo y stock 7.
const pcf = await upload(XCF)
const pfa = await upload(XFA)
check(pcf.totalFilas === 21 && pfa.totalFilas === 21, 'preview lee 21 filas en cada Excel')
let creados = 0
for (const f of pcf.filas) {
  const x = await api('POST', '/api/v1/productos', { sku: String(f.Sku), nombre: f.Producto, precioVenta: 1000, precioCosto: 500, stock: 7 })
  if (x.id) creados++
}
check(creados === 21, 'creados 21 productos (' + creados + ')')
const nombreUno = pcf.filas[0].Producto
check(/Anticaída/.test(nombreUno), 'el Excel trae la tilde bien ("' + nombreUno + '")')

// 2) Lista Farmacias +IVA con redondeo a $100 (el import tiene que ignorarlo: precio MANUAL exacto)
let listas = lista(await api('GET', '/api/v1/listas-precio'))
const principal = listas.find((l) => l.esDefault)
const farm = await api('POST', '/api/v1/listas-precio', { nombre: 'Farmacias', base: 'PRINCIPAL', masIva: true, redondeo: 100 })
check(farm.id && farm.masIva === true, 'lista Farmacias creada con masIva')

// 3) Revisar
const archivos = [
  { listaId: principal.id, masIva: false, mapeo: { sku: 'Sku', nombre: 'Producto', precio: 'Precio' }, filas: pcf.filas },
  { listaId: farm.id, masIva: true, mapeo: { sku: 'sku', nombre: 'Producto', precio: 'Precio' }, filas: pfa.filas },
]
r = await api('POST', '/api/v1/productos/importar-precios/revisar', { archivos })
check(r.status === 200 && r.archivos?.length === 2, 'revisar responde 2 archivos (' + r.status + ' ' + (r.message || '') + ')')
const [rcf, rfa] = r.archivos || [[], []]
check(rcf.resumen.matchean === 21 && rfa.resumen.matchean === 21, 'los 21 matchean por SKU en ambas listas')
check(rcf.items.every((i) => i.incluir) && rfa.items.every((i) => i.incluir), 'todos vienen tildados')
check(rcf.items[0].actual === 1000 && rcf.items[0].precio === 41500, 'CF fila 1: actual 1000 → nuevo 41500')

// revisar con misma lista 2 veces → 400
const dup = await api('POST', '/api/v1/productos/importar-precios/revisar', { archivos: [archivos[0], { ...archivos[1], listaId: principal.id }] })
check(dup.status === 400, 'misma lista en 2 archivos → 400')

// stock antes
const antes = lista(await api('GET', '/api/v1/productos?limit=100'))
const stockAntes = antes.reduce((s, p) => s + Number(p.stock), 0)

// 4) Confirmar
const conf = await api('POST', '/api/v1/productos/importar-precios/confirmar', {
  archivos: r.archivos.map((a) => ({ listaId: a.listaId, masIva: a.masIva, items: a.items.filter((i) => i.incluir).map((i) => ({ productoId: i.productoId, varianteId: i.varianteId, precio: i.precio })) })),
})
check(conf.status === 200 && conf.listas?.every((l) => l.actualizados === 21), 'confirmar: 21 + 21 actualizados (' + JSON.stringify(conf.listas || conf.message) + ')')

const desp = lista(await api('GET', '/api/v1/productos?limit=100'))
const stockDesp = desp.reduce((s, p) => s + Number(p.stock), 0)
check(stockAntes === stockDesp && stockDesp === 21 * 7, 'stock intacto (' + stockAntes + ' → ' + stockDesp + ')')
check(desp.every((p) => Number(p.precioCosto) === 500), 'costos intactos')
const bySku = new Map(desp.map((p) => [p.sku, p]))
let okCF = 0, okFA = 0
for (const f of pcf.filas) { const p = bySku.get(String(f.Sku)); if (p && Number(p.precioVenta) === f.Precio && p.precioManual) okCF++ }
for (const f of pfa.filas) { const p = bySku.get(String(f.sku)); if (p && Number(p.preciosListas?.[farm.id]) === f.Precio) okFA++ }
check(okCF === 21, 'CF: 21 precios exactos + precio manual (' + okCF + ')')
check(okFA === 21, 'Farmacias: 21 precios exactos aunque la lista redondea a $100 (' + okFA + ')')
listas = lista(await api('GET', '/api/v1/listas-precio'))
check(listas.find((l) => l.id === farm.id)?.masIva === true, 'Farmacias sigue +IVA')

// 5) IVA por producto (masivo) e IVA por defecto
const p1 = bySku.get(String(pfa.filas[0].sku))
check(Number(p1.impuesto) === 21, 'IVA por defecto del producto = 21')
r = await api('PATCH', '/api/v1/productos/bulk', { ids: [p1.id], accion: 'iva', payload: { iva: 10.5 } })
check(r.actualizados === 1, 'Cambiar IVA masivo a 10,5%')
r = await api('PATCH', '/api/v1/productos/bulk', { ids: [p1.id], accion: 'iva', payload: { iva: 150 } })
check(r.status === 400, 'IVA 150% rechazado')
await api('PUT', '/api/v1/configuracion/kv/iva.default', { valor: '10.5' })
const nuevo = await api('POST', '/api/v1/productos', { sku: 'QA-IVA-1', nombre: 'Producto Iva Default', precioVenta: 100 })
check(Number(nuevo.impuesto) === 10.5, 'producto nuevo toma IVA por defecto 10,5 (' + nuevo.impuesto + ')')

// 6) Reimportar igual → todo "igual", nada cambia
r = await api('POST', '/api/v1/productos/importar-precios/revisar', { archivos })
check(r.archivos[0].resumen.iguales === 21 && r.archivos[1].resumen.iguales === 21, 'reimportar el mismo Excel: 21 iguales en cada lista')

// 7) La principal no puede ser +IVA
r = await api('PUT', '/api/v1/listas-precio/' + principal.id, { masIva: true })
check(r.status === 400, 'principal +IVA rechazado')

// 8) Match por nombre (sin SKU) y nombre parecido
r = await api('POST', '/api/v1/productos/importar-precios/revisar', { archivos: [{ listaId: farm.id, masIva: true, mapeo: { nombre: 'n', precio: 'p' }, filas: [
  { n: 'SHAMPOO ENERGIZANTE ANTICAIDA260CC', p: '20.600' },
  { n: 'Tricoten 401', p: '$ 23.900,50' },
  { n: 'Producto Inexistente XYZ', p: 100 },
] }] })
const it = r.archivos?.[0]?.items || []
check(it[0]?.match === 'nombre' && it[0]?.precio === 20600 && it[0]?.incluir, 'nombre sin tildes/mayúsculas matchea exacto, "20.600" = 20600')
check(it[1]?.match === 'parecido' && it[1]?.precio === 23900.5 && !it[1]?.incluir, 'nombre parecido queda "¿es este?" sin tildar, "$ 23.900,50" = 23900.5')
check(!it[2]?.productoId && !it[2]?.incluir, 'inexistente: sin match')

// 9) Ticket con IVA sumado (lo que manda el PoS con lista +IVA)
const prodT = bySku.get(String(pfa.filas[2].sku)) // Tricoten 23850, IVA 21
const sub = 23850, iva = Math.round(sub * 0.21 * 100) / 100
const caja = await api('POST', '/api/v1/caja/abrir', { montoInicial: 0 })
const ov = await api('POST', '/api/v1/ordenes-venta', { listaPrecioId: farm.id, subtotal: sub, impuestos: iva, total: sub + iva, lineas: [{ productoId: prodT.id, descripcion: prodT.nombre, cantidad: 1, precioUnit: sub, impuesto: 21, subtotal: sub }] })
const tk = await api('POST', '/api/v1/tickets', { ordenId: ov.id, listaPrecioId: farm.id, cajaSesionId: caja.id, medioPago: 'EFECTIVO', subtotal: sub, impuestos: iva, total: sub + iva, lineas: [{ productoId: prodT.id, descripcion: prodT.nombre, cantidad: 1, precioUnit: sub, impuesto: 21, subtotal: sub }] })
check(tk.id && Number(tk.total) === 28858.5 && Number(tk.impuestos) === 5008.5 && Number(tk.subtotal) === 23850, 'ticket +IVA guarda subtotal 23850 + IVA 5008,5 = 28858,5 (' + (tk.message || tk.total) + ')')

console.log('\n' + ok + ' OK, ' + fail + ' fallaron')
process.exit(fail ? 1 : 0)
