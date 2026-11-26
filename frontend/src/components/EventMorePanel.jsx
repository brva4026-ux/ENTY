import { useCallback, useEffect, useState } from "react";
import { useUI } from "../lib/ui";
import { money } from "../lib/format";
import {
  createDispute,
  createLottery,
  createManualAdmission,
  createPoll,
  createRecording,
  deleteRecording,
  drawLottery,
  getAccessRules,
  getArchive,
  getFeeConfig,
  getStaffingForecast,
  getVenueProfile,
  listDisputes,
  listLinkChecks,
  listLotteries,
  listLotteryWinners,
  listManualAdmissions,
  listPolls,
  listRecordings,
  listRsvps,
  lookupDoorTickets,
  publicFees,
  runLinkCheck,
  saveAccessRules,
  saveArchive,
  saveFeeConfig,
  saveVenueProfile,
  setPollStatus,
  updateDispute,
  updateRsvp,
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
  const [cfg, setCfg] = useState({ service_fee_cents: 0, payment_fee_pct: 0, tax_pct: 0, show_breakdown: true });
  const [typeId, setTypeId] = useState(types?.[0]?.id || "");
  const [preview, setPreview] = useState(null);
  useEffect(() => { getFeeConfig(venueId, eventId).then(setCfg).catch(() => {}); }, [venueId, eventId]);
  useEffect(() => { if (typeId) publicFees(eventId, typeId).then(setPreview).catch(() => setPreview(null)); }, [eventId, typeId]);
  async function save(e) {
    e.preventDefault();
    const saved = await act(() => saveFeeConfig(venueId, eventId, cfg), "Costos guardados.");
    if (saved) setCfg(saved);
  }
  return (
    <>
      <h4>Costos transparentes</h4>
      <form className="bs-suite-form" onSubmit={save}>
        <label>Servicio (centavos)<input type="number" value={cfg.service_fee_cents} onChange={(e) => setCfg({ ...cfg, service_fee_cents: Number(e.target.value) })} /></label>
        <label>Comisión de pago (%)<input type="number" step="0.01" value={cfg.payment_fee_pct} onChange={(e) => setCfg({ ...cfg, payment_fee_pct: Number(e.target.value) })} /></label>
        <label>Impuesto (%)<input type="number" step="0.01" value={cfg.tax_pct} onChange={(e) => setCfg({ ...cfg, tax_pct: Number(e.target.value) })} /></label>
        <label className="bs-suite-check"><input type="checkbox" checked={cfg.show_breakdown} onChange={(e) => setCfg({ ...cfg, show_breakdown: e.target.checked })} /> Mostrar desglose al comprador</label>
        <button className="btn-mini" type="submit">Guardar</button>
      </form>
      <div className="bs-suite-card">
        <strong>Vista previa del comprador</strong>
        <select value={typeId} onChange={(e) => setTypeId(Number(e.target.value))}>
          {types?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        {preview && (
          <div className="bs-suite-breakdown">
            <p><span>Boleta</span><b>{money(preview.base_cents)}</b></p>
            <p><span>Servicio</span><b>{money(preview.service_fee_cents)}</b></p>
            <p><span>Pago</span><b>{money(preview.payment_fee_cents)}</b></p>
            <p><span>Impuesto</span><b>{money(preview.tax_cents)}</b></p>
            <p><span>Total</span><b>{money(preview.total_cents)}</b></p>
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

function RsvpSection({ venueId, eventId }) {
  const act = useAction();
  const [rows, setRows] = useState([]);
  const load = useCallback(async () => setRows(await act(() => listRsvps(venueId, eventId)) || []), [act, venueId, eventId]);
  useEffect(() => { load(); }, [load]);
  return (
    <>
      <h4>Registro gratuito</h4>
      <p className="bs-suite-note">Los asistentes confirman sin pasar por pago. Puedes pedir reconfirmación o liberar el lugar.</p>
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
      </div>
    </section>
  );
}
