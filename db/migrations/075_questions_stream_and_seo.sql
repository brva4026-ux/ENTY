-- 075: preguntas posteriores a la compra, boletas virtuales y transmisión.
--
-- Tres piezas independientes que comparten el mismo momento del ciclo:
--   * el organizador prepara la actividad (preguntas, horario del directo),
--   * el comprador compra una boleta presencial o virtual,
--   * después de comprar responde y corrige sus datos sin reemitir nada.
--
-- Todo es idempotente: schema.sql y deploy.sh aplican esta migración también
-- sobre una base que ya la tenga.

ALTER TABLE events
    ADD COLUMN IF NOT EXISTS stream_url text,
    ADD COLUMN IF NOT EXISTS stream_starts_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS stream_ends_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS stream_instructions text;

ALTER TABLE ticket_types
    ADD COLUMN IF NOT EXISTS is_virtual boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS event_questions (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id bigint NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    prompt text NOT NULL,
    help_text text,
    kind text NOT NULL DEFAULT 'text'
        CHECK (kind IN ('text', 'textarea', 'select', 'number', 'boolean')),
    options jsonb NOT NULL DEFAULT '[]'::jsonb,
    required boolean NOT NULL DEFAULT false,
    sort_order integer NOT NULL DEFAULT 0,
    closes_at timestamp with time zone,
    is_active boolean NOT NULL DEFAULT true,
    created_by_user_id bigint REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_event_questions_event
    ON event_questions (event_id, sort_order, id);

CREATE TABLE IF NOT EXISTS ticket_answers (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    question_id bigint NOT NULL REFERENCES event_questions(id) ON DELETE CASCADE,
    ticket_id bigint NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    answer jsonb NOT NULL,
    answered_by_contact text,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    UNIQUE (question_id, ticket_id)
);

CREATE INDEX IF NOT EXISTS idx_ticket_answers_ticket
    ON ticket_answers (ticket_id, question_id);
