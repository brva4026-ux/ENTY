import { useEffect, useMemo, useState } from "react";
import { useTabKeys } from "../lib/useTabKeys";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { fetchPublicEventDetail } from "../lib/api";
import FanCheckoutModal from "../components/FanCheckoutModal";
import { money } from "../lib/format";
import { forceDarkOnce } from "../lib/theme";
import { track } from "../lib/analytics";
import useDocumentTitle from "../lib/useDocumentTitle";

/**
 * Detalle del evento — la pantalla de decision de compra (mockup "2").
 *
 * Publica y sin login, hermana de Inicio: se llega al tocar un evento del
 * catalogo (`/evento/:id`). Hero de imagen que se funde con el negro, grid de
 * datos (fecha / ubicacion / precio), CTA y tres pestanas.
 *
 * Tabs: "Descripcion" sale de `events.description`. "Ubicacion" usa un mapa
 * de OpenStreetMap incrustado en modo oscuro (filtro CSS, sin API key ni
 * coordenadas: busca por el texto del lugar). "Lineup" no tiene datos todavia
 * (el modelo no tiene artistas): muestra un estado "por anunciar" honesto en
 * vez de inventar cabezas de cartel.
 *
 * Compra: el CTA abre el checkout público (sin cuenta). El fan elige
 * localidad, deja su contacto y paga en Wompi; al volver, `?pago=<reference>`
 * reabre el modal en modo confirmación (sondeo del estado) y la boleta se
 * reclama por contacto en Mis boletos.
 */

const FAVS_KEY = "tf_fan_favs";

function longDate(iso, tz) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: "—", time: "" };
  const parts = new Intl.DateTimeFormat("es-CO", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: tz || undefined,
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? "";
  const wd = get("weekday").replace(".", "");
  const date = `${wd.charAt(0).toUpperCase()}${wd.slice(1)} ${get("day")} ${get("month").replace(".", "")}`;
  const time = new Intl.DateTimeFormat("es-CO", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: tz || undefined,
  }).format(d);
  return { date, time };
}

function Icon({ name, className = "" }) {
  const common = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
    className,
  };
  if (name === "back")
    return (
      <svg {...common}>
        <path d="M15 5l-7 7 7 7" />
      </svg>
    );
  if (name === "heart")
    return (
      <svg {...common}>
        <path d="M12 20s-7-4.6-7-9.5A3.9 3.9 0 0 1 12 7a3.9 3.9 0 0 1 7 3.5C19 15.4 12 20 12 20z" />
      </svg>
    );
  if (name === "share")
    return (
      <svg {...common}>
        <circle cx="18" cy="5" r="2.6" />
        <circle cx="6" cy="12" r="2.6" />
        <circle cx="18" cy="19" r="2.6" />
        <path d="M8.4 10.8l7.2-4.2M8.4 13.2l7.2 4.2" />
      </svg>
    );
  if (name === "calendar")
    return (
      <svg {...common}>
        <rect x="3.5" y="5" width="17" height="16" rx="2.5" />
        <path d="M3.5 9.5h17M8 3v4M16 3v4" />
      </svg>
    );
  if (name === "pin")
    return (
      <svg {...common}>
        <path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11z" />
        <circle cx="12" cy="10" r="2.6" />
      </svg>
    );
  // tag
  return (
    <svg {...common}>
      <path d="M20 12.5L12.5 20a2 2 0 0 1-2.8 0l-6-6a2 2 0 0 1 0-2.8L11 3.7h6a3 3 0 0 1 3 3z" />
      <circle cx="16" cy="8" r="1.2" />
    </svg>
  );
}

function readFavs() {
  try {
    const arr = JSON.parse(localStorage.getItem(FAVS_KEY) || "[]");
    return new Set(Array.isArray(arr) ? arr.map(Number) : []);
  } catch {
    return new Set();
  }
}

