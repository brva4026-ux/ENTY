import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../../lib/auth";
import { activeVenueId } from "../../lib/venue";
import { currentYM, labelMonth, shiftMonth } from "../../lib/format";
import BusinessOverview from "../../components/BusinessOverview";
import Icon from "../../components/Icon";
import useDocumentTitle from "../../lib/useDocumentTitle";

/**
 * Reportes del negocio como PÁGINA (/admin/negocio), no como pestaña del
 * panel: los números del mes no dependen de una noche concreta, así que se
 * enlazan y se comparten igual que /admin/metricas.
 *
 * El mes vive en la URL (`?mes=YYYY-MM`), la misma convención que la portada
 * del panel: un período concreto es compartible y sobrevive a una recarga.
 * Sin `?mes` cuenta el mes en curso. Las flechas se repiten aquí (mismas
 * clases .vh-mesnav que la portada) porque este reporte no se pinta dentro
 * de ella y su estado vacío invita a navegar a otros meses.
 */
export default function BusinessPage() {
  useDocumentTitle("Negocio");
  const { user } = useAuth();
  const nav = useNavigate();
  const venueId = activeVenueId(user);
  // Sin la portada del panel, hay que decir de qué negocio son estos números.
  const venueName = (user?.venues || []).find((v) => v.id === venueId)?.name;
  const [searchParams, setSearchParams] = useSearchParams();
  const month = searchParams.get("mes"); // null = mes en curso
  const nowMonth = currentYM();
  const shownMonth = month || nowMonth;
  const isCurrent = shownMonth === nowMonth;

  // Cambiar de período es navegar: el mes queda en la URL, no en un estado
  // local que se pierde al recargar ni en un `replace` silencioso.
  const setMonth = (next) => {
    const params = new URLSearchParams(searchParams);
    if (!next || next === nowMonth) params.delete("mes");
    else params.set("mes", next);
    setSearchParams(params, { replace: true });
  };

  if (!venueId) {
    return (
      <div className="card p-6 text-center text-zinc-400">
        No tienes venues asociadas. Habla con un super admin.
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          {venueName && <p className="eyebrow">{venueName}</p>}
          <h1 className="display text-xl">Negocio</h1>
          <p className="mt-1 text-sm text-zinc-400">
            La foto del mes: ventas, ritmo de venta y quién vuelve.
          </p>
        </div>
        <div className="vh-mesnav">
          <div className="vh-mesnav-ctrl">
            <button
              type="button"
              onClick={() => setMonth(shiftMonth(shownMonth, -1))}
              className="btn-mini btn-icon"
              data-variant="brand"
              aria-label="Mes anterior"
            >
              <Icon name="back" className="h-3.5 w-3.5" />
            </button>
            <span className="vh-mesnav-label display capitalize">
              {labelMonth(shownMonth)}
            </span>
            <button
              type="button"
              onClick={() => setMonth(shiftMonth(shownMonth, 1))}
              className="btn-mini btn-icon"
              data-variant="brand"
              aria-label="Mes siguiente"
              disabled={isCurrent}
            >
              <Icon name="back" className="h-3.5 w-3.5 rotate-180" />
            </button>
          </div>
          {!isCurrent && (
            <button
              type="button"
              onClick={() => setMonth(null)}
              className="vh-mesnav-hoy"
            >
              Volver al mes actual
            </button>
          )}
        </div>
      </header>

      <div className="mt-5">
        <BusinessOverview
          venueId={venueId}
          month={month}
          onOpenEvent={(id) => nav(`/admin?event=${id}&tab=resumen`)}
        />
      </div>
    </div>
  );
}
