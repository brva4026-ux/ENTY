import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { apiFetch, publicTicketPageUrl } from "../lib/api";
import ContactEditsHistory from "../components/ContactEditsHistory";
import { useAuth } from "../lib/auth";
import { useLiveRefresh } from "../lib/useLiveRefresh";
import { haptics } from "../lib/haptics";
import ReportWidget from "../components/ReportWidget";
import DoorPulse from "../components/DoorPulse";
import { LiveIndicator, QuotaMeter } from "../components/Brand";
import { STATUS_META as EV_CHIP } from "../components/EventWorkbench";
import { PullToRefresh } from "../components/PullToRefresh";
import { InstallPrompt } from "../components/InstallPrompt";
import {
  ListSkeleton,
  SelectSkeleton,
  Skeleton,
  StatSkeletonRow,
} from "../components/Skeleton";
import { useUI } from "../lib/ui";
import { activeVenueId } from "../lib/venue";
import { money, currentYM } from "../lib/format";
import CountUpNumber from "../components/CountUpNumber";
import EmptyState from "../components/EmptyState";
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
import EventWorkbench, {
  EventNotFound,
  sortEventsForStrip,
} from "../components/EventWorkbench";
import Icon from "../components/Icon";
import { Star4, Bolt, RibbonDivider } from "../components/Doodles";
import TeamManager from "../components/TeamManager";
import InvitationsManager from "../components/InvitationsManager";
import PayoutsManager from "../components/PayoutsManager";
import TypeManager from "../components/TypeManager";
import AllocationManager from "../components/AllocationManager";
import TicketList from "../components/TicketList";
import EventTeamPanel from "../components/EventTeamPanel";
import EventCreateModal from "../components/EventCreateModal";
import QrTesterModal from "../components/QrTesterModal";
import BusinessOverview from "../components/BusinessOverview";
import DoorSection from "../components/DoorSection";
import PromotersSection from "../components/PromotersSection";
import BusinessDock from "../components/BusinessDock";
import PaymentsPanel from "../components/PaymentsPanel";
import VenueHeader from "../components/VenueHeader";
import useDocumentTitle from "../lib/useDocumentTitle";
import TransitionLink from "../components/TransitionLink";

