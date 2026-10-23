-- CreateEnum
CREATE TYPE "AreaNegocio" AS ENUM ('PRODUCTO', 'SERVICIO', 'GENERAL');

-- AlterTable
ALTER TABLE "gastos" ADD COLUMN     "activo" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "area" "AreaNegocio" NOT NULL DEFAULT 'GENERAL',
ADD COLUMN     "empleadoId" TEXT,
ADD COLUMN     "servicioContratadoId" TEXT,
ADD COLUMN     "sucursalId" TEXT;

-- AlterTable
ALTER TABLE "pagos_plan_cliente" ADD COLUMN     "sucursalId" TEXT;

-- CreateTable
CREATE TABLE "servicios_contratados" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "servicios_contratados_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "servicios_contratados_tenantId_idx" ON "servicios_contratados"("tenantId");

-- AddForeignKey
ALTER TABLE "gastos" ADD CONSTRAINT "gastos_sucursalId_fkey" FOREIGN KEY ("sucursalId") REFERENCES "sucursales"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gastos" ADD CONSTRAINT "gastos_empleadoId_fkey" FOREIGN KEY ("empleadoId") REFERENCES "empleados"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gastos" ADD CONSTRAINT "gastos_servicioContratadoId_fkey" FOREIGN KEY ("servicioContratadoId") REFERENCES "servicios_contratados"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pagos_plan_cliente" ADD CONSTRAINT "pagos_plan_cliente_sucursalId_fkey" FOREIGN KEY ("sucursalId") REFERENCES "sucursales"("id") ON DELETE SET NULL ON UPDATE CASCADE;