export default function EventDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("descripcion");
  const evdTabs = useTabKeys({
    ids: ["descripcion", "lineup", "ubicacion"],
    activeId: tab,
    onSelect: setTab,
    idOf: (k) => `evd-tab-${k}`,
  });
  const [fav, setFav] = useState(false);
  const [favPop, setFavPop] = useState(false);
  const [copied, setCopied] = useState(false);
  const [coords, setCoords] = useState(null);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  useDocumentTitle(data?.name);

  // Referencia del checkout al volver de Wompi (redirect_url del cobro).
  const payRef = searchParams.get("pago");

  /** Acciones del cartel (volver, favorito, compartir). Se renderizan dos
   *  veces — sobre el hero en móvil y sobre el cartel en escritorio — pero solo
   *  una es visible según el breakpoint (la otra queda display:none). Es una
   *  función de render, no un componente anidado: así no se remonta en cada
   *  render ni pierde el foco. */
  function posterActions() {
    return (
      <>
        <button
          type="button"
          className="evd-round"
          aria-label="Volver"
          onClick={() => navigate(-1)}
        >
          <Icon name="back" className="h-5 w-5" />
        </button>
        <div className="evd-hero-actions-right">
          <button
            type="button"
            className={`evd-round${fav ? " is-on" : ""}${favPop ? " is-pop" : ""}`}
            aria-label={fav ? "Quitar de favoritos" : "Guardar en favoritos"}
            aria-pressed={fav}
            onClick={toggleFav}
          >
            <Icon name="heart" className="h-5 w-5" />
          </button>
          <button
            type="button"
            className="evd-round"
            aria-label="Compartir"
            onClick={share}
          >
            <Icon name="share" className="h-5 w-5" />
          </button>
        </div>
      </>
    );
  }

  useEffect(() => {
    const restore = forceDarkOnce();
    return restore;
  }, []);

  useEffect(() => {
    let alive = true;
    setData(null);
    setError("");
    fetchPublicEventDetail(id)
      .then((d) => {
        if (alive) setData(d);
      })
      .catch((e) => {
        if (alive) setError(e.status === 404 ? "Este evento ya no está disponible." : e.message);
      });
    return () => {
      alive = false;
    };
  }, [id]);

  useEffect(() => {
    if (data) setFav(readFavs().has(Number(data.id)));
  }, [data]);

  // Embudo, paso 2: abrió este evento. Se dispara una sola vez por id, aunque
  // la pantalla se re-renderice por favoritos o pestañas.
  useEffect(() => {
    if (data) track("view_event", { eventId: Number(data.id) });
  }, [data]);

  // Geocodificacion best-effort del lugar (Nominatim, sin API key). Solo se
  // dispara al abrir la pestana Ubicacion; si falla, el mapa no aparece y
  // queda la direccion en texto — nunca bloquea la pantalla.
  useEffect(() => {
    if (tab !== "ubicacion" || coords || !data) return;
    const q = [data.venue, data.location].filter(Boolean).join(", ");
    if (!q) return;
    let alive = true;
    fetch(
      `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`,
    )
      .then((r) => (r.ok ? r.json() : []))
      .then((arr) => {
        if (!alive || !arr?.[0]) return;
        const lat = Number(arr[0].lat);
        const lon = Number(arr[0].lon);
        if (Number.isFinite(lat) && Number.isFinite(lon)) setCoords({ lat, lon });
      })
      .catch(() => {
        /* sin mapa: la direccion en texto sigue */
      });
    return () => {
      alive = false;
    };
  }, [tab, coords, data]);

  const when = useMemo(
    () => (data ? longDate(data.starts_at, data.timezone) : { date: "—", time: "" }),
    [data],
  );

  function toggleFav() {
    if (!data) return;
    const next = !fav;
    setFav(next);
    setFavPop(next);
    try {
      const set = readFavs();
      if (next) set.add(Number(data.id));
      else set.delete(Number(data.id));
      localStorage.setItem(FAVS_KEY, JSON.stringify([...set]));
    } catch {
      /* modo privado */
    }
  }

  async function share() {
    const url = window.location.href;
    const payload = { title: data?.name, text: data?.name, url };
    try {
      if (navigator.share) {
        await navigator.share(payload);
        return;
      }
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* el usuario canceló o el navegador no soporta: sin ruido */
    }
  }

  // Mapa: OSM incrustado (sin API key). El pin lo dibuja Enty encima del
  // centro (el embed no acepta marcador por URL); se tiñe oscuro con CSS.
  const mapSrc = coords
    ? `https://www.openstreetmap.org/export/embed.html?bbox=${encodeURIComponent(
        `${coords.lon - 0.004},${coords.lat - 0.003},${coords.lon + 0.004},${coords.lat + 0.003}`,
      )}&layer=mapnik&marker=${encodeURIComponent(`${coords.lat},${coords.lon}`)}`
    : "";

  // Cierra el checkout. Si venimos de Wompi con ?pago=, limpia ese parametro
  // de la URL (replace: sin dejar historial) para no reabrir el modal al
  // recargar.
  function closeCheckout() {
    setCheckoutOpen(false);
    if (payRef) {
      const next = new URLSearchParams(searchParams);
      next.delete("pago");
      setSearchParams(next, { replace: true });
    }
  }

  return (
    <div className="evd">
      {/* Hero a sangre: solo en móvil/tablet. En escritorio el cartel pasa a
          la columna izquierda (ver .evd-poster). */}
      <div className="evd-hero">
        {data?.flyer_url ? (
          <img
            src={data.flyer_url}
            alt=""
            loading="eager"
            fetchPriority="high"
            decoding="async"
          />
        ) : (
          <div className="evd-hero-fallback" aria-hidden="true" />
        )}
        <div className="evd-hero-actions">
          {posterActions()}
        </div>
      </div>

      {error ? (
        <div className="evd-empty">
          <p>{error}</p>
          <Link to="/inicio" className="evd-cta">Volver al inicio</Link>
        </div>
      ) : !data ? (
        <div className="evd-empty">
          <p>Cargando…</p>
        </div>
      ) : (
        <div className="evd-body">
          {/* Columna izquierda (escritorio): el cartel del evento, pegajoso. */}
          <div className="evd-poster">
            <div className="evd-poster-frame">
              {data.flyer_url ? (
                <img
                  src={data.flyer_url}
                  alt=""
                  loading="lazy"
                  decoding="async"
                />
              ) : (
                <div className="evd-hero-fallback" aria-hidden="true" />
              )}
              <div className="evd-hero-actions">
                {posterActions()}
              </div>
            </div>
          </div>

          {/* Columna derecha: identidad, datos, compra y pestañas. */}
          <div className="evd-info">
            <p className="evd-eyebrow">{data.category}</p>
            <h1 className="evd-title">{data.name}</h1>
            <p className="evd-sub">{data.where}</p>

            <div className="evd-grid">
              <div className="evd-cell">
                <Icon name="calendar" className="evd-cell-icon" />
                <span className="evd-cell-k">Fecha</span>
                <span className="evd-cell-v">{when.date}</span>
                {when.time && <span className="evd-cell-sub">{when.time}</span>}
              </div>
              <div className="evd-cell">
                <Icon name="pin" className="evd-cell-icon" />
                <span className="evd-cell-k">Ubicación</span>
                <span className="evd-cell-v">{data.venue || data.location || "—"}</span>
                {data.location && data.venue && (
                  <span className="evd-cell-sub">{data.location}</span>
                )}
              </div>
              <div className="evd-cell">
                <Icon name="tag" className="evd-cell-icon" />
                <span className="evd-cell-k">Precio</span>
                <span className="evd-cell-v">
                  {data.price_cents == null ? "Gratis" : money(data.price_cents)}
                </span>
                <span className="evd-cell-sub">desde</span>
              </div>
            </div>

            {/* Rail de compra: el canto troquelado del boleto. El precio se
                repite aquí en grande — la decisión no obliga a scrollear. */}
            <div className="evd-buy enty-notch">
              <div className="evd-buy-row">
                <span className="evd-buy-label">Entrada desde</span>
                <span className="evd-buy-price tnum">
                  {data.price_cents == null ? "Gratis" : money(data.price_cents)}
                </span>
              </div>
              <p className="evd-buy-note">
                {data.sold_out
                  ? "Agotado. Entra a la lista de espera: si alguien devuelve su boleta, te avisamos."
                  : data.price_cents == null
                    ? "Cortesía: el acceso se valida con QR en la puerta."
                    : "Compra en línea y recibe tu QR para la puerta."}
              </p>
              {data.sold_out ? (
                <Link
                  to={`/waitlist?event=${data.id}`}
                  className="evd-cta evd-cta--wide"
                >
                  Entrar a la lista de espera
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M5 12h13M13 6l6 6-6 6" />
                  </svg>
                </Link>
              ) : data.price_cents == null ? (
                <Link to="/boletas" className="evd-cta evd-cta--wide">
                  Ver mis boletas
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M5 12h13M13 6l6 6-6 6" />
                  </svg>
                </Link>
              ) : (
                <button
                  type="button"
                  className="evd-cta evd-cta--wide"
                  onClick={() => {
                    // Embudo, paso 3: intención real de compra (abre el pago).
                    track("checkout_start", { eventId: Number(data.id) });
                    setCheckoutOpen(true);
                  }}
                >
                  Comprar boleto
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M5 12h13M13 6l6 6-6 6" />
                  </svg>
                </button>
              )}
            </div>

            <div role="tablist" aria-label="Detalles" className="evd-tabs">
              {[
                ["descripcion", "Descripción"],
                ["lineup", "Lineup"],
                ["ubicacion", "Ubicación"],
              ].map(([k, label]) => (
                <button
                  key={k}
                  id={`evd-tab-${k}`}
                  role="tab"
                  aria-selected={tab === k}
                  aria-controls={`evd-panel-${k}`}
                  tabIndex={tab === k ? 0 : -1}
                  onKeyDown={evdTabs.onKeyDown}
                  className={tab === k ? "is-on" : ""}
                  onClick={() => setTab(k)}
                >
                  {label}
                </button>
              ))}
            </div>

            <div
              className="evd-tabbody"
              role="tabpanel"
              id={`evd-panel-${tab}`}
              aria-labelledby={`evd-tab-${tab}`}
              tabIndex={0}
            >
              {tab === "descripcion" &&
                (data.description ? (
                  <p className="evd-prose">{data.description}</p>
                ) : (
                  <p className="evd-muted">El organizador todavía no publicó la descripción.</p>
                ))}

              {tab === "lineup" &&
                (data.lineup?.length ? (
                  <ul className="evd-lineup">
                    {data.lineup.map((a) => (
                      <li key={a.name}>
                        <span className="evd-lineup-avatar" aria-hidden="true">
                          {a.name.charAt(0)}
                        </span>
                        <span className="evd-lineup-info">
                          <strong>{a.name}</strong>
                          {a.role && <em>{a.role}</em>}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="evd-muted">Lineup por anunciar.</p>
                ))}

              {tab === "ubicacion" && (
                <div className="evd-map-wrap">
                  {mapSrc ? (
                    <div className="evd-map-frame">
                      <iframe
                        className="evd-map"
                        title={`Mapa de ${data.venue || data.name}`}
                        src={mapSrc}
                        loading="lazy"
                        referrerPolicy="no-referrer-when-downgrade"
                      />
                      <span className="evd-map-pin" aria-hidden="true">
                        <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M12 22s7.5-6.6 7.5-11.7A7.5 7.5 0 1 0 4.5 10.3C4.5 15.4 12 22 12 22z" fill="#7C3AED" stroke="#fff" strokeWidth="1.4" />
                          <circle cx="12" cy="10" r="2.7" fill="#fff" />
                        </svg>
                      </span>
                    </div>
                  ) : (
                    <div className="evd-map-skeleton" aria-hidden="true" />
                  )}
                  <p className="evd-address">
                    <Icon name="pin" className="h-4 w-4" />
                    {[data.venue, data.location].filter(Boolean).join(" · ") || "Ubicación por confirmar"}
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {copied && <p className="evd-copied">Enlace copiado</p>}

      {(checkoutOpen || payRef) && data && (
        <FanCheckoutModal
          event={data}
          reference={payRef}
          onClose={closeCheckout}
          onPaid={() => {
            closeCheckout();
            navigate("/boletas");
          }}
        />
      )}
    </div>
  );
}
