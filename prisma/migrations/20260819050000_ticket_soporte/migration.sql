-- CreateEnum
CREATE TYPE "EstadoTicketSoporte" AS ENUM ('ABIERTO', 'RESUELTO');

-- CreateTable: mensajes del chat flotante de Ayuda/Soporte — llegan al panel /superadmin.
CREATE TABLE "tickets_soporte" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mensaje" TEXT NOT NULL,
    "estado" "EstadoTicketSoporte" NOT NULL DEFAULT 'ABIERTO',
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actuEn" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tickets_soporte_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "tickets_soporte_tenantId_idx" ON "tickets_soporte"("tenantId");
CREATE INDEX "tickets_soporte_estado_idx" ON "tickets_soporte"("estado");

ALTER TABLE "tickets_soporte" ADD CONSTRAINT "tickets_soporte_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tickets_soporte" ADD CONSTRAINT "tickets_soporte_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Mismo criterio que toda tabla nueva de este proyecto (ver 20260804233157_enable_rls_missing_tables):
-- solo se llega vía Prisma con el rol "postgres" (rolbypassrls=true), nunca por PostgREST.
ALTER TABLE "tickets_soporte" ENABLE ROW LEVEL SECURITY;
