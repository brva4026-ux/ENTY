import { useEffect, useMemo, useState } from "react";
import { fetchPublicEvents } from "../lib/api";
import { money } from "../lib/format";
import { track } from "../lib/analytics";
import { SITE } from "../lib/site";
import { waLink } from "../lib/whatsapp";
import { Logo } from "../components/Brand";
import TransitionLink from "../components/TransitionLink";
import useDocumentTitle from "../lib/useDocumentTitle";

/**
 * Presentación pública de Enty (la raíz "/").
 *
 * Es la PRIMERA pantalla del producto: quien llega por un enlace compartido o
 * por el QR de un flyer —sin cuenta— tiene que entender qué es Enty, ver qué
 * noches están abiertas y llegar al panel si es del equipo.
 *
 * La composición es deliberadamente calmada: fondo claro cálido, una sola
 * columna centrada, tarjetas blancas con hairline y el violeta de marca como
 * único acento. Nada de una caja flotante en el vacío: la página es la
 * superficie del producto.
 *
 * Las funcionalidades que se anuncian son las que existen de verdad
 * (eventos, cupos, QR, escáner, lista de espera, liquidaciones). Lo único que
 * se pide a la red es la cartelera: si falla, la presentación sigue en pie.
 */

const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

/** Fecha corta legible: "vie 24 oct · 21:00". */
function whenLabel(iso, tz) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Fecha por confirmar";
  const parts = new Intl.DateTimeFormat("es-CO", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: tz || undefined,
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? "";
  const wd = get("weekday").replace(".", "");
  const month = get("month").replace(".", "");
  const cap = wd.charAt(0).toUpperCase() + wd.slice(1);
  return `${cap} ${get("day")} ${month} · ${get("hour")}:${get("minute")}`;
}

/** "24 / OCT" para el sello del boleto. */
function stampLabel(iso, tz) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { day: "--", month: "---" };
  const parts = new Intl.DateTimeFormat("es-CO", {
    day: "2-digit",
    month: "numeric",
    timeZone: tz || undefined,
  }).formatToParts(d);
  const day = parts.find((p) => p.type === "day")?.value ?? "--";
  const m = Number(parts.find((p) => p.type === "month")?.value ?? 1);
  return { day, month: (MONTHS[m - 1] ?? "---").toUpperCase() };
}

/**
 * Las seis funcionalidades que se presentan. Cada una corresponde a algo que
 * la plataforma ya hace; ninguna es una promesa de roadmap.
 */
const FEATURES = [
  {
    icon: "event",
    name: "Eventos y aforo",
    body: "Crea la noche, define localidades con precio y ajusta el aforo por tipo de boleta.",
  },
  {
    icon: "qr",
    name: "Boletas con QR",
    body: "Cada boleta nace con un código único de un solo uso, lista para mostrar en la puerta.",
  },
  {
    icon: "scan",
    name: "Control en puerta",
    body: "Escanea desde el celular, incluso sin señal: los ingresos se sincronizan al volver la red.",
  },
  {
    icon: "people",
    name: "Promotores y cupos",
    body: "Asigna un cupo a cada vendedor y sigue sus ventas sin riesgo de sobreventa.",
  },
  {
    icon: "queue",
    name: "Lista de espera",
    body: "Cuando el aforo se agota, los interesados quedan en fila y reciben el cupo que se libera.",
  },
  {
    icon: "payout",
    name: "Liquidaciones",
    body: "El sistema cuenta las ventas de cada promotor y calcula su comisión al cierre.",
  },
];

/** Línea de confianza: solo cosas que se pueden comprobar en la app. */
const TRUST = [
  "Se entiende sin manual",
  "Todo se actualiza en vivo",
  "Funciona sin señal en la puerta",
  "La información queda ordenada",
];

