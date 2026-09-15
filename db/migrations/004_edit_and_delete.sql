-- =============================================================================
-- Migración 004: edición y eliminación de tipos de boleta y cupos de promotor.
--
-- Reglas que protege (dinero, no cosmética):
--   1. Un tipo no puede quedar por debajo de las boletas YA emitidas de ese
--      tipo (`quantity_below_issued`). Como toda quantity_i >= issued_i, la
--      suma de quantities del evento sigue cubriendo el total emitido: el mismo
--      invariante que ya sostienen emit_ticket() y la apertura de puertas.
--   2. Un cupo de promotor no puede quedar por debajo de las boletas emitidas
--      contra él (`capacity_below_used`).
--   3. Un tipo/cupo archivado (is_active = FALSE) no recibe boletas nuevas. Las
--      columnas `is_active` existían desde el esquema inicial pero NINGUNA
--      consulta las miraba, así que "desactivar" no tenía efecto real: el
--      trigger de la sección 4 lo vuelve efectivo.
--   4. Eliminar es destructivo solo cuando es seguro: si el tipo/cupo no tiene
--      ninguna boleta se borra la fila; si tiene historial se archiva (borrarlo
--      rompería la trazabilidad — y el FK RESTRICT lo impediría de todos modos).
--
-- El lock es `SELECT ... FOR UPDATE` sobre la MISMA fila que bloquea
-- emit_ticket(), así que una emisión concurrente no puede colarse entre el
-- conteo y el UPDATE.
--
-- Idempotente: safe re-run.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) Editar un tipo de boleta
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_ticket_type(
    p_type_id      bigint,
    p_name         text,
    p_price_cents  bigint,
    p_quantity     integer,
    p_is_courtesy  boolean,
    p_is_active    boolean
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    v_id     bigint;
    v_issued bigint;
BEGIN
    SELECT id INTO v_id FROM ticket_types WHERE id = p_type_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'ticket_type_not_found'; END IF;

    IF p_quantity IS NULL OR p_quantity <= 0 THEN
        RAISE EXCEPTION 'invalid_quantity';
    END IF;

    SELECT count(*) INTO v_issued
      FROM tickets
     WHERE ticket_type_id = p_type_id
       AND status NOT IN ('voided', 'refunded');

    IF p_quantity < v_issued THEN
        RAISE EXCEPTION 'quantity_below_issued (quantity=%, issued=%)', p_quantity, v_issued;
    END IF;

    UPDATE ticket_types
       SET name        = p_name,
           price_cents = p_price_cents,
           quantity    = p_quantity,
           is_courtesy = p_is_courtesy,
           is_active   = p_is_active
     WHERE id = p_type_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2) Editar un cupo de promotor (solo capacidad y vigencia)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_promoter_allocation(
    p_allocation_id bigint,
    p_capacity      integer,
    p_is_active     boolean
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    v_id   bigint;
    v_used bigint;
BEGIN
    SELECT id INTO v_id FROM promoter_allocations WHERE id = p_allocation_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'allocation_not_found'; END IF;

    IF p_capacity IS NULL OR p_capacity < 0 THEN
        RAISE EXCEPTION 'invalid_capacity';
    END IF;

    SELECT count(*) INTO v_used
      FROM tickets
     WHERE allocation_id = p_allocation_id
       AND status NOT IN ('voided', 'refunded');

    IF p_capacity < v_used THEN
        RAISE EXCEPTION 'capacity_below_used (capacity=%, used=%)', p_capacity, v_used;
    END IF;

    UPDATE promoter_allocations
       SET capacity  = p_capacity,
           is_active = p_is_active
     WHERE id = p_allocation_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3) Eliminar: borra si no hay historial, archiva si lo hay.
--    Devuelve TRUE si quedó archivado, FALSE si se borró la fila.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION delete_ticket_type(p_type_id bigint)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
    v_id      bigint;
    v_tickets bigint;
BEGIN
    SELECT id INTO v_id FROM ticket_types WHERE id = p_type_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'ticket_type_not_found'; END IF;

    SELECT count(*) INTO v_tickets FROM tickets WHERE ticket_type_id = p_type_id;

    IF v_tickets = 0 THEN
        -- Sin boletas: se puede borrar de verdad. Las asignaciones de promotor
        -- de este tipo caen en cascada, y no pueden tener boletas (una boleta
        -- de este tipo la referenciaría a él también).
        DELETE FROM ticket_types WHERE id = p_type_id;
        RETURN FALSE;
    END IF;

    UPDATE ticket_types SET is_active = FALSE WHERE id = p_type_id;
    RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION delete_promoter_allocation(p_allocation_id bigint)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
    v_id      bigint;
    v_tickets bigint;
BEGIN
    SELECT id INTO v_id FROM promoter_allocations WHERE id = p_allocation_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'allocation_not_found'; END IF;

    SELECT count(*) INTO v_tickets FROM tickets WHERE allocation_id = p_allocation_id;

    IF v_tickets = 0 THEN
        -- tickets.allocation_id es ON DELETE SET NULL: sin boletas, el borrado
        -- no pierde nada.
        DELETE FROM promoter_allocations WHERE id = p_allocation_id;
        RETURN FALSE;
    END IF;

    -- Con historial: se archiva para no perder de quién era cada boleta
    -- (lo usa el reporte por promotor).
    UPDATE promoter_allocations SET is_active = FALSE WHERE id = p_allocation_id;
    RETURN TRUE;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4) Un tipo/cupo archivado no puede recibir boletas nuevas.
--    Se resuelve con un trigger (no reescribiendo emit_ticket) para que valga
--    para CUALQUIER camino de inserción, no solo el de la API.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION tickets_check_active_refs()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_type_active  boolean;
    v_alloc_active boolean;
BEGIN
    SELECT is_active INTO v_type_active FROM ticket_types WHERE id = NEW.ticket_type_id;
    IF v_type_active IS NOT TRUE THEN
        RAISE EXCEPTION 'ticket_type_inactive';
    END IF;

    IF NEW.allocation_id IS NOT NULL THEN
        SELECT is_active INTO v_alloc_active
          FROM promoter_allocations WHERE id = NEW.allocation_id;
        IF v_alloc_active IS NOT TRUE THEN
            RAISE EXCEPTION 'allocation_inactive';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tickets_check_active_refs ON tickets;
CREATE TRIGGER trg_tickets_check_active_refs
    BEFORE INSERT ON tickets
    FOR EACH ROW EXECUTE FUNCTION tickets_check_active_refs();

COMMIT;
