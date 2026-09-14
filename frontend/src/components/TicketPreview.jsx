import { useEffect, useState } from "react";
import QRCode from "qrcode";

/** Boleta visual con QR real (escaneable por la app del bouncer). */
export default function TicketPreview({ rawToken, ticketId, name, eventName }) {
  const [qrDataUrl, setQrDataUrl] = useState(null);

  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(rawToken, {
      width: 480,
      margin: 1,
      errorCorrectionLevel: "M",
      color: { dark: "#0f172a", light: "#ffffff" },
    })
      .then((url) => {
        if (alive) setQrDataUrl(url);
      })
      .catch(() => {
        if (alive) setQrDataUrl(null);
      });
    return () => {
      alive = false;
    };
  }, [rawToken]);

  return (
    <div className="overflow-hidden rounded-2xl bg-gradient-to-br from-slate-900 to-slate-950 ring-1 ring-slate-700/60">
      <div className="relative flex items-center gap-4 p-5">
        {/* perforación lateral estilo ticket */}
        <div aria-hidden className="absolute left-[calc(100%-7.25rem)] top-0 h-full w-px bg-slate-700/70" />
        <div aria-hidden className="absolute -left-2.5 top-1/2 h-5 w-5 -translate-y-1/2 rounded-full bg-slate-950 ring-1 ring-slate-700" />
        <div aria-hidden className="absolute -right-[6.6rem] top-1/2 h-5 w-5 -translate-y-1/2 rounded-full bg-slate-950 ring-1 ring-slate-700" />

        <div className="min-w-0 flex-1">
          {eventName && (
            <p className="mb-0.5 truncate text-xs font-bold uppercase tracking-wider text-brand-400">
              {eventName}
            </p>
          )}
          <p className="truncate text-lg font-black text-white">{name}</p>
          <p className="tnum text-xs text-slate-500">Boleta #{ticketId}</p>
        </div>
        <div className="shrink-0 rounded-lg bg-white p-1.5 shadow-lg">
          {qrDataUrl ? (
            <img src={qrDataUrl} alt="QR de la boleta" className="h-24 w-24" />
          ) : (
            <div className="skeleton h-24 w-24 !rounded-md" />
          )}
        </div>
      </div>
      <div className="border-t border-dashed border-slate-700/70 px-5 py-2.5">
        <p className="text-[11px] font-medium text-slate-500">
          Presenta este QR en la entrada · TicketFlow
        </p>
      </div>
    </div>
  );
}
