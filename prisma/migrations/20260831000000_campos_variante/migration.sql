-- Campos de variante configurables por tenant (reemplaza las 3 columnas fijas talle/color/tamano
-- de producto_variantes). Ver prisma/schema.prisma: modelo CampoVariante + ProductoVariante.valores.

-- 1) Catálogo de campos por tenant
CREATE TABLE "campos_variante" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clave" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "opciones" TEXT,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "orden" INTEGER NOT NULL DEFAULT 0,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campos_variante_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "campos_variante_tenantId_clave_key" ON "campos_variante"("tenantId", "clave");
CREATE INDEX "campos_variante_tenantId_idx" ON "campos_variante"("tenantId");

-- 2) Nueva columna JSON en producto_variantes
ALTER TABLE "producto_variantes" ADD COLUMN "valores" JSONB NOT NULL DEFAULT '{}';

-- 3) Backfill: talle/color/tamano existentes pasan a valores = {"talle":..., "color":..., "tamano":...}
--    (solo las claves que tenían un valor no nulo)
UPDATE "producto_variantes"
SET "valores" = jsonb_strip_nulls(jsonb_build_object('talle', "talle", 'color', "color", 'tamano', "tamano"));

-- 4) Se borran las columnas viejas — los datos ya están en "valores" (paso 3)
ALTER TABLE "producto_variantes" DROP COLUMN "talle";
ALTER TABLE "producto_variantes" DROP COLUMN "color";
ALTER TABLE "producto_variantes" DROP COLUMN "tamano";
