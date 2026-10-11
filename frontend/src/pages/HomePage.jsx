import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { fetchPublicEvents } from "../lib/api";
import { money } from "../lib/format";
import { forceDarkOnce } from "../lib/theme";
import FanNav from "../components/FanNav";

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

/** Día y mes para el badge de la miniatura. */
function dayBadge(iso, tz) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { day: "--", month: "---" };
  const parts = new Intl.DateTimeFormat("es-CO", {
    day: "2-digit",
    month: "numeric",
    timeZone: tz || undefined,
  }).formatToParts(d);
  const day = parts.find((p) => p.type === "day")?.value ?? "--";
  const monthNum = Number(parts.find((p) => p.type === "month")?.value ?? 1);
  return { day, month: MONTHS[monthNum - 1] ?? "---" };
}

/** Estrella de cuatro puntas (acento de marca). */
function Star({ size = 8, color = "#8B5CF6" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 0 L14.6 9.4 L24 12 L14.6 14.6 L12 24 L9.4 14.6 L0 12 L9.4 9.4 Z" fill={color} />
    </svg>
  );
}

/**
 * Trazos organicos neon (verde/rosa) que barren detras de la tarjeta de
 * cristal. Son asimetricos y finos a proposito: rompen la rigidez de la
 * cuadricula sin competir con el contenido (energia grafica, no interfaz).
 */
function NeonStrokes() {
  return (
    <svg
      className="home-strokes"
      viewBox="0 0 342 262"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      <defs>
        <filter id="sGlow" x="-30%" y="-60%" width="160%" height="220%">
          <feGaussianBlur stdDeviation="3.4" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <path
        d="M-10 214 C 70 150, 150 236, 250 150 S 352 92, 356 74"
        fill="none"
        stroke="#00E6AB"
        strokeWidth="2.4"
        strokeLinecap="round"
        filter="url(#sGlow)"
        opacity="0.9"
      />
      <path
        d="M-6 60 C 96 96, 150 8, 262 46"
        fill="none"
        stroke="#FF2D98"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeDasharray="1 7"
        filter="url(#sGlow)"
        opacity="0.85"
      />
    </svg>
  );
}

