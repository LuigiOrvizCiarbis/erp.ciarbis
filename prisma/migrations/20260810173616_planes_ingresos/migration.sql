-- CreateEnum
CREATE TYPE "Moneda" AS ENUM ('ARS', 'USD');

-- AlterTable
ALTER TABLE "pagos_plan_cliente" ADD COLUMN     "comprobantePdf" TEXT,
ADD COLUMN     "cotizacionAplicada" DECIMAL(10,2),
ADD COLUMN     "medioPagoId" TEXT,
ADD COLUMN     "periodoDesde" TIMESTAMP(3),
ADD COLUMN     "periodoHasta" TIMESTAMP(3),
ADD COLUMN     "periodosCubiertos" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "planes_cliente" ADD COLUMN     "diasGracia" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "moneda" "Moneda" NOT NULL DEFAULT 'ARS',
ADD COLUMN     "templateId" TEXT;

-- CreateTable
CREATE TABLE "ingresos" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "categoria" TEXT NOT NULL,
    "descripcion" TEXT,
    "monto" DECIMAL(15,2) NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "formaPago" "FormaPagoInterno" NOT NULL,
    "cajaSesionId" TEXT,
    "usuarioId" TEXT NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "area" "AreaNegocio" NOT NULL DEFAULT 'GENERAL',
    "sucursalId" TEXT,
    "clienteId" TEXT,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ingresos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_templates" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "precio" DECIMAL(15,2) NOT NULL,
    "moneda" "Moneda" NOT NULL DEFAULT 'ARS',
    "frecuenciaDias" INTEGER NOT NULL DEFAULT 30,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "medios_pago_servicio" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "medios_pago_servicio_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cotizaciones_dolar" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "oficialCompra" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "oficialVenta" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "blueCompra" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "blueVenta" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "usdtCompra" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "usdtVenta" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "fuente" TEXT NOT NULL DEFAULT 'MANUAL',
    "actualizadoEn" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cotizaciones_dolar_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ingresos_tenantId_idx" ON "ingresos"("tenantId");

-- CreateIndex
CREATE INDEX "ingresos_tenantId_fecha_idx" ON "ingresos"("tenantId", "fecha");

-- CreateIndex
CREATE INDEX "plan_templates_tenantId_idx" ON "plan_templates"("tenantId");

-- CreateIndex
CREATE INDEX "medios_pago_servicio_tenantId_idx" ON "medios_pago_servicio"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "cotizaciones_dolar_tenantId_key" ON "cotizaciones_dolar"("tenantId");

-- AddForeignKey
ALTER TABLE "ingresos" ADD CONSTRAINT "ingresos_cajaSesionId_fkey" FOREIGN KEY ("cajaSesionId") REFERENCES "caja_sesiones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingresos" ADD CONSTRAINT "ingresos_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingresos" ADD CONSTRAINT "ingresos_sucursalId_fkey" FOREIGN KEY ("sucursalId") REFERENCES "sucursales"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingresos" ADD CONSTRAINT "ingresos_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "clientes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cotizaciones_dolar" ADD CONSTRAINT "cotizaciones_dolar_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pagos_plan_cliente" ADD CONSTRAINT "pagos_plan_cliente_medioPagoId_fkey" FOREIGN KEY ("medioPagoId") REFERENCES "medios_pago_servicio"("id") ON DELETE SET NULL ON UPDATE CASCADE;

