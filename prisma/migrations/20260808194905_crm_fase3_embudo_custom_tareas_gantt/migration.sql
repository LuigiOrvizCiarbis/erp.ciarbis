-- CreateEnum
CREATE TYPE "PrioridadTarea" AS ENUM ('BAJA', 'MEDIA', 'ALTA');

-- CreateEnum
CREATE TYPE "TipoTarea" AS ENUM ('LLAMADA', 'REUNION', 'EMAIL', 'SEGUIMIENTO', 'GENERAL');

-- AlterTable
ALTER TABLE "crm_campos_custom_contacto" ADD COLUMN     "mostrarEnEmbudo" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "crm_contactos" ADD COLUMN     "etapaCustomId" TEXT,
ADD COLUMN     "sucursalId" TEXT,
ADD COLUMN     "tipoEmbudoId" TEXT,
ADD COLUMN     "usuarioId" TEXT;

-- AlterTable
ALTER TABLE "crm_tareas" ADD COLUMN     "fechaInicio" TIMESTAMP(3),
ADD COLUMN     "prioridad" "PrioridadTarea" NOT NULL DEFAULT 'MEDIA',
ADD COLUMN     "tipo" "TipoTarea" NOT NULL DEFAULT 'GENERAL';

-- CreateTable
CREATE TABLE "crm_tipos_embudo" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "esDefault" BOOLEAN NOT NULL DEFAULT false,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_tipos_embudo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_etapas_embudo_custom" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "tipoEmbudoId" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#6c5ce7',
    "orden" INTEGER NOT NULL DEFAULT 0,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crm_etapas_embudo_custom_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "crm_tipos_embudo_tenantId_idx" ON "crm_tipos_embudo"("tenantId");

-- CreateIndex
CREATE INDEX "crm_etapas_embudo_custom_tenantId_tipoEmbudoId_idx" ON "crm_etapas_embudo_custom"("tenantId", "tipoEmbudoId");

-- CreateIndex
CREATE INDEX "crm_contactos_tenantId_etapaCustomId_idx" ON "crm_contactos"("tenantId", "etapaCustomId");

-- AddForeignKey
ALTER TABLE "crm_contactos" ADD CONSTRAINT "crm_contactos_tipoEmbudoId_fkey" FOREIGN KEY ("tipoEmbudoId") REFERENCES "crm_tipos_embudo"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_contactos" ADD CONSTRAINT "crm_contactos_etapaCustomId_fkey" FOREIGN KEY ("etapaCustomId") REFERENCES "crm_etapas_embudo_custom"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_etapas_embudo_custom" ADD CONSTRAINT "crm_etapas_embudo_custom_tipoEmbudoId_fkey" FOREIGN KEY ("tipoEmbudoId") REFERENCES "crm_tipos_embudo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Data migration: cada tenant que ya tenga contactos recibe un TipoEmbudo "General" (esDefault)
-- con las 6 etapas fijas que existían antes (mismo nombre/orden que el enum EtapaEmbudo), y cada
-- contacto existente se apunta a la etapa que le corresponde según su `etapa` vieja — para que el
-- Kanban nuevo (que lee etapaCustomId) no arranque vacío ni pierda datos ya cargados.
DO $$
DECLARE
  t RECORD;
  tipo_id TEXT;
BEGIN
  FOR t IN SELECT DISTINCT "tenantId" FROM "crm_contactos" LOOP
    tipo_id := 'teg' || substr(md5(random()::text || t."tenantId" || clock_timestamp()::text), 1, 22);

    INSERT INTO "crm_tipos_embudo" (id, "tenantId", nombre, "esDefault", "creadoEn")
    VALUES (tipo_id, t."tenantId", 'General', true, now());

    INSERT INTO "crm_etapas_embudo_custom" (id, "tenantId", "tipoEmbudoId", nombre, color, orden, "creadoEn") VALUES
      ('etc'||substr(md5(random()::text||tipo_id||'1'),1,22), t."tenantId", tipo_id, 'Nuevo',        '#3b82f6', 0, now()),
      ('etc'||substr(md5(random()::text||tipo_id||'2'),1,22), t."tenantId", tipo_id, 'Contactado',   '#8b5cf6', 1, now()),
      ('etc'||substr(md5(random()::text||tipo_id||'3'),1,22), t."tenantId", tipo_id, 'Propuesta',    '#f59e0b', 2, now()),
      ('etc'||substr(md5(random()::text||tipo_id||'4'),1,22), t."tenantId", tipo_id, 'Negociación',  '#f97316', 3, now()),
      ('etc'||substr(md5(random()::text||tipo_id||'5'),1,22), t."tenantId", tipo_id, 'Ganado',       '#22c55e', 4, now()),
      ('etc'||substr(md5(random()::text||tipo_id||'6'),1,22), t."tenantId", tipo_id, 'Perdido',      '#ef4444', 5, now());

    UPDATE "crm_contactos" c
    SET "tipoEmbudoId" = tipo_id,
        "etapaCustomId" = e.id
    FROM "crm_etapas_embudo_custom" e
    WHERE e."tipoEmbudoId" = tipo_id
      AND c."tenantId" = t."tenantId"
      AND e.nombre = CASE c.etapa
        WHEN 'NUEVO' THEN 'Nuevo'
        WHEN 'CONTACTADO' THEN 'Contactado'
        WHEN 'PROPUESTA' THEN 'Propuesta'
        WHEN 'NEGOCIACION' THEN 'Negociación'
        WHEN 'GANADO' THEN 'Ganado'
        WHEN 'PERDIDO' THEN 'Perdido'
      END;
  END LOOP;
END $$;