/** Un mismo trazo para todos los iconos: 24px, 1.6, esquinas redondeadas. */
function FeatureIcon({ name }) {
  const common = {
    width: 22,
    height: 22,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
  };
  switch (name) {
    case "qr":
      return (
        <svg {...common}>
          <rect x="3" y="3" width="7" height="7" rx="1.5" />
          <rect x="14" y="3" width="7" height="7" rx="1.5" />
          <rect x="3" y="14" width="7" height="7" rx="1.5" />
          <path d="M14 14h3v3h-3zM20 20h1M14 20h2M20 14v2" />
        </svg>
      );
    case "scan":
      return (
        <svg {...common}>
          <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" />
          <path d="M4 12h16" />
        </svg>
      );
    case "people":
      return (
        <svg {...common}>
          <circle cx="9" cy="8" r="3.2" />
          <path d="M3.5 20a5.5 5.5 0 0 1 11 0" />
          <path d="M16 5.5a3 3 0 0 1 0 5.8M17.5 20a5.6 5.6 0 0 0-2.2-4.4" />
        </svg>
      );
    case "queue":
      return (
        <svg {...common}>
          <path d="M4 6h10M4 12h10M4 18h7" />
          <path d="M17.5 14.5V20M17.5 14.5l2.5 2M17.5 14.5 15 16.5" />
        </svg>
      );
    case "payout":
      return (
        <svg {...common}>
          <rect x="3" y="6" width="18" height="12" rx="2.5" />
          <path d="M3 10h18" />
          <path d="M7 15h3" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <rect x="3" y="5" width="18" height="16" rx="2.5" />
          <path d="M3 10h18M8 5V3M16 5V3" />
        </svg>
      );
  }
}

function CheckIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m5 12.5 4.5 4.5L19 7" />
    </svg>
  );
}

