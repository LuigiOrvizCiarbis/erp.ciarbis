-- CreateTable
CREATE TABLE "planes_cliente" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clienteId" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "precio" DECIMAL(15,2) NOT NULL,
    "frecuenciaDias" INTEGER NOT NULL DEFAULT 30,
    "proximoVencimiento" TIMESTAMP(3) NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actuEn" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "planes_cliente_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pagos_plan_cliente" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "monto" DECIMAL(15,2) NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usuarioId" TEXT NOT NULL,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pagos_plan_cliente_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "planes_cliente_tenantId_idx" ON "planes_cliente"("tenantId");

-- CreateIndex
CREATE INDEX "planes_cliente_tenantId_clienteId_idx" ON "planes_cliente"("tenantId", "clienteId");

-- CreateIndex
CREATE INDEX "pagos_plan_cliente_planId_idx" ON "pagos_plan_cliente"("planId");

-- AddForeignKey
ALTER TABLE "planes_cliente" ADD CONSTRAINT "planes_cliente_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "clientes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pagos_plan_cliente" ADD CONSTRAINT "pagos_plan_cliente_planId_fkey" FOREIGN KEY ("planId") REFERENCES "planes_cliente"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pagos_plan_cliente" ADD CONSTRAINT "pagos_plan_cliente_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
