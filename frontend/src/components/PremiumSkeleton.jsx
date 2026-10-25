/** Premium Skeleton components with brand shimmer effect.
 * Skeletons con shimmer de marca y support de prefers-reduced-motion.
 * Se usan como estado de carga "quieto" — la página conserva su layout
 * real y los bloques respiran hasta que llegan los datos.
 * Diseño consistente con ProfilePage y HomePage.
 */

/** Skeleton base con shimmer premium */
function PremiumSkeletonBase({ className, size = "md", style }) {
  const prefersReducedMotion = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (prefersReducedMotion) {
    return <div aria-hidden="true" className={`skeleton skeleton-reduced ${className}`} style={{ animationDuration: '0s' }} />;
  }

  return (
    <div
      aria-hidden="true"
      className={`skeleton skeleton-shimmer ${className}`}
      style={{
        background: "linear-gradient(90deg, transparent 0%, currentColor 50%, transparent 100%)",
        backgroundSize: "200% 100%",
        animation: "skeleton-shimmer 1.5s ease-in-out infinite",
        ...style,
      }}
    />
  );
}

/** Shimmer keyframe definition - añadir al CSS global o component style */
const shimmerKeyframes = `
  @keyframes skeleton-shimmer {
    0% {
      background-position: 200% 0;
    }
    100% {
      background-position: -200% 0;
    }
  }
`;

/** Skeleton de bloque simple - para stats, cards, etc. */
export function PremiumSkeleton({
  className = "",
  size = "md",
  width,
  height,
  style,
}) {
  // Inyectar keyframes globalmente si no existen
  if ((document.querySelector('[data-skeleton-keyframes]') === null)) {
    const style = document.createElement('style');
    style.setAttribute('data-skeleton-keyframes', '');
    style.textContent = shimmerKeyframes;
    document.head.appendChild(style);
  }

  return PremiumSkeletonBase({ className, style });
}

/** Skeleton rectangular - para stats, cards, inputs */
export function RectangularSkeleton({ className = "", width, height, style }) {
  return PremiumSkeletonBase({
    className: `${className} skeleton-rectangular`,
    style: { width, height, ...style },
  });
}

/** Skeleton circular - para avatares, chips, badges */
export function CircularSkeleton({ className = "", size = "md", style }) {
  const sizeMap = { sm: 24, md: 36, lg: 48 };
  const diameter = sizeMap[size] || 36;

  return PremiumSkeletonBase({
    className: `${className} skeleton-circle`,
    style: { width: diameter, height: diameter, ...style },
  });
}

/** Skeleton de línea - para tablas, listas */
export function LineSkeleton({ className = "", width, style }) {
  return PremiumSkeletonBase({
    className: `${className} skeleton-line`,
    style: { width, height: "1.2rem", ...style },
  });
}

/** Skeleton de avatar - para usuaros y perfiles */
export function AvatarSkeleton({ className = "", size = "md", style }) {
  const sizeMap = { sm: 28, md: 48, lg: 72 };
  const diameter = sizeMap[size] || 48;

  return PremiumSkeletonBase({
    className: `${className} skeleton-avatar`,
    style: { width: diameter, height: diameter, ...style },
  });
}

/** Skeleton de texto - para párrafos, descripciones */
export function TextSkeleton({ className = "", lines = 3, style }) {
  return PremiumSkeletonBase({
    className: `${className} skeleton-text`,
    style: {
      height: `calc(1.2rem * ${lines})`,
      width: "60%",
      ...style,
    },
  });
}

/** Skeleton de lista - para listas de eventos, tickets, etc. */
export function ListSkeleton({ rows = 4, className = "", style }) {
  return (
    <div
      className={`space-y-2 ${className}`}
      style={{ animationDuration: prefersReducedMotion ? '0s' : 'auto' }}
      aria-busy="true"
    >
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="card flex items-start gap-3 p-3">
          <div className="min-w-0 flex-1 space-y-1">
            <CircularSkeleton size="sm" />
            <TextSkeleton lines={2} />
          </div>
          <LineSkeleton width="2.5rem" />
        </div>
      ))}
    </div>
  );
}

/** Skeleton de tarjeta individual - para grids de stats, eventos */
export function CardSkeleton({ className = "", style }) {
  return (
    <div
      className={`card p-4 ${className}`}
      style={{
        animationDuration: prefersReducedMotion ? '0s' : '0.2s ease',
        ...style,
      }}
      aria-busy="true"
    />
  );
}

export default PremiumSkeleton;