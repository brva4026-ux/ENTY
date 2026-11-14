// Lint del frontend. El gate es de ERRORES (mas un presupuesto de warnings,
// ver `lint:js` en package.json): las reglas que hoy no pasan en limpio se
// dejan como WARNING con su conteo actual, y ese techo solo puede BAJAR (misma
// regla que `lint:css`). No se sube para "pasar".
//
// `react-hooks/rules-of-hooks` es error: una llamada condicional a un hook es
// un bug real, no un matiz. Las reglas del React Compiler que trae
// eslint-plugin-react-hooks 7.x (set-state-in-effect, immutability, purity,
// refs) NO se activan aca: marcan cientos de sitios que funcionan y hoy no
// aportan senal accionable.
import js from "@eslint/js";
import globals from "globals";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  {
    ignores: ["dist", "node_modules", "test-results", "playwright-report", "public"],
  },
  js.configs.recommended,
  {
    files: ["src/**/*.{js,jsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { react, "react-hooks": reactHooks },
    settings: { react: { version: "detect" } },
    rules: {
      // Sin esto, los componentes usados solo en JSX se ven como no usados.
      "react/jsx-uses-vars": "error",
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
];
