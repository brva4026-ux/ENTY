import VenueImportPanel from "./VenueImportPanel";
import { useCallback, useEffect, useState } from "react";
import { useUI } from "../lib/ui";
import { money } from "../lib/format";
import {
  createDispute,
  createLottery,
  createManualAdmission,
  createPoll,
  createEventQuestion,
  createRecording,
  deleteRecording,
  deleteEventQuestion,
  drawLottery,
  getAccessRules,
  getArchive,
  getEventAdmin,
  getExternalReconciliation,
  getFeeConfig,
  getStaffingForecast,
  getVenueProfile,
  importExternalTickets,
  listDisputes,
  listExternalChannels,
  listLinkChecks,
  listLotteries,
  listLotteryWinners,
  listManualAdmissions,
  listEventQuestions,
  listPolls,
  listRecordings,
  listRsvps,
  lookupDoorTickets,
  adminFeePreview,
  runLinkCheck,
  saveAccessRules,
  saveArchive,
  saveFeeConfig,
  saveVenueProfile,
  setPollStatus,
  updateDispute,
  updateEventAdmin,
  updateEventQuestion,
  updateExternalChannel,
  updateRsvp,
  createExternalChannel,
} from "../lib/api";

const TABS = [
  ["ingreso", "Sin celular"],
  ["disputas", "Contracargos"],
  ["costos", "Costos"],
  ["reglas", "Reglas"],
  ["votacion", "Votación"],
  ["grabaciones", "Grabaciones"],
  ["sorteo", "Sorteo"],
  ["registro", "Registro gratis"],
  ["recinto", "Recinto"],
  ["personal", "Personal"],
  ["enlaces", "Enlaces"],
  ["archivo", "Archivo"],
  ["preparacion", "Preparación"],
  ["invitados", "Canal invitado"],
];

function useAction() {
  const ui = useUI();
  return useCallback(
    async (fn, ok) => {
      try {
        const res = await fn();
        if (ok) ui.toast(ok, "success");
        return res;
      } catch (error) {
        ui.toast(error?.message || "No se pudo completar", "error");
        return null;
      }
    },
    [ui],
  );
}

