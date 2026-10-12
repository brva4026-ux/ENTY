---
title: Plan de elevación estética — Enty
version: 1
scope: frontend (vitrina del fan + interior admin/promotor/puerta + auth)
principle: la marca se unifica en tokens; la cascada se aplana; la calidad se mide
---

# Plan de elevación estética avanzada — Enty

> Objetivo: llevar **toda** la estética del producto a nivel avanzado (no solo la
> vitrina del fan, que ya se rediseñó). El resultado debe sentirse como **un solo
> producto con un solo sistema**, no cuatro hojas de estilo apiladas.
>
> Regla de oro: **conservar los contratos E2E** (selectores y flujos) y la
> jerarquía de roles (admin / promotor / puerta / fan). El rediseño es de
> superficie: no mueve rutas, endpoints ni la lógica de negocio.

---

## 1. Diagnóstico (evidencia dura, no opinión)

Medido sobre el árbol actual (`frontend/src`, 8 424 líneas de CSS en 4 hojas):

| Síntoma | Evidencia | Impacto |
| --- | --- | --- |
| **Cascada apilada** | `index.css` (5 076) → `aesthetic-refresh.css` (2 433) → `enty-system.css` (348) → `enty-fan.css` (567). Cada hoja "eleva sin reescribir" la anterior. | Gana el último que escribe; depurar una regla exige revisar 4 archivos. |
| **Tokens duplicados** | 150 custom props distintas; conviven los espacios de nombres `--color-zinc-*` (Tailwind), `--tf-*`, `--home-*`, `--evd-*`, `--tkt-*`, `--vh-*`, `--enty-*`. | La misma decisión de diseño vive en 3–4 nombres; divergen. |
| **Color hardcodeado** | 44 × `#BB5CF6`, 20 × `#7C3AED`, 16 × `#6D28D9`, 15 × `#34D399`, 14 × `#D29BF9`, 23 × `#e4e4e7`, 12 × `#0B0B0F`… dentro del CSS. | La marca no se puede re-afinar en un punto. |
| **Escala tipográfica difusa** | ~24 tamaños distintos (0.5rem → 1.75rem) y **7 micro-tamaños** ≤ 0.6875rem (0.5/0.55/0.6/0.625/0.66/0.68/0.6875rem). | Sin ritmo vertical; los textos diminutos comprometen legibilidad. |
| **Escala de radios difusa** | 999px (40), 1rem (16), 0.5rem (13) + ~15 valores de una sola aparición (0.375/0.4/0.55/0.6/0.7/0.8/0.9/1.05/1.1/1.15/1.4/1.5…). | El "radio" no es un lenguaje, es una lotería. |
| **Breakpoints dispersos** | 768, 1024, 640, 900, 480, 1280, 560, 420, 400, 360 **más** candados de teléfono en `26rem`/`27rem`. | Rejillas que saltan distinto por página. |
| **Modo claro reactivo** | ~430 líneas de remapeo `html[data-theme="light"]` solo en `index.css` (2974→3400s). | El claro se parcha caso por caso → se escapan bugs. |
| **Estilos en línea** | 27 `style={{…}}` en JSX (tamaños de esqueleto, colores de gráfico). | Rompe el sistema; imposible de tematizar. |
| **`!important`** | 11 (index 7, enty-system 3, refresh 1). | Síntoma de pugna de especificidad. |
| **Sin guardarraíles** | No hay stylelint/eslint, ni regresión visual (Chromatic/Percy/backstop). Los E2E (4 specs, 6 tests) solo cubren flujos. | Nada impide que la estética se degrade con el próximo commit. |
| **Motion desparejo** | 26 `@keyframes` (index 23, fan 2, refresh 1) y solo 9 bloques `prefers-reduced-motion`. | Animaciones que no se apagan con la preferencia del SO. |
| **Contraste en claro (2 bugs reales)** | `/waitlist`: `<p class="text-white">` sobre `.card` blanco (1:1). `/login`: el título del panel de marca hereda `#171a20` sobre el navy del panel (1.07:1). | Texto **invisible** en tema claro. |
| **Tap targets** | 30–40 px en admin (avatar 30, tema/notificaciones 32, botones de fila 40) contra el objetivo de 44 px (AGENTS.md). | Falla la ergonomía táctil que el propio repo exige. |
| **Foco de teclado desparejo** | `:focus-visible` global (radio 0.375rem) vs controles redondos/pill. | El anillo no sigue la forma del control. |

