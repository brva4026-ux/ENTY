/**
 * Escenografía de la entrada (login/registro).
 *
 * La entrada es la vitrina del producto: aquí el fondo sí tiene capas, a
 * diferencia del resto de la app donde la aurora es un lavado sutil.
 * Capas, de atrás hacia adelante:
 *   1. aurora  — gradientes radiales violeta/fucsia/cian que respiran lento
 *   2. orbes   — tres manchas de luz flotando en direcciones opuestas
 *   3. rejilla — puntos que enmarcan el centro (donde vive la tarjeta)
 *   4. grano   — textura SVG que mata el look "plano de plantilla"
 *   5. foco    — luz detrás de la tarjeta, pulsando muy sutil
 *
 * Todo es decorativo: aria-hidden, pointer-events-none y animaciones solo
 * de transform/opacity (compositables). Con prefers-reduced-motion queda
 * un fondo estático bonito, sin movimiento.
 */

export function MailIcon({ className = "" }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="3" y="5.5" width="18" height="13" rx="2.5" />
      <path d="m4 7.5 8 6 8-6" />
    </svg>
  );
}

export function LockIcon({ className = "" }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="4.5" y="10.5" width="15" height="9.5" rx="2.5" />
      <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
      <circle cx="12" cy="15.2" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function AuthBackdrop() {
  return (
    <div className="auth-backdrop" aria-hidden="true">
      <div className="ab-aurora" />
      <div className="ab-orb ab-orb-1" />
      <div className="ab-orb ab-orb-2" />
      <div className="ab-orb ab-orb-3" />
      <div className="ab-grid" />
      <div className="ab-spot" />
      <div className="ab-grain" />
    </div>
  );
}
