"""Guardia SSRF: URLs de flyer/logo que apuntan a IPs internas se rechazan.

Hermeticidad: los tests de dominios parchean socket.getaddrinfo para no
depender de DNS real (ni de red en CI).
"""
import socket
from unittest.mock import patch

import pytest

from app.core.urlguard import validate_public_http_url


def _addrinfo(ip):
    return [(socket.AF_INET, None, None, "", (ip, 0))]


class TestIpLiterals:
    def test_loopback_rejected(self):
        with pytest.raises(ValueError):
            validate_public_http_url("http://127.0.0.1/flyer.jpg")

    def test_private_range_rejected(self):
        with pytest.raises(ValueError):
            validate_public_http_url("http://10.1.2.3/flyer.jpg")

    def test_metadata_service_rejected(self):
        # 169.254.169.254: la metadata de AWS/GCP, el objetivo clasico de SSRF
        with pytest.raises(ValueError):
            validate_public_http_url("http://169.254.169.254/latest/meta-data/")

    def test_cgnat_rejected(self):
        with pytest.raises(ValueError):
            validate_public_http_url("http://100.64.0.1/flyer.jpg")

    def test_public_ip_accepted(self):
        assert validate_public_http_url("https://8.8.8.8/flyer.jpg")

    def test_non_http_scheme_rejected(self):
        with pytest.raises(ValueError):
            validate_public_http_url("file:///etc/passwd")

    def test_ftp_rejected(self):
        with pytest.raises(ValueError):
            validate_public_http_url("ftp://203.0.113.10/flyer.jpg")

    def test_empty_rejected(self):
        with pytest.raises(ValueError):
            validate_public_http_url("")


class TestDomains:
    def test_domain_resolving_public_ok(self):
        with patch.object(socket, "getaddrinfo", return_value=_addrinfo("8.8.8.8")):
            assert validate_public_http_url("https://cdn.ejemplo.com/flyer.jpg")

    def test_domain_resolving_private_rejected(self):
        with patch.object(socket, "getaddrinfo", return_value=_addrinfo("192.168.1.50")):
            with pytest.raises(ValueError):
                validate_public_http_url("https://cdn.ejemplo.com/flyer.jpg")

    def test_domain_mixed_answers_rejected(self):
        # Un dominio que mezcla una respuesta publica y una interna se
        # rechaza entero: no se juega a que gane la publica.
        with patch.object(
            socket, "getaddrinfo",
            return_value=_addrinfo("8.8.8.8") + _addrinfo("10.0.0.9"),
        ):
            with pytest.raises(ValueError):
                validate_public_http_url("https://cdn.ejemplo.com/flyer.jpg")

    def test_dns_failure_rejected(self):
        with patch.object(socket, "getaddrinfo", side_effect=OSError("nx")):
            with pytest.raises(ValueError):
                validate_public_http_url("https://noexiste.ejemplo.com/flyer.jpg")

    def test_ipv6_loopback_rejected(self):
        with pytest.raises(ValueError):
            validate_public_http_url("http://[::1]/flyer.jpg")


class TestSchemaWiring:
    """El rechazo se ve como 422 de pydantic, no como excepcion del router."""

    def test_event_create_rejects_internal_flyer(self):
        from app.schemas import EventCreate

        with pytest.raises(Exception):
            EventCreate(
                name="X",
                starts_at="2026-10-01T20:00:00-05:00",
                capacity=10,
                flyer_url="http://169.254.169.254/latest/meta-data/",
            )

    def test_event_create_accepts_public_flyer(self):
        from app.schemas import EventCreate

        ev = EventCreate(
            name="X",
            starts_at="2026-10-01T20:00:00-05:00",
            capacity=10,
            flyer_url="https://8.8.8.8/flyer.jpg",
        )
        assert str(ev.flyer_url).startswith("https://8.8.8.8")
