-- AlterTable: descripción corta para productos (teaser/resumen, pensado para el e-commerce a
-- futuro) — la "descripcion" ya existente pasa a ser la descripción larga.
ALTER TABLE "productos" ADD COLUMN "descripcionCorta" TEXT;
