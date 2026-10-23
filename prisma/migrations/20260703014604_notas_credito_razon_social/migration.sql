-- AlterEnum
ALTER TYPE "TipoComprobante" ADD VALUE 'NC_C';

-- AlterTable
ALTER TABLE "tickets" ADD COLUMN     "esNotaCredito" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "observaciones" TEXT,
ADD COLUMN     "razonSocialId" TEXT,
ADD COLUMN     "ticketOrigenId" TEXT;

-- CreateTable
CREATE TABLE "razones_sociales" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "cuit" TEXT NOT NULL,
    "condIVA" TEXT NOT NULL DEFAULT 'Responsable Inscripto',
    "ptoVta" TEXT NOT NULL DEFAULT '0001',
    "esPrincipal" BOOLEAN NOT NULL DEFAULT false,
    "activa" BOOLEAN NOT NULL DEFAULT true,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "razones_sociales_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "razones_sociales_tenantId_idx" ON "razones_sociales"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "razones_sociales_tenantId_cuit_key" ON "razones_sociales"("tenantId", "cuit");

-- CreateIndex
CREATE INDEX "tickets_ticketOrigenId_idx" ON "tickets"("ticketOrigenId");

-- CreateIndex
CREATE INDEX "tickets_razonSocialId_idx" ON "tickets"("razonSocialId");

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_razonSocialId_fkey" FOREIGN KEY ("razonSocialId") REFERENCES "razones_sociales"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_ticketOrigenId_fkey" FOREIGN KEY ("ticketOrigenId") REFERENCES "tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "razones_sociales" ADD CONSTRAINT "razones_sociales_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
