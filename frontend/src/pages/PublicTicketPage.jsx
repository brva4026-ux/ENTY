import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { fetchPublicTicket, fetchTicketImage, returnTicket } from "../lib/api";
import { eventDate } from "../lib/format";
import { forceDarkOnce } from "../lib/theme";
import Icon from "../components/Icon";

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

export default function PublicTicketPage() {
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
      const file = new File(
        [blob],
        `boleta-${ticket?.ticket_id ?? "ticketflow"}.jpg`,
        {
          type: "image/jpeg",
        },
      );
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

  return (
    <div className="tkt-stage">
      <div className="tkt-wrap">
        {/* El ticket: credencial ambar troquelada, como las de festival */}
        <div className="tkt">
          <div className="tkt-head">
            <div className="min-w-0">
              <p className="tkt-date">{eventDate(ticket?.starts_at) || "—"}</p>
              <p className="tkt-venue truncate">{ticket?.venue_name ?? ""}</p>
            </div>
            <span className="tkt-brand">Tickelot</span>
          </div>

          <h1 className="tkt-title">{ticket?.event_name ?? "Tu boleta"}</h1>
          <p className="tkt-sub">Boleta de invitado</p>

          <div className="tkt-tear" aria-hidden="true" />

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
                <p className="mt-2 text-[11px] font-semibold opacity-70">
                  Guarda este enlace: es tu boleta y en la puerta va a funcionar.
                </p>
              </div>
            ) : (
              <>
                <div className="tkt-qr-zone">
                  <div className="tkt-qr">
                    {qrDataUrl ? (
                      <img src={qrDataUrl} alt="QR de tu boleta" />
                    ) : (
                      <div className="skeleton" />
                    )}
                    {redeemed && (
                      <div className="absolute inset-0 grid place-items-center rounded-[1rem] bg-zinc-950/70">
                        <span className="rounded-full bg-white/95 px-3 py-1 text-xs font-bold text-black">
                          Ya usada
                        </span>
                      </div>
                    )}
                  </div>
                  <span className="tkt-admit">Admit one</span>
                </div>

                <div className="tkt-grid">
                  <div className="tkt-cell">
                    <p className="tkt-cell-label">Boleta</p>
                    <p className="tkt-cell-value tnum">
                      #{ticket?.ticket_id ?? "—"}
                    </p>
                  </div>
                  <div className="tkt-cell">
                    <p className="tkt-cell-label">Fecha</p>
                    <p className="tkt-cell-value">
                      {eventDate(ticket?.starts_at) || "—"}
                    </p>
                  </div>
                  <div className="tkt-cell">
                    <p className="tkt-cell-label">Estado</p>
                    <p className="tkt-cell-value">
                      {redeemed ? "Usada" : "Lista"}
                    </p>
                  </div>
                </div>
                <div className="tkt-name-row">
                  <p className="tkt-cell-label">Invitado</p>
                  <p className="tkt-cell-value">{ticket?.customer_name ?? "—"}</p>
                </div>
                {ticket?.location && (
                  <p
                    className="mt-2.5 flex items-start justify-center gap-1.5 text-center text-xs font-semibold"
                    style={{ color: "rgba(74, 47, 5, 0.8)" }}
                  >
                    <Icon name="door" className="mt-px h-3.5 w-3.5 shrink-0" />
                    {ticket.location}
                  </p>
                )}
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
                      <p className="mt-1.5 text-xs font-bold text-red-700">
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
          <span>Tickelot</span>
        </div>
        <p className="tkt-footer">Guarda esta página: la necesitas en la entrada</p>
      </div>
    </div>
  );
}
