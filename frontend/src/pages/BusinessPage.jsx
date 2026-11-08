import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { activeVenueId } from "../lib/venue";
import { apiFetch } from "../lib/api";
import { haptics } from "../lib/haptics";
import { currentYM, labelMonth, shiftMonth } from "../lib/format";
import BusinessOverview from "../components/BusinessOverview";
import DoorSection from "../components/DoorSection";
import PromotersSection from "../components/PromotersSection";
import PaymentsPanel from "../components/PaymentsPanel";
import TeamManager from "../components/TeamManager";
import PayoutsManager from "../components/PayoutsManager";
import InvitationsManager from "../components/InvitationsManager";
import Icon from "../components/Icon";
import useDocumentTitle from "../lib/useDocumentTitle";

/**
 * Negocio: el HUB de lo que NO depende de una noche puntual.
 *
 * Antes estas secciones vivían embebidas en la portada del panel (`/admin`),
 * apiladas debajo de la franja de eventos: el admin tenía que bajar por toda
 * la lista de noches para llegar a "Puerta" o "Equipo", y el dock de accesos
 * competía por ser la cabecera con la propia portada.
 *
 * Aquí hay UN solo contexto (el negocio) con sus secciones como pestañas:
 * Reportes · Puerta · Promotores · Cobros · Equipo · Liquidaciones ·
 * Invitaciones. La pestaña vive en la URL (`?tab=`), igual que en el perfil y
 * el backstage, así que un enlace a una sección es compartible y sobrevive a
 * la recarga. El mes de Reportes viaja aparte (`?mes=`), la misma convención
 * de siempre.
 *
 * Esta pantalla es también la dueña de los datos compartidos entre secciones:
 * el catálogo de eventos (Cobros) y el equipo (Equipo, Liquidaciones) se piden
 * una vez y se reparten, en vez de que cada sección los vuelva a pedir.
 */
