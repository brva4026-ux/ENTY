import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useLiveRefresh } from "../lib/useLiveRefresh";
import { haptics } from "../lib/haptics";
import { PullToRefresh } from "../components/PullToRefresh";
import { InstallPrompt } from "../components/InstallPrompt";
import { useUI } from "../lib/ui";
import { activeVenueId } from "../lib/venue";
import { getToken } from "../lib/tokenStore";
import { fromZonedInput, toZonedInput, isPastEvent, eventZone } from "../lib/eventTime";
import { OnboardingChecklist, OnboardingResume } from "../components/OnboardingChecklist";
import {
  cachedPreferences,
  loadPreferences,
  savePreference,
  clearLegacyOnboardingKeys,
  PREF_ONBOARDING,
  PREF_TUTORIAL,
} from "../lib/onboarding";
import OnboardingTour, { ONBOARDING_STEPS } from "../components/OnboardingTour";
import EventWorkbench, { EventNotFound } from "../components/EventWorkbench";
import Icon from "../components/Icon";
import EventCreateModal from "../components/EventCreateModal";
import AdminEventCard from "../components/AdminEventCard";
import AdminEventWorkspace from "../components/AdminEventWorkspace";
import { useAdminChrome } from "../components/AdminShell";
import QrTesterModal from "../components/QrTesterModal";
import VenueHeader from "../components/VenueHeader";
import useDocumentTitle from "../lib/useDocumentTitle";
import { EVENT_CATEGORIES } from "../lib/eventCategories";
import { money } from "../lib/format";
import { fileToDataUrl } from "../lib/imageUpload";
import EventPublicPreview from "../components/EventPublicPreview";

/** Pestañas del backstage de un evento. Cuatro secciones que agrupan el
 *  trabajo real: montar, vender, asignar y operar la puerta. */
const EVENT_TABS = ["resumen", "ventas", "equipo", "accesos"];

/** Enlaces viejos del backstage -> sección nueva equivalente. */
const LEGACY_EVENT_TABS = {
  entradas: "ventas",
  boletas: "ventas",
  cupones: "ventas",
  lineup: "resumen",
  cupos: "equipo",
  noche: "equipo",
};

function normalizeEventTab(tab) {
  if (EVENT_TABS.includes(tab)) return tab;
  return LEGACY_EVENT_TABS[tab] || "resumen";
}

/** Pestañas que eran del panel y ahora son sub-secciones del hub Negocio:
 *  sirven para redirigir enlaces viejos (/admin?tab=equipo). */
const VENUE_TABS = [
  "negocio",
  "puerta",
  "promotores",
  "cobros",
  "equipo",
  "liquidaciones",
  "invitaciones",
];

/** Diferencia de dias de CALENDARIO (no de 24h): un evento de hoy a las
    11 p.m. dista 0.9 dias de la medianoche y un round() lo mandaria a
    "mañana". Comparar año/mes/dia evita ese classico. */
function calendarDiffDays(a, b) {
  const ua = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const ub = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((ua - ub) / 86400000);
}

const NEXT_ACTIONS = {
  draft: [
    { action: "publish", label: "Revisar y publicar" },
    { action: "cancel", label: "Cancelar", danger: true },
  ],
  published: [
    { action: "live", label: "Abrir puertas" },
    { action: "cancel", label: "Cancelar evento", danger: true },
  ],
  live: [{ action: "end", label: "Finalizar evento", secondary: true }],
  ended: [
    // Reabrir (mig 034): 'ended' dejó de ser terminal. La noche se puede
    // estirar más allá de la gracia de 6 h, o el cierre fue un error.
    { action: "reopen", label: "Reabrir puertas" },
  ],
  cancelled: [],
};

/** Lo que se avisa al cerrar cada transición. Una sola copia: la usan el
    backstage y la tarjeta de la franja (antes cada camino tenía la suya). */
const DONE_MESSAGE = {
  publish: "Evento publicado: ya puede vender 🎟️",
  live: "Puertas abiertas: la puerta fue avisada 🚪",
  end: "Evento finalizado",
  reopen: "Evento reabierto: la puerta vuelve a escanear 🔓",
  cancel: "Evento cancelado",
};

/* Chip de estado para la franja de eventos (compacto, en español) y orden
 * por prioridad operativa: vivos arriba, pasados al final. Ambos viven en
 * EventWorkbench — un solo vocabulario de estados en toda la app. */

/**
 * Espejo de la regla del backend (lifecycle.delete_event): se borra cualquier
 * evento salvo el que tiene las puertas abiertas (se está operando ahora).
 * Para limpiar un catálogo de pruebas no hace falta vaciar boletas a mano.
 */
export function canDeleteEvent(ev) {
  return !!ev && ev.status !== "live";
}

