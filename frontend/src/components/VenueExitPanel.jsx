import { useEffect, useState } from "react";
import { fetchVenueExport, getExitSummary } from "../lib/api";
import { useUI } from "../lib/ui";
import { money } from "../lib/format";

export default function VenueExitPanel({ venueId }) {
  const ui = useUI();
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!venueId) return;
    let alive = true;
    getExitSummary(venueId)
      .then((data) => alive && setSummary(data))
      .catch((err) => alive && setError(err.message));
    return () => {
      alive = false;
    };
  }, [venueId]);

  async function download() {
    setBusy(true);
    setError("");
    try {
      const blob = await fetchVenueExport(venueId);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `enty-${summary?.venue?.name || "organizacion"}-export.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      ui.success("Datos de la organización descargados");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="admin-org-grid" aria-label="Salida ordenada del servicio">
      <div className="admin-settings-card">
        <h2>Salida ordenada</h2>
        <p>
          Si algún día dejas Enty, tus datos son tuyos. Descarga eventos, tipos
          de boleta, ventas y equipo en un archivo reutilizable. Las boletas ya
          vendidas siguen siendo válidas hasta el final de cada evento.
        </p>
        {error && (
          <p className="mt-3 text-xs text-red-400" role="alert">
            {error}
          </p>
        )}
        <button type="button" className="btn-primary mt-4" onClick={download} disabled={busy}>
          {busy ? "Preparando…" : "Descargar datos de la organización"}
        </button>
        <p className="admin-note mt-3">
          El archivo no incluye códigos QR ni contraseñas. Solo la información
          que la organización está autorizada a conservar.
        </p>
      </div>

      <div className="admin-legal-card">
        <h2>Qué pasa al salir</h2>
        {!summary ? (
          <p>Cargando el resumen de la organización…</p>
        ) : (
          <ul className="space-y-2 text-sm">
            <li>
              <strong>{summary.future_events}</strong> eventos futuros
              {summary.selling_events ? ` · ${summary.selling_events} con venta abierta` : ""}.
            </li>
            <li>
              <strong>{summary.sold_tickets}</strong> boletas vendidas ·{" "}
              <strong>{summary.admitted_tickets}</strong> ya ingresaron.
            </li>
            <li>
              Recaudo histórico registrado: <strong>{money(summary.gross_cents)}</strong>.
            </li>
            <li>{summary.note}</li>
          </ul>
        )}
        <p className="admin-note mt-3">
          Antes de cerrar la cuenta, descarga el archivo y avisa a tu equipo.
          Los compradores conservan su comprobante y su QR.
        </p>
      </div>
    </section>
  );
}
