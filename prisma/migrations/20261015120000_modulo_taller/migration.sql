-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "seqTaller" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "ordenes_taller" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "numero" INTEGER NOT NULL,
    "tipo" TEXT NOT NULL,
    "estado" TEXT NOT NULL DEFAULT 'INGRESADO',
    "clienteId" TEXT,
    "clienteNombre" TEXT NOT NULL,
    "clienteTel" TEXT,
    "clienteEmail" TEXT,
    "clienteDni" TEXT,
    "equipoTipo" TEXT,
    "marca" TEXT,
    "modelo" TEXT,
    "nroSerie" TEXT,
    "productoId" TEXT,
    "falla" TEXT,
    "estadoFisico" TEXT,
    "accesorios" JSONB,
    "claveAcceso" TEXT,
    "comprobanteCompra" TEXT,
    "fechaCompra" TIMESTAMP(3),
    "fechaPrometida" TIMESTAMP(3),
    "tecnicoId" TEXT,
    "tecnicoNombre" TEXT,
    "sucursalId" TEXT,
    "presupuesto" DECIMAL(15,2),
    "presupuestoDetalle" TEXT,
    "presupuestoEn" TIMESTAMP(3),
    "aprobadoEn" TIMESTAMP(3),
    "informe" TEXT,
    "sena" DECIMAL(15,2),
    "total" DECIMAL(15,2),
    "medioPago" TEXT,
    "garantiaDias" INTEGER,
    "entregadoEn" TIMESTAMP(3),
    "usuarioId" TEXT,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actuEn" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ordenes_taller_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ordenes_taller_eventos" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "ordenId" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "texto" TEXT,
    "estado" TEXT,
    "usuarioId" TEXT,
    "usuarioNombre" TEXT,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ordenes_taller_eventos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ordenes_taller_tenantId_tipo_estado_idx" ON "ordenes_taller"("tenantId", "tipo", "estado");

-- CreateIndex
CREATE INDEX "ordenes_taller_tenantId_clienteId_idx" ON "ordenes_taller"("tenantId", "clienteId");

-- CreateIndex
CREATE UNIQUE INDEX "ordenes_taller_tenantId_numero_key" ON "ordenes_taller"("tenantId", "numero");

-- CreateIndex
CREATE INDEX "ordenes_taller_eventos_ordenId_idx" ON "ordenes_taller_eventos"("ordenId");

-- AddForeignKey
ALTER TABLE "ordenes_taller_eventos" ADD CONSTRAINT "ordenes_taller_eventos_ordenId_fkey" FOREIGN KEY ("ordenId") REFERENCES "ordenes_taller"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Supabase: mismo criterio que el resto de las tablas (RLS activado sin políticas → PostgREST
-- anónimo no ve nada; Prisma conecta como postgres, que bypassea RLS).
ALTER TABLE "ordenes_taller" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ordenes_taller_eventos" ENABLE ROW LEVEL SECURITY;
