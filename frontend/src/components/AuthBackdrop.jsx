/**
 * Escenografía de la entrada (login/registro) — v3 Tesla/Apple: showroom
 * plano. La pantalla es el producto: canvas único, cero gradientes
 * decorativos, cero sombras de UI. La única "fotografía" es una luz muy
 * sutil desde arriba, como la lámpara de un showroom. Con
 * prefers-reduced-motion no hay nada que apagar: nada se mueve.
 *
 * Capas: una sola (la luz del showroom). La calma ES el lujo.
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
    </div>
  );
}
