-- Fix: Supabase security linter flagged 15 public tables with RLS disabled (rls_disabled_in_public).
-- These tables are only ever reached through Prisma over the direct Postgres connection (role
-- "postgres", which has rolbypassrls=true and owns every table), never through Supabase's
-- PostgREST API — so enabling RLS with no policies fully closes off anonymous/PostgREST access
-- without affecting the app itself. Verified against prod before writing this migration.

ALTER TABLE "public"."producto_variantes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."listas_precio" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."lista_precio_margenes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."cupones" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."configuracion_puntos" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."reglas_bonus_puntos" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."crm_tareas" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."crm_contactos" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."crm_contacto_etiquetas" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."crm_etiquetas" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."roles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."razones_sociales" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."empleados" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."fichajes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."caja_sesiones" ENABLE ROW LEVEL SECURITY;
