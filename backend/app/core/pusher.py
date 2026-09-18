"""Web Push (VAPID) sin servicios externos — RFC 8291 (aes128gcm) + RFC 8292.

Casos de uso en TicketFlow:
- El portero activa "avisarme" en el escáner -> el backend guarda la
  suscripción (migración 007, tabla push_subscriptions).
- Cuando el admin abre puertas (published -> live) se notifica a todos los
  dispositivos de la venue (routers/lifecycle.py -> notify_venue).

Implementación autónoma sobre `cryptography` (ya es dependencia vía
python-jose): JWT VAPID ES256 y cifrado del payload con aes128gcm. Se evita
pywebpush para no sumar dependencias de runtime; el protocolo es pequeño,
estable y quedó verificado contra Chrome/Firefox/Safari vía los vectores del
RFC. Las claves VAPID viven en variables de entorno (config.py), NUNCA en
código: vacías = push deshabilitado (no-op elegante).
"""
from __future__ import annotations

import base64
import json
import os
import struct
import time
from urllib.parse import urlparse

import httpx
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

# ---------------------------------------------------------------------------
# base64url (RFC 4648 §5, sin padding, como exige el protocolo)
# ---------------------------------------------------------------------------


def _b64url_decode(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


# ---------------------------------------------------------------------------
# Claves VAPID
# ---------------------------------------------------------------------------


def generate_vapid_keypair() -> tuple[str, str]:
    """Par de claves P-256 para VAPID, en base64url sin padding.

    Devuelve (public_key_b64, private_key_b64) con el mismo formato que
    esperan las variables VAPID_PUBLIC_KEY_B64 / VAPID_PRIVATE_KEY_B64:
    la pública es el punto no comprimido (65 bytes) y la privada el escalar
    crudo (32 bytes). Para generarlas:
        python -c "from app.core.pusher import generate_vapid_keypair; print(generate_vapid_keypair())"
    """
    key = ec.generate_private_key(ec.SECP256R1())
    pub = key.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    # Escalar crudo de 32 bytes (cryptography no soporta Encoding.Raw para EC).
    priv = key.private_numbers().private_value.to_bytes(32, "big")
    return _b64url_encode(pub), _b64url_encode(priv)


def _load_private_key(private_b64: str) -> ec.EllipticCurvePrivateKey:
    priv = _b64url_decode(private_b64)
    return ec.derive_private_key(int.from_bytes(priv, "big"), ec.SECP256R1())


# ---------------------------------------------------------------------------
# RFC 8292 — cabecera Authorization: vapid
# ---------------------------------------------------------------------------


def _vapid_auth_header(endpoint: str, private_b64: str, subject: str) -> str:
    """JWT ES256 firmado con aud=<origin del endpoint>, exp<=12h, sub=<mailto>."""
    key = _load_private_key(private_b64)
    pub_raw = key.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )

    header = {"typ": "JWT", "alg": "ES256"}
    claims = {
        "aud": f"{urlparse(endpoint).scheme}://{urlparse(endpoint).netloc}",
        "exp": int(time.time()) + 12 * 3600,
        "sub": subject,
    }
    signing_input = (
        _b64url_encode(json.dumps(header, separators=(",", ":")).encode())
        + "."
        + _b64url_encode(json.dumps(claims, separators=(",", ":")).encode())
    )
    der_sig = key.sign(signing_input.encode("ascii"), ec.ECDSA(hashes.SHA256()))
    r, s = decode_dss_signature(der_sig)
    # El JWT ES256 exige la firma en formato IEEE P1363 (r||s de 64 bytes),
    # no DER.
    raw_sig = r.to_bytes(32, "big") + s.to_bytes(32, "big")
    token = f"{signing_input}.{_b64url_encode(raw_sig)}"
    return f"vapid t={token}, k={_b64url_encode(pub_raw)}"


# ---------------------------------------------------------------------------
# RFC 8291 — cifrado del payload (aes128gcm)
# ---------------------------------------------------------------------------

# Tamaño de registro declarado en la cabecera binaria (4096 = valor típico).
_RS = 4096
# Máximo plaintext útil por registro: rs - tag GCM (16) - delimitador (1).
_MAX_PLAINTEXT = _RS - 17


