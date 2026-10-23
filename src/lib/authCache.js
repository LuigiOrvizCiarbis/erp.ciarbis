// ─────────────────────────────────────────────
//  Caché corta de sesión+usuario y tenant (V2.101.0, performance)
//
//  verifyJWT y verifyTenant consultaban la base en CADA request (sesión, usuario, tenant) antes de
//  hacer nada útil. En prod cada consulta es un viaje Hostinger ↔ Supabase, así que una pantalla
//  que dispara 9 requests pagaba ~25 viajes extra solo en verificaciones. Se recuerdan 30s.
//
//  Cualquier cambio que afecte esto (logout, cambio de contraseña, desactivar usuario, cambio de
//  plan/estado del tenant) llama invalidarCacheAuth() → efecto inmediato en este proceso. Si hay
//  más de un proceso Node corriendo, el peor caso es 30s de demora en los demás.
// ─────────────────────────────────────────────

const TTL_MS = 30_000
const MAX_ENTRADAS = 5000

const sesiones = new Map() // jti → { exp, valor }
const tenants = new Map()  // tenantId → { exp, valor }

function leer(mapa, clave) {
  const e = mapa.get(clave)
  if (!e) return undefined
  if (e.exp < Date.now()) { mapa.delete(clave); return undefined }
  return e.valor
}
function guardar(mapa, clave, valor) {
  if (mapa.size >= MAX_ENTRADAS) mapa.clear()
  mapa.set(clave, { exp: Date.now() + TTL_MS, valor })
}

export const cacheSesion = {
  leer: (jti) => leer(sesiones, jti),
  guardar: (jti, sesion) => guardar(sesiones, jti, sesion),
}
export const cacheTenant = {
  leer: (id) => leer(tenants, id),
  guardar: (id, tenant) => guardar(tenants, id, tenant),
}
export function invalidarCacheAuth() {
  sesiones.clear()
  tenants.clear()
}
