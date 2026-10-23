-- Fix: Supabase security linter flagged 15 more public tables with RLS disabled (rls_disabled_in_public)
-- — everything added since the previous sweep in 20260804233157_enable_rls_missing_tables.
-- Same rationale as that migration: these tables are only ever reached through Prisma over the
-- direct Postgres connection (role "postgres", which has rolbypassrls=true and owns every table),
-- never through Supabase's PostgREST API — so enabling RLS with no policies fully closes off
-- anonymous/PostgREST access without affecting the app itself.

ALTER TABLE "public"."pagos_proveedor" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."cuentas_internas" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."movimientos_cuenta_interna" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."pagos_plan_cliente" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."planes_cliente" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."gastos" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."crm_notas_contacto" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."crm_campos_custom_contacto" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."servicios_contratados" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."crm_tipos_embudo" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."crm_etapas_embudo_custom" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."plan_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."ingresos" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."cotizaciones_dolar" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."medios_pago_servicio" ENABLE ROW LEVEL SECURITY;
