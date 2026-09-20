"""Guardia SSRF para URLs que el SERVIDOR va a descargar.

El único flujo donde un input del usuario se convierte en una request de red
saliente es la imagen compuesta de la boleta: ticket_image descarga el
flyer/logo del venue. Sin guardia, un admin podría apuntar flyer_url a
http://169.254.169.254/ (metadata de la nube) o a una IP interna del runtime
y leer la respuesta a través del JPEG compuesto.

Regla: esquema http(s) OBLIGATORIO y TODAS las direcciones a las que resuelve
el host deben ser públicas. Se resuelve DNS en el momento de la validación;
el DNS rebinding posterior (validar dominio y que cambie a IP privada antes
del fetch) es un vector residual documentado: exigiría que el atacante
controlara el DNS de su propio dominio de imágenes.
"""
import ipaddress
import re
import socket
from urllib.parse import urlparse

# Redes que NUNCA son destino legítimo de una imagen: loopback, privadas,
# link-local (incluye 169.254.169.254, la metadata de AWS/GCP), CGNAT,
# reservadas y multicast.
_BLOCKED_V4 = ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.168.0.0/16", "198.18.0.0/15", "224.0.0.0/4", "240.0.0.0/4"]
_BLOCKED_V6 = ["::1/128", "fc00::/7", "fe80::/10", "ff00::/8"]
_BLOCKED_NETS = [ipaddress.ip_network(n) for n in _BLOCKED_V4 + _BLOCKED_V6]


def _is_public_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """False también para IPs no asignadas globalmente (is_global=False)."""
    if not ip.is_global:
        return False
    return not any(ip in net for net in _BLOCKED_NETS)


# Flyer subido desde el navegador: vive en la tabla `media` de esta misma DB
# y se sirve por GET /media/{id} (misma pagina). No hay fetch de red posible:
# el <img> pinta del propio origen, asi que la guardia SSRF no aplica.
_MEDIA_PATH = re.compile(r"^/media/[0-9]{1,12}$")


def validate_flyer_url(url: str) -> str:
    """URL de flyer válida: ruta interna /media/{id} O http(s) público."""
    if not url or not url.strip():
        raise ValueError("La URL de la imagen no puede estar vacía.")
    u = url.strip()
    if _MEDIA_PATH.match(u):
        return u
    return validate_public_http_url(u)


def validate_public_http_url(url: str) -> str:
    """Devuelve la URL si es http(s) con host que resuelve SOLO a IPs públicas.

    Lanza ValueError con mensaje entendible: los schemas de pydantic lo
    convierten en 422 y el admin ve por qué se rechazó su URL.
    """
    if not url or not url.strip():
        raise ValueError("La URL de la imagen no puede estar vacía.")
    u = url.strip()
    parsed = urlparse(u)
    if parsed.scheme not in ("http", "https"):
        raise ValueError("La URL de la imagen debe empezar por http:// o https://.")
    host = parsed.hostname
    if not host:
        raise ValueError("La URL de la imagen no tiene un host válido.")

    # ¿El host ya es una IP literal? (http://10.0.0.5/flyer.jpg)
    try:
        literal = ipaddress.ip_address(host)
        if not _is_public_ip(literal):
            raise ValueError("La URL apunta a una dirección no pública.")
        return u
    except ValueError as e:
        if "no pública" in str(e) or "pública" in str(e):
            raise
        # no era una IP literal: seguir a resolución DNS

    # Dominio: TODAS las respuestas DNS deben ser públicas (un dominio que
    # mezcla una IP pública con una interna se rechaza entero).
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        raise ValueError("No se pudo resolver el host de la imagen.")

    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if not _is_public_ip(ip):
            raise ValueError(
                "La URL de la imagen apunta a una dirección interna, no permitida."
            )
    return u
