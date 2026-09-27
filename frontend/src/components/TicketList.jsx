import { useCallback, useEffect, useState } from "react";
import {
  apiFetch,
  downloadTicketsCsv,
  listTicketsPaged,
  publicTicketPageUrl,
} from "../lib/api";
import { useUI } from "../lib/ui";
import ContactEditsHistory from "./ContactEditsHistory";
import EmptyState from "./EmptyState";
import TicketQrModal from "./TicketQrModal";

const PAGE_SIZE = 50;

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

export default function TicketList({ venueId, eventId, onChanged, onError }) {
  const ui = useUI();
  const [voidingId, setVoidingId] = useState(null);
  const [reason, setReason] = useState("Error de digitación");
  const [busy, setBusy] = useState(false);
  // Mig 015: corrección de contacto (nombre/teléfono) con auditoría.
  const [editingId, setEditingId] = useState(null);
  const [edit, setEdit] = useState({ name: "", phone: "", reason: "" });
  // Boleta cuyo QR se está mostrando (token ya rotado por reissue).
  const [qrTicket, setQrTicket] = useState(null);

  // ===== Listado server-driven: filtros + paginación viven en el API =====
  // (antes: 200 boletas en el DOM y Ctrl+F; ahora el server filtra y pagina,
  //  y el total permite pintar "página 2 de 3").
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [qInput, setQInput] = useState("");
  const [page, setPage] = useState(0); // 0-indexed
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!eventId) return;
    setLoading(true);
    try {
      const data = await listTicketsPaged(venueId, eventId, {
        status: status || undefined,
        q: q || undefined,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      });
      setItems(data.items);
      setTotal(data.total);
    } catch (e) {
      onError(e.message);
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [venueId, eventId, status, q, page]);

  useEffect(() => {
    load();
  }, [load]);

  // Cambiar filtro/reset de evento vuelve a la página 1.
  useEffect(() => {
    setPage(0);
  }, [eventId, status]);

  // El buscador busca al enviar (Enter), no en cada tecla: menos queries.
  function submitSearch(e) {
    e.preventDefault();
    setQ(qInput.trim());
    setPage(0);
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

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
      await refreshList();
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
      await refreshList();
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
      await refreshList();
      ui.success(`Contacto de la boleta #${t.id} actualizado`);
    } catch (e) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  }

  // El listado ya llega filtrado del server; el refresh post-acción
  // re-consulta con los filtros vigentes.
  const refreshList = onChanged;

  /** Ver el QR de una boleta: como la DB solo guarda el hash del token
      (el crudo se entrega una vez), verlo exige ROTARLO. El enlace anterior
      muere: lo confirmamos antes. El QR nuevo es único y queda asociado al
      asistente mientras el evento siga abierto. */
  async function showQr(t) {
    const ok = await ui.confirm(`¿Mostrar el QR de la boleta #${t.id}?`, {
      message: `Se genera un QR NUEVO para ${t.customer_name} y el enlace anterior deja de funcionar. Úsalo si perdió el mensaje de WhatsApp.`,
      confirmLabel: "Generar QR nuevo",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await apiFetch(
        `/venues/${venueId}/events/${eventId}/tickets/${t.id}/reissue`,
        {
          method: "POST",
          body: JSON.stringify({
            reason: "Consulta de QR desde el dashboard",
          }),
        },
      );
      await onChanged();
      await refreshList();
      setQrTicket({ ...t, raw_token: res.raw_token });
    } catch (e) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  }

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
        <div>
          <p className="eyebrow">Auditorio</p>
          <h3 className="display mt-0.5 text-base">Boletas emitidas</h3>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => downloadCsv("guests.csv")}
            className="btn-ghost text-xs font-bold"
            data-tip="Descarga la lista de asistentes"
          >
            Invitados
          </button>
          <button
            onClick={() => downloadCsv("revenue.csv")}
            className="btn-ghost text-xs font-bold"
            data-tip="Descarga el detalle de recaudo"
          >
            Recaudo
          </button>
          <button
            onClick={() => downloadTicketsCsv(venueId, eventId, { status, q })}
            disabled={loading}
            className="btn-ghost text-xs font-bold"
            data-tip="Exporta el listado filtrado completo"
          >
            Boletas (CSV)
          </button>
        </div>
      </div>

      {/* Filtros server-side: estado + búsqueda. Cambian de página y de
          consulta: el server hace el trabajo, el DOM no carga 200 filas. */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div
          className="tabbar no-scrollbar"
          role="tablist"
          aria-label="Filtrar por estado"
        >
          {[
            ["", "Todas"],
            ["issued", "Activas"],
            ["redeemed", "Redimidas"],
            ["voided", "Anuladas"],
            ["refunded", "Reembolsadas"],
          ].map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={status === id}
              onClick={() => setStatus(id)}
              className="tabbar-item !text-xs"
            >
              {label}
            </button>
          ))}
        </div>
        <form
          onSubmit={submitSearch}
          className="flex min-w-52 flex-1 items-center gap-1.5"
        >
          <input
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            className="field !py-1.5 text-xs"
            placeholder="Buscar por nombre del asistente… (Enter)"
          />
          {q && (
            <button
              type="button"
              onClick={() => {
                setQInput("");
                setQ("");
              }}
              className="btn-mini shrink-0"
            >
              Limpiar
            </button>
          )}
        </form>
      </div>

      <p className="tnum mb-2 text-xs text-zinc-500">
        {loading ? "Cargando…" : `${total} boletas`}
        {!loading && total > 0 && ` · página ${page + 1} de ${totalPages}`}
      </p>
      <ul className="space-y-2">
        {loading &&
          [1, 2, 3].map((i) => <li key={i} className="skeleton h-16" />)}
        {!loading &&
          items.map((t) => {
            const st = TICKET_STATUS[t.status] ?? TICKET_STATUS.issued;
            const canVoid = t.status === "issued";
            return (
              <li
                key={t.id}
                className="list-row px-3 py-2.5 text-sm"
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
                          onClick={() => showQr(t)}
                          disabled={busy}
                          className="btn-mini"
                          data-variant="brand"
                        >
                          Ver QR
                        </button>
                        <button
                          onClick={() => reissueTicket(t)}
                          disabled={busy}
                          className="btn-mini"
                          data-variant="brand"
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
                          className="btn-mini"
                        >
                          Corregir
                        </button>
                        <button
                          onClick={() => {
                            setVoidingId(t.id);
                            setReason("Error de digitación");
                          }}
                          className="btn-mini"
                          data-variant="danger"
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
                      className={`btn-danger !py-1.5 text-xs ${busy ? "is-busy" : ""}`}
                    >
                      {busy && (
                        <svg
                          className="btn-spinner"
                          viewBox="0 0 24 24"
                          aria-hidden="true"
                        >
                          <circle cx="12" cy="12" r="9" />
                        </svg>
                      )}
                      {busy ? "Anulando…" : "Confirmar"}
                    </button>
                    <button
                      onClick={() => setVoidingId(null)}
                      className="btn-mini"
                    >
                      Cancelar
                    </button>
                  </div>
                )}
                {editingId === t.id && (
                  <div className="mt-2 list-row space-y-2 p-3">
                    <p className="text-xs font-semibold text-zinc-400">
                      Corregir contacto · queda en auditoría
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
                        className={`btn-primary !px-3 !py-1.5 text-xs ${busy ? "is-busy" : ""}`}
                      >
                        {busy && (
                          <svg
                            className="btn-spinner"
                            viewBox="0 0 24 24"
                            aria-hidden="true"
                          >
                            <circle cx="12" cy="12" r="9" />
                          </svg>
                        )}
                        {busy ? "Guardando…" : "Guardar"}
                      </button>
                      <button
                        onClick={() => setEditingId(null)}
                        className="btn-mini"
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
        {!loading && items.length === 0 && total === 0 && (
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
        {!loading && items.length === 0 && total > 0 && (
          <li className="list-row px-3 py-3 text-sm text-zinc-500">
            Ninguna boleta coincide con el filtro.
          </li>
        )}
      </ul>

      {/* QR de la boleta: único por token, visible mientras el evento viva. */}
      {qrTicket && (
        <TicketQrModal ticket={qrTicket} onClose={() => setQrTicket(null)} />
      )}

      {/* Paginador: solo si hay más de una página */}
      {!loading && totalPages > 1 && (
        <div className="mt-3 flex items-center justify-between">
          <button
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
            className="btn-ghost !py-1.5 text-xs disabled:opacity-30"
          >
            ← Anterior
          </button>
          <span className="tnum text-xs text-zinc-500">
            {page + 1} / {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
            className="btn-ghost !py-1.5 text-xs disabled:opacity-30"
          >
            Siguiente →
          </button>
        </div>
      )}
    </div>
  );
}
