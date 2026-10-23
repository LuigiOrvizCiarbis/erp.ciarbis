-- Saldar cuenta corriente de un cliente (espejo exacto de pagos_proveedor, pero cobrando en vez
-- de pagando) + pago dividido en 2 métodos en el PoS (Ticket.pagosSplit).

-- CreateTable
CREATE TABLE "pagos_cliente" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clienteId" TEXT NOT NULL,
    "monto" DECIMAL(15,2) NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "comentario" TEXT,
    "cotizacionTipo" TEXT,
    "cotizacionValor" DECIMAL(10,2),
    "montoUSD" DECIMAL(15,2),
    "formaPago" "FormaPagoInterno" NOT NULL,
    "cajaSesionId" TEXT,
    "usuarioId" TEXT NOT NULL,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pagos_cliente_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pagos_cliente_tenantId_idx" ON "pagos_cliente"("tenantId");

-- CreateIndex
CREATE INDEX "pagos_cliente_tenantId_clienteId_idx" ON "pagos_cliente"("tenantId", "clienteId");

-- AddForeignKey
ALTER TABLE "pagos_cliente" ADD CONSTRAINT "pagos_cliente_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "clientes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pagos_cliente" ADD CONSTRAINT "pagos_cliente_cajaSesionId_fkey" FOREIGN KEY ("cajaSesionId") REFERENCES "caja_sesiones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pagos_cliente" ADD CONSTRAINT "pagos_cliente_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Mismo criterio que 20260819000000_enable_rls_new_tables: esta tabla solo se toca vía Prisma
-- con el rol "postgres" (rolbypassrls=true) — habilitar RLS sin policies cierra el acceso
-- anónimo/PostgREST sin afectar la app.
ALTER TABLE "public"."pagos_cliente" ENABLE ROW LEVEL SECURITY;

-- AlterTable: pago dividido en 2 métodos (ej. mitad efectivo, mitad QR) — ver Ticket.pagosSplit
-- en el schema para el comentario completo.
ALTER TABLE "tickets" ADD COLUMN "pagosSplit" JSONB;
