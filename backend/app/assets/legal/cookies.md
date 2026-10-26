# Aviso de Cookies y Tecnologías Similares

**Slug:** `cookies` · **Versión:** 1.1 · **Vigente desde:** 17 de octubre de 2026

**Cambio en la 1.1:** la tipografía ya no se pide a Google Fonts; se sirve del
propio dominio. Desaparece la transferencia de IP a ese tercero y se añade al
inventario el preferencias del aviso mismo.

> Este aviso explica qué guarda V-Pass en el navegador de quien usa la aplicación.
> Aplica la Ley 1581 de 2012 en cuanto a los identificadores que permiten
> individualizar a una persona. El detalle del tratamiento está en la Política de
> Tratamiento de Datos Personales (`privacidad`).

---

## 1. Qué usamos y qué no

**V-Pass no usa cookies de publicidad, de redes sociales, de perfilamiento
comercial ni de repetición de sesión (*session replay*).** No hay píxeles de
seguimiento ni herramientas de analítica de terceros. Esto es deliberado: la
aplicación gestiona acceso a eventos y dinero, y el rastreo publicitario no
aporta nada al servicio.

Lo que sí existe es **almacenamiento local del navegador**. La tipografía se
sirve del propio dominio (decisión tomada en esta versión): la aplicación no
envía IP ni cabeceras a ningún proveedor de fuentes. El inventario completo y
real es:

## 2. Inventario

### 2.1. Almacenamiento local propio (esencial)

| Nombre | Tipo | Qué guarda | Para qué | Duración |
|---|---|---|---|---|
| `tf_token` | `localStorage` | El token de la sesión iniciada | Mantener la sesión sin pedir la contraseña en cada pantalla | Se borra al cerrar sesión |
| `tf_theme` | `localStorage` | `light` o `dark` | Recordar el tema elegido y evitar el destello al cargar | Hasta que el usuario lo cambie o limpie el navegador |
| Caché del *service worker* | `CacheStorage` | Los archivos de la aplicación y la lista del evento descargada para el modo sin conexión | Permitir que la app abra y valide boletas cuando la puerta no tiene señal | Se renueva en cada visita |
| Suscripción a notificaciones *push* | `PushManager` | El punto de envío del navegador | Enviar avisos al usuario que los autorizó | Hasta que el usuario las desactive |
| Aviso de cookies | `localStorage` | Que este aviso ya se cerró | No repetirlo en cada visita | Hasta que el usuario limpie el navegador |

Estos elementos son **necesarios para el funcionamiento**. Sin `tf_token` no hay
sesión; sin la caché no funciona el modo sin conexión de la puerta, que es una
función central del servicio. Conforme al criterio de la autoridad, no se
solicita consentimiento para lo estrictamente necesario; se informa.

### 2.2. Terceros

| Tercero | Qué se envía | Para qué | Más información |
|---|---|---|---|
| **Sentry** | Mensaje y traza del error, versión de la app, tipo de navegador e IP | Detectar y corregir fallas de la aplicación | [Política de privacidad de Sentry](https://sentry.io/privacy/) |

La tipografía ya no entra en esta tabla: desde la versión 1.1 se aloja en el
propio dominio y **no se envía nada a proveedores de fuentes**. Google Fonts se
citaba en la 1.0 como tercero; la decisión de auto-hospedar la eliminó (mejora
de privacidad que el propio aviso declaraba como pendiente).

### 2.3. Categorías que NO usamos

Para que no haya ambigüedad, en V-Pass **no existen** cookies ni tecnologías de:
publicidad, redes sociales, analítica de terceros, *session replay*, Flash Local
Shared Objects, ni SDK de aplicaciones móviles de terceros.

## 3. Perfil no vinculado a publicidad

No se crean perfiles de usuario con fines publicitarios, no se hace *retargeting*
y no se comparte información con corredores de datos.

## 4. Cómo controlarlo

**4.1. Cerrar sesión.** Es la forma directa de eliminar `tf_token`. La opción está
en el perfil del usuario.

**4.2. Configuración del navegador.** Se puede bloquear o eliminar el
almacenamiento local y las cookies desde la configuración del navegador. Tenga en
cuenta que si lo hace: la aplicación pedirá la contraseña en cada visita y **el
modo sin conexión de la puerta dejará de funcionar**, porque la lista del evento
no podrá descargarse ni conservarse.

**4.3. Notificaciones.** El aviso del navegador al suscribirse permite
desactivarlas en cualquier momento desde la configuración del sitio en el
navegador o desde la aplicación.

## 5. Cambios

Si se incorpora una herramienta de analítica o de otro tipo que requiera
consentimiento, este aviso se actualizará **antes** de activarla y se solicitará
la autorización correspondiente.

## 6. Contacto

Dudas sobre este aviso: **vargasblancobrayan@gmail.com** o al teléfono
**310 276 5347**.

---

*Última modificación: 17 de octubre de 2026.*

---

This template was prepared and made publicly available by General Legal, PC
("General Legal"). It is provided for general reference purposes only and does
not constitute, and should not be construed as, legal advice. Use of this
template does not create an attorney-client relationship with General Legal.
