import { useEffect, useMemo, useRef, useState } from "react";
import { fetchPublicEvents } from "../lib/api";
import { money } from "../lib/format";
import { track } from "../lib/analytics";
import FanNav from "../components/FanNav";
import useDocumentTitle from "../lib/useDocumentTitle";
import TransitionLink from "../components/TransitionLink";

const prefersReducedMotion = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const reducedMotionClass = prefersReducedMotion ? "motion-reduced" : "";

/**
 * Inicio — la cara publica de Enty para el fan (mockup "1 · Inicio").
 *
 * Catalogo de descubrimiento SIN login: lista los eventos con venta abierta
 * (`published`/`live`, futuros) que devuelve /public/events, con su categoria
 * inferida, precio minimo y aforo vendido. Buscador, carrusel de categorias,
 * hero destacado y lista con favoritos; todo en cliente sobre el mismo fetch
 * (no hay endpoint nuevo).
 *
 * Las 5 categorias del mockup (Conciertos/Festivales/Deportes/Teatro/Comedia)
 * son MAS finas que las 3 que deriva el backend (Musica/Deportes/Teatro): no
 * hay columna `category` en la DB. Se resuelven con un refinamiento por texto
 * sobre lo ya descargado — Festivales es "Musica" cuyo nombre dice festival,
 * Comedia es "Teatro" con nombre de comedia/stand-up — para no inventar datos
 * ni exigir una migracion.
 */

const MONTHS = ["ENE", "FEB", "MAR", "ABR", "MAY", "JUN", "JUL", "AGO", "SEP", "OCT", "NOV", "DIC"];
const FAVS_KEY = "tf_fan_favs";

/**
 * Fecha larga del hero: "Sáb 8 nov · 21:00". El destacado mostraba solo la
 * fecha corta ("Dom 8 NOV") al lado del lugar, en 12px y en gris: el dato que
 * más decide una compra (¿cuándo es?) estaba al mismo nivel que la dirección.
 * Se parte en dos piezas para poder pintar el día grande y la hora aparte.
 */
function longDateParts(iso, tz) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { day: "", time: "" };
  const fmt = (opts) =>
    new Intl.DateTimeFormat("es-CO", { ...opts, timeZone: tz || undefined }).format(d);
  const day = fmt({ weekday: "short", day: "numeric", month: "short" });
  const time = fmt({ hour: "2-digit", minute: "2-digit", hour12: false });
  const cap = day.charAt(0).toUpperCase() + day.slice(1);
  return { day: cap.replace(/\.$/, ""), time };
}

/** ¿El evento ocurre hoy (día calendario del fan)? Para el sello "HOY". */
function isToday(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

/**
 * Sellos de confianza de la banda cinética. NO repite los nombres de las
 * categorías: esos ya están en los chips justo encima, y gastar 45px del
 * primer scroll (el sitio más caro de la página) diciendo dos veces lo mismo
 * era puro ruido. La banda habla de lo que el catálogo *ofrece*; las ciudades
 * con oferta real se añaden en el render, que sí es información nueva. */
const TICKER_TRUST = ["Aforo en vivo", "Entrada con QR", "Cortesías", "Pago seguro"];

/** Fecha corta del evento, en su zona horaria: "Vie 24 oct". */
function shortDate(iso, tz) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("es-CO", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: tz || undefined,
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? "";
  const wd = get("weekday").replace(".", "");
  const month = get("month").replace(".", "").toUpperCase();
  const cap = wd.charAt(0).toUpperCase() + wd.slice(1);
  return `${cap} ${get("day")} ${month}`;
}

/**
 * Hora del evento en su zona, "21:00". En escritorio la tarjeta ya lleva el
 * día en el sello de la miniatura, así que la línea de datos muestra la HORA
 * en vez de repetir la misma fecha (antes el dato se duplicaba y la hora no
 * aparecía en ningún sitio del catálogo).
 */
function timeLabel(iso, tz) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("es-CO", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: tz || undefined,
  }).format(d);
}

/** Día, mes y día de la semana para el sello de la miniatura. */
function dayBadge(iso, tz) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { wd: "", day: "--", month: "---" };
  const parts = new Intl.DateTimeFormat("es-CO", {
    weekday: "short",
    day: "2-digit",
    month: "numeric",
    timeZone: tz || undefined,
  }).formatToParts(d);
  const day = parts.find((p) => p.type === "day")?.value ?? "--";
  const monthNum = Number(parts.find((p) => p.type === "month")?.value ?? 1);
  const wd = (parts.find((p) => p.type === "weekday")?.value ?? "").replace(".", "").toUpperCase();
  return { wd, day, month: MONTHS[monthNum - 1] ?? "---" };
}

