-- V2.110.0 — Listas de precio "+IVA": precios guardados sin IVA, el IVA del producto se suma al cobrar.
ALTER TABLE "listas_precio" ADD COLUMN IF NOT EXISTS "masIva" BOOLEAN NOT NULL DEFAULT false;