export default function LandingPage() {
  useDocumentTitle("Boletería, aforo y control de acceso");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    fetchPublicEvents({ limit: 60 })
      .then((d) => {
        if (!alive) return;
        setData(d);
        track("view_landing", { eventCount: (d.events ?? []).length });
      })
      .catch((e) => {
        if (alive) setError(e.message || "No pudimos cargar la cartelera");
      });
    return () => {
      alive = false;
    };
  }, []);

  const events = useMemo(() => {
    const now = Date.now();
    return (data?.events ?? [])
      .filter((e) => {
        const t = new Date(e.starts_at).getTime();
        return !Number.isNaN(t) && t >= now;
      })
      .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
  }, [data]);

  const openEvents = events.slice(0, 4);

  /** "Explorar ENTY" baja a las funcionalidades: el explorar es real, no un
   *  botón decorativo. Se hace con el ancla nativa para que funcione incluso
   *  antes de que React hidrate la página. */
  return (
    <div className="lp">
      <a href="#lp-contenido" className="lp-skip">
        Saltar al contenido
      </a>

      <div className="lp-wrap">
        {/* --- Marca: logotipo centrado + qué es Enty ------------------- */}
        <header className="lp-brand">
          <Logo size="lg" />
          <p className="lp-brand-tag">Boletería, aforo y control de puerta</p>
        </header>

        <main id="lp-contenido">
          {/* --- Titular: qué hace Enty y qué gana quien lo usa --------- */}
          <section className="lp-hero" aria-labelledby="lp-title">
            <h1 id="lp-title" className="lp-title">
              Tu evento, tus boletas y tu puerta,{" "}
              <span className="lp-title-accent">en un solo panel.</span>
            </h1>
            <p className="lp-lede">
              Publica la cartelera, reparte cupos entre promotores, emite boletas
              con QR y valida cada ingreso desde el celular. Ventas y aforo se
              actualizan en vivo, sin cuadernos ni listas en papel.
            </p>

            <div className="lp-cta">
              <a href="#funciones" className="lp-btn lp-btn-primary">
                Explorar ENTY
              </a>
              <TransitionLink to="/login" className="lp-btn lp-btn-secondary">
                Iniciar sesión
              </TransitionLink>
            </div>
          </section>

          {/* --- Funcionalidades reales --------------------------------- */}
          <section
            id="funciones"
            className="lp-features"
            aria-labelledby="lp-features-title"
          >
            <h2 id="lp-features-title" className="lp-h2">
              Todo lo que necesitas para la noche
            </h2>
            <p className="lp-sub">
              Seis herramientas que ya funcionan juntas: la venta, la puerta y la
              cuenta del cierre.
            </p>

            <ul className="lp-grid">
              {FEATURES.map((f, i) => (
                <li
                  key={f.name}
                  className="lp-card"
                  style={{ "--i": i }}
                >
                  <span className="lp-card-icon" aria-hidden="true">
                    <FeatureIcon name={f.icon} />
                  </span>
                  <h3 className="lp-card-name">{f.name}</h3>
                  <p className="lp-card-body">{f.body}</p>
                </li>
              ))}
            </ul>
          </section>

          {/* --- Cartelera real: lo único que depende de la red -------- */}
          <section
            id="eventos"
            className="lp-events-block"
            aria-labelledby="lp-events-title"
          >
            <div className="lp-events-head">
              <div>
                <h2 id="lp-events-title" className="lp-h2">
                  Eventos abiertos
                </h2>
                <p className="lp-sub">
                  Las noches con venta abierta ahora mismo.
                </p>
              </div>
              <TransitionLink to="/inicio" className="lp-more">
                Ver la cartelera completa
              </TransitionLink>
            </div>

            {error && (
              <p className="lp-note" role="status">
                No pudimos cargar la cartelera. Intenta de nuevo en un momento.
              </p>
            )}

            {!error && !data && (
              <ul className="lp-list" aria-hidden="true">
                {[0, 1, 2].map((i) => (
                  <li key={i} className="lp-event lp-event-skeleton" />
                ))}
              </ul>
            )}

            {!error && data && openEvents.length === 0 && (
              <p className="lp-note" role="status">
                No hay eventos abiertos en este momento. Vuelve pronto.
              </p>
            )}

            {openEvents.length > 0 && (
              <ul className="lp-list">
                {openEvents.map((e) => {
                  const stamp = stampLabel(e.starts_at, e.timezone);
                  const wa = e.contact_phone
                    ? waLink(
                        e.contact_phone,
                        `Hola${e.contact_name ? ` ${e.contact_name}` : ""}! ` +
                          `Quiero encargar una boleta para ${e.name} (${whenLabel(
                            e.starts_at,
                            e.timezone,
                          )}).`,
                      )
                    : null;
                  return (
                    <li key={e.id} className="lp-event">
                      <div className="lp-event-stamp" aria-hidden="true">
                        <b>{stamp.day}</b>
                        <i>{stamp.month}</i>
                      </div>
                      <div className="lp-event-body">
                        <h3 className="lp-event-name">{e.name}</h3>
                        <p className="lp-event-meta">
                          {whenLabel(e.starts_at, e.timezone)}
                          {(e.where || e.venue) && (
                            <>
                              {" · "}
                              <span className="lp-event-where">
                                {e.where || e.venue}
                              </span>
                            </>
                          )}
                        </p>
                        <p className="lp-event-price">
                          {e.price_cents == null
                            ? "Entrada libre"
                            : `Desde ${money(e.price_cents)}`}
                        </p>
                      </div>
                      <div className="lp-event-actions">
                        {wa ? (
                          <a
                            className="lp-btn lp-btn-wa"
                            href={wa}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={() =>
                              track("landing_whatsapp", { eventId: e.id })
                            }
                          >
                            Encargar por WhatsApp
                          </a>
                        ) : (
                          <TransitionLink
                            to={`/evento/${e.id}`}
                            className="lp-btn lp-btn-primary"
                          >
                            Comprar boleta
                          </TransitionLink>
                        )}
                        <TransitionLink
                          to={`/evento/${e.id}`}
                          className="lp-event-detail"
                        >
                          Ver detalle
                        </TransitionLink>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* --- Línea de confianza ------------------------------------- */}
          <ul className="lp-trust" aria-label="Por qué funciona">
            {TRUST.map((t) => (
              <li key={t} className="lp-trust-item">
                <span className="lp-trust-check" aria-hidden="true">
                  <CheckIcon />
                </span>
                {t}
              </li>
            ))}
          </ul>
        </main>

        <footer className="lp-foot">
          <nav className="lp-foot-links" aria-label="Enlaces del sitio">
            <TransitionLink to="/privacidad">Política de privacidad</TransitionLink>
            <span className="lp-foot-dot" aria-hidden="true" />
            <TransitionLink to="/terminos">Términos de uso</TransitionLink>
            <span className="lp-foot-dot" aria-hidden="true" />
            <a href={`mailto:${SITE.supportEmail}`}>Contacto</a>
          </nav>
          <p className="lp-foot-copy">
            © {new Date().getFullYear()} ENTY. Todos los derechos reservados.
          </p>
        </footer>
      </div>
    </div>
  );
}
