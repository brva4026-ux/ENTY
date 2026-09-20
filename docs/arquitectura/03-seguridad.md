# 3. Seguridad y Prevención de Fraude

## 3.1 Falsificación de QRs

**Modelo elegido: token opaco con HMAC + estado en la DB.**

Un QR **no lleva datos legibles** (ni nombre, ni evento, ni precio). Solo lleva:

```
QR payload = base64url( random_token ) + ":" + HMAC_SHA256( random_token, SERVER_SECRET )
```

- `random_token`: 24+ bytes de entropía (`secrets.token_urlsafe(24)`), con sha256
  guardado en `tickets.token_hash` (nunca el token en claro en la DB).
- La **firma HMAC** permite que el bouncer (y la API) verifiquen en *microsegundos*
  que el QR fue emitido por nosotros, sin necesidad de consultar la DB en cada
  escaneo (útil offline).
- Como el token es aleatorio y de un solo uso (compare-and-swap de `redeem_ticket`),
  **copiar el QR no sirve**: la segunda persona recibe `ALREADY_REDEEMED`.

**Por qué NO JWT como payload del QR:**

| Criterio | Token HMAC (elegido) | JWT como payload |
|---|---|---|
| Filtrar datos en el QR | ✅ nada legible | ❌ payload base64 se decodifica (nombre, evento) |
| Revocación previa | ✅ se revoca anulando en DB | ❌ ad hoc |
| Verificación offline | ✅ HMAC con clave estática | ✅ (pero igual requiere estado para one-time) |
| Uso único | ✅ estado en DB via CAS | ❌ hard |

**Código de verificación** (`backend/servicios/qr.py` — fragmento de referencia):

```python
import base64, hashlib, hmac, secrets, os

def generar_token_firmado(secret: bytes) -> str:
    token = secrets.token_urlsafe(24)
    sig = hmac.new(secret, token.encode(), hashlib.sha256).digest()[:16]
    return token + "." + base64.urlsafe_b64encode(sig).decode()

def verificar_firma(qr_text: str, secret: bytes) -> str | None:
    try:
        token, b64 = qr_text.split(".", 1)
        sig = base64.urlsafe_b64decode(b64 + "==")
        probe = hmac.new(secret, token.encode(), hashlib.sha256).digest()[:16]
        if not hmac.compare_digest(probe, sig):
            return None
        return token            # ok, corresponde a una boleta emitida
    except Exception:
        return None
```

El flujo de `redeem_ticket` **ya implementado** hace línea a línea:
1. verifica formato y firma (cuando offline, con la clave del tenant),
2. busca `token_hash = sha256(token)` en tickets,
3. valida evento + estado,
4. `UPDATE ... WHERE status='issued'` (compare-and-swap) → o `GRANTED` o
   `ALREADY_REDEEMED` — nunca ambos.

## 3.2 El fraude #1: reenvío de la misma boleta

Aunque el QR sea de un solo uso, el asistente puede **reenviarlo por WhatsApp
ante de usarlo**. El control humano es parte del diseño:

- La boleta visual (Portada de ticket) lleva **nombre del asistente** en grande.
- El bouncer compara "¿es la misma persona?" antes de validar.
- Con `GRANTED`, la app muestra el nombre en gigante (ya implementado) para
  agilizar esa comprobación.
- **Complemento técnico** (fase 2): QR animado o con temporizador de 60s no
  es viable en papel, pero sí con boleta digital viva (WebSocket de vencer).
  Para MVP decidimos: boleta estática + nombre visible + un solo uso.

## 3.3 Protección de la cuenta de bouncer en dispositivos compartidos

El celular del bouncer **es compartido** y está en la puerta. Decisiones:

| Frente | Diseño |
|---|---|
| **Sesión** | JWT de **corta duración** (p.ej. 4h) + `iat`/`exp`; sin refresh de larga vida en ese dispositivo |
| **Pin del evento** | Cada evento puede tener un PIN de 4-6 dígitos que el bouncer debe teclear al iniciar el turno (bind a `scanned_by_user_id` + `event_id`). |
| **Cierre automático** | La app del bouncer bloquea tras 5 min sin uso (configurable) y tras N escaneos; obliga al PIN de turno. |
| **Monouso del equipo** | `redeem_ticket` registra `scanned_by_user_id`: cualquier escaneo anómalo de un turno queda auditado (tabla `redemptions`). |
| **No persistencia de token** | En modo compartido preferimos un `sessionStorage` (se limpia al cerrar el navegador) en vez de `localStorage`. |
| **Rate-limit** | `redeem` limitado a ~60 req/min por dispositivo/IP para evitar fuerza bruta de códigos. |

## 3.4 Consola / auditoría

- `redemptions` guarda **todo** intento con outcome. Permite responder:
  "¿cuántos intentaron con la misma boleta?" (detección de reenvío)
  "¿quién escaneó a las 2 AM y en qué evento?".
- `price_cents_snapshot` congela el precio al emitir (inmutable abajo de la
  fila de dinero).
- Soft-delete / jornadas: se usará `closed_at` en eventos, nunca borrado físico
  de filas de dinero.

## 3.4b Decisión: ¿QR firmados con HMAC? (mig 019, no aplicado)

La recomendación estándar del rubro (Ticketmaster SafeTix) firma el QR con
HMAC. Aquí NO se aplica por decisión de diseño, y es deliberada:

- El token del invitado es **aleatorio de 192 bits**: no se puede fabricar
  (fabricar un token válido = adivinar 2^192). El HMAC protege QRs
  *derivados de datos* (asiento, evento); los nuestros no derivan de nada.
- La DB guarda solo el SHA-256: filtrar la base no produce boletas
  canjeables. Un HMAC estático en cambio exige rotación de secreto y los
  QRs viejos siguen "viendo" válido el algoritmo aunque se anule la fila.
- El un-solo-uso es el **compare-and-swap** de `redeem_ticket` en DB: dos
  puertas escaneando simultáneo, una sola gana (testado).
- Revocación: matar la fila del token mata el QR al instante; con HMAC hay
  que mantener además una lista de revocación en cada validación.

Lo que sí se endureció en la 019: sesiones revocables (`token_version`),
auditoría de dinero/exports (`audit_log`) y rate limit de escaneos.

## 3.5 Checklist de seguridad operacional

- [ ] HTTPS en frontend y API (TLS 1.2+).
- [ ] Headers: `Content-Security-Policy`, `X-Frame-Options`.
- [ ] JWT firmado con secreto rotativo; campo `kid` para rotación.
- [ ] bcrypt (ya pinesado a 4.0.1 por compatibilidad passlib) para passwords.
- [ ] No loguear tokens ni `password_hash`.
- [ ] El `JWT_SECRET` en el `.env`, nunca en git.
- [ ] En producción: secret manager del hosting (no env estático).