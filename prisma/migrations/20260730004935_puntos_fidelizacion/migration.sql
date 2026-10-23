-- CreateEnum
CREATE TYPE "TipoReglaBonus" AS ENUM ('PRODUCTO', 'CATEGORIA', 'DIA_SEMANA', 'HORARIO', 'MONTO_MINIMO');

-- AlterTable
ALTER TABLE "clientes" ADD COLUMN     "anioNacimiento" INTEGER,
ADD COLUMN     "cumpleDia" INTEGER,
ADD COLUMN     "cumpleMes" INTEGER,
ADD COLUMN     "puntos" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "configuracion_puntos" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT false,
    "puntosPorMonto" DECIMAL(10,4) NOT NULL DEFAULT 0,
    "compraMinima" DECIMAL(15,2),
    "puntosMaxPorCompra" INTEGER,

    CONSTRAINT "configuracion_puntos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reglas_bonus_puntos" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "tipo" "TipoReglaBonus" NOT NULL,
    "productoId" TEXT,
    "categoriaId" TEXT,
    "diaSemana" INTEGER,
    "horaDesde" TEXT,
    "horaHasta" TEXT,
    "montoMinimo" DECIMAL(15,2),
    "multiplicador" DECIMAL(5,2) NOT NULL DEFAULT 2,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reglas_bonus_puntos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "configuracion_puntos_tenantId_key" ON "configuracion_puntos"("tenantId");

-- CreateIndex
CREATE INDEX "reglas_bonus_puntos_tenantId_idx" ON "reglas_bonus_puntos"("tenantId");