export default function BusinessPage() {
  useDocumentTitle("Negocio");
  const { user } = useAuth();
  const nav = useNavigate();
  const venueId = activeVenueId(user);
  const realVenueId = venueId ?? 0;
  const venueName = (user?.venues || []).find((v) => v.id === venueId)?.name;

  const [searchParams, setSearchParams] = useSearchParams();
  const month = searchParams.get("mes"); // null = mes en curso
  const nowMonth = currentYM();
  const shownMonth = month || nowMonth;
  const isCurrent = shownMonth === nowMonth;

  const tabs = useMemo(
    () => [
      { id: "reportes", label: "Reportes", icon: "chart" },
      { id: "puerta", label: "Puerta", icon: "door" },
      { id: "promotores", label: "Promotores", icon: "users" },
      { id: "cobros", label: "Cobros", icon: "ticket" },
      { id: "equipo", label: "Equipo", icon: "users" },
      { id: "liquidaciones", label: "Liquidaciones", icon: "money" },
      { id: "invitaciones", label: "Invitaciones", icon: "door" },
    ],
    [],
  );

  const rawTab = searchParams.get("tab");
  const activeTab = tabs.some((t) => t.id === rawTab) ? rawTab : "reportes";

  // La URL canónica no escribe `tab=reportes`: es la pestaña por defecto.
  useEffect(() => {
    const canonical = activeTab === "reportes" ? null : activeTab;
    if ((rawTab ?? null) === canonical) return;
    const next = new URLSearchParams(searchParams);
    if (canonical === null) next.delete("tab");
    else next.set("tab", canonical);
    setSearchParams(next, { replace: true });
  }, [activeTab, rawTab, searchParams, setSearchParams]);

  function selectTab(id) {
    haptics.tick();
    const next = new URLSearchParams(searchParams);
    if (id === "reportes") next.delete("tab");
    else next.set("tab", id);
    setSearchParams(next);
  }

  // Navegación por teclado del patrón ARIA tabs (flechas + Home/End).
  function onTabKeyDown(e) {
    const ids = tabs.map((t) => t.id);
    const i = ids.indexOf(activeTab);
    let next = null;
    if (e.key === "ArrowRight") next = ids[(i + 1) % ids.length];
    else if (e.key === "ArrowLeft") next = ids[(i - 1 + ids.length) % ids.length];
    else if (e.key === "Home") next = ids[0];
    else if (e.key === "End") next = ids[ids.length - 1];
    if (!next) return;
    e.preventDefault();
    selectTab(next);
    document.getElementById(`biz-tab-${next}`)?.focus();
  }

  // Datos compartidos: el catálogo de eventos (Cobros) y el equipo (Equipo,
  // Liquidaciones). Se piden aquí una vez y se reparten a las secciones.
  const [events, setEvents] = useState([]);
  const [users, setUsers] = useState([]);
  useEffect(() => {
    if (!realVenueId) return;
    apiFetch(`/venues/${realVenueId}/events`)
      .then((rows) => setEvents(rows || []))
      .catch(() => setEvents([]));
    apiFetch(`/venues/${realVenueId}/users?include_inactive=true`)
      .then((rows) => setUsers(rows || []))
      .catch(() => setUsers([]));
  }, [realVenueId]);
  const reloadUsers = () =>
    apiFetch(`/venues/${realVenueId}/users?include_inactive=true`)
      .then((rows) => setUsers(rows || []))
      .catch(() => {});

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
    <div className="mx-auto w-full max-w-3xl space-y-5">
      <header>
        {venueName && <p className="eyebrow">{venueName}</p>}
        <h1 className="display text-xl">Negocio</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Lo que no depende de una noche puntual: números del bar, puerta,
          equipo y pagos.
        </p>
      </header>

      <div
        className="tabbar no-scrollbar pf-tabs"
        role="tablist"
        aria-label="Secciones del negocio"
      >
        {tabs.map((t) => {
          const active = t.id === activeTab;
          return (
            <button
              key={t.id}
              id={`biz-tab-${t.id}`}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={`biz-panel-${t.id}`}
              tabIndex={active ? 0 : -1}
              // El nombre viaja en el aria-label: bajo 520px la etiqueta se
              // oculta (queda solo el icono) y el botón se quedaba sin nombre.
              aria-label={t.label}
              onClick={() => selectTab(t.id)}
              onKeyDown={onTabKeyDown}
              className="tabbar-item"
            >
              <Icon name={t.icon} className="h-4 w-4" aria-hidden="true" />
              <span className="pf-tab-label">{t.label}</span>
            </button>
          );
        })}
      </div>

      {activeTab === "reportes" && (
        <section
          id="biz-panel-reportes"
          role="tabpanel"
          aria-labelledby="biz-tab-reportes"
          tabIndex={0}
        >
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-zinc-400">
              La foto del mes: ventas, ritmo de venta y quién vuelve.
            </p>
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
          </div>
          <BusinessOverview
            venueId={venueId}
            month={month}
            onOpenEvent={(id) => nav(`/admin?event=${id}&tab=resumen`)}
          />
        </section>
      )}

      {activeTab === "puerta" && (
        <section
          id="biz-panel-puerta"
          role="tabpanel"
          aria-labelledby="biz-tab-puerta"
          tabIndex={0}
        >
          <DoorSection
            venueId={venueId}
            onOpenEvent={(id) => nav(`/admin?event=${id}&tab=entradas`)}
          />
        </section>
      )}

      {activeTab === "promotores" && (
        <section
          id="biz-panel-promotores"
          role="tabpanel"
          aria-labelledby="biz-tab-promotores"
          tabIndex={0}
        >
          <PromotersSection venueId={venueId} month={month} />
        </section>
      )}

      {activeTab === "cobros" && (
        <section
          id="biz-panel-cobros"
          role="tabpanel"
          aria-labelledby="biz-tab-cobros"
          tabIndex={0}
        >
          <PaymentsPanel venueId={venueId} events={events} />
        </section>
      )}

      {activeTab === "equipo" && (
        <section
          id="biz-panel-equipo"
          role="tabpanel"
          aria-labelledby="biz-tab-equipo"
          tabIndex={0}
        >
          <TeamManager venueId={venueId} users={users} onChanged={reloadUsers} />
        </section>
      )}

      {activeTab === "liquidaciones" && (
        <section
          id="biz-panel-liquidaciones"
          role="tabpanel"
          aria-labelledby="biz-tab-liquidaciones"
          tabIndex={0}
        >
          <PayoutsManager venueId={venueId} users={users} />
        </section>
      )}

      {activeTab === "invitaciones" && (
        <section
          id="biz-panel-invitaciones"
          role="tabpanel"
          aria-labelledby="biz-tab-invitaciones"
          tabIndex={0}
        >
          <InvitationsManager venueId={venueId} />
        </section>
      )}
    </div>
  );
}
