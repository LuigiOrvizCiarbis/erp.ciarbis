-- AlterTable
ALTER TABLE "caja_sesiones" ADD COLUMN     "cierreForzado" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "clientes" ADD COLUMN     "listaPrecioId" TEXT;

-- CreateTable
CREATE TABLE "listas_precio" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "esDefault" BOOLEAN NOT NULL DEFAULT false,
    "activa" BOOLEAN NOT NULL DEFAULT true,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "listas_precio_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lista_precio_margenes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "listaPrecioId" TEXT NOT NULL,
    "categoriaId" TEXT,
    "margenPct" DECIMAL(6,2) NOT NULL,

    CONSTRAINT "lista_precio_margenes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "listas_precio_tenantId_idx" ON "listas_precio"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "listas_precio_tenantId_nombre_key" ON "listas_precio"("tenantId", "nombre");

-- CreateIndex
CREATE INDEX "lista_precio_margenes_tenantId_idx" ON "lista_precio_margenes"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "lista_precio_margenes_listaPrecioId_categoriaId_key" ON "lista_precio_margenes"("listaPrecioId", "categoriaId");

-- AddForeignKey
ALTER TABLE "lista_precio_margenes" ADD CONSTRAINT "lista_precio_margenes_listaPrecioId_fkey" FOREIGN KEY ("listaPrecioId") REFERENCES "listas_precio"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lista_precio_margenes" ADD CONSTRAINT "lista_precio_margenes_categoriaId_fkey" FOREIGN KEY ("categoriaId") REFERENCES "categorias"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clientes" ADD CONSTRAINT "clientes_listaPrecioId_fkey" FOREIGN KEY ("listaPrecioId") REFERENCES "listas_precio"("id") ON DELETE SET NULL ON UPDATE CASCADE;
