-- CreateEnum
CREATE TYPE "TipoDescuentoCupon" AS ENUM ('PORCENTAJE', 'MONTO');

-- AlterTable
ALTER TABLE "tickets" ADD COLUMN     "cuponId" TEXT,
ADD COLUMN     "descuentoCuponMonto" DECIMAL(15,2);

-- CreateTable
CREATE TABLE "cupones" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "codigo" TEXT NOT NULL,
    "tipo" "TipoDescuentoCupon" NOT NULL DEFAULT 'PORCENTAJE',
    "valor" DECIMAL(10,2) NOT NULL,
    "fechaDesde" TIMESTAMP(3),
    "fechaHasta" TIMESTAMP(3),
    "montoMinimoCompra" DECIMAL(15,2),
    "usosMax" INTEGER,
    "usosMaxPorCliente" INTEGER,
    "combinaConDescuentoManual" BOOLEAN NOT NULL DEFAULT false,
    "combinaConDescuentoCliente" BOOLEAN NOT NULL DEFAULT false,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cupones_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cupones_tenantId_idx" ON "cupones"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "cupones_tenantId_codigo_key" ON "cupones"("tenantId", "codigo");
