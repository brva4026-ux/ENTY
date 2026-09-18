/** Primitivos del design system: skeletons con el shimmer de la marca.
 *  Se usan como estado de carga "quieto" — la página conserva su layout
 *  real y los bloques respiran hasta que llegan los datos. */

export function Skeleton({ className = "" }) {
  return <div aria-hidden="true" className={`skeleton ${className}`} />;
}

/** Bloque de carga del dashboard: cifra + dos líneas, como las cards reales. */
export function StatSkeletonRow({ count = 4 }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-busy="true">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="card p-4">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="mt-3 h-8 w-24" />
          <Skeleton className="mt-2 h-2.5 w-14" />
        </div>
      ))}
    </div>
  );
}

/** Lista de filas de carga (tablas, historial, equipo). */
export function ListSkeleton({ rows = 4, className = "" }) {
  return (
    <div className={`space-y-2 ${className}`} aria-busy="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="card flex items-center justify-between p-4">
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-2.5 w-24" />
          </div>
          <Skeleton className="h-6 w-16 rounded-full" />
        </div>
      ))}
    </div>
  );
}

/** Selector de evento del escáner/dashboard mientras carga la lista. */
export function SelectSkeleton({ className = "" }) {
  return <Skeleton className={`h-11 w-full rounded-xl ${className}`} />;
}