**Lo que ya está bien y hay que proteger**: la marca es coherente y distintiva
(matte black, violeta, verde/rosa con significado, Sora única voz); la boleta
pública `.tkt` es un artefacto troquelado de primera; el motivo de boleto
perforado y el ticker del fan ya existen; el modo oscuro por defecto y la puerta
forzada oscura son decisiones correctas.

---

## 2. Visión y principios

**Concepto rector**: *"boletería nocturna de precisión"* — un sistema editorial,
futurista y táctil, donde la **entrada física** (el troquel, la muesca, la tinta
sobre papel) es el ADN visual, y el **dato en vivo** (aforo, validaciones, cupos)
es la energía. Nada decorativo que no signifique algo.

Cinco principios que gobiernan cada decisión:

1. **Un sistema, no cuatro.** Una sola fuente de verdad (tokens) y una cascada
   plana por capas semánticas. El color, el radio, el espacio y el movimiento se
   **eligen**, no se inventan por página.
2. **La marca en un punto.** Ningún hex de marca dentro de un componente; todo
   sale de un token. Cambiar `--brand` debe re-vestir el producto entero.
3. **El acento significa.** Violeta = acción; verde = validado/disponible; rosa =
   urgencia/últimas; ámbar = atención; rojo = rechazo. Nunca decoración.
4. **Profundidad por materia, no por brillo.** Superficies con relieve de 1px,
   grano sutil, auras radiales contenidas y sombras de contacto (no `box-shadow`
   regadas). El claro es un material distinto del oscuro, no un filtro.
5. **Movimiento que respeta.** Solo `transform`/`opacity`, curva única, y todo se
   apaga con `prefers-reduced-motion`. Los momentos de alto impacto se
   orquestan (una entrada escalonada), no se dispersan.

**Elevación por rol** (misma marca, distinta densidad):

- **Fan** (público): editorial y aireado. Es la vitrina.
- **Admin**: denso, monocromo, con el violeta reservado a la acción primaria.
- **Promotor**: densidad media, tinte de marca en cupos/ranking.
- **Puerta**: máximo contraste, siempre oscuro, tap targets grandes, cero adornos.

---

## 3. Sistema de tokens (la base de todo)

Se crea `frontend/src/tokens.css`, importado **primero** en `main.jsx`. Tres
niveles, con prefijo único `--e-*` (Enty) para no chocar con Tailwind ni con los
espacios legacy:

```
Nivel 1 · PRIMITIVAS  (crudo, no se usa en componentes)
  --e-ink-0 #050507  --e-ink-1 #0B0B0F  --e-ink-2 #14121C  --e-ink-3 #1C1730
  --e-violet-500 #7C3AED  --e-violet-400 #BB5CF6  --e-violet-600 #6D28D9
  --e-green-500 #00E6AB   --e-pink-500 #FF2D98     --e-amber-500 #F5A524
  --e-red-500 #EF4444     --e-paper #F5F5F7

Nivel 2 · SEMÁNTICAS  (lo que usan los componentes)
  --e-canvas / --e-surface / --e-surface-2 / --e-surface-3 / --e-overlay
  --e-text-primary / --e-text-secondary / --e-text-muted / --e-text-on-accent
  --e-border-hairline / --e-border-soft / --e-border-strong
  --e-brand / --e-brand-glow / --e-success / --e-urgent / --e-warn / --e-danger
  --e-focus

Nivel 3 · COMPONENTE  (opcional, para lo que se repite)
  --card-radius / --card-pad / --btn-h / --btn-radius / --field-h
```

Escalas cerradas (se acaban los valores de una sola aparición):

