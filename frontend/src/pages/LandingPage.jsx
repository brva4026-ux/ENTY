import { useEffect, useMemo, useState } from "react";
import { fetchPublicEvents } from "../lib/api";
import { money } from "../lib/format";
import { forceDarkOnce } from "../lib/theme";
import { track } from "../lib/analytics";
import { SITE } from "../lib/site";
import { waLink } from "../lib/whatsapp";
import { Spark } from "../components/Brand";
import TransitionLink from "../components/TransitionLink";
import useDocumentTitle from "../lib/useDocumentTitle";

/**
 * Presentación pública de Enty (la raíz "/").
 *
 * Es la cara del PRODUCTO, no la del fan: quien llega por un enlace
 * compartido —o por el QR de un flyer— sin cuenta necesita entender qué es
 * Enty, ver qué noches hay abiertas y saber con quién hablar. La vitrina de
 * compra vive en /inicio; aquí se presenta la plataforma y se ofrece la
 * entrada al panel del equipo.
 *
 * El contacto del organizador (mig 036) es lo que cierra el círculo: el fan
 * que no quiere comprar en línea escribe por WhatsApp a la persona encargada
 * de ESA noche. Sin contacto publicado, el evento solo ofrece la compra web —
 * nunca un botón a un número vacío.
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

/** "vie 24 oct" para el sello del boleto. */
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

/** Los cuatro pasos del ciclo de una noche (el "cómo funciona"). */
const STEPS = [
  {
    n: "01",
    title: "Publica tu cartelera",
    body: "Crea el evento, su aforo y sus localidades con precio. El flyer y la descripción salen a la vitrina pública al instante.",
  },
  {
    n: "02",
    title: "Vende con QR",
    body: "Cada boleta nace con un código único. El fan la paga en línea o la encarga por WhatsApp, y la recibe lista para entrar.",
  },
  {
    n: "03",
    title: "Controla la puerta",
    body: "El equipo escanea en vivo desde el celular, incluso sin señal. Los ingresos y el aforo se ven al segundo.",
  },
  {
    n: "04",
    title: "Liquida a tu equipo",
    body: "El sistema cuenta las ventas de cada promotor y calcula la comisión. Menos cuaderno, menos discusión al cierre.",
  },
];

/** El equipo que el usuario menciona: quién hace qué dentro del negocio. */
const ROLES = [
  {
    tag: "Administrador",
    title: "Dirige el negocio",
    body: "Publica eventos, ve métricas en vivo, gestiona el equipo y ajusta precios y aforo.",
    icon: "shield",
  },
  {
    tag: "Puerta",
    title: "Escanea en la entrada",
    body: "Valida cada QR desde el celular, con o sin datos. La lista de acceso se sincroniza sola.",
    icon: "scan",
  },
  {
    tag: "Promotor",
    title: "Vende y gana",
    body: "Comparte su enlace, sigue sus ventas y consulta su liquidación sin pedirle cuentas a nadie.",
    icon: "tag",
  },
];

function RoleIcon({ name }) {
  const common = {
    width: 24,
    height: 24,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
  };
  if (name === "scan")
    return (
      <svg {...common}>
        <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" />
        <path d="M4 12h16" />
      </svg>
    );
  if (name === "tag")
    return (
      <svg {...common}>
        <path d="M3 12V5a2 2 0 0 1 2-2h7l9 9-9 9z" />
        <circle cx="8" cy="8" r="1.4" />
      </svg>
    );
  return (
    <svg {...common}>
      <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" />
      <path d="M9.5 12l1.8 1.8L15 10" />
    </svg>
  );
}

