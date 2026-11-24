import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import Icon from "../../components/Icon";
import { PromoterAlert, PromoterDrawer, PromoterEmpty, PromoterSkeleton, PromoterStatus } from "../../components/PromoterUI";
import { useAuth } from "../../lib/auth";
import { useUI } from "../../lib/ui";
import { activeVenueId } from "../../lib/venue";
import {
  createPromoterIssue,
  editTicketContact,
  fetchPromoterEvents,
  fetchPromoterSale,
  fetchPromoterSales,
  reissueTicket,
  resolvePromoterIssue,
} from "../../lib/api";
import { eventDate, money } from "../../lib/format";
import {
  admissionLabel,
  channelLabel,
  eventWhen,
  paymentClass,
  paymentLabel,
  shortTicket,
  ticketMessage,
  ticketShareUrl,
  waDigits,
} from "../../lib/promoter";

const CHANNELS = [
  { id: "", label: "Todos los canales" },
  { id: "link", label: "Link" },
  { id: "direct", label: "Venta directa" },
  { id: "quota", label: "Cupo" },
];

const STATUSES = [
  { id: "", label: "Todas" },
  { id: "issued", label: "Vigentes" },
  { id: "redeemed", label: "Usadas" },
  { id: "voided", label: "Anuladas" },
  { id: "refunded", label: "Reembolsadas" },
];

