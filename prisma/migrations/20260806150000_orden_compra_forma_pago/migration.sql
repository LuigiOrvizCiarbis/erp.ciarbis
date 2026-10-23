-- AlterTable
ALTER TABLE "ordenes_compra" ADD COLUMN     "cajaSesionId" TEXT,
ADD COLUMN     "ctaCte" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "formaPagoInterno" "FormaPagoInterno";

-- AddForeignKey
ALTER TABLE "ordenes_compra" ADD CONSTRAINT "ordenes_compra_cajaSesionId_fkey" FOREIGN KEY ("cajaSesionId") REFERENCES "caja_sesiones"("id") ON DELETE SET NULL ON UPDATE CASCADE;
