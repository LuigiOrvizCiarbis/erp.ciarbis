-- CreateEnum
CREATE TYPE "FormaPagoInterno" AS ENUM ('CAJA', 'FONDO', 'TRANSFERENCIA_DUENO');

-- CreateEnum
CREATE TYPE "TipoCuentaInterna" AS ENUM ('FONDO', 'TRANSFERENCIA_DUENO');

-- CreateTable
CREATE TABLE "gastos" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "categoria" TEXT NOT NULL,
    "descripcion" TEXT,
    "monto" DECIMAL(15,2) NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "formaPago" "FormaPagoInterno" NOT NULL,
    "cajaSesionId" TEXT,
    "usuarioId" TEXT NOT NULL,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gastos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pagos_proveedor" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "proveedorId" TEXT NOT NULL,
    "monto" DECIMAL(15,2) NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "comentario" TEXT,
    "formaPago" "FormaPagoInterno" NOT NULL,
    "cajaSesionId" TEXT,
    "usuarioId" TEXT NOT NULL,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pagos_proveedor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cuentas_internas" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "tipo" "TipoCuentaInterna" NOT NULL,

    CONSTRAINT "cuentas_internas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "movimientos_cuenta_interna" (
    "id" TEXT NOT NULL,
    "cuentaId" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "monto" DECIMAL(15,2) NOT NULL,
    "concepto" TEXT NOT NULL,
    "usuarioId" TEXT NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "movimientos_cuenta_interna_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "gastos_tenantId_idx" ON "gastos"("tenantId");

-- CreateIndex
CREATE INDEX "gastos_tenantId_fecha_idx" ON "gastos"("tenantId", "fecha");

-- CreateIndex
CREATE INDEX "pagos_proveedor_tenantId_idx" ON "pagos_proveedor"("tenantId");

-- CreateIndex
CREATE INDEX "pagos_proveedor_tenantId_proveedorId_idx" ON "pagos_proveedor"("tenantId", "proveedorId");

-- CreateIndex
CREATE UNIQUE INDEX "cuentas_internas_tenantId_tipo_key" ON "cuentas_internas"("tenantId", "tipo");

-- CreateIndex
CREATE INDEX "movimientos_cuenta_interna_cuentaId_idx" ON "movimientos_cuenta_interna"("cuentaId");

-- CreateIndex
CREATE INDEX "movimientos_cuenta_interna_cuentaId_fecha_idx" ON "movimientos_cuenta_interna"("cuentaId", "fecha");

-- AddForeignKey
ALTER TABLE "gastos" ADD CONSTRAINT "gastos_cajaSesionId_fkey" FOREIGN KEY ("cajaSesionId") REFERENCES "caja_sesiones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gastos" ADD CONSTRAINT "gastos_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pagos_proveedor" ADD CONSTRAINT "pagos_proveedor_proveedorId_fkey" FOREIGN KEY ("proveedorId") REFERENCES "proveedores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pagos_proveedor" ADD CONSTRAINT "pagos_proveedor_cajaSesionId_fkey" FOREIGN KEY ("cajaSesionId") REFERENCES "caja_sesiones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pagos_proveedor" ADD CONSTRAINT "pagos_proveedor_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movimientos_cuenta_interna" ADD CONSTRAINT "movimientos_cuenta_interna_cuentaId_fkey" FOREIGN KEY ("cuentaId") REFERENCES "cuentas_internas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movimientos_cuenta_interna" ADD CONSTRAINT "movimientos_cuenta_interna_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