function DoorSection({ venueId, eventId }) {
  const act = useAction();
  const [q, setQ] = useState("");
  const [rows, setRows] = useState([]);
  const [selected, setSelected] = useState(null);
  const [reason, setReason] = useState("Sin batería o teléfono descargado");
  const [verification, setVerification] = useState("Documento y compra confirmados");
  const [history, setHistory] = useState([]);
  const load = useCallback(async () => setHistory(await act(() => listManualAdmissions(venueId, eventId)) || []), [act, venueId, eventId]);
  useEffect(() => { load(); }, [load]);

  async function search(e) {
    e.preventDefault();
    const data = await act(() => lookupDoorTickets(venueId, eventId, q));
    setRows(data || []);
  }
  async function admit() {
    if (!selected) return;
    const res = await act(() => createManualAdmission(venueId, eventId, {
      ticket_id: selected.id, reason, verification,
    }), "Ingreso registrado. El QR queda marcado como usado.");
    if (res) { setRows([]); setSelected(null); load(); }
  }
  return (
    <>
      <h4>Ingreso sin celular</h4>
      <p className="bs-suite-note">Busca por nombre, teléfono o correo. Al registrar la entrada, el QR original queda marcado como utilizado.</p>
      <form className="bs-suite-form" onSubmit={search}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nombre, teléfono o correo" />
        <button className="btn-mini" type="submit">Buscar</button>
      </form>
      {rows.map((r) => (
        <button key={r.id} type="button" className="bs-suite-row"
          data-active={selected?.id === r.id} onClick={() => setSelected(r)}>
          <strong>{r.customer_name}</strong>
          <span>{r.type_name} · {r.status === "redeemed" ? "Ya ingresó" : "Vigente"}</span>
          <span>{r.customer_phone || r.customer_email || "Sin contacto"}</span>
        </button>
      ))}
      {selected && (
        <div className="bs-suite-card">
          <strong>{selected.customer_name}</strong>
          <label>Motivo<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          <label>Verificación<input value={verification} onChange={(e) => setVerification(e.target.value)} /></label>
          <button type="button" className="btn-mini" onClick={admit}>Registrar ingreso</button>
        </div>
      )}
      {history.length > 0 && (
        <div className="bs-suite-card">
          <strong>Ingresos manuales</strong>
          {history.map((h) => <p key={h.id}>#{h.ticket_id} · {h.customer_name} · {h.staff_name || "staff"}</p>)}
        </div>
      )}
    </>
  );
}

function DisputeSection({ venueId, eventId }) {
  const act = useAction();
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState({ amount: "", reason: "", due: "" });
  const load = useCallback(async () => setRows(await act(() => listDisputes(venueId, eventId)) || []), [act, venueId, eventId]);
  useEffect(() => { load(); }, [load]);
  async function add(e) {
    e.preventDefault();
    if (await act(() => createDispute(venueId, eventId, {
      amount_cents: Math.round(Number(form.amount) * 100), reason: form.reason,
      due_at: form.due ? new Date(form.due).toISOString() : null,
    }), "Contracargo registrado.")) { setForm({ amount: "", reason: "", due: "" }); load(); }
  }
  async function status(row, next) {
    if (await act(() => updateDispute(venueId, eventId, row.id, { status: next }), "Estado actualizado.")) load();
  }
  return (
    <>
      <h4>Contracargos</h4>
      <form className="bs-suite-form" onSubmit={add}>
        <input required type="number" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder="Monto en pesos" />
        <input required value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="Motivo del banco" />
        <input type="date" value={form.due} onChange={(e) => setForm({ ...form, due: e.target.value })} />
        <button className="btn-mini" type="submit">Registrar</button>
      </form>
      {rows.map((r) => (
        <div key={r.id} className="bs-suite-card">
          <strong>{money(r.amount_cents)} · {r.status}</strong>
          <span>{r.reason}</span>
          <span>{r.due_at ? `Responde antes del ${new Date(r.due_at).toLocaleString()}` : "Sin fecha límite"}{r.overdue ? " · VENCIDO" : ""}</span>
          <div className="bs-suite-actions">
            {["en_revision", "ganada", "perdida"].map((s) => (
              <button key={s} type="button" className="btn-mini" onClick={() => status(r, s)}>{s}</button>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

function FeeSection({ venueId, eventId, types }) {
  const act = useAction();
  const [cfg, setCfg] = useState({
    service_fee_cents: 0,
    payment_fee_pct: 0,
    tax_pct: 0,
    show_breakdown: true,
    platform_fee_bps: 0,
    platform_fee_fixed_cents: 0,
    platform_fee_payer: "organizer",
  });
  const [typeId, setTypeId] = useState(types?.[0]?.id || "");
  const [preview, setPreview] = useState(null);

  const refreshPreview = useCallback(async (ticketTypeId = typeId) => {
    if (!ticketTypeId) return;
    try {
      setPreview(await adminFeePreview(venueId, eventId, ticketTypeId));
    } catch {
      setPreview(null);
    }
  }, [venueId, eventId, typeId]);

  useEffect(() => {
    getFeeConfig(venueId, eventId).then(setCfg).catch(() => {});
  }, [venueId, eventId]);
  useEffect(() => { refreshPreview(); }, [refreshPreview]);

  async function save(e) {
    e.preventDefault();
    const saved = await act(() => saveFeeConfig(venueId, eventId, cfg), "Costos guardados.");
    if (saved) {
      setCfg(saved);
      refreshPreview();
    }
  }

  return (
    <>
      <h4>Costos transparentes y comisión de Enty</h4>
      <form className="bs-suite-form" onSubmit={save}>
        <label>Servicio al comprador (centavos)<input type="number" value={cfg.service_fee_cents} onChange={(e) => setCfg({ ...cfg, service_fee_cents: Number(e.target.value) })} /></label>
        <label>Comisión de pago (%)<input type="number" step="0.01" value={cfg.payment_fee_pct} onChange={(e) => setCfg({ ...cfg, payment_fee_pct: Number(e.target.value) })} /></label>
        <label>Impuesto (%)<input type="number" step="0.01" value={cfg.tax_pct} onChange={(e) => setCfg({ ...cfg, tax_pct: Number(e.target.value) })} /></label>
        <label>Comisión de Enty (%)<input type="number" min="0" max="100" step="0.01" value={(cfg.platform_fee_bps || 0) / 100} onChange={(e) => setCfg({ ...cfg, platform_fee_bps: Math.round(Number(e.target.value) * 100) })} /></label>
        <label>Cargo fijo de Enty (centavos)<input type="number" min="0" value={cfg.platform_fee_fixed_cents} onChange={(e) => setCfg({ ...cfg, platform_fee_fixed_cents: Number(e.target.value) })} /></label>
        <label>¿Quién paga la comisión de Enty?
          <select value={cfg.platform_fee_payer} onChange={(e) => setCfg({ ...cfg, platform_fee_payer: e.target.value })}>
            <option value="organizer">El organizador, desde su liquidación</option>
            <option value="buyer">El comprador, en el total</option>
          </select>
        </label>
        <label className="bs-suite-check"><input type="checkbox" checked={cfg.show_breakdown} onChange={(e) => setCfg({ ...cfg, show_breakdown: e.target.checked })} /> Mostrar desglose al comprador</label>
        <button className="btn-mini" type="submit">Guardar</button>
      </form>
      <div className="bs-suite-card">
        <strong>Simulación de una venta</strong>
        <select value={typeId} onChange={(e) => setTypeId(Number(e.target.value))}>
          {types?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        {preview && (
          <div className="bs-suite-breakdown">
            <p><span>Paga el comprador</span><b>{money(preview.buyer_total_cents)}</b></p>
            <p><span>Boleta</span><b>{money(preview.base_cents)}</b></p>
            <p><span>Servicio</span><b>{money(preview.service_fee_cents)}</b></p>
            <p><span>Comisión de pago</span><b>{money(preview.payment_fee_cents)}</b></p>
            <p><span>Impuesto</span><b>{money(preview.tax_cents)}</b></p>
            <p><span>Enty ({preview.platform_fee_payer === "buyer" ? "lo paga el comprador" : "lo paga el organizador"})</span><b>{money(preview.platform_fee_cents)}</b></p>
            <p><span>Neto para el organizador</span><b>{money(preview.organizer_net_cents)}</b></p>
          </div>
        )}
      </div>
    </>
  );
}

function RulesSection({ venueId, eventId }) {
  const act = useAction();
  const [form, setForm] = useState({ dress_code: "", bags_policy: "", prohibited: "" });
  useEffect(() => {
    getAccessRules(venueId, eventId).then((r) => setForm({
      dress_code: r.dress_code || "", bags_policy: r.bags_policy || "",
      prohibited: (r.prohibited_items || []).join(", "),
    })).catch(() => {});
  }, [venueId, eventId]);
  async function save(e) {
    e.preventDefault();
    await act(() => saveAccessRules(venueId, eventId, {
      dress_code: form.dress_code || null, bags_policy: form.bags_policy || null,
      prohibited_items: form.prohibited.split(",").map((s) => s.trim()).filter(Boolean),
    }), "Reglas guardadas. Puerta y ficha ven la misma versión.");
  }
  return (
    <>
      <h4>Vestimenta y objetos</h4>
      <form className="bs-suite-form" onSubmit={save}>
        <label>Vestimenta<input value={form.dress_code} onChange={(e) => setForm({ ...form, dress_code: e.target.value })} placeholder="Elegante, sin gorra..." /></label>
        <label>Bolsos<input value={form.bags_policy} onChange={(e) => setForm({ ...form, bags_policy: e.target.value })} placeholder="Bolsos pequeños, sin mochilas..." /></label>
        <label>Objetos prohibidos<input value={form.prohibited} onChange={(e) => setForm({ ...form, prohibited: e.target.value })} placeholder="Vidrio, pirotecnia, armas" /></label>
        <button className="btn-mini" type="submit">Publicar reglas</button>
      </form>
    </>
  );
}

function PollSection({ venueId, eventId }) {
  const act = useAction();
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState({ question: "", options: "" });
  const load = useCallback(async () => setRows(await act(() => listPolls(venueId, eventId)) || []), [act, venueId, eventId]);
  useEffect(() => { load(); }, [load]);
  async function add(e) {
    e.preventDefault();
    if (await act(() => createPoll(venueId, eventId, {
      question: form.question,
      options: form.options.split("\n").map((s) => s.trim()).filter(Boolean),
    }), "Votación creada.")) { setForm({ question: "", options: "" }); load(); }
  }
  async function status(row, next) {
    if (await act(() => setPollStatus(venueId, eventId, row.id, next), `Votación ${next}.`)) load();
  }
  return (
    <>
      <h4>Votaciones durante el evento</h4>
      <form className="bs-suite-form" onSubmit={add}>
        <input required value={form.question} onChange={(e) => setForm({ ...form, question: e.target.value })} placeholder="Pregunta" />
        <textarea required value={form.options} onChange={(e) => setForm({ ...form, options: e.target.value })} placeholder="Una opción por línea" rows={3} />
        <button className="btn-mini" type="submit">Crear</button>
      </form>
      {rows.map((p) => (
        <div key={p.id} className="bs-suite-card">
          <strong>{p.question} · {p.status}</strong>
          {(p.options || []).map((o) => <span key={o.id}>{o.label}: {o.votes}</span>)}
          <div className="bs-suite-actions">
            {["abierta", "cerrada", "publicada"].map((s) => (
              <button key={s} type="button" className="btn-mini" onClick={() => status(p, s)}>{s}</button>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

function RecordingSection({ venueId, eventId, types }) {
  const act = useAction();
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState({ title: "", url: "", ticket_type_id: "" });
  const load = useCallback(async () => setRows(await act(() => listRecordings(venueId, eventId)) || []), [act, venueId, eventId]);
  useEffect(() => { load(); }, [load]);
  async function add(e) {
    e.preventDefault();
    if (await act(() => createRecording(venueId, eventId, {
      title: form.title, url: form.url,
      ticket_type_id: form.ticket_type_id ? Number(form.ticket_type_id) : null,
    }), "Grabación publicada.")) { setForm({ title: "", url: "", ticket_type_id: "" }); load(); }
  }
  return (
    <>
      <h4>Grabaciones después del evento</h4>
      <form className="bs-suite-form" onSubmit={add}>
        <input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Título" />
        <input required value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://..." />
        <select value={form.ticket_type_id} onChange={(e) => setForm({ ...form, ticket_type_id: e.target.value })}>
          <option value="">Todas las boletas</option>
          {types?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <button className="btn-mini" type="submit">Publicar</button>
      </form>
      {rows.map((r) => (
        <div key={r.id} className="bs-suite-card">
          <strong>{r.title}</strong>
          <span>{r.type_name || "Todas"} · {r.available_until ? `Hasta ${new Date(r.available_until).toLocaleDateString()}` : "Sin fecha límite"}</span>
          <button type="button" className="btn-mini" onClick={async () => { await act(() => deleteRecording(venueId, eventId, r.id)); load(); }}>Eliminar</button>
        </div>
      ))}
    </>
  );
}

function LotterySection({ venueId, eventId }) {
  const act = useAction();
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState({ name: "", quantity: 10, opens: "", closes: "" });
  const load = useCallback(async () => setRows(await act(() => listLotteries(venueId, eventId)) || []), [act, venueId, eventId]);
  useEffect(() => { load(); }, [load]);
  async function add(e) {
    e.preventDefault();
    if (await act(() => createLottery(venueId, eventId, {
      name: form.name, quantity: Number(form.quantity),
      opens_at: new Date(form.opens).toISOString(), closes_at: new Date(form.closes).toISOString(),
    }), "Sorteo abierto.")) { setForm({ name: "", quantity: 10, opens: "", closes: "" }); load(); }
  }
  async function draw(row) {
    if (await act(() => drawLottery(venueId, eventId, row.id), "Sorteo realizado.")) {
      const winners = await listLotteryWinners(venueId, eventId, row.id);
      if (winners?.[0]) window.prompt("Token del ganador (compártelo con la persona)", winners[0].token);
      load();
    }
  }
  return (
    <>
      <h4>Sorteo de acceso</h4>
      <form className="bs-suite-form" onSubmit={add}>
        <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Nombre del sorteo" />
        <input type="number" min="1" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} placeholder="Cupos" />
        <label>Abre<input type="datetime-local" required value={form.opens} onChange={(e) => setForm({ ...form, opens: e.target.value })} /></label>
        <label>Cierra<input type="datetime-local" required value={form.closes} onChange={(e) => setForm({ ...form, closes: e.target.value })} /></label>
        <button className="btn-mini" type="submit">Crear sorteo</button>
      </form>
      {rows.map((l) => (
        <div key={l.id} className="bs-suite-card">
          <strong>{l.name} · {l.status}</strong>
          <span>{l.entries} inscritos · {l.winners} ganadores de {l.quantity}</span>
          {l.status === "abierta" && <button type="button" className="btn-mini" onClick={() => draw(l)}>Sortear</button>}
        </div>
      ))}
    </>
  );
}

export function RsvpSection({ venueId, eventId, eventName }) {
  const act = useAction();
  const [showImport, setShowImport] = useState(false);
  const [rows, setRows] = useState([]);
  const load = useCallback(async () => setRows(await act(() => listRsvps(venueId, eventId)) || []), [act, venueId, eventId]);
  useEffect(() => { load(); }, [load]);
  return (
    <>
      <h3>Lista de invitados</h3>
      <p className="bs-suite-note">Las filas importadas quedan como confirmaciones de asistencia. Las boletas con QR se emiten por separado.</p>
      <button
        type="button"
        className="btn-ghost"
        aria-expanded={showImport}
        onClick={() => setShowImport((open) => !open)}
      >
        {showImport ? "Ocultar importación" : "Importar lista de invitados"}
      </button>
      {showImport && (
        <VenueImportPanel venueId={venueId} guestEvent={{ id: eventId, name: eventName }} onImported={load} />
      )}
      {rows.length === 0 && <p className="bs-suite-note">Aún no hay confirmaciones.</p>}
      {rows.map((r) => (
        <div key={r.id} className="bs-suite-card">
          <strong>{r.name} · {r.status}</strong>
          <span>{r.email} {r.phone || ""}</span>
          <div className="bs-suite-actions">
            {["reconfirmar", "cancelada", "confirmada"].map((s) => (
              <button key={s} type="button" className="btn-mini" onClick={async () => { await act(() => updateRsvp(venueId, eventId, r.id, s)); load(); }}>{s}</button>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

function VenueSection({ venueId }) {
  const act = useAction();
  const [form, setForm] = useState({});
  useEffect(() => { getVenueProfile(venueId).then(setForm).catch(() => {}); }, [venueId]);
  async function save(e) {
    e.preventDefault();
    await act(() => saveVenueProfile(venueId, form), "Ficha del recinto guardada.");
  }
  return (
    <>
      <h4>Catálogo del recinto</h4>
      <form className="bs-suite-form" onSubmit={save}>
        <label>Ancho de escenario (m)<input type="number" step="0.1" value={form.stage_width_m ?? ""} onChange={(e) => setForm({ ...form, stage_width_m: Number(e.target.value) })} /></label>
        <label>Profundidad (m)<input type="number" step="0.1" value={form.stage_depth_m ?? ""} onChange={(e) => setForm({ ...form, stage_depth_m: Number(e.target.value) })} /></label>
        <label>Carga desde<input type="time" value={form.load_in_start || ""} onChange={(e) => setForm({ ...form, load_in_start: e.target.value })} /></label>
        <label>Carga hasta<input type="time" value={form.load_in_end || ""} onChange={(e) => setForm({ ...form, load_in_end: e.target.value })} /></label>
        <label>Sonido<input value={form.sound_system || ""} onChange={(e) => setForm({ ...form, sound_system: e.target.value })} /></label>
        <label>Iluminación<input value={form.lighting || ""} onChange={(e) => setForm({ ...form, lighting: e.target.value })} /></label>
        <label>Energía<input value={form.power || ""} onChange={(e) => setForm({ ...form, power: e.target.value })} /></label>
        <label>Contacto técnico<input value={form.technical_contact || ""} onChange={(e) => setForm({ ...form, technical_contact: e.target.value })} /></label>
        <button className="btn-mini" type="submit">Guardar ficha</button>
      </form>
    </>
  );
}

function StaffingSection({ venueId, eventId }) {
  const [data, setData] = useState(null);
  useEffect(() => { getStaffingForecast(venueId, eventId).then(setData).catch(() => {}); }, [venueId, eventId]);
  return (
    <>
      <h4>Previsión de personal</h4>
      {data && (
        <div className="bs-suite-card">
          <strong>{data.basis}</strong>
          <span>Vendidas: {data.sold} · Ingresaron: {data.admitted} · Capacidad: {data.capacity}</span>
          {data.hourly_plan.map((h) => (
            <p key={h.relative_hour}>Hora {h.relative_hour >= 0 ? `+${h.relative_hour}` : h.relative_hour}: {h.expected_entries} ingresos · {h.recommended_staff} puestos</p>
          ))}
        </div>
      )}
    </>
  );
}

function LinkCheckSection({ venueId, eventId }) {
  const act = useAction();
  const [url, setUrl] = useState("");
  const [rows, setRows] = useState([]);
  const load = useCallback(async () => setRows(await act(() => listLinkChecks(venueId, eventId)) || []), [act, venueId, eventId]);
  useEffect(() => { load(); }, [load]);
  return (
    <>
      <h4>Revisión de enlaces antes de anunciar</h4>
      <form className="bs-suite-form" onSubmit={async (e) => { e.preventDefault(); if (await act(() => runLinkCheck(venueId, eventId, { url }), "Revisión completada.")) { setUrl(""); load(); } }}>
        <input required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://..." />
        <button className="btn-mini" type="submit">Revisar</button>
      </form>
      {rows.map((r) => (
        <div key={r.id} className="bs-suite-card">
          <strong>{r.status.toUpperCase()} · {r.url}</strong>
          <span>{new Date(r.checked_at).toLocaleString()}</span>
          {(r.details?.checks || []).map((c) => <p key={c.name}>{c.ok ? "OK" : "FALLA"} · {c.name}: {c.detail}</p>)}
        </div>
      ))}
    </>
  );
}

function ArchiveSection({ venueId, eventId }) {
  const act = useAction();
  const [form, setForm] = useState({ enabled: false, headline: "", summary: "", photos: "" });
  useEffect(() => {
    getArchive(venueId, eventId).then((a) => setForm({
      enabled: a.enabled || false, headline: a.headline || "",
      summary: a.summary || "", photos: (a.photos || []).join("\n"),
    })).catch(() => {});
  }, [venueId, eventId]);
  async function save(e) {
    e.preventDefault();
    await act(() => saveArchive(venueId, eventId, {
      enabled: form.enabled, headline: form.headline || null, summary: form.summary || null,
      photos: form.photos.split("\n").map((s) => s.trim()).filter(Boolean),
    }), "Archivo público guardado.");
  }
  return (
    <>
      <h4>Archivo público del evento</h4>
      <form className="bs-suite-form" onSubmit={save}>
        <label className="bs-suite-check"><input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> Habilitar página pública del evento terminado</label>
        <label>Titular<input value={form.headline} onChange={(e) => setForm({ ...form, headline: e.target.value })} /></label>
        <label>Resumen<textarea rows={3} value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} /></label>
        <label>Fotos (una URL por línea)<textarea rows={3} value={form.photos} onChange={(e) => setForm({ ...form, photos: e.target.value })} /></label>
        <button className="btn-mini" type="submit">Guardar archivo</button>
      </form>
    </>
  );
}


function toLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function PreparationSection({ venueId, eventId }) {
  const act = useAction();
  const [questions, setQuestions] = useState([]);
  const [form, setForm] = useState({
    prompt: "",
    help_text: "",
    kind: "text",
    options: "",
    required: false,
    closes_at: "",
  });
  const [stream, setStream] = useState({
    url: "",
    starts: "",
    ends: "",
    instructions: "",
  });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const rows = await act(() => listEventQuestions(venueId, eventId));
    if (rows) setQuestions(rows);
    const event = await act(() => getEventAdmin(venueId, eventId));
    if (event) {
      setStream({
        url: event.stream_url || "",
        starts: toLocalInput(event.stream_starts_at),
        ends: toLocalInput(event.stream_ends_at),
        instructions: event.stream_instructions || "",
      });
    }
  }, [act, venueId, eventId]);

  useEffect(() => { load(); }, [load]);

  async function addQuestion(e) {
    e.preventDefault();
    setBusy(true);
    const created = await act(
      () =>
        createEventQuestion(venueId, eventId, {
          prompt: form.prompt.trim(),
          help_text: form.help_text.trim() || null,
          kind: form.kind,
          options:
            form.kind === "select"
              ? form.options.split(",").map((x) => x.trim()).filter(Boolean)
              : [],
          required: form.required,
          closes_at: form.closes_at
            ? new Date(form.closes_at).toISOString()
            : null,
        }),
      "Pregunta publicada",
    );
    if (created) {
      setQuestions((prev) => [...prev, created]);
      setForm({
        prompt: "",
        help_text: "",
        kind: "text",
        options: "",
        required: false,
        closes_at: "",
      });
    }
    setBusy(false);
  }

  async function toggleQuestion(row) {
    const updated = await act(() =>
      updateEventQuestion(venueId, eventId, row.id, {
        is_active: !row.is_active,
      }),
    );
    if (updated) {
      setQuestions((prev) => prev.map((q) => (q.id === updated.id ? updated : q)));
    }
  }

  async function removeQuestion(row) {
    const ok = await act(() => deleteEventQuestion(venueId, eventId, row.id));
    if (ok !== null) setQuestions((prev) => prev.filter((q) => q.id !== row.id));
  }

  async function saveStream(e) {
    e.preventDefault();
    setBusy(true);
    const saved = await act(
      () =>
        updateEventAdmin(venueId, eventId, {
          stream_url: stream.url.trim() || null,
          stream_starts_at: stream.starts
            ? new Date(stream.starts).toISOString()
            : null,
          stream_ends_at: stream.ends ? new Date(stream.ends).toISOString() : null,
          stream_instructions: stream.instructions.trim() || null,
        }),
      "Transmisión guardada",
    );
    if (saved) {
      setStream({
        url: saved.stream_url || "",
        starts: toLocalInput(saved.stream_starts_at),
        ends: toLocalInput(saved.stream_ends_at),
        instructions: saved.stream_instructions || "",
      });
    }
    setBusy(false);
  }

  return (
    <>
      <p className="bs-suite-note">
        Prepara la experiencia después de la compra: preguntas para tus
        asistentes y la ventana de la transmisión para boletas virtuales.
      </p>

      <h4>Transmisión</h4>
      <form className="bs-suite-form" onSubmit={saveStream}>
        <label>
          Enlace del directo
          <input
            type="url"
            value={stream.url}
            onChange={(e) => setStream({ ...stream, url: e.target.value })}
            placeholder="https://…"
          />
        </label>
        <label>
          Abre
          <input
            type="datetime-local"
            value={stream.starts}
            onChange={(e) => setStream({ ...stream, starts: e.target.value })}
          />
        </label>
        <label>
          Cierra
          <input
            type="datetime-local"
            value={stream.ends}
            onChange={(e) => setStream({ ...stream, ends: e.target.value })}
          />
        </label>
        <label>
          Instrucciones
          <textarea
            rows={2}
            value={stream.instructions}
            onChange={(e) =>
              setStream({ ...stream, instructions: e.target.value })
            }
            placeholder="Cómo entrar, a qué hora conectarse…"
          />
        </label>
        <button className="btn-mini" type="submit" disabled={busy}>
          Guardar transmisión
        </button>
      </form>
      <p className="bs-suite-note">
        El enlace solo se entrega a una boleta virtual dentro de esta ventana.
        La ficha pública anuncia el horario, nunca la URL.
      </p>

      <h4>Preguntas después de comprar</h4>
      <form className="bs-suite-form" onSubmit={addQuestion}>
        <label>
          Pregunta
          <input
            value={form.prompt}
            onChange={(e) => setForm({ ...form, prompt: e.target.value })}
            placeholder="¿Qué nivel de experiencia tienes?"
            required
          />
        </label>
        <label>
          Tipo
          <select
            value={form.kind}
            onChange={(e) => setForm({ ...form, kind: e.target.value })}
          >
            <option value="text">Texto corto</option>
            <option value="textarea">Texto largo</option>
            <option value="select">Selección</option>
            <option value="number">Número</option>
            <option value="boolean">Sí / No</option>
          </select>
        </label>
        {form.kind === "select" && (
          <label>
            Opciones separadas por coma
            <input
              value={form.options}
              onChange={(e) => setForm({ ...form, options: e.target.value })}
              placeholder="Principiante, Intermedio, Avanzado"
            />
          </label>
        )}
        <label>
          Ayuda (opcional)
          <input
            value={form.help_text}
            onChange={(e) => setForm({ ...form, help_text: e.target.value })}
          />
        </label>
        <label>
          Cierra
          <input
            type="datetime-local"
            value={form.closes_at}
            onChange={(e) => setForm({ ...form, closes_at: e.target.value })}
          />
        </label>
        <label className="bs-suite-check">
          <input
            type="checkbox"
            checked={form.required}
            onChange={(e) => setForm({ ...form, required: e.target.checked })}
          />
          Obligatoria
        </label>
        <button className="btn-mini" type="submit" disabled={busy}>
          Agregar pregunta
        </button>
      </form>

      <ul className="bs-suite-list">
        {questions.map((q) => (
          <li key={q.id}>
            <div>
              <b>{q.prompt}</b>
              <small>
                {q.kind}
                {q.required ? " · obligatoria" : ""} · {q.answer_count}{" "}
                respuesta(s)
                {q.is_active === false ? " · pausada" : ""}
              </small>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                className="btn-mini"
                onClick={() => toggleQuestion(q)}
              >
                {q.is_active === false ? "Activar" : "Pausar"}
              </button>
              <button
                type="button"
                className="btn-mini"
                data-variant="danger"
                onClick={() => removeQuestion(q)}
              >
                Eliminar
              </button>
            </div>
          </li>
        ))}
        {questions.length === 0 && (
          <li><small>Aún no hay preguntas para este evento.</small></li>
        )}
      </ul>
    </>
  );
}

const CSV_ALIASES = {
  external_ticket_id: ["external_ticket_id", "id_externo", "id", "codigo", "ticket_id"],
  token: ["token", "qr", "codigo_qr", "raw_token"],
  holder_name: ["holder_name", "nombre", "name", "asistente"],
  holder_phone: ["holder_phone", "telefono", "phone", "celular"],
  holder_email: ["holder_email", "email", "correo"],
  status: ["status", "estado"],
};

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const clean = String(text || "").replace(/^\uFEFF/, "");
  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean[i];
    if (quoted) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") {
      cell += ch;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

function normalizeStatus(value) {
  const v = String(value || "").trim().toLowerCase();
  if (["void", "anulada", "anulado", "cancelada"].includes(v)) return "void";
  if (["used", "usada", "usado", "redeemed", "ingresó", "ingreso"].includes(v)) return "used";
  return "valid";
}

function csvToRows(text) {
  const table = parseCsv(text);
  if (table.length < 2) {
    return { rows: [], error: "El CSV no tiene filas de datos." };
  }
  const header = table[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  const idx = {};
  Object.entries(CSV_ALIASES).forEach(([key, names]) => {
    idx[key] = header.findIndex((h) => names.includes(h));
  });
  const missing = ["external_ticket_id", "token", "holder_name"].filter(
    (key) => idx[key] < 0,
  );
  if (missing.length) {
    return {
      rows: [],
      error: `Faltan columnas: ${missing.join(", ")}.`,
    };
  }
  const rows = [];
  const incomplete = [];
  table.slice(1).forEach((cells, index) => {
    const get = (key) => (idx[key] >= 0 ? (cells[idx[key]] || "").trim() : "");
    const row = {
      external_ticket_id: get("external_ticket_id"),
      token: get("token"),
      holder_name: get("holder_name"),
      holder_phone: get("holder_phone") || null,
      holder_email: get("holder_email") || null,
      status: normalizeStatus(get("status")),
    };
    if (!row.external_ticket_id || !row.token || !row.holder_name) {
      incomplete.push(index + 2);
    } else {
      rows.push(row);
    }
  });
  return {
    rows,
    error: incomplete.length
      ? `Filas incompletas omitidas: ${incomplete.slice(0, 8).join(", ")}${incomplete.length > 8 ? "…" : ""}`
      : "",
  };
}

function ExternalChannelSection({ venueId, eventId, types = [] }) {
  const act = useAction();
  const [channels, setChannels] = useState([]);
  const [form, setForm] = useState({
    name: "",
    provider_name: "",
    confirmation_owner: "enty",
    zone_id: "",
  });
  const [selected, setSelected] = useState(null);
  const [csvName, setCsvName] = useState("");
  const [csvRows, setCsvRows] = useState([]);
  const [csvError, setCsvError] = useState("");
  const [result, setResult] = useState(null);
  const [recon, setRecon] = useState(null);
  const [busy, setBusy] = useState(false);

  const zones = [];
  const seenZones = new Set();
  types.forEach((t) => {
    if (t.zone_id && !seenZones.has(t.zone_id)) {
      seenZones.add(t.zone_id);
      zones.push({ id: t.zone_id, name: t.zone_name || `Zona ${t.zone_id}` });
    }
  });

  const load = useCallback(async () => {
    const rows = await act(() => listExternalChannels(venueId, eventId));
    if (rows) setChannels(rows);
  }, [act, venueId, eventId]);

  useEffect(() => {
    load();
  }, [load]);

  async function loadReconciliation(channelId) {
    const data = await act(() =>
      getExternalReconciliation(venueId, eventId, channelId),
    );
    if (data) setRecon(data);
  }

  async function addChannel(e) {
    e.preventDefault();
    if (!form.name.trim() || !form.provider_name.trim()) return;
    setBusy(true);
    const created = await act(
      () =>
        createExternalChannel(venueId, eventId, {
          name: form.name.trim(),
          provider_name: form.provider_name.trim(),
          confirmation_owner: form.confirmation_owner,
          zone_id: form.zone_id ? Number(form.zone_id) : null,
        }),
      "Canal invitado creado",
    );
    if (created) {
      setChannels((prev) => [created, ...prev]);
      setSelected(created);
      setRecon(null);
      setForm({ name: "", provider_name: "", confirmation_owner: "enty", zone_id: "" });
      loadReconciliation(created.id);
    }
    setBusy(false);
  }

  async function toggleChannel(channel) {
    const next = channel.status === "active" ? "paused" : "active";
    const updated = await act(
      () =>
        updateExternalChannel(venueId, eventId, channel.id, { status: next }),
      next === "active" ? "Canal activado" : "Canal pausado",
    );
    if (updated) {
      setChannels((prev) =>
        prev.map((c) => (c.id === updated.id ? updated : c)),
      );
      if (selected?.id === updated.id) setSelected(updated);
    }
  }

  function openChannel(channel) {
    setSelected(channel);
    setCsvRows([]);
    setCsvName("");
    setCsvError("");
    setResult(null);
    loadReconciliation(channel.id);
  }

  async function onFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const parsed = csvToRows(text);
    setCsvName(file.name);
    setCsvRows(parsed.rows);
    setCsvError(parsed.error || "");
    setResult(null);
  }

  async function doImport() {
    if (!selected || !csvRows.length) return;
    setBusy(true);
    const res = await act(
      () =>
        importExternalTickets(venueId, eventId, selected.id, {
          filename: csvName,
          rows: csvRows,
        }),
      "Importación terminada",
    );
    if (res) {
      setResult(res);
      await load();
      await loadReconciliation(selected.id);
    }
    setBusy(false);
  }

  return (
    <>
      <p className="bs-suite-note">
        Opera en Enty la puerta de boletas vendidas por otro canal. Importá el
        CSV del proveedor, elegí quién confirma cada ingreso y revisá la
        conciliación por canal. El token se guarda hasheado, nunca en claro.
      </p>

      <h4>Nuevo canal invitado</h4>
      <form className="bs-suite-form" onSubmit={addChannel}>
        <label>
          Nombre del canal
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Taquilla invitada"
            required
          />
        </label>
        <label>
          Proveedor
          <input
            value={form.provider_name}
            onChange={(e) => setForm({ ...form, provider_name: e.target.value })}
            placeholder="Nombre de la plataforma"
            required
          />
        </label>
        <label>
          ¿Quién confirma el ingreso?
          <select
            value={form.confirmation_owner}
            onChange={(e) =>
              setForm({ ...form, confirmation_owner: e.target.value })
            }
          >
            <option value="enty">Enty</option>
            <option value="provider">El proveedor</option>
            <option value="shared">Ambos (Enty registra)</option>
          </select>
        </label>
        {zones.length > 0 && (
          <label>
            Zona (opcional)
            <select
              value={form.zone_id}
              onChange={(e) => setForm({ ...form, zone_id: e.target.value })}
            >
              <option value="">Sin zona</option>
              {zones.map((z) => (
                <option key={z.id} value={z.id}>{z.name}</option>
              ))}
            </select>
          </label>
        )}
        <button className="btn-mini" type="submit" disabled={busy}>
          Crear canal
        </button>
      </form>

      <ul className="bs-suite-list">
        {channels.map((c) => (
          <li key={c.id}>
            <div>
              <b>{c.name}</b>
              <small>
                {c.provider_name} · {c.status} · {c.valid} válidas ·{" "}
                {c.redeemed} ingresaron · {c.voided} anuladas
              </small>
            </div>
            <div className="flex gap-2">
              <button type="button" className="btn-mini" onClick={() => openChannel(c)}>
                Importar / conciliar
              </button>
              <button type="button" className="btn-mini" onClick={() => toggleChannel(c)}>
                {c.status === "active" ? "Pausar" : "Activar"}
              </button>
            </div>
          </li>
        ))}
        {channels.length === 0 && (
          <li><small>Aún no hay canales invitados en este evento.</small></li>
        )}
      </ul>

      {selected && (
        <div className="bs-suite-card">
          <strong>{selected.name}</strong>
          <p className="bs-suite-note">
            Confirma: {selected.confirmation_owner} · Localidad:{" "}
            {selected.ticket_type_name}
            {selected.zone_name ? ` · ${selected.zone_name}` : ""}
          </p>

          <label>
            CSV del proveedor
            <input type="file" accept=".csv,text/csv" onChange={onFile} />
          </label>
          <p className="bs-suite-note">
            Columnas: external_ticket_id, token, holder_name, holder_phone,
            holder_email, status. status: valid, void o used.
          </p>
          {csvError && <p className="bs-suite-note">{csvError}</p>}
          {csvRows.length > 0 && (
            <p className="bs-suite-note">
              {csvRows.length} boletas listas para importar desde {csvName}.
            </p>
          )}
          <button
            type="button"
            className="btn-mini"
            disabled={!csvRows.length || busy}
            onClick={doImport}
          >
            Importar {csvRows.length || ""} boletas
          </button>

          {result && (
            <div className="bs-suite-card">
              <strong>Resultado de la importación</strong>
              <p>
                {result.imported} nuevas · {result.updated} actualizadas ·{" "}
                {result.skipped} omitidas
              </p>
              {result.errors.slice(0, 10).map((err) => (
                <p key={`${err.row}-${err.external_ticket_id || ""}`}>
                  Fila {err.row}: {err.message}
                </p>
              ))}
            </div>
          )}

          {recon && (
            <div className="bs-suite-card">
              <strong>Conciliación</strong>
              <p>
                {recon.valid} válidas · {recon.redeemed} ingresaron ·{" "}
                {recon.voided} anuladas · {recon.total} importadas
              </p>
              <p>
                Aforo: {recon.active_total} activas de {recon.capacity} ·{" "}
                {recon.external_total} del canal invitado
              </p>
              {recon.capacity_warning && (
                <p className="bs-suite-note">
                  Las boletas activas superan el aforo. Revisá la capacidad del
                  evento antes de abrir la puerta.
                </p>
              )}
              {recon.by_door.length > 0 && (
                <p>
                  Ingresos por puerta:{" "}
                  {recon.by_door.map((d) => `${d.door_id} (${d.count})`).join(" · ")}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}


export default function EventMorePanel({ venueId, eventId, types = [] }) {
  const [tab, setTab] = useState("ingreso");
  const props = { venueId, eventId, types };
  return (
    <section className="bs-suite bs-suite-more">
      <header className="bs-suite-head">
        <div>
          <h3>Más herramientas</h3>
          <p>Doce frentes nuevos para operar, vender y cuidar la experiencia.</p>
        </div>
      </header>
      <nav className="bs-suite-tabs" aria-label="Herramientas adicionales">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" data-active={tab === id} onClick={() => setTab(id)}>{label}</button>
        ))}
      </nav>
      <div className="bs-suite-body">
        {tab === "ingreso" && <DoorSection {...props} />}
        {tab === "disputas" && <DisputeSection {...props} />}
        {tab === "costos" && <FeeSection {...props} />}
        {tab === "reglas" && <RulesSection {...props} />}
        {tab === "votacion" && <PollSection {...props} />}
        {tab === "grabaciones" && <RecordingSection {...props} />}
        {tab === "sorteo" && <LotterySection {...props} />}
        {tab === "registro" && <RsvpSection {...props} />}
        {tab === "recinto" && <VenueSection {...props} />}
        {tab === "personal" && <StaffingSection {...props} />}
        {tab === "enlaces" && <LinkCheckSection {...props} />}
        {tab === "archivo" && <ArchiveSection {...props} />}
        {tab === "preparacion" && <PreparationSection {...props} />}
        {tab === "invitados" && <ExternalChannelSection {...props} />}
      </div>
    </section>
  );
}
