import { useState } from "react";
import { apiFetch, publicTicketPageUrl } from "../lib/api";
import { useUI } from "../lib/ui";
import ContactEditsHistory from "./ContactEditsHistory";
import EmptyState from "./EmptyState";

const TICKET_STATUS = {
  issued: {
    label: "Activa",
    cls: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/40",
  },
  redeemed: {
    label: "Redimida",
    cls: "bg-sky-500/15 text-sky-300 ring-sky-500/40",
  },
  voided: {
    label: "Anulada",
    cls: "bg-red-500/15 text-red-300 ring-red-500/40",
  },
  refunded: {
    label: "Reembolsada",
    cls: "bg-amber-500/15 text-amber-300 ring-amber-500/40",
  },
};

export default function TicketList({
  venueId,
  eventId,
  tickets,
  onChanged,
  onError,
}) {
  const ui = useUI();
  const [voidingId, setVoidingId] = useState(null);
  const [reason, setReason] = useState("Error de digitación");
  const [busy, setBusy] = useState(false);
  // Mig 015: corrección de contacto (nombre/teléfono) con auditoría.
  const [editingId, setEditingId] = useState(null);
  const [edit, setEdit] = useState({ name: "", phone: "", reason: "" });

  async function voidTicket(t) {
    const ok = await ui.confirm(`¿Anular la boleta #${t.id}?`, {
      message: `Se anula la boleta de ${t.customer_name}. El cupo quedará liberado.`,
      danger: true,
      confirmLabel: "Anular boleta",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await apiFetch(
        `/venues/${venueId}/events/${eventId}/tickets/${t.id}/void`,
        {
          method: "POST",
          body: JSON.stringify({ reason }),
        },
      );
      setVoidingId(null);
      await onChanged();
      ui.success(`Boleta #${t.id} anulada`);
    } catch (e) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  }

  /** Reemite una boleta vigente (mig 004): rota el token y entrega el enlace
      nuevo. En el admin la entrega práctica es el portapapeles: el enlace
      copiado se pega en el chat del invitado. Si el portapapeles falla (http,
      permisos), el enlace queda visible en un diálogo para copiarlo a mano. */
  async function reissueTicket(t) {
    const ok = await ui.confirm(`¿Reemitir la boleta #${t.id}?`, {
      message: `Se genera un enlace NUEVO para ${t.customer_name}. El enlace anterior deja de funcionar de inmediato.`,
      confirmLabel: "Reemitir boleta",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await apiFetch(
        `/venues/${venueId}/events/${eventId}/tickets/${t.id}/reissue`,
        {
          method: "POST",
          body: JSON.stringify({
            reason: "Recuperación de enlace (WhatsApp perdido o borrado)",
          }),
        },
      );
      await onChanged();
      const url = publicTicketPageUrl(res.raw_token);
      try {
        await navigator.clipboard.writeText(url);
        ui.success(
          `Boleta #${t.id} reemitida: enlace copiado, pégalo en el chat del invitado`,
        );
      } catch {
        ui.alert("Enlace nuevo de la boleta (cópialo manualmente):", {
          message: url,
        });
      }
    } catch (e) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  }

  /** Corrección de contacto (mig 015): PATCH con auditoría en la DB. Al menos
      un campo debe venir; el backend valida el teléfono y los permisos. */
  async function saveContact(t) {
    const name = edit.name.trim();
    const phone = edit.phone.trim();
    if (!name && !phone) {
      onError("Escribe nombre o teléfono: al menos uno.");
      return;
    }
    setBusy(true);
    try {
      await apiFetch(
        `/venues/${venueId}/events/${eventId}/tickets/${t.id}/contact`,
        {
          method: "PATCH",
          body: JSON.stringify({
            ...(name ? { customer_name: name } : {}),
            ...(phone ? { customer_phone: phone } : {}),
            ...(edit.reason.trim() ? { reason: edit.reason.trim() } : {}),
          }),
        },
      );
      setEditingId(null);
      await onChanged();
      ui.success(`Contacto de la boleta #${t.id} actualizado`);
    } catch (e) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const [query, setQuery] = useState("");
  const filtered = (tickets || []).filter((t) => {
    if (!query.trim()) return true;
    const q = query.trim().toLowerCase();
    return (
      String(t.id) === q.replace("#", "") ||
      t.customer_name?.toLowerCase().includes(q) ||
      t.customer_phone?.includes(q) ||
      t.type_name?.toLowerCase().includes(q) ||
      t.sold_by_name?.toLowerCase().includes(q)
    );
  });

  async function downloadCsv(kind) {
    try {
      const res = await fetch(
        `/api/venues/${venueId}/events/${eventId}/${kind}`,
        {
          headers: {
            Authorization: `Bearer ${localStorage.getItem("tf_token")}`,
          },
        },
      );
      if (!res.ok) throw new Error("No se pudo generar el archivo");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${kind.replace(".csv", "")}-evento-${eventId}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      onError(e.message);
    }
  }

  return (
    <div className="card p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="display text-base">Boletas emitidas</h3>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => downloadCsv("guests.csv")}
            className="btn-ghost text-xs font-bold"
          >
            Exportar invitados
          </button>
          <button
            onClick={() => downloadCsv("revenue.csv")}
            className="btn-ghost text-xs font-bold"
          >
            Exportar recaudo
          </button>
          <button
            onClick={() => downloadCsv("noshow.csv")}
            className="btn-ghost text-xs font-bold"
          >
            No-shows
          </button>
          <span className="tnum text-xs text-zinc-500">
            {(tickets || []).length} recientes
          </span>
        </div>
      </div>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="field mb-3"
        placeholder="Buscar por nombre, teléfono, #boleta, tipo o promotor…"
      />
      <ul className="space-y-2">
        {filtered.map((t) => {
          const st = TICKET_STATUS[t.status] ?? TICKET_STATUS.issued;
          const canVoid = t.status === "issued";
          return (
            <li
              key={t.id}
              className="rounded-lg border border-zinc-800/60 bg-zinc-900/40 px-3 py-2.5 text-sm"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-semibold text-zinc-200">
                    <span className="tnum text-zinc-500">#{t.id}</span> ·{" "}
                    {t.customer_name}
                  </p>
                  <p className="mt-0.5 text-xs text-zinc-500">
                    {t.type_name ?? "—"}
                    {t.customer_phone ? ` · ${t.customer_phone}` : ""}
                    {t.from_allocation
                      ? " · cupo promotor"
                      : " · venta directa"}
                    {t.sold_by_name ? ` · por ${t.sold_by_name}` : ""}
                    {t.price_cents_snapshot > 0
                      ? ` · $${(t.price_cents_snapshot / 100).toLocaleString("es-CO")}`
                      : " · cortesía"}
                  </p>
                </div>
                <div className="flex items-center gap-1.5">
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ring-1 ${st.cls}`}
                  >
                    {st.label}
                  </span>
                  {canVoid && voidingId !== t.id && editingId !== t.id && (
                    <>
                      <button
                        onClick={() => reissueTicket(t)}
                        disabled={busy}
                        className="rounded-lg px-2 py-1 text-xs font-semibold text-brand-300 transition hover:bg-brand-500/10 disabled:opacity-50"
                      >
                        Reemitir
                      </button>
                      <button
                        onClick={() => {
                          setEditingId(t.id);
                          setEdit({
                            name: t.customer_name ?? "",
                            phone: t.customer_phone ?? "",
                            reason: "",
                          });
                        }}
                        className="rounded-lg px-2 py-1 text-xs font-semibold text-zinc-300 transition hover:bg-zinc-800"
                      >
                        Corregir
                      </button>
                      <button
                        onClick={() => {
                          setVoidingId(t.id);
                          setReason("Error de digitación");
                        }}
                        className="rounded-lg px-2 py-1 text-xs font-semibold text-red-400 transition hover:bg-red-500/10"
                      >
                        Anular
                      </button>
                    </>
                  )}
                </div>
              </div>
              {voidingId === t.id && (
                <div className="mt-2 flex gap-2">
                  <input
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    className="field !py-1.5 text-xs"
                    placeholder="Motivo de anulación"
                    minLength={3}
                    required
                  />
                  <button
                    onClick={() => voidTicket(t)}
                    disabled={busy || reason.trim().length < 3}
                    className="rounded-lg bg-red-500/90 px-3 py-1.5 text-xs font-bold text-white transition hover:bg-red-500 disabled:opacity-50"
                  >
                    {busy ? "Anulando…" : "Confirmar"}
                  </button>
                  <button
                    onClick={() => setVoidingId(null)}
                    className="rounded-lg px-2 py-1.5 text-xs font-semibold text-zinc-400 hover:text-zinc-200"
                  >
                    Cancelar
                  </button>
                </div>
              )}
              {editingId === t.id && (
                <div className="mt-2 space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
                  <p className="text-xs font-semibold text-zinc-400">
                    Corregir contacto · queda en auditoría (mig 015)
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <input
                      value={edit.name}
                      onChange={(e) =>
                        setEdit({ ...edit, name: e.target.value })
                      }
                      className="field !py-1.5 text-xs sm:flex-1"
                      placeholder="Nombre del asistente"
                    />
                    <input
                      value={edit.phone}
                      onChange={(e) =>
                        setEdit({ ...edit, phone: e.target.value })
                      }
                      className="field !py-1.5 text-xs sm:flex-1"
                      placeholder="Teléfono (WhatsApp)"
                      inputMode="tel"
                    />
                  </div>
                  <div className="flex gap-2">
                    <input
                      value={edit.reason}
                      onChange={(e) =>
                        setEdit({ ...edit, reason: e.target.value })
                      }
                      className="field !py-1.5 flex-1 text-xs"
                      placeholder="Motivo (opcional): quedó mal escrito, cambió de número…"
                    />
                    <button
                      onClick={() => saveContact(t)}
                      disabled={
                        busy || (!edit.name.trim() && !edit.phone.trim())
                      }
                      className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-bold text-white transition hover:bg-brand-500 disabled:opacity-50"
                    >
                      {busy ? "Guardando…" : "Guardar"}
                    </button>
                    <button
                      onClick={() => setEditingId(null)}
                      className="rounded-lg px-2 py-1.5 text-xs font-semibold text-zinc-400 hover:text-zinc-200"
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
              )}
              {/* Auditoría de la mig 015: quién corrigió el contacto y cuándo.
                  Cargada perezosa al expandir: con cientos de boletas no se
                  pueden N fetches por listado. */}
              <ContactEditsHistory
                venueId={venueId}
                eventId={eventId}
                ticket={t}
                ticketIdField="id"
              />
            </li>
          );
        })}
        {filtered.length === 0 && (tickets || []).length > 0 && (
          <li className="rounded-lg border border-zinc-800/60 bg-zinc-900/40 px-3 py-3 text-sm text-zinc-500">
            Ninguna boleta coincide con la búsqueda.
          </li>
        )}
        {(tickets || []).length === 0 && (
          <li className="list-none">
            <EmptyState
              icon="ticket"
              title="Aún no hay boletas para este evento"
            >
              Cuando un promotor emita la primera, aparecerá aquí con su estado
              en vivo.
            </EmptyState>
          </li>
        )}
      </ul>
    </div>
  );
}
