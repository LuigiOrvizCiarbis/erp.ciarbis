-- DropForeignKey
ALTER TABLE "ordenes_venta" DROP CONSTRAINT "ordenes_venta_clienteId_fkey";

-- AlterTable
ALTER TABLE "ordenes_venta" ALTER COLUMN "clienteId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "ordenes_venta" ADD CONSTRAINT "ordenes_venta_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "clientes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
