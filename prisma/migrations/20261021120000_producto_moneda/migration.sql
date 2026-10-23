-- Precios en dólares (V2.106.0): moneda en la que están cargados precioCosto/precioVenta del
-- producto y de sus variantes. Solo agrega una columna con default ARS — no cambia nada existente.
ALTER TABLE "productos" ADD COLUMN "moneda" TEXT NOT NULL DEFAULT 'ARS';
