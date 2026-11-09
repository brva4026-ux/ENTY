---
title: Auditoría de la Ley de Jakob — Enty
version: 1
scope: frontend (vitrina del fan + interior admin/promotor/puerta + auth)
principle: una sección, un nombre; un botón hace lo que dice
---

# Auditoría de la Ley de Jakob — Enty

> Objetivo: que nadie tenga que **aprender Enty** para usar Enty. La Ley de
> Jakob dice que la gente pasa la mayor parte del tiempo en *otras* apps, así
> que espera que la nuestra funcione como las que ya conoce: el mismo nombre
> para la misma cosa, el botón que hace lo que promete, el enlace que existe
> donde el patrón lo puso. En la práctica son cuatro reglas de casa:
>
> 1. **Una sección, un nombre** — la pestaña, el `h1` y el título de la
>    pestaña del navegador dicen lo mismo. Dos nombres para una pantalla
>    obligan a adivinar si son la misma.
> 2. **El botón hace lo que dice** — "Volver" vuelve; "Acceso" lleva al
>    ingreso, no a un "Perfil" que no existe.
> 3. **El affordance vive donde el patrón lo puso** — un login tiene
>    "¿Olvidaste tu contraseña?" y "Crear cuenta"; el registro es alcanzable
>    desde la portada.
> 4. **Nada promete lo que no hay** — si una ruta existe pero ninguna pantalla
>    la anuncia, para el usuario no existe.

## 1. Método

Se recorrió la app **en vivo** (dev server de Vite) con el mismo arnés
Playwright de la auditoría de Fitts: se navegó cada pantalla pública y la de
cada rol, y se comparó, para cada sección, **el nombre que muestra la
navegación** contra **el `h1`** y contra **`document.title`**. Aparte se
rastrearon los botones de "volver" y los enlaces de entrada (login/registro)
para ver si el destino coincide con la etiqueta y si el gesto tiene a dónde
ir cuando no hay historial.

## 2. Diagnóstico (evidencia dura, no opinión)

Seis defectos reales, todos verificados en vivo y arreglados:

| Síntoma | Evidencia | Causa raíz | Arreglo |
| --- | --- | --- | --- |
| La barra inferior del fan decía **"Boletos"** y **"Perfil"** | Pestaña ≠ `h1` ("Mis boletas") ≠ nav de escritorio | Tres nombres para dos destinos; y "Perfil" llevaba a `/login` (el fan no tiene cuenta) | `FanNav`: "Boletos"→**"Mis boletas"**, "Perfil"→**"Acceso"** (el destino real) |
| La nav de escritorio de Mis boletas decía **"Mis boletos"** | `h1` y `document.title` decían "Mis boletas" | Una letra de diferencia entre la pestaña y su propio encabezado | `MyTicketsPage`: "Mis boletos"→**"Mis boletas"** |
| El promotor tenía una pestaña **"Mis boletas"** | El fan también tiene "Mis boletas" (las que compró) | Dos pantallas, mismo nombre, conceptos distintos: confunde a quien tiene ambos roles | `PromoterDashboard`: pestaña y `h3`→**"Mis ventas"** |
| La pantalla de métricas se titulaba **"Embudo"** | La pestaña de navegación dice "Métricas" | El destino se llama distinto en el menú y en la página | `FunnelPage`: `h1` "Embudo"→**"Métricas"** (el "embudo" baja al subtítulo) |
| El login se titulaba **"Ingresar"** | La portada y el `h1` dicen "Iniciar sesión" | La misma acción nombrada de dos formas | `LoginPage`: `document.title`→**"Iniciar sesión"** |
| **"Volver"** era un botón muerto en un deep-link | `navigate(-1)` sin historial no lleva a ninguna parte | Un enlace de WhatsApp a `/evento/:id` abre sin historial de la app | `useBackOrFallback`: vuelve si hay `history.state.idx > 0`, si no cae al destino canónico |

Además, dos **rutas huérfanas** que ninguna pantalla anunciaba:

- `POST /auth/forgot-password` existía y funcionaba, pero **ningún** formulario
  lo llamaba: quien olvidaba su contraseña no tenía por dónde. Ahora vive como
  "¿Olvidaste tu contraseña?" en la fila de "Recordarme" del login (usa el
  correo ya escrito; sin correo, enfoca el campo en vez de abrir un modal).
- `/register` existía y funcionaba, pero **ningún** enlace llevaba a ella. Ahora
  el login cierra con "¿Aún no tienes cuenta? Crear cuenta", y la portada
  pública promueve **"Crear cuenta"** como acción principal (antes solo ofrecía
  "Iniciar sesión").

## 3. Lo que se midió y **no** se cambió (a propósito)

- **La raíz `/` sigue siendo la portada, no el login.** El patrón de muchas
  SaaS es mandar `/` al login; aquí `/` es la página que explica qué es Enty y
  el staff logueado cae en su panel (`homeForRole`). Cambiarlo rompería el
  contrato documentado en `AGENTS.md` y la portada pública.
- **Las rutas conservan sus nombres internos.** `?tab=boletas` en `/promotor`
  sigue siendo `boletas` en la URL: es un identificador estable y compartible;
  lo que cambió es la **etiqueta** visible, no la ruta. Renombrar el query
  rompería enlaces guardados sin mejorar nada que el usuario vea.
- **Los enlaces "Acceso" y "Iniciar sesión" conviven.** "Acceso" es la
  etiqueta corta de la barra inferior (cabe en el ancho de una pestaña);
  "Iniciar sesión" es la del botón grande de la portada. Ambas nombran el
  mismo destino `/login` y ninguna promete un "Perfil".

## 4. Cómo se verifica

- **E2E**: `e2e/fan.spec.js` comprueba el `h1` "Mis boletas" y el camino
  Inicio → detalle → Mis boletas; `e2e/login-welcome.spec.js` cubre el login
  (incluido el nuevo enlace de registro); `e2e/a11y.spec.js` valida un solo
  `h1` por pantalla y el título `… · Enty`.
- **Gate de diseño**: `npm run lint:design`.
- **Manual**: el arnés de comparación nombre-de-nav ↔ `h1` ↔ `document.title`
  fue temporal y se retiró; el patrón está en `e2e/a11y.spec.js`.

## 5. Reglas de casa (para no reintroducir el defecto)

1. Al renombrar una sección, cambiar **los tres** lugares a la vez: la
   pestaña, el `h1` y el `document.title` (`useDocumentTitle`). Si el
   identificador de ruta debe quedarse (URL compartible), se queda; lo que se
   unifica es la etiqueta.
2. Un destino con dos nombres distintos ("Embudo"/"Métricas") se nombra por
   **lo que hay ahí**, no por la metáfora interna.
3. Un botón de "volver" que puede montarse sin historial usa
   `useBackOrFallback(destino)`, nunca `navigate(-1)` a secas.
4. Si el backend expone una acción que el usuario espera (reset de contraseña,
   registro), **una pantalla tiene que llamarla**: un endpoint sin formulario
   es una función que no existe.