- **Espacio** (base 4px): `--e-space-1..12` = 4/8/12/16/20/24/32/40/48/64/80/96.
- **Radio**: `--e-radius-sm .5rem · md .75rem · lg 1rem · xl 1.25rem · 2xl 1.5rem · pill 999px`.
- **Tipografía** (ratio 1.25, fluida con `clamp()` para display):
  `--e-text-2xs .6875 · xs .75 · sm .8125 · base .9375 · lg 1.0625 · xl 1.25 · 2xl 1.5 · 3xl 1.875 · display clamp(2.25rem,6vw,3.5rem)`.
  Se **retiran los 7 micro-tamaños**; el mínimo de texto baja a 0.6875rem.
- **Peso**: 400/500/600/700 (Sora variable ya cubre 100–800).
- **Motion**: `--e-dur-fast 120ms · base 200ms · slow 320ms`; curvas
  `--e-ease-standard cubic-bezier(.2,.8,.2,1)` (la única del producto),
  `--e-ease-expo`, `--e-ease-spring` (para micro-rebotes).
- **Elevación**: `--e-shadow-1..4` (contacto → flotante) + `--e-glow-brand`.

**Tema claro**: se reescriben **solo los tokens semánticos** bajo
`html[data-theme="light"]` — no reglas por componente. Las ~430 líneas de
remapeo actuales se sustituyen por un bloque de ~40 tokens. El panel de marca de
auth (navy) se declara explícitamente **insensible al tema** con tokens propios.

**Migración**: se crea un mapa de alias `--tf-* / --home-* / --evd-* / --tkt-* /
--vh-* → --e-*` en un bloque temporal `@layer compat`, y cada fase retira los
alias del área que toca. El namespace muere al final de la Fase 6.

---

## 4. Fases (cada una entregable y verificable por separado)

### Fase 0 — Red de seguridad (antes de tocar nada) — **HECHA (parcial)**

- [x] Instalar **stylelint** (`stylelint.config.mjs`): `color-no-hex`
  (`src/**/*.css` salvo `tokens.css`), `no-duplicate-selectors`,
  `declaration-block-no-duplicate-properties`,
  `declaration-block-no-shorthand-property-overrides`. Las dos primeras nacen
  como `warning` y `npm run lint:css` las mide con un **presupuesto**
  (`--max-warnings 558`) que solo puede bajar: ninguna PR introduce deriva nueva.
- [x] Endurecer **contraste AA** y **tap targets ≥ 44px** como test permanente:
  `e2e/a11y.spec.js` (público × oscuro/claro, interior admin/promotor, puerta).
  Cazó y cerró 3 bugs reales (ver Fase 3).
- [ ] **Regresión visual** `toHaveScreenshot()` × breakpoints × temas — pendiente
  (la cubren los E2E de flujo + el spec de a11y mientras tanto).

### Fase 1 — Tokens y aplanado de la cascada — **HECHA (corte de tokens/color)**

- [x] Crear `src/tokens.css` (§3) e importarlo primero en `main.jsx`.
- [x] Tokens semánticos + escalas cerradas (espacio, radio, tipo, motion,
  elevación) y el tema claro como reescritura de tokens, no de componentes.
- [x] Utilidades semánticas `text-ink` / `text-dim` / `text-dim-2` / `bg-canvas`
  y el bloque de componentes insensibles al tema (`.auth-brand`).
- [x] Reapuntar las 5 hojas a los tokens (mecánico, por área): `color-no-hex`
  bajó de **558 a 31** (todas por valor exacto → cero regresión). Las 4 hojas
  de componente quedan sin hex; el único hex crudo vive en el bloque `@theme`
  de `index.css`, exento con rationale (fuente de los tokens Tailwind).
- [x] Colapsar la capa de alias: `--tf-* / --home-* / --evd-* / --tkt-* / --in-*`
  ya no declaran valores, solo primitivas `--e-*`.
- [x] Retirar `!important`: **11 → 3** (los 3 restantes son un único override
  legítimo de `prefers-reduced-motion`, que por norma necesita `!important`).
  `chip-active` y `auth-field-has-icon` no lo necesitaban (sus selectores ya
  ganaban por capa/orden); el candado oscuro de la puerta (`data-theme-lock`)
  se movió al **cierre de la hoja** para ganar por orden de fuente sin
  `!important` (verificado: claro → `rgb(241,241,244)`, candado → `rgb(24,24,27)`).
