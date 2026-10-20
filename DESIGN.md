# DESIGN.md — Enty

Sistema de diseño de Enty: boletería y control de aforo para bares, venues y
recintos de conciertos/festivales/deportes/teatro. Este documento describe la
**capa visual** del producto. La fuente de verdad ejecutable es
`frontend/src/tokens.css`; aquí se explica el porqué y las reglas que ninguna
hoja puede romper.

> Documento anterior: el análisis de Apple que vivía en este archivo se movió a
> `docs/referencia-apple.md` como referencia histórica (Fase 6 del plan
> estético). Apple no es la estética de Enty.

---

## 1. Identidad de marca

| Atributo | Valor |
|---|---|
| Nombre | Enty |
| Sector | Conciertos · Festivales · Deportes · Teatro |
| Vibe | Nocturno · futurista · tech · vibrante |
| Producto | Gestión de cortesías y verificación de boletas (NO venta de boletas) |
| Roles | Admin (crea evento y asigna cupos) · Promotor/vendedor (emite cortesías) · Portero (verifica en puerta) |

### Paleta

La paleta vive **solo** en `frontend/src/tokens.css` (primitivas `--e-*`). El
stylelint `color-no-hex` prohíbe cualquier hex en el resto de hojas.

| Rol | Token | Hex | Uso |
|---|---|---|---|
| Negro mate | `--e-ink-1` | `#0B0B0F` | Lienzo de la marca (tema oscuro por defecto) |
| Violeta eléctrico | `--e-violet-500` | `#7C3AED` | La única acción primaria |
| Verde eléctrico | `--e-green-500` | `#00E6AB` | Validado / disponible / en vivo |
| Rosa eléctrico | `--e-pink-500` | `#FF2D98` | Urgencia / últimas / rechazo crítico |
| Tinta | `--e-paper` / `#F5F5F7` | | Texto principal sobre negro |

Reglas de color:

- **Un solo acento interactivo**: el violeta `#7C3AED` (`--e-brand`). Todo
  botón/estado primario lo usa; nada más.
- **El verde y el rosa significan, no decoran**. Verde = validado/disponible/en
  vivo; rosa = urgencia/últimas. Nunca son color de interfaz ni de marca.
- **Un violeta más brillante** (`--e-violet-400` `#BB5CF6`) es solo
  halo/glow, nunca relleno interactivo.
- Oscuro por defecto; la **puerta es siempre oscura** (el flash blanco en un
  recinto a oscuras ciega al portero), aunque el tema del dispositivo sea claro.

---

## 2. Tipografía

**Sora es la única voz del sistema** (variable, auto-hospedada, `--font-sans`).
No hay segunda tipografía, ni display alternativo.

Escala cerrada (ratio 1.25, `tokens.css`). 7 micro-tamaños fueron retirados; el
piso de legibilidad es `--e-text-2xs` (`0.6875rem` / 11px).

| Token | rem | Rol |
|---|---|---|
| `--e-text-2xs` | 0.6875 | Micro-etiqueta, piso absoluto |
| `--e-text-xs` | 0.75 | Etiqueta, contador |
| `--e-text-sm` | 0.8125 | Texto denso de UI |
| `--e-text-base` | 0.9375 | Cuerpo |
| `--e-text-lg` | 1.0625 | Cuerpo destacado |
| `--e-text-xl` | 1.25 | Subtítulo |
| `--e-text-2xl` | 1.5 | Título de sección |
| `--e-text-3xl` | 1.875 | Título de pantalla |
| `--e-text-display` | `clamp(2.25rem, 6vw, 3.5rem)` | Wordmark / hero |

Cifras **siempre tabulares** en datos de negocio: `.tnum` o
`font-variant-numeric: tabular-nums` (recaudo, vendidas, cupos, contadores).

---

## 3. Tokens

`tokens.css` tiene tres niveles:

1. **Primitivas** `--e-<familia>-<paso>`: el valor crudo (`--e-ink-1`,
   `--e-violet-500`). No se consumen en componentes.
2. **Semánticas** `--e-<rol>`: lo que usan las hojas (`--e-canvas`,
   `--e-surface`, `--e-text-primary`, `--e-border-hairline`, `--e-brand`,
   `--e-success`, `--e-urgent`). **Voltean con el tema**.
