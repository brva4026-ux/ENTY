/**
 * Fondo en movimiento de la pantalla de ingreso.
 *
 * Tres manchas de luz de marca (violeta) que derivan muy lento + un barrido
 * de brillo que cruza en diagonal. No es un video: es una capa de gradientes
 * animados, así no pesa un byte, escala a cualquier pantalla y se apaga sola
 * con prefers-reduced-motion. El movimiento es deliberadamente lento y tenue
 * (22-38s por ciclo, opacidad baja): atmósfera premium, no un salvapantallas.
 *
 * Puramente decorativo: `aria-hidden` y `pointer-events: none`.
 */
export function LoginAurora() {
  return (
    <div className="auth-aurora" aria-hidden="true">
      <span className="auth-aurora-blob auth-aurora-blob--a" />
      <span className="auth-aurora-blob auth-aurora-blob--b" />
      <span className="auth-aurora-blob auth-aurora-blob--c" />
      <span className="auth-aurora-sheen" />
    </div>
  );
}
