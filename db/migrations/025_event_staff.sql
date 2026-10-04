-- 025: el evento deja de ser solo una noche dentro de la venue y pasa a ser
-- una unidad de trabajo AISLADA con su propio equipo y su propio link de puerta.
--
-- Problema que resuelve: hoy el equipo es de la VENUE (venue_user_roles) y el
-- bouncer abre /escaner y elige el evento en un selector. Eso tiene dos
-- problemas reales:
--
--   1) "Quién trabaja en esta noche" no existe. Un bouncer asignado a la
--      venue puede escanear CUALQUIER evento, incluidos meses que ya
--      pasaron. No hay forma de decir "esta persona solo trabaja la noche
--      del 14".
--   2) En la puerta se le pide al bouncer que elija la noche correcta con un
--      dedo y sin contexto: un toque equivocado = boletas de otro evento.
--
-- Decisiones:
--
-- - event_staff: la persona y su rol POR EVENTO. No reemplaza
--   venue_user_roles (esa sigue siendo "de quién es el bar"): define "quién
--   trabaja esta noche" y con qué rol. Rol propio del evento: puerta, trato
--   o-feedback. El admin del bar sigue siendo el dueño y no necesita estar
--   en la tabla: el backend lo trata como staff implícito.
--
-- - event_access_tokens: el link de la puerta CON EL EVENTO YA FIJO. Es la
--   diferencia entre "elegí la noche" y "esta noche es esta". Token de 192
--   bits, en DB solo el SHA-256 (misma disciplina que staff_invitations y que
--   los QR de boleta), de un solo uso para el PRIMER canje y luego ligado a
--   la sesión. Si el link traspasa, el receptor igual queda atado a esa noche.
--
-- - NO es una credencial de administración: el link solo abre el escaner de
--   ESE evento. No otorga lectura de caja, ni reportes, ni el equipo. El
--   canje de boletas lo sigue autorizando el rol venue-level.

CREATE TABLE IF NOT EXISTS event_staff (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id    bigint NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Rol DENTRO de esta noche. "admin" no va acá: el dueño del bar siempre
    -- puede entrar a su evento, esté o no en la tabla.
    role        text   NOT NULL CHECK (role IN ('bouncer', 'promotor')),
    -- Turno acotado: si se llena, el token solo vale entre estas horas. Vacío
    -- = sin restricción (el caso normal: la noche entera).
    shift_start timestamptz,
    shift_end   timestamptz,
    assigned_by bigint NOT NULL REFERENCES users(id),
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT event_staff_shift_check CHECK (shift_end IS NULL OR shift_start IS NULL OR shift_end > shift_start),
    -- Una persona, un rol por noche: sin esto el mismo usuario podía quedar
    -- dos veces en la lista de la puerta y la UI lo mostraría duplicado.
    CONSTRAINT event_staff_unique UNIQUE (event_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_event_staff_event ON event_staff (event_id);
CREATE INDEX IF NOT EXISTS idx_event_staff_user  ON event_staff (user_id);

CREATE TABLE IF NOT EXISTS event_access_tokens (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id     bigint NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    user_id      bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash   text   NOT NULL UNIQUE,
    expires_at   timestamptz NOT NULL,
    used_at      timestamptz,
    created_by   bigint NOT NULL REFERENCES users(id),
    created_at   timestamptz NOT NULL DEFAULT now(),
    revoked_at   timestamptz
);

CREATE INDEX IF NOT EXISTS idx_event_tokens_user
    ON event_access_tokens (user_id) WHERE revoked_at IS NULL;

-- Un link vigente por persona y noche: generar de nuevo invalida el anterior
-- (rotación), igual que hace reissue_ticket con los QR.
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_tokens_active
    ON event_access_tokens (event_id, user_id)
    WHERE used_at IS NULL AND revoked_at IS NULL;

COMMENT ON TABLE event_staff IS
    'Quién trabaja cada noche y con qué rol. La pertenencia al bar vive en venue_user_roles; esto es "quién está en esta puerta".';
COMMENT ON TABLE event_access_tokens IS
    'Links de puerta con el evento ya fijo. Solo el SHA-256 del token se guarda.';