"""Mapa ÚNICO de errores SQL de negocio → HTTP.

Antes cada router traducía los mismos códigos por separado (tickets, events,
payments, public_tickets, waitlist, lifecycle): seis listas de `if` que podían
divergir, así que el mismo error sonaba distinto según la puerta por la que
entró. Aquí vive una sola tabla; los routers solo aportan los pocos mensajes
donde el CONTEXTO de la puerta cambia la frase útil (p. ej. la puerta le dice
al bouncer "selecciona otro evento en el escáner").

El contrato de códigos lo fijan las funciones/triggers de la DB: cada
`RAISE EXCEPTION 'codigo (...)'` de las migraciones. El match es por subcadena
sobre `diag.message_primary`, de la clave más larga a la más corta (para que
`event_not_open` no se coma a `event_not_open_for_sales`).
"""
from typing import Mapping

import psycopg
from fastapi import HTTPException

# Código (prefijo del RAISE) → (status HTTP, mensaje canónico).
DB_ERRORS: dict[str, tuple[int, str]] = {
    # Emisión / canje (tickets.py, payments.py)
    "promoter_quota_exceeded": (409, "Cupo de promotor agotado para este tipo de boleta"),
    "ticket_type_not_found": (404, "Tipo de boleta no encontrado"),
    "ticket_type_sold_out": (409, "Sin disponibilidad para este tipo/evento"),
    "event_at_capacity": (409, "Sin disponibilidad para este tipo/evento"),
    "event_not_open_for_sales": (409, "El evento no esta abierto para emision"),
    "ticket_type_inactive": (
        409,
        "Ese tipo de boleta esta archivado: no se pueden emitir mas boletas de ese tipo",
    ),
    "allocation_inactive": (409, "Tu cupo esta archivado: pidele al admin que lo reactive"),
    "paid_ticket_tied_to_promoter_allocation": (
        400,
        "Una boleta de pago no puede usar cupo de promotor",
    ),
    "event_not_found": (404, "Evento no encontrado"),
    "ticket_not_found": (404, "Boleta no encontrada"),
    "cannot_reissue_redeemed": (409, "La boleta ya fue usada: no se puede reemitir"),
    "cannot_reissue_ticket": (
        409,
        "La boleta no esta vigente (anulada o reembolsada): no se puede reemitir",
    ),
    "event_closed": (409, "El evento ya cerro: no se puede reemitir"),
    # Devolución del invitado (mig 021)
    "return_window_closed": (409, "La ventana de devolución ya cerró"),
    "token_stale": (409, "Este enlace ya no es la credencial vigente de la boleta"),
    "cannot_return_ticket": (
        409,
        "La boleta no se puede devolver (no esta vigente o ya fue usada)",
    ),
    # Corrección de contacto del asistente (mig 015)
    "cannot_edit_ticket_status": (
        409,
        "Solo se puede corregir el contacto de boletas vigentes (no usadas ni anuladas)",
    ),
    "nothing_to_update": (400, "No hay nada que actualizar: envía nombre o teléfono"),
    # Validaciones de datos (compartidas)
    "invalid_phone": (400, "El teléfono no parece válido"),
    "invalid_name": (400, "El nombre no puede quedar vacío"),
    "invalid_token_format": (400, "Datos incompletos"),
    # Conciliación de caja (mig 042): medio de pago de una venta directa.
    "invalid_payment_method": (
        400,
        "Medio de pago inválido: usa efectivo, transferencia o pago en línea",
    ),
    # Edición / borrado (mig 004)
    "allocation_not_found": (404, "Cupo no encontrado"),
    "quantity_below_issued": (
        409,
        "No puedes dejar la cantidad por debajo de las boletas ya emitidas",
    ),
    "capacity_below_used": (
        409,
        "No puedes dejar la capacidad por debajo de las boletas ya emitidas",
    ),
    "capacity_cannot_be_below_issued": (
        409,
        "No puedes bajar el aforo por debajo de las boletas ya emitidas",
    ),
    "invalid_quantity": (400, "La cantidad debe ser mayor que cero"),
    "invalid_capacity": (400, "La capacidad no puede ser negativa"),
    "invalid_window": (
        400,
        "La ventana del evento no es válida: el cierre debe ser posterior a "
        "la apertura y la apertura no puede estar en el pasado",
    ),
    "starts_at_in_past": (
        400,
        "La ventana del evento no es válida: el cierre debe ser posterior a "
        "la apertura y la apertura no puede estar en el pasado",
    ),
    # Cobros online (payments.py)
    "payment_amount_mismatch": (409, "El monto pagado no coincide con el cobrado"),
    "payment_not_approvable": (409, "El cobro ya no esta pendiente: no se puede aprobar"),
    "payment_not_found": (404, "Cobro no encontrado"),
    # Lista de espera (waitlist.py)
    "waitlist_not_needed": (409, "El evento aun tiene boletas: no hay lista de espera"),
    "event_not_open": (409, "El evento no esta abierto"),
    "waitlist_offer_expired": (
        409,
        "Tu ventana de reclamo cerro: el lugar paso al siguiente",
    ),
    "waitlist_spot_gone": (
        409,
        "El lugar ya no esta disponible: se ofrecio al siguiente",
    ),
    "waitlist_entry_not_found": (404, "No estas en la lista de este evento"),
    # Ciclo de vida (lifecycle.py)
    "invalid_transition": (
        409,
        "El evento no está en el estado esperado para esa transición",
    ),
    "cannot_void_redeemed": (409, "No se puede anular una boleta ya redimida"),
    "cannot_void_ticket": (409, "La boleta no puede anularse en este estado"),
}

# Claves ordenadas de mayor a menor: la primera coincidencia gana, así los
# códigos específicos ("event_not_open_for_sales") no quedan tapados por un
# prefijo genérico ("event_not_open").
_CODES_BY_LENGTH = sorted(DB_ERRORS, key=len, reverse=True)


def _primary(e: psycopg.errors.Error) -> str:
    """Mensaje primario del error (psycopg lo deja en e.diag)."""
    diag = getattr(e, "diag", None)
    return (getattr(diag, "message_primary", "") or "") or str(e)


def translate_db_error(
    e: psycopg.errors.Error,
    overrides: Mapping[str, tuple[int, str]] | None = None,
) -> HTTPException | None:
    """Traduce un error de negocio de la DB a HTTPException.

    Devuelve `None` si el código no está en el mapa: el llamador decide el
    fallback (re-lanzar el original en las rutas de negocio, o un 500 genérico
    en las de transición). `overrides` permite cambiar status/mensaje de un
    código concreto para el contexto de una puerta.
    """
    primary = _primary(e)
    diag = getattr(e, "diag", None)
    constraint = getattr(diag, "constraint_name", "") or ""
    # Nombre de tipo duplicado: el único caso que llega por constraint, no por
    # RAISE (índice único ticket_types_event_id_name_key).
    if (
        constraint == "ticket_types_event_id_name_key"
        or "ticket_types_event_id_name_key" in primary
    ):
        return HTTPException(
            409,
            "Ya existe un tipo con ese nombre en este evento"
            " (si estaba archivado, reactívalo en vez de crearlo)",
        )
    for code in _CODES_BY_LENGTH:
        if code in primary:
            status, message = DB_ERRORS[code]
            if overrides and code in overrides:
                status, message = overrides[code]
            return HTTPException(status, message)
    return None
