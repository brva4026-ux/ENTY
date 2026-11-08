---
title: Auditoría de la Ley de Fitts — Enty
version: 1
scope: frontend (vitrina del fan + interior admin/promotor/puerta + auth)
principle: cada acción se mide; lo que se arregla es lo que se mide
---

# Auditoría de la Ley de Fitts — Enty

> Objetivo: que **toda** acción de la app sea más rápida de alcanzar, más
> difícil de fallar y más cómoda de pulsar a una mano. La Ley de Fitts dice
> que el tiempo para alcanzar un objetivo depende de su **tamaño** y de su
> **distancia**: objetivo más grande y más cerca = más rápido y con menos
> error. En la práctica se traduce en cuatro reglas de casa:
>
> 1. **Tamaño** — todo control alcanza 44×44px con el dedo (WCAG 2.5.5/2.5.8).
> 2. **Distancia** — la acción principal de cada pantalla vive donde el pulgar
>    llega sin recolocar la mano (mitad inferior).
> 3. **Separación** — entre dos vecinos hay ≥8px, para que un dedo impreciso
>    no dispare la acción de al lado.
> 4. **Peso** — una sola acción principal visible; las secundarias van al menú
>    "…" (esto ya lo fija la Ley de Hick, ver `AGENTS.md`).

## 1. Método

Se midió la app **en vivo** (no sobre el código) con un arnés Playwright
temporal contra el dev server de Vite: recorrió las pantallas públicas y las de
cada rol en tres viewports (390×844, 320×720, 1280×800), leyó `getBoundingClientRect`
de cada `a, button, input, select, textarea, [role=button]` — **expandiendo el
área por los pseudo-elementos `::after/::before`** con los que el sistema
agranda el objetivo sin tocar la caja visible — y clasificó cada control por
tamaño, posición vertical y separación real borde-a-borde con su vecino.

## 2. Diagnóstico (evidencia dura, no opinión)

Cinco defectos reales, todos verificados en vivo y arreglados:

| Síntoma | Evidencia medida | Causa raíz | Arreglo |
| --- | --- | --- | --- |
| El campo "Correo o teléfono" de **Mis boletas** medía **23px de alto** | `offsetHeight: 23` (debía ser 48) | En móvil `.fan-lookup` se apila en columna y el `flex: 1 1 0%` del input pasaba a medir el **alto**: el `flex-basis: 0` gana al `height: 3rem` | `flex: none` en la regla apilada (`enty-fan.css`) |
| La fila de **"Eventos del mes"** (Reportes) medía **39px** | 316×39 en móvil | `py-2` de densidad de tabla; sin mínimo táctil | clase `.bo-event-row` + `min-height: 2.75rem` en puntero grueso (`enty-system.css`) |
| Las opciones del menú **"…"** (ActionMenu) medían **39px** | 198×39, en toda la app | El componente no fijaba mínimo táctil | `min-height: 44px` a `.menu-pop [role="menuitem"]` en móvil/táctil (`index.css`) |
| Los **atajos del alta de evento** (`.opt-chip`: fecha, aforo, ideas) medían **37px** | 191×37 dentro del modal | Píldora de densidad de escritorio | `min-height: 44px` a `.opt-chip` en móvil/táctil (`index.css`) |
| Las **7 pestañas de Reportes** medían **43px de ancho** a 320px | 43×44 cada una | `flex: 1 1 0` las encogía por debajo del mínimo | `min-width: 44px` a `.pf-tabs .tabbar-item` (`index.css`) |

Lo que **ya estaba bien** (y no se tocó): el escáner de la puerta, el topbar
autenticado, la barra inferior de pestañas, los botones primarios/secundarios y
los campos `.field` ya cumplían 44px con el dedo; el trabajo previo de Hick ya
había sacado las acciones destructivas a la primera fila.

## 3. Lo que se midió y **no** se cambió (a propósito)

- **El CTA "Comprar boleto" queda 44px bajo el pliegue** en un teléfono
  (390×844: el rail de compra empieza en y=741). La tentación es fijarlo al
  fondo, pero la vitrina del fan **ya tiene una barra de pestañas fija** en la
  parte inferior: dos barras fijas apiladas roban pantalla y compiten por el
  pulgar —lo contrario de lo que pide Fitts—. La decisión de diseño correcta
  (un único rail de compra pegajoso que reemplace la barra en esta pantalla)
  exige rehacer el layout móvil y su verificación visual; queda **propuesta**,
  no aplicada a ciegas.
- **Checkboxes nativos (login "Recordarme", registro)**: el checkbox mide 16-18px,
  pero su `<label>` asociado es el objetivo real y cumple. Se dejan nativos: su
  tamaño es el del sistema a propósito.
- **Enlaces legales en línea** (footer, párrafo de aceptación): exentos por
  WCAG 2.5.8 (objetivo *inline* en una frase).
- **Escritorio**: los controles por debajo de 44px en puntero fino (p. ej. el
  topnav de 37px) se conservan: Fitts es sobre el dedo; el cursor no necesita
  esa área y estirarlos rompería el ritmo de la retícula.

## 4. Cómo se verifica

La medición vive en `e2e/a11y.spec.js`: el test de la puerta y el del topbar
comprueban ≥44px, y cualquier control nuevo por debajo del mínimo en una
superficie cubierta falla la suite. El resto del arnés fue temporal y se retiró;
si se quiere cobertura permanente por pantalla, el patrón está en ese spec.

## 5. Reglas de casa (para no reintroducir el defecto)

1. Un control que solo existe en móvil/táctil **debe** entrar en el bloque
   `@media (max-width: 640px), (pointer: coarse)` de `index.css` o usar el
   `::after` de 44px del sistema. No inventar una tercera forma.
2. Si un contenedor cambia de fila a columna (o al revés), revisar el `flex`
   de sus hijos: `flex: 1` con `flex-basis: 0` **pisa la altura** en columna.
3. Las filas y chips de densidad de tabla llevan `min-height: 2.75rem` en
   puntero grueso, nunca un `height` fijo (que rompe el reflujo).
