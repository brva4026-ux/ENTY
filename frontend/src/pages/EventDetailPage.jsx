import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  fetchPublicEventDetail,
  getCheckoutRecovery,
  publicEventExtras,
  publicResales,
  recordPromoterLinkVisit,
  requestResale,
} from "../lib/api";
import ContactSupport from "../components/ContactSupport";
import FanCheckoutModal from "../components/FanCheckoutModal";
import WaitingRoomOverlay from "../components/WaitingRoomOverlay";
import { useWaitingRoom } from "../lib/useWaitingRoom";
import { money } from "../lib/format";
import { forceDarkOnce } from "../lib/theme";
import { track } from "../lib/analytics";
import useDocumentTitle from "../lib/useDocumentTitle";
import useBackOrFallback from "../lib/useBackOrFallback";
import TransitionLink from "../components/TransitionLink";
import { Skeleton } from "../components/Skeleton";
import { EntySymbol } from "../components/Brand";
import { waLink } from "../lib/whatsapp";
import { placeLabel } from "../lib/placeLabel";

/**
 * Ficha pública del evento — la pantalla que abre alguien desde un enlace
 * compartido, sin cuenta y casi siempre en el celular.
 *
 * La portada manda: el afiche se muestra completo (object-fit: contain, con
 * un fondo desenfocado) y el nombre, la fecha/hora y el lugar se repiten como
 * texto real debajo, aunque la imagen no cargue. Después vienen las boletas,
 * el video opcional, la descripción/lineup/condiciones, el lugar con "Cómo
 * llegar" SOLO si el organizador confirmó un enlace de mapa, el contacto
 * público y la acción de compartir.
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
  if (name === "whatsapp")
    return (
      <svg {...common}>
        <path d="M20.5 11.6a8.5 8.5 0 0 1-12.6 7.5L3 20.5l1.4-4.8A8.5 8.5 0 1 1 20.5 11.6z" />
        <path d="M8.7 8.2c.2-.5.4-.5.7-.5h.5c.2 0 .4 0 .5.4l.7 1.6c.1.2 0 .4-.1.6l-.5.6c-.1.1-.2.3 0 .6.3.5.7 1 1.2 1.4.5.4 1 .7 1.5.9.2.1.4.1.6-.1l.6-.7c.2-.2.4-.2.6-.1l1.6.8c.2.1.4.2.4.4v.5c0 .3-.2.8-.5 1-.3.3-.8.5-1.3.5-.5 0-1.2-.2-2.1-.6-1-.5-2-1.2-2.8-2.1-.8-.9-1.4-1.8-1.7-2.5-.3-.7-.4-1.3-.3-1.8z" />
      </svg>
    );
  if (name === "play")
    return (
      <svg {...common}>
        <path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none" />
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
  const goBack = useBackOrFallback("/explorar");
  const [searchParams, setSearchParams] = useSearchParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  // 404 no se reintenta (el evento no existe); un 500 o un corte de red sí.
  const [missing, setMissing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [fav, setFav] = useState(false);
  const [favPop, setFavPop] = useState(false);
  const [copied, setCopied] = useState(false);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [extras, setExtras] = useState(null);
  const [resales, setResales] = useState([]);
  const [recovery, setRecovery] = useState(null);
  const [lang, setLang] = useState(() => {
    try { return localStorage.getItem("tf_lang") || "es"; } catch { return "es"; }
  });
  const [resaleForm, setResaleForm] = useState({ id: null, name: "", phone: "" });
  const [resaleMsg, setResaleMsg] = useState("");

  async function requestResaleOffer(e) {
    e.preventDefault();
    if (!resaleForm.id || !resaleForm.name.trim()) return;
    try {
      const res = await requestResale(resaleForm.id, {
        buyer_name: resaleForm.name.trim(),
        buyer_phone: resaleForm.phone.trim() || null,
      });
      setResaleMsg(res.detail || "Solicitud enviada.");
      setResaleForm({ id: null, name: "", phone: "" });
    } catch (err) {
      setResaleMsg(err.message || "No pudimos enviar la solicitud.");
    }
  }
  // Video opcional (mig 057): no se descarga hasta que el fan toca play, y
  // empieza silenciado para no sorprender. Si falla, la ficha sigue.
  const [videoStarted, setVideoStarted] = useState(false);
  const [videoPlaying, setVideoPlaying] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);
  // Afiche que ya falló: se cae al fondo neutro, nunca a un <img> roto.
  const [badFlyer, setBadFlyer] = useState("");
  const videoRef = useRef(null);
  // La barra fija aparece cuando el CTA del rail ya pasó por arriba: antes
  // taparía el precio y duplicaría el botón que el fan todavía tiene a la vista.
  const buyCtaRef = useRef(null);
  const [railCtaPassed, setRailCtaPassed] = useState(false);
  // Sala de espera (mig 055/056). Solo se activa si el evento la tiene
  // encendida; con la sala apagada el hook no hace ni una peticion y el
  // checkout funciona igual que siempre.
  const [queueOpen, setQueueOpen] = useState(false);
  const waitingRoom = useWaitingRoom(data?.id, Boolean(data?.waiting_room) && queueOpen);
  useDocumentTitle(data?.name);

  // Referencia del checkout al volver de Wompi (redirect_url del cobro).
  const payRef = searchParams.get("pago");
  const preview = searchParams.get("preview") === "1";
  // Link público de un promotor (mig 063). Solo se usa para atribuir; no se
  // muestra ni se comparte de vuelta.
  const promoterRef = searchParams.get("ref");

  useEffect(() => {
    if (!promoterRef) return;
    const key = `tf_promo_visit_${promoterRef}`;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, "1");
    } catch {
      /* modo privado: se cuenta igual */
    }
    recordPromoterLinkVisit(promoterRef).catch(() => {});
  }, [promoterRef]);

  /** Acciones del cartel (volver, favorito, compartir). Se dibujan sobre la
   *  portada, que es la misma pieza en móvil y escritorio. Es una función de
   *  render, no un componente anidado: así no se remonta en cada render ni
   *  pierde el foco. */
  function posterActions() {
    return (
      <>
        <button
          type="button"
          className="evd-round"
          aria-label="Volver"
          onClick={goBack}
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
    setMissing(false);
    fetchPublicEventDetail(id, { preview })
      .then((d) => {
        if (alive) setData(d);
      })
      .catch((e) => {
        if (!alive) return;
        setMissing(e.status === 404);
        setError(e.status === 404 ? "Este evento ya no está disponible." : e.message);
      });
    return () => {
      alive = false;
    };
  }, [id, attempt, preview]);

  useEffect(() => {
    if (data) setFav(readFavs().has(Number(data.id)));
  }, [data]);

  useEffect(() => {
    if (!id) return undefined;
    let alive = true;
    Promise.all([
      publicEventExtras(id).catch(() => ({ transport: [], map_points: [] })),
      publicResales(id).catch(() => []),
    ]).then(([ex, rs]) => {
      if (!alive) return;
      setExtras(ex);
      setResales(rs || []);
    });
    return () => { alive = false; };
  }, [id]);

  useEffect(() => {
    const token = searchParams.get("retomar");
    if (!token) return;
    getCheckoutRecovery(token).then(setRecovery).catch(() => setRecovery(null));
  }, [searchParams]);

  useEffect(() => {
    try { localStorage.setItem("tf_lang", lang); } catch { /* privado */ }
    document.documentElement.lang = lang;
  }, [lang]);

  // Embudo, paso 2: abrió este evento. Se dispara una sola vez por id, aunque
  // la pantalla se re-renderice por favoritos o pestañas.
  useEffect(() => {
    if (data) track("view_event", { eventId: Number(data.id) });
  }, [data]);

  // Sala de espera: en cuanto llega el pase, la fila se cierra y se abre el
  // checkout con ese pase. Es la unica transicion que el fan percibe como
  // "ya me toca": sin ella se quedaria mirando la fila para siempre.
  useEffect(() => {
    if (waitingRoom.state !== "admitted" || !queueOpen) return;
    setQueueOpen(false);
    setCheckoutOpen(true);
  }, [waitingRoom.state, queueOpen]);

  // Cambiar de evento (o reintentar) resetea el video y el afiche fallido: el
  // estado de la ficha anterior no debe filtrarse a la siguiente.
  useEffect(() => {
    setVideoStarted(false);
    setVideoPlaying(false);
    setVideoFailed(false);
    setBadFlyer("");
    setCopied(false);
  }, [id]);

  // El checkout y la sala de espera tapan la ficha: pausar el video evita
  // que siga sonando detrás del modal.
  useEffect(() => {
    if ((checkoutOpen || queueOpen) && videoRef.current) {
      videoRef.current.pause();
    }
  }, [checkoutOpen, queueOpen]);

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
    if (!data) return;
    // URL canónica, NO window.location.href: al volver de Wompi la barra
    // lleva ?pago=<reference>, y compartir eso abriría el estado de un cobro
    // ajeno. El enlace público es siempre /evento/<id>.
    const url = `${window.location.origin}/evento/${data.id}`;
    const payload = {
      title: data.name,
      text: [data.name, data.where].filter(Boolean).join(" · "),
      url,
    };
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

  // Contacto del organizador para "encargar la boleta" cuando el pago en linea
  // no esta configurado. null si no publico un telefono usable: sin el, el CTA
  // no lleva a ningun chat seguro, asi que se dice la verdad en vez de mostrarlo.
  // Tambien cubre entradas de cortesia: el organizador sigue siendo el canal
  // real para conseguir la boleta cuando no hay cobro en linea.
  const contactWa =
    data &&
    !data.sold_out &&
    (!data.payments_enabled || data.price_cents == null)
      ? waLink(
          data.contact_phone,
          data.price_cents == null
            ? `Hola, quiero consultar por la entrada a ${data.name}.`
            : `Hola, quiero comprar una boleta para ${data.name}.`,
        )
      : null;

  // Contacto general (preguntas, no compra). Solo si hay un número usable:
  // waLink devuelve null para teléfonos incompletos y no se inventa un chat.
  const organizerWa =
    data && data.contact_phone
      ? waLink(
          data.contact_phone,
          `Hola${data.contact_name ? ` ${data.contact_name}` : ""}, tengo una pregunta sobre ${data.name}.`,
        )
      : null;

  const ticketRows = useMemo(() => {
    if (!data) return [];
    if (data.ticket_types?.length) return data.ticket_types;
    return [
      {
        id: "general",
        name: "Entrada general",
        price_cents: data.price_cents,
        is_courtesy: data.price_cents == null,
        sold_out: false,
      },
    ];
  }, [data]);

  const showFlyer = Boolean(data?.flyer_url && data.flyer_url !== badFlyer);
  const hasAbout = Boolean(
    data?.description ||
      data?.lineup?.length ||
      data?.min_age != null ||
      data?.dress_code ||
      data?.doors_open_at,
  );
  const hasLocation = Boolean(data?.venue || data?.location);
  // Identidad que viaja sobre el video: si el clip es vertical y se ve sin
  // audio, el nombre, la fecha, el lugar y el cartel siguen en pantalla.
  const videoTags = data?.lineup?.length
    ? data.lineup
        .slice(0, 4)
        .map((a) => a.name)
        .filter(Boolean)
        .join(" · ")
    : data?.category || "";
  const hasBuyBar = Boolean(
    data &&
      !preview &&
      !checkoutOpen &&
      !queueOpen &&
      !videoPlaying &&
      (data.sold_out ||
        ((data.price_cents != null || contactWa) &&
          (data.payments_enabled || contactWa))),
  );
  const showBuyBar = hasBuyBar && railCtaPassed;

  useEffect(() => {
    const el = buyCtaRef.current;
    if (!el) return;
    let frame = 0;
    const check = () => {
      frame = 0;
      setRailCtaPassed(el.getBoundingClientRect().bottom < 0);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(check);
    };
    check();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [data?.id, hasBuyBar]);

  /** CTA de boletas, una sola definición para el rail y la barra fija. */
  function ticketCta(wide = false) {
    if (!data) return null;
    if (preview) {
      return (
        <span className="evd-preview-cta">
          Vista previa · la venta se habilita al publicar
        </span>
      );
    }
    const cls = `evd-cta${wide ? " evd-cta--wide" : ""}`;
    const arrow = (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M5 12h13M13 6l6 6-6 6" />
      </svg>
    );
    if (data.sold_out) {
      return (
        <TransitionLink to={`/waitlist?event=${data.id}`} className={cls}>
          Entrar a la lista de espera
          {arrow}
        </TransitionLink>
      );
    }
    if (data.price_cents == null) {
      if (contactWa) {
        return (
          <a
            className={cls}
            href={contactWa}
            target="_blank"
            rel="noreferrer"
            onClick={() =>
              track("checkout_contact_whatsapp", { eventId: Number(data.id) })
            }
          >
            Encargar por WhatsApp
            {arrow}
          </a>
        );
      }
      // Sin precio no hay compra pública que ofrecer. Un enlace a "Mis
      // boletas" confundía al visitante sin cuenta: se muestra el estado real.
      return (
        <span className={`${cls} evd-cta--disabled`} aria-disabled="true">
          Entrada gratuita
        </span>
      );
    }
    if (data.payments_enabled) {
      return (
        <button
          type="button"
          className={cls}
          onClick={() => {
            // Embudo, paso 3: intención real de compra (abre el pago).
            track("checkout_start", { eventId: Number(data.id) });
            if (data.waiting_room) {
              // Con sala activa el fan NO va directo al pago: primero hace
              // fila. El checkout se abre solo cuando recibe el pase.
              setQueueOpen(true);
              return;
            }
            setCheckoutOpen(true);
          }}
        >
          Comprar boleto
          {arrow}
        </button>
      );
    }
    if (contactWa) {
      return (
        <a
          className={cls}
          href={contactWa}
          target="_blank"
          rel="noreferrer"
          onClick={() =>
            track("checkout_contact_whatsapp", { eventId: Number(data.id) })
          }
        >
          Encargar por WhatsApp
          {arrow}
        </a>
      );
    }
    return null;
  }

  return (
    <div className={`evd${hasBuyBar ? " evd--buybar" : ""}`}>
      {preview && (
        <div className="evd-preview-banner" role="status">
          <strong>Vista previa</strong>
          <span>
            Así verá el público esta ficha. Los cambios sin guardar no
            aparecen y la venta está cerrada.
          </span>
          <a href={`/admin?event=${id}&tab=resumen`}>Volver al backstage</a>
        </div>
      )}
      {error ? (
        <div className="evd-empty">
          <p>{error}</p>
          {/* Un corte de red se arregla reintentando; un evento borrado, no. */}
          {missing ? (
            <TransitionLink to="/inicio" className="evd-cta">
              Volver al inicio
            </TransitionLink>
          ) : (
            <button
              type="button"
              className="evd-cta"
              onClick={() => setAttempt((a) => a + 1)}
            >
              Reintentar
            </button>
          )}
        </div>
      ) : !data ? (
        /* Esqueleto con el alto real de la ficha: evita el salto de layout
           cuando llegan los datos. */
        <div className="evd-body" aria-busy="true">
          <p className="sr-only" role="status">
            Cargando el evento…
          </p>
          <div className="evd-poster">
            <div className="evd-poster-frame is-skeleton" />
          </div>
          <div className="evd-info">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-4 h-9 w-4/5" />
            <Skeleton className="mt-3 h-3.5 w-2/5" />
            <div className="evd-grid">
              {["fecha", "lugar", "precio"].map((k) => (
                <div key={k} className="evd-cell">
                  <Skeleton className="h-5 w-5 rounded-md" />
                  <Skeleton className="mt-3 h-2.5 w-14" />
                  <Skeleton className="mt-2 h-4 w-20" />
                </div>
              ))}
            </div>
            <Skeleton className="mt-6 h-28 w-full rounded-2xl" />
          </div>
        </div>
      ) : (
        <div className="evd-body">
          {/* Portada: afiche completo, con un fondo desenfocado que rellena
              los bordes. El texto de la ficha no depende de la imagen. */}
          <div className="evd-poster">
            <div className={`evd-poster-frame${showFlyer ? "" : " is-fallback"}`}>
              {showFlyer ? (
                <>
                  <img
                    className="evd-poster-bg"
                    src={data.flyer_url}
                    alt=""
                    aria-hidden="true"
                    decoding="async"
                    onError={() => setBadFlyer(data.flyer_url)}
                  />
                  <img
                    className="evd-poster-img"
                    src={data.flyer_url}
                    alt={`Afiche de ${data.name}`}
                    loading="eager"
                    fetchPriority="high"
                    decoding="async"
                    onError={() => setBadFlyer(data.flyer_url)}
                  />
                </>
              ) : (
                <div className="evd-poster-fallback" aria-hidden="true">
                  <span className="evd-poster-brand">
                    <EntySymbol size={52} />
                    <span className="evd-poster-mark">Enty</span>
                  </span>
                </div>
              )}
              <div className="evd-hero-actions">{posterActions()}</div>
            </div>
            {showFlyer && (
              <a
                className="evd-poster-link"
                href={data.flyer_url}
                target="_blank"
                rel="noreferrer"
              >
                Ver afiche completo
              </a>
            )}
          </div>

          <div className="evd-info">
            <p className="evd-eyebrow">{data.category || "Evento"}</p>
            <h1 className="evd-title">{data.name}</h1>
            <div className="evd-lang-row">
              <label htmlFor="evd-lang">Idioma</label>
              <select id="evd-lang" value={lang} onChange={(e) => setLang(e.target.value)}>
                <option value="es">Español</option>
                <option value="en">English</option>
                <option value="pt">Português</option>
              </select>
            </div>
            {recovery && (
              <div className="evd-recovery" role="status">
                <strong>Retoma tu compra</strong>
                <span>
                  {recovery.type_name || "Tu localidad"} · {money(recovery.price_cents)}
                  {recovery.available != null ? ` · ${recovery.available} disponibles` : ""}
                </span>
                <button type="button" className="evd-cta" onClick={() => setCheckoutOpen(true)}>
                  Retomar compra
                </button>
              </div>
            )}
            <p className="evd-when">
              <Icon name="calendar" className="h-4 w-4" />
              <span>
                {when.date}
                {when.time ? ` · ${when.time}` : ""}
              </span>
            </p>
            <p className="evd-where">
              <Icon name="pin" className="h-4 w-4" />
              <span>
                {placeLabel(data.venue, data.location) ||
                  "Lugar por confirmar"}
              </span>
            </p>

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
                <span className="evd-cell-v">
                  {data.venue || data.location || "—"}
                </span>
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
                {data.price_cents != null && (
                  <span className="evd-cell-sub">desde</span>
                )}
              </div>
            </div>

            <section className="evd-section" aria-labelledby="evd-tickets-title">
              <h2 id="evd-tickets-title" className="evd-section-title">
                Boletas
              </h2>
              <ul className="evd-ticket-list">
                {ticketRows.map((t) => (
                  <li key={t.id} className="evd-ticket-row">
                    <span className="evd-ticket-name">
                      {t.name}
                      {t.sessions?.length ? (
                        <small className="evd-ticket-includes">
                          Incluye: {t.sessions.map((s) => s.name).join(" · ")}
                        </small>
                      ) : null}
                    </span>
                    {t.sold_out && (
                      <span className="evd-ticket-badge">Agotada</span>
                    )}
                    <span className="evd-ticket-price">
                      {t.is_courtesy || t.price_cents == null
                        ? "Gratis"
                        : money(t.price_cents)}
                    </span>
                  </li>
                ))}
              </ul>

              <div className="evd-buy enty-notch">
                <div className="evd-buy-row">
                  <span className="evd-buy-label">
                    {data.price_cents == null ? "Entrada" : "Entrada desde"}
                  </span>
                  <span className="evd-buy-price tnum">
                    {data.price_cents == null
                      ? "Gratis"
                      : money(data.price_cents)}
                  </span>
                </div>
                <p className="evd-buy-note">
                  {data.sold_out
                    ? "Agotado. Entra a la lista de espera: si alguien devuelve su boleta, te avisamos."
                    : data.price_cents == null
                      ? contactWa
                        ? "Cortesía: escríbele al organizador para coordinar tu entrada."
                        : "Cortesía: el acceso se valida con QR en la puerta."
                      : data.payments_enabled
                        ? "Compra en línea y recibe tu QR para la puerta."
                        : contactWa
                          ? "Escríbele al organizador y te agenda la boleta."
                          : "La compra en línea no está disponible para este evento."}
                </p>
                <div ref={buyCtaRef} className="evd-buy-cta">
                  {ticketCta(true)}
                </div>
              </div>
            </section>

            {data.video_url && (
              <section className="evd-section" aria-labelledby="evd-video-title">
                <h2 id="evd-video-title" className="evd-section-title">
                  Video del evento
                </h2>
                {videoFailed ? (
                  <p className="evd-muted">
                    El video no está disponible. La información y las boletas
                    siguen aquí.
                  </p>
                ) : !videoStarted ? (
                  <button
                    type="button"
                    className="evd-video-cover"
                    onClick={() => setVideoStarted(true)}
                    aria-label={`Reproducir video de ${data.name}`}
                  >
                    {showFlyer ? (
                      <img src={data.flyer_url} alt="" decoding="async" />
                    ) : (
                      <span className="evd-video-fallback" aria-hidden="true" />
                    )}
                    <span className="evd-video-play" aria-hidden="true">
                      <Icon name="play" className="h-8 w-8" />
                    </span>
                    <span className="evd-video-caption">
                      Ver video del evento
                    </span>
                  </button>
                ) : (
                  <>
                    <div className="evd-video-frame">
                      <video
                        ref={videoRef}
                        className="evd-video-player"
                        src={data.video_url}
                        poster={showFlyer ? data.flyer_url : undefined}
                        controls
                        autoPlay
                        muted
                        playsInline
                        preload="metadata"
                        aria-label={`Video de ${data.name}`}
                        onPlay={() => setVideoPlaying(true)}
                        onPause={() => setVideoPlaying(false)}
                        onEnded={() => setVideoPlaying(false)}
                        onError={() => {
                          setVideoFailed(true);
                          setVideoPlaying(false);
                        }}
                      >
                        Tu navegador no puede reproducir este video.
                      </video>
                      {/* El clip puede ser vertical y verse sin audio: estos
                          datos también viven como texto en la ficha, pero aquí
                          acompañan la reproducción. */}
                      <div className="evd-video-meta" aria-hidden="true">
                        <strong>{data.name}</strong>
                        <span>
                          {when.date}
                          {when.time ? ` · ${when.time}` : ""}
                        </span>
                        <span>
                          {placeLabel(data.venue, data.location) ||
                            "Lugar por confirmar"}
                        </span>
                        {videoTags && (
                          <span className="evd-video-tags">{videoTags}</span>
                        )}
                      </div>
                    </div>
                    <p className="evd-video-note">
                      Se reproduce sin sonido. Los datos clave están escritos
                      arriba y abajo del video.
                    </p>
                  </>
                )}
              </section>
            )}

            {hasAbout && (
              <section className="evd-section" aria-labelledby="evd-about-title">
                <h2 id="evd-about-title" className="evd-section-title">
                  Sobre el evento
                </h2>
                {data.description && (
                  <p className="evd-prose">{data.description}</p>
                )}

                {data.lineup?.length > 0 && (
                  <div className="evd-subsection">
                    <h3 className="evd-subtitle">Artistas y programación</h3>
                    <ul className="evd-lineup">
                      {data.lineup.map((a) => (
                        <li key={a.id ?? a.name}>
                          {a.image_url ? (
                            <img
                              className="evd-lineup-avatar evd-lineup-photo"
                              src={a.image_url}
                              alt=""
                              loading="lazy"
                            />
                          ) : (
                            <span className="evd-lineup-avatar" aria-hidden="true">
                              {a.name.charAt(0)}
                            </span>
                          )}
                          <span className="evd-lineup-info">
                            <strong>{a.name}</strong>
                            {a.role && <em>{a.role}</em>}
                            {a.starts_at && (
                              <span className="evd-lineup-time">
                                {new Date(a.starts_at).toLocaleTimeString(
                                  "es-CO",
                                  {
                                    hour: "2-digit",
                                    minute: "2-digit",
                                    timeZone: data.timezone || undefined,
                                  },
                                )}
                              </span>
                            )}
                            {a.description && (
                              <span className="evd-lineup-desc">
                                {a.description}
                              </span>
                            )}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {(data.min_age != null ||
                  data.dress_code ||
                  data.doors_open_at) && (
                  <div className="evd-subsection">
                    <h3 className="evd-subtitle">Condiciones de ingreso</h3>
                    <ul className="evd-facts">
                      {data.min_age != null && (
                        <li className="evd-fact">
                          <span className="evd-fact-k">Edad mínima</span>
                          <span className="evd-fact-v">
                            {data.min_age === 0
                              ? "Todas las edades"
                              : `${data.min_age}+`}
                          </span>
                        </li>
                      )}
                      {data.dress_code && (
                        <li className="evd-fact">
                          <span className="evd-fact-k">Dress code</span>
                          <span className="evd-fact-v">{data.dress_code}</span>
                        </li>
                      )}
                      {data.doors_open_at && (
                        <li className="evd-fact">
                          <span className="evd-fact-k">Puertas</span>
                          <span className="evd-fact-v">
                            {new Date(data.doors_open_at).toLocaleTimeString(
                              "es-CO",
                              {
                                hour: "2-digit",
                                minute: "2-digit",
                                timeZone: data.timezone || undefined,
                              },
                            )}
                          </span>
                        </li>
                      )}
                    </ul>
                  </div>
                )}
              </section>
            )}

            {hasLocation && (
              <section className="evd-section" aria-labelledby="evd-place-title">
                <h2 id="evd-place-title" className="evd-section-title">
                  Lugar
                </h2>
                <p className="evd-place-name">
                  {data.venue || data.location || "Lugar por confirmar"}
                </p>
                {data.venue && data.location && (
                  <p className="evd-address">
                    <Icon name="pin" className="h-4 w-4" />
                    {data.location}
                  </p>
                )}
                {data.location_url ? (
                  <a
                    className="evd-cta evd-cta--ghost evd-map-link"
                    href={data.location_url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Cómo llegar
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M5 12h13M13 6l6 6-6 6" />
                    </svg>
                  </a>
                ) : (
                  <p className="evd-muted">
                    El organizador aún no confirmó un enlace de mapa. Esta es la
                    dirección publicada.
                  </p>
                )}
              </section>
            )}

            {extras?.transport?.length > 0 && (
              <section className="evd-section" aria-labelledby="evd-transport-title">
                <h2 id="evd-transport-title" className="evd-section-title">
                  Transporte
                </h2>
                <div className="evd-extra-list">
                  {extras.transport.map((t) => (
                    <div className="evd-extra-card" key={t.id}>
                      <strong>{t.name}</strong>
                      <span>{t.kind}{t.schedule ? ` · ${t.schedule}` : ""}</span>
                      {t.detail && <small>{t.detail}</small>}
                      {t.map_url && (
                        <a href={t.map_url} target="_blank" rel="noreferrer">Ver mapa</a>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            )}

            {extras?.map_points?.length > 0 && (
              <section className="evd-section" aria-labelledby="evd-map-title">
                <h2 id="evd-map-title" className="evd-section-title">
                  Puntos de encuentro
                </h2>
                <div className="evd-extra-list">
                  {extras.map_points.map((p) => (
                    <div className="evd-extra-card" key={p.id}>
                      <strong>{p.name}</strong>
                      <span>{p.kind}{p.accessible ? " · accesible" : ""}</span>
                      {p.description && <small>{p.description}</small>}
                    </div>
                  ))}
                </div>
              </section>
            )}

            {resales.length > 0 && (
              <section className="evd-section" aria-labelledby="evd-resale-title">
                <h2 id="evd-resale-title" className="evd-section-title">
                  Reventa oficial
                </h2>
                <p className="evd-muted">
                  Boletas de personas que no pueden ir, a precio controlado.
                  Enty anula el QR anterior al confirmar la compra.
                </p>
                {resaleMsg && <p className="evd-muted" role="status">{resaleMsg}</p>}
                <div className="evd-extra-list">
                  {resales.map((r) => (
                    <div className="evd-extra-card" key={r.id}>
                      <strong>{r.type_name} · {money(r.price_cents)}</strong>
                      <span>Vende {r.seller_first_name}</span>
                      {resaleForm.id === r.id ? (
                        <form className="evd-resale-form" onSubmit={requestResaleOffer}>
                          <input placeholder="Tu nombre" value={resaleForm.name}
                            onChange={(e) => setResaleForm((f) => ({ ...f, name: e.target.value }))} />
                          <input placeholder="Tu WhatsApp" value={resaleForm.phone}
                            onChange={(e) => setResaleForm((f) => ({ ...f, phone: e.target.value }))} />
                          <button type="submit" className="evd-cta">Enviar solicitud</button>
                        </form>
                      ) : (
                        <button type="button" className="evd-cta evd-cta--ghost"
                          onClick={() => setResaleForm({ id: r.id, name: "", phone: "" })}>
                          Quiero esta boleta
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            )}

            <section className="evd-section" aria-labelledby="evd-contact-title">
              <h2 id="evd-contact-title" className="evd-section-title">
                Contacto
              </h2>
              {organizerWa ? (
                <a
                  className="evd-contact-card"
                  href={organizerWa}
                  target="_blank"
                  rel="noreferrer"
                >
                  <Icon name="whatsapp" className="evd-contact-icon" />
                  <span className="evd-contact-text">
                    <strong>Contactar al organizador</strong>
                    <span>
                      Escríbele a{" "}
                      {data.contact_name || data.venue || "el organizador"}
                    </span>
                  </span>
                </a>
              ) : (
                <p className="evd-muted">
                  El organizador no publicó un WhatsApp para este evento.
                </p>
              )}
              <ContactSupport
                className="evd-support"
                prompt="¿Problemas con tu boleta?"
                label="Ayuda con mi boleta"
                message={`Hola, necesito ayuda con mi boleta para ${data.name}.`}
              />
            </section>

            <section className="evd-section evd-share" aria-labelledby="evd-share-title">
              <h2 id="evd-share-title" className="evd-section-title">
                Compartir
              </h2>
              <p className="evd-muted">
                Manda esta ficha por WhatsApp o copia el enlace. Quien la abra
                no necesita crear una cuenta.
              </p>
              <button
                type="button"
                className="evd-cta evd-cta--ghost evd-share-btn"
                onClick={share}
              >
                <Icon name="share" className="h-4 w-4" />
                Compartir evento
              </button>
            </section>
          </div>
        </div>
      )}

      {copied && (
        <p className="evd-copied" role="status">
          Enlace copiado
        </p>
      )}

      {showBuyBar && (
        <div className="evd-buybar" role="region" aria-label="Compra de boletas">
          <div className="evd-buybar-price">
            <span className="tnum">
              {data.sold_out
                ? "Agotado"
                : data.price_cents == null
                  ? "Gratis"
                  : money(data.price_cents)}
            </span>
            <small>{data.sold_out ? "Lista de espera" : "desde"}</small>
          </div>
          {ticketCta()}
        </div>
      )}

      {queueOpen && data && waitingRoom.state !== "admitted" && (
        <WaitingRoomOverlay
          state={waitingRoom.state}
          position={waitingRoom.position}
          eventName={data.name}
          onRetry={waitingRoom.retry}
          onLeave={() => setQueueOpen(false)}
        />
      )}

      {(checkoutOpen || payRef) && data && (
        <FanCheckoutModal
          event={data}
          reference={payRef}
          contactHref={organizerWa}
          promoterRef={promoterRef}
          lang={lang}
          waitingPass={waitingRoom.passToken}
          onWaitingPassRejected={() => {
            // El pase vencio o no le tocaba: vuelve a la fila a por otro.
            setCheckoutOpen(false);
            setQueueOpen(true);
          }}
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