/**
 * Rangos de fecha de la vitrina. El backend no tiene filtro por fecha (ordena
 * por `starts_at`), asi que se recorta en cliente sobre el catalogo ya
 * descargado: cero peticiones extra y cambio instantaneo.
 */
const DATE_CHIPS = [
  { key: "todos", label: "Todas" },
  { key: "hoy", label: "Hoy" },
  { key: "semana", label: "7 días" },
  { key: "mes", label: "30 días" },
];

/** Ciudad del evento: el primer segmento de la direccion, o el venue. */
function cityOf(e) {
  return (e.location || e.venue || "").split(",")[0].trim();
}

/**
 * ¿El evento cae dentro del rango elegido? "Hoy" es el dia calendario del
 * navegador (la vitrina se lee desde donde esta el fan); los demas rangos son
 * ventanas moviles desde ahora, que es como la gente piensa "este fin de
 * semana" / "este mes".
 */
function inDateRange(iso, key) {
  if (key === "todos") return true;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return false;
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (key === "hoy") return t >= dayStart && t < dayStart + 86_400_000;
  const days = key === "semana" ? 7 : 30;
  return t >= now.getTime() && t <= now.getTime() + days * 86_400_000;
}

/** Estrella de cuatro puntas (acento de marca). */
function Star({ size = 8, color = "#8B5CF6" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 0 L14.6 9.4 L24 12 L14.6 14.6 L12 24 L9.4 14.6 L0 12 L9.4 9.4 Z" fill={color} />
    </svg>
  );
}


/** A partir de qué % el aforo vendido es una señal de escasez que vale la pena
 *  mostrar. Por debajo, "1% VENDIDO" no informa de nada y ocupa el sitio más
 *  visible del hero; en su lugar va un dato útil (la categoría). */
const SOLD_ALERT_PCT = 70;

/**
 * Anillo de aforo del destacado. Solo se pinta cuando el % ya es una señal
 * ("casi lleno"); con el aforo bajo el hero muestra otra cosa.
 *
 * Es una PIEZA cuadrada de 100×100, no un lienzo a sangre: antes el SVG se
 * estiraba al ancho de la tarjeta y en escritorio el "VENDIDO" salía a 70px,
 * desbordado y encima del titular. El tamaño lo fija el CSS.
 */
function SoldRing({ pct }) {
  const r = 43;
  const c = 2 * Math.PI * r;
  const shown = Math.max(0, Math.min(100, pct ?? 0));
  return (
    <svg className="home-ring" viewBox="0 0 100 100" aria-hidden="true">
      <circle cx="50" cy="50" r={r} fill="none" stroke="var(--e-white)" strokeOpacity="0.16" strokeWidth="3" />
      <circle
        cx="50"
        cy="50"
        r={r}
        fill="none"
        stroke="var(--e-violet-250)"
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray={`${(shown / 100) * c} ${c}`}
        transform="rotate(-90 50 50)"
      />
      <text x="50" y="53" textAnchor="middle" fontSize="25" fontWeight="300" fill="var(--e-white)" letterSpacing="-1">
        {shown}%
      </text>
      <text x="50" y="68" textAnchor="middle" fontSize="11" fill="var(--e-violet-200)" letterSpacing="1.4">
        VENDIDO
      </text>
    </svg>
  );
}

/** Iconos de las categorias (circulares, trazo fino como la barra inferior). */
function CatIcon({ name }) {
  const common = {
    width: 22,
    height: 22,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
  };
  if (name === "music")
    return (
      <svg {...common}>
        <path d="M9 18V6l10-2v12" />
        <circle cx="6.5" cy="18" r="2.5" />
        <circle cx="16.5" cy="16" r="2.5" />
      </svg>
    );
  if (name === "tent")
    return (
      <svg {...common}>
        <path d="M12 4l8 15H4z" />
        <path d="M12 4v15" />
        <path d="M8.5 19l3.5-7 3.5 7" />
      </svg>
    );
  if (name === "ball")
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7l3.5 2.5-1.3 4.2h-4.4L8.5 9.5z" />
      </svg>
    );
  if (name === "masks")
    return (
      <svg {...common}>
        <path d="M3 7h8v5a4 4 0 0 1-8 0z" />
        <path d="M13 9h8v5a4 4 0 0 1-8 0z" />
        <path d="M5.5 10.5h.01M8.5 10.5h.01M15.5 12.5h.01M18.5 12.5h.01" />
      </svg>
    );
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 14.5a4.5 4.5 0 0 0 7 0" />
      <path d="M9 9.5h.01M15 9.5h.01" />
    </svg>
  );
}

