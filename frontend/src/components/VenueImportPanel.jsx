import { useEffect, useMemo, useRef, useState } from "react";
import { apiFetch, applyImport, previewImport } from "../lib/api";
import { useUI } from "../lib/ui";

const KINDS = [
  { id: "events", label: "Eventos" },
  { id: "guests", label: "Invitados" },
];

const TEMPLATE = {
  events:
    "nombre,fecha,hora,aforo,lugar,categoria,descripcion\n" +
    "Noche de salsa,2026-12-05,21:00,180,Bar La Clave,Fiesta,Clásicos y salsa en vivo\n",
  guests:
    "nombre,correo,telefono\n" +
    "Ana Gómez,ana@ejemplo.com,3001234567\n",
};

function downloadText(name, text) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}

function readBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(new Error("No pudimos leer el archivo"));
    reader.readAsDataURL(file);
  });
}

const STATUS_LABEL = {
  valid: "Lista",
  duplicate: "Ya cargada",
  error: "Corregir",
};

export default function VenueImportPanel({ venueId }) {
  const ui = useUI();
  const inputRef = useRef(null);
  const [kind, setKind] = useState("events");
  const [eventId, setEventId] = useState("");
  const [events, setEvents] = useState([]);
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (!venueId) return;
    apiFetch(`/venues/${venueId}/events`)
      .then((rows) => setEvents(rows || []))
      .catch(() => setEvents([]));
  }, [venueId]);

  const selectedEvent = useMemo(
    () => events.find((ev) => String(ev.id) === String(eventId)),
    [events, eventId],
  );

  async function analyze(nextFile) {
    if (!nextFile) return;
    if (kind === "guests" && !eventId) {
      setError("Elige el evento para cargar invitados.");
      return;
    }
    setFile(nextFile);
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const content_base64 = await readBase64(nextFile);
      const data = await previewImport(venueId, {
        kind,
        event_id: kind === "guests" ? Number(eventId) : null,
        filename: nextFile.name,
        content_base64,
      });
      setPreview(data);
    } catch (err) {
      setPreview(null);
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function rowProblem(data) {
    if (!String(data.name || "").trim()) return "Falta el nombre";
    if (kind === "events") {
      if (!String(data.starts_at || "").trim()) return "Falta la fecha";
      if (Number(data.capacity) < 1) return "El aforo debe ser mayor que cero";
      return "";
    }
    if (!String(data.email || "").includes("@")) return "Falta un correo válido";
    return "";
  }

  function patchRow(rowNumber, field, value) {
    setPreview((prev) => ({
      ...prev,
      rows: prev.rows.map((row) => {
        if (row.row_number !== rowNumber) return row;
        const data = { ...row.data, [field]: value };
        const error = rowProblem(data);
        return {
          ...row,
          data,
          status: row.status === "duplicate" ? row.status : error ? "error" : "valid",
          error,
        };
      }),
    }));
  }

  async function confirmImport() {
    const rows = (preview?.rows || [])
      .filter((row) => row.status !== "duplicate")
      .map((row) => ({ row_number: row.row_number, data: row.data }));
    if (!rows.length) {
      setError("No hay filas nuevas para importar.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await applyImport(venueId, {
        kind,
        event_id: kind === "guests" ? Number(eventId) : null,
        filename: file?.name || "importacion",
        rows,
      });
      setResult(res);
      setPreview(null);
      setFile(null);
      if (inputRef.current) inputRef.current.value = "";
      ui.success(
        `${res.imported} filas importadas${
          res.duplicates ? ` · ${res.duplicates} ya existían` : ""
        }`,
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const counts = preview
    ? {
        valid: preview.rows.filter((r) => r.status === "valid").length,
        duplicate: preview.rows.filter((r) => r.status === "duplicate").length,
        error: preview.rows.filter((r) => r.status === "error").length,
      }
    : null;

  return (
    <section className="admin-org-grid" aria-label="Importar desde Excel o CSV">
      <div className="admin-settings-card">
        <h2>Importación guiada</h2>
        <p>
          Trae eventos o invitados desde una hoja de cálculo. Primero revisas
          cada fila; nada se guarda hasta que confirmes. Si vuelves a subir el
          mismo archivo, Enty marca lo que ya estaba cargado.
        </p>

        <div className="admin-tabbar" role="tablist" aria-label="Qué vas a importar">
          {KINDS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={kind === item.id}
              className={`admin-tab${kind === item.id ? " is-active" : ""}`}
              onClick={() => {
                setKind(item.id);
                setPreview(null);
                setResult(null);
                setError("");
              }}
            >
              {item.label}
            </button>
          ))}
        </div>

        {kind === "guests" && (
          <label className="mt-4 block text-xs text-zinc-400">
            Evento que recibe la lista
            <select
              className="field mt-1"
              value={eventId}
              onChange={(e) => {
                setEventId(e.target.value);
                setPreview(null);
              }}
            >
              <option value="">Elige un evento…</option>
              {events.map((ev) => (
                <option key={ev.id} value={ev.id}>
                  {ev.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <div className="mt-4 rounded-xl border border-dashed border-zinc-700 p-4">
          <input
            ref={inputRef}
            type="file"
            accept=".csv,.xlsx,.xlsm"
            className="sr-only"
            id="venue-import-file"
            onChange={(e) => analyze(e.target.files?.[0])}
          />
          <label htmlFor="venue-import-file" className="btn-primary inline-flex cursor-pointer">
            {busy ? "Leyendo…" : "Elegir archivo CSV o Excel"}
          </label>
          <p className="admin-note mt-2">
            {file ? file.name : "También puedes descargar la plantilla y llenarla."}
          </p>
          <button
            type="button"
            className="admin-inline-link mt-2"
            onClick={() =>
              downloadText(
                kind === "events" ? "plantilla-eventos.csv" : "plantilla-invitados.csv",
                TEMPLATE[kind],
              )
            }
          >
            Descargar plantilla
          </button>
        </div>

        {error && (
          <p className="mt-3 text-xs text-red-400" role="alert">
            {error}
          </p>
        )}
        {result && (
          <p className="mt-3 text-xs text-emerald-400" role="status">
            Lote #{result.batch_id}: {result.imported} importadas,{" "}
            {result.duplicates} duplicadas, {result.errors} con error.
          </p>
        )}
      </div>

      <div className="admin-legal-card">
        <h2>Revisión antes de importar</h2>
        {!preview ? (
          <p>
            Sube un archivo para ver la vista previa. Las filas con error se
            pueden corregir aquí mismo; las duplicadas no se vuelven a cargar.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap gap-2 text-xs">
              <span className="admin-chip">{counts.valid} listas</span>
              <span className="admin-chip">{counts.duplicate} ya cargadas</span>
              <span className="admin-chip">{counts.error} por corregir</span>
              {selectedEvent && kind === "guests" && (
                <span className="admin-chip">Para: {selectedEvent.name}</span>
              )}
            </div>
            <div className="mt-3 max-h-[420px] overflow-auto">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-zinc-950/90">
                  <tr>
                    <th className="p-2">#</th>
                    <th className="p-2">Estado</th>
                    {kind === "events" ? (
                      <>
                        <th className="p-2">Nombre</th>
                        <th className="p-2">Fecha</th>
                        <th className="p-2">Aforo</th>
                        <th className="p-2">Lugar</th>
                      </>
                    ) : (
                      <>
                        <th className="p-2">Nombre</th>
                        <th className="p-2">Correo</th>
                        <th className="p-2">Teléfono</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row) => (
                    <tr key={row.row_number} className="border-t border-zinc-800">
                      <td className="p-2 text-zinc-500">{row.row_number}</td>
                      <td className="p-2">
                        <span
                          className={`admin-chip ${
                            row.status === "error" ? "is-warn" : ""
                          }`}
                          title={row.error || ""}
                        >
                          {STATUS_LABEL[row.status]}
                        </span>
                      </td>
                      <td className="p-2">
                        <input
                          className="field field-sm"
                          value={row.data.name || ""}
                          disabled={row.status === "duplicate"}
                          onChange={(e) =>
                            patchRow(row.row_number, "name", e.target.value)
                          }
                        />
                      </td>
                      {kind === "events" ? (
                        <>
                          <td className="p-2">
                            <input
                              className="field field-sm"
                              value={(row.data.starts_at || "").slice(0, 16)}
                              disabled={row.status === "duplicate"}
                              onChange={(e) =>
                                patchRow(row.row_number, "starts_at", e.target.value)
                              }
                            />
                          </td>
                          <td className="p-2">
                            <input
                              className="field field-sm"
                              value={row.data.capacity || ""}
                              disabled={row.status === "duplicate"}
                              onChange={(e) =>
                                patchRow(row.row_number, "capacity", e.target.value)
                              }
                            />
                          </td>
                          <td className="p-2">
                            <input
                              className="field field-sm"
                              value={row.data.location || ""}
                              disabled={row.status === "duplicate"}
                              onChange={(e) =>
                                patchRow(row.row_number, "location", e.target.value)
                              }
                            />
                          </td>
                        </>
                      ) : (
                        <>
                          <td className="p-2">
                            <input
                              className="field field-sm"
                              value={row.data.email || ""}
                              disabled={row.status === "duplicate"}
                              onChange={(e) =>
                                patchRow(row.row_number, "email", e.target.value)
                              }
                            />
                          </td>
                          <td className="p-2">
                            <input
                              className="field field-sm"
                              value={row.data.phone || ""}
                              disabled={row.status === "duplicate"}
                              onChange={(e) =>
                                patchRow(row.row_number, "phone", e.target.value)
                              }
                            />
                          </td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button
              type="button"
              className="btn-primary mt-4"
              onClick={confirmImport}
              disabled={busy || counts.valid === 0}
            >
              {busy ? "Importando…" : `Importar ${counts.valid} filas`}
            </button>
          </>
        )}
      </div>
    </section>
  );
}
