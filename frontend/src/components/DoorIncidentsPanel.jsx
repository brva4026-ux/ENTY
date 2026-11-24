import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { apiFetch } from "../lib/api";
import { useUI } from "../lib/ui";
import Icon from "./Icon";

const STATUS = {
  open: { label: "Abierta", tone: "warn" },
  reviewing: { label: "En revisión", tone: "info" },
  resolved: { label: "Resuelta", tone: "ok" },
};

function when(value) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString("es-CO", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
}

function phoneHref(phone) {
  return `tel:${String(phone || "").replace(/\s/g, "")}`;
}

function waHref(phone, text) {
  const digits = String(phone || "").replace(/[^\d]/g, "");
  return digits ? `https://wa.me/${digits}?text=${encodeURIComponent(text)}` : null;
}

/**
 * El mismo expediente para Administración y Promotor.
 *
 * Puerta abre el caso; Administración lo asume, pide contexto o resuelve; el
 * promotor consulta y aporta contexto solo si el caso es de una boleta suya o
 * si Administración le dio acceso. El backend decide; esta UI solo muestra lo
 * que la respuesta autoriza (`can_comment`, `can_manage`).
 */
export default function DoorIncidentsPanel({ venueId, eventId, role = "admin", focusId = null }) {
  const ui = useUI();
  const [params] = useSearchParams();
  const deepFocus = Number(params.get("incidencia")) || null;
  const focus = focusId || deepFocus;
  const isAdmin = role === "admin";
  const [incidents, setIncidents] = useState([]);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("all");
  const [comment, setComment] = useState("");
  const [channel, setChannel] = useState("note");
  const [guidance, setGuidance] = useState("");
  const [contact, setContact] = useState("");
  const [contactChannel, setContactChannel] = useState("call");
  const [opsContact, setOpsContact] = useState(null);
  const [staff, setStaff] = useState([]);
  const [promoterId, setPromoterId] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch(
        `/venues/${venueId}/events/${eventId}/door-incidents`,
        { fresh: true },
      );
      setIncidents(data);
    } catch (e) {
      ui.error(e.message);
    } finally {
      setLoading(false);
    }
  }, [venueId, eventId, ui]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    let alive = true;
    apiFetch(`/venues/${venueId}/events/${eventId}/door-context`, { fresh: true })
      .then((ctx) => {
        if (alive) {
          setOpsContact(
            ctx.ops_contact_phone
              ? { name: ctx.ops_contact_name, phone: ctx.ops_contact_phone }
              : null,
          );
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [venueId, eventId]);

  useEffect(() => {
    if (!isAdmin) return;
    apiFetch(`/venues/${venueId}/events/${eventId}/staff`)
      .then((rows) => setStaff((rows || []).filter((r) => r.role === "promotor")))
      .catch(() => {});
  }, [isAdmin, venueId, eventId]);

  const open = useCallback(
    async (id) => {
      try {
        const data = await apiFetch(
          `/venues/${venueId}/events/${eventId}/door-incidents/${id}`,
          { fresh: true },
        );
        setDetail(data);
        setGuidance(data.resolution_guidance || "");
        setPromoterId(data.promoter_id ? String(data.promoter_id) : "");
        setComment("");
      } catch (e) {
        ui.error(e.message);
      }
    },
    [venueId, eventId, ui],
  );

  useEffect(() => {
    if (focus) open(focus);
  }, [focus, open]);

  async function refreshDetail() {
    if (!detail) return;
    await open(detail.id);
    load();
  }

  async function sendComment(e) {
    e.preventDefault();
    if (!detail || !comment.trim()) return;
    setBusy(true);
    try {
      const data = await apiFetch(
        `/venues/${venueId}/events/${eventId}/door-incidents/${detail.id}/comments`,
        { method: "POST", body: JSON.stringify({ body: comment.trim(), channel }) },
      );
      setDetail(data);
      setComment("");
      load();
    } catch (err) {
      ui.error(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function changeStatus(status) {
    if (!detail) return;
    if (status === "resolved" && !guidance.trim()) {
      ui.error("Escribí la indicación concreta para Puerta antes de resolver.");
      return;
    }
    setBusy(true);
    try {
      const data = await apiFetch(
        `/venues/${venueId}/events/${eventId}/door-incidents/${detail.id}/status`,
        {
          method: "POST",
          body: JSON.stringify({
            status,
            guidance: guidance.trim() || null,
            note: status === "resolved" ? null : guidance.trim() || null,
          }),
        },
      );
      setDetail(data);
      load();
      ui.success(status === "resolved" ? "Incidencia resuelta." : "Incidencia actualizada.");
    } catch (err) {
      ui.error(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function requestPromoter() {
    if (!detail || !promoterId) {
      ui.error("Elegí el promotor que debe aportar contexto.");
      return;
    }
    setBusy(true);
    try {
      const data = await apiFetch(
        `/venues/${venueId}/events/${eventId}/door-incidents/${detail.id}/request-promoter`,
        {
          method: "POST",
          body: JSON.stringify({
            promoter_id: Number(promoterId),
            note: guidance.trim() || null,
          }),
        },
      );
      setDetail(data);
      load();
      ui.success("El promotor ya puede ver el caso y fue notificado.");
    } catch (err) {
      ui.error(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function logContact() {
    if (!detail || !contact.trim()) return;
    setBusy(true);
    try {
      const data = await apiFetch(
        `/venues/${venueId}/events/${eventId}/door-incidents/${detail.id}/comments`,
        {
          method: "POST",
          body: JSON.stringify({ body: contact.trim(), channel: contactChannel }),
        },
      );
      setDetail(data);
      setContact("");
      load();
    } catch (err) {
      ui.error(err.message);
    } finally {
      setBusy(false);
    }
  }

  const shown = useMemo(
    () => (filter === "all" ? incidents : incidents.filter((i) => i.status === filter)),
    [incidents, filter],
  );
  const counts = useMemo(
    () => ({
      open: incidents.filter((i) => i.status === "open").length,
      reviewing: incidents.filter((i) => i.status === "reviewing").length,
      resolved: incidents.filter((i) => i.status === "resolved").length,
    }),
    [incidents],
  );

  return (
    <section className="doorinc" data-role={role}>
      <header className="doorinc-head">
        <div>
          <p className="doorinc-kicker">Puerta · casos compartidos</p>
          <h2>Incidencias</h2>
          <p>
            {isAdmin
              ? "La puerta reporta; Administración asume, pide apoyo al promotor y resuelve con una indicación."
              : "Solo ves casos de boletas que gestionaste o a los que Administración te dio acceso."}
          </p>
        </div>
        <button type="button" className="doorinc-refresh" onClick={load} aria-label="Actualizar incidencias">
          <Icon name="undo" className="h-4 w-4" />
        </button>
      </header>

      {detail ? (
        <div className="doorinc-detail">
          <button
            type="button"
            className="doorinc-back"
            onClick={() => {
              setDetail(null);
              load();
            }}
          >
            <Icon name="back" className="h-4 w-4" /> Todas las incidencias
          </button>

          <div className="doorinc-detail-head">
            <span className="doorinc-pill" data-tone={STATUS[detail.status]?.tone}>
              {STATUS[detail.status]?.label}
            </span>
            <span className="doorinc-mono">{detail.ticket_ref || `#${detail.id}`}</span>
            <span className="doorinc-muted">{when(detail.created_at)}</span>
          </div>
          <h3>{detail.reason}</h3>
          {detail.note && <p className="doorinc-note">{detail.note}</p>}

          <dl className="doorinc-facts">
            <div><dt>Puesto</dt><dd>{detail.door_name || "—"}</dd></div>
            <div><dt>Reportó</dt><dd>{detail.created_by_name}</dd></div>
            <div><dt>Boleta</dt><dd>{detail.ticket_ref || "Sin boleta adjunta"}</dd></div>
            <div><dt>Tipo</dt><dd>{detail.ticket_type_name || "—"}</dd></div>
            <div><dt>Promotor</dt><dd>{detail.promoter_name || "Sin asignar"}</dd></div>
            <div><dt>Responsable</dt><dd>{detail.assigned_admin_name || "Sin asumir"}</dd></div>
          </dl>

          {detail.resolution_guidance && (
            <div className="doorinc-guidance">
              <span>Indicación para Puerta</span>
              <p>{detail.resolution_guidance}</p>
              {detail.status_changed_by_name && (
                <small>Cerró {detail.status_changed_by_name} · {when(detail.status_changed_at)}</small>
              )}
            </div>
          )}

          {opsContact?.phone && (
            <div className="doorinc-contact">
              <div>
                <span>Contacto operativo</span>
                <strong>{opsContact.name || "Administración"}</strong>
                <small>{opsContact.phone}</small>
              </div>
              <div className="doorinc-contact-actions">
                <a href={phoneHref(opsContact.phone)} className="doorinc-btn doorinc-btn--soft">Llamar</a>
                <a
                  href={waHref(opsContact.phone, `Incidencia ${detail.ticket_ref || detail.id}: ${detail.reason}`)}
                  target="_blank"
                  rel="noreferrer"
                  className="doorinc-btn doorinc-btn--soft"
                >
                  WhatsApp
                </a>
              </div>
            </div>
          )}

          {detail.can_comment && (
            <div className="doorinc-contact-log">
              <label>
                Registrar resultado del contacto
                <input
                  value={contact}
                  onChange={(e) => setContact(e.target.value)}
                  placeholder="Ej: el promotor confirmó que la boleta se reemitió"
                />
              </label>
              <select value={contactChannel} onChange={(e) => setContactChannel(e.target.value)} aria-label="Canal">
                <option value="call">Llamada</option>
                <option value="whatsapp">WhatsApp</option>
                <option value="note">Nota</option>
              </select>
              <button
                type="button"
                className="doorinc-btn doorinc-btn--soft"
                disabled={busy || !contact.trim()}
                onClick={logContact}
              >
                Registrar
              </button>
            </div>
          )}

          <div className="doorinc-thread">
            {(detail.comments || []).length === 0 && (
              <p className="doorinc-muted">Todavía no hay respuestas.</p>
            )}
            {(detail.comments || []).map((c) => (
              <div key={c.id} className="doorinc-comment" data-channel={c.channel}>
                <div>
                  <strong>{c.author_name}</strong>
                  <span>
                    {c.author_role === "admin"
                      ? "Administración"
                      : c.author_role === "promotor"
                        ? "Promotor"
                        : "Puerta"}{" "}
                    · {when(c.created_at)}
                  </span>
                </div>
                <p>{c.body}</p>
              </div>
            ))}
          </div>

          {detail.can_comment && detail.status !== "resolved" && (
            <form className="doorinc-comment-form" onSubmit={sendComment}>
              <textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="Aportar contexto, sin datos personales de más."
                rows={3}
              />
              <div className="doorinc-inline">
                <select value={channel} onChange={(e) => setChannel(e.target.value)} aria-label="Canal">
                  <option value="note">Nota</option>
                  <option value="call">Llamada</option>
                  <option value="whatsapp">WhatsApp</option>
                </select>
                <button type="submit" className="doorinc-btn doorinc-btn--primary" disabled={busy || !comment.trim()}>
                  Responder
                </button>
              </div>
            </form>
          )}

          {isAdmin && detail.can_manage && (
            <div className="doorinc-manage">
              <h4>Resolver el caso</h4>
              <label>
                Indicación para Puerta
                <textarea
                  value={guidance}
                  onChange={(e) => setGuidance(e.target.value)}
                  rows={3}
                  placeholder="Qué debe hacer la persona en la puerta, en una frase concreta."
                />
              </label>
              <div className="doorinc-inline">
                {detail.status !== "reviewing" && detail.status !== "resolved" && (
                  <button type="button" className="doorinc-btn doorinc-btn--soft" disabled={busy} onClick={() => changeStatus("reviewing")}>
                    Asumir caso
                  </button>
                )}
                {detail.status !== "resolved" ? (
                  <button type="button" className="doorinc-btn doorinc-btn--primary" disabled={busy} onClick={() => changeStatus("resolved")}>
                    Resolver
                  </button>
                ) : (
                  <button type="button" className="doorinc-btn doorinc-btn--soft" disabled={busy} onClick={() => changeStatus("open")}>
                    Reabrir
                  </button>
                )}
              </div>
              <div className="doorinc-promoter">
                <label>
                  Pedir apoyo al promotor
                  <select value={promoterId} onChange={(e) => setPromoterId(e.target.value)}>
                    <option value="">Elegí promotor…</option>
                    {staff.map((s) => (
                      <option key={s.user_id} value={s.user_id}>{s.full_name}</option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="doorinc-btn doorinc-btn--soft"
                  disabled={busy || !promoterId}
                  onClick={requestPromoter}
                >
                  Dar acceso y avisar
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="doorinc-filters" role="tablist" aria-label="Estado de incidencias">
            {[
              ["open", `Abiertas ${counts.open}`],
              ["reviewing", `En revisión ${counts.reviewing}`],
              ["resolved", `Resueltas ${counts.resolved}`],
              ["all", "Todas"],
            ].map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={filter === id}
                data-active={filter === id ? "true" : "false"}
                onClick={() => setFilter(id)}
              >
                {label}
              </button>
            ))}
          </div>

          {loading ? (
            <p className="doorinc-muted">Cargando incidencias…</p>
          ) : shown.length === 0 ? (
            <div className="doorinc-empty">
              <Icon name="check" className="h-6 w-6" />
              <strong>Sin incidencias en esta vista</strong>
              <span>Cuando Puerta reporte algo, aparece acá con su boleta y su puesto.</span>
            </div>
          ) : (
            <div className="doorinc-list">
              {shown.map((inc) => (
                <button type="button" key={inc.id} className="doorinc-row" onClick={() => open(inc.id)}>
                  <span className="doorinc-pill" data-tone={STATUS[inc.status]?.tone}>
                    {STATUS[inc.status]?.label}
                  </span>
                  <strong>{inc.reason}</strong>
                  <span className="doorinc-row-meta">
                    {inc.ticket_ref || `#${inc.id}`} · {inc.door_name || "Puerta"} · {when(inc.created_at)}
                  </span>
                  <span className="doorinc-row-sub">
                    {inc.created_by_name}
                    {inc.ticket_type_name ? ` · ${inc.ticket_type_name}` : ""}
                  </span>
                  <Icon name="chevronDown" className="doorinc-chevron h-4 w-4" />
                </button>
              ))}
            </div>
          )}
          {detail && isAdmin && (
            <button type="button" className="doorinc-btn doorinc-btn--soft" onClick={refreshDetail}>
              Actualizar caso
            </button>
          )}
        </>
      )}
    </section>
  );
}
