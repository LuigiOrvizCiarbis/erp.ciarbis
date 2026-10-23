-- CreateEnum
CREATE TYPE "TipoDescuentoCliente" AS ENUM ('PORCENTAJE', 'COSTO');

-- AlterTable
ALTER TABLE "clientes" ADD COLUMN     "descuentoTipo" "TipoDescuentoCliente" NOT NULL DEFAULT 'PORCENTAJE';

-- AlterTable
ALTER TABLE "productos" ADD COLUMN     "vencimiento" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "producto_variantes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productoId" TEXT NOT NULL,
    "talle" TEXT,
    "color" TEXT,
    "tamano" TEXT,
    "sku" TEXT NOT NULL,
    "codigoBarras" TEXT,
    "precioVenta" DECIMAL(15,2),
    "stock" DECIMAL(15,3) NOT NULL DEFAULT 0,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "producto_variantes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "producto_variantes_tenantId_productoId_idx" ON "producto_variantes"("tenantId", "productoId");

-- CreateIndex
CREATE UNIQUE INDEX "producto_variantes_tenantId_sku_key" ON "producto_variantes"("tenantId", "sku");

-- AddForeignKey
ALTER TABLE "producto_variantes" ADD CONSTRAINT "producto_variantes_productoId_fkey" FOREIGN KEY ("productoId") REFERENCES "productos"("id") ON DELETE CASCADE ON UPDATE CASCADE;
