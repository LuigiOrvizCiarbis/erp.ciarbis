-- CreateEnum
CREATE TYPE "EtapaEmbudo" AS ENUM ('NUEVO', 'CONTACTADO', 'PROPUESTA', 'NEGOCIACION', 'GANADO', 'PERDIDO');

-- CreateEnum
CREATE TYPE "CampoCustomTipo" AS ENUM ('TEXTO', 'NUMERO', 'FECHA', 'SELECT');

-- AlterTable
ALTER TABLE "crm_contactos" ADD COLUMN     "camposCustom" JSONB,
ADD COLUMN     "etapa" "EtapaEmbudo" NOT NULL DEFAULT 'NUEVO',
ADD COLUMN     "valorEstimado" DECIMAL(15,2),
ADD COLUMN     "whatsapp" TEXT;

-- CreateTable
CREATE TABLE "crm_notas_contacto" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "contactoId" TEXT NOT NULL,
    "texto" TEXT NOT NULL,
    "usuarioId" TEXT,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_notas_contacto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_campos_custom_contacto" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clave" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "tipo" "CampoCustomTipo" NOT NULL DEFAULT 'TEXTO',
    "opciones" TEXT,
    "orden" INTEGER NOT NULL DEFAULT 0,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_campos_custom_contacto_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "crm_notas_contacto_tenantId_contactoId_idx" ON "crm_notas_contacto"("tenantId", "contactoId");

-- CreateIndex
CREATE INDEX "crm_campos_custom_contacto_tenantId_idx" ON "crm_campos_custom_contacto"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "crm_campos_custom_contacto_tenantId_clave_key" ON "crm_campos_custom_contacto"("tenantId", "clave");

-- CreateIndex
CREATE INDEX "crm_contactos_tenantId_etapa_idx" ON "crm_contactos"("tenantId", "etapa");

-- AddForeignKey
ALTER TABLE "crm_notas_contacto" ADD CONSTRAINT "crm_notas_contacto_contactoId_fkey" FOREIGN KEY ("contactoId") REFERENCES "crm_contactos"("id") ON DELETE CASCADE ON UPDATE CASCADE;
