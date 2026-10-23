// Tabla de permisos por rol de sistema — espejo server-side de PERMS en public/dashboard.html.
// Se usa para (a) sembrar un Rol de sistema por tenant por cada valor del enum RolUsuario,
// y (b) el helper requirePermiso() en las rutas que sí enforcean a nivel backend.
// Los roles de sistema no distinguen ver/crear/editar/eliminar (igual que el canAccess()
// original, todo-o-nada por módulo) — un rol custom sí puede diferenciarlos.

export const MODULOS_ROL = [
  'home', 'inventario', 'ventas', 'compras', 'produccion', 'logistica',
  'ecommerce', 'reportes', 'facturacion', 'pos', 'pos_restaurant', 'config', 'taller',
]

export const PERMS_SISTEMA = {
  ADMIN:      ['home', 'inventario', 'ventas', 'compras', 'produccion', 'logistica', 'ecommerce', 'reportes', 'facturacion', 'pos', 'pos_restaurant', 'config', 'taller'],
  VENDEDOR:   ['home', 'inventario', 'ventas', 'facturacion', 'pos', 'taller'],
  DEPOSITO:   ['home', 'inventario', 'compras', 'logistica'],
  CONTADOR:   ['home', 'reportes', 'facturacion', 'config'],
  PRODUCCION: ['home', 'inventario', 'produccion', 'taller'],
  LOGISTICA:  ['home', 'inventario', 'logistica'],
}

export const ROL_LABELS = {
  ADMIN: 'Administrador', VENDEDOR: 'Vendedor', DEPOSITO: 'Depósito',
  CONTADOR: 'Contador', PRODUCCION: 'Producción', LOGISTICA: 'Logística',
}

export function permisosDesdeModulos(mods) {
  const out = {}
  for (const m of MODULOS_ROL) {
    const incluido = mods.includes(m)
    out[m] = { ver: incluido, crear: incluido, editar: incluido, eliminar: incluido }
  }
  return out
}

export function tienePermiso(permisos, modulo, accion) {
  if (!permisos || !permisos[modulo]) return false
  return !!permisos[modulo][accion]
}
