/**
 * Guardarraíl de CSS del design system Enty (Fase 0 del plan estético).
 *
 * Objetivo: que la estética no se degrade en silencio. No es un formateador
 * (no hay prettier-style), es un conjunto de reglas de CORRECCIÓN + las
 * reglas de sistema de diseño:
 *
 *   - color-no-hex: el color de marca vive SOLO en tokens.css. El resto de
 *     hojas consume var(--e-*). Arranca como `warning` durante la migración
 *     (Fase 1) y pasa a `error` cuando la cascada queda plana.
 *   - no-duplicate-selectors / declaration-block-no-duplicate-properties:
 *     evitan la pugna de especificidad que hoy obliga a los 11 !important.
 *   - declaration-block-no-shorthand-property-overrides: un shorthand no
 *     puede pisar una longhand ya declarada en el mismo bloque.
 *
 * Se extiende stylelint-config-standard pero se desactivan las reglas
 * puramente estilísticas (orden de propiedades, notaciones, formato) para no
 * ahogar la señal en el legado; se reactivarán si se adopta un formateador.
 */
export default {
  extends: ["stylelint-config-standard"],
  rules: {
    // --- Sistema de diseño (nuestro foco) ---
    // Durante la migración (Fase 0→1) estas dos viven como `warning`: la
    // cascada todavía tiene legado. El script `lint:css` usa un PRESUPUESTO
    // (--max-warnings) que solo puede bajar: así ninguna PR introduce deriva
    // nueva, y cada fase baja el número.
    "color-no-hex": [true, { severity: "warning" }],
    "no-duplicate-selectors": [true, { severity: "warning" }],
    "declaration-block-no-duplicate-properties": [
      true,
      { ignore: ["consecutive-duplicates-with-different-syntaxes"] },
    ],
    "declaration-block-no-shorthand-property-overrides": true,
    "color-no-invalid-hex": true,
    "block-no-empty": true,

    // --- Ruido de formato del legado (se apaga hasta que haya formateador) ---
    "alpha-value-notation": null,
    "color-function-notation": null,
    "color-function-alias-notation": null,
    "color-hex-length": null,
    "hue-degree-notation": null,
    "lightness-notation": null,
    "number-max-precision": null,
    "value-keyword-case": null,
    "font-family-name-quotes": null,
    "font-family-no-missing-generic-family-keyword": null,
    "function-name-case": null,
    "function-url-quotes": null,
    "length-zero-no-unit": null,
    "shorthand-property-no-redundant-values": null,
    "declaration-block-no-redundant-longhand-properties": null,
    "no-descending-specificity": null,
    "no-duplicate-at-import-rules": null,
    "custom-property-empty-line-before": null,
    "comment-empty-line-before": null,
    "rule-empty-line-before": null,
    "declaration-empty-line-before": null,
    "at-rule-empty-line-before": null,
    "selector-attribute-quotes": null,
    "media-feature-range-notation": null,
    "property-no-vendor-prefix": null,
    "value-no-vendor-prefix": null,
    "keyframes-name-pattern": null,
    "selector-class-pattern": null,
    "selector-id-pattern": null,
    "custom-property-pattern": null,
    "at-rule-no-unknown": [true, { ignoreAtRules: ["theme", "layer", "apply"] }],
    "import-notation": null,
    "no-invalid-position-at-import-rule": null,
  },
  overrides: [
    {
      // tokens.css ES la fuente de color: aquí el hex no solo se permite, es
      // la razón de ser del archivo.
      files: ["src/tokens.css"],
      rules: { "color-no-hex": null },
    },
  ],
};
