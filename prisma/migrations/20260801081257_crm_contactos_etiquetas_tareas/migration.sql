-- CreateEnum
CREATE TYPE "EstadoTareaCRM" AS ENUM ('PENDIENTE', 'HECHA');

-- CreateTable
CREATE TABLE "crm_contactos" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "empresa" TEXT,
    "cargo" TEXT,
    "email" TEXT,
    "tel" TEXT,
    "notas" TEXT,
    "clienteId" TEXT,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actuEn" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_contactos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_etiquetas" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "color" TEXT,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_etiquetas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_contacto_etiquetas" (
    "id" TEXT NOT NULL,
    "contactoId" TEXT NOT NULL,
    "etiquetaId" TEXT NOT NULL,

    CONSTRAINT "crm_contacto_etiquetas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_tareas" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "titulo" TEXT NOT NULL,
    "descripcion" TEXT,
    "fechaVencimiento" TIMESTAMP(3),
    "estado" "EstadoTareaCRM" NOT NULL DEFAULT 'PENDIENTE',
    "contactoId" TEXT,
    "usuarioId" TEXT,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actuEn" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_tareas_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "crm_contactos_tenantId_idx" ON "crm_contactos"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "crm_etiquetas_tenantId_nombre_key" ON "crm_etiquetas"("tenantId", "nombre");

-- CreateIndex
CREATE UNIQUE INDEX "crm_contacto_etiquetas_contactoId_etiquetaId_key" ON "crm_contacto_etiquetas"("contactoId", "etiquetaId");

-- CreateIndex
CREATE INDEX "crm_tareas_tenantId_idx" ON "crm_tareas"("tenantId");

-- AddForeignKey
ALTER TABLE "crm_contacto_etiquetas" ADD CONSTRAINT "crm_contacto_etiquetas_contactoId_fkey" FOREIGN KEY ("contactoId") REFERENCES "crm_contactos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_contacto_etiquetas" ADD CONSTRAINT "crm_contacto_etiquetas_etiquetaId_fkey" FOREIGN KEY ("etiquetaId") REFERENCES "crm_etiquetas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

