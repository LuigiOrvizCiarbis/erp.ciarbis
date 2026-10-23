-- AlterTable: snapshot silencioso del costo vigente al momento de cada venta (para reportes de
-- ganancia históricamente correctos, aunque el costo del producto haya cambiado después).
ALTER TABLE "lineas_ticket" ADD COLUMN "precioCosto" DECIMAL(15,2);

-- CreateTable: costo recordado por producto+proveedor ("le compro a A cuando tiene, a B si no")
CREATE TABLE "producto_proveedores" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productoId" TEXT NOT NULL,
    "proveedorId" TEXT NOT NULL,
    "ultimoCosto" DECIMAL(15,2) NOT NULL,
    "ultimaCompra" TIMESTAMP(3),
    "preferido" BOOLEAN NOT NULL DEFAULT false,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actuEn" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "producto_proveedores_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "producto_proveedores_tenantId_productoId_proveedorId_key" ON "producto_proveedores"("tenantId", "productoId", "proveedorId");
CREATE INDEX "producto_proveedores_tenantId_productoId_idx" ON "producto_proveedores"("tenantId", "productoId");

ALTER TABLE "producto_proveedores" ADD CONSTRAINT "producto_proveedores_productoId_fkey" FOREIGN KEY ("productoId") REFERENCES "productos"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "producto_proveedores" ADD CONSTRAINT "producto_proveedores_proveedorId_fkey" FOREIGN KEY ("proveedorId") REFERENCES "proveedores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Mismo criterio que toda tabla nueva en este proyecto (ver 20260804233157_enable_rls_missing_tables):
-- solo se llega vía Prisma con el rol "postgres" (rolbypassrls=true), nunca por PostgREST.
ALTER TABLE "producto_proveedores" ENABLE ROW LEVEL SECURITY;
