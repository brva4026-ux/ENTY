/** Logo E Troquelada - Enty Premium.
 * Diseño con profundidad usando tokens --e-ink y --e-brand.
 * Tema-aware: violeta remapea en modo claro.
 */
function Logo({ size = 32 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <rect width="24" height="24" fill="var(--e-ink-1)" rx="4" />
      <path
        fill="var(--e-ink-1)"
        d="M2 4h4l13 17h-4"
        stroke="var(--e-ink-1)"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        fill="none"
        stroke="var(--e-brand-400)"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M2 4h4l13 17h-4"
      />
      <path
        fill="var(--e-ink-1)"
        d="M6 8h4l3 9h-4"
        stroke="var(--e-brand-400)"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <circle
        cx="12"
        cy="12"
        r="8"
        fill="none"
        stroke="var(--e-brand-400)"
        strokeWidth="2"
      />
      <circle cx="12" cy="12" r="3" fill="var(--e-brand-400)" />
      <circle cx="12" cy="12" r="1.5" fill="var(--e-brand-500)" opacity="/4" />
    </svg>
  );
}

export default Logo;