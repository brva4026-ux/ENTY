-- Los cubos centinela (`__register__`, `__forgot__`) limitan su propio
-- endpoint, pero no deben bloquear el login desde la misma IP. Sin esto, una
-- ráfaga de altas o resets deja a todos los usuarios de esa IP sin poder
-- entrar aunque sus credenciales sean correctas.

CREATE OR REPLACE FUNCTION public.login_locked(
    p_email text,
    p_ip text,
    p_max_failures integer DEFAULT 8,
    p_window_minutes integer DEFAULT 15
) RETURNS boolean
    LANGUAGE sql
    AS $$
    SELECT (
        SELECT count(*)
          FROM login_attempts
         WHERE email_norm = lower(p_email)
           AND at > now() - make_interval(mins => p_window_minutes)
    ) >= p_max_failures
    OR (
        SELECT count(*)
          FROM login_attempts
         WHERE ip = p_ip
           AND email_norm NOT LIKE '\_\_%'
           AND at > now() - make_interval(mins => p_window_minutes)
    ) >= p_max_failures;
$$;
