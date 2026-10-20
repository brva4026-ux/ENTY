import { AuthBackdrop } from "./AuthBackdrop";
import { Logo } from "./Brand";
import { LegalLinks } from "./LegalLinks";

/**
 * Escenografía de la entrada (login/registro) en dos paneles.
 *
 * Izquierda: el panel de MARCA (negro mate de la boleta) con el logo grande, el
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

export function AuthShell({ children }) {
  return (
    <div className="auth-shell bg-zinc-950 min-h-screen">
      {/* Misma atmósfera de showroom que el resto de la entrada. En desktop
          queda tapada por el panel de marca; en móvil es todo el fondo. */}
      <AuthBackdrop />

      {/* ----------------------------------------------------------------
          PANEL DE MARCA (solo desktop). El negro mate es la superficie de la
          boleta; el troquel y la E son el agua de marca de fondo.
          ---------------------------------------------------------------- */}
      <aside className="auth-brand">
        <div className="auth-brand-glow" aria-hidden="true" />

        {/* El troquel: la linea de perforado del talon, la firma de la casa.
            Sustituye a los rayos del logotipo anterior. */}
        <svg className="auth-brand-rays" viewBox="0 0 512 512" aria-hidden="true">
          <g fill="var(--e-brand-400)" opacity="0.06">
            {Array.from({ length: 24 }, (_, i) => (
              <circle key={i} cx="256" cy={10 + i * 21} r="7" />
            ))}
          </g>
        </svg>

        {/* La "E" troquelada, el isotipo, como marca de agua de esquina.
            Antes vivia aqui la estrella de cuatro puntas (el icono generico
            de "producto con IA"), que la identidad Enty retira. */}
        <svg className="auth-brand-mark" viewBox="0 0 512 512" aria-hidden="true">
          <g
            stroke="var(--e-brand-400)"
            strokeWidth="54"
            strokeLinecap="round"
            fill="none"
          >
            <path d="M186 96 V416" />
            <path d="M186 110 H336" />
            <path d="M186 256 H304" />
            <path d="M186 402 H336" />
          </g>
          <circle cx="336" cy="110" r="17" fill="var(--e-brand-400)" />
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
