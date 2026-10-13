"""Generadores de referencias del ciclo de pagos.

La `reference` es la llave de todo el ciclo (viaja a Wompi y vuelve en el
webhook): en el checkout publico ademas actua como CAPABILITY — es el unico
dato con que el fan consulta el estado de su cobro sin cuenta. 48 bits se
adivinan; 128 no. Vive aqui (no en un router) para que el cobro del admin y
el del fan usen exactamente el mismo formato.
"""
import secrets


def payment_reference(event_id: int) -> str:
    """Referencia legible y aleatoria: "TF-<evento>-<32 hex> (128 bits)"."""
    return f"TF-{event_id}-{secrets.token_hex(16)}"
