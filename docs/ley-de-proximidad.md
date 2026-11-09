---
title: Auditoría de la Ley de Proximidad — Enty
version: 1
scope: frontend (vitrina del fan + detalle + auth + interior admin/promotor/puerta)
principle: la distancia comunica la pertenencia
---

# Auditoría de la Ley de Proximidad — Enty

> Objetivo: que el ojo sepa **qué va con qué** sin leer una sola palabra. La Ley
> de Proximidad (Gestalt) dice que lo que está cerca se percibe como un grupo y
> lo que está lejos como otra cosa. En la práctica: el hueco *dentro* de un
> grupo tiene que ser claramente menor que el hueco *entre* grupos. Cuando esa
> relación se rompe, la pantalla miente: dos cosas que son una se leen como dos,
> y dos que son distintas se leen como una.
>
> Antes de esta auditoría cada hoja elegía el espacio a ojo —"1rem u 0.85rem
> quedaba bien"—, así que el mismo par de elementos (etiqueta↔campo,
> tarjeta↔tarjeta) aparecía a distinta distancia según la pantalla. No había una
> regla, había 40 decisiones independientes.

## 1. Método

Se recorrió la app **en vivo** (dev server de Vite) con un arnés Playwright que
mide, para cada par de elementos relacionados, el **hueco vertical real** entre
el borde inferior de uno y el superior del siguiente
(`getBoundingClientRect()`), a 1280px y a 390px de ancho. No se midieron
valores declarados en CSS, sino la **geometría renderizada**: la cascada puede
sobrescribir un margen y la medición es la única que lo ve.

Se midieron cinco superficies representativas de las tres audiencias:

| Superficie | Qué se midió |
| --- | --- |
| Vitrina `/inicio` | titular → buscador → categorías → banda cinética → rejilla → lista |
| Detalle `/evento/:id` | rubro → título → resumen → cuerpo → pestañas → bloque de compra |
| Acceso `/login` | título → resumen → formulario → etiqueta → campo → fila → CTA → pie |
| Boletas `/boletas` | titular → buscador → lista |
| Panel `/admin`, `/admin/negocio` | cabecera del negocio (tile↔nombre↔KPI) → secciones → instrumentos |

## 2. La regla: roles, no píxeles

El diagnóstico no fue "falta aire aquí". Fue "no existe un vocabulario de
relaciones". Se añadió en `tokens.css` una capa de **roles de espacio** que se
apoya en la escala cruda (`--e-space-*`). La escala dice *cuánto*; el rol dice
*qué relación*:

```
--e-gap-inline   (4px)   icono<->texto, etiqueta<->campo
--e-gap-tight    (8px)   items de una misma tarjeta
--e-gap-field   (12px)   entre campos de un formulario
--e-gap-group   (16px)   entre grupos / tarjeta<->tarjeta
--e-gap-card    (24px)   padding interno de tarjeta
--e-gap-section (32px)   entre secciones de una pantalla
--e-gap-region  (64px)   entre regiones mayores (contenido<->pie)
```

La regla operativa que sale de ahí: **el hueco entre grupos es 2-4× el hueco
dentro de un grupo**. Los tests de `e2e/proximidad.spec.js` verifican esa
*relación*, no un valor exacto: que el buscador esté más cerca de las categorías
que del titular; que el cuerpo del detalle abra más hueco que el título; que la
etiqueta esté pegada a su campo. El diseño puede mover los números; lo que no
puede romperse es la proporción.

## 3. Diagnóstico (evidencia dura, no opinión)