export default function PromoterSalesView() {
  const { user } = useAuth();
  const venueId = activeVenueId(user);
  const [searchParams, setSearchParams] = useSearchParams();
  const [events, setEvents] = useState([]);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [filters, setFilters] = useState({
    event_id: searchParams.get("event_id") || "",
    channel: "",
    status: "",
    attention: false,
  });
  const [selectedId, setSelectedId] = useState(null);
  const timer = useRef(null);

  async function load() {
    if (!venueId) return;
    setError("");
    try {
      const res = await fetchPromoterSales(venueId, {
        q,
        event_id: filters.event_id || undefined,
        channel: filters.channel || undefined,
        status: filters.status || undefined,
        attention: filters.attention,
        limit: 100,
      });
      setData(res);
    } catch (err) {
      setError(err.message || "No pudimos cargar tus ventas.");
      setData({ total: 0, items: [] });
    }
  }

  useEffect(() => {
    if (!venueId) return;
    fetchPromoterEvents(venueId).then(setEvents).catch(() => setEvents([]));
  }, [venueId]);

  useEffect(() => {
    const next = searchParams.get("event_id") || "";
    setFilters((f) => (f.event_id === next ? f : { ...f, event_id: next }));
  }, [searchParams]);

  useEffect(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(load, q ? 250 : 0);
    return () => clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [venueId, q, filters.event_id, filters.channel, filters.status, filters.attention]);

  function setFilter(key, value) {
    setFilters((f) => ({ ...f, [key]: value }));
    if (key === "event_id") {
      const next = new URLSearchParams(searchParams);
      if (value) next.set("event_id", value);
      else next.delete("event_id");
      setSearchParams(next, { replace: true });
    }
  }

  if (data === null && !error) return <PromoterSkeleton rows={4} />;

  return (
    <div className="promoter-page">
      <div className="promoter-head">
        <div>
          <span className="promoter-toplabel"><Icon name="ticket" className="h-3 w-3" aria-hidden="true" />Historial</span>
          <h1>Mis ventas</h1>
          <p>
            Quién compró, cuánto pagó y si ya entró. El QR no se muestra aquí:
            se genera un enlace nuevo cuando hay que reenviarlo.
          </p>
        </div>
        <button type="button" className="promoter-btn" onClick={load}>
          <Icon name="undo" aria-hidden="true" />
          Actualizar
        </button>
      </div>

      {error && (
        <PromoterAlert tone="danger" action={<button type="button" onClick={load}>Reintentar</button>}>
          {error}
        </PromoterAlert>
      )}

      <div className="promoter-toolbar">
        <label className="promoter-search">
          <Icon name="search" aria-hidden="true" />
          <span className="sr-only">Buscar venta</span>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar por nombre, teléfono, correo o número de boleta"
          />
        </label>
        <div className="promoter-filter-row">
          <button
            type="button"
            className="promoter-chip"
            aria-pressed={filters.attention}
            onClick={() => setFilter("attention", !filters.attention)}
          >
            <Icon name="alert" className="mr-1 inline h-3 w-3" aria-hidden="true" />
            Por atender
          </button>
        </div>
      </div>

      <div className="promoter-filter-row" aria-label="Filtros de ventas">
        <select className="promoter-select" value={filters.event_id} onChange={(e) => setFilter("event_id", e.target.value)} aria-label="Evento">
          <option value="">Todos los eventos</option>
          {events.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
        <select className="promoter-select" value={filters.channel} onChange={(e) => setFilter("channel", e.target.value)} aria-label="Canal">
          {CHANNELS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
        <select className="promoter-select" value={filters.status} onChange={(e) => setFilter("status", e.target.value)} aria-label="Estado">
          {STATUSES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
      </div>

      {data?.total === 0 ? (
        <PromoterEmpty icon="ticket" title="No hay ventas con estos filtros">
          Emite una boleta desde un evento o quita los filtros para ver todo tu historial.
        </PromoterEmpty>
      ) : (
        <>
          <p className="promoter-hint">{data?.total ?? 0} ventas · toca una fila para ver el detalle y actuar.</p>
          <div className="promoter-table-wrap">
            <table className="promoter-sales-table">
              <thead>
                <tr>
                  <th>Comprador</th>
                  <th>Evento</th>
                  <th>Emitida</th>
                  <th>Tipo</th>
                  <th>Canal</th>
                  <th>Pago</th>
                  <th>Ingreso</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data?.items.map((sale) => (
                  <tr key={sale.ticket_id}>
                    <td>
                      <div className="is-strong">{sale.customer_name}</div>
                      <div className="is-sub">{sale.customer_phone || sale.customer_email || "Sin contacto"}</div>
                    </td>
                    <td>
                      <div className="is-strong">{sale.event_name}</div>
                      <div className="is-sub">{eventWhen(sale.event_starts_at)}</div>
                    </td>
                    <td>{eventWhen(sale.issued_at)}</td>
                    <td>{sale.ticket_type}</td>
                    <td>{channelLabel(sale.sale_channel)}</td>
                    <td>
                      <PromoterStatus tone={paymentClass(sale.payment_state)}>{paymentLabel(sale.payment_state)}</PromoterStatus>
                      <div className="is-sub">{admissionLabel(sale.admission_state)}</div>
                    </td>
                    <td className="is-strong">{money(sale.price_cents)}</td>
                    <td>
                      <div className="promoter-sale-actions">
                        <button type="button" className="promoter-btn promoter-btn--sm" onClick={() => setSelectedId(sale.ticket_id)}>
                          Abrir
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="promoter-sales-mobile">
            {data?.items.map((sale) => (
              <article key={sale.ticket_id} className="promoter-sale-card">
                <div className="promoter-sale-card-head">
                  <div>
                    <b>{sale.customer_name}</b>
                    <div className="promoter-sale-card-meta">{sale.event_name} · {sale.ticket_type}</div>
                  </div>
                  <PromoterStatus tone={paymentClass(sale.payment_state)}>{paymentLabel(sale.payment_state)}</PromoterStatus>
                </div>
                <div className="promoter-sale-card-meta">
                  <span>{channelLabel(sale.sale_channel)}</span>
                  <span>{admissionLabel(sale.admission_state)}</span>
                  <span>{money(sale.price_cents)}</span>
                  {sale.attention && <span>Requiere atención</span>}
                </div>
                <div className="promoter-sale-actions">
                  <button type="button" className="promoter-btn promoter-btn--sm" onClick={() => setSelectedId(sale.ticket_id)}>
                    Ver y actuar
                  </button>
                </div>
              </article>
            ))}
          </div>
        </>
      )}

      {selectedId && (
        <SaleDrawer
          venueId={venueId}
          ticketId={selectedId}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}

function SaleDrawer({ venueId, ticketId, onClose }) {
  const ui = useUI();
  const [sale, setSale] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState("");
  const [issueOpen, setIssueOpen] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);
  const [issue, setIssue] = useState({ kind: "delivery", note: "" });
  const [contact, setContact] = useState({ name: "", phone: "", reason: "" });

  async function load() {
    setError("");
    try {
      const data = await fetchPromoterSale(venueId, ticketId);
      setSale(data);
      setContact({ name: data.customer_name || "", phone: data.customer_phone || "", reason: "" });
    } catch (err) {
      setError(err.message || "No pudimos abrir esta venta.");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [venueId, ticketId]);

  async function makeLink() {
    if (!sale || busy) return;
    const ok = await ui.confirm("¿Generar un enlace nuevo?", {
      body: sale.reissue_blocked_reason
        || "El enlace anterior dejará de funcionar. Úsalo solo si el invitado perdió su QR.",
      confirmLabel: "Generar enlace",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await reissueTicket(venueId, sale.event_id, sale.ticket_id, "Reenvío solicitado por el promotor");
      setLink(ticketShareUrl(res.raw_token));
      ui.toast("Enlace nuevo listo.", "success");
    } catch (err) {
      ui.error(err.message || "No pudimos reemitir el enlace.");
    } finally {
      setBusy(false);
    }
  }

  async function saveContact() {
    if (!contact.name.trim()) return;
    setBusy(true);
    try {
      await editTicketContact(venueId, sale.event_id, sale.ticket_id, {
        customer_name: contact.name.trim(),
        customer_phone: contact.phone.trim() || null,
        reason: contact.reason.trim() || null,
      });
      setContactOpen(false);
      await load();
      ui.toast("Contacto corregido.", "success");
    } catch (err) {
      ui.error(err.message || "No pudimos corregir el contacto.");
    } finally {
      setBusy(false);
    }
  }

  async function sendIssue() {
    if (!issue.note.trim()) return;
    setBusy(true);
    try {
      await createPromoterIssue(venueId, sale.ticket_id, {
        kind: issue.kind,
        note: issue.note.trim(),
      });
      setIssueOpen(false);
      setIssue({ kind: "delivery", note: "" });
      await load();
      ui.toast("Solicitud registrada.", "success");
    } catch (err) {
      ui.error(err.message || "No pudimos registrar la solicitud.");
    } finally {
      setBusy(false);
    }
  }

  async function resolveIssue(issueId) {
    setBusy(true);
    try {
      await resolvePromoterIssue(venueId, sale.ticket_id, issueId);
      await load();
    } catch (err) {
      ui.error(err.message || "No pudimos cerrar la incidencia.");
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return (
      <PromoterDrawer title="Venta" onClose={onClose} footer={<button type="button" className="promoter-btn" onClick={onClose}>Cerrar</button>}>
        <PromoterAlert tone="danger" action={<button type="button" onClick={load}>Reintentar</button>}>{error}</PromoterAlert>
      </PromoterDrawer>
    );
  }
  if (!sale) return <PromoterDrawer title="Cargando venta" onClose={onClose}><PromoterSkeleton rows={1} /></PromoterDrawer>;

  const waHref = link && waDigits(sale.customer_phone).length >= 10
    ? `https://wa.me/${waDigits(sale.customer_phone)}?text=${encodeURIComponent(
        ticketMessage({
          customerName: sale.customer_name,
          eventName: sale.event_name,
          ticketId: sale.ticket_id,
          url: link,
        }),
      )}`
    : null;

  return (
    <PromoterDrawer
      title={`Boleta ${shortTicket(sale.ticket_id)}`}
      subtitle={`${sale.event_name} · ${eventDate(sale.event_starts_at)}`}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="promoter-btn" onClick={onClose}>Cerrar</button>
          {sale.can_reissue && (
            <button type="button" className="promoter-btn promoter-btn--primary" onClick={makeLink} disabled={busy}>
              <Icon name="link" aria-hidden="true" />
              {busy ? "Generando…" : "Generar enlace"}
            </button>
          )}
        </>
      )}
    >
      {sale.attention && (
        <PromoterAlert tone="warn">
          Esta venta requiere atención{sale.issue_status ? " · solicitud abierta" : ""}.
        </PromoterAlert>
      )}
      <div className="promoter-summary">
        <div className="promoter-summary-row"><span>Comprador</span><b>{sale.customer_name}</b></div>
        <div className="promoter-summary-row"><span>Teléfono</span><b>{sale.customer_phone || "Sin teléfono"}</b></div>
        <div className="promoter-summary-row"><span>Correo</span><b>{sale.customer_email || "Sin correo"}</b></div>
        <div className="promoter-summary-row"><span>Tipo</span><b>{sale.ticket_type}</b></div>
        <div className="promoter-summary-row"><span>Canal</span><b>{channelLabel(sale.sale_channel)}</b></div>
        <div className="promoter-summary-row"><span>Pago</span><b>{paymentLabel(sale.payment_state)}</b></div>
        <div className="promoter-summary-row"><span>Ingreso</span><b>{admissionLabel(sale.admission_state)}</b></div>
        <div className="promoter-summary-row promoter-summary-total"><span>Valor</span><b>{money(sale.price_cents)}</b></div>
      </div>

      <div className="promoter-actions-row">
        <button type="button" className="promoter-btn promoter-btn--sm" onClick={() => setContactOpen((v) => !v)}>
          <Icon name="edit" aria-hidden="true" />
          Corregir contacto
        </button>
        <button type="button" className="promoter-btn promoter-btn--sm" onClick={() => setIssueOpen((v) => !v)}>
          <Icon name="flag" aria-hidden="true" />
          Reportar problema
        </button>
      </div>

      {sale.reissue_blocked_reason && (
        <PromoterAlert tone="warn">{sale.reissue_blocked_reason}</PromoterAlert>
      )}

      {link && (
        <div className="promoter-success">
          <h3>Enlace nuevo listo</h3>
          <div className="promoter-link-box"><code>{link}</code></div>
          <div className="promoter-actions-row">
            {waHref ? (
              <a className="promoter-btn promoter-btn--ok" href={waHref} target="_blank" rel="noreferrer">
                <Icon name="whatsapp" aria-hidden="true" />
                Abrir WhatsApp
              </a>
            ) : (
              <span className="promoter-hint">Sin teléfono válido: copia el enlace y envíalo por otro canal.</span>
            )}
            <button type="button" className="promoter-btn" onClick={async () => { await navigator.clipboard?.writeText(link); ui.toast("Enlace copiado.", "success"); }}>
              <Icon name="copy" aria-hidden="true" />
              Copiar
            </button>
          </div>
          <p className="promoter-hint">El enlace anterior ya no funciona. El QR nuevo se valida una sola vez.</p>
        </div>
      )}

      {contactOpen && (
        <div className="promoter-summary">
          <label className="promoter-field">
            <span className="promoter-label">Nombre</span>
            <input className="promoter-input" value={contact.name} onChange={(e) => setContact((c) => ({ ...c, name: e.target.value }))} />
          </label>
          <label className="promoter-field">
            <span className="promoter-label">Teléfono con indicativo</span>
            <input className="promoter-input" value={contact.phone} onChange={(e) => setContact((c) => ({ ...c, phone: e.target.value }))} inputMode="tel" />
          </label>
          <label className="promoter-field">
            <span className="promoter-label">Motivo (opcional)</span>
            <input className="promoter-input" value={contact.reason} onChange={(e) => setContact((c) => ({ ...c, reason: e.target.value }))} />
          </label>
          <div className="promoter-actions-row">
            <button type="button" className="promoter-btn promoter-btn--primary" onClick={saveContact} disabled={busy}>Guardar contacto</button>
          </div>
        </div>
      )}

      {issueOpen && (
        <div className="promoter-summary">
          <label className="promoter-field">
            <span className="promoter-label">Tipo de problema</span>
            <select className="promoter-input" value={issue.kind} onChange={(e) => setIssue((i) => ({ ...i, kind: e.target.value }))}>
              <option value="delivery">No recibió la boleta</option>
              <option value="contact">Datos de contacto incorrectos</option>
              <option value="payment">Pago no coincide</option>
              <option value="other">Otro</option>
            </select>
          </label>
          <label className="promoter-field">
            <span className="promoter-label">Qué pasó</span>
            <textarea className="promoter-input" value={issue.note} onChange={(e) => setIssue((i) => ({ ...i, note: e.target.value }))} />
          </label>
          <div className="promoter-actions-row">
            <button type="button" className="promoter-btn promoter-btn--primary" onClick={sendIssue} disabled={busy || !issue.note.trim()}>
              Registrar solicitud
            </button>
          </div>
        </div>
      )}

      {sale.issues?.length > 0 && (
        <div className="promoter-summary">
          <span className="promoter-label">Solicitudes</span>
          {sale.issues.map((i) => (
            <div key={i.id} className="promoter-payout-item">
              <div>
                <b>{i.kind}</b>
                <p className="promoter-hint">{i.note}</p>
              </div>
              <div>
                <PromoterStatus tone={i.status === "open" ? "warn" : "ok"}>{i.status === "open" ? "Abierta" : "Resuelta"}</PromoterStatus>
                {i.status === "open" && (
                  <button type="button" className="promoter-btn promoter-btn--sm" onClick={() => resolveIssue(i.id)} disabled={busy}>
                    Resolver
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </PromoterDrawer>
  );
}
