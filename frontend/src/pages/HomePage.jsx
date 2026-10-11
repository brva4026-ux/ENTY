import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { fetchPublicEvents } from "../lib/api";
import { money } from "../lib/format";
import { forceDarkOnce } from "../lib/theme";

/**
 * Inicio — la cara publica de Enty para el fan (mockup "1 · Inicio").
 *
 * Es un catalogo de descubrimiento SIN login: lista los eventos con venta
 * abierta (`published`/`live`, futuros) que devuelve /public/events, con su
 * categoria inferida, precio minimo y aforo vendido. El look es editorial y
 * nocturno (Sora en peso 300, fondo negro, acento violeta), hermano sobrio de
 * la boleta coleccionable: la boleta es el objeto, esto es la vitrina.
 *
 * Navegacion: cada evento enlaza a /t#<token> cuando se comparte, pero desde
 * el catalogo aun no hay token (el invitado no ha comprado): por ahora el CTA
 * es informativo. Cuando exista checkout publico, apunta ahi.
 */

const MONTHS = ["ENE", "FEB", "MAR", "ABR", "MAY", "JUN", "JUL", "AGO", "SEP", "OCT", "NOV", "DIC"];
const WEEKDAYS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];

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

/** Día y mes para el badge de la lista. */
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

const NAV = [
  { key: "inicio", label: "Inicio", active: true, to: "/inicio" },
  { key: "explorar", label: "Explorar", active: false, to: "/inicio" },
  { key: "boletos", label: "Boletos", active: false, to: "/t" },
  { key: "perfil", label: "Perfil", active: false, to: "/login" },
];

function NavIcon({ name }) {
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
  if (name === "inicio")
    return (
      <svg {...common}>
        <path d="M4 11l8-7 8 7v9a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z" />
      </svg>
    );
  if (name === "explorar")
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="9" />
        <path d="M15.5 8.5l-2 5-5 2 2-5z" />
      </svg>
    );
  if (name === "boletos")
    return (
      <svg {...common}>
        <path d="M3 9a2 2 0 0 0 0 6v3a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-3a2 2 0 0 1 0-6V6a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1z" />
        <path d="M14 5v14" strokeDasharray="2 3" />
      </svg>
    );
  return (
    <svg {...common}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 3.6-6 8-6s8 2 8 6" />
    </svg>
  );
}

export default function HomePage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("Todo");
  // La vitrina es nocturna por diseno (negro + violeta). Sin el candado, un
  // visitante con tema claro veia la cartelera como una tarjeta negra sobre
  // blanco: el tema del sistema no aplica a una pantalla publica de marca.
  useEffect(() => forceDarkOnce(), []);

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
  const tabs = useMemo(() => ["Todo", ...(data?.categories ?? [])], [data]);
  const shown = useMemo(
    () => (tab === "Todo" ? events : events.filter((e) => e.category === tab)),
    [events, tab],
  );
  const featured = shown[0] ?? null;
  const rest = shown.slice(1, 4);
  const priceLabel = (c) => (c == null ? "Gratis" : money(c));

  return (
    <div className="home">
      <header className="home-head">
        <div className="home-wordmark">
          <span>Enty</span>
          <Star />
        </div>
        <Link to="/login" className="home-avatar" aria-label="Entrar">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
            <circle cx="12" cy="8" r="4" />
            <path d="M4 21c0-4 3.6-6 8-6s8 2 8 6" />
          </svg>
        </Link>
      </header>

      <div className="home-title">
        <h1>Esta semana</h1>
        <p>
          {data?.city || "Tu ciudad"} · {data?.count ?? 0} evento
          {(data?.count ?? 0) === 1 ? "" : "s"}
        </p>
      </div>

      <div role="tablist" aria-label="Categorías" className="home-tabs">
        {tabs.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={t === tab}
            onClick={() => setTab(t)}
            className={t === tab ? "is-on" : ""}
          >
            {t}
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
          <p>No hay eventos próximos</p>
          <span>Vuelve pronto: la cartelera se actualiza cada semana.</span>
        </div>
      ) : (
        <>
          <article className="home-feature">
            {featured.flyer_url ? (
              <img className="home-feature-flyer" src={featured.flyer_url} alt="" />
            ) : (
              <SoldRing pct={featured.sold_pct} />
            )}
            <div className="home-feature-body">
              <div className="home-feature-top">
                <span className="home-eyebrow">Destacado</span>
                <h2>{featured.name}</h2>
              </div>
              <div className="home-feature-bottom">
                <span className="home-feature-meta">
                  {shortDate(featured.starts_at, featured.timezone)} · {featured.where}
                  <b>{priceLabel(featured.price_cents)}</b>
                </span>
                <Link to="/login" className="home-cta">
                  Comprar boletos
                </Link>
              </div>
            </div>
          </article>

          <div className="home-subhead">
            <span>Próximos</span>
            <button type="button" onClick={() => setTab("Todo")}>
              Ver todo
            </button>
          </div>

          <div className="home-list">
            {rest.map((e) => {
              const b = dayBadge(e.starts_at, e.timezone);
              return (
                <Link key={e.id} to="/login" className="home-row">
                  <span className="home-row-date">
                    <b>{b.day}</b>
                    <i>{b.month}</i>
                  </span>
                  <span className="home-row-info">
                    <strong>{e.name}</strong>
                    <em>{e.where}</em>
                  </span>
                  <span className="home-row-price">{priceLabel(e.price_cents)}</span>
                </Link>
              );
            })}
          </div>
        </>
      )}

      <nav className="home-nav" aria-label="Navegación principal">
        {NAV.map((n) => (
          <Link key={n.key} to={n.to} className={n.active ? "is-on" : ""}>
            <NavIcon name={n.key} />
            {n.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
