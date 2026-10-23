-- AlterTable
ALTER TABLE "caja_sesiones" ADD COLUMN     "diferencia" DECIMAL(15,2),
ADD COLUMN     "efectivoEsperado" DECIMAL(15,2);

-- AddForeignKey
ALTER TABLE "caja_sesiones" ADD CONSTRAINT "caja_sesiones_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
