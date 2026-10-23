// Normalización de campos "nombre" en toda la app: se guardan con Mayúscula
// Inicial En Cada Palabra para que "saco"/"Saco"/"SACO" no generen registros
// duplicados por casing. El chequeo de duplicados sigue usando mode:'insensitive'
// aparte de esto — tituloCase es solo para consistencia visual del dato guardado.
export function tituloCase(str) {
  if (!str) return str
  return String(str)
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/(^|[\s\-'])(\p{L})/gu, (m, sep, letra) => sep + letra.toUpperCase())
}
