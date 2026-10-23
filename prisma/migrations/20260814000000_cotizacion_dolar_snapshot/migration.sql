-- AlterTable: cotizaciones_dolar gana manual compra/venta (8va cotización) y tipoDefault
ALTER TABLE "cotizaciones_dolar" ADD COLUMN     "manualCompra" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "manualVenta" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "tipoDefault" TEXT NOT NULL DEFAULT 'oficialVenta';

-- AlterTable: snapshot silencioso de cotización en cada transacción (cotizacionTipo/Valor/montoUSD)
ALTER TABLE "ordenes_compra" ADD COLUMN     "cotizacionTipo" TEXT,
ADD COLUMN     "cotizacionValor" DECIMAL(10,2),
ADD COLUMN     "montoUSD" DECIMAL(15,2);

ALTER TABLE "tickets" ADD COLUMN     "cotizacionTipo" TEXT,
ADD COLUMN     "cotizacionValor" DECIMAL(10,2),
ADD COLUMN     "montoUSD" DECIMAL(15,2);

ALTER TABLE "gastos" ADD COLUMN     "cotizacionTipo" TEXT,
ADD COLUMN     "cotizacionValor" DECIMAL(10,2),
ADD COLUMN     "montoUSD" DECIMAL(15,2);

ALTER TABLE "ingresos" ADD COLUMN     "cotizacionTipo" TEXT,
ADD COLUMN     "cotizacionValor" DECIMAL(10,2),
ADD COLUMN     "montoUSD" DECIMAL(15,2);

ALTER TABLE "pagos_proveedor" ADD COLUMN     "cotizacionTipo" TEXT,
ADD COLUMN     "cotizacionValor" DECIMAL(10,2),
ADD COLUMN     "montoUSD" DECIMAL(15,2);

-- pagos_plan_cliente ya tenía cotizacionAplicada — solo se agregan cotizacionTipo y montoUSD
ALTER TABLE "pagos_plan_cliente" ADD COLUMN     "cotizacionTipo" TEXT,
ADD COLUMN     "montoUSD" DECIMAL(15,2);

-- CreateTable: histórico GLOBAL de cotizaciones (sin tenantId), capturado por el cron 4x/día
CREATE TABLE "cotizaciones_dolar_historial" (
    "id" TEXT NOT NULL,
    "capturadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "oficialCompra" DECIMAL(10,2) NOT NULL,
    "oficialVenta" DECIMAL(10,2) NOT NULL,
    "blueCompra" DECIMAL(10,2) NOT NULL,
    "blueVenta" DECIMAL(10,2) NOT NULL,
    "usdtCompra" DECIMAL(10,2) NOT NULL,
    "usdtVenta" DECIMAL(10,2) NOT NULL,

    CONSTRAINT "cotizaciones_dolar_historial_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cotizaciones_dolar_historial_capturadoEn_idx" ON "cotizaciones_dolar_historial"("capturadoEn");