def encrypt_payload(payload: bytes, p256dh_b64: str, auth_b64: str) -> bytes:
    """Cifra el payload para la suscripción (ECDH efímero + HKDF + AES-GCM).

    Devuelve el cuerpo binario con la cabecera aes128gcm embebida:
        salt(16) || rs(4) || idlen(1) || key_efímera(65) || ciphertext
    Lanza ValueError si las claves de la suscripción son inválidas (la
    suscripción está muerta y debe eliminarse).
    """
    if len(payload) > _MAX_PLAINTEXT:
        raise ValueError("payload demasiado grande para un registro aes128gcm")

    try:
        ua_pub = ec.EllipticCurvePublicKey.from_encoded_point(
            ec.SECP256R1(), _b64url_decode(p256dh_b64)
        )
    except Exception as e:
        raise ValueError("p256dh inválido") from e
    auth_secret = _b64url_decode(auth_b64)
    if not auth_secret:
        raise ValueError("auth inválido")

    eph = ec.generate_private_key(ec.SECP256R1())
    eph_pub = eph.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    ecdh_secret = eph.exchange(ec.ECDH(), ua_pub)

    # IKM: HKDF(salt=auth_secret, info="WebPush: info" 0x00 ua_pub eph_pub)
    ikm = HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=auth_secret,
        info=b"WebPush: info\x00" + _b64url_decode(p256dh_b64) + eph_pub,
    ).derive(ecdh_secret)

    salt = os.urandom(16)

    def _derive(length: int, info: bytes) -> bytes:
        return HKDF(algorithm=hashes.SHA256(), length=length, salt=salt, info=info).derive(ikm)

    cek = _derive(16, b"Content-Encoding: aes128gcm\x00")
    nonce = _derive(12, b"Content-Encoding: nonce\x00")

    # Único registro => el delimitador de padding es 0x02 (RFC 8291 §2.2).
    ciphertext = AESGCM(cek).encrypt(nonce, payload + b"\x02", None)
    header = salt + struct.pack("!IB", _RS, len(eph_pub)) + eph_pub
    return header + ciphertext


# ---------------------------------------------------------------------------
# Envío
# ---------------------------------------------------------------------------


class PushResult:
    """Resultado del envío a una suscripción individual."""

    __slots__ = ("status_code", "error")

    def __init__(self, status_code: int | None = None, error: str | None = None):
        self.status_code = status_code
        self.error = error

    @property
    def ok(self) -> bool:
        return self.status_code is not None and self.status_code < 300

    @property
    def dead(self) -> bool:
        """404/410: el navegador invalidó la suscripción -> borrar de la DB."""
        return self.status_code in (404, 410)


async def send_web_push(
    endpoint: str,
    p256dh: str,
    auth: str,
    *,
    vapid_private_b64: str,
    vapid_subject: str,
    payload: dict,
    ttl_seconds: int = 3600,
) -> PushResult:
    """Envía una notificación JSON a una suscripción Web Push.

    Nunca lanza por fallo de red/servidor: devuelve PushResult con el estado;
    el llamador decide limpiar suscripciones muertas (`result.dead`).
    """
    try:
        body = encrypt_payload(json.dumps(payload).encode("utf-8"), p256dh, auth)
    except ValueError as e:
        return PushResult(error=str(e))

    headers = {
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        "TTL": str(ttl_seconds),
        "Urgency": "high",
        "Authorization": _vapid_auth_header(endpoint, vapid_private_b64, vapid_subject),
    }
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(endpoint, content=body, headers=headers)
            return PushResult(status_code=resp.status_code)
    except httpx.HTTPError as e:
        return PushResult(error=str(e))


# ---------------------------------------------------------------------------
# Utilidad de alto nivel (la usa lifecycle.go_live)
# ---------------------------------------------------------------------------


async def notify_venue(
    rows: list[dict],
    payload: dict,
    *,
    vapid_private_b64: str,
    vapid_subject: str,
) -> tuple[list[int], int]:
    """Notifica a todas las suscripciones dadas, en paralelo.

    `rows`: dicts con id/endpoint/p256dh/auth provenientes de
    push_subscriptions. Devuelve (ids_de_suscripciones_muertas, enviados_ok).
    Si las claves VAPID no están configuradas devuelve inmediatamente ([], 0):
    push deshabilitado no debe romper la apertura de puertas. El timeout total
    acota la latencia: avisar a la puerta nunca puede bloquear la respuesta
    del admin más de unos segundos.
    """
    import asyncio

    if not vapid_private_b64 or not rows:
        return ([], 0)

    async def _one(row: dict) -> tuple[int | None, bool, bool]:
        """Devuelve (id, ok, dead)."""
        try:
            res = await send_web_push(
                row["endpoint"],
                row["p256dh"],
                row["auth"],
                vapid_private_b64=vapid_private_b64,
                vapid_subject=vapid_subject,
                payload=payload,
            )
        except Exception:  # un dispositivo caído no tumba el resto
            return (int(row["id"]), False, False)
        return (int(row["id"]), res.ok, res.dead)

    try:
        results = await asyncio.wait_for(
            asyncio.gather(*(_one(r) for r in rows)), timeout=15.0
        )
    except asyncio.TimeoutError:
        return ([], 0)

    dead = [rid for rid, ok, is_dead in results if is_dead]
    sent = sum(1 for _, ok, _ in results if ok)
    return (dead, sent)
