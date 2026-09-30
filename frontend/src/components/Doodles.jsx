/**
 * Doodles POP: garabatos estilo "portfolio de animador" (referencia
 * Dikshant/Absolut). Solo adornan: nunca portan datos ni acciones.
 * Colores de fiesta usados con cuentagotas sobre los carteles de referencia:
 * magenta #ef6c8a, lima #f0f542, verde #34d399, celeste #7dd3fc.
 */

const TINTA = "currentColor";

/** Estrella de 4 puntas (destello de cartel). */
export function Star4({ className = "", style }) {
  return (
    <svg viewBox="0 0 24 24" className={`doodle ${className}`} style={style} aria-hidden="true">
      <path
        d="M12 2c.6 4.8 2.2 7.4 8 10-5.8 2.6-7.4 5.2-8 10-.6-4.8-2.2-7.4-8-10 5.8-2.6 7.4-5.2 8-10Z"
        fill={TINTA}
      />
    </svg>
  );
}

/** Estrella clasica de 5 puntas (la del hombro de Dikshant). */
export function Star5({ className = "", style }) {
  return (
    <svg viewBox="0 0 24 24" className={`doodle ${className}`} style={style} aria-hidden="true">
      <path
        d="M12 2.5 14.7 9l7 .5-5.4 4.5 1.7 6.8L12 17l-6 3.8L7.7 14 2.3 9.5l7-.5L12 2.5Z"
        fill={TINTA}
      />
    </svg>
  );
}

/** Rayo (energia de fiesta). */
export function Bolt({ className = "", style }) {
  return (
    <svg viewBox="0 0 24 24" className={`doodle ${className}`} style={style} aria-hidden="true">
      <path d="M13.5 2 5 13.5h5L9.5 22 19 9.8h-5.6L13.5 2Z" fill={TINTA} />
    </svg>
  );
}

/** Corona (la del "PORT FOLio" del scrapbook). */
export function Crown({ className = "", style }) {
  return (
    <svg viewBox="0 0 24 24" className={`doodle ${className}`} style={style} aria-hidden="true">
      <path
        d="M3 8.5 7.5 12 12 5l4.5 7L21 8.5 19.2 17H4.8L3 8.5Z"
        fill="none"
        stroke={TINTA}
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Espiral garabateada (el gesto "creativo" del hero neon). */
export function Spiral({ className = "", style }) {
  return (
    <svg viewBox="0 0 48 24" className={`doodle ${className}`} style={style} aria-hidden="true">
      <path
        d="M2 12c4-7 10-7 12-2s-2 10-6 8-2-9 3-11 12-3 16 1 5 10 12 10"
        fill="none"
        stroke={TINTA}
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Nota musical (la noche es musica). */
export function MusicNote({ className = "", style }) {
  return (
    <svg viewBox="0 0 24 24" className={`doodle ${className}`} style={style} aria-hidden="true">
      <path
        d="M9 18.5V5.8L20 3v12.2"
        fill="none"
        stroke={TINTA}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="6.6" cy="18.6" r="2.6" fill={TINTA} />
      <circle cx="17.6" cy="15.4" r="2.6" fill={TINTA} />
    </svg>
  );
}

/** Flecha curva dibujada a mano (señala el CTA, como "Hey!" del hero). */
export function ArrowScribble({ className = "", style }) {
  return (
    <svg viewBox="0 0 40 32" className={`doodle ${className}`} style={style} aria-hidden="true">
      <path
        d="M4 4c2 10 10 18 26 20m0 0-6-7m6 7-8 3"
        fill="none"
        stroke={TINTA}
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Estrella para el divisor de lazo (ribbon-divider). */
export function DividerStar({ className = "" }) {
  return (
    <svg viewBox="0 0 24 24" className={`rd-star ${className}`} aria-hidden="true">
      <path
        d="M12 2c.6 4.8 2.2 7.4 8 10-5.8 2.6-7.4 5.2-8 10-.6-4.8-2.2-7.4-8-10 5.8-2.6 7.4-5.2 8-10Z"
        fill="currentColor"
      />
    </svg>
  );
}

/** Divisor ornamental de lazo: linea + estrella central + linea. */
export function RibbonDivider({ className = "" }) {
  return (
    <div className={`ribbon-divider ${className}`} role="presentation">
      <DividerStar />
    </div>
  );
}
