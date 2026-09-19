import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { fetchPublicTicket, fetchTicketImage } from "../lib/api";
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
      errorCorrectionLevel: "M",
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
      const file = new File([blob], `boleta-${ticket?.ticket_id ?? "ticketflow"}.jpg`, {
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
          { label: ticket.status === "redeemed" ? "Usada" : "Escaneada", state: ticket.status === "redeemed" ? "done" : "" },
        ]
      : null;

  return (
    <div className="grain relative min-h-screen overflow-hidden bg-slate-950 px-4 py-8">
      <div className="atmosphere" aria-hidden="true" />
      <div className="relative mx-auto w-full max-w-sm animate-rise">
        <div className="card-lit card p-5">
          <div className="mb-4 flex items-center gap-2">
            <span className="tile grid h-9 w-9">
              <Icon name="ticket" className="h-4 w-4 text-brand-400" />
            </span>
            <div className="min-w-0">
              <p className="eyebrow">Tu boleta</p>
              <p className="truncate text-sm font-bold text-white">
                {ticket?.event_name ?? "Cargando…"}
              </p>
            </div>
          </div>

          {error ? (
            <div className="rounded-xl bg-red-500/10 p-4 text-center ring-1 ring-red-500/30">
              <Icon name="alert" className="mx-auto mb-2 h-6 w-6 text-red-400" />
              <p className="text-sm font-medium text-red-300">{error}</p>
            </div>
          ) : (
            <>
              {!qrActive ? (
                <div className="rounded-2xl bg-slate-800/60 p-6 text-center ring-1 ring-slate-700/50">
                  <span className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-full bg-brand-500/15">
                    <Icon name="clock" className="h-7 w-7 text-brand-300" />
                  </span>
                  <p className="text-sm font-bold text-white">Tu QR aún no se activa</p>
                  <p className="mt-1 text-xs leading-relaxed text-slate-300">{qrMessage}</p>
                  <p className="mt-3 text-[11px] text-slate-400">
                    Guarda este enlace: es tu boleta y en la puerta va a funcionar.
                  </p>
                </div>
              ) : (
                <>
                  <div className="relative mx-auto w-fit rounded-2xl bg-white p-3 shadow-2xl">
                    {qrDataUrl ? (
                      <img src={qrDataUrl} alt="QR de tu boleta" className="h-56 w-56" />
                    ) : (
                      <div className="skeleton h-56 w-56 !rounded-lg" />
                    )}
                    {redeemed && (
                      <div className="absolute inset-0 grid place-items-center rounded-2xl bg-slate-950/70">
                        <span className="rounded-full bg-white/95 px-3 py-1 text-xs font-bold text-slate-900">
                          Ya usada
                        </span>
                      </div>
                    )}
                  </div>

                  <p className="mt-3 text-center text-sm text-slate-400">
                    Muestra este QR en la entrada
                  </p>
                </>
              )}

              {lifecycle && (
                <div className="ticket-timeline mt-4 rounded-xl bg-slate-800/40 px-4 py-3 ring-1 ring-slate-700/40">
                  {lifecycle.map((step) => (
                    <div key={step.label} className={`ticket-step ${step.state}`}>
                      <span className="ticket-step-dot" aria-hidden="true" />
                      <span className="ticket-step-label">{step.label}</span>
                    </div>
                  ))}
                </div>
              )}

              <div className="mt-5 space-y-1 rounded-xl bg-slate-800/60 p-3 ring-1 ring-slate-700/50">
                <p className="text-base font-bold text-white">
                  {ticket?.customer_name ?? "—"}
                </p>
                <p className="text-xs text-slate-400">{ticket?.venue_name}</p>
                <p className="flex items-center gap-1.5 text-xs text-slate-400">
                  <Icon name="clock" className="h-3.5 w-3.5" />
                  {ticket?.starts_at}
                </p>
                {ticket?.location && (
                  <p className="flex items-start gap-1.5 text-xs text-slate-300">
                    <Icon name="door" className="mt-px h-3.5 w-3.5 shrink-0" />
                    {ticket.location}
                  </p>
                )}
                {ticket && (
                  <p className="tnum text-xs text-slate-500">
                    Boleta #{ticket.ticket_id}
                  </p>
                )}
              </div>

              <button
                type="button"
                onClick={shareOrDownload}
                disabled={!imageUrl || busy || !qrActive}
                title={!qrActive ? "El QR se activa cerca de la fecha del evento" : undefined}
                className="btn-primary mt-4 w-full disabled:opacity-50"
              >
                <Icon name="whatsapp" className="h-4 w-4" />
                {busy
                  ? "Abriendo…"
                  : qrActive
                    ? "Compartir o guardar imagen"
                    : "Imagen disponible cuando se active el QR"}
              </button>
            </>
          )}
        </div>

        <p className="mt-4 text-center text-xs text-slate-600">
          Guarda esta página: la necesitas en la entrada · TicketFlow
        </p>
      </div>
    </div>
  );
}