export default function AdminDashboard() {
  useDocumentTitle("Panel del negocio");
  const { user } = useAuth();
  const ui = useUI();
  const { setBreadcrumb } = useAdminChrome();
  // Multi-negocio: la activa se elige en /perfil y persiste (tf_venue);
  // sin elección, la primera disponible (comportamiento de siempre).
  const venueId = activeVenueId(user);
  const realVenueId = venueId ?? 0;

  const [events, setEvents] = useState(null); // null = primera carga (skeleton)
  // Eventos de URL ya revalidados contra el servidor (ver más abajo): un
  // enlace a un evento ausente se relee UNA vez antes de darlo por roto.
  const probedEventsRef = useRef({});
  // Boletas activas por evento ({id: n}): el pulso de la franja sin abrir
  // cada evento. Un solo GET agregado, no N requests.
  const [ticketCounts, setTicketCounts] = useState({});
  const [types, setTypes] = useState([]);
  const [allocations, setAllocations] = useState([]);
  const [report, setReport] = useState(null);
  const [users, setUsers] = useState([]);
  const [selectedEvent, setSelectedEvent] = useState(null);
  // Fuente de verdad de la URL: el evento abierto y su pestaña viven en
  // /admin?event=<id>&tab=<tab> — compartible, sobrevive recargas y back.
  const [searchParams, setSearchParams] = useSearchParams();
  const urlEvent = searchParams.get("event");
  const urlTab = searchParams.get("tab") || "resumen";
  const [error, setError] = useState("");
  // Modal de crear evento: cerrado por defecto — el admin trabaja en su
  // evento, no mira un formulario gigante todo el día.
  const [createOpen, setCreateOpen] = useState(false);
  // Probador de QR: leer un QR y ver a quién pertenece SIN canjearlo.
  const [qrTesterOpen, setQrTesterOpen] = useState(false);
  const [busyAction, setBusyAction] = useState("");
  // Edición del evento seleccionado: null = cerrado, objeto = formulario abierto.
  const [editingEvent, setEditingEvent] = useState(null);
  const [editError, setEditError] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [uploadingFlyer, setUploadingFlyer] = useState(false);
  const [previewEvent, setPreviewEvent] = useState(null);
  const flyerInputRef = useRef(null);
  // La pestaña activa es la de la URL (la mig 012 ya generaba ?tab=...);
  // whitelist para no renderizar una pestaña inventada por el usuario. Solo
  // pestañas de EVENTO: las del negocio viven en /admin/negocio.
  const section = normalizeEventTab(urlTab);

  // events === null significa "primera carga": se muestra skeleton en vez de
  // un vacío engañoso ("Aún no hay eventos") que no es verdad aún.
  const booting = events === null;

  // Franja de eventos: búsqueda por nombre y filtro por estado. Es client-side
  // a propósito: el catálogo ya vive en memoria y pedirlo al server por cada
  // tecla sería desperdicio (y más lento que filtrar 50 objetos).
  const [eventQuery, setEventQuery] = useState("");
  const [eventBucket, setEventBucket] = useState("todos");
  // Filtros y historial: el listado prioriza lo que está pasando. Los
  // estados y el pasado no ocupan la portada hasta que el admin los pide.
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  // Flyers que ya fallaron al cargar ({url: true}): la tarjeta muestra sus
  // iniciales en lugar de un img roto. Estado unificado para toda la franja.
  const [badFlyers, setBadFlyers] = useState({});

  // Rango de caja del cierre (opcional): vacío = todo el evento. Fechas
  // sueltas "YYYY-MM-DD" que el backend interpreta en la zona del evento.
  const [cajaRange, setCajaRange] = useState({ desde: "", hasta: "" });
  const [cajaBusy, setCajaBusy] = useState(false);

  const BUCKETS = [
    ["todos", "Todos"],
    ["live", "En puerta"],
    ["published", "A la venta"],
    ["draft", "Borradores"],
    ["ended", "Terminados"],
    ["cancelled", "Cancelados"],
  ];
  // Igual que el buscador de la vitrina: el input responde en cada tecla y el
  // filtrado de la lista puede diferirse, para no bloquear el tecleo cuando la
  // venue tiene muchas noches.
  const deferredEventQuery = useDeferredValue(eventQuery);
  const q = deferredEventQuery.trim().toLowerCase();
  const activeFilterCount = eventBucket !== "todos" ? 1 : 0;
  const matchesQuery = (ev) => !q || ev.name.toLowerCase().includes(q);
  const visibleEvents = (events ?? []).filter(
    (ev) =>
      (eventBucket === "todos" || ev.status === eventBucket) &&
      matchesQuery(ev),
  );

  const byStartAsc = (a, b) =>
    String(a.starts_at ?? "").localeCompare(String(b.starts_at ?? ""));
  const byStartDesc = (a, b) => byStartAsc(b, a);
  const base = (events ?? []).filter(matchesQuery);
  const liveEvents = base
    .filter((ev) => ev.status === "live")
    .sort(byStartAsc);
  const upcoming = base
    .filter((ev) => ev.status === "published" && !isPastEvent(ev))
    .sort(byStartAsc);
  const drafts = base.filter((ev) => ev.status === "draft").sort(byStartAsc);
  const history = base
    .filter(
      (ev) =>
        ev.status === "ended" ||
        ev.status === "cancelled" ||
        (ev.status === "published" && isPastEvent(ev)),
    )
    .sort(byStartDesc);
  const sortEventList = (list) => {
    const rank = { live: 0, published: 1, draft: 2, ended: 3, cancelled: 4 };
    return [...list].sort(
      (a, b) => (rank[a.status] ?? 3) - (rank[b.status] ?? 3) || byStartAsc(a, b),
    );
  };

  // Onboarding del primer evento. El evento del onboarding es el BORRADOR más
  // cercano en el tiempo, no `events[0]`: la lista viene ordenada `starts_at
  // DESC`, así que `events[0]` es el evento con la fecha MÁS LEJANA del futuro.
  // Con ese criterio, publicar la fiesta de hoy y luego crear la del mes que
  // viene (borrador) reactivaba la guía que el admin ya había cerrado.
  //
  // Un borrador sin fecha no debería existir (el modal la exige), pero se
  // ordena igual para no depender de eso.
  const onboardingEvent = useMemo(() => {
    const draftEvents = (events ?? []).filter((e) => e.status === "draft");
    if (!draftEvents.length) return null;
    return [...draftEvents].sort((a, b) =>
      String(a.starts_at ?? "").localeCompare(String(b.starts_at ?? ""))
    )[0];
  }, [events]);
  // La guía solo aplica mientras el negocio no esté vendiendo: con el primer
  // evento publicado ya no hay nada que enseñar. Se mira TODA la lista, no solo
  // el borrador: un borrador viejo junto a un evento ya publicado (o en puerta)
  // no debe reabrir la guía.
  const onboardingRelevant =
    events !== null &&
    !events.some((e) => e.status !== "draft" && e.status !== "cancelled");
  // Preferencia por usuario+venue, en el SERVIDOR (lib/onboarding, mig 032):
  // "accepted" la aceptó, "dismissed" la rechazó, "completed" la terminó,
  // "pending" todavía no decidió (se le ofrece). Se pinta primero el cache para
  // no mostrar la invitación un instante y esconderla al llegar la respuesta.
  const [prefs, setPrefs] = useState(() => cachedPreferences(venueId));
  const onboardingPref = prefs[PREF_ONBOARDING]?.value ?? "pending";
  // Tutorial guiado abierto (modo "me dice dónde presionar").
  const [tourOpen, setTourOpen] = useState(false);
  useEffect(() => {
    // Claves viejas (localStorage) que ya no se leen: se limpian una vez.
    clearLegacyOnboardingKeys();
  }, []);
  useEffect(() => {
    let alive = true;
    setPrefs(cachedPreferences(venueId));
    loadPreferences(venueId).then((p) => {
      if (alive) setPrefs(p);
    });
    return () => {
      alive = false;
    };
  }, [venueId]);

  // Se OFRECE (opt-in) si no decidió; se MUESTRA la guía si la aceptó.
  const showOnboardingInvite =
    onboardingRelevant && onboardingPref === "pending" && events !== null;
  const showOnboardingChecklist =
    onboardingRelevant && onboardingPref === "accepted" && events !== null;
  // La guía está visible de alguna forma: los efectos que cargan su progreso
  // (tipos, cupos) dependen de esto.
  const showOnboarding = showOnboardingInvite || showOnboardingChecklist;
  // Acceso permanente para volver a mostrarla cuando está oculta (la rechazó o
  // ya la completó). NO depende de que haya un borrador: si el negocio ya
  // vende, la guía terminó su trabajo y no debe reaparecer sola — pero el
  // camino de vuelta siempre queda a la vista.
  const showOnboardingResume =
    events !== null &&
    (onboardingPref === "dismissed" || onboardingPref === "completed");

  /** Guarda la decisión en el servidor y refleja el resultado en el acto. */
  function decideOnboarding(pref) {
    setPrefs((p) => ({ ...p, [PREF_ONBOARDING]: { ...p[PREF_ONBOARDING], value: pref } }));
    savePreference(venueId, PREF_ONBOARDING, pref).catch(() =>
      // Si el servidor la rechaza, se recarga la verdad: la UI no puede quedar
      // mintiendo sobre una decisión que no se guardó.
      loadPreferences(venueId).then(setPrefs)
    );
  }

  /**
   * Arranca el tutorial guiado. Aceptar la invitación ES aceptar la guía, así
   * que también queda "accepted": sin eso, cerrar el tutorial devolvía al admin
   * a la invitación de nuevo — el bucle que se está arreglando.
   */
  function startTour() {
    if (onboardingPref === "pending") decideOnboarding("accepted");
    const step = prefs[PREF_TUTORIAL]?.step ?? 0;
    setPrefs((p) => ({ ...p, [PREF_TUTORIAL]: { value: "accepted", step } }));
    savePreference(venueId, PREF_TUTORIAL, "accepted", step).catch(() => {});
    setTourOpen(true);
  }

  /** Guarda el avance del tutorial (sobrevive a cerrar la app). */
  function onTourStep(step) {
    setPrefs((p) => ({ ...p, [PREF_TUTORIAL]: { value: "accepted", step } }));
    savePreference(venueId, PREF_TUTORIAL, "accepted", step).catch(() => {});
  }

  /** El tutorial terminó: no vuelve a ofrecerse solo. La guía de progreso
   *  sigue viva si al negocio le falta montar algo — son dos cosas distintas. */
  function finishTour() {
    setTourOpen(false);
    setPrefs((p) => ({ ...p, [PREF_TUTORIAL]: { value: "completed", step: 0 } }));
    savePreference(venueId, PREF_TUTORIAL, "completed", 0).catch(() => {});
  }

  /** El usuario salió del tutorial: se recuerda dónde quedó para retomarlo. */
  function exitTour() {
    setTourOpen(false);
  }

  /** El tutorial no puede explicar el backstage desde la lista: navega solo.
   *  Es el único punto donde el tutorial mueve la URL; el resto del panel
   *  sigue siendo el dueño de la navegación. */
  useEffect(() => {
    if (!tourOpen) return;
    const step = ONBOARDING_STEPS[prefs[PREF_TUTORIAL]?.step ?? 0];
    if (!step) return;
    if (step.screen === "event") {
      // El backstage necesita un evento. El borrador del onboarding es el
      // candidato natural; sin borrador, el más próximo.
      const target = onboardingEvent ?? events?.[0];
      if (target && selectedEvent !== target.id) flyToEvent(target.id, "resumen");
    } else if (selectedEvent !== null) {
      setSearchParams({});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tourOpen, prefs[PREF_TUTORIAL]?.step]);

  // El tutorial y el modal de crear evento no pueden coexistir: el tooltip
  // (z-85) queda por encima del diálogo (z-80) y su capa tapa el botón
  // "Crear evento" del modal, así que el clic nunca llega. Al abrir el modal
  // el tutorial se retira; el avance queda guardado y se retoma al cerrarlo.
  useEffect(() => {
    if (createOpen && tourOpen) setTourOpen(false);
  }, [createOpen, tourOpen]);

  const loadEvents = useCallback(async () => {
    if (!venueId) return;
    const data = await apiFetch(`/venues/${venueId}/events`);
    setEvents(data);
    // Contadores de la franja: fire-and-forget (si falla, la franja muestra
    // su chip vacío; no rompe el listado que ya llegó).
    apiFetch(`/venues/${venueId}/events/ticket-counts`)
      .then(setTicketCounts)
      .catch(() => {});
  }, [venueId]);

  useEffect(() => {
    loadEvents().catch((e) => setError(e.message));
  }, [loadEvents]);

  // Sincronización URL <-> selección. La URL manda si trae evento válido;
  // sin evento en la URL, se aterriza en el primero (determinismo: la
  // recarga con /admin a secas abre el mismo evento, no una pantalla vacía).
  // Con eventos === null aún no se sabe si existe el de la URL: no tocar nada.
  useEffect(() => {
    if (events === null) return;
    const wanted = urlEvent ? Number(urlEvent) : null;
    const exists = wanted !== null && events.some((e) => e.id === wanted);
    if (exists) {
      if (wanted !== selectedEvent) setSelectedEvent(wanted); // Enlace viejo con una pestaña de venue dentro de un evento
      // (?event=5&tab=equipo): esas pestañas no existen en el backstage —
      // se normaliza al evento sin tab (aterriza en Resumen).
      if (urlTab && !EVENT_TABS.includes(urlTab)) {
        const next = normalizeEventTab(urlTab);
        const params = { event: String(wanted) };
        if (next !== "resumen") params.tab = next;
        setSearchParams(params, { replace: true });
      }
    } else if (urlEvent) {
      // El evento de la URL no está en el catálogo que tenemos. Puede ser un
      // enlace de verdad roto (borrado) o, más probable en la operación, un
      // aviso recién llegado a un evento que se creó DESPUÉS de esta carga
      // (la cola de puerta crea la noche y avisa en el acto). Antes de borrar
      // el parámetro se relee el catálogo UNA vez: solo si el evento sigue sin
      // aparecer el enlace se declara roto. Sin este paso, el aviso se comía
      // su propio destino y aterrizaba en el panel a secas.
      if (probedEventsRef.current[urlEvent]) {
        probedEventsRef.current[urlEvent] = false;
        setSearchParams({});
      } else {
        probedEventsRef.current[urlEvent] = true;
        loadEvents().catch(() => {});
      }
    } else if (selectedEvent !== null) {
      // Sin ?event= en la URL: la lista es la pantalla (modo lista). Nadie
      // aterriza "en el primer evento" por accidente: entrar es una decisión.
      setSelectedEvent(null);
    }
    // selectedEvent a propósito fuera de las deps: esta pantalla solo sigue a
    // la URL y al catálogo, no re-detecciona en cada clic del selector.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, urlEvent, onboardingPref]);

  /** Navega al backstage de un evento (la URL es la fuente de verdad). */
  function flyToEvent(id, tab) {
    const params = new URLSearchParams();
    params.set("event", String(id));
    const next = normalizeEventTab(tab);
    if (next !== "resumen") params.set("tab", next);
    setSearchParams(params); // push: back vuelve al evento/tab anterior
  }

  /** Duplica un evento (borrador con sus tipos y cupos).
   *
   *  Ley de Tesler: no se adivina "+7 días". Si la venue tiene un patrón
   *  propio (quincenal, mensual), el duplicado nace a ese intervalo —el
   *  calculado entre las últimas noches— en vez del semanal por defecto. El
   *  admin lo corrige igual al editar, pero el default ya es "lo que suele
   *  hacer" y no un número ajeno a su negocio. */
  async function duplicateEvent(ev) {
    try {
      // Intervalo real: días entre este evento y el inmediatamente anterior.
      const prev = (events ?? [])
        .filter((e) => e.id !== ev.id && e.starts_at < ev.starts_at)
        .sort((a, b) => b.starts_at.localeCompare(a.starts_at))[0];
      const gap = prev
        ? calendarDiffDays(new Date(ev.starts_at), new Date(prev.starts_at))
        : 0;
      const days = gap >= 1 && gap <= 365 ? gap : 7;
      const copy = await apiFetch(
        `/venues/${venueId}/events/${ev.id}/duplicate?days=${days}`,
        { method: "POST" },
      );
      await loadEvents();
      // NO se salta al backstage del borrador: con 20+ noches, duplicar una
      // tras otra y que cada clic te expulse de la lista rompe el flujo. El
      // borrador aparece arriba y el aviso dice que abrir.
      ui.success(
        `Borrador "${copy.name}" creado a ${days} días: ajustá la fecha y publicá 📋`,
      );
    } catch (err) {
      setError(err.message);
    }
  }

  /** Cambia de pestaña dentro del backstage del evento abierto. */
  function setSection(tab) {
    flyToEvent(selectedEvent, tab);
  }

  /** Atajo de la guía de primeros pasos: abre el borrador en la pestaña donde
   *  se resuelve el paso pendiente. Sin evento, solo "Crear evento" aplica. */
  function onboardingGo(step) {
    if (!onboardingEvent) {
      setCreateOpen(true);
      return;
    }
    flyToEvent(onboardingEvent.id, step === "evento" ? undefined : step);
  }

  // Usuarios de la venue: para asignar cupos con nombres reales
  const reloadUsers = useCallback(() => {
    if (!realVenueId) return Promise.resolve();
    return apiFetch(`/venues/${realVenueId}/users?include_inactive=true`)
      .then(setUsers)
      .catch(() => setUsers([]));
  }, [realVenueId]);
  useEffect(() => {
    reloadUsers();
  }, [reloadUsers]);

  useEffect(() => {
    if (!selectedEvent) return;
    apiFetch(`/venues/${venueId}/events/${selectedEvent}/types`)
      .then(setTypes)
      .catch((e) => setError(e.message));
    apiFetch(`/venues/${venueId}/events/${selectedEvent}/allocations`)
      .then(setAllocations)
      .catch((e) => setError(e.message));
    apiFetch(`/venues/${venueId}/events/${selectedEvent}/report`)
      .then(setReport)
      .catch((e) => setError(e.message));
    // El listado de boletas NO se pide aquí: TicketList trae el suyo paginado
    // y filtrado. Pedir el completo era una request muerta (nadie lee el
    // estado `tickets`) que además traía TODAS las boletas del evento.
  }, [selectedEvent, venueId]);

  // Progreso del primer evento SIN abrir su backstage: la guía de primeros
  // pasos necesita saber si el borrador ya tiene tipos y cupos. Con un evento
  // abierto manda el suyo (el efecto de arriba ya llenó types/allocations);
  // solo se precarga el borrador cuando NO hay backstage abierto, para no
  // pisar los datos del evento que el admin está editando en ese momento.
  useEffect(() => {
    if (selectedEvent || !showOnboarding || !onboardingEvent || !venueId) return;
    apiFetch(`/venues/${venueId}/events/${onboardingEvent.id}/types`)
      .then(setTypes)
      .catch(() => {});
    apiFetch(`/venues/${venueId}/events/${onboardingEvent.id}/allocations`)
      .then(setAllocations)
      .catch(() => {});
  }, [selectedEvent, showOnboarding, onboardingEvent, venueId]);

  // Memoizado: es dependencia de reloadAll (PTR) y de useLiveRefresh; sin
  // memo, ambas corren con una closure vieja cuando cambia el evento elegido.
  const refreshEventData = useCallback(async () => {
    if (!selectedEvent) return;
    apiFetch(`/venues/${venueId}/events/${selectedEvent}/report`)
      .then(setReport)
      .catch(() => {});
    apiFetch(`/venues/${venueId}/events/${selectedEvent}/allocations`)
      .then(setAllocations)
      .catch(() => {});
    // El pulso de la franja también vive: en puerta cambia con cada escaneo.
    apiFetch(`/venues/${venueId}/events/ticket-counts`)
      .then(setTicketCounts)
      .catch(() => {});
    // Nota: el listado de boletas no va aquí — TicketList se refresca sola
    // (su load es el refresh local de la tabla).
  }, [selectedEvent, venueId]);

  // Recarga completa para pull-to-refresh: eventos, equipo y datos del evento
  // seleccionado. Nunca lanza: el PTR solo necesita terminar.
  const reloadAll = useCallback(async () => {
    await Promise.allSettled([loadEvents(), reloadUsers(), refreshEventData()]);
    // refreshEventData ya cubre selectedEvent/venueId; si falta alguna dep,
    // el PTR refrescaría datos de un evento que ya no está seleccionado.
  }, [loadEvents, reloadUsers, refreshEventData]);

  /** Transición de ciclo de vida con UN SOLO camino: lo usan la tarjeta de la
      franja y el backstage. `ev` es el evento destino (en la tarjeta no siempre
      es el seleccionado); `fromStrip` solo cambia la clave de `busyAction` y si,
      al abortar el pre-vuelo, hay que navegar al evento (desde el backstage ya
      se está dentro). Antes eran dos funciones con textos y reglas distintas. */
  async function transitionEvent(
    ev,
    action,
    { fromStrip = false, confirmed = false } = {},
  ) {
    if (!ev) return;
    const busyKey = fromStrip ? `${action}-${ev.id}` : action;
    const zone = eventZone(ev);
    const when = (value) =>
      value
        ? new Date(value).toLocaleString("es-CO", {
            dateStyle: "full",
            timeStyle: "short",
            timeZone: zone,
          })
        : "Por confirmar";

    // PRE-VUELO: abrir puertas sin nadie en puerta era el fracaso silencioso
    // (el evento pasa a live y el escáner rechaza con 403). Se avisa ANTES del
    // confirm, con los nombres, y deja seguir si el admin decide que así sea.
    // Reabrir (mig 034) vuelve a poner la puerta en marcha: mismo pre-vuelo.
    if (action === "live" || action === "reopen") {
      try {
        const pf = await apiFetch(
          `/venues/${venueId}/events/${ev.id}/preflight`,
        );
        if (pf.bouncers === 0) {
          const ok = await ui.confirm("¿Abrir puertas sin nadie en puerta?", {
            message: fromStrip
              ? "Esta noche no tiene nadie asignado en puerta. La boletería funciona, pero no habrá quien escanee. Podés sumar a alguien en la pestaña Equipo de la noche."
              : "Esta noche no tiene nadie asignado en puerta. Podés sumar a alguien en la pestaña Equipo antes de abrir.",
            confirmLabel: "Abrir igual",
            danger: true,
          });
          if (!ok) {
            flyToEvent(ev.id, "noche");
            return;
          }
        } else if (!pf.door_ready) {
          const names = pf.door_staff.map((s) => s.full_name).join(", ");
          const ok = await ui.confirm("¿Abrir puertas sin escáner activo?", {
            message: `${names} ${pf.bouncers === 1 ? "está" : "están"} asignado${pf.bouncers === 1 ? "" : "s"} a puerta pero nadie abrió su link todavía. Sin canjear el link no van a poder escanear esta noche.`,
            confirmLabel: "Abrir igual",
          });
          if (!ok) {
            flyToEvent(ev.id, "noche");
            return;
          }
        }
      } catch {
        // Pre-vuelo caído: no bloquea la apertura (el negocio decide igual).
      }
    }

    // Confirmaciones de las transiciones que no se deshacen.
    if (action === "cancel") {
      const ok = await ui.confirm("¿Cancelar el evento?", {
        message:
          `${ev.name}\n${when(ev.starts_at)} · ${ev.location || "Lugar por confirmar"}\n\n` +
          "La ficha deja de estar pública, se detiene la venta y las boletas emitidas dejan de ser válidas en la puerta. No se puede revertir.",
        danger: true,
        confirmLabel: "Sí, cancelar evento",
      });
      if (!ok) return;
    }
    if (action === "end") {
      const ok = await ui.confirm("¿Finalizar el evento?", {
        message:
          `${ev.name}\n${when(ev.starts_at)} · ${ev.location || "Lugar por confirmar"}\n\n` +
          "La puerta deja de aceptar validaciones en línea. Podés reabrirla después si la noche se estira.",
        confirmLabel: "Finalizar evento",
      });
      if (!ok) return;
    }
    if (action === "publish" && !confirmed) {
      const activeTypes =
        ev.id === selectedEvent
          ? (types || []).filter((t) => t.is_active !== false)
          : [];
      const activeAllocations =
        ev.id === selectedEvent
          ? (allocations || []).filter((a) => a.is_active !== false)
          : [];
      const ticketLines = activeTypes.length
        ? activeTypes
            .map(
              (t) =>
                `• ${t.name}: ${
                  t.is_courtesy ? "cortesía $0" : money(t.price_cents)
                } · ${t.quantity} cupos`,
            )
            .join("\n")
        : "• Sin localidades activas todavía.";
      const promoterLine = activeAllocations.length
        ? `${activeAllocations.length} cupo(s) de promotor activos: podrán emitir desde este momento.`
        : "Sin cupos de promotor asignados: la venta directa queda en manos del admin.";
      const ok = await ui.confirm("Revisar y publicar", {
        message:
          `Evento: ${ev.name}\n` +
          `Inicio: ${when(ev.starts_at)}\n` +
          `Fin: ${when(ev.ends_at)}\n` +
          `Lugar: ${ev.location || "Por confirmar"}\n\n` +
          `Boletas configuradas:\n${ticketLines}\n\n` +
          "Al publicar:\n" +
          "• La ficha deja de ser un borrador y queda visible al público.\n" +
          "• Se habilita la venta pública y el enlace de la ficha.\n" +
          `• ${promoterLine}`,
        confirmLabel: "Publicar evento",
        cancelLabel: "Volver al borrador",
      });
      if (!ok) return;
    }
    if (action === "live") {
      const ok = await ui.confirm("¿Abrir puertas?", {
        message:
          `${ev.name}\n${when(ev.starts_at)} · ${ev.location || "Lugar por confirmar"}\n\n` +
          "Habilita el escaneo en la puerta para esta noche. El equipo asignado recibe el aviso.",
        confirmLabel: "Abrir puertas",
      });
      if (!ok) return;
    }

    setBusyAction(busyKey);
    setError("");
    try {
      const updated = await apiFetch(
        `/venues/${venueId}/events/${ev.id}/${action}`,
        { method: "POST" },
      );
      setEvents((evs) => evs.map((e) => (e.id === updated.id ? updated : e)));
      haptics.success();
      // El backstage muestra las cifras del evento abierto y necesita releerlas;
      // la franja ya quedó al día con el evento que devolvió el POST.
      if (!fromStrip) await refreshEventData();
      ui.success(DONE_MESSAGE[action]);
      return updated;
    } catch (err) {
      setError(
        action === "publish"
          ? `No se pudo publicar. El evento sigue en borrador; revisa el aviso y vuelve a intentar. ${err.message}`
          : err.message,
      );
      return null;
    } finally {
      setBusyAction("");
    }
  }

  /** Acción del backstage: el evento abierto, con la etiqueta de NEXT_ACTIONS. */
  function runAction(action, opts = {}) {
    return transitionEvent(selectedEventData, action, opts);
  }

  /** Acción de la tarjeta de la franja: la tarjeta es panel de control, así que
      ofrece el ciclo de vida completo (publicar, abrir puertas, finalizar,
      cancelar) sin tener que entrar al backstage. */
  function quickTransition(ev, action) {
    return transitionEvent(ev, action, { fromStrip: true });
  }

  function startEditEvent() {
    const ev = selectedEventData;
    const tz = eventZone(ev);
    setEditError("");
    setEditingEvent({
      name: ev.name ?? "",
      description: ev.description ?? "",
      flyer_url: ev.flyer_url ?? "",
      location: ev.location ?? "",
      starts_at: toZonedInput(ev.starts_at, tz),
      ends_at: toZonedInput(ev.ends_at, tz),
      capacity: String(ev.capacity),
      qr_unlock_minutes: String(ev.qr_unlock_minutes ?? 60),
      // Ficha (mig 043): categoría elegida + datos que pregunta la puerta.
      category: ev.category ?? "",
      min_age: ev.min_age != null ? String(ev.min_age) : "",
      dress_code: ev.dress_code ?? "",
      doors_open_at: toZonedInput(ev.doors_open_at, tz),
      // Identidad pública (mig 057): video opcional, mapa confirmado y
      // contacto propio del evento (si falta, la ficha usa el del local).
      video_url: ev.video_url ?? "",
      location_url: ev.location_url ?? "",
      contact_name: ev.contact_name ?? "",
      contact_phone: ev.contact_phone ?? "",
    });
  }

  /** Sube el afiche desde el editor con el mismo endpoint de medios que usa
   *  el alta. El navegador reduce la imagen; el backend valida mime y tamaño. */
  async function uploadEditFlyer(file) {
    if (!file || !editingEvent) return;
    setEditError("");
    setUploadingFlyer(true);
    try {
      const dataUrl = await fileToDataUrl(file);
      const res = await apiFetch(`/venues/${venueId}/media`, {
        method: "POST",
        body: JSON.stringify({ data_url: dataUrl }),
      });
      setEditingEvent((ev) => (ev ? { ...ev, flyer_url: res.url } : ev));
      setBadFlyers((m) => ({ ...m, [res.url]: false }));
      ui.success("Afiche listo");
    } catch (err) {
      setEditError(err.message);
    } finally {
      setUploadingFlyer(false);
    }
  }

  /** Vista previa con los valores del formulario, sin esperar a guardar. */
  function openEventPreview() {
    if (!editingEvent || !selectedEventData) return;
    const tz = eventZone(selectedEventData);
    setPreviewEvent({
      ...selectedEventData,
      name: editingEvent.name.trim() || selectedEventData.name,
      description: editingEvent.description.trim() || null,
      flyer_url: editingEvent.flyer_url.trim() || null,
      video_url: editingEvent.video_url.trim() || null,
      location: editingEvent.location.trim() || null,
      location_url: editingEvent.location_url.trim() || null,
      contact_name: editingEvent.contact_name.trim() || null,
      contact_phone: editingEvent.contact_phone.trim() || null,
      category: editingEvent.category || selectedEventData.category,
      starts_at:
        fromZonedInput(editingEvent.starts_at, tz) ||
        selectedEventData.starts_at,
      doors_open_at:
        fromZonedInput(editingEvent.doors_open_at, tz) || null,
      min_age:
        editingEvent.min_age === "" ? null : Number(editingEvent.min_age),
      dress_code: editingEvent.dress_code.trim() || null,
    });
  }

  async function saveEventEdit(e) {
    e.preventDefault();
    setEditError("");

    const tz = eventZone(selectedEventData);
    const startsIso = fromZonedInput(editingEvent.starts_at, tz);
    const startsAt = startsIso ? new Date(startsIso) : null;
    if (!startsAt || Number.isNaN(startsAt.getTime())) {
      setEditError("Elige una fecha y hora de apertura valida.");
      return;
    }
    const endsIso = editingEvent.ends_at
      ? fromZonedInput(editingEvent.ends_at, tz)
      : null;
    const endsAt = endsIso ? new Date(endsIso) : null;
    if (editingEvent.ends_at && !endsAt) {
      setEditError("La fecha de cierre no es valida.");
      return;
    }
    if (endsAt && endsAt <= startsAt) {
      setEditError("El cierre debe ser posterior a la apertura.");
      return;
    }
    const doorsIso = editingEvent.doors_open_at
      ? fromZonedInput(editingEvent.doors_open_at, tz)
      : null;
    const capacity = Number(editingEvent.capacity);
    if (!Number.isInteger(capacity) || capacity < 1) {
      setEditError("El aforo debe ser un entero mayor que cero.");
      return;
    }

    setSavingEdit(true);
    try {
      const updated = await apiFetch(
        `/venues/${venueId}/events/${selectedEvent}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            name: editingEvent.name.trim(),
            capacity,
            qr_unlock_minutes: Number(editingEvent.qr_unlock_minutes),
            starts_at: startsIso,
            ends_at: endsIso,
            description: editingEvent.description.trim() || null,
            flyer_url: editingEvent.flyer_url.trim() || null,
            location: editingEvent.location.trim() || null,
            // Ficha (mig 043). category="" limpia la elección (el catálogo
            // vuelve a inferirla del texto).
            category: editingEvent.category || "",
            min_age: editingEvent.min_age === "" ? null : Number(editingEvent.min_age),
            dress_code: editingEvent.dress_code.trim() || null,
            doors_open_at: doorsIso,
            // Identidad pública (mig 057). "" limpia: el video/mapa
            // desaparecen de la ficha y el contacto cae al del local.
            video_url: editingEvent.video_url.trim() || null,
            location_url: editingEvent.location_url.trim() || null,
            contact_name: editingEvent.contact_name.trim() || null,
            contact_phone: editingEvent.contact_phone.trim() || null,
          }),
        },
      );
      setEvents((evs) => evs.map((x) => (x.id === updated.id ? updated : x)));
      setEditingEvent(null);
      ui.success("Cambios guardados");
    } catch (err) {
      setEditError(err.message);
    } finally {
      setSavingEdit(false);
    }
  }

  /**
   * Elimina un evento desde donde se dispare: la lista (tarjeta/fila) o el
   * backstage. El backend exige el nombre exacto como confirmación y solo lo
   * permite en borrador o sin boletas emitidas: aquí solo traducimos.
   */
  async function deleteEvent(ev) {
    if (!ev) return;
    const confirm = await ui.prompt(`Eliminar "${ev.name}"`, {
      message:
        "Se borran también sus tipos, cupos, boletas y pagos. Esta acción no tiene deshacer.\nEscribe el nombre del evento para confirmar:",
      placeholder: ev.name,
      danger: true,
      confirmLabel: "Eliminar definitivamente",
    });
    if (confirm === null) return;
    setError("");
    try {
      await apiFetch(`/venues/${venueId}/events/${ev.id}`, {
        method: "DELETE",
        body: JSON.stringify({ confirm }),
      });
      // Si el evento borrado era el que estaba abierto, salir del backstage
      // (sin tocar la URL si se borró desde la lista: ahí no hay ?event=).
      if (selectedEvent === ev.id) {
        setSelectedEvent(null);
        setSearchParams({});
      }
      await loadEvents();
      ui.success("Evento eliminado");
    } catch (err) {
      setError(err.message);
    }
  }

  function deleteSelectedEvent() {
    return deleteEvent(selectedEventData);
  }

  const selectedEventData = (events ?? []).find(
    (ev) => ev.id === selectedEvent,
  );
  const actions = selectedEventData
    ? (NEXT_ACTIONS[selectedEventData.status] ?? [])
    : [];

  useEffect(() => {
    setBreadcrumb(selectedEventData?.name ?? "");
    return () => setBreadcrumb("");
  }, [selectedEventData?.name, setBreadcrumb]);
  const editable =
    selectedEventData &&
    ["draft", "published"].includes(selectedEventData.status);

  // Auto-refresh en puerta (live): el reporte cambia con los escaneos de la
  // puerta, así que el admin no debería tener que recargar para ver el aforo.
  // El hook pausa el intervalo con la pestaña oculta y refresca al volver.
  const isLive = selectedEventData?.status === "live";
  const lastUpdated = useLiveRefresh(refreshEventData, isLive);

  // Píldora de turno (tanda 3): quién está en puerta AHORA y si su escáner
  // está activo. Se pide con el resto de los datos del evento; si el endpoint
  // falla, la píldora simplemente no aparece (es información, no control).
  const [preflight, setPreflight] = useState(null);
  useEffect(() => {
    if (!selectedEvent) {
      setPreflight(null);
      return;
    }
    apiFetch(`/venues/${venueId}/events/${selectedEvent}/preflight`)
      .then(setPreflight)
      .catch(() => setPreflight(null));
  }, [selectedEvent, venueId]);

  // Cierre de noche (tanda 3): el botón aparece en el backstage; si el evento
  // tiene boletas o escaneos, hay algo que cerrar. Fallar la descarga no
  // rompe el panel: el CSV se puede reintentar.
  const closing = !!selectedEventData;
  async function closeNight() {
    setError("");
    try {
      const token = getToken();
      const res = await fetch(
        `/api/venues/${venueId}/events/${selectedEvent}/closing.csv`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {} },
      );
      if (!res.ok) throw new Error("No se pudo exportar el cierre");
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `cierre-evento-${selectedEvent}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      ui.success("Cierre descargado");
    } catch (err) {
      setError(err.message);
    }
  }

  // Caja con rango: el cierre por defecto es "todo el evento"; el contador a
  // veces quiere solo un periodo (p.ej. los dias 1-15). El rango se pasa como
  // fechas sueltas; el backend las ancla a la zona del evento.
  async function closeCaja() {
    setError("");
    setCajaBusy(true);
    try {
      const token = getToken();
      const qs = new URLSearchParams();
      if (cajaRange.desde) qs.set("since", cajaRange.desde);
      // El API cierra el rango en forma semiabierta [since, until), pero el
      // input "Hasta" es inclusivo: si el contador elige el 15, quiere TODO
      // el 15. Mandamos el dia siguiente (en UTC, solo aritmetica de fecha).
      if (cajaRange.hasta) {
        const next = new Date(`${cajaRange.hasta}T00:00:00Z`);
        next.setUTCDate(next.getUTCDate() + 1);
        qs.set("until", next.toISOString().slice(0, 10));
      }
      const suffix = qs.toString() ? `?${qs}` : "";
      const res = await fetch(
        `/api/venues/${venueId}/events/${selectedEvent}/summary.csv${suffix}`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {} },
      );
      if (!res.ok) throw new Error("No se pudo exportar la caja");
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `caja-evento-${selectedEvent}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      ui.success("Caja descargada");
    } catch (err) {
      setError(err.message);
    } finally {
      setCajaBusy(false);
    }
  }

  const renderCard = (ev) => (
    <AdminEventCard
      key={ev.id}
      ev={ev}
      stat={ticketCounts[String(ev.id)] ?? ticketCounts[ev.id]}
      actions={NEXT_ACTIONS[ev.status] ?? []}
      onAction={quickTransition}
      busyAction={busyAction}
      onOpen={() => haptics.tick()}
      onDelete={deleteEvent}
      canDelete={canDeleteEvent(ev)}
    />
  );

  if (!venueId) {
    return (
      <div className="card p-6 text-center text-zinc-400">
        No tienes venues asociadas. Habla con un super admin.
      </div>
    );
  }

  // Enlaces viejos: las secciones del negocio eran pestañas de esta pantalla
  // (/admin?tab=equipo). Ahora viven en Reportes u Organización. Sin evento
  // abierto, se redirige a la sección equivalente para no romper enlaces.
  if (!urlEvent && VENUE_TABS.includes(urlTab)) {
    let target = "/admin/reportes";
    if (urlTab === "equipo" || urlTab === "invitaciones") {
      target = `/admin/organizacion?tab=${urlTab}`;
    } else if (urlTab === "puerta" || urlTab === "promotores") {
      target = "/admin/reportes?tab=resultados";
    } else if (urlTab === "cobros" || urlTab === "liquidaciones") {
      target = "/admin/reportes?tab=ventas";
    }
    return <Navigate to={target} replace />;
  }

  return (
    <PullToRefresh onRefresh={reloadAll}>
      <div className="reveal space-y-5">
        {/* En móvil: invita a instalar la PWA (se oculta sola si ya está instalada) */}
        <InstallPrompt />
        {/* Guía del admin primerizo: acompaña hasta que el PRIMER evento está
          realmente a la venta. Primero se OFRECE (opt-in): el admin decide si
          la quiere o la hace por su cuenta, y su elección se recuerda por
          usuario y negocio (en el servidor). Cuando está oculta queda "Primeros
          pasos" para volver a abrirla — nunca es irreversible.

          Vive SOLO en modo lista: dentro del backstage de un evento la guía no
          tiene nada que hacer y tapaba la pantalla de trabajo. */}
        {/* =================================================================
            MODO LISTA: sin evento abierto. El mapa de la operación. Aquí es
            el único lugar donde existen "todos los eventos": se elige uno y
            se ENTRA — el backstage no comparte pantalla con la lista.
            ================================================================= */}
        {!selectedEventData && (
          <>
            <div className="admin-events">
              <header className="admin-page-head">
                <div>
                  <p className="eyebrow">Operación</p>
                  <h1>Eventos</h1>
                  <p>
                    Crea, publica y opera tus noches. Abre una para montar
                    boletas, equipo y puerta.
                  </p>
                </div>
              </header>
              <VenueHeader venueId={venueId} user={user} compact />

              {error && (
                <div className="admin-error" role="alert">
                  {error}
                </div>
              )}

              {showOnboardingInvite && (
                <OnboardingChecklist
                  mode="invite"
                  onAccept={startTour}
                  onDismiss={() => decideOnboarding("dismissed")}
                />
              )}
              {showOnboardingChecklist && (
                <OnboardingChecklist
                  mode="checklist"
                  hasEvent={events.length > 0}
                  hasTypes={types.length > 0}
                  hasAllocations={allocations.length > 0}
                  isPublished={events.some((e) => e.status !== "draft")}
                  onStart={() => setCreateOpen(true)}
                  onGo={onboardingGo}
                  onTour={startTour}
                  onDismiss={() => decideOnboarding("dismissed")}
                  onComplete={() => decideOnboarding("completed")}
                />
              )}
              {showOnboardingResume && (
                <OnboardingResume
                  onRestart={() => decideOnboarding("accepted")}
                  onTour={startTour}
                />
              )}

              <div className="admin-toolbar">
                <div className="admin-search">
                  <Icon name="search" aria-hidden="true" />
                  <input
                    value={eventQuery}
                    onChange={(e) => setEventQuery(e.target.value)}
                    placeholder="Buscar evento…"
                    aria-label="Buscar evento por nombre"
                  />
                </div>
                <button
                  type="button"
                  className={`admin-filter-btn ${activeFilterCount ? "has-filter" : ""}`}
                  aria-expanded={filtersOpen}
                  aria-controls="admin-filters"
                  onClick={() => setFiltersOpen((v) => !v)}
                >
                  <Icon name="filter" className="h-3.5 w-3.5" />
                  Filtros
                  {activeFilterCount > 0 && (
                    <span className="admin-filter-count">{activeFilterCount}</span>
                  )}
                </button>
                <button
                  type="button"
                  className="admin-create-btn"
                  data-tour="nuevo-evento"
                  onClick={() => {
                    haptics.tick();
                    setCreateOpen(true);
                  }}
                >
                  <Icon name="plus" className="h-4 w-4" />
                  Crear evento
                </button>
              </div>

              {filtersOpen && (
                <div
                  id="admin-filters"
                  className="admin-filter-panel"
                  role="group"
                  aria-label="Filtrar eventos por estado"
                >
                  {BUCKETS.map(([id, label]) => {
                    const n =
                      id === "todos"
                        ? events.length
                        : events.filter((ev) => ev.status === id).length;
                    return (
                      <button
                        key={id}
                        type="button"
                        aria-pressed={eventBucket === id}
                        onClick={() => {
                          setEventBucket(id);
                          if (id === "ended" || id === "cancelled") setHistoryOpen(true);
                        }}
                        className="admin-filter-chip"
                      >
                        {label} <span className="tnum">{n}</span>
                      </button>
                    );
                  })}
                  {eventBucket !== "todos" && (
                    <button
                      type="button"
                      className="admin-filter-clear"
                      onClick={() => setEventBucket("todos")}
                    >
                      Limpiar filtro
                    </button>
                  )}
                </div>
              )}

              {booting ? (
                <div className="admin-event-grid" aria-busy="true">
                  {[0, 1].map((i) => (
                    <div key={i} className="admin-event-card">
                      <div className="skeleton h-full min-h-[160px]" />
                      <div className="space-y-3 p-4">
                        <div className="skeleton h-3 w-24" />
                        <div className="skeleton h-5 w-3/4" />
                        <div className="skeleton h-3 w-full" />
                        <div className="skeleton h-8 w-2/3" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : events.length === 0 ? (
                <section data-tour="eventos">
                  <div className="admin-empty">
                    <span className="grid h-12 w-12 place-items-center rounded-full bg-[var(--admin-accent-soft)] text-[var(--admin-accent-ink)]">
                      <Icon name="ticket" className="h-5 w-5" />
                    </span>
                    <h2>Todavía no hay eventos</h2>
                    <p>
                      Crea tu primera noche. Nace en borrador para que montes
                      boletas, equipo y puerta antes de publicarla.
                    </p>
                    <button
                      type="button"
                      onClick={() => setCreateOpen(true)}
                      className="admin-create-btn mt-2"
                    >
                      <Icon name="plus" className="h-4 w-4" />
                      Crear mi primer evento
                    </button>
                  </div>
                </section>
              ) : q || eventBucket !== "todos" ? (
                <section className="admin-section" data-tour="eventos">
                  <div className="admin-section-head">
                    <h2>
                      {q ? `Resultados para “${eventQuery.trim()}”` : "Eventos filtrados"}
                    </h2>
                    <span className="admin-section-count">
                      {visibleEvents.length}{" "}
                      {visibleEvents.length === 1 ? "evento" : "eventos"}
                    </span>
                  </div>
                  {visibleEvents.length === 0 ? (
                    <div className="admin-empty">
                      <h2>No hay eventos en este estado</h2>
                      <p>
                        {q
                          ? "Ningún evento coincide con la búsqueda."
                          : "Prueba con otro estado o vuelve a ver todos."}
                      </p>
                      <button
                        type="button"
                        className="admin-filter-clear"
                        onClick={() => {
                          setEventBucket("todos");
                          setEventQuery("");
                        }}
                      >
                        Ver todos
                      </button>
                    </div>
                  ) : (
                    <div className="admin-event-grid">
                      {sortEventList(visibleEvents).map(renderCard)}
                    </div>
                  )}
                </section>
              ) : (
                <div className="space-y-6" data-tour="eventos">
                  {liveEvents.length > 0 && (
                    <section className="admin-section">
                      <div className="admin-section-head">
                        <h2>En puerta</h2>
                        <span className="admin-live-badge">Ahora</span>
                        <span className="admin-section-count">
                          {liveEvents.length}{" "}
                          {liveEvents.length === 1 ? "noche" : "noches"}
                        </span>
                      </div>
                      <div className="admin-event-grid">
                        {liveEvents.map(renderCard)}
                      </div>
                    </section>
                  )}

                  {upcoming.length > 0 && (
                    <section className="admin-section">
                      <div className="admin-section-head">
                        <h2>Próximos eventos</h2>
                        <span className="admin-section-count">
                          {upcoming.length}{" "}
                          {upcoming.length === 1 ? "evento" : "eventos"}
                        </span>
                      </div>
                      <div className="admin-event-grid">
                        {upcoming.map(renderCard)}
                      </div>
                    </section>
                  )}

                  {drafts.length > 0 && (
                    <section className="admin-section">
                      <div className="admin-section-head">
                        <h2>Borradores</h2>
                        <span className="admin-section-count">
                          {drafts.length} por terminar
                        </span>
                      </div>
                      <div className="admin-event-grid">
                        {drafts.map(renderCard)}
                      </div>
                    </section>
                  )}

                  {liveEvents.length === 0 &&
                    upcoming.length === 0 &&
                    drafts.length === 0 && (
                      <div className="admin-empty">
                        <h2>No hay noches activas</h2>
                        <p>
                          Todo lo que existe ya pasó. Revisa el historial o crea
                          la próxima fecha.
                        </p>
                      </div>
                    )}

                  {history.length > 0 && (
                    <button
                      type="button"
                      className="admin-history-toggle"
                      aria-expanded={historyOpen}
                      onClick={() => setHistoryOpen((v) => !v)}
                    >
                      <span>
                        Ver historial · {history.length}{" "}
                        {history.length === 1 ? "evento" : "eventos"}
                      </span>
                      <Icon
                        name="back"
                        className={`h-4 w-4 transition ${historyOpen ? "rotate-90" : "-rotate-90"}`}
                      />
                    </button>
                  )}

                  {historyOpen && history.length > 0 && (
                    <section className="admin-section">
                      <div className="admin-section-head">
                        <h2>Historial</h2>
                        <span className="admin-section-count">
                          {history.length}{" "}
                          {history.length === 1 ? "evento" : "eventos"}
                        </span>
                      </div>
                      <div className="admin-event-grid">
                        {history.map(renderCard)}
                      </div>
                    </section>
                  )}
                </div>
              )}
            </div>

            {createOpen && (
              <EventCreateModal
                venueId={venueId}
                onClose={() => setCreateOpen(false)}
                onCreated={(ev) => {
                  setCreateOpen(false);
                  loadEvents().then(() => flyToEvent(ev.id, "ventas"));
                }}
              />
            )}
          </>
        )}

        {qrTesterOpen && (
          <QrTesterModal onClose={() => setQrTesterOpen(false)} />
        )}

        {previewEvent && (
          <EventPublicPreview
            event={previewEvent}
            ticketTypes={types}
            onClose={() => setPreviewEvent(null)}
          />
        )}

        {/* Enlace viejo o evento borrado: pantalla honesta, no un limbo */}
        {selectedEvent && !selectedEventData && (
          <EventNotFound onBack={() => setSearchParams({})} />
        )}        {selectedEvent && selectedEventData && (
          <>
            {/* Backstage del evento: identidad, pulso y ciclo de vida */}
            <EventWorkbench
              ev={selectedEventData}
              report={report}
              tab={section}
              onTab={setSection}
              actions={actions}
              onAction={runAction}
              busyAction={busyAction}
              isLive={isLive}
              lastUpdated={lastUpdated}
              onEdit={startEditEvent}
              editable={editable}
              onDelete={deleteSelectedEvent}
              onDuplicate={() => duplicateEvent(selectedEventData)}
              canDelete={canDeleteEvent(selectedEventData)}
              onExit={() => setSearchParams({})}
              preflight={preflight}
            />

            {/* Edición del evento (draft/published) */}
            {editingEvent && editable && (
              <form onSubmit={saveEventEdit} className="card p-5">
                <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="display text-base">Editar evento</h3>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={openEventPreview}
                      className="btn-ghost !px-3 !py-1.5 text-2xs font-bold"
                    >
                      <Icon name="eye" className="h-3.5 w-3.5" />
                      Vista previa móvil
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingEvent(null)}
                      className="text-xs font-semibold text-zinc-400 transition hover:text-zinc-200"
                    >
                      Cerrar
                    </button>
                  </div>
                </div>
                <p className="mb-4 text-xs text-zinc-500">
                  El aforo no puede bajar de las boletas ya emitidas ni la
                  apertura moverse al pasado.
                </p>

                <div className="grid gap-3.5 sm:grid-cols-2">
                  <label className="sm:col-span-full">
                    <span className="mb-1 block text-xs font-medium text-zinc-400">
                      Nombre *
                    </span>
                    <input
                      value={editingEvent.name}
                      onChange={(e) =>
                        setEditingEvent({
                          ...editingEvent,
                          name: e.target.value,
                        })
                      }
                      className="field"
                      maxLength={200}
                      required
                    />
                  </label>

                  <label>
                    <span className="mb-1 block text-xs font-medium text-zinc-400">
                      Apertura *
                    </span>
                    <input
                      type="datetime-local"
                      value={editingEvent.starts_at}
                      onChange={(e) =>
                        setEditingEvent({
                          ...editingEvent,
                          starts_at: e.target.value,
                        })
                      }
                      className="field"
                      required
                    />
                  </label>

                  <label>
                    <span className="mb-1 block text-xs font-medium text-zinc-400">
                      Cierre
                    </span>
                    <input
                      type="datetime-local"
                      value={editingEvent.ends_at}
                      onChange={(e) =>
                        setEditingEvent({
                          ...editingEvent,
                          ends_at: e.target.value,
                        })
                      }
                      className="field"
                    />
                  </label>

                  <label>
                    <span className="mb-1 block text-xs font-medium text-zinc-400">
                      QR se activa (min antes)
                    </span>
                    <input
                      type="number"
                      value={editingEvent.qr_unlock_minutes}
                      onChange={(e) =>
                        setEditingEvent({
                          ...editingEvent,
                          qr_unlock_minutes: e.target.value,
                        })
                      }
                      className="field"
                      min="0"
                      required
                    />
                  </label>

                  <label>
                    <span className="mb-1 block text-xs font-medium text-zinc-400">
                      Aforo *
                    </span>
                    <input
                      type="number"
                      value={editingEvent.capacity}
                      onChange={(e) =>
                        setEditingEvent({
                          ...editingEvent,
                          capacity: e.target.value,
                        })
                      }
                      className="field"
                      min="1"
                      required
                    />
                  </label>

                  <div>
                    <span className="mb-1 block text-xs font-medium text-zinc-400">
                      Afiche del evento
                    </span>
                    <div className="flex items-start gap-3">
                      {editingEvent.flyer_url &&
                      !badFlyers[editingEvent.flyer_url] ? (
                        <img
                          src={editingEvent.flyer_url}
                          alt="Afiche actual"
                          onError={() =>
                            setBadFlyers((m) => ({
                              ...m,
                              [editingEvent.flyer_url]: true,
                            }))
                          }
                          decoding="async"
                          className="h-16 w-16 shrink-0 rounded-xl object-cover ring-1 ring-zinc-700"
                        />
                      ) : (
                        <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-xl bg-zinc-800 text-zinc-600">
                          <Icon name="camera" className="h-5 w-5" />
                        </span>
                      )}
                      <div className="min-w-0 flex-1">
                        <input
                          type="url"
                          value={editingEvent.flyer_url}
                          onChange={(e) =>
                            setEditingEvent({
                              ...editingEvent,
                              flyer_url: e.target.value,
                            })
                          }
                          className="field"
                          placeholder="https://…/flyer.jpg"
                          aria-label="Enlace del afiche"
                        />
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={() => flyerInputRef.current?.click()}
                            disabled={uploadingFlyer}
                            className="btn-ghost !px-3 !py-1.5 text-2xs font-bold"
                          >
                            {uploadingFlyer ? "Subiendo…" : "Subir afiche"}
                          </button>
                          <input
                            ref={flyerInputRef}
                            type="file"
                            accept="image/jpeg,image/png,image/webp"
                            className="hidden"
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              e.target.value = "";
                              uploadEditFlyer(file);
                            }}
                          />
                          {editingEvent.flyer_url && (
                            <button
                              type="button"
                              onClick={() =>
                                setEditingEvent({
                                  ...editingEvent,
                                  flyer_url: "",
                                })
                              }
                              className="text-2xs font-semibold text-zinc-500 transition hover:text-red-400"
                            >
                              Quitar
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                    <span className="mt-1 block text-xs text-zinc-500">
                      Es la portada pública. Se muestra completa, sin recortar
                      el texto de los bordes. También puedes pegar un enlace.
                    </span>
                  </div>

                  <label>
                    <span className="mb-1 block text-xs font-medium text-zinc-400">
                      Video (URL)
                    </span>
                    <input
                      type="url"
                      value={editingEvent.video_url}
                      onChange={(e) =>
                        setEditingEvent({
                          ...editingEvent,
                          video_url: e.target.value,
                        })
                      }
                      className="field"
                      placeholder="https://…/video.mp4"
                      maxLength={2000}
                    />
                    <span className="mt-1 block text-xs text-zinc-500">
                      Opcional. Enlace público MP4 o WebM; se reproduce dentro
                      de la ficha y empieza sin sonido. Enty no aloja videos:
                      usa un enlace de tu hosting.
                    </span>
                  </label>

                  <label>
                    <span className="mb-1 block text-xs font-medium text-zinc-400">
                      Enlace de mapa (URL)
                    </span>
                    <input
                      type="url"
                      value={editingEvent.location_url}
                      onChange={(e) =>
                        setEditingEvent({
                          ...editingEvent,
                          location_url: e.target.value,
                        })
                      }
                      className="field"
                      placeholder="https://maps.google.com/…"
                      maxLength={2000}
                    />
                    <span className="mt-1 block text-xs text-zinc-500">
                      Solo se muestra "Cómo llegar" si pegas un enlace
                      confirmado.
                    </span>
                  </label>

                  <label>
                    <span className="mb-1 block text-xs font-medium text-zinc-400">
                      Lugar
                    </span>
                    <input
                      value={editingEvent.location}
                      onChange={(e) =>
                        setEditingEvent({
                          ...editingEvent,
                          location: e.target.value,
                        })
                      }
                      className="field"
                      placeholder="Calle 45 #12-30"
                      maxLength={200}
                    />
                  </label>

                  <label className="sm:col-span-full">
                    <span className="mb-1 block text-xs font-medium text-zinc-400">
                      Descripción
                    </span>
                    <textarea
                      value={editingEvent.description}
                      onChange={(e) =>
                        setEditingEvent({
                          ...editingEvent,
                          description: e.target.value,
                        })
                      }
                      className="field"
                      rows={2}
                      maxLength={2000}
                    />
                  </label>

                  {/* Ficha del evento (mig 043): lo que el invitado pregunta
                      en la puerta. Categoría, edad mínima, dress code y a qué
                      hora abren puertas. */}
                  <label>
                    <span className="mb-1 block text-xs font-medium text-zinc-400">
                      Categoría
                    </span>
                    <select
                      value={editingEvent.category}
                      onChange={(e) =>
                        setEditingEvent({
                          ...editingEvent,
                          category: e.target.value,
                        })
                      }
                      className="field"
                    >
                      <option value="">Sin categoría (automática)</option>
                      {EVENT_CATEGORIES.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label>
                    <span className="mb-1 block text-xs font-medium text-zinc-400">
                      Edad mínima
                    </span>
                    <input
                      type="number"
                      value={editingEvent.min_age}
                      onChange={(e) =>
                        setEditingEvent({
                          ...editingEvent,
                          min_age: e.target.value,
                        })
                      }
                      className="field"
                      min="0"
                      max="99"
                      placeholder="Sin restricción"
                    />
                  </label>

                  <label>
                    <span className="mb-1 block text-xs font-medium text-zinc-400">
                      Dress code
                    </span>
                    <input
                      value={editingEvent.dress_code}
                      onChange={(e) =>
                        setEditingEvent({
                          ...editingEvent,
                          dress_code: e.target.value,
                        })
                      }
                      className="field"
                      placeholder="Elegante, casual…"
                      maxLength={200}
                    />
                  </label>

                  <label>
                    <span className="mb-1 block text-xs font-medium text-zinc-400">
                      Apertura de puertas
                    </span>
                    <input
                      type="datetime-local"
                      value={editingEvent.doors_open_at}
                      onChange={(e) =>
                        setEditingEvent({
                          ...editingEvent,
                          doors_open_at: e.target.value,
                        })
                      }
                      className="field"
                    />
                  </label>

                  <label>
                    <span className="mb-1 block text-xs font-medium text-zinc-400">
                      Contacto del evento (nombre)
                    </span>
                    <input
                      value={editingEvent.contact_name}
                      onChange={(e) =>
                        setEditingEvent({
                          ...editingEvent,
                          contact_name: e.target.value,
                        })
                      }
                      className="field"
                      placeholder="Productora Norte"
                      maxLength={120}
                    />
                  </label>

                  <label>
                    <span className="mb-1 block text-xs font-medium text-zinc-400">
                      WhatsApp del evento
                    </span>
                    <input
                      type="tel"
                      value={editingEvent.contact_phone}
                      onChange={(e) =>
                        setEditingEvent({
                          ...editingEvent,
                          contact_phone: e.target.value,
                        })
                      }
                      className="field"
                      placeholder="573001112233"
                      maxLength={40}
                    />
                    <span className="mt-1 block text-xs text-zinc-500">
                      Si lo dejas vacío, la ficha usa el contacto del local.
                    </span>
                  </label>
                </div>

                {editError && (
                  <p className="mt-3 text-xs text-red-400">{editError}</p>
                )}

                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <button type="submit" className="btn-primary" disabled={savingEdit}>
                    {savingEdit ? "Guardando" : "Guardar cambios"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingEvent(null)}
                    className="btn-ghost text-sm font-bold"
                  >
                    Cancelar
                  </button>
                  {editingEvent.flyer_url &&
                    !badFlyers[editingEvent.flyer_url] && (
                      <img
                        src={editingEvent.flyer_url}
                        alt="Previsualización del flyer"
                        onError={() =>
                          setBadFlyers((m) => ({
                            ...m,
                            [editingEvent.flyer_url]: true,
                          }))
                        }
                        decoding="async"
                        className="h-12 w-12 rounded-lg object-cover ring-1 ring-zinc-700"
                      />
                    )}
                </div>
              </form>
            )}

            {/* ====== Pestañas dentro del backstage ====== */}
            <div
              id="evx-tab-panel"
              role="tabpanel"
              aria-labelledby={`evx-tab-${section}`}
              tabIndex={0}
            >
            <AdminEventWorkspace
              ev={selectedEventData}
              section={section}
              report={report}
              types={types}
              allocations={allocations}
              users={users}
              preflight={preflight}
              isLive={isLive}
              actions={actions}
              busyAction={busyAction}
              onAction={runAction}
              onSection={setSection}
              onEdit={startEditEvent}
              editable={editable}
              venueId={venueId}
              eventId={selectedEvent}
              onChanged={refreshEventData}
              onError={setError}
              onQrTest={() => setQrTesterOpen(true)}
              closing={closing}
              onCloseNight={closeNight}
              onCloseCaja={closeCaja}
              cajaRange={cajaRange}
              setCajaRange={setCajaRange}
              cajaBusy={cajaBusy}
              lastUpdated={lastUpdated}
            />
            </div>
          </>
        )}
        {/* Tutorial guiado: se monta al final para quedar por encima de todo
          el panel (no dentro de un card, que lo recortaría). */}
        {tourOpen && (
          <OnboardingTour
            steps={ONBOARDING_STEPS}
            step={prefs[PREF_TUTORIAL]?.step ?? 0}
            onStep={onTourStep}
            onExit={exitTour}
            onFinish={finishTour}
          />
        )}
      </div>
    </PullToRefresh>
  );
}
