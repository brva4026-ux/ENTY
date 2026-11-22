"""Nombre público del espacio de trabajo.

"Mientras el organizador no configure su identidad, el nombre interno no se
publica": un venue creado sin nombre de negocio usa "Mi organización" solo en
el panel. Las consultas públicas (catálogo, ficha, boletas, lista de espera)
leen el nombre con esta expresión, que devuelve cadena vacía para el marcador.
"""


def public_venue_name_sql(alias: str = "v") -> str:
    return (
        "CASE WHEN coalesce((to_jsonb({a}) ->> 'is_placeholder')::boolean, false) "
        "THEN '' ELSE {a}.name END"
    ).format(a=alias)
