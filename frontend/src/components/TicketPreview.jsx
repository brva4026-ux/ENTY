import { useEffect, useState } from "react";

/**
 * Dibuja un QR ASCII/patrón en canvas como vista previa real de la boleta.
 * En producción se usará la imagen generada por el backend (services/ticket_image.py).
 */
export default function TicketPreview({ rawToken, ticketId, name, color = "#6366f1" }) {
  const [hash, setHash] = useState(0);

  useEffect(() => {
    // hash simple del token para variar el patrón
    let h = 0;
    for (let i = 0; i < rawToken.length; i++) h = (h * 31 + rawToken.charCodeAt(i)) | 0;
    setHash(Math.abs(h));
  }, [rawToken]);

  return (
    <div className="overflow-hidden rounded-xl bg-slate-950">
      <div className="flex items-center gap-4 p-4">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-white">{name}</p>
          <p className="text-xs text-slate-400">Boleta #{ticketId}</p>
        </div>
        <FakeQr hash={hash} color={color} />
      </div>
      <div className="border-t border-slate-800 px-4 py-2 text-[10px] text-slate-500">
        Presenta este código en la entrada · TicketFlow
      </div>
    </div>
  );
}

function FakeQr({ hash, color }) {
  const N = 11; // grid 11x11 (determinista salvo 3 finder)
  const cells = [];
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const inFinderA = i < 3 && j < 3;
      const inFinderB = i < 3 && j >= N - 3;
      const inFinderC = i >= N - 3 && j < 3;
      if (inFinderA || inFinderB || inFinderC) continue;
      cells.push({ x: j, y: i, on: ((hash >> ((i * 7 + j) % 31)) & 1) === 1 });
    }
  }
  return (
    <div className="shrink-0 rounded-md bg-white p-1">
      <div className="grid grid-cols-11 gap-px" style={{ width: 88, height: 88 }}>
        {Array.from({ length: N * N }).map((_, idx) => {
          const i = Math.floor(idx / N);
          const j = idx % N;
          const inAnyFinder = (i < 3 && j < 3) || (i < 3 && j >= N - 3) || (i >= N - 3 && j < 3);
          const on = cells.find((c) => c.x === j && c.y === i)?.on ?? inAnyFinder;
          return <span key={idx} style={{ background: on ? "#000" : "#fff" }} />;
        })}
      </div>
    </div>
  );
}