/**
 * Las 5 categorias del mockup, resueltas sobre las 3 del backend por
 * refinamiento de texto (ver comentario de cabecera). `match` recibe el evento
 * ya descargado; nunca hace red.
 */
const CATEGORY_CHIPS = [
  { key: "todos", label: "Todo", icon: null, match: () => true },
  {
    key: "conciertos",
    label: "Conciertos",
    icon: "music",
    match: (e) => e.category === "Música" && !/festival/i.test(e.name),
  },
  {
    key: "festivales",
    label: "Festivales",
    icon: "tent",
    match: (e) => e.category === "Música" && /festival/i.test(e.name),
  },
  { key: "deportes", label: "Deportes", icon: "ball", match: (e) => e.category === "Deportes" },
  {
    key: "teatro",
    label: "Teatro",
    icon: "masks",
    match: (e) => e.category === "Teatro" && !/comedia|stand/i.test(e.name),
  },
  {
    key: "comedia",
    label: "Comedia",
    icon: "smile",
    match: (e) => e.category === "Teatro" && /comedia|stand/i.test(e.name),
  },
];

function Heart({ filled }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 20s-7-4.6-7-9.5A3.9 3.9 0 0 1 12 7a3.9 3.9 0 0 1 7 3.5C19 15.4 12 20 12 20z"
        fill={filled ? "#7C3AED" : "none"}
        stroke={filled ? "#7C3AED" : "currentColor"}
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function BellIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 8a6 6 0 1 0-12 0c0 6-2 7-2 7h16s-2-1-2-7" />
      <path d="M10.5 20a1.8 1.8 0 0 0 3 0" />
    </svg>
  );
}

/** Lee los favoritos guardados (ids). localStorage puede fallar en privado. */
function readFavs() {
  try {
    const raw = localStorage.getItem(FAVS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr.map(Number) : []);
  } catch {
    return new Set();
  }
}

