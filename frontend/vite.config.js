import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Config PostCSS inline (vacía): evita que Vite busque configs hacia
  // directorios padres (p.ej. postcss.config.js inválidos en el HOME).
  // Tailwind v4 se aplica via plugin @tailwindcss/vite, no necesita postcssrc.
  css: {
    postcss: {},
  },
  server: {
    host: "0.0.0.0",
    port: 12000,
    // Mismo caso que en `preview`: el runtime sirve la app por subdominio
    // propio y Vite bloquea hosts desconocidos por defecto.
    allowedHosts: [
      "localhost",
      ".prod-runtime.all-hands.dev",
      ".all-hands.dev",
    ],
    proxy: {
      // En dev/proxy, las llamadas a /api van al backend
      "/api": {
        target: process.env.VITE_BACKEND_URL || "http://localhost:8000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
  preview: {
    host: "0.0.0.0",
    port: 12000,
    // El host público de este runtime usa subdominio propio; Vite bloquea
    // por defecto hosts desconocidos (protección DNS rebinding).
    allowedHosts: [
      "localhost",
      ".prod-runtime.all-hands.dev",
      ".all-hands.dev",
    ],
    proxy: {
      "/api": {
        target: process.env.VITE_BACKEND_URL || "http://localhost:8000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});