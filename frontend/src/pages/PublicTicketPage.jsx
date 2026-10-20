import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { fetchPublicTicket, fetchTicketImage, returnTicket } from "../lib/api";
import { eventDate, clockTime } from "../lib/format";
import { forceDarkOnce } from "../lib/theme";
import Icon from "../components/Icon";
import useDocumentTitle from "../lib/useDocumentTitle";

/**
 * Boleta del invitado. Es la pagina publica que se comparte por WhatsApp: el
 * invitado la abre en su telefono y muestra el QR al bouncer.
 *
 * El token llega en el FRAGMENTO de la URL (`/t#<token>`), no en la ruta: el
 * navegador nunca envia el fragmento al servidor, asi que el token no queda en
 * los logs de Vercel ni en el `Referer` de terceros. El QR codifica el token
 * crudo, que es lo que BouncerScanner espera al escanear.
 */

/** Lee el token del fragmento y limpia la barra: que no quede a la vista. */
function readToken() {
  const raw = window.location.hash.replace(/^#/, "").trim();
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Isotipo Enty: la "E" con muesca de boleto, en blanco sobre la boleta. */
function EntyMark({ className }) {
  return (
    <svg viewBox="0 0 64 84" className={className} aria-hidden="true">
      <path
        d="M8 4h48a4 4 0 0 1 4 4v14a11 11 0 0 0 0 22v14a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V62a11 11 0 0 0 0-22V8a4 4 0 0 1 4-4Z"
        fill="#FFFFFF"
      />
      <g fill="#0A0A0D">
        <rect x="20" y="24" width="26" height="6" rx="3" />
        <rect x="20" y="40" width="26" height="6" rx="3" />
        <rect x="20" y="56" width="26" height="6" rx="3" />
      </g>
    </svg>
  );
}

/** Estrella de cuatro puntas (acento de marca). */
function Star({ className, color = "#00E6AB" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path
        fill={color}
        d="M12 1 l2.6 8.4 8.4 2.6 -8.4 2.6 -2.6 8.4 -2.6 -8.4 -8.4 -2.6 8.4 -2.6 z"
      />
    </svg>
  );
}

/** Código de barras decorativo (determinista: mismo ancho en cada render). */
function Barcode() {
  let seed = 99;
  const rnd = () =>
    (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const bars = [];
  let x = 0;
  while (x < 190) {
    const w = 0.6 + rnd() * 2.2;
    if (rnd() > 0.45) {
      bars.push(
        <rect
          key={x.toFixed(1)}
          x={x.toFixed(1)}
          y="0"
          width={w.toFixed(1)}
          height="40"
        />,
      );
    }
    x += w + 0.6 + rnd() * 1.6;
  }
  return <g fill="#FFFFFF">{bars}</g>;
}

export default function PublicTicketPage() {
  useDocumentTitle("Tu boleta");
  const [token] = useState(readToken);
  const [ticket, setTicket] = useState(null);
  const [qrDataUrl, setQrDataUrl] = useState(null);
  const [imageUrl, setImageUrl] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // La boleta pública SIEMPRE es oscura (es la credencial de la noche: se
  // muestra en la puerta a oscuras, igual que el escáner). Sin el candado,
  // un invitado con tema claro ve texto blanco sobre blanco.
  useEffect(() => forceDarkOnce(), []);
  // Devolucion (mig 021): confirmacion en dos pasos — es irreversible.
  const [confirming, setConfirming] = useState(false);
  const [returning, setReturning] = useState(false);
  const [returnError, setReturnError] = useState("");

  useEffect(() => {
    if (!token) {
      setError("Este enlace no trae una boleta.");
      return;
    }
    let alive = true;

    fetchPublicTicket(token)
      .then((t) => {
        if (alive) setTicket(t);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });

    // El QR se genera local: el invitado lo ve aunque la imagen del servidor
    // tarde o falle.
    QRCode.toDataURL(token, {
      width: 640,
      margin: 1,
      // Mismo nivel que la imagen del servidor (ticket_image): la boleta se
      // muestra con brillo bajo o llega por WhatsApp; con correccion H (30%)
      // el escaneo en la puerta falla mucho menos que con M.
      errorCorrectionLevel: "H",
      color: { dark: "#0f172a", light: "#ffffff" },
    })
      .then((url) => {
        if (alive) setQrDataUrl(url);
      })
      .catch(() => {});

    // Imagen compuesta (flyer + QR) para descargar o reenviar.
    fetchTicketImage(token)
      .then((blob) => {
        if (alive) setImageUrl(URL.createObjectURL(blob));
      })
      .catch(() => {});

    return () => {
      alive = false;
    };
  }, [token]);

  // Liberar los object URLs al desmontar (si no, se filtran en el celular)
  useEffect(() => {
    return () => {
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    };
  }, [imageUrl]);

  async function shareOrDownload() {
    if (!imageUrl) return;
    setBusy(true);
    try {
      const blob = await (await fetch(imageUrl)).blob();
      const file = new File([blob], `boleta-${ticket?.ticket_id ?? "enty"}.jpg`, {
        type: "image/jpeg",
      });
      // Web Share API (movil): manda la IMAGEN, no un texto.
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: "Mi boleta" });
        return;
      }
      const a = document.createElement("a");
      a.href = imageUrl;
      a.download = file.name;
      a.click();
    } catch {
      // el usuario cancelo el share
    } finally {
      setBusy(false);
    }
  }

  const redeemed = ticket?.status === "redeemed";
  // Estados terminales: la boleta no muestra QR por ningun lado. La copa
  // cambia si fue DEVUELTA por el invitado (was_returned) o anulada por staff.
  const terminal =
    ticket?.status === "voided" || ticket?.status === "refunded";
  const returned = ticket?.was_returned === true;

  async function doReturn() {
    setReturning(true);
    setReturnError("");
    try {
      await returnTicket(ticket.ticket_id, token);
      // Re-consultar: el backend decide el estado real (voided + was_returned).
      const t = await fetchPublicTicket(token);
      setTicket(t);
      setConfirming(false);
    } catch (e) {
      setReturnError(e.message || "No se pudo devolver la boleta");
    } finally {
      setReturning(false);
    }
  }
  // Activación del QR (mig 013, patrón DICE): el backend decide si el QR
  // es visible y, si no, manda el mensaje con la hora de activación. El QR
  // local se genera solo con la boleta activa: fuera de ventana el invitado
  // ve el aviso, no el código.
  const qrActive = ticket ? ticket.qr_active !== false : true;
  const qrMessage = ticket?.qr_message ?? null;

  /**
   * Ciclo de vida de la boleta (patrón timeline de reportes de distri-stream):
   * emitida -> en la entrada -> usada. El punto "actual" pulsa en verde:
   * el invitado ve de un vistazo que su QR está listo. Solo para el ciclo
   * normal (issued/redeemed): anulada/reembolsada no lo muestra.
   */
  const lifecycle =
    ticket?.status === "issued" || ticket?.status === "redeemed"
      ? [
          { label: "Emitida", state: "done" },
          {
            label: "En la entrada",
            state: ticket.status === "redeemed" ? "done" : "current",
          },
          {
            label: ticket.status === "redeemed" ? "Usada" : "Escaneada",
            state: ticket.status === "redeemed" ? "done" : "",
          },
        ]
      : null;

  // Localidad del talón: "CIUDAD, REGION" derivada del venue con heuristicas
  // tolerantes a los separadores que usa el formulario.
  const venue = ticket?.venue_name ?? "";
  const [venueMain, venueCityRaw] = venue.includes("·")
    ? venue.split("·").map((s) => s.trim())
    : [venue, ""];
  const venueCity = /online|virtual|remoto/i.test(venue)
    ? "EN LÍNEA"
    : (venueCityRaw || venueMain).toUpperCase();

  const statusLabel = terminal
    ? returned
      ? "DEVUELTA"
      : "ANULADA"
    : redeemed
      ? "USADA"
      : "VÁLIDA";

  // Hora de puerta: solo se muestra si la fecha no la trae ya formateada.
  const dateStr = eventDate(ticket?.starts_at) || "—";
  const doorTime = /\d{1,2}:\d{2}/.test(dateStr)
    ? null
    : clockTime(ticket?.starts_at);
  const year = new Date(ticket?.starts_at).getFullYear();

  return (
    <div className="tkt-stage">
      <div className="tkt-wrap">
        {/* El ticket: pase de festival de papel negro con acentos neon */}
        <div className="tkt">
          <div className="tkt-head">
            <div className="tkt-brand-lock">
              <EntyMark className="tkt-mark" />
              <span>Enty</span>
            </div>
            <p className="tkt-connect">
              Music
              <br />
              Connects
              <br />
              Us<span className="tkt-arw">↗</span>
            </p>
          </div>

          <div className="tkt-hero">
            <svg
              className="tkt-orbit"
              viewBox="0 0 430 190"
              aria-hidden="true"
              preserveAspectRatio="xMidYMid meet"
            >
              <ellipse
                cx="215"
                cy="95"
                rx="205"
                ry="58"
                fill="none"
                stroke="#00E6AB"
                strokeWidth="1.6"
                opacity="0.8"
                transform="rotate(-7 215 95)"
              />
              <path
                d="M360 24 l6 15 15 6 -15 6 -6 15 -6 -15 -15 -6 15 -6 z"
                fill="#00E6AB"
                className="tkt-orbit-star"
              />
            </svg>
            <p className="tkt-kicker">Festival</p>
            <h1 className="tkt-title">{ticket?.event_name ?? "Tu boleta"}</h1>
            <p className="tkt-tags">
              Music / Art / Nature
              <span className="tkt-one">One Night</span>
            </p>
          </div>

          <div className="tkt-body">
            {error ? (
              <div className="tkt-note">
                <span className="tkt-note-icon">
                  <Icon name="alert" className="h-6 w-6" />
                </span>
                <strong>No pudimos abrir tu boleta</strong>
                <p>{error}</p>
              </div>
            ) : terminal ? (
              <div className="tkt-note">
                <span className="tkt-note-icon">
                  <Icon name={returned ? "undo" : "alert"} className="h-6 w-6" />
                </span>
                <strong>{returned ? "Boleta devuelta" : "Boleta anulada"}</strong>
                <p>
                  {returned
                    ? "Devuiste esta boleta y su QR quedó sin efecto. Si cambias de opinión, pide una nueva al promotor."
                    : "Esta boleta fue anulada por el organizador y no permite el ingreso."}
                </p>
              </div>
            ) : !qrActive ? (
              <div className="tkt-note">
                <span className="tkt-note-icon">
                  <Icon name="clock" className="h-6 w-6" />
                </span>
                <strong>Tu QR aún no se activa</strong>
                <p>{qrMessage}</p>
                <p className="mt-2 text-2xs font-semibold opacity-70">
                  Guarda este enlace: es tu boleta y en la puerta va a funcionar.
                </p>
              </div>
            ) : (
              <>
                <div className="tkt-body-grid">
                  <div className="tkt-when">
                    {year ? <p className="tkt-yr">{year}</p> : null}
                    <p className="tkt-big">{dateStr}</p>
                    {doorTime && <p className="tkt-hrs">Puerta {doorTime}</p>}
                    <p className="tkt-place">{venueMain || "—"}</p>
                    <p className="tkt-city">{venueCity}</p>
                  </div>

                  <div className="tkt-qr-zone">
                    <div className={`tkt-qr${qrDataUrl ? " reveal-qr" : ""}`}>
                      {qrDataUrl ? (
                        <img src={qrDataUrl} alt="QR de tu boleta" />
                      ) : (
                        <div className="skeleton" />
                      )}
                      <Star className="tkt-qr-star" />
                      {redeemed && (
                        <div className="tkt-qr-used">
                          <span>Ya usada</span>
                        </div>
                      )}
                    </div>
                    <span className="tkt-scan">
                      Scan for Entry <span className="tkt-arw">↗</span>
                    </span>
                  </div>
                </div>

                <div className="tkt-strokes" aria-hidden="true">
                  <svg viewBox="0 0 380 44" preserveAspectRatio="none">
                    <path
                      d="M8 30 C 70 8, 130 40, 196 20 S 320 6, 372 24"
                      fill="none"
                      stroke="#39FF14"
                      strokeWidth="5"
                      strokeLinecap="round"
                      opacity="0.9"
                      className="tkt-stroke-green"
                    />
                    <path
                      d="M20 38 C 96 22, 150 40, 214 26 S 330 14, 366 34"
                      fill="none"
                      stroke="#FF2D98"
                      strokeWidth="4"
                      strokeLinecap="round"
                      opacity="0.85"
                      className="tkt-stroke-pink"
                    />
                  </svg>
                </div>

                <div className="tkt-perf" aria-hidden="true" />

                <div className="tkt-stub">
                  <div className="tkt-seat">
                    <div className="tkt-seat-cell">
                      <p className="tkt-seat-k">Estado</p>
                      <p className="tkt-seat-v">{statusLabel}</p>
                    </div>
                    <div className="tkt-seat-cell">
                      <p className="tkt-seat-k">Boleta</p>
                      <p className="tkt-seat-v tnum">
                        #{ticket?.ticket_id ?? "—"}
                      </p>
                    </div>
                    <div className="tkt-seat-cell">
                      <p className="tkt-seat-k">Invitado</p>
                      <p className="tkt-seat-v tkt-seat-name">
                        {ticket?.customer_name ?? "—"}
                      </p>
                    </div>
                  </div>
                  <div className="tkt-admit">
                    <p className="tkt-admit-k">General Admission</p>
                    <div className="tkt-brand-lock tkt-brand-lock--sm">
                      <EntyMark className="tkt-mark" />
                      <span>Enty</span>
                    </div>
                  </div>
                </div>

                {ticket?.location && (
                  <p className="tkt-location">
                    <Icon name="door" className="mt-px h-3.5 w-3.5 shrink-0" />
                    {ticket.location}
                  </p>
                )}

                <div className="tkt-foot">
                  <div className="tkt-barcode" aria-hidden="true">
                    <svg viewBox="0 0 190 40" preserveAspectRatio="none">
                      <Barcode />
                    </svg>
                    <p className="tkt-barcode-cap">Enty App — Your Next Event</p>
                  </div>
                  <p className="tkt-sign">See You There!</p>
                </div>
              </>
            )}

            {!error && !terminal && (
              <div className="tkt-actions">
                {!confirming ? (
                  <>
                    <button
                      type="button"
                      onClick={shareOrDownload}
                      disabled={!imageUrl || busy || !qrActive}
                      title={
                        !qrActive
                          ? "El QR se activa cerca de la fecha del evento"
                          : undefined
                      }
                      className="tkt-btn tkt-btn-primary"
                    >
                      <Icon name="whatsapp" className="h-4 w-4" />
                      {busy
                        ? "Abriendo…"
                        : qrActive
                          ? "Compartir o guardar imagen"
                          : "Imagen cuando se active el QR"}
                    </button>
                    {ticket?.can_return && (
                      <button
                        type="button"
                        onClick={() => setConfirming(true)}
                        className="tkt-btn tkt-btn-quiet"
                      >
                        <Icon name="undo" className="h-4 w-4" />
                        No puedo ir — devolver boleta
                      </button>
                    )}
                  </>
                ) : (
                  <div className="tkt-note w-full !text-left">
                    <strong>¿Seguro que no puedes ir?</strong>
                    <p>
                      Esto es irreversible: tu QR muere y el lugar vuelve al
                      organizador
                      {ticket?.return_until
                        ? ` · Ventana abierta hasta ${ticket.return_until}`
                        : ""}
                      .
                    </p>
                    {returnError && (
                      <p className="mt-1.5 text-xs font-bold text-red-400">
                        {returnError}
                      </p>
                    )}
                    <div className="mt-3 flex gap-2">
                      <button
                        type="button"
                        onClick={doReturn}
                        disabled={returning}
                        className="tkt-btn tkt-btn-danger flex-1"
                      >
                        {returning ? "Devolviendo…" : "Sí, devolver"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirming(false)}
                        disabled={returning}
                        className="tkt-btn tkt-btn-quiet flex-1"
                      >
                        Volver
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Ciclo de vida: sobre el escenario oscuro, con la firma del sistema */}
        {lifecycle && !error && (
          <div className="ticket-timeline mx-auto mt-4 w-fit rounded-xl bg-zinc-900/50 px-4 py-3 ring-1 ring-zinc-800/80">
            {lifecycle.map((step) => (
              <div key={step.label} className={`ticket-step ${step.state}`}>
                <span className="ticket-step-dot" aria-hidden="true" />
                <span className="ticket-step-label">{step.label}</span>
              </div>
            ))}
          </div>
        )}

        <div className="tkt-brandline">
          <img src="/icon.svg" alt="" aria-hidden="true" />
          <span>Enty</span>
        </div>
        <p className="tkt-footer">Guarda esta página: la necesitas en la entrada</p>
      </div>
    </div>
  );
}
