/** Logo E Troquelada + sello registro Enty.
 * Usa tokens --e-ink-1 negro mate y --e-brand-400 violeta.
 * Totalmente tema-aware: en claro el violeta remapea via html[data-theme=light].
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
      <path
        fill="var(--e-ink-1)"
        d="M2 4h4l13 17h-4"
        stroke="var(--e-ink-1)"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
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
    </svg>
  );
}

export default Logo;