-- Stock por sucursal (V2.104.0): el producto/variante se da de alta una sola vez para toda la
-- cuenta, el stock vive por sucursal y Producto.stock / ProductoVariante.stock pasan a ser
-- siempre la suma de sus filas por sucursal (mantenido por src/lib/stock.js).

-- 1) Stock por sucursal de cada variante
CREATE TABLE "variantes_sucursales" (
    "id" TEXT NOT NULL,
    "varianteId" TEXT NOT NULL,
    "sucursalId" TEXT NOT NULL,
    "stock" DECIMAL(15,3) NOT NULL DEFAULT 0,
    "actuEn" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "variantes_sucursales_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "variantes_sucursales_varianteId_sucursalId_key" ON "variantes_sucursales"("varianteId", "sucursalId");
CREATE INDEX "variantes_sucursales_sucursalId_idx" ON "variantes_sucursales"("sucursalId");
ALTER TABLE "variantes_sucursales" ADD CONSTRAINT "variantes_sucursales_varianteId_fkey" FOREIGN KEY ("varianteId") REFERENCES "producto_variantes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "variantes_sucursales" ADD CONSTRAINT "variantes_sucursales_sucursalId_fkey" FOREIGN KEY ("sucursalId") REFERENCES "sucursales"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Mismo criterio que el resto de las tablas (ver fix RLS 2026-08-04): RLS sin políticas cierra
-- el acceso anónimo por PostgREST; Prisma entra como "postgres" (bypassrls).
ALTER TABLE "variantes_sucursales" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "productos_sucursales" ENABLE ROW LEVEL SECURITY;

-- 2) Punto de partida: lo que había en productos_sucursales no era confiable (nada cargaba
-- stock ahí, solo las ventas lo descontaban → todo en 0 o negativo). Se pone en 0 y TODO el
-- stock actual queda asignado a la sucursal principal de cada empresa (o la más vieja activa).
UPDATE "productos_sucursales" SET "stock" = 0;

WITH destino AS (
  SELECT DISTINCT ON ("tenantId") "tenantId", "id"
  FROM "sucursales" WHERE "activa" = true
  ORDER BY "tenantId", "esPrincipal" DESC, "creadoEn" ASC
)
INSERT INTO "productos_sucursales" ("id", "productoId", "sucursalId", "stock", "stockMin", "actuEn")
SELECT 'ps' || md5(p."id" || d."id"), p."id", d."id", p."stock", 0, now()
FROM "productos" p JOIN destino d ON d."tenantId" = p."tenantId"
WHERE p."stock" <> 0
ON CONFLICT ("productoId", "sucursalId") DO UPDATE SET "stock" = EXCLUDED."stock";

WITH destino AS (
  SELECT DISTINCT ON ("tenantId") "tenantId", "id"
  FROM "sucursales" WHERE "activa" = true
  ORDER BY "tenantId", "esPrincipal" DESC, "creadoEn" ASC
)
INSERT INTO "variantes_sucursales" ("id", "varianteId", "sucursalId", "stock", "actuEn")
SELECT 'vs' || md5(v."id" || d."id"), v."id", d."id", v."stock", now()
FROM "producto_variantes" v JOIN destino d ON d."tenantId" = v."tenantId"
WHERE v."stock" <> 0;
