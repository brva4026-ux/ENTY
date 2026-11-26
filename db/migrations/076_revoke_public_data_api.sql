-- 076: cierra la Data API de Supabase sobre el esquema public.
--
-- El backend entra por Postgres directo como owner; el frontend no usa
-- supabase-js. Sin este revoke, la anon key (publica por diseño) podia leer y
-- escribir tickets, eventos y datos personales a traves de PostgREST.
--
-- Idempotente y seguro en bases locales sin los roles de Supabase: cada bloque
-- solo se ejecuta si el rol existe.

DO $$
DECLARE r record;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
            EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon', r.tablename);
        END LOOP;
        FOR r IN SELECT sequencename FROM pg_sequences WHERE schemaname = 'public' LOOP
            EXECUTE format('REVOKE ALL ON SEQUENCE public.%I FROM anon', r.sequencename);
        END LOOP;
        REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
            EXECUTE format('REVOKE ALL ON TABLE public.%I FROM authenticated', r.tablename);
        END LOOP;
        FOR r IN SELECT sequencename FROM pg_sequences WHERE schemaname = 'public' LOOP
            EXECUTE format('REVOKE ALL ON SEQUENCE public.%I FROM authenticated', r.sequencename);
        END LOOP;
        REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM authenticated;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM authenticated;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM authenticated;
    END IF;
END $$;
