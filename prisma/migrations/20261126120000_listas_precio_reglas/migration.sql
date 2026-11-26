-- V2.108.0 — Listas de precio automáticas: reglas %/$/manual por producto, categoría, proveedor
-- o categoría+proveedor; base de cada lista; precio manual por producto; lista usada en ventas.

-- La unicidad (lista, categoría) ya no aplica (ahora hay destinos por proveedor/producto).
-- En prod puede ser CONSTRAINT y en dev índice suelto: se cubren los dos.
ALTER TABLE "lista_precio_margenes" DROP CONSTRAINT IF EXISTS "lista_precio_margenes_listaPrecioId_categoriaId_key";
DROP INDEX IF EXISTS "lista_precio_margenes_listaPrecioId_categoriaId_key";

ALTER TABLE "lista_precio_margenes" ADD COLUMN IF NOT EXISTS "productoId" TEXT,
ADD COLUMN IF NOT EXISTS "proveedorId" TEXT,
ADD COLUMN IF NOT EXISTS "tipo" TEXT NOT NULL DEFAULT 'PCT',
ADD COLUMN IF NOT EXISTS "valor" DECIMAL(15,4) NOT NULL DEFAULT 0;
ALTER TABLE "lista_precio_margenes" ALTER COLUMN "margenPct" SET DEFAULT 0;

ALTER TABLE "listas_precio" ADD COLUMN IF NOT EXISTS "autoActiva" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "redondeo" DECIMAL(10,2) NOT NULL DEFAULT 0;
-- "base": las listas que YA existen calculaban % sobre el COSTO → se crea la columna con default
-- COSTO (llena las filas actuales) y recién después el default pasa a PRINCIPAL para las nuevas.
-- Solo la primera vez (si la columna ya está, no se toca nada → idempotente).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'listas_precio' AND column_name = 'base') THEN
    ALTER TABLE "listas_precio" ADD COLUMN "base" TEXT NOT NULL DEFAULT 'COSTO';
    ALTER TABLE "listas_precio" ALTER COLUMN "base" SET DEFAULT 'PRINCIPAL';
  END IF;
END $$;

ALTER TABLE "ordenes_venta" ADD COLUMN IF NOT EXISTS "listaPrecioId" TEXT,
ADD COLUMN IF NOT EXISTS "listaPrecioNombre" TEXT;

ALTER TABLE "productos" ADD COLUMN IF NOT EXISTS "precioManual" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "listaPrecioId" TEXT,
ADD COLUMN IF NOT EXISTS "listaPrecioNombre" TEXT;

CREATE INDEX IF NOT EXISTS "lista_precio_margenes_listaPrecioId_idx" ON "lista_precio_margenes"("listaPrecioId");

DO $$ BEGIN
  ALTER TABLE "lista_precio_margenes" ADD CONSTRAINT "lista_precio_margenes_proveedorId_fkey" FOREIGN KEY ("proveedorId") REFERENCES "proveedores"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "lista_precio_margenes" ADD CONSTRAINT "lista_precio_margenes_productoId_fkey" FOREIGN KEY ("productoId") REFERENCES "productos"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Datos: los márgenes viejos eran % sobre el costo → valor = margenPct (solo filas sin migrar;
-- el código nuevo escribe margenPct = valor, así que correrlo de nuevo no cambia nada).
UPDATE "lista_precio_margenes" SET "valor" = "margenPct" WHERE "tipo" = 'PCT' AND "valor" = 0 AND "margenPct" <> 0;
