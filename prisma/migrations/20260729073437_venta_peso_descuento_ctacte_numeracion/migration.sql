-- AlterEnum
ALTER TYPE "MedioPago" ADD VALUE 'CUENTA_CORRIENTE';

-- AlterTable
ALTER TABLE "categorias" ADD COLUMN     "numero" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "clientes" ADD COLUMN     "descuento" DECIMAL(5,2) DEFAULT 0;

-- AlterTable
ALTER TABLE "productos" ADD COLUMN     "numero" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "proveedorId" TEXT,
ADD COLUMN     "ventaPorPeso" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "proveedores" ADD COLUMN     "numero" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "seqCategorias" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "seqProductos" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "seqProveedores" INTEGER NOT NULL DEFAULT 0;

-- AddForeignKey
ALTER TABLE "productos" ADD CONSTRAINT "productos_proveedorId_fkey" FOREIGN KEY ("proveedorId") REFERENCES "proveedores"("id") ON DELETE SET NULL ON UPDATE CASCADE;
