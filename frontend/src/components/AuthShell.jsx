import { AuthBackdrop } from "./AuthBackdrop";
import { LoginAurora } from "./LoginAurora";
import { LoginVideo } from "./LoginVideo";
import { Logo } from "./Brand";
import { LegalLinks } from "./LegalLinks";

/**
 * Escenografía de la entrada (login/registro) en dos paneles.
 *
 * Izquierda: el panel de MARCA (navy de la boleta) con el logo grande, el
 * lema y tres beneficios concretos. Derecha: el formulario sobre el lienzo.
 * Entre ambos corre un TROQUEL real — la línea perforada de la boleta — con
 * dos muescas comidas por una máscara (no por un parche del color del fondo),
 * así funciona igual en tema claro y oscuro.
 *
 * El panel de marca es decoración de contexto + copy de producto: en móvil
 * se oculta y queda una cabecera compacta (logo + lema) sobre el formulario.
 */

/** Beneficio del panel de marca: check en chip + texto. */
function Benefit({ children }) {
  return (
    <li className="auth-benefit">
      <span className="auth-benefit-check" aria-hidden="true">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m5 12.5 4.5 4.5L19 7" />
        </svg>
      </span>
      <span>{children}</span>
    </li>
  );
}

export function AuthShell({ children, minimal = false }) {
  // Variante mínima: solo la tarjeta del formulario, centrada, sobre el fondo
  // en movimiento. Sin panel de marca, sin cabecera compacta, sin pie legal.
  // La usa /login, donde un visitante solo viene a entrar.
  if (minimal) {
    return (
      <div className="auth-shell auth-shell--minimal">
        {/* El video va encima del fondo CSS; si no carga o el usuario pide
            menos movimiento, el CSS (LoginAurora) queda de respaldo. */}
        <LoginAurora />
        <LoginVideo />
        <main className="auth-panel">
          <div className="auth-panel-inner">{children}</div>
        </main>
      </div>
    );
  }

  return (
    <div className="auth-shell">
      {/* Misma atmósfera de showroom que el resto de la entrada. En desktop
          queda tapada por el panel de marca; en móvil es todo el fondo. */}
      <AuthBackdrop />

      {/* ----------------------------------------------------------------
          PANEL DE MARCA (solo desktop). El navy es la superficie de la
          boleta; los rayos y la criatura son el agua de marca de fondo.
          ---------------------------------------------------------------- */}
      <aside className="auth-brand">
        <div className="auth-brand-glow" aria-hidden="true" />

        {/* Rayos del logo, a la misma opacidad que el isotipo: textura que
            se siente, no que se ve. Reemplazan a los doodles sueltos. */}
        <svg className="auth-brand-rays" viewBox="0 0 512 512" aria-hidden="true">
          <g fill="#BB5CF6" opacity="0.06">
            <path d="M256 256 96 24h92zM256 256 268 0h64zM256 256 480 128v84zM256 256 416 488h-92zM256 256 44 384v-84z" />
          </g>
        </svg>

        {/* La estrella de cuatro puntas, como marca de agua de esquina. */}
        <svg className="auth-brand-mark" viewBox="0 0 512 512" aria-hidden="true">
          <path
            fill="#BB5CF6"
            d="M256 40 l58 158 158 58 -158 58 -58 158 -58 -158 -158 -58 158 -58 z"
          />
        </svg>

        <div className="auth-brand-top">
          <Logo size="xl" />
        </div>

        <div className="auth-brand-copy">
          <p className="eyebrow">Boletería y control de puerta</p>
          <h2 className="auth-brand-title display">
            La lista de la puerta, resuelta.
          </h2>
          <p className="auth-brand-sub">
            Emite boletas, vende en taquilla y controla el acceso desde un solo
            panel, con todo actualizándose en vivo.
          </p>

          <ul className="auth-benefits">
            <Benefit>Boletas con QR listas en segundos</Benefit>
            <Benefit>Control en puerta escaneando, sin listas en papel</Benefit>
            <Benefit>Ventas, cupos y aforo en vivo</Benefit>
          </ul>
        </div>

        {/* El troquel: las dos muescas las come la máscara; aquí solo va la
            línea perforada. */}
        <span className="auth-perf" aria-hidden="true" />
      </aside>

      {/* ----------------------------------------------------------------
          COLUMNA DEL FORMULARIO
          ---------------------------------------------------------------- */}
      <main className="auth-panel">
        <div className="auth-panel-inner">
          {/* Cabecera compacta: reemplaza al panel de marca en móvil. */}
          <div className="auth-compact">
            <Logo size="hero" />
            <p className="hand auth-compact-lema">
              la lista de la puerta, resuelta
            </p>
          </div>

          {children}

          {/* Pie legal: aceptar unos términos exige poder leerlos ANTES de
              marcarlos, y el login también los enlaza (quien ya tiene cuenta
              puede necesitar consultarlos o pedir sus datos). */}
          <div className="legal-muted mt-8 border-t border-zinc-800/60 pt-4">
            <LegalLinks />
          </div>
        </div>
      </main>
    </div>
  );
}