function firstVenueId(user) {
  // Multi-negocio: la activa se elige en /perfil y persiste (tf_venue);
  // sin elección, la primera disponible (comportamiento de siempre).
  return activeVenueId(user);
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** Date -> valor para <input type="datetime-local"> (hora LOCAL, sin zona). */
function toLocalInput(date) {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    `T${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  );
}

/** Fecha corta para la franja de eventos (los chips no dan para más). */
function formatShortDate(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("es-CO", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Minuto del día 0-1439 -> etiqueta "8 p.m." (para la píldora de apertura). */
function minuteLabel(mins) {
  const h24 = Math.floor(mins / 60);
  const m = mins % 60;
  const suf = h24 >= 12 ? "p.m." : "a.m.";
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return m ? `${h}:${String(m).padStart(2, "0")} ${suf}` : `${h} ${suf}`;
}

/** Diferencia de dias de CALENDARIO (no de 24h): un evento de hoy a las
    11 p.m. dista 0.9 dias de la medianoche y un round() lo mandaria a
    "mañana". Comparar año/mes/dia evita ese classico. */
function calendarDiffDays(a, b) {
  const ua = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const ub = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((ua - ub) / 86400000);
}

/** Píldora de apertura del evento: "Hoy 8 p.m." / "Vie 8 p.m." / pasado. */
function openingPill(startsAt) {
  if (!startsAt) return null;
  const d = new Date(startsAt);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  const mins = d.getHours() * 60 + d.getMinutes();
  const time = minuteLabel(mins);
  const diffDays = calendarDiffDays(d, now);
  if (diffDays === 0) return { main: `Hoy ${time}`, tone: "today" };
  if (diffDays === 1) return { main: `Mañana ${time}`, tone: "soon" };
  if (diffDays < 0)
    return {
      main: d.toLocaleDateString("es-CO", { day: "numeric", month: "short" }),
      tone: "past",
    };
  return {
    main: `${d.toLocaleDateString("es-CO", {
      weekday: "short",
    })} ${time}`,
    tone: diffDays <= 3 ? "soon" : "far",
  };
}

const NEXT_ACTIONS = {
  draft: [
    { action: "publish", label: "Publicar evento" },
    { action: "cancel", label: "Cancelar", danger: true },
  ],
  published: [
    { action: "live", label: "Abrir puertas" },
    { action: "cancel", label: "Cancelar evento", danger: true },
  ],
  live: [{ action: "end", label: "Finalizar evento" }],
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

/* Presentación de las acciones EN LA TARJETA: verbo corto + icono + color.
   El backstage usa las etiquetas largas de NEXT_ACTIONS; aquí el ancho es
   escaso y el verbo solo ("Publicar") ya dice todo. */
const STRIP_ACTION = {
  publish: { label: "Publicar", icon: "bolt", variant: "success" },
  live: { label: "Abrir puertas", icon: "door", variant: "success" },
  end: { label: "Finalizar", icon: "check", variant: "brand" },
  reopen: { label: "Reabrir", icon: "door", variant: "success" },
  cancel: { label: "Cancelar", icon: "close", variant: "danger" },
};

const ACTION_TIP = {
  publish: "Publicar evento (pasa a la venta)",
  live: "Abrir puertas (la puerta empieza a escanear)",
  end: "Finalizar evento (la puerta deja de escanear)",
  reopen: "Reabrir puertas (la puerta vuelve a escanear)",
  cancel: "Cancelar evento (las boletas dejan de ser válidas)",
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
  const venueId = firstVenueId(user);
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
  // tickets: el listado real vive en TicketList (server-driven, paginado).
  // El fetch que llenaba este estado quedó muerto: nadie lo lee. Solo setTickets
  // se usa para limpiar al cambiar de evento — por eso este useState se queda.
  const [tickets, setTickets] = useState([]);
  const [selectedEvent, setSelectedEvent] = useState(null);
  // Fuente de verdad de la URL: el evento abierto y su pestaña viven en
  // /admin?event=<id>&tab=<tab> — compartible, sobrevive recargas y back.
  const [searchParams, setSearchParams] = useSearchParams();
  const urlEvent = searchParams.get("event");
  const urlTab = searchParams.get("tab") || "resumen";
  const urlMonth = searchParams.get("mes"); // null = mes en curso
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
  // La pestaña activa es la de la URL (la mig 012 ya generaba ?tab=...);
  // whitelist para no renderizar una pestaña inventada por el usuario.
  const section = [
    "resumen",
    "entradas",
    "cupos",
    "boletas",
    "noche",
    "cobros",
    "negocio",
    "puerta",
    "promotores",
    "equipo",
    "liquidaciones",
    "invitaciones",
  ].includes(urlTab)
    ? urlTab
    : "resumen";

  // events === null significa "primera carga": se muestra skeleton en vez de
  // un vacío engañoso ("Aún no hay eventos") que no es verdad aún.
  const booting = events === null;

  // Franja de eventos: búsqueda por nombre y filtro por estado. Es client-side
  // a propósito: el catálogo ya vive en memoria y pedirlo al server por cada
  // tecla sería desperdicio (y más lento que filtrar 50 objetos).
  const [eventQuery, setEventQuery] = useState("");
  const [eventBucket, setEventBucket] = useState("todos");
  // Densidad de la franja: tarjetas (default) o lista compacta. Con 20+
  // eventos la grilla exige scroll infinito; la tabla responde de un vistazo.
  // Persistida: la preferencia de densidad es del usuario, no de la sesión.
  const [compactView, setCompactView] = useState(
    () => localStorage.getItem("tf_ev_compact") === "1",
  );
  useEffect(() => {
    localStorage.setItem("tf_ev_compact", compactView ? "1" : "0");
  }, [compactView]);
  // Id del evento duplicándose ahora (spinner in situ en SU tarjeta).
  const [dupingId, setDupingId] = useState(null);
  // Id del evento eliminándose ahora (spinner in situ en SU tarjeta/fila).
  const [deletingId, setDeletingId] = useState(null);
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
  const venueForTeam = realVenueId;
  const q = eventQuery.trim().toLowerCase();
  // Pulso operativo de la cabecera: cuántas noches están EN PUERTA ahora. Es
  // el único estado que exige atención en vivo, así que la cabecera lo dice
  // sin que el admin tenga que tocar el filtro "En puerta" para descubrirlo.
  const liveNow = (events ?? []).filter((ev) => ev.status === "live").length;
  const visibleEvents = (events ?? []).filter(
    (ev) =>
      (eventBucket === "todos" || ev.status === eventBucket) &&
      (!q || ev.name.toLowerCase().includes(q)),
  );

  // Onboarding del primer evento. El evento del onboarding es el BORRADOR más
  // cercano en el tiempo, no `events[0]`: la lista viene ordenada `starts_at
  // DESC`, así que `events[0]` es el evento con la fecha MÁS LEJANA del futuro.
  // Con ese criterio, publicar la fiesta de hoy y luego crear la del mes que
  // viene (borrador) reactivaba la guía que el admin ya había cerrado.
  //
  // Un borrador sin fecha no debería existir (el modal la exige), pero se
  // ordena igual para no depender de eso.
  const onboardingEvent = useMemo(() => {
    const drafts = (events ?? []).filter((e) => e.status === "draft");
    if (!drafts.length) return null;
    return [...drafts].sort((a, b) =>
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
  // Evento con la puerta abierta AHORA. Se deriva de la lista ya cargada (el
  // endpoint de eventos trae `status`), así que saber si hay noche en curso no
  // cuesta un request. Si hubiera más de uno (no debería), el primero.
  const liveEvent = (events || []).find((e) => e.status === "live") || null;
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
      if (wanted !== selectedEvent) setSelectedEvent(wanted); // Enlace viejo con pestaña de venue dentro de un evento
      // (?event=5&tab=equipo): esas pestañas no existen en el backstage —
      // se normaliza al evento sin tab (aterriza en Resumen).
      if (
        urlTab &&
        ["negocio", "equipo", "liquidaciones", "invitaciones"].includes(urlTab)
      ) {
        setSearchParams({ event: String(wanted) });
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
    } else if (
      events.length === 0 &&
      !createOpen &&
      // La guía manda mientras esté en pantalla: su CTA ("Crear evento") es el
      // camino, y abrir el modal por encima tapaba la invitación — el admin no
      // llegaba a decidir— o la propia guía si acababa de rechazarla.
      !showOnboardingInvite &&
      !showOnboardingChecklist &&
      !showOnboardingResume
    ) {
      // Venue nueva sin eventos y sin guía: la única acción posible es crear
      // el primero.
      setCreateOpen(true);
    }
    // selectedEvent a propósito fuera de las deps: esta pantalla solo sigue a
    // la URL y al catálogo, no re-detecciona en cada clic del selector.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, urlEvent, onboardingPref]);

  /** Navega al backstage de un evento (la URL es la fuente de verdad). */
  function flyToEvent(id, tab) {
    const params = new URLSearchParams();
    params.set("event", String(id));
    if (tab && tab !== "resumen") params.set("tab", tab);
    setSearchParams(params); // push: back vuelve al evento/tab anterior
  }

  /**
   * Mes del panel (portada + Reportes), en la URL para que un refresh o un
   * enlace compartido caigan en el mismo mes. `null` = mes en curso (se
   * omite el param, no se escribe "hoy": la URL queda limpia).
   */
  function setMonth(ym) {
    const params = new URLSearchParams(searchParams);
    // El mes en curso no se escribe: la URL queda limpia (?mes solo cuando
    // se navega al pasado/futuro). Se compara contra el mes del navegador —
    // el mismo valor de arranque que usa la cabecera para su flecha.
    if (ym && ym !== currentYM()) params.set("mes", ym);
    else params.delete("mes");
    setSearchParams(params, { replace: true });
  }

  /** Duplica un evento (borrador con sus tipos y cupos). */
  async function duplicateEvent(ev) {
    setDupingId(ev.id);
    try {
      const copy = await apiFetch(
        `/venues/${venueId}/events/${ev.id}/duplicate`,
        { method: "POST" },
      );
      await loadEvents();
      // NO se salta al backstage del borrador: con 20+ noches, duplicar una
      // tras otra y que cada clic te expulse de la lista rompe el flujo. El
      // borrador aparece arriba y el aviso dice que abrir.
      ui.success(`Borrador "${copy.name}" creado: ajustá la fecha y publicá 📋`);
    } catch (err) {
      setError(err.message);
    } finally {
      setDupingId(null);
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
    if (!venueId) return Promise.resolve();
    return apiFetch(`/venues/${realVenueId}/users?include_inactive=true`)
      .then(setUsers)
      .catch(() => setUsers([]));
  }, [venueId]);
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
  async function transitionEvent(ev, action, { fromStrip = false } = {}) {
    if (!ev) return;
    const busyKey = fromStrip ? `${action}-${ev.id}` : action;

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
          "Las boletas emitidas dejarán de ser válidas en la puerta y no se podrá revertir.",
        danger: true,
        confirmLabel: "Sí, cancelar evento",
      });
      if (!ok) return;
    }
    if (action === "end") {
      const ok = await ui.confirm("¿Finalizar el evento?", {
        message: "La puerta dejará de aceptar escaneos.",
        confirmLabel: "Finalizar",
      });
      if (!ok) return;
    }
    if (action === "publish") {
      const ok = await ui.confirm("¿Publicar el evento?", {
        message:
          "El evento pasa a la venta: los promotores pueden emitir boletas.",
        confirmLabel: "Publicar",
      });
      if (!ok) return;
    }
    if (action === "live") {
      const ok = await ui.confirm("¿Abrir puertas?", {
        message: "La puerta empieza a aceptar escaneos.",
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
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyAction("");
    }
  }

  /** Acción del backstage: el evento abierto, con la etiqueta de NEXT_ACTIONS. */
  function runAction(action) {
    return transitionEvent(selectedEventData, action);
  }

  /** Acción de la tarjeta de la franja: la tarjeta es panel de control, así que
      ofrece el ciclo de vida completo (publicar, abrir puertas, finalizar,
      cancelar) sin tener que entrar al backstage. */
  function quickTransition(ev, action) {
    return transitionEvent(ev, action, { fromStrip: true });
  }

  function startEditEvent() {
    const ev = selectedEventData;
    setEditError("");
    setEditingEvent({
      name: ev.name ?? "",
      description: ev.description ?? "",
      flyer_url: ev.flyer_url ?? "",
      location: ev.location ?? "",
      starts_at: toLocalInput(new Date(ev.starts_at)),
      ends_at: ev.ends_at ? toLocalInput(new Date(ev.ends_at)) : "",
      capacity: String(ev.capacity),
      qr_unlock_minutes: String(ev.qr_unlock_minutes ?? 60),
    });
  }

  async function saveEventEdit(e) {
    e.preventDefault();
    setEditError("");

    const startsAt = new Date(editingEvent.starts_at);
    if (Number.isNaN(startsAt.getTime())) {
      setEditError("Elige una fecha y hora de apertura valida.");
      return;
    }
    const endsAt = editingEvent.ends_at ? new Date(editingEvent.ends_at) : null;
    if (endsAt && Number.isNaN(endsAt.getTime())) {
      setEditError("La fecha de cierre no es valida.");
      return;
    }
    if (endsAt && endsAt <= startsAt) {
      setEditError("El cierre debe ser posterior a la apertura.");
      return;
    }
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
            starts_at: startsAt.toISOString(),
            ends_at: endsAt ? endsAt.toISOString() : null,
            description: editingEvent.description.trim() || null,
            flyer_url: editingEvent.flyer_url.trim() || null,
            location: editingEvent.location.trim() || null,
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
    setDeletingId(ev.id);
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
    } finally {
      setDeletingId(null);
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
      const token = localStorage.getItem("tf_token");
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
      const token = localStorage.getItem("tf_token");
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

  if (!venueId) {
    return (
      <div className="card p-6 text-center text-zinc-400">
        No tienes venues asociadas. Habla con un super admin.
      </div>
    );
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
        {!selectedEventData && showOnboardingInvite && (
          <OnboardingChecklist
            mode="invite"
            onAccept={startTour}
            onDismiss={() => decideOnboarding("dismissed")}
          />
        )}
        {!selectedEventData && showOnboardingChecklist && (
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
        {!selectedEventData && showOnboardingResume && (
          <OnboardingResume
            onRestart={() => decideOnboarding("accepted")}
            onTour={startTour}
          />
        )}{" "}
        {error && (
          <div className="rounded-xl border border-red-900 bg-red-950/60 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        )}
        {/* =================================================================
            MODO LISTA: sin evento abierto. El mapa de la operación. Aquí es
            el único lugar donde existen "todos los eventos": se elige uno y
            se ENTRA — el backstage no comparte pantalla con la lista.
            ================================================================= */}
        {!selectedEventData && (
          <>
            {/* PORTADA UNIFICADA: identidad + cifra del mes + eventos viven en
              el MISMO card. Antes eran dos boxes apiladas que competían por
              ser "la cabecera"; aquí hay una sola portada con una sola línea
              de lectura: quién eres → cuánto va el mes → tus noches. */}
            <VenueHeader
              venueId={venueId}
              user={user}
              month={urlMonth}
              onMonth={setMonth}
              liveEvent={liveEvent}
              liveCount={liveNow}
            >
              {/* PORTADA UNIFICADA: la franja de eventos vive DENTRO del card
                de la venue — un solo contexto como Del negocio, secciones
                separadas por hairline. Sin evento abierto no hay segundo
                bloque que compita por ser "la cabecera". */}
              {booting
                ? null
                : events.length > 0 && (
                    <>
                      {/* Cabecera de sección DENTRO de la portada: mismo
                        idioma del dock Del negocio (eyebrow + display + la
                        acción principal a la derecha, ENCIMA de la barra de
                        búsqueda). */}
                      <div className="evx-head doodle-host">
                        {/* Doodle de fiesta junto al titular (capa POP) */}
                        <Star4 className="-left-1 -top-1 h-3.5 w-3.5 text-[#00E6AB]" />
                        <div className="min-w-0">
                          <p className="eyebrow">Operación</p>
                          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                            <h2 className="display text-xl sm:text-2xl">
                              <span className="brush-mark">Eventos</span>
                            </h2>
                            <p className="text-xs text-zinc-500">
                              {events.length} noche{events.length === 1 ? "" : "s"} en el calendario
                              {liveNow > 0 && (
                                <>
                                  <span className="text-zinc-600"> · </span>
                                  <span className="evx-livepill">
                                    <span
                                      className="evx-livepill-dot"
                                      aria-hidden="true"
                                    />
                                    {liveNow} en puerta ahora
                                  </span>
                                </>
                              )}
                            </p>
                          </div>
                        </div>
                        {/* Nuevo evento: en móvil el verbo completo no entra sin
                            partirse en dos líneas y empujar el contador de la
                            franja; ahí queda el ícono solo (44x44, con
                            aria-label), que es el gesto que ya se reconoce. */}
                        <button
                          onClick={() => setCreateOpen(true)}
                          aria-label="Nuevo evento"
                          data-tip="Nuevo evento"
                          data-tour="nuevo-evento"
                          className="btn-primary evx-newbtn shrink-0"
                        >
                          <Icon name="plus" className="h-4 w-4" />
                          {/* El verbo aparece a 1024px, el mismo breakpoint
                              en que la barra vuelve a ser de una fila: antes
                              de eso el boton es solo el icono (CSS .evx-newbtn). */}
                          <span className="hidden lg:inline">
                            Nuevo evento
                          </span>
                        </button>
                      </div>
                      <div className="evx-toolbar">
                        {/* El buscador en su PROPIA fila en móvil. Antes
                            compartia fila con los filtros y terminaba con
                            54px de caja (40 de padding para la lupa): el
                            placeholder era invisible y la lupa se montaba
                            sobre la primera pestaña. Medido a 320/390/414px. */}
                        <div className="evx-search">
                          <Icon
                            name="search"
                            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500"
                          />
                          <input
                            value={eventQuery}
                            onChange={(e) => setEventQuery(e.target.value)}
                            placeholder="Buscar evento…"
                            aria-label="Buscar evento por nombre"
                            className="field !py-2 !pl-10 text-sm"
                          />
                        </div>
                        {/* Densidad: tarjetas para pocas noches, tabla de una línea
                    cuando la lista crece (20+ eventos no caben en grilla).
                    Comparte la fila del buscador, no la de los filtros: ahí
                    competía por el mismo ancho. */}
                        <button
                          onClick={() => {
                            haptics.tick();
                            setCompactView((v) => !v);
                          }}
                          aria-pressed={compactView}
                          aria-label={
                            compactView
                              ? "Cambiar a vista de tarjetas"
                              : "Cambiar a vista compacta"
                          }
                          data-tip={
                            compactView
                              ? "Ver como tarjetas"
                              : "Ver como lista compacta"
                          }
                          className="btn-mini btn-icon shrink-0"
                          data-variant="brand"
                        >
                          <Icon
                            name={compactView ? "calendar" : "list"}
                            className="h-3.5 w-3.5"
                          />
                        </button>
                        {/* Filtros como tabs de texto (no píldoras con borde):
                    el estado activo se dice con tinta, no con otra caja. En
                    móvil van en fila propia con scroll-snap: son 6 estados y
                    con el buscador al lado solo entraban 2 a la vista, sin
                    ninguna pista de que la fila scrolleara. La pista se pinta
                    con la mascara de desvanecido (solo en móvil, que es donde
                    hay algo que scrollear de verdad). */}
                        <div
                          className="evx-filters"
                          role="group"
                          aria-label="Filtrar eventos por estado"
                        >
                          <div className="no-scrollbar evx-filters-row">
                            {BUCKETS.map(([id, label]) => {
                              const n =
                                id === "todos"
                                  ? events.length
                                  : events.filter((ev) => ev.status === id)
                                      .length;
                              const active = eventBucket === id;
                              return (
                                <button
                                  key={id}
                                  aria-pressed={active}
                                  onClick={() => setEventBucket(id)}
                                  className={`evx-tab ${active ? "is-active" : ""}`}
                                >
                                  {label}
                                  {/* El contador solo existe si hay algo que
                                    contar: un span vacio dejaba el gap del
                                    flex puesto igual y la pestana quedaba ~5px
                                    mas ancha que las que no tienen numero. */}
                                  {n > 0 && (
                                    <span className="tnum evx-tab-count">
                                      {n}
                                    </span>
                                  )}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    </>
                  )}
              {booting ? (
                <SelectSkeleton className="max-w-xs" />
              ) : events.length > 0 ? (
                  <section className="events-strip" data-tour="eventos">
                    {visibleEvents.length === 0 ? (
                      /* El vacío dice la verdad del motivo: sin búsqueda, un
                         filtro de estado sin eventos NO es "no coincide una
                         búsqueda". Antes el texto mentía y encima no había
                         salida; aquí se ofrece volver a "Todos". */
                      <p className="mt-4 text-pretty text-sm text-zinc-500">
                        {q
                          ? "Ningún evento coincide con la búsqueda."
                          : "No hay eventos en este estado."}{" "}
                        {eventBucket !== "todos" && (
                          <button
                            onClick={() => setEventBucket("todos")}
                            className="font-semibold text-violet-300 underline-offset-2 hover:underline"
                          >
                            Ver todos
                          </button>
                        )}
                      </p>
                    ) : compactView ? (
                      /* VISTA COMPACTA: una línea por evento. Con 20+ noches la
                    grilla de tarjetas exige scroll infinito; la tabla responde
                    "cuál es la próxima y cómo va" de un vistazo. */
                      <ul className="evx-list">
                        {sortEventsForStrip(visibleEvents).map((ev) => {
                          const stat =
                            ticketCounts[String(ev.id)] ?? ticketCounts[ev.id];
                          const pill = openingPill(ev.starts_at);
                          const live = ev.status === "live";
                          return (
                            <li key={ev.id} className="evx-row">
                              <TransitionLink
                                to={`/admin?event=${ev.id}`}
                                onClick={() => haptics.tick()}
                                className="absolute inset-0"
                                aria-label={`Abrir ${ev.name}`}
                              />
                              <span className="evx-dot-wrap">
                                <span
                                  className="evx-dot"
                                  data-status={ev.status}
                                  aria-hidden="true"
                                />
                              </span>
                              <span className="evx-row-name truncate">
                                {ev.name}
                              </span>
                              {pill && (
                                <span className="evx-row-when">
                                  {pill.main}
                                </span>
                              )}
                              <span className="evx-row-nums tnum">
                                {stat
                                  ? `${money(stat.revenue_cents)} · ${stat.redeemed}/${stat.active}`
                                  : "…"}
                              </span>
                              {/* Salud de puerta: solo si hay duplicados. La
                                franja delata el QR reenviado sin abrir el
                                evento; un "0" permanente sería ruido. */}
                              {stat?.duplicates > 0 && (
                                <span
                                  className="evx-door-alert"
                                  data-tip={`${stat.duplicates} boleta(s) reescaneada(s): posible QR reenviado`}
                                >
                                  <Icon
                                    name="alert"
                                    className="h-3 w-3"
                                    aria-hidden="true"
                                  />
                                  <span className="tnum">{stat.duplicates}</span>
                                </span>
                              )}
                              <span
                                className={`evx-row-state ${live ? "is-live" : ""}`}
                              >
                                {(EV_CHIP[ev.status] ?? EV_CHIP.draft).label}
                              </span>
                              {/* Acciones de la fila: con 20+ noches la lista
                                compacta es la vista de trabajo, no un resumen
                                de solo lectura. Eliminar vive aquí para no
                                tener que abrir el backstage de cada evento. */}
                              {canDeleteEvent(ev) && (
                                <span className="evx-row-actions">
                                  <button
                                    onClick={() => deleteEvent(ev)}
                                    disabled={deletingId !== null}
                                    aria-label={`Eliminar ${ev.name}`}
                                    data-tip="Eliminar evento definitivamente"
                                    className="btn-mini btn-icon"
                                    data-variant="danger"
                                  >
                                    {deletingId === ev.id ? (
                                      <svg
                                        className="btn-spinner"
                                        viewBox="0 0 24 24"
                                        aria-hidden="true"
                                      >
                                        <circle cx="12" cy="12" r="9" />
                                      </svg>
                                    ) : (
                                      <Icon
                                        name="trash"
                                        className="h-3.5 w-3.5"
                                      />
                                    )}
                                  </button>
                                </span>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    ) : (
                      <div className="evx-grid">
                        {sortEventsForStrip(visibleEvents).map((ev) => {
                          // Mini-reporte del evento (vendidas · dentro · recaudo) del
                          // GET agregado. undefined = aún no llegó: la tarjeta degrada
                          // a la versión sin cifras sin parpadear.
                          const stat =
                            ticketCounts[String(ev.id)] ?? ticketCounts[ev.id];
                          const sold = stat?.active ?? null;
                          const pct =
                            sold !== null && ev.capacity > 0
                              ? Math.min(
                                  100,
                                  Math.round((sold / ev.capacity) * 100),
                                )
                              : null;
                          const pill = openingPill(ev.starts_at);
                          const live = ev.status === "live";
                          const ended = ["ended", "cancelled"].includes(
                            ev.status,
                          );
                          const hasFlyer =
                            ev.flyer_url && !badFlyers[ev.flyer_url];
                          // Iniciales del evento (fallback sin flyer): primera
                          // palabra completa + inicial de la segunda, max 2.
                          const initials = (ev.name || "?")
                            .split(/\s+/)
                            .slice(0, 2)
                            .map((w) => w[0])
                            .join("")
                            .toUpperCase();
                          // Hoja de calendario (fallback sin flyer): para una
                          // lista de NOCHES, el día identifica más que dos
                          // letras. Si la fecha no es válida, quedan iniciales.
                          const thumbDate = (() => {
                            const d = new Date(ev.starts_at);
                            if (Number.isNaN(d.getTime())) return null;
                            return {
                              day: String(d.getDate()),
                              mon: d
                                .toLocaleDateString("es-CO", { month: "short" })
                                .replace(".", "")
                                .toUpperCase(),
                            };
                          })();
                          return (
                            <div
                              key={ev.id}
                              className={`event-card evx-card ${live ? "is-live" : ""} ${
                                ev.status === "published" ? "is-published" : ""
                              } ${ended ? "is-ended" : ""}`}
                            >
                              {/* Link superpuesto: la TARJETA entera abre el
                            backstage y deja libres las esquinas para acciones
                            (duplicar) sin anidar botones dentro del <a>. */}
                              <TransitionLink
                                to={`/admin?event=${ev.id}`}
                                onClick={() => haptics.tick()}
                                className="absolute inset-0 rounded-xl"
                                aria-label={`Abrir ${ev.name}`}
                              />
                              {/* Perno del talon: la linea punteada que
                                  separa el cuerpo de la boleta del codigo. */}
                              <span className="evx-perf" aria-hidden="true" />
                              <div className="pointer-events-none p-4">
                                {/* Fila 1: identidad. Flyer (o iniciales) + nombre
                              y estado; la fecha en su propia línea es lo
                              operativo: "cuándo es" pesa más que el aforo. */}
                                <div className="evx-idrow">
                                  {hasFlyer ? (
                                    <img
                                      src={ev.flyer_url}
                                      alt=""
                                      onError={() =>
                                        setBadFlyers((m) => ({
                                          ...m,
                                          [ev.flyer_url]: true,
                                        }))
                                      }
                                      className="evx-thumb"
                                    />
                                  ) : thumbDate ? (
                                    <span
                                      className={`evx-thumb evx-thumb-fallback evx-datecal ${
                                        ended ? "is-ended" : ""
                                      }`}
                                      aria-hidden="true"
                                    >
                                      <span className="evx-datecal-mon">
                                        {thumbDate.mon}
                                      </span>
                                      <span className="evx-datecal-day tnum">
                                        {thumbDate.day}
                                      </span>
                                    </span>
                                  ) : (
                                    <span
                                      className={`evx-thumb evx-thumb-fallback ${
                                        ended ? "is-ended" : ""
                                      }`}
                                      aria-hidden="true"
                                    >
                                      {initials}
                                    </span>
                                  )}
                                  <div className="min-w-0 flex-1">
                                    <p className="evx-name truncate">
                                      {ev.name}
                                    </p>
                                    {pill && (
                                      <p
                                        className={`evx-when ec-when ec-when-${pill.tone} mt-1 inline-flex`}
                                      >
                                        <Icon
                                          name="calendar"
                                          className="h-3 w-3"
                                        />
                                        {pill.main}
                                      </p>
                                    )}
                                    {/* Estado + señal de apertura en su propia
                                      fila: el estado deja de pelear con los
                                      botones por la esquina y "Abrir →" dice
                                      SIEMPRE que la tarjeta se abre (sin
                                      depender del cursor ni del hover). */}
                                    <div className="evx-meta-row">
                                      <span className="evx-state">
                                        <span
                                          className={`evx-dot ${live ? "is-live" : ""}`}
                                          data-status={ev.status}
                                          aria-hidden="true"
                                        />
                                        {
                                          (EV_CHIP[ev.status] ?? EV_CHIP.draft)
                                            .label
                                        }
                                      </span>
                                      <span className="evx-open-label">
                                        Abrir
                                        <Icon
                                          name="arrowRight"
                                          className="h-3 w-3"
                                          aria-hidden="true"
                                        />
                                      </span>
                                    </div>
                                    {/* Salud de puerta: solo si hay
                                      duplicados. Un QR reenviado se delata
                                      desde la franja, sin abrir el evento. */}
                                    {stat?.duplicates > 0 && (
                                      <p
                                        className="evx-door-alert mt-2"
                                        data-tip="Posible QR reenviado: la puerta rechazó la boleta repetida"
                                      >
                                        <Icon
                                          name="alert"
                                          className="h-3 w-3"
                                          aria-hidden="true"
                                        />
                                        <span className="tnum">
                                          {stat.duplicates}
                                        </span>
                                        {stat.duplicates === 1
                                          ? "reescaneada"
                                          : "reescaneadas"}
                                      </p>
                                    )}
                                  </div>
                                </div>

                                {/* Fila 2: las TRES cifras que responden las tres
                              preguntas de la noche, CADA UNA ROTULADA (antes
                              "0/1 dentro" flotaba sin contexto y "$ 0" en
                              verde prometia dinero que no hay). El recaudo
                              manda en tamanio; vendidas y entraron en tinta
                              media. */}
                                {sold !== null ? (
                                  <div className="evx-stats">
                                    <div className="evx-stat">
                                      <span className="evx-stat-label">
                                        Recaudo
                                      </span>
                                      <span
                                        className={`evx-stat-value tnum ${
                                          stat.revenue_cents > 0
                                            ? "has-money"
                                            : ""
                                        }`}
                                      >
                                        {money(stat.revenue_cents)}
                                      </span>
                                    </div>
                                    <div className="evx-stat">
                                      <span className="evx-stat-label">
                                        Vendidas
                                      </span>
                                      <span className="evx-stat-value tnum">
                                        {sold}
                                        <span className="evx-stat-denom">
                                          /{ev.capacity}
                                        </span>
                                      </span>
                                    </div>
                                    <div className="evx-stat">
                                      <span className="evx-stat-label">
                                        Entraron
                                      </span>
                                      <span
                                        className={`evx-stat-value tnum ${
                                          live && stat.redeemed > 0
                                            ? "is-counting"
                                            : ""
                                        }`}
                                      >
                                        {/* En puerta el número late: el punto
                                          esmeralda latiendo junto a la cifra
                                          dice "está pasando ahora" sin animar
                                          el número (menos ruido, más pulso). */}
                                        {live && stat.redeemed > 0 && (
                                          <span
                                            className="evx-stat-dot"
                                            aria-hidden="true"
                                          />
                                        )}
                                        {stat.redeemed}
                                      </span>
                                    </div>
                                  </div>
                                ) : (
                                  <div className="evx-stats">
                                    {[0, 1, 2].map((i) => (
                                      <div key={i} className="evx-stat">
                                        <span className="skeleton h-2.5 w-14" />
                                        <span className="skeleton mt-1 block h-4 w-16" />
                                      </div>
                                    ))}
                                  </div>
                                )}

                                {/* Fila 3: aforo como barra fina + % vendido.
                              La barra es proporcion, no decoracion: color solo
                              si hay alerta real (80% ambar, 100% rojo). */}
                                {pct !== null && (
                                  <div className="evx-meterrow">
                                    <div
                                      className="evx-meter"
                                      aria-hidden="true"
                                    >
                                      <div
                                        className={`evx-meter-fill ${
                                          pct >= 100
                                            ? "is-full"
                                            : pct >= 80
                                              ? "is-warn"
                                              : ""
                                        }`}
                                        style={{ width: `${pct}%` }}
                                      />
                                    </div>
                                    {/* La proporción NOMBRADA: un "1%" suelto
                                      obliga a adivinar (¿1% de qué?). */}
                                    <span
                                      className="evx-pct tnum"
                                      data-tip="Porcentaje vendido del aforo"
                                    >
                                      {pct}%
                                    </span>
                                  </div>
                                )}
                              </div>
                              {/* Acciones de la tarjeta: es panel de control,
                            no solo enlace. Se derivan de NEXT_ACTIONS — la
                            MISMA fuente que el backstage — así que la tarjeta
                            ya no reimplementa un subconjunto: un evento en vivo
                            se finaliza desde aquí, sin abrir su backstage. */}
                              <div className="evx-actions pointer-events-auto">
                                {(NEXT_ACTIONS[ev.status] ?? []).map(
                                  ({ action }) => {
                                    const meta =
                                      STRIP_ACTION[action] ?? {
                                        label: action,
                                        icon: "bolt",
                                      };
                                    const busy =
                                      busyAction === `${action}-${ev.id}`;
                                    return (
                                      <button
                                        key={action}
                                        onClick={() => quickTransition(ev, action)}
                                        disabled={busyAction !== ""}
                                        aria-label={`${meta.label} ${ev.name}`}
                                        data-tip={ACTION_TIP[action]}
                                        className="btn-mini"
                                        data-variant={meta.variant}
                                      >
                                        {busy ? (
                                          <svg
                                            className="btn-spinner"
                                            viewBox="0 0 24 24"
                                            aria-hidden="true"
                                          >
                                            <circle cx="12" cy="12" r="9" />
                                          </svg>
                                        ) : (
                                          <Icon
                                            name={meta.icon}
                                            className="h-3.5 w-3.5"
                                          />
                                        )}
                                        {meta.label}
                                      </button>
                                    );
                                  },
                                )}
                                {/* Duplicar está disponible en TODOS los
                                    estados: de una noche en curso o pasada
                                    nace el borrador de la siguiente. */}
                                <button
                                  onClick={() => duplicateEvent(ev)}
                                  disabled={dupingId !== null}
                                  aria-label={`Duplicar ${ev.name}`}
                                  data-tip="Duplicar evento (borrador con sus tipos y cupos)"
                                  className="btn-mini btn-icon"
                                >
                                  {dupingId === ev.id ? (
                                    <svg
                                      className="btn-spinner"
                                      viewBox="0 0 24 24"
                                      aria-hidden="true"
                                    >
                                      <circle cx="12" cy="12" r="9" />
                                    </svg>
                                  ) : (
                                    <Icon name="copy" className="h-3.5 w-3.5" />
                                  )}
                                </button>
                                {/* Eliminar: para limpiar el calendario de 20
                                    noches sin entrar al backstage de cada
                                    evento. Solo donde el backend lo permite. */}
                                {canDeleteEvent(ev) && (
                                  <button
                                    onClick={() => deleteEvent(ev)}
                                    disabled={deletingId !== null}
                                    aria-label={`Eliminar ${ev.name}`}
                                    data-tip="Eliminar evento definitivamente"
                                    className="btn-mini btn-icon"
                                    data-variant="danger"
                                  >
                                    {deletingId === ev.id ? (
                                      <svg
                                        className="btn-spinner"
                                        viewBox="0 0 24 24"
                                        aria-hidden="true"
                                      >
                                        <circle cx="12" cy="12" r="9" />
                                      </svg>
                                    ) : (
                                      <Icon
                                        name="trash"
                                        className="h-3.5 w-3.5"
                                      />
                                    )}
                                  </button>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </section>
                ) : (
                  /* Negocio recién creado: sin noches todavía. Este bloque es
                     también el ancla del paso "eventos" del tutorial, que
                     tiene que existir aunque no haya eventos. */
                  <section data-tour="eventos" className="pt-1">
                    <EmptyState
                      icon="ticket"
                      title="Todavía no hay eventos"
                    >
                      <p>
                        Crea tu primera noche con el botón de abajo: nace en
                        borrador y la montas antes de vender.
                      </p>
                      <button
                        type="button"
                        onClick={() => setCreateOpen(true)}
                        data-tour="nuevo-evento"
                        className="btn-primary mt-3 !px-3 !py-1.5 text-xs"
                      >
                        Crear mi primer evento
                      </button>
                    </EmptyState>
                  </section>
                )}
            </VenueHeader>

            {/* Acción primaria al alcance del pulgar (solo móvil, modo lista):
              con una lista larga, "Nuevo evento" en el header queda aizar
              tras hacer scroll. La FAB flotante lo mantiene a un toque,
              encima de la barra de pestañas. */}
            {!selectedEventData && section === "resumen" && !createOpen && (
              <button
                onClick={() => {
                  haptics.tick();
                  setCreateOpen(true);
                }}
                aria-label="Nuevo evento"
                data-tip="Nuevo evento"
                className="fixed right-4 z-20 grid h-14 w-14 place-items-center rounded-full bg-brand-600 text-white shadow-lg shadow-brand-900/40 transition active:scale-95 md:hidden"
                style={{ bottom: "calc(5.5rem + env(safe-area-inset-bottom))" }}
              >
                <Icon name="plus" className="h-6 w-6" />
              </button>
            )}

            {/* Probador de QR: leer sin canjear (solo lectura). */}
            {qrTesterOpen && (
              <QrTesterModal onClose={() => setQrTesterOpen(false)} />
            )}

            {/* Crear evento: modal (no un formulario de 10 campos en la página). */}
            {createOpen && (
              <EventCreateModal
                venueId={venueId}
                onClose={() => setCreateOpen(false)}
                onCreated={(ev) => {
                  setCreateOpen(false);
                  // El evento recién creado ABRE su backstage: nace aparte y
                  // el admin aterriza directo en la pestaña de montaje.
                  loadEvents().then(() => flyToEvent(ev.id, "entradas"));
                }}
              />
            )}
          </>
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
              onExit={() => setSearchParams({})}
              preflight={preflight}
            />

            {/* Edición del evento (draft/published) */}
            {editingEvent && editable && (
              <form onSubmit={saveEventEdit} className="card p-5">
                <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="display text-base">Editar evento</h3>
                  <button
                    type="button"
                    onClick={() => setEditingEvent(null)}
                    className="text-xs font-semibold text-zinc-400 transition hover:text-zinc-200"
                  >
                    Cerrar
                  </button>
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

                  <label>
                    <span className="mb-1 block text-xs font-medium text-zinc-400">
                      Flyer (URL)
                    </span>
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
                    />
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
                </div>

                {editError && (
                  <p className="mt-3 text-xs text-red-400">{editError}</p>
                )}

                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <button className="btn-primary" disabled={savingEdit}>
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
            {section === "resumen" && (
              <div className="grid gap-5 lg:grid-cols-2">
                {report ? (
                  <ReportWidget report={report} />
                ) : (
                  <StatSkeletonRow />
                )}
                {/* Ritmo de la puerta a ANCHO COMPLETO: una serie temporal se
                    lee mejor ancha, y es la señal operativa de la noche
                    (¿fluye o se atascó?), no un detalle del reporte. */}
                {report && (
                  <div className="lg:col-span-2">
                    <DoorPulse pulse={report.door_pulse} isLive={isLive} />
                  </div>
                )}
                {closing && (
                  <div className="card p-4 lg:col-span-2">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="eyebrow">Cierre de noche</p>
                        <p className="mt-0.5 text-sm text-zinc-400">
                          Caja + puerta + equipo en un CSV para el contador. El
                          cierre trae toda la noche; la caja se puede acotar a
                          un rango de fechas.
                        </p>
                      </div>
                      <button
                        onClick={closeNight}
                        className="btn-primary shrink-0"
                      >
                        <Icon name="download" className="h-4 w-4" />
                        Cerrar noche
                      </button>
                    </div>
                    {/* Caja por periodo: el cierre trae TODO el evento; si el
                        contador solo quiere unos dias, se acota aqui. Las
                        fechas van en la zona del evento (lo resuelve el API). */}
                    <div className="mt-3 flex flex-wrap items-end gap-3 border-t border-zinc-800 pt-3">
                      <label className="flex flex-col gap-1 text-2xs uppercase tracking-wide text-zinc-500">
                        Desde
                        <input
                          type="date"
                          value={cajaRange.desde}
                          onChange={(e) =>
                            setCajaRange({ ...cajaRange, desde: e.target.value })
                          }
                          className="field"
                          aria-label="Caja desde"
                        />
                      </label>
                      <label className="flex flex-col gap-1 text-2xs uppercase tracking-wide text-zinc-500">
                        Hasta
                        <input
                          type="date"
                          value={cajaRange.hasta}
                          onChange={(e) =>
                            setCajaRange({ ...cajaRange, hasta: e.target.value })
                          }
                          className="field"
                          aria-label="Caja hasta"
                        />
                      </label>
                      <button
                        onClick={closeCaja}
                        disabled={cajaBusy}
                        className="btn-ghost shrink-0"
                      >
                        <Icon name="download" className="h-4 w-4" />
                        {cajaBusy ? "Preparando…" : "Caja (CSV)"}
                      </button>
                    </div>
                    {/* Las cifras EN PANTALLA antes de descargar: el CSV es
                        para el contador; esto es para decidir si la noche ya
                        está para cerrar o si quedó gente sin entrar. */}
                    <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                      {[
                        ["Recaudo", money(report?.revenue_cents ?? 0)],
                        ["Vendidas", report?.issued ?? 0],
                        ["Entraron", report?.redeemed ?? 0],
                        ["En puerta", preflight?.bouncers ?? 0],
                      ].map(([label, value]) => (
                        <div
                          key={label}
                          className="rounded-xl bg-zinc-940 px-3 py-2"
                        >
                          <p className="text-2xs uppercase tracking-wide text-zinc-500">
                            {label}
                          </p>
                          <p className="tnum mt-0.5 text-lg font-bold text-zinc-100">
                            {value}
                          </p>
                        </div>
                      ))}
                    </div>
                    {/* Semáforo de "listo para vender": solo antes de abrir
                        puertas, que es cuando todavía se puede corregir. */}
                    {["draft", "published"].includes(
                      selectedEventData?.status,
                    ) && (
                      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                        {[
                          [
                            types.filter((t) => t.is_active !== false).length >
                              0,
                            "Tipos de boleta",
                          ],
                          [allocations.length > 0, "Cupos de promotor"],
                          [(preflight?.bouncers ?? 0) > 0, "Portero asignado"],
                          [preflight?.door_ready === true, "Escáner activo"],
                        ].map(([ok, label]) => (
                          <span
                            key={label}
                            className={ok ? "text-emerald-300" : "text-amber-300"}
                          >
                            {ok ? "✓" : "•"} {label}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {/* Tips operativos: el qué-hacer-now del evento, sin duplicar
                  el ciclo de vida (que vive siempre visible en el header). */}
                <div className="card p-4">
                  <p className="eyebrow">Puerta</p>
                  <p className="display mb-3 mt-0.5 text-base">
                    Cómo va la puerta
                  </p>
                  {/* Barra de ingreso: cuánto del aforo ya cruzó la puerta, de
                      un vistazo. Verde = ya entraron; el resto es lo que falta. */}
                  {(() => {
                    const cap = selectedEventData?.capacity ?? 0;
                    const inCount = report?.redeemed ?? 0;
                    const pct = cap ? Math.min(100, (inCount / cap) * 100) : 0;
                    return (
                      <div className="meter mb-1.5">
                        <div
                          className="meter-fill bg-emerald-500"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    );
                  })()}
                  <ul className="space-y-2 text-sm text-zinc-300">
                    <li className="flex items-center justify-between gap-2">
                      <span>Boletas pendientes de entrar</span>
                      <span className="tnum font-bold text-amber-300">
                        {(report?.issued ?? 0) - (report?.redeemed ?? 0)}
                      </span>
                    </li>
                    <li className="flex items-center justify-between gap-2">
                      <span>Ya ingresaron</span>
                      <span className="tnum font-bold text-emerald-300">
                        {report?.redeemed ?? 0}
                      </span>
                    </li>
                    <li className="flex items-center justify-between gap-2">
                      <span>Aforo disponible</span>
                      <span className="tnum font-bold text-zinc-100">
                        {Math.max(
                          0,
                          (selectedEventData?.capacity ?? 0) -
                            (report?.issued ?? 0),
                        )}
                      </span>
                    </li>
                  </ul>
                  {isLive && (
                    <p className="mt-3 flex items-center gap-2 rounded-lg bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300 ring-1 ring-emerald-500/30">
                      <span className="dp-live-dot shrink-0" aria-hidden="true" />
                      Puertas abiertas: los escaneos actualizan estos números en
                      vivo.
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* Pestañas separadas: cada pantalla una tarea, todo con control
                total. "Entradas" monta el producto; "Cupos" delega la venta;
                "Boletas" audita lo vendido y entrega los QR. */}
            {section === "entradas" && (
              <TypeManager
                venueId={venueId}
                eventId={selectedEvent}
                types={types}
                onChange={setTypes}
              />
            )}

            {section === "cupos" && (
              <AllocationManager
                venueId={venueId}
                eventId={selectedEvent}
                allocations={allocations}
                types={types}
                users={users}
                onChange={setAllocations}
              />
            )}

            {(section === "boletas" ||
              section === "entradas" ||
              section === "cupos") && (
              <TicketList
                venueId={venueId}
                eventId={selectedEvent}
                onChanged={refreshEventData}
                onError={setError}
              />
            )}

            {/* "Equipo" DENTRO de la noche (mig 025): el roster de esta noche y
                los links de puerta. Es lo unico de "Del negocio" que depende
                del evento — el resto (Equipo del bar, Liquidaciones) sigue en
                la portada porque no cambia con la noche abierta. */}
            {section === "noche" && selectedEventData && (
              <EventTeamPanel
                venueId={venueForTeam}
                event={selectedEventData}
                preflight={preflight}
              />
            )}
            </div>
          </>
        )}
        {/* Divisor de lazo (scrapbook): cierra la portada de la noche antes
            de la zona "del negocio", como los separadores del cartel. */}
        {!selectedEventData && events?.length > 0 && (
          <RibbonDivider className="my-1" />
        )}
        {/* ====== Del negocio: viven FUERA del evento ====== */}
        {/* Siempre visibles en modo lista: Reportes, Equipo, Liquidaciones e
          Invitaciones no cambian con el evento elegido — son del negocio, no
          de la noche. Dentro de un evento abierto NO existen: ahí solo hay
          pestañas de ese evento. */}
        {!selectedEventData && (
          <BusinessDock
            venueId={venueId}
            section={section}
            onNavigate={(id) => setSearchParams({ tab: id })}
          />
        )}
        {/* Secciones de venue: se renderizan cuando su pestaña está activa y
          NO hay evento abierto (en modo evento la pestaña activa es del
          evento; estas secciones son alcanzables desde la lista). */}
        {!selectedEventData && section === "puerta" && (
          <DoorSection
            venueId={venueId}
            onOpenEvent={(id) => flyToEvent(id, "entradas")}
          />
        )}
        {!selectedEventData && section === "promotores" && (
          <PromotersSection venueId={venueId} month={urlMonth} />
        )}
        {!selectedEventData && section === "cobros" && (
          <PaymentsPanel venueId={venueId} events={events ?? []} />
        )}
        {!selectedEventData && section === "negocio" && (
          <BusinessOverview
            venueId={venueId}
            month={urlMonth}
            onOpenEvent={(id) => flyToEvent(id, "resumen")}
          />
        )}
        {!selectedEventData && section === "equipo" && (
          <TeamManager
            venueId={venueId}
            users={users}
            onChanged={reloadUsers}
          />
        )}
        {!selectedEventData && section === "liquidaciones" && (
          <PayoutsManager venueId={venueId} users={users} />
        )}
        {!selectedEventData && section === "invitaciones" && (
          <InvitationsManager venueId={venueId} />
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