| Síntoma | Evidencia medida | Causa raíz | Arreglo |
| --- | --- | --- | --- |
| El buscador y las categorías se leían como **dos cosas** | Hueco buscador↔categorías = titular↔buscador = **16px** | Los dos usaban `margin-top: 1rem`, más un `padding-bottom: 0.35rem` (5.6px) que no separaba nada | `.home-search` → `--e-gap-section`; `.home-cats` → `--e-gap-group` (grupo interno chico) |
| La banda cinética flotaba **sin dueño** | Estaba a 16px del resultado y a 16px de los filtros | `margin-top: 1rem` plano, sin rol | `.home-ticker` → `--e-gap-section`: cierra el grupo "decidir qué ver" y abre el resultado |
| La rejilla de eventos se leía como **otra pantalla** | 24px de hueco contra 16px dentro de la fila de decisiones | `.home-grid` usaba `1.5rem` en vez de la escala de rol | `.home-grid` → `--e-gap-group` |
| El troquel del destacado dejaba **"Próximos" flotando** | 24px+24px empujaban la lista lejos del destacado | `margin: 1.5rem 0` / `2rem 0` a ojo | `.enty-perf` → `--e-gap-group`, y `--e-gap-card` en escritorio |
| La lista "Próximos" no pertenecía a su rótulo | Sin hueco propio; `gap: 0.75rem`/`0.9rem` mezclados | Dos gaps distintos para la misma rejilla | `.home-list`: `margin-top: --e-gap-tight`, `gap: --e-gap-field` |
| El pie competía con el contenido | `--e-space-16` fijo | El rol existía pero la hoja usaba la escala cruda | `.home-foot` → `--e-gap-region` |
| **La cabecera del panel** medía 0.875rem a su bloque | `.pc-sec` `margin-bottom: 0.875rem` (14px, fuera de la escala) | Valor a ojo, no un rol | `.pc-sec` → `--e-gap-group`; su padding a `--e-gap-tight` |
| Los instrumentos del panel se **tocaban** | `gap: 0.625rem` (10px) < su propio padding (13px) | El hueco entre tarjetas era menor que su padding interno: se leían como una sola pieza | `.pc-instruments` → `--e-gap-group` |
| La cabecera del negocio **no tenía jerarquía** | tile↔nombre 11.2px, nombre↔KPI 20px, meta 9.6px, delta 6.4px | Cinco valores distintos, ninguno de la escala | `.vh-*` → `--e-gap-card` / `--e-gap-field` / `--e-gap-inline` / `--e-gap-tight` |
| Las tarjetas de evento del admin (`evx`) **bailaban** | head 16px vs grid 13.6px vs stats 8px vs meter 13.6px | `0.85rem`, `0.95rem`, `0.85rem` a ojo | `.evx-*` → `--e-gap-group`/`--e-gap-field`/`--e-gap-tight` |

## 4. Lo que se midió y **no** se cambió (a propósito)

- **El login ya estaba bien.** Medido: etiqueta↔campo 6px, resumen↔formulario
  24px, campo↔fila 109px (el hueco lo da el formulario, no un margen suelto).
  La relación ya era correcta, así que solo se añadió el test que la protege.
- **El detalle de evento ya tenía su cabecera agrupada.** Medido: rubro↔título
  8px, título↔resumen 8px, resumen↔cuerpo 24px. Se protege con un test; no se
  tocó.
- **La banda cinética se queda.** Es un motivo de marca documentado (el
  "ticker" de la noche) y el equipo ya la había ajustado a propósito para no
  repetir categorías. Se le dio un *rol* (frontera entre decidir y ver), no se
  eliminó.
- **Los tokens crudos (`--e-space-*`) siguen existiendo.** Los roles no los
  reemplazan: son una capa de intención encima. Un valor crudo puntual (un
  alto, un radio, un icono) sigue siendo correcto; lo que se eliminó es el
  *espaciado entre elementos relacionados* elegido a ojo.
- **No se tocó la escala de tipografía ni los colores.** Esta auditoría es de
  distancia; el tamaño y el contraste tienen sus propias auditorías
  (`docs/ley-de-fitts.md`, `e2e/a11y.spec.js`).

## 5. Cómo se verifica

- **E2E**: `e2e/proximidad.spec.js` (6 pruebas) mide la *relación* de huecos en
  la vitrina, el detalle, el login y el panel; se salta sola si la app o el seed
  no están. Las pruebas de presentación de la vitrina siguen en
  `e2e/a11y.spec.js` (buscador, categorías, destacado, "Próximos").
- **Gate de diseño**: `npm run lint:design`.
- **Stylelint**: `npm run lint:css` (0 errores).
- **Manual**: el arnés de medición de huecos fue temporal y se retiró; el patrón
  está en `e2e/proximidad.spec.js` (`getBoundingClientRect()` sobre el par de
  selectores, no sobre el CSS declarado).

## 6. Reglas de casa (para no reintroducir el defecto)

1. **Espaciar entre elementos relacionados se hace con un rol**, no con un
   valor crudo: `--e-gap-inline|tight|field|group|card|section|region`. La
   escala cruda (`--e-space-*`) queda para altos, radios y paddings puntuales.
2. **El hueco entre grupos debe ser 2-4× el hueco dentro del grupo.** Si dudas,
   mide: si el hueco hacia afuera es igual o menor que hacia adentro, el ojo
   agrupa mal.
3. **Un encabezado pertenece a su bloque, no a la pantalla.** El rótulo de una
   sección se separa de su contenido con `--e-gap-group`, no con
   `--e-gap-section` (que es para separar secciones entre sí).
4. **El gap de una rejilla no puede ser menor que el padding de sus tarjetas.**
   Si lo es, las tarjetas se leen como una sola pieza (fue el caso de
   `.pc-instruments`).
5. **Un valor de espaciado que no está en la escala es una señal de alarma**
   (0.875rem, 0.625rem, 1.35rem…). O pertenece a un rol, o es un caso puntual
   que conviene comentar.