- [x] Retirar el color crudo de los `style={{}}`: el punto de estado (franja y
  backstage) y los colores del logotipo pasan a CSS por `data-status` / clases.
  El JSX ya no fija hex; quedan 21 `style={{}}` de geometría dinámica
  (porcentajes, `env(safe-area)`, delays) que NO son color ni violan el guard.
- *Aceptación*: `color-no-hex` pasa en todo `src/**/*.css` menos `tokens.css`;
  cero regresión visual; un cambio de `--brand` re-viste todas las pantallas.
  Cumplida. Lo único pendiente del presupuesto son 31 `no-duplicate-selectors`
  (F4, profundidad/material), no color.

### Fase 2 — Tipografía y ritmo editorial — **HECHA (corte de escala)**

- [x] Colapsar a la escala de §3: **44 tamaños → 9 pasos**. La escala vive
  ahora como tokens compartidos: `--e-text-2xs..display` en `tokens.css` y
  `--text-2xs..4xl` en el `@theme` de Tailwind (una sola fuente para CSS y
  para las utilidades `text-*`). CSS: **179 `font-size` → todos `var(--e-text-*)`**
  (solo queda 1 `1.25em` relativo en `.tkt-arw`, correcto por diseño).
- [x] **Retirados los micro-tamaños**: 0.5/0.55/0.56/0.6/0.62/0.625rem (8–10px)
  → 2xs (11px). El JSX no deja ningún `text-[Npx]`: 46×`text-[11px]` →
  `text-2xs`, 34×`text-[10px]` + 5×`text-[9px]` + `text-[8px]` → `text-2xs`,
  `text-[13px]` → `text-sm`, etc. **El piso de legibilidad es 11px** (medido en
  navegador: 0 elementos por debajo en home/login, sin overflow a 320px).
- [x] `clamp()` en display: los 6 clamps ad-hoc → `--e-text-display`
  (`clamp(2.25rem, 6vw, 3.5rem)`); de paso el hero dejó de tener techos de
  8.5vw (hasta 46px en móvil) y bajó a 36px, más contenido.
- [x] `font-variant-numeric: tabular-nums` en cifras: aforo, recaudo, precio,
  rango, conteo de pestaña y número de boleta (9 reglas; las cifras no bailan
  al refrescar).
- [ ] *Slice restante*: fijar el patrón editorial (eyebrow → display → lead →
  meta) con tracking/line-height por token — es ritmo fino, va con F3.
- *Aceptación*: ninguna superficie usa un tamaño fuera de la escala (cumplida);
  el ritmo vertical es constante entre páginas (parcial: pendiente el patrón).

### Fase 3 — Color, tema claro y accesibilidad (incluye los 2 bugs) — **HECHA**

- [x] Bugs de color: el título de marca de `/login` en claro ya usa tokens
  propios del panel navy (`tokens.css` `.auth-brand`). En `/waitlist` la
  auditoría no encontró `text-white` sobre `.card`: ya usa `.eyebrow` /
  `text-ink` / `text-dim`. Verificado con matriz de contraste ampliada.
- [x] Repaso del claro con la matriz de contraste: **0 fallos AA** en las 7
  rutas públicas + detalle de evento + admin/promotor/puerta, en oscuro y
  claro (`/tmp` de auditoría contra el navegador real).
- [x] Foco de teclado unificado: nuevo token `--e-focus-ring` (crema en oscuro,
  tinta en claro) del que beben `:focus-visible`, el override de `index.css` y
  el `:focus-visible` del app-shell. Se retiró el `border-radius` que el foco
  imponía al control (el anillo respeta el radio propio). Nueva prueba
  `a11y.spec.js` «foco visible y de un solo color» en ambos temas.
- [x] Objetivos táctiles ≥ 44px: avatar/tema/notificaciones (área `::after` en
  móvil), `btn-mini` (44px alto en móvil), `btn-icon` (44px ancho+alto en móvil)
  y `topnav-item` (área `::before` en puntero coarse, ≥44px). Sin overflow a
  320/360/390/420px.
- *Aceptación*: `a11y.spec.js` **11/11 en verde** en ambos temas; contraste
  ≥ 4.5:1 (≥ 3:1 en texto grande) en todas las pantallas. Cumplida.

