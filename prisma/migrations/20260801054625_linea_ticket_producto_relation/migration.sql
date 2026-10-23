-- CreateIndex
CREATE INDEX "lineas_ticket_productoId_idx" ON "lineas_ticket"("productoId");

-- AddForeignKey
ALTER TABLE "lineas_ticket" ADD CONSTRAINT "lineas_ticket_productoId_fkey" FOREIGN KEY ("productoId") REFERENCES "productos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