/** Anillo de progreso: aforo vendido del evento destacado. */
function SoldRing({ pct }) {
  const r = 42;
  const c = 2 * Math.PI * r;
  const shown = Math.max(0, Math.min(100, pct ?? 0));
  return (
    <svg className="home-ring" viewBox="0 0 342 262" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <radialGradient id="hGlow" cx="0.82" cy="0.18" r="0.7">
          <stop offset="0" stopColor="#8B5CF6" stopOpacity="0.34" />
          <stop offset="1" stopColor="#8B5CF6" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="hFade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0.35" stopColor="#101012" stopOpacity="0" />
          <stop offset="1" stopColor="#101012" stopOpacity="0.9" />
        </linearGradient>
      </defs>
      <rect width="342" height="262" fill="url(#hGlow)" />
      <g fill="none" stroke="#fff">
        <circle cx="266" cy="86" r="74" strokeOpacity="0.07" />
        <circle cx="266" cy="86" r="58" strokeOpacity="0.1" strokeDasharray="1 6.2" />
        <circle cx="266" cy="86" r="42" strokeOpacity="0.07" />
      </g>
      <circle
        cx="266"
        cy="86"
        r={r}
        fill="none"
        stroke="#B7A3FF"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={`${(shown / 100) * c} ${c}`}
        transform="rotate(-90 266 86)"
      />
      <text x="266" y="92" textAnchor="middle" fontSize="22" fontWeight="300" fill="#F3F1EC" letterSpacing="-1">
        {shown}%
      </text>
      <text x="266" y="108" textAnchor="middle" fontSize="7.5" fill="#8A8A93" letterSpacing="1.6">
        VENDIDO
      </text>
      <rect width="342" height="262" fill="url(#hFade)" />
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

export default function HomePage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [cat, setCat] = useState("todos");
  const [query, setQuery] = useState("");
  const [favs, setFavs] = useState(() => new Set());
  const [bellOpen, setBellOpen] = useState(false);
  // La vitrina es nocturna por diseno (negro + violeta). Sin el candado, un
  // visitante con tema claro veia la cartelera como una tarjeta negra sobre
  // blanco: el tema del sistema no aplica a una pantalla publica de marca.
  useEffect(() => forceDarkOnce(), []);

  useEffect(() => setFavs(readFavs()), []);

  // Ciudad opcional por URL (?city=Bogotá): permite enlazar/compartir una
  // cartelera por ciudad sin cuenta. Sin parametro, el catalogo completo.
  const cityFilter = useMemo(() => {
    const c = new URLSearchParams(window.location.search).get("city");
    return c && c.trim() ? c.trim() : undefined;
  }, []);

  useEffect(() => {
    let alive = true;
    fetchPublicEvents({ limit: 50, city: cityFilter })
      .then((d) => {
        if (alive) setData(d);
      })
      .catch((e) => {
        if (alive) setError(e.message || "No pudimos cargar los eventos");
      });
    return () => {
      alive = false;
    };
  }, [cityFilter]);

  const events = data?.events ?? [];
  const chip = CATEGORY_CHIPS.find((c) => c.key === cat) ?? CATEGORY_CHIPS[0];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return events.filter((e) => {
      if (!chip.match(e)) return false;
      if (!q) return true;
      return (
        e.name.toLowerCase().includes(q) ||
        (e.venue ?? "").toLowerCase().includes(q) ||
        (e.location ?? "").toLowerCase().includes(q)
      );
    });
  }, [events, chip, query]);

  const featured = filtered[0] ?? null;
  const rest = filtered.slice(1);

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
  }

  const priceLabel = (c) => (c == null ? "Gratis" : money(c));

  return (
    <div className="home">
      <header className="home-head">
        <div className="home-wordmark">
          <span>Enty</span>
          <Star />
        </div>
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
      </header>

      {bellOpen && (
        <div className="home-bell-panel" role="dialog" aria-label="Avisos">
          <p className="home-bell-title">Próximos 7 días</p>
          {soon.length === 0 ? (
            <p className="home-bell-empty">Sin eventos a la vuelta de la esquina.</p>
          ) : (
            <ul>
              {soon.slice(0, 4).map((e) => (
                <li key={e.id}>
                  <Link to={`/evento/${e.id}`} onClick={() => setBellOpen(false)}>
                    <strong>{e.name}</strong>
                    <em>{shortDate(e.starts_at, e.timezone)} · {e.where}</em>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="home-search">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="M20 20l-3.5-3.5" />
        </svg>
        <input
          type="search"
          value={query}
          onChange={(ev) => setQuery(ev.target.value)}
          placeholder="Busca conciertos, eventos, artistas…"
          aria-label="Buscar eventos"
        />
      </div>

      <div role="tablist" aria-label="Categorías" className="home-cats">
        {CATEGORY_CHIPS.map((c) => (
          <button
            key={c.key}
            role="tab"
            aria-selected={c.key === cat}
            onClick={() => setCat(c.key)}
            className={c.key === cat ? "is-on" : ""}
          >
            <span className="home-cat-dot">
              {c.icon ? <CatIcon name={c.icon} /> : <Star size={16} color="currentColor" />}
            </span>
            {c.label}
          </button>
        ))}
      </div>

      {error ? (
        <div className="home-empty">
          <p>No pudimos cargar los eventos</p>
          <span>{error}</span>
        </div>
      ) : !data ? (
        <div className="home-empty">
          <p>Cargando cartelera…</p>
        </div>
      ) : !featured ? (
        <div className="home-empty">
          <p>{query ? "Sin resultados" : "No hay eventos próximos"}</p>
          <span>
            {query
              ? "Prueba con otro nombre, artista o ciudad."
              : "Vuelve pronto: la cartelera se actualiza cada semana."}
          </span>
        </div>
      ) : (
        <>
          <Link to={`/evento/${featured.id}`} className="home-feature">
            {featured.flyer_url ? (
              <img className="home-feature-flyer" src={featured.flyer_url} alt="" />
            ) : (
              <>
                <NeonStrokes />
                <SoldRing pct={featured.sold_pct} />
              </>
            )}
            <div className="home-feature-body">
              <div className="home-feature-top">
                <span className="home-eyebrow">Featured</span>
                <h2>{featured.name}</h2>
              </div>
              <div className="home-feature-bottom">
                <span className="home-feature-meta">
                  {shortDate(featured.starts_at, featured.timezone)} · {featured.where}
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
          </Link>

          <div className="home-subhead">
            <span>Próximos</span>
            <Link to="/boletas">Mis boletos</Link>
          </div>

          <div className="home-list">
            {rest.map((e) => {
              const b = dayBadge(e.starts_at, e.timezone);
              const fav = favs.has(e.id);
              return (
                <div key={e.id} className="home-row">
                  <Link to={`/evento/${e.id}`} className="home-row-main">
                    <span className="home-row-thumb">
                      {e.flyer_url ? (
                        <img src={e.flyer_url} alt="" />
                      ) : (
                        <span className="home-row-thumb-date">
                          <b>{b.day}</b>
                          <i>{b.month}</i>
                        </span>
                      )}
                    </span>
                    <span className="home-row-info">
                      <strong>{e.name}</strong>
                      <em>{shortDate(e.starts_at, e.timezone)} · {e.where}</em>
                    </span>
                    <span className="home-row-price">{priceLabel(e.price_cents)}</span>
                  </Link>
                  <button
                    type="button"
                    className={`home-row-fav${fav ? " is-on" : ""}`}
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
        </>
      )}

      <FanNav active="inicio" />
    </div>
  );
}