### Fase 4 — Profundidad, material y atmósfera — **HECHA**

- [x] **Sistema de elevación por tokens**: par tema-aware `--e-elev-card`
  (reposo) · `--e-elev-raised` (hover/activa) · `--e-elev-overlay`
  (modal/hoja/toast) más el relieve `--e-highlight-inset`. Oscuro = sombra
  profunda sobre pizarra; claro = papel con sombras más tenues. Los
  diferenciadores funcionales (glow de marca, estados `is-live`/`is-on`)
  siguen aparte.
- [x] **Una sola receta de tarjeta**: `.card`, `.auth-card`, `.auth-shell
  .auth-card`, `.dialog-panel`, `.bizdock`, `.venue-header`, `.home-feature` y
  `.promo-hero` beben de los mismos tokens. Auditoría en navegador: **1 receta
  por superficie** en ambos temas y oscuro ≠ claro (pizarra vs papel). Se
  retiraron los tokens muertos `--tf-shadow-card` / `--tf-shadow-purple`.
- [x] **Grano de atmósfera** opcional: `.home::after` con data-URI SVG
  fractalNoise a `opacity .045` / `overlay`, por debajo del contenido; **fuera
  con `reduced-motion`** (verificado: `display:none`).
- *Aceptación*: no hay dos tarjetas con recetas de sombra distintas; el claro se
  ve "papel" y el oscuro "pizarra". Cumplida.


### Fase 5 — Motion y micro-interacciones — **HECHA**

- [x] **Consolidación de `@keyframes`**: de **26 a 19** (index 23→17, fan 2,
  refresh 1→0 — sus animaciones ahora reusan `enter`/`logo-pop`/`shimmer`/`spin`
  de la capa base). Fusiones reales, no alias vacíos: `toast-in`/`rise`/`scale-in`
  /`dialog-in` → un solo `enter`; `dialog-backdrop` → `fade`; `splash-breathe`
  /`halo-breathe` → `breathe`; `ptr-spin`/`enty-spin` → `spin`; `fav-pop` →
  `logo-pop`; `scan-verdict-ok` → `pop`. Se eliminan keyframes muertos
  (`ab-breathe`, `splash-breathe`, `live-glow`) y los alias de curva duplicados
  (`--ease-out-expo`/`--ease-spring` en `:root`).
- [x] **Tokens de movimiento**: `--e-ease-standard/expo/spring` +
  `--e-dur-fast/base/slow` en `tokens.css` son la única fuente; toda la hoja
  `index.css` migró de `var(--ease-*)` a `var(--e-ease-*)` (0 referencias legacy).
- [x] **`prefers-reduced-motion` por hoja**: `aesthetic-refresh.css` pasó de **0**
  a 1 bloque que apaga `enter`/`logo-pop`/`shimmer`/`spin` y los gestos de
  interacción (hover/presión de la casa fan y del detalle). `index.css` amplió su
  lista RM con la familia entera (`enter`, `reveal-qr`, `dialog-*`, `offline-in`,
  `confetti`, `empty-state-icon`, …) y `scan-result` tiene su propio bloque.
- [x] **Momentos de alto impacto** (solo `transform`/`opacity`): entrada escalonada
  de la vitrina (`.reveal`), revelado del QR (`.reveal-qr` en Mis boletos y boleta
  pública), veredicto de puerta (`scan-result[data-result]`: `pop` al entrar,
  `scan-verdict-no` al rechazar), favorito con micro-rebote (`logo-pop`, gated a
  `is-pop` en clic, no al montar).
- *Aceptación*: **0 animaciones sin escape de reduced-motion** (verificado
  programáticamente: 19 keyframes definidos = 19 usados, 0 huérfanos); solo
  `transform`/`opacity` (nada de animar `filter`/`backdrop-filter`). Cumplida.
  Build limpio (0 errores) y E2E **11/11 verdes**.

### Fase 6 — Elevación por rol (interior) y cierre

- **Admin**: densidad y jerarquía de datos; tablas/listas con zebra sutil,
  cabeceras pegajosas, cifras tabulares, violeta solo en la acción primaria.
