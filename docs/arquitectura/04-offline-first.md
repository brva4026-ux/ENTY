# 4. Sincronización Offline-First (Bouncer en la puerta)

> Escenario real: sótano de una discoteca a las 11 PM, sin señal móvil, 200
> personas en fila. El sistema no puede depender de la red **para decidir** si
> alguien entra; la red solo sirve para reportar después.

## 4.1 Idea núcleo

El bouncer mantiene una **réplica local de estados** (boletas + su `status`) y un
**log de redenciones**. Es una arquitectura *offline-first* asimétrica:

- **Descarga (snapshot)**: antes de abrir puerta, el dispositivo descarga una
  snapshot firmada con las boletas relevantes: `{ticket_key, nombre, estado, seq}`.
- **Decisión local**: cada escaneo valida **sin red** (firma HMAC + estado local).
- **Escritura diferida**: los eventos de redención se encolan localmente y se
  sincronizan con el servidor **cuando hay red**, con **idempotencia**.

## 4.2 Protocolo de snapshot

```
GET /events/{id}/offline-snapshot  (auth: JWT bouncer)

Response (gzip, opcional WebSocket de delta):
{
  "snapshot_id": "ab12cd",            // hash del contenido
  "generated_at": "2026-09-14T03:00:00Z",
  "secret_b64": "c2VjcmV0...",        // clave HMAC del evento (rotada por evento)
  "tickets": [
    {"k": "sha256-token", "name": "Ana", "status": "issued", "seq": 41},
    {"k": "sha256-token2", "name": "Luis", "status": "redeemed", "seq": 42}
  ],
  "signature": "HMAC-SHA256(serialize(tickets), evento_secret)"
}
```

- La `signature` se valida localmente → un dispositivo comprometido no puede
  inyectar `status=redeemed`.
- El dispositivo guarda el snapshot en **IndexedDB** (o SQLite con Capacitor en la
  app nativa).

## 4.3 Lógica local de validación (pseudocódigo)

```python
def escanear_local(qr_text, snapshot, secret):
    token = verificar_firma(qr_text, secret)     # HMAC
    if token is None:
        return "QR_INVALIDO"
    k = sha256(token)
    if k not in snapshot.por_key:
        return "NO_EXISTE"
    b = snapshot.por_key[k]
    if b.status in ("voided", "refunded"):
        return "ANULADA"
    if b.status == "redeemed":
        return "YA_USADA"
    # marcamos LOCAL (todavía no confirmado en servidor)
    b.status = "redeemed"
    b.local_seq = snapshot.next_seq + 1
    cola_local.append({"k": k, "ts": now()})
    return "ENTRA"  # + mostrar nombre gigante
```

Regla de coherencia: **si la snapshot indica `redeemed`, se rechaza**; si no, se
marca local. Conflictos raros (dos dispositivos sin red) se resuelven en el
merge con política: el servidor es ley, y si el servidor decía `redeemed`, el
evento diferido se descarta (el que entró con un duplicado fue error humano).

## 4.4 Sincronización idempotente (los pasos de la red)

```
POST /events/{id}/sync-now   (una o muchas redenciones)
{
  "device_id": "bouncer-3",
  "items": [
    {"k": "sha256-token", "status": "redeemed", "ts": "2026-09-15T00:01:02Z"}
  ]
}
```

- Cada item lleva la clave y el timestamp local **pero el servidor usa su propio
  `UPDATE ... WHERE status='issued'`** (compare-and-swap): el evento que llega
  segundo, aunque sea del mismo bouncer con doble scan, devuelve `already_redeemed`
  y NO cuenta doble.
- La cola local se vacía solo de los items con `ack=true`.
- **Idempotencia por `device_id + key + ts`**: si la misma redención llega dos
  veces por un reintento HTTP, el segundo ack es no-op.

## 4.5 Conflictos y garantías

| Caso | Resultado esperado |
|---|---|
| Dos bouncers, misma boleta, sin red | Ambos la marcan local; el primero en sincronizar gana; el otro recibe `already_redeemed` y se descarta. (Buena práctica: compartir por walkie-talkie quién ya entró.) |
| Bouncer con snapshot vieja | El `seq` de sincronización detecta y descarta redenciones que el servidor ya marcó. |
| Bouncer de turno B reabre la app | Re-descarga snapshot; los eventos locales sin `ack` se reenvían. |
| Dispositivo robado | Hacken el PIN de turno… pero el escaneo quedó con `scanned_by_user_id`; se revoca desactivando el `user` en admin. |

## 4.6 Storage local seguro

- **Frontend web (MVP)**: IndexedDB cifrada con clave derivada del PIN de turno
  (WebCrypto AES-GCM). En la práctica: `localStorage` para el JWT de sesión corta
  + IndexedDB para la snapshot (los tokens HMAC del evento suman un secreto más,
  pero en MVP se asume el celular de la disco).
- **App nativa (fase 4)**: Keychain/Keystore + SQLCipher.

## 4.7 Límites de diseño

- La **emisión** de boletas es online-siempre (el promotor hace `emit_ticket` con
  red). Solo el **validate** es offline.
- La anti-sobreventa del aforo se garantiza en el **momento de emitir**, no en
  puerta: el aforo de puerta simplemente no deja pasar a quien no tenga boleta
  válida; el conteo "puertas abiertas" se aproxima con `redeemed`, nunca con
  `count(local)`.