3. **Escalas**: espacio, radio, texto, movimiento y elevación.

### Escalas

- **Espacio** (base 4px): `--e-space-1` … `--e-space-24`.
- **Radio**: `--e-radius-sm` 0.5rem · `md` 0.75 · `lg` 1 · `xl` 1.25 · `2xl` 1.5 ·
  `pill` 999px. Ninguna página inventa un radio.
- **Movimiento**: `--e-dur-fast` 120ms · `base` 200ms · `slow` 320ms; curvas
  `--e-ease-standard`, `--e-ease-expo` (desembarco, la dominante),
  `--e-ease-spring` (solo micro-celebraciones).

### Elevación y material

- `--e-shadow-1..4` + `--e-elev-card` / `--e-elev-raised` / `--e-elev-overlay`.
  La elevación es un par tema-aware: **mismo hueco visual, distinta materia**
  (oscuro = sombra; claro = papel).
- `--e-highlight-inset`: el filo de 1px que hace la superficie "pizarra".
- `--e-glow-brand`, `--e-glow-violet/green/pink`: halos de marca.
- `--e-glass-1/2`, `--e-glass-line`, `--e-glass-blur`: material de cristal de la
  casa fan (vitrina, detalle, boleta).
- `--e-ticket-*`: material de la **boleta pública**, siempre oscuro (no voltea).

### Temas

- Oscuro por defecto (`:root`).
- Claro en `html[data-theme="light"]` (bloque al final de `tokens.css`).
- Fijo oscuro en `[data-theme-lock="dark"]` (puerta/escáner).

---

## 4. Superficies y jerarquía por rol

Cada rol es un "volumen" distinto del mismo lenguaje.

### Admin (densidad y jerarquía de datos)

- Lista compacta (`evx-*`): filas densas con **zebra sutil**, cabecera
  **pegajosa**, **cifras tabulares** y **violeta solo en la acción primaria**.
- El ciclo de vida de cada noche se lee como un rail de estado (verde vivo = en
  puerta), no como una tabla fría.
- Las acciones de fila son **control, no decoración**: siempre visibles (el
  hover no existe en táctil).

### Promotor (cupos y comisión)

- **Tinte de marca** en el hero y en los cupos; el medidor (`e-meter`) muestra
  la proporción de la noche con el violeta de marca.
- Estados de comisión/pago **explícitos** (pendiente / disputada / pagada /
  rechazada) con su color semántico, nunca solo un número.

### Puerta (contraste máximo)

- **Siempre oscura**, contraste máximo, targets ≥ 44px.
- Feedback de escaneo **inconfundible**: pantalla completa, `role="status"`
  `aria-live="assertive"`, `data-result="ok|no"`, verde/rosa sin ambigüedad.

---

## 5. Píldoras semánticas y motivos

- `.e-pill--ok` = verde (validado). `.e-pill--hot` = rosa (urgencia).
  `.e-pill--brand` = violeta tenue (estado de marca).
- `.e-meter` / `.e-meter-fill` (+ `.is-warn`, `.is-full`): medidor de cupo.
- El **troquel** (`.enty-perf`) es el corte perforado de la boletería: separa
  bloques como el corte de una entrada.
- La **boleta** (`.tkt`) es un artefacto troquelado; conserva su forma y solo
  hereda tokens (radio/sombra).

---

## 6. Movimiento

- El movimiento dominante es `transform`/`opacity`; **nunca** se anima
  `filter`/`backdrop-filter`.
- 19 keyframes, todos usados; 0 huérfanos.
- **Todo movimiento respeta `prefers-reduced-motion`** (único uso legítimo de
  `!important` en el repo).

---

## 7. Reglas duras (guardarraíles)

1. Ningún hex de marca fuera de `tokens.css` (stylelint `color-no-hex`).
2. Ninguna página inventa un radio o tamaño fuera de escala.
3. Un solo acento interactivo (violeta).
4. Sin `@layer compat`, sin namespaces legacy (`--tf-*`, `--home-*`, `--evd-*`,
   `--tkt-*`, `--vh-*`): retirados en Fase 6.
5. Contraste AA, tap ≥ 44px, alt en imágenes, un solo `h1` por vista, foco
   visible de un solo color — verificados por `e2e/a11y.spec.js`.
6. Los **contratos E2E** (selectores, textos de acción, flujos) no se renombran.
