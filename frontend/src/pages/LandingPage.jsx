import { useEffect, useMemo, useRef, useState } from "react";
import { fetchPublicEvents } from "../lib/api";
import { money } from "../lib/format";
import { track } from "../lib/analytics";
import { SITE } from "../lib/site";
import { waLink } from "../lib/whatsapp";
import { Logo } from "../components/Brand";
import TransitionLink from "../components/TransitionLink";
import useDocumentTitle from "../lib/useDocumentTitle";
import { prefersReducedMotion } from "../lib/motion";
import { richMotion } from "../lib/perf";
import useScrollReveal from "../lib/useScrollReveal";
import useSectionSpy from "../lib/useSectionSpy";
import useParallax from "../lib/useParallax";
import useInViewOnce from "../lib/useInViewOnce";
import { useCountUp } from "../lib/useCountUp";

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

/** Frases de confianza: solo cosas que se pueden comprobar en la app. */
const TRUST = [
  "Se entiende sin manual",
  "Todo se actualiza en vivo",
  "Funciona sin señal en la puerta",
  "La información queda ordenada",
];

/** Secciones que el índice de la portada puede marcar como activas. */
const SECTION_IDS = ["funciones", "eventos"];

/** Índice: solo las secciones con encabezado propio. */
const NAV_ITEMS = [
  { id: "funciones", label: "Funciones" },
  { id: "eventos", label: "Eventos abiertos" },
];

/** Cifra de la línea de confianza: cuenta al asomar, una sola vez. */
function TrustStat({ value, label, seen, plus }) {
  const n = useCountUp(seen ? value : 0, { duration: 800 });
  return (
    <>
      <span className="lp-trust-check" aria-hidden="true">
        <CheckIcon />
      </span>
      <span className="lp-trust-text">
        <b className="lp-trust-num">
          {Math.round(n)}
          {plus ? "+" : ""}
        </b>{" "}
        {label}
      </span>
    </>
  );
}

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

function PlayIcon() {
  return (
    <svg
      width="26"
      height="26"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10-6.5a1 1 0 0 0 0-1.72l-10-6.5A1 1 0 0 0 8 5.5Z" />
    </svg>
  );
}

/** Rutas del video de demostración. Vive en `public/media` (mismo mecanismo
 *  que el fondo sintetizado del login) para que Vercel lo sirva estático con
 *  su MIME y soporte de `Range`. */
const DEMO_VIDEO = {
  mp4: "/media/enty-demo.mp4",
  webm: "/media/enty-demo.webm",
  poster: "/media/enty-demo-poster.jpg",
  captions: "/media/enty-demo.vtt",
  seconds: 25,
};

/**
 * Reproductor de la demostración: portada propia y reproducción a pedido.
 *
 * `preload="none"` + portada JPEG evita descargar el video al abrir la
 * portada. El botón de portada es un control real (teclado y lector de
 * pantalla); al reproducir se retira y quedan los controles nativos, que
 * permiten pausar, buscar y activar subtítulos. Si el archivo falla, el
 * componente cae a un texto con enlace de descarga: la sección conserva su
 * descripción, su CTA y las seis funciones.
 */
