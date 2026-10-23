-- Fix: Supabase security linter flagged cotizaciones_dolar_historial with RLS disabled
-- (rls_disabled_in_public) — table created by 20260814000000_cotizacion_dolar_snapshot,
-- missed by the 20260819000000_enable_rls_new_tables sweep because it didn't exist yet at
-- that point. Same rationale: only ever reached through Prisma over the direct Postgres
-- connection (role "postgres", rolbypassrls=true), never through PostgREST.

ALTER TABLE "public"."cotizaciones_dolar_historial" ENABLE ROW LEVEL SECURITY;