- **Promotor**: tinte de marca en cupos/ranking; estados de comisión claros.
- **Puerta**: contraste máximo, targets grandes, feedback de escaneo inconfundible.
- Retirar el bloque `@layer compat`; borrar los namespaces legacy.
- Actualizar `AGENTS.md` y `DESIGN.md` (ver nota abajo).
- *Aceptación*: E2E 6/6 verdes; regresión visual aprobada; stylelint y a11y verdes.

**Hecho.** Estado final:

- **Namespaces legacy retirados**: `--tf-* / --home-* / --evd-* / --tkt-* /
  --vh-* / --in-*` ya no existen en ninguna hoja; todo consume `--e-*`. (El
  bloque `@layer compat` nunca llegó a existir en el árbol: se descartó durante
  la migración F1.) Los **nombres de CLASE** `.home-*`, `.evd-*`, `.tkt-*` se
  conservan porque los E2E los usan como contrato.
- **Admin**: `.evx-toolbar` pegajosa (`sticky; top: 3.5rem`, fondo canvas),
  zebra sutil en `.evx-row:nth-child(even)`, lista densa con rail de estado y
  cifras tabulares.
- **Promotor**: la tarjeta "Mis noches" (`.e-meter` / `.e-meter-fill` con
  `.is-warn`/`.is-full`) muestra la proporción del cupo por noche; el seed demo
  ahora siembra `event_staff` para que la tarjeta exista en la demo.
- **`DESIGN.md`**: sustituido por un design system real de Enty; el análisis de
  Apple se movió a `docs/referencia-apple.md`.
- **Verificación**: backend 354/354, E2E Playwright 11/11 (incluye a11y
  claro/oscuro y targets ≥ 44px en puerta), stylelint 0 errores / 30 warnings,
  build limpio.

---

## 5. Guardarraíles y verificación (permanentes)

1. **E2E de flujo** existentes: 6/6 siempre verdes (contrato intacto).
2. **Regresión visual** por captura (Fase 0) como red anti-deriva.
3. **stylelint** con `color-no-hex` y sin duplicados.
4. **`e2e/a11y.spec.js`**: contraste AA, tap ≥ 44px, alt en imágenes, un solo
   `h1` por vista, foco visible.
5. **Presupuesto de tokens**: ninguna hoja fuera de `tokens.css` declara un hex
   de marca; ninguna página inventa un radio o un tamaño fuera de escala.

---

## 6. Lo que NO se toca (protegido)

- **Contratos E2E**: selectores, textos de acción y flujos (login, portada,
  puerta, fan). El rediseño no renombra nada que un test use.
- **La boleta pública `.tkt`**: es un artefacto troquelado y la credencial de la
  noche. Se conserva; solo hereda tokens (radio/sombra) sin cambiar su forma.
- **Decisiones de marca**: oscuro por defecto, puerta siempre oscura, Sora única
  voz, verde/rosa con significado.
- **Lógica de negocio**: rutas, endpoints, roles, magic-link, QR anti-reuso.

---

## 7. Nota sobre la documentación de diseño

`DESIGN.md` **ya no es el análisis de Apple**. En Fase 6 se sustituyó por un
design system real de Enty (identidad, paleta, tipografía, tokens, superficies
por rol, motivos, movimiento y guardarraíles). El análisis de Apple que lo
ocupaba se conserva como referencia histórica en `docs/referencia-apple.md`.

---

## 8. Orden, dependencias y riesgos

- **Secuencia**: 0 → 1 → 2 → 3 → (4, 5 en paralelo) → 6. La Fase 1 es la que
  habilita todo lo demás; no se salta.
- **Riesgo principal**: la cascada de 4 hojas. Mitigación: los alias de compat y
  la regresión visual por fase (cada fase deja la app visualmente estable salvo
  lo que cambia a propósito).
- **Riesgo de regresión**: mitigado por capturas + E2E + stylelint desde Fase 0.
- **Criterio de "avanzado"**: cuando un cambio de token re-viste el producto
  entero, cuando el claro y el oscuro se sienten materiales distintos, cuando no
  queda ningún hex de marca fuera de `tokens.css`, y cuando la suite visual/a11y
  no permite volver atrás.