function DemoVideo() {
  const ref = useRef(null);
  const [started, setStarted] = useState(false);
  const [ended, setEnded] = useState(false);
  const [failed, setFailed] = useState(false);

  // Al arrancar, el botón de portada desaparece; el foco pasa al reproductor
  // para que quien navega con teclado no lo pierda en el <body>.
  useEffect(() => {
    if (!started) return;
    const frame = requestAnimationFrame(() => ref.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [started]);

  function play() {
    const el = ref.current;
    if (!el) return;
    if (ended) el.currentTime = 0;
    setEnded(false);
    setStarted(true);
    const p = el.play?.();
    if (p && typeof p.catch === "function") {
      // Un navegador puede negarse (política de reproducción): se devuelve
      // la portada en vez de dejar un marco negro sin explicación.
      p.catch(() => setStarted(false));
    }
  }

  if (failed) {
    return (
      <div className="lp-demo-player lp-demo-player--fallback" role="status">
        <p className="lp-demo-fallback-title">El video no está disponible ahora.</p>
        <p className="lp-demo-fallback-body">
          El recorrido sigue explicado aquí abajo. También puedes{" "}
          <a href={DEMO_VIDEO.mp4} download>
            descargar la demostración
          </a>
          .
        </p>
      </div>
    );
  }

  return (
    <div className="lp-demo-player">
      <video
        ref={ref}
        className="lp-demo-video"
        poster={DEMO_VIDEO.poster}
        controls={started}
        playsInline
        preload="none"
        tabIndex={started ? 0 : -1}
        aria-label="Demostración de Enty: emisión, validación y aforo"
        aria-describedby="lp-demo-desc"
        onEnded={() => setEnded(true)}
        onError={() => setFailed(true)}
      >
        <source src={DEMO_VIDEO.webm} type="video/webm" />
        <source src={DEMO_VIDEO.mp4} type="video/mp4" />
        <track
          kind="captions"
          src={DEMO_VIDEO.captions}
          srcLang="es"
          label="Español"
        />
      </video>

      {(!started || ended) && (
        <button
          type="button"
          className="lp-demo-cover"
          onClick={play}
          aria-label={
            ended
              ? `Volver a reproducir la demostración de ${DEMO_VIDEO.seconds} segundos`
              : `Reproducir la demostración de ${DEMO_VIDEO.seconds} segundos`
          }
        >
          <span className="lp-demo-play">
            <PlayIcon />
          </span>
          <span className="lp-demo-cover-title">
            {ended ? "Volver a ver" : "Ver demostración"} · {DEMO_VIDEO.seconds} s
          </span>
          <span className="lp-demo-cover-sub">Toca para reproducir</span>
        </button>
      )}
    </div>
  );
}

export default function LandingPage() {
  useDocumentTitle("Boletería, aforo y control de acceso");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  // Revela por scroll: cada bloque entra cuando asoma, no todos al cargar.
  const { rootRef, enabled: reveal } = useScrollReveal(data);
  // Con red lenta o ahorro de datos, la capa rica no se monta (misma puerta
  // que el revelado). El contenido se ve igual: solo se apaga el adorno.
  const rich = useMemo(() => richMotion(), []);
  useParallax({ ref: rootRef, factor: 0.15, max: 90, enabled: rich });
  const { active, progress, scrolled } = useSectionSpy(SECTION_IDS);

  // Cifras de la linea de confianza: cuentan al asomar, una sola vez.
  const trustRef = useRef(null);
  const trustSeen = useInViewOnce(trustRef, { enabled: rich });

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

  /** "Explorar Enty" baja a las funcionalidades: el explorar es real, no un
   *  botón decorativo. Conserva el ancla nativa (funciona incluso antes de que
   *  React hidrate y con JS apagado); cuando hay JS se suaviza el salto, salvo
   *  si el movimiento está reducido, donde el salto directo es lo correcto. */
  function scrollToSection(e, id) {
    const el = document.getElementById(id);
    if (!el) return; // sin destino: que actúe el ancla nativa
    e.preventDefault();
    el.scrollIntoView({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      block: "start",
    });
    // El clic es una navegación real: la barra de direcciones debe reflejarla
    // (compartir "…/#eventos" tiene que funcionar). `replaceState` no dispara
    // el salto nativo, así que no pelea con el `scrollIntoView` de arriba.
    if (window.history?.replaceState) {
      window.history.replaceState(null, "", `#${id}`);
    }
  }

  /**
   * Ancla en carga fría (`/#eventos` compartido por WhatsApp).
   *
   * El navegador resuelve el `#hash` antes de que React monte la sección, así
   * que no encuentra el destino y se queda arriba.
   *
   * Y aunque el destino exista, la altura de la página sigue cambiando después
   * del salto: la cartelera llega async y el aviso de cookies empuja el
   * documento hacia abajo. Por eso no basta con saltar una vez; hay que
   * re-ajustar mientras la página se asienta. Se vigila la altura del
   * documento y solo se vuelve a alinear cuando cambia, porque no se sabe
   * cuándo llega la cartelera: con temporizadores fijos, en una red lenta la
   * respuesta entra después del último y el ancla queda corta.
   *
   * Se vigila `scrollHeight` y no con `ResizeObserver`: la caja de `<html>` y
   * de `<body>` mide el viewport (el contenido desborda sin cambiar su
   * altura), así que el observer nunca dispara.
   *
   * Tres guardas para no secuestrar la página:
   *  - Un `wheel`, `touchmove` o `keydown` (el usuario ya va por su cuenta)
   *    corta la vigilancia en el acto.
   *  - La ventana se cierra sola a los 6 s: pasado ese punto la página ya no
   *    cambia de altura.
   *  - El efecto corre una sola vez (`[]`). Si dependiera de `data`, cada
   *    llegada de la cartelera lo re-ejecutaría y devolvería a la sección a
   *    quien ya se había ido a leer otra parte.
   */
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.replace(/^#/, ""));
    if (!id || !SECTION_IDS.includes(id)) return;
    if (!document.getElementById(id)) return;

    let active = true;
    let raf = 0;
    let timer = 0;
    let lastHeight = -1;
    let frame = 0;
    const INTENT = ["wheel", "touchmove", "keydown"];

    // `scrollIntoView` deja el destino a `scroll-padding-top` del borde; se
    // mide en vez de clavar 72 px porque el valor cambia con la tipografía.
    const offset = () => {
      const pad = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop);
      return Number.isFinite(pad) ? pad : 0;
    };

    const stop = () => {
      active = false;
      clearTimeout(timer);
      if (raf) cancelAnimationFrame(raf);
      for (const ev of INTENT) window.removeEventListener(ev, stop);
    };

    const align = () => {
      const target = document.getElementById(id);
      if (!target) return;
      // Ya alineado (dentro de 4 px): no hay nada que corregir.
      if (Math.abs(target.getBoundingClientRect().top - offset()) < 4) return;
      // Instantáneo, como el salto nativo de un `#hash`: un desplazamiento
      // suave aquí se vería como un tirón en cada corrección.
      target.scrollIntoView({ block: "start" });
    };

    // Cada 6 frames (~10/s) basta para acompañar un asentamiento y no fuerza
    // layout en cada frame.
    const watch = () => {
      raf = 0;
      if (!active) return;
      frame += 1;
      if (frame % 6 === 0) {
        const height = document.documentElement.scrollHeight;
        if (height !== lastHeight) {
          lastHeight = height;
          align();
        }
      }
      raf = requestAnimationFrame(watch);
    };

    for (const ev of INTENT) {
      window.addEventListener(ev, stop, { passive: true, once: true });
    }
    align();
    lastHeight = document.documentElement.scrollHeight;
    raf = requestAnimationFrame(watch);
    timer = setTimeout(stop, 6000);

    return stop;
  }, []);

  return (
    <div ref={rootRef} className={reveal ? "lp lp-anim" : "lp"}>
      <a href="#lp-contenido" className="lp-skip">
        Saltar al contenido
      </a>

      {/* Progreso de lectura: 2px de violeta en el borde superior. Es un
          indicador, no un adorno: en una página que se recorre entera dice
          cuánto falta sin robar altura. `aria-hidden` porque duplica lo que
          ya anuncian los encabezados. */}
      <div
        className={scrolled ? "lp-progress is-on" : "lp-progress"}
        aria-hidden="true"
        style={{ "--p": progress }}
      />

      {/* Índice de secciones: aparece al salir del hero y marca sola la
          sección que se está leyendo. En móvil va pegado arriba y desplaza
          horizontalmente si no cabe (nunca rompe el ancho). */}
      <nav
        className={scrolled ? "lp-index is-on" : "lp-index"}
        aria-label="Secciones de la portada"
      >
        {NAV_ITEMS.map((item) => (
          <a
            key={item.id}
            href={`#${item.id}`}
            className={active === item.id ? "lp-index-link is-active" : "lp-index-link"}
            aria-current={active === item.id ? "true" : undefined}
            onClick={(e) => scrollToSection(e, item.id)}
          >
            {item.label}
          </a>
        ))}
      </nav>

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
              {/* La portada solo llevaba a /login: quien quería abrir su
                  cuenta no tenía puerta de entrada al registro (existía, pero
                  no se anunciaba). Ahora el registro es la acción principal y
                  el ingreso la secundaria; "Explorar" baja a las funciones. */}
              <TransitionLink to="/register" className="lp-btn lp-btn-primary">
                Crear cuenta
              </TransitionLink>
              <TransitionLink to="/login" className="lp-btn lp-btn-secondary">
                Iniciar sesión
              </TransitionLink>
              <a
                href="#funciones"
                className="lp-btn lp-btn-ghost"
                onClick={(e) => scrollToSection(e, "funciones")}
              >
                Explorar Enty
              </a>
            </div>
          </section>

          {/* --- Demostración + funcionalidades reales ------------------ */}
          <section
            id="funciones"
            className="lp-features"
            aria-labelledby="lp-demo-title"
          >
            <h2 id="lp-demo-title" className="lp-h2" data-reveal>
              Mira cómo funciona Enty
            </h2>
            <p className="lp-sub" data-reveal>
              Emite una boleta, valida el QR y consulta el aforo en un solo
              recorrido.
            </p>

            <div className="lp-demo" data-reveal>
              <DemoVideo />
              <p id="lp-demo-desc" className="lp-demo-desc">
                Recorrido de 25 segundos, sin audio: un promotor emite una
                boleta desde su cupo, la puerta valida el QR y el panel del
                negocio muestra el ingreso sumado al aforo.
              </p>
              <TransitionLink
                to="/register"
                className="lp-btn lp-btn-primary lp-demo-cta"
              >
                Crear mi primer evento
              </TransitionLink>
            </div>

            <h3 className="lp-h3" data-reveal>
              Todo lo que necesitas para la noche
            </h3>
            <p className="lp-sub" data-reveal>
              Seis herramientas que ya funcionan juntas: la venta, la puerta y la
              cuenta del cierre.
            </p>

            <ul className="lp-grid">
              {FEATURES.map((f, i) => (
                <li
                  key={f.name}
                  className="lp-card"
                  style={{ "--i": i }}
                  data-reveal="card"
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
            <div className="lp-events-head" data-reveal>
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
                {openEvents.map((e, i) => {
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
                    <li
                      key={e.id}
                      className="lp-event"
                      style={{ "--i": i }}
                      data-reveal
                    >
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
          <ul className="lp-trust" aria-label="Por qué funciona" ref={trustRef}>
            {TRUST.map((t, i) => (
              <li
                key={t}
                className="lp-trust-item"
                style={{ "--i": i }}
                data-reveal
              >
                <span className="lp-trust-check" aria-hidden="true">
                  <CheckIcon />
                </span>
                <span className="lp-trust-text">{t}</span>
              </li>
            ))}
            {/* Cuenta la cartelera entera, no las tarjetas de arriba (la
                vista previa se corta a 4 y el bloque ya enlaza a "Ver la
                cartelera completa"). `count` viene recortado al límite
                pedido, así que con `has_more` se añade "+": una cifra exacta
                que no es el total se lee como mentira. Con una sola noche no
                hay nada que contar, así que se omite. */}
            {data?.count > 1 && (
              <li
                className="lp-trust-item lp-trust-item-stat"
                style={{ "--i": TRUST.length }}
                data-reveal
              >
                <TrustStat
                  value={data.count}
                  plus={data.has_more}
                  label="noches con venta abierta ahora"
                  seen={trustSeen}
                />
              </li>
            )}
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
            © {new Date().getFullYear()} Enty. Todos los derechos reservados.
          </p>
        </footer>
      </div>
    </div>
  );
}
