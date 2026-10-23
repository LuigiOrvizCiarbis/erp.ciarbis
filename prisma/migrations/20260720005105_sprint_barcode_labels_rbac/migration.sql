-- AlterTable
ALTER TABLE "caja_sesiones" ADD COLUMN     "motivoDiferencia" TEXT,
ADD COLUMN     "requiereRevision" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "empleados" ADD COLUMN     "pin" TEXT;

-- AlterTable
ALTER TABLE "fichajes" ADD COLUMN     "corrigeId" TEXT,
ADD COLUMN     "motivo" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "rolId" TEXT;

-- CreateTable
CREATE TABLE "roles" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "esSistema" BOOLEAN NOT NULL DEFAULT false,
    "permisos" JSONB NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "roles_tenantId_idx" ON "roles"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "roles_tenantId_nombre_key" ON "roles"("tenantId", "nombre");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_rolId_fkey" FOREIGN KEY ("rolId") REFERENCES "roles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roles" ADD CONSTRAINT "roles_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fichajes" ADD CONSTRAINT "fichajes_corrigeId_fkey" FOREIGN KEY ("corrigeId") REFERENCES "fichajes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
