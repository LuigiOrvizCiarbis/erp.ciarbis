-- Ubicación en depósito (V2.105.0): Pasillo / Estante / Cajón por producto y por variante, en
-- cada sucursal. Solo agrega columnas (nullable) — no toca datos existentes.
ALTER TABLE "productos_sucursales" ADD COLUMN "pasillo" TEXT;
ALTER TABLE "productos_sucursales" ADD COLUMN "estante" TEXT;
ALTER TABLE "productos_sucursales" ADD COLUMN "cajon" TEXT;

ALTER TABLE "variantes_sucursales" ADD COLUMN "pasillo" TEXT;
ALTER TABLE "variantes_sucursales" ADD COLUMN "estante" TEXT;
ALTER TABLE "variantes_sucursales" ADD COLUMN "cajon" TEXT;