export default function HomePage({ explorar = false }) {
  useDocumentTitle(explorar ? "Explorar eventos" : "Inicio");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [cat, setCat] = useState("todos");
  const [query, setQuery] = useState("");
  const [range, setRange] = useState("todos");
  const [favs, setFavs] = useState(() => new Set());
  // Solo la última tarjeta marcada celebra (rebote): no todas al montar.
  const [favPop, setFavPop] = useState(null);
  const [bellOpen, setBellOpen] = useState(false);
  // Filtros avanzados (fecha + ciudad) detrás de un botón "Filtros": son
  // micro-decisiones de una pantalla de CONSUMO (Ley de Hick) y competían con
  // la grilla. El buscador y las categorías quedan a la vista; lo raro, un
  // nivel más adentro (divulgación progresiva).
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtersRef = useRef(null);
  const filtersPanelRef = useRef(null);
  // El panel de avisos es un role="dialog" (dropdown, no modal): cierra con
  // Escape y con clic fuera, como el resto de campanas de la app. Sin esto el
  // usuario de teclado quedaba mirando un panel que solo cerraba el botón.
  // El panel vive fuera de `.home-head-right` (es hermano del header), así que
  // el "clic fuera" mira los dos nodos: botón y panel.
  const bellRef = useRef(null);
  const bellPanelRef = useRef(null);
  // La banda de categorias hace scroll horizontal (677px de contenido en 350px
  // visibles): sin una pista, Teatro y Comedia quedan invisibles. El CSS pinta
  // un degradado al borde derecho; este efecto lo retira cuando el usuario ya
  // llego al final, para no sugerir que sigue faltando algo.
  const catsRef = useRef(null);
  // Contador de reintentos: cambiar el valor vuelve a disparar el fetch sin
  // duplicar la lógica de carga (mismo efecto, misma limpieza).
  const [reload, setReload] = useState(0);
  // La vitrina no bloquea el tema: su capa es papel claro (enty-fan.css) y la
  // tipografía/acentos se mantienen iguales en claro y oscuro.
  const searchRef = useRef(null);

  useEffect(() => setFavs(readFavs()), []);

  // Explorar nace con el buscador listo: la pestaña existe para buscar, no
  // para mirar una portada. Solo con puntero fino: en móvil el teclado tapa
  // medio catálogo y el foco automático empuja el layout.
  useEffect(() => {
    if (!explorar) return;
    if (window.matchMedia?.("(hover: hover) and (pointer: fine)").matches) {
      searchRef.current?.focus();
    }
  }, [explorar]);

  // Pista de scroll de las categorias: `data-scrolled="end"` apaga el degradado
  // cuando la fila ya se desplazo hasta el final (y "start" en reposo).
  useEffect(() => {
    const el = catsRef.current;
    if (!el) return;
    const sync = () => {
      const alFinal = el.scrollLeft + el.clientWidth >= el.scrollWidth - 2;
      el.dataset.scrolled = alFinal ? "end" : "start";
    };
    sync();
    el.addEventListener("scroll", sync, { passive: true });
    window.addEventListener("resize", sync);
    return () => {
      el.removeEventListener("scroll", sync);
      window.removeEventListener("resize", sync);
    };
  }, [data]);

  // Ciudad opcional por URL (?city=Bogotá): permite enlazar/compartir una
  // cartelera por ciudad sin cuenta. Se filtra en cliente sobre el catalogo
  // ya descargado — cambiar de ciudad NO vuelve a pedir la API (sin esqueleto
  // de carga) y la URL se mantiene sincronizada para que el enlace se pueda
  // seguir compartiendo.
  const [city, setCity] = useState(() => {
    const c = new URLSearchParams(window.location.search).get("city");
    return c && c.trim() ? c.trim() : "";
  });

  useEffect(() => {
    let alive = true;
    // Un reintento vuelve al estado de carga: si no, la pantalla muestra el
    // error viejo mientras la petición nueva está en camino.
    setError("");
    setData(null);
    fetchPublicEvents({ limit: 100 })
      .then((d) => {
        if (alive) setData(d);
      })
      .catch((e) => {
        if (alive) setError(e.message || "No pudimos cargar los eventos");
      });
    return () => {
      alive = false;
    };
  }, [reload]);

  // La ciudad vive en la URL: el enlace compartido abre la misma cartelera.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (city) url.searchParams.set("city", city);
    else url.searchParams.delete("city");
    window.history.replaceState(null, "", url);
  }, [city]);

  // Cerrar el panel de avisos con Escape (y devolver el foco a la campana) y con
  // clic fuera. Patrón dropdown, igual que NotificationBell: es un role="dialog"
  // de contenido, no un modal, así que no atrapa el foco ni bloquea el scroll.
  useEffect(() => {
    if (!bellOpen) return;
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setBellOpen(false);
        bellRef.current?.querySelector(".home-bell")?.focus();
      }
    };
    const onDoc = (e) => {
      const enBoton = bellRef.current?.contains(e.target);
      const enPanel = bellPanelRef.current?.contains(e.target);
      if (!enBoton && !enPanel) setBellOpen(false);
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDoc);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDoc);
    };
  }, [bellOpen]);

  // Panel "Filtros": mismo contrato que la campana (role="dialog" de contenido,
  // no modal). Cierra con Escape (devolviendo el foco al botón) y con clic fuera.
  useEffect(() => {
    if (!filtersOpen) return;
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setFiltersOpen(false);
        filtersRef.current?.querySelector(".home-filter-btn")?.focus();
      }
    };
    const onDoc = (e) => {
      const enBoton = filtersRef.current?.contains(e.target);
      const enPanel = filtersPanelRef.current?.contains(e.target);
      if (!enBoton && !enPanel) setFiltersOpen(false);
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDoc);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDoc);
    };
  }, [filtersOpen]);

  // Embudo, paso 1: vio la vitrina. Solo cuando el catálogo cargó: si la API
  // falló, esa visita no es una oportunidad de venta y no debe contarla.
  useEffect(() => {
    if (data) track("view_home", { eventCount: (data.events ?? []).length });
  }, [data]);

  const events = data?.events ?? [];
  const chip = CATEGORY_CHIPS.find((c) => c.key === cat) ?? CATEGORY_CHIPS[0];

  // Ciudades del catalogo (las que de verdad tienen eventos), de mas a menos
  // oferta: el filtro no ofrece destinos vacios.
  const cities = useMemo(() => {
    const counts = new Map();
    for (const e of events) {
      const c = cityOf(e);
      if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [events]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return events.filter((e) => {
      if (city && cityOf(e) !== city) return false;
      if (!inDateRange(e.starts_at, range)) return false;
      if (!chip.match(e)) return false;
      if (!q) return true;
      return (
        e.name.toLowerCase().includes(q) ||
        (e.venue ?? "").toLowerCase().includes(q) ||
        (e.location ?? "").toLowerCase().includes(q)
      );
    });
  }, [events, chip, query, city, range]);

  // En modo explorar no hay destacado: la rejilla es el catálogo completo y
  // el primer evento no se roba el sitio (es lo que diferencia la pestaña
  // "Explorar" de "Inicio", que sí es una portada editorial).
  const featured = filtered[0] ?? null;
  const rest = explorar ? filtered : filtered.slice(1);
  // Hay un filtro puesto (texto, categoria, fecha o ciudad): cambia el mensaje
  // del vacio y el boton que lo deshace.
  const narrowed = Boolean(query.trim()) || cat !== "todos" || range !== "todos" || Boolean(city);
  // Cuántos filtros avanzados (fecha + ciudad) están puestos: el botón "Filtros"
  // lo dice con un contador, así el usuario sabe que hay algo activo sin abrir.
  const activeAdvanced =
    (range !== "todos" ? 1 : 0) + (city ? 1 : 0);

  // La banda cinética: sellos de confianza + las ciudades con oferta real
  // (dato que no está en ningún otro sitio del primer scroll).
  const tickerWords = useMemo(
    () => [...TICKER_TRUST, ...cities.slice(0, 4).map(([name]) => name)],
    [cities],
  );

  // El anillo solo aparece cuando el aforo ya es una señal; si no, el hero
  // muestra la categoría (ver SOLD_ALERT_PCT).
  const heroPct = featured?.sold_pct ?? null;
  const heroCasiLleno = heroPct != null && heroPct >= SOLD_ALERT_PCT;

  // Anuncio para lectores de pantalla del resultado de filtrar. Buscar, cambiar
  // de categoría o de fecha re-renderiza la rejilla en silencio: sin esto, quien
  // no ve la pantalla no sabe cuántos eventos quedaron (ni que no quedó ninguno).
  // Solo cuenta con el catálogo cargado y sin error: en carga o fallo el mensaje
  // visible ya lo comunica el estado correspondiente.
  const anuncio = !data
    ? ""
    : error
      ? "No se pudo cargar la cartelera."
      : filtered.length === 0
        ? "Sin resultados. Prueba con otro nombre, categoría, fecha o ciudad."
        : `${filtered.length} ${filtered.length === 1 ? "evento" : "eventos"} en la cartelera.`;

  function resetFilters() {
    setQuery("");
    setCat("todos");
    setRange("todos");
    setCity("");
  }

  // Avisos = eventos que ocurren en los proximos 7 dias (lo unico que el
  // catalogo publico permite saber sin cuenta). No hay push de fan todavia.
  const soon = useMemo(() => {
    const now = Date.now();
    const week = now + 7 * 24 * 60 * 60 * 1000;
    return events.filter((e) => {
      const t = new Date(e.starts_at).getTime();
      return !Number.isNaN(t) && t >= now && t <= week;
    });
  }, [events]);

  function toggleFav(id) {
    setFavs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(FAVS_KEY, JSON.stringify([...next]));
      } catch {
        /* modo privado: se pierde al recargar, la UI ya refleja el toggle */
      }
      return next;
    });
    // Marcar celebra (rebote); desmarcar no.
    setFavPop(favs.has(id) ? null : id);
  }

  const priceLabel = (c) => (c == null ? "Gratis" : money(c));

  return (
    <div className="home motion-reduced">
      <header className="home-head">
        <div className="home-head-left">
          <TransitionLink to="/inicio" className="home-wordmark" aria-label="Enty, inicio">
            <span>Enty</span>
            <Star />
          </TransitionLink>
          {/* Nav de escritorio: en móvil vive la barra inferior (FanNav). */}
          <nav className="home-topnav" aria-label="Secciones">
            <TransitionLink to="/inicio" aria-current={explorar ? undefined : "page"}>
              Inicio
            </TransitionLink>
            <TransitionLink to="/explorar" aria-current={explorar ? "page" : undefined}>
              Explorar
            </TransitionLink>
            <TransitionLink to="/boletas">Mis boletas</TransitionLink>
            {/* El staff necesita una entrada visible al panel: en movil la da
                la barra inferior (Acceso), en escritorio no hay barra. */}
            <TransitionLink to="/login">Acceso</TransitionLink>
          </nav>
        </div>
        <div className="home-head-right" ref={bellRef}>
          <button
            type="button"
            className="home-bell"
            aria-label="Notificaciones"
            aria-expanded={bellOpen}
            onClick={() => setBellOpen((v) => !v)}
          >
            <BellIcon />
            {soon.length > 0 && <i className="home-bell-dot" aria-hidden="true" />}
          </button>
        </div>
      </header>

      {bellOpen && (
        <div className="home-bell-panel" role="dialog" aria-label="Avisos" ref={bellPanelRef}>
          <p className="home-bell-title">Próximos 7 días</p>
          {soon.length === 0 ? (
            <p className="home-bell-empty">Sin eventos a la vuelta de la esquina.</p>
          ) : (
            <ul>
              {soon.slice(0, 4).map((e) => (
                <li key={e.id}>
                  <TransitionLink to={`/evento/${e.id}`} onClick={() => setBellOpen(false)}>
                    <strong>{e.name}</strong>
                    <em>{shortDate(e.starts_at, e.timezone)} · {e.where}</em>
                  </TransitionLink>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <main className="home-main">
        {/* Titular VISIBLE de la vitrina. Antes era `sr-only`: el h1 existía
            para el lector de pantalla pero en la pantalla no había ninguna frase
            que dijera qué es esta página. La primera mitad del scroll era
            andamiaje de filtros y el único texto grande era el nombre de un
            evento. Ahora el titular ocupa ese hueco, con el conteo de la
            cartelera como dato vivo.
            Sigue presente en TODOS los estados (cargando, error, vacío y con
            cartelera): sin eventos la página se quedaba sin encabezado. */}
        <div className="home-hero">
          <h1>
            {error
              ? "Cartelera no disponible"
              : filtered.length === 0
                ? "Sin resultados en la cartelera"
                : explorar
                  ? "Explorar eventos"
                  : "Cartelera de eventos"}
          </h1>
          {!error && data && filtered.length > 0 && (
            <p className="home-hero-count">
              {filtered.length === 1
                ? "1 evento por descubrir"
                : `${filtered.length} eventos por descubrir`}
            </p>
          )}
        </div>

        <div className="home-search">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(ev) => setQuery(ev.target.value)}
            placeholder="Busca eventos o artistas…"
            aria-label="Buscar eventos"
          />
        </div>

        <div role="group" aria-label="Categorías" className="home-cats" ref={catsRef}>
          {CATEGORY_CHIPS.map((c) => (
            <button
              key={c.key}
              aria-pressed={c.key === cat}
              onClick={() => setCat(c.key)}
              className={"relative" + (c.key === cat ? " is-on" : "")}
            >
              <span className="home-cat-dot">
                {c.icon ? <CatIcon name={c.icon} /> : <Star size={16} color="currentColor" />}
              </span>
              {c.label}
            </button>
          ))}
        </div>

        {/* Filtros avanzados (fecha + ciudad) detrás de un botón "Filtros".
            Ley de Hick: en una pantalla de consumo, cada control visible es una
            micro-decisión que retrasa "ver eventos y comprar". El buscador y
            las categorías quedan a la vista; lo demás, un nivel más adentro.
            El contador del botón dice cuántos filtros hay puestos. */}
        <div className="home-filterbar" ref={filtersRef}>
          <button
            type="button"
            className="home-filter-btn"
            aria-expanded={filtersOpen}
            aria-controls={filtersOpen ? "home-filter-panel" : undefined}
            onClick={() => setFiltersOpen((v) => !v)}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 6h16M7 12h10M10 18h4" />
            </svg>
            Filtros
            {activeAdvanced > 0 && (
              <span className="home-filter-count tnum" aria-hidden="true">
                {activeAdvanced}
              </span>
            )}
          </button>
        </div>

        {filtersOpen && (
          <div
            id="home-filter-panel"
            className="home-filter-panel"
            role="dialog"
            aria-label="Filtros de la cartelera"
            ref={filtersPanelRef}
          >
            <div className="home-filter-group">
              <p className="home-filter-label">Fecha</p>
              <div className="home-filter-dates">
                {DATE_CHIPS.map((d) => (
                  <button
                    key={d.key}
                    type="button"
                    aria-pressed={range === d.key}
                    className={"home-chip transition-colors" + (range === d.key ? " is-on" : "")}
                    onClick={() => setRange(d.key)}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </div>
            {cities.length > 1 && (
              <div className="home-filter-group">
                <p className="home-filter-label">Ciudad</p>
                <div className="home-filter-city">
                  <select
                    value={city}
                    onChange={(ev) => setCity(ev.target.value)}
                    aria-label="Filtrar por ciudad"
                  >
                    <option value="">Todas las ciudades</option>
                    {cities.map(([name]) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Banda cinética: entre el troquel y la rejilla. Decorativa
            (aria-hidden). Antes repetía los nombres de las categorías que están
            justo encima en los chips; ahora lleva sellos de confianza y las
            ciudades con oferta real. La lista va duplicada para que el loop sea
            continuo (el keyframe mueve -50%). */}
        <div className="home-ticker" aria-hidden="true">
          <div className="home-ticker-track">
            {tickerWords.concat(tickerWords).map((w, i) => (
              <span key={`${w}-${i}`}>{w}</span>
            ))}
          </div>
        </div>

        {/* Región viva: anuncia el resultado de filtrar sin mover el foco.
            `polite` espera a que el lector termine la frase en curso (buscar
            mientras se escribe no debe interrumpir). El nodo queda siempre en el
            DOM —si se montara solo al haber texto, el lector no lo reconocería
            como región y no anunciaría nada—; solo cambia su contenido. */}
        <p className="sr-only" role="status" aria-live="polite">
          {anuncio}
        </p>

        {error ? (
          <div className="home-empty">
            <span className="enty-spark" aria-hidden="true">
              <Star size={20} color="#BB5CF6" />
            </span>
            <p>No pudimos cargar la cartelera</p>
            <span>{error}</span>
            <button
              type="button"
              className="btn-ghost mt-3"
              onClick={() => setReload((n) => n + 1)}
            >
              Reintentar
            </button>
          </div>
        ) : !data ? (
          <div className="home-grid">
            <div className="enty-skel" style={{ height: "16.4rem" }} />
            <div className="home-list">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="enty-skel" style={{ height: "5.4rem" }} />
              ))}
            </div>
          </div>
        ) : !featured ? (
          <div className="home-empty">
            <span className="enty-spark" aria-hidden="true">
              <Star size={20} color="#00E6AB" />
            </span>
            <p>{narrowed ? "Sin resultados" : "No hay eventos próximos"}</p>
            <span>
              {narrowed
                ? "Prueba con otro nombre, categoría, fecha o ciudad."
                : "Vuelve pronto: la cartelera se actualiza cada semana."}
            </span>
            {narrowed ? (
              <button
                type="button"
                className="btn-ghost mt-3"
                onClick={resetFilters}
              >
                Ver todos los eventos
              </button>
            ) : (
              <button
                type="button"
                className="btn-ghost mt-3"
                onClick={() => setReload((n) => n + 1)}
              >
                Actualizar cartelera
              </button>
            )}
          </div>
        ) : (
          <div className="home-grid">
            {!explorar && (
            <TransitionLink to={`/evento/${featured.id}`} className="home-feature">
              {/* El flyer del destacado es el LCP de la vitrina: se pide ya y con
                  prioridad alta en vez de competir con el resto de la página. */}
              {/* Sin flyer el cartel se tiñe con el violeta de la casa (CSS):
                  antes eran trazos neón verde/rosa del lienzo nocturno, que
                  sobre papel se leían como ruido. */}
              {featured.flyer_url ? (
                <img
                  className="home-feature-flyer transition-opacity duration-300"
                  src={featured.flyer_url}
                  alt=""
                  loading="eager"
                  fetchPriority="high"
                  decoding="async"
                />
              ) : null}
              {/* El anillo de aforo solo se pinta cuando el % ya es una señal
                  ("casi lleno"). Con el aforo bajo, "1% VENDIDO" ocupaba el
                  sitio más visible del hero sin informar nada. */}
              {!featured.flyer_url && heroCasiLleno && <SoldRing pct={heroPct} />}
              <div className="home-feature-body">
                <div className="home-feature-top">
                  <span className="home-eyebrow">
                    Destacado
                    {isToday(featured.starts_at) && <b className="home-badge-hoy">HOY</b>}
                    {heroCasiLleno && <b className="home-badge-sold">{heroPct}% vendido</b>}
                  </span>
                  {/* h2: el h1 de la página es el titular visible de arriba
                      (siempre presente). El destacado ES el nombre del evento,
                      pero la jerarquía de documento necesita un h1 que no
                      dependa de que existan eventos publicados. */}
                  <h2>{featured.name}</h2>
                  {/* La fecha sube a su propia línea, grande: es el dato que más
                      decide la compra y antes iba en 12px junto a la dirección. */}
                  <p className="home-feature-when">
                    <b>{longDateParts(featured.starts_at, featured.timezone).day}</b>
                    <i>{longDateParts(featured.starts_at, featured.timezone).time}</i>
                  </p>
                </div>
                <div className="home-feature-bottom">
                  <span className="home-feature-meta">
                    {featured.where}
                    <b>{priceLabel(featured.price_cents)}</b>
                  </span>
                  <span className="home-cta">
                    Ver boletos
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M5 12h13M13 6l6 6-6 6" />
                    </svg>
                  </span>
                </div>
              </div>
            </TransitionLink>
            )}

            {/* El troquel: la línea perforada de la boletería separa el
                destacado de la lista — el mismo corte que la entrada. Solo
                cuando hay destacado que separar. */}
            {!explorar && <span className="enty-perf" aria-hidden="true" />}

            {/* "Próximos" solo cuando HAY lista. Con un único evento el hero
                ES toda la cartelera y el encabezado quedaba colgando sobre un
                `.home-list` de 0px: la página prometía una lista inexistente. */}
            {rest.length > 0 && (
              <div className="home-subhead">
                <span>{explorar ? "Todos los eventos" : "Próximos"}</span>
                <TransitionLink to="/boletas">Mis boletos</TransitionLink>
              </div>
            )}

            <div className="home-list">
              {rest.map((e) => {
                const b = dayBadge(e.starts_at, e.timezone);
                const fav = favs.has(e.id);
                return (
                  <div key={e.id} className="home-row">
                    <TransitionLink to={`/evento/${e.id}`} className="home-row-main">
                      <span className="home-row-thumb">
                        {e.flyer_url ? (
                          <img
                            src={e.flyer_url}
                            alt=""
                            loading="lazy"
                            decoding="async"
                          />
                        ) : (
                          <span className="home-row-thumb-date">
                            <em className="home-row-thumb-wd">{b.wd}</em>
                            <b>{b.day}</b>
                            <i>{b.month}</i>
                          </span>
                        )}
                      </span>
                      {/* El precio va DENTRO de la información: como columna
                          propia se comía ~60px de la fila y en móvil el nombre
                          del evento se cortaba a 13 caracteres. En la tarjeta
                          de escritorio el resultado es el mismo (todo apilado). */}
                      <span className="home-row-info">
                        <strong>{e.name}</strong>
                        <em>
                          <span className="home-row-when">{shortDate(e.starts_at, e.timezone)} · </span>
                          {timeLabel(e.starts_at, e.timezone)} · {e.where}
                        </em>
                        <span className="home-row-price">{priceLabel(e.price_cents)}</span>
                      </span>
                    </TransitionLink>
                    <button
                      type="button"
                      className={"home-row-fav transition-colors" + (fav ? " is-on" : "") + (favPop === e.id ? " is-pop" : "")}
                      aria-label={fav ? `Quitar ${e.name} de favoritos` : `Guardar ${e.name} en favoritos`}
                      aria-pressed={fav}
                      onClick={() => toggleFav(e.id)}
                    >
                      <Heart filled={fav} />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

      </main>

      <footer className="home-foot">
        <p className="home-foot-brand">
          <span>Enty</span>
          <i aria-hidden="true" />
        </p>
        <nav className="home-foot-links" aria-label="Enlaces legales">
          <TransitionLink to="/terminos">Términos</TransitionLink>
          <TransitionLink to="/privacidad">Privacidad</TransitionLink>
        </nav>
      </footer>

      <FanNav active={explorar ? "explorar" : "inicio"} />
    </div>
  );
}