export default function LandingPage() {
  useDocumentTitle("Boletería, aforo y control de acceso");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  // La presentación es nocturna por diseño (la marca vive sobre negro mate).
  useEffect(() => forceDarkOnce(), []);

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

  const cities = useMemo(() => {
    const set = new Set();
    for (const e of events) {
      const c = (e.location || e.venue || "").split(",")[0].trim();
      if (c) set.add(c);
    }
    return set.size;
  }, [events]);

  const openEvents = events.slice(0, 6);

  return (
    <div className="lp motion-reduced">
      <a href="#lp-contenido" className="lp-skip">
        Saltar al contenido
      </a>

      <header className="lp-head">
        <TransitionLink to="/" className="lp-wordmark" aria-label="Enty, inicio">
          <span>Enty</span>
          <Spark size={9} />
        </TransitionLink>
        <nav className="lp-nav" aria-label="Secciones">
          <a href="#como-funciona">Cómo funciona</a>
          <a href="#equipo">Equipo</a>
          <a href="#eventos">Eventos</a>
          <a href="#boletas">Mi boleta</a>
        </nav>
        <TransitionLink to="/login" className="lp-head-cta">
          Ingresar
        </TransitionLink>
      </header>

      <main id="lp-contenido" className="lp-main">
        {/* --- Hero: qué es Enty, en una frase ------------------------- */}
        <section className="lp-hero" aria-labelledby="lp-hero-title">
          <p className="lp-eyebrow">Boletería · Aforo · Puerta</p>
          <h1 id="lp-hero-title" className="lp-title">
            Tus eventos,
            <br />
            <span className="lp-title-accent">tus boletas, tu puerta.</span>
          </h1>
          <p className="lp-lede">
            Enty es la plataforma con la que un bar, un teatro o una productora
            publica su cartelera, vende boletas con QR, controla la entrada en
            vivo y liquida a su equipo de promotores. Tú pones la noche;
            nosotros llevamos la cuenta.
          </p>

          <div className="lp-hero-cta">
            <a href="#eventos" className="lp-btn lp-btn-primary">
              Ver eventos abiertos
            </a>
            <TransitionLink to="/login" className="lp-btn lp-btn-ghost">
              Ingresar al panel
            </TransitionLink>
          </div>

          <dl className="lp-stats">
            <div className="lp-stat">
              <dt>Eventos abiertos</dt>
              <dd>{data ? events.length : "—"}</dd>
            </div>
            <div className="lp-stat">
              <dt>Ciudades</dt>
              <dd>{data ? cities : "—"}</dd>
            </div>
            <div className="lp-stat">
              <dt>Entrada</dt>
              <dd>QR</dd>
            </div>
          </dl>
        </section>

        {/* --- Cómo funciona: el ciclo de una noche -------------------- */}
        <section
          id="como-funciona"
          className="lp-section"
          aria-labelledby="lp-como-title"
        >
          <h2 id="lp-como-title" className="lp-h2">
            Cómo funciona
          </h2>
          <p className="lp-sub">
            De la idea al cierre de puerta, en cuatro pasos que hace el mismo
            equipo.
          </p>
          <ol className="lp-steps">
            {STEPS.map((s) => (
              <li key={s.n} className="lp-step">
                <span className="lp-step-n" aria-hidden="true">
                  {s.n}
                </span>
                <h3 className="lp-step-title">{s.title}</h3>
                <p className="lp-step-body">{s.body}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* --- Equipo: quién hace qué ---------------------------------- */}
        <section id="equipo" className="lp-section" aria-labelledby="lp-equipo-title">
          <h2 id="lp-equipo-title" className="lp-h2">
            Un equipo, tres pantallas
          </h2>
          <p className="lp-sub">
            Cada persona entra con su propio rol y ve solo lo que necesita.
          </p>
          <div className="lp-roles">
            {ROLES.map((r) => (
              <article key={r.tag} className="lp-role">
                <span className="lp-role-icon" aria-hidden="true">
                  <RoleIcon name={r.icon} />
                </span>
                <p className="lp-role-tag">{r.tag}</p>
                <h3 className="lp-role-title">{r.title}</h3>
                <p className="lp-role-body">{r.body}</p>
              </article>
            ))}
          </div>
        </section>

        {/* --- Eventos abiertos: la cartelera en vivo ------------------ */}
        <section id="eventos" className="lp-section" aria-labelledby="lp-eventos-title">
          <div className="lp-section-head">
            <div>
              <h2 id="lp-eventos-title" className="lp-h2">
                Eventos abiertos
              </h2>
              <p className="lp-sub">
                Estas son las noches con venta abierta ahora mismo.
              </p>
            </div>
            <TransitionLink to="/inicio" className="lp-link-more">
              Ver la cartelera completa
            </TransitionLink>
          </div>

          {error && (
            <p className="lp-note" role="status">
              No pudimos cargar la cartelera. Intenta de nuevo en un momento.
            </p>
          )}

          {!error && !data && (
            <ul className="lp-events" aria-hidden="true">
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
            <ul className="lp-events">
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
                          onClick={() => track("landing_whatsapp", { eventId: e.id })}
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

          <p className="lp-contact-note">
            ¿Organizas un evento y quieres que aparezca aquí? Escribe a{" "}
            <a href={`mailto:${SITE.supportEmail}`}>{SITE.supportEmail}</a>.
          </p>
        </section>

        {/* --- Mi boleta: los tres estados ---------------------------- */}
        <section id="boletas" className="lp-section" aria-labelledby="lp-boletas-title">
          <h2 id="lp-boletas-title" className="lp-h2">
            ¿Ya tienes tu boleta?
          </h2>
          <p className="lp-sub">
            Tu boleta vive en tu correo o teléfono. Ábrela para ver su estado.
          </p>
          <div className="lp-tickets">
            <div className="lp-ticket">
              <span className="lp-dot lp-dot-ok" aria-hidden="true" />
              <h3 className="lp-ticket-title">Está activa</h3>
              <p className="lp-ticket-body">
                Lista para entrar. Muestra el QR en la puerta y listo.
              </p>
            </div>
            <div className="lp-ticket">
              <span className="lp-dot lp-dot-warn" aria-hidden="true" />
              <h3 className="lp-ticket-title">Ya llegó la noche</h3>
              <p className="lp-ticket-body">
                El código se marca como usado al escanearse: nadie entra dos
                veces con la misma boleta.
              </p>
            </div>
            <div className="lp-ticket">
              <span className="lp-dot lp-dot-brand" aria-hidden="true" />
              <h3 className="lp-ticket-title">Todavía no la tengo</h3>
              <p className="lp-ticket-body">
                Pídela con tu correo o teléfono, o encárgala por WhatsApp al
                organizador de esa noche.
              </p>
            </div>
          </div>
          <div className="lp-tickets-cta">
            <TransitionLink to="/boletas" className="lp-btn lp-btn-primary">
              Abrir mis boletas
            </TransitionLink>
            <a href="#eventos" className="lp-btn lp-btn-ghost">
              Ver eventos abiertos
            </a>
          </div>
        </section>

        {/* --- CTA de staff: la entrada al panel ---------------------- */}
        <section className="lp-staff" aria-labelledby="lp-staff-title">
          <div className="lp-staff-copy">
            <h2 id="lp-staff-title" className="lp-h2">
              ¿Eres del equipo?
            </h2>
            <p className="lp-sub">
              Administrador, puerta o promotor: entra con tu cuenta y llega
              directo a tu panel.
            </p>
          </div>
          <TransitionLink to="/login" className="lp-btn lp-btn-primary lp-btn-lg">
            Ingresar al panel
          </TransitionLink>
        </section>
      </main>

      <footer className="lp-foot">
        <p className="lp-foot-brand">
          <span>Enty</span> · Boletería y control de acceso
        </p>
        <nav className="lp-foot-links" aria-label="Enlaces legales">
          <TransitionLink to="/terminos">Términos</TransitionLink>
          <TransitionLink to="/privacidad">Privacidad</TransitionLink>
          <a href={`mailto:${SITE.supportEmail}`}>Contacto</a>
        </nav>
      </footer>
    </div>
  );
}
