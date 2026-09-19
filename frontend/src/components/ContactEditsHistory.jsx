import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api";

/**
 * Historial de correcciones de contacto de una boleta (mig 015).
 *
 * Responde "quién cambió qué y cuándo" sin abrir la DB. Se monta colapsado:
 * el fetch solo ocurre al expandir (el listado puede tener cientos de
 * boletas y la auditoría es la excepción, no la regla).
 *
 * El caché se invalida solo: cuando el contacto de la fila cambia (nombre o
 * teléfono nuevos tras guardar), la próxima apertura vuelve a consultar.
 *
 * `ticketIdField` es "id" (admin) o "ticket_id" (promotor): cada listado
 * nombra la PK distinto y el componente se usa en ambos.
 */
export default function ContactEditsHistory({ venueId, eventId, ticket, ticketIdField }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState(null); // null = sin cargar todavía
  const [error, setError] = useState("");

  const ticketId = ticket[ticketIdField];

  // El fetch dispara al primer expandir; después se cachea en el componente.
  useEffect(() => {
    if (!open || rows) return;
    let alive = true;
    apiFetch(`/venues/${venueId}/events/${eventId}/tickets/${ticketId}/contact-edits`)
      .then((data) => alive && setRows(data))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [open, rows, venueId, eventId, ticketId]);

  // Tras guardar una corrección el contacto de la fila cambia: el caché
  // quedaria viejo. Observar los valores (no una función del padre) evita
  // reseteos en cada render.
  useEffect(() => {
    setRows(null);
  }, [ticket.customer_name, ticket.customer_phone]);

  const hasEdits = rows !== null && rows.length > 0;

  return (
    <div className="mt-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-xs font-semibold text-zinc-400 transition hover:text-zinc-200"
      >
        {open
          ? "Ocultar correcciones ▲"
          : `Correcciones de contacto${hasEdits ? ` (${rows.length})` : ""} ▼`}
      </button>
      {open && (
        <div className="mt-2 rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
          {error && <p className="text-xs text-red-400">{error}</p>}
          {rows === null && !error && <p className="text-xs text-zinc-500">Cargando…</p>}
          {rows !== null && rows.length === 0 && (
            <p className="text-xs text-zinc-500">Sin correcciones registradas.</p>
          )}
          {hasEdits && (
            <ul className="space-y-2">
              {rows.map((r) => {
                const nameChanged = r.new_name !== r.old_name;
                const phoneChanged = r.new_phone !== r.old_phone;
                return (
                  <li key={r.id} className="text-xs">
                    <p className="font-semibold text-zinc-200">
                      {r.edited_by_name ?? "Usuario eliminado"}
                      <span className="ml-1.5 font-normal text-zinc-500">
                        {new Date(r.created_at).toLocaleString("es-CO", {
                          day: "numeric",
                          month: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    </p>
                    {nameChanged && (
                      <p className="text-zinc-400">
                        Nombre: <span className="text-zinc-500 line-through">{r.old_name ?? "—"}</span>{" "}
                        → <span className="text-zinc-200">{r.new_name}</span>
                      </p>
                    )}
                    {phoneChanged && (
                      <p className="text-zinc-400">
                        Teléfono: <span className="text-zinc-500 line-through">{r.old_phone ?? "—"}</span>{" "}
                        → <span className="text-zinc-200">{r.new_phone}</span>
                      </p>
                    )}
                    {r.reason && <p className="italic text-zinc-500">“{r.reason}”</p>}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
