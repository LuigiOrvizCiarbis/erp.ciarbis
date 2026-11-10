// Catálogo de módulos "gateables" del ERP y sugerencias por rubro.
// Única fuente de verdad — se expone al frontend vía GET /api/v1/auth/modulos-catalogo
// (usado por register.html, dashboard.html y superadmin/index.html).
// home, reportes y config NO están acá: son baseline, siempre activos para todo tenant.

export const BASELINE_MODULES = ['home', 'reportes', 'config']

export const MODULE_CATALOG = [
  { id: 'pos', label: 'Caja / PoS', icon: '🏧' },
  { id: 'pos_restaurant', label: 'Restaurant PoS', icon: '🍽️' },
  { id: 'inventario', label: 'Inventario', icon: '📦' },
  { id: 'ventas', label: 'Ventas', icon: '🧾' },
  { id: 'compras', label: 'Compras', icon: '🛒' },
  { id: 'produccion', label: 'Producción', icon: '🏭', selfService: true, desc: 'Recetas, órdenes de trabajo, etapas y planificación de insumos' },
  { id: 'facturacion', label: 'Facturación', icon: '💳' },
  // selfService: el admin del tenant lo prende/apaga solo desde Ajustes > Módulos (además del
  // registro y del superadmin) — ver PUT /configuracion/modulos/:id.
  { id: 'taller', label: 'Taller', icon: '🔧', selfService: true, desc: 'Armado, reparaciones y garantías' },
  { id: 'logistica', label: 'Logística', icon: '🚚', comingSoon: true },
  { id: 'ecommerce', label: 'E-Commerce', icon: '💻', comingSoon: true },
]

// Módulos incluidos en todos los planes que el admin puede OCULTAR (no se cobran, solo se
// sacan del menú para quien no los usa). Se guardan en Tenant.modulosOcultos.
// Auditoría oculta sigue registrando: si se vuelve a mostrar, el historial está completo.
export const OCULTABLE_MODULES = [
  { id: 'fichaje', label: 'Fichaje', icon: '🕐', desc: 'Entrada, salida y descansos del personal. Oculto, la caja se abre sin exigir fichaje.' },
  { id: 'auditoria', label: 'Auditoría', icon: '🔍', desc: 'Historial de cambios sensibles (precios, stock, ventas). Oculto, el registro se sigue guardando.' },
]
export const OCULTABLE_IDS = OCULTABLE_MODULES.map(m => m.id)

export const MODULE_IDS = MODULE_CATALOG.map(m => m.id)
export const GATEABLE_NOW_IDS = MODULE_CATALOG.filter(m => !m.comingSoon).map(m => m.id)
export const SELF_SERVICE_IDS = MODULE_CATALOG.filter(m => m.selfService).map(m => m.id)

// rubro (slug) → subset sugerido de MODULE_CATALOG (sólo ids gateables ahora, nunca comingSoon)
export const RUBRO_MODULE_DEFAULTS = {
  kiosko:       ['pos', 'inventario', 'compras', 'facturacion'],
  almacen:      ['pos', 'inventario', 'compras', 'ventas', 'facturacion'],
  supermercado: ['pos', 'inventario', 'compras', 'ventas', 'facturacion'],
  minimercado:  ['pos', 'inventario', 'compras', 'facturacion'],
  dietetica:    ['pos', 'inventario', 'compras', 'ventas', 'facturacion'],
  indumentaria: ['pos', 'inventario', 'compras', 'ventas', 'facturacion'],
  tecnologia:   ['pos', 'inventario', 'compras', 'ventas', 'facturacion'],
  ecommerce:    ['inventario', 'compras', 'ventas', 'facturacion'],
  otro:         ['inventario', 'compras', 'ventas', 'facturacion'],
}

export function defaultModulosForRubro(rubro) {
  return RUBRO_MODULE_DEFAULTS[rubro] || RUBRO_MODULE_DEFAULTS.otro
}

// Filtra una lista de módulos elegidos por el usuario contra el catálogo real,
// descartando ids desconocidos y cualquier módulo comingSoon (no seleccionable todavía).
export function sanitizeModulos(modulos) {
  if (!Array.isArray(modulos)) return []
  return [...new Set(modulos.filter(id => GATEABLE_NOW_IDS.includes(id)))]
}
