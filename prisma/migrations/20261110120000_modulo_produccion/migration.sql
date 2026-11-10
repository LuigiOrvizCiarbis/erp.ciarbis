-- DropIndex
DROP INDEX "boms_tenantId_productoId_version_key";

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "modulosOcultos" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "seqOT" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "boms" ADD COLUMN     "costoIndirecto" DECIMAL(15,2) NOT NULL DEFAULT 0,
ADD COLUMN     "costoManoObra" DECIMAL(15,2) NOT NULL DEFAULT 0,
ADD COLUMN     "etapas" TEXT[],
ADD COLUMN     "notas" TEXT,
ADD COLUMN     "rendimiento" DECIMAL(15,3) NOT NULL DEFAULT 1,
ADD COLUMN     "varianteId" TEXT;

-- AlterTable
ALTER TABLE "bom_items" ADD COLUMN     "orden" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "varianteId" TEXT;

-- AlterTable
ALTER TABLE "ordenes_trabajo" ADD COLUMN     "activo" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "costoIndirecto" DECIMAL(15,2) NOT NULL DEFAULT 0,
ADD COLUMN     "costoInsumos" DECIMAL(15,2) NOT NULL DEFAULT 0,
ADD COLUMN     "costoManoObra" DECIMAL(15,2) NOT NULL DEFAULT 0,
ADD COLUMN     "costoTotal" DECIMAL(15,2) NOT NULL DEFAULT 0,
ADD COLUMN     "costoUnitario" DECIMAL(15,4) NOT NULL DEFAULT 0,
ADD COLUMN     "creadoPorId" TEXT,
ADD COLUMN     "creadoPorNombre" TEXT,
ADD COLUMN     "etapaId" TEXT,
ADD COLUMN     "fechaVenc" TIMESTAMP(3),
ADD COLUMN     "insumosDescontados" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "loteNro" TEXT,
ADD COLUMN     "prioridad" TEXT NOT NULL DEFAULT 'NORMAL',
ADD COLUMN     "productoId" TEXT,
ADD COLUMN     "responsableId" TEXT,
ADD COLUMN     "responsableNombre" TEXT,
ADD COLUMN     "sucursalId" TEXT;

-- AlterTable
ALTER TABLE "lineas_orden_trabajo" ADD COLUMN     "costoUnit" DECIMAL(15,4) NOT NULL DEFAULT 0,
ADD COLUMN     "um" TEXT NOT NULL DEFAULT 'unidad',
ADD COLUMN     "varianteId" TEXT;

-- CreateTable
CREATE TABLE "etapas_produccion" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#1E40FF',
    "orden" INTEGER NOT NULL DEFAULT 0,
    "activa" BOOLEAN NOT NULL DEFAULT true,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "etapas_produccion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ordenes_trabajo_salidas" (
    "id" TEXT NOT NULL,
    "ordenId" TEXT NOT NULL,
    "productoId" TEXT NOT NULL,
    "varianteId" TEXT,
    "cantPlanif" DECIMAL(15,3) NOT NULL,
    "cantProd" DECIMAL(15,3) NOT NULL DEFAULT 0,

    CONSTRAINT "ordenes_trabajo_salidas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ordenes_trabajo_etapas" (
    "id" TEXT NOT NULL,
    "ordenId" TEXT NOT NULL,
    "etapaId" TEXT,
    "nombre" TEXT NOT NULL,
    "posicion" INTEGER NOT NULL DEFAULT 0,
    "estado" TEXT NOT NULL DEFAULT 'PENDIENTE',
    "responsableId" TEXT,
    "responsableNombre" TEXT,
    "inicio" TIMESTAMP(3),
    "fin" TIMESTAMP(3),
    "nota" TEXT,

    CONSTRAINT "ordenes_trabajo_etapas_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "etapas_produccion_tenantId_idx" ON "etapas_produccion"("tenantId");

-- CreateIndex
CREATE INDEX "ordenes_trabajo_salidas_ordenId_idx" ON "ordenes_trabajo_salidas"("ordenId");

-- CreateIndex
CREATE INDEX "ordenes_trabajo_etapas_ordenId_idx" ON "ordenes_trabajo_etapas"("ordenId");

-- CreateIndex
CREATE INDEX "boms_tenantId_productoId_idx" ON "boms"("tenantId", "productoId");

-- CreateIndex
CREATE INDEX "ordenes_trabajo_tenantId_estado_idx" ON "ordenes_trabajo"("tenantId", "estado");

-- AddForeignKey
ALTER TABLE "ordenes_trabajo_salidas" ADD CONSTRAINT "ordenes_trabajo_salidas_ordenId_fkey" FOREIGN KEY ("ordenId") REFERENCES "ordenes_trabajo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ordenes_trabajo_etapas" ADD CONSTRAINT "ordenes_trabajo_etapas_ordenId_fkey" FOREIGN KEY ("ordenId") REFERENCES "ordenes_trabajo"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- RLS sin políticas (igual que el resto de las tablas, ver fix 2026-08-04): cierra el acceso
-- por la anon key de PostgREST; Prisma conecta como postgres (bypassrls) y no se ve afectado.
ALTER TABLE "etapas_produccion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ordenes_trabajo_salidas" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ordenes_trabajo_etapas" ENABLE ROW LEVEL SECURITY;
