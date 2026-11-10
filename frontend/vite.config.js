import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Dominio público de la app. Vive en UNA variable para que pasar a dominio
// propio (o cambiar de proyecto Vercel) no obligue a cazar URLs por el HTML.
// El default es el dominio de producción real; Vercel deja sobreescribirlo con
// VITE_SITE_URL sin tocar el código.
const SITE_URL = (
  process.env.VITE_SITE_URL || "https://ticketflow-brva4026-uxs-projects.vercel.app"
).replace(/\/+$/, "");

/** Sustituye `%SITE_URL%` en el HTML por el dominio real (canonical, og:*,
 *  twitter:*, JSON-LD). Sin esto, compartir un link muestra la URL de la rama
 *  de preview en vez del sitio de producción. */
function siteUrlPlugin() {
  return {
    name: "enty-site-url",
    transformIndexHtml(html) {
      return html.replaceAll("%SITE_URL%", SITE_URL);
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), siteUrlPlugin()],
  // Config PostCSS inline (vacía): evita que Vite busque configs hacia
  // directorios padres (p.ej. postcss.config.js inválidos en el HOME).
  // Tailwind v4 se aplica via plugin @tailwindcss/vite, no necesita postcssrc.
  css: {
    postcss: {},
  },
  build: {
    rollupOptions: {
      output: {
        // manualChunks: el escáner (html5-qrcode, ~230KB) y el generador de QR
        // (qrcode) NO van en el chunk vendor del camino crítico. Son pesados y
        // solo los usan BouncerScanner y TicketQrModal/PromoterDashboard: los
        // imports dinámicos ya los separan por ruta, pero sin este map el
        // renderer de Vite los fusiona en el chunk común "esm" y el login
        // termina descargando la librería de QR sin necesitarla.
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (id.includes("html5-qrcode")) return "scanner";
            if (id.includes("qrcode")) return "qr";
          }
          return undefined;
        },
      },
    },
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