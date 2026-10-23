-- AlterTable: costo propio por variante (talle/color/tamaño) — null = hereda el precioCosto
-- del producto base, mismo criterio que ya existía para precioVenta.
ALTER TABLE "producto_variantes" ADD COLUMN "precioCosto" DECIMAL(15,2);
