-- DropIndex
-- El objeto "categorias_tenantId_nombre_key" es una constraint UNIQUE en algunos entornos (prod)
-- y un índice simple en otros (dev) — Postgres exige DROP CONSTRAINT para el primer caso y
-- DROP INDEX para el segundo. Este bloque cubre ambos sin fallar en ninguno de los dos.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'categorias_tenantId_nombre_key') THEN
    ALTER TABLE "categorias" DROP CONSTRAINT "categorias_tenantId_nombre_key";
  ELSIF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'categorias_tenantId_nombre_key' AND relkind = 'i') THEN
    DROP INDEX "categorias_tenantId_nombre_key";
  END IF;
END $$;

-- AlterTable
ALTER TABLE "categorias" ADD COLUMN     "parentId" TEXT;

-- CreateIndex
CREATE INDEX "categorias_parentId_idx" ON "categorias"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "categorias_tenantId_parentId_nombre_key" ON "categorias"("tenantId", "parentId", "nombre");

-- AddForeignKey
ALTER TABLE "categorias" ADD CONSTRAINT "categorias_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "categorias"("id") ON DELETE CASCADE ON UPDATE CASCADE;

