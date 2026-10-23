-- CreateEnum
CREATE TYPE "TipoFichaje" AS ENUM ('INGRESO', 'DESCANSO', 'REGRESO', 'SALIDA');

-- AlterTable
ALTER TABLE "caja_sesiones" ADD COLUMN     "comentario" TEXT,
ADD COLUMN     "empleadoId" TEXT;

-- CreateTable
CREATE TABLE "empleados" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "legajo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "userId" TEXT,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "empleados_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fichajes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "empleadoId" TEXT NOT NULL,
    "sucursalId" TEXT,
    "tipo" "TipoFichaje" NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fichajes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "empleados_userId_key" ON "empleados"("userId");

-- CreateIndex
CREATE INDEX "empleados_tenantId_idx" ON "empleados"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "empleados_tenantId_legajo_key" ON "empleados"("tenantId", "legajo");

-- CreateIndex
CREATE INDEX "fichajes_tenantId_idx" ON "fichajes"("tenantId");

-- CreateIndex
CREATE INDEX "fichajes_empleadoId_fecha_idx" ON "fichajes"("empleadoId", "fecha");

-- CreateIndex
CREATE INDEX "caja_sesiones_empleadoId_idx" ON "caja_sesiones"("empleadoId");

-- AddForeignKey
ALTER TABLE "caja_sesiones" ADD CONSTRAINT "caja_sesiones_empleadoId_fkey" FOREIGN KEY ("empleadoId") REFERENCES "empleados"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "empleados" ADD CONSTRAINT "empleados_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "empleados" ADD CONSTRAINT "empleados_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fichajes" ADD CONSTRAINT "fichajes_empleadoId_fkey" FOREIGN KEY ("empleadoId") REFERENCES "empleados"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
