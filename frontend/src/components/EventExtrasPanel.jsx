import { useEffect, useState } from "react";
import {
  ackOpsOrder,
  changeTicket,
  createBooking,
  createBundle,
  createCourtesyRequest,
  createDocument,
  createEquipment,
  createMapPoint,
  createMilestone,
  createOpsOrder,
  createResale,
  createTransport,
  deleteMapPoint,
  deleteTransport,
  getForecast,
  listBookings,
  listCourtesyRequests,
  listDocuments,
  listEquipment,
  listMapPoints,
  listMilestones,
  listOpsOrders,
  listRecoveries,
  listResales,
  listShifts,
  listStaffCheckins,
  listTransport,
  resolveOpsOrder,
  reviewCourtesyRequest,
  sellResale,
  staffCheckin,
  staffCheckout,
  updateEquipment,
  updateMilestone,
  updateShift,
} from "../lib/api";
import { money } from "../lib/format";
import { useUI } from "../lib/ui";

const VIEWS = [
  { id: "transporte", label: "Transporte" },
  { id: "plano", label: "Plano" },
  { id: "turnos", label: "Turnos" },
  { id: "checkin", label: "Check-in" },
  { id: "ordens", label: "Órdenes" },
  { id: "equipos", label: "Equipos" },
  { id: "reservas", label: "Reservas" },
  { id: "hitos", label: "Hitos" },
  { id: "documentos", label: "Documentos" },
  { id: "cortesias", label: "Cortesías" },
  { id: "recoberi", label: "Compras" },
  { id: "reventa", label: "Reventa" },
  { id: "cambios", label: "Cámbios" },
  { id: "pronostico", label: "Pronóstico" },
  { id: "paquete", label: "Paquete" },
];

function useList(loader, deps) {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState("");
  async function reload() {
    try {
      setRows(await loader());
      setError("");
    } catch (err) {
      setError(err.message || "No pudimos leer los datos.");
    }
  }
  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { rows, setRows, error, reload };
}

function SectionHead({ title, hint }) {
  return (
    <div className="bs-box-office-head">
      <div><h2>{title}</h2><p>{hint}</p></div>
    </div>
  );
}

function TransportSection({ venueId, eventId }) {
  const ui = useUI();
  const { rows, error, reload } = useList(
    () => listTransport(venueId, eventId), [venueId, eventId],
  );
  const [form, setForm] = useState({ kind: "recogida", name: "", schedule: "" });
  async function add(e) {
    e.preventDefault();
    if (!form.name.trim()) return;
    try {
      await createTransport(venueId, eventId, {
        ...form, name: form.name.trim(), detail: null, map_url: null,
      });
      setForm({ kind: "recogida", name: "", schedule: "" });
      ui.toast("Punto de transporte agregado.", "success");
      reload();
    } catch (err) { ui.error(err.message); }
  }
  async function remove(id) {
    try { await deleteTransport(venueId, eventId, id); reload(); }
    catch (err) { ui.error(err.message); }
  }
  return (
    <section>
      <SectionHead title="Plan de transporte"
        hint="Puntos de recogida, parqueaderos y regreso. Se muestran en la ficha pública." />
      {error && <p className="admin-note" data-tone="warn">{error}</p>}
      <ul className="bs-suite-list">
        {rows.map((r) => (
          <li key={r.id}>
            <span><strong>{r.name}</strong><small>{r.kind} · {r.schedule || "sin horario"}</small></span>
            <button type="button" className="btn-mini" onClick={() => remove(r.id)}>Quitar</button>
          </li>
        ))}
        {!rows.length && <li className="bs-suite-empty">Todavía no hay puntos.</li>}
      </ul>
      <form className="bs-suite-form" onSubmit={add}>
        <select value={form.kind} onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value }))}>
          <option value="recogida">Recogida</option>
          <option value="parqueadero">Parqueadero</option>
          <option value="regreso">Regreso</option>
          <option value="otro">Otro</option>
        </select>
        <input placeholder="Nombre del punto" value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
        <input placeholder="Horario" value={form.schedule}
          onChange={(e) => setForm((f) => ({ ...f, schedule: e.target.value }))} />
        <button type="submit" className="btn-primary">Agregar</button>
      </form>
    </section>
  );
}

function MapSection({ venueId, eventId }) {
  const ui = useUI();
  const { rows, error, reload } = useList(
    () => listMapPoints(venueId, eventId), [venueId, eventId],
  );
  const [form, setForm] = useState({ kind: "encuentro", name: "", accessible: false });
  async function add(e) {
    e.preventDefault();
    if (!form.name.trim()) return;
    try {
      await createMapPoint(venueId, eventId, {
        ...form, name: form.name.trim(), description: null,
      });
      setForm({ kind: "encuentro", name: "", accessible: false });
      ui.toast("Punto del plano agregado.", "success");
      reload();
    } catch (err) { ui.error(err.message); }
  }
  async function remove(id) {
    try { await deleteMapPoint(venueId, eventId, id); reload(); }
    catch (err) { ui.error(err.message); }
  }
  return (
    <section>
      <SectionHead title="Plano y puntos de encuentro"
        hint="Baños, atención, punto de encuentro y accesibilidad. Se muestran en la ficha pública." />
      {error && <p className="admin-note" data-tone="warn">{error}</p>}
      <ul className="bs-suite-list">
        {rows.map((r) => (
          <li key={r.id}>
            <span><strong>{r.name}</strong><small>{r.kind}{r.accessible ? " · accesible" : ""}</small></span>
            <button type="button" className="btn-mini" onClick={() => remove(r.id)}>Quitar</button>
          </li>
        ))}
        {!rows.length && <li className="bs-suite-empty">Todavía no hay puntos.</li>}
      </ul>
      <form className="bs-suite-form" onSubmit={add}>
        <select value={form.kind} onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value }))}>
          <option value="encuentro">Punto de encuentro</option>
          <option value="baño">Baño</option>
          <option value="atencion">Atención</option>
          <option value="accesible">Accesible</option>
          <option value="salida">Salida</option>
          <option value="otro">Otro</option>
        </select>
        <input placeholder="Nombre" value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
        <label className="bs-suite-check">
          <input type="checkbox" checked={form.accessible}
            onChange={(e) => setForm((f) => ({ ...f, accessible: e.target.checked }))} />
          Accesible
        </label>
        <button type="submit" className="btn-primary">Agregar</button>
      </form>
    </section>
  );
}

function ShiftSection({ venueId, eventId }) {
  const ui = useUI();
  const { rows, error, reload } = useList(
    () => listShifts(venueId, eventId), [venueId, eventId],
  );
  async function save(person, patch) {
    try {
      await updateShift(venueId, eventId, person.user_id, {
        shift_start: person.shift_start,
        shift_end: person.shift_end,
        break_start: person.break_start,
        break_end: person.break_end,
        station: person.station,
        ...patch,
      });
      ui.toast("Turno actualizado.", "success");
      reload();
    } catch (err) { ui.error(err.message); }
  }
  return (
    <section>
      <SectionHead title="Plan de turnos"
        hint="Horario, descanso y puesto de cada persona. La cobertura se ve de un vistazo." />
      {error && <p className="admin-note" data-tone="warn">{error}</p>}
      <div className="bs-suite-table">
        {rows.map((p) => (
          <div className="bs-suite-row" key={p.user_id}>
            <div><strong>{p.full_name}</strong><small>{p.role} · {p.door_name || "sin puerta"}</small></div>
            <input type="datetime-local" value={(p.shift_start || "").slice(0, 16)}
              onChange={(e) => save(p, { shift_start: e.target.value || null })} />
            <input type="datetime-local" value={(p.shift_end || "").slice(0, 16)}
              onChange={(e) => save(p, { shift_end: e.target.value || null })} />
            <input placeholder="Puesto" value={p.station || ""}
              onBlur={(e) => save(p, { station: e.target.value || null })} />
          </div>
        ))}
        {!rows.length && <p className="bs-suite-empty">Asigna personal en Equipo.</p>}
      </div>
    </section>
  );
}

function CheckinSection({ venueId, eventId }) {
  const ui = useUI();
  const { rows, error, reload } = useList(
    () => listStaffCheckins(venueId, eventId), [venueId, eventId],
  );
  async function checkin() {
    try { await staffCheckin(venueId, eventId); ui.toast("Ingreso registrado.", "success"); reload(); }
    catch (err) { ui.error(err.message); }
  }
  async function checkout(id) {
    try { await staffCheckout(venueId, eventId, id); ui.toast("Salida registrada.", "success"); reload(); }
    catch (err) { ui.error(err.message); }
  }
  return (
    <section>
      <SectionHead title="Ingreso del personal"
        hint="Cada persona marca su entrada y salida. Administración ve quién está en el recinto." />
      {error && <p className="admin-note" data-tone="warn">{error}</p>}
      <button type="button" className="btn-primary" onClick={checkin}>Marcar mi ingreso</button>
      <ul className="bs-suite-list">
        {rows.map((c) => (
          <li key={c.id}>
            <span><strong>{c.full_name}</strong><small>{new Date(c.checked_in_at).toLocaleString("es-CO")}{c.checked_out_at ? " · salió" : " · adentro"}</small></span>
            {!c.checked_out_at && <button type="button" className="btn-mini" onClick={() => checkout(c.id)}>Salida</button>}
          </li>
        ))}
        {!rows.length && <li className="bs-suite-empty">Sin ingresos todavía.</li>}
      </ul>
    </section>
  );
}

function OrdersSection({ venueId, eventId }) {
  const ui = useUI();
  const { rows, error, reload } = useList(
    () => listOpsOrders(venueId, eventId), [venueId, eventId],
  );
  const [form, setForm] = useState({ message: "", target: "" });
  async function add(e) {
    e.preventDefault();
    if (!form.message.trim()) return;
    try {
      await createOpsOrder(venueId, eventId, form);
      setForm({ message: "", target: "" });
      ui.toast("Orden enviada.", "success");
      reload();
    } catch (err) { ui.error(err.message); }
  }
  async function ack(id) {
    try { await ackOpsOrder(venueId, eventId, id); reload(); }
    catch (err) { ui.error(err.message); }
  }
  async function resolve(id) {
    try { await resolveOpsOrder(venueId, eventId, id); reload(); }
    catch (err) { ui.error(err.message); }
  }
  return (
    <section>
      <SectionHead title="Bitácora de órdenes"
        hint="Una orden queda registrada y cada puesto confirma que la leyó." />
      {error && <p className="admin-note" data-tone="warn">{error}</p>}
      <ul className="bs-suite-list">
        {rows.map((o) => (
          <li key={o.id} className={o.resolved_at ? "is-done" : ""}>
            <span><strong>{o.message}</strong><small>{o.target || "Todos"} · {o.acks.length} confirmaciones{o.resolved_at ? " · resuelta" : ""}</small></span>
            <span className="bs-suite-actions">
              <button type="button" className="btn-mini" onClick={() => ack(o.id)}>Leída</button>
              {!o.resolved_at && <button type="button" className="btn-mini" onClick={() => resolve(o.id)}>Resolver</button>}
            </span>
          </li>
        ))}
        {!rows.length && <li className="bs-suite-empty">Sin órdenes.</li>}
      </ul>
      <form className="bs-suite-form" onSubmit={add}>
        <input placeholder="Orden para el equipo" value={form.message}
          onChange={(e) => setForm((f) => ({ ...f, message: e.target.value }))} />
        <input placeholder="Puesto destino (opcional)" value={form.target}
          onChange={(e) => setForm((f) => ({ ...f, target: e.target.value }))} />
        <button type="submit" className="btn-primary">Enviar</button>
      </form>
    </section>
  );
}

function EquipmentSection({ venueId, eventId }) {
  const ui = useUI();
  const { rows, error, reload } = useList(
    () => listEquipment(venueId, eventId), [venueId, eventId],
  );
  const [form, setForm] = useState({ item_name: "", serial: "" });
  async function add(e) {
    e.preventDefault();
    if (!form.item_name.trim()) return;
    try {
      await createEquipment(venueId, eventId, form);
      setForm({ item_name: "", serial: "" });
      ui.toast("Equipo entregado.", "success");
      reload();
    } catch (err) { ui.error(err.message); }
  }
  async function returnItem(id) {
    try { await updateEquipment(venueId, eventId, id, { status: "devuelto" }); reload(); }
    catch (err) { ui.error(err.message); }
  }
  return (
    <section>
      <SectionHead title="Equipos prestados"
        hint="Quién tiene cada radio, llave o equipo, y cuándo vuelve." />
      {error && <p className="admin-note" data-tone="warn">{error}</p>}
      <ul className="bs-suite-list">
        {rows.map((e) => (
          <li key={e.id} className={e.status === "devuelto" ? "is-done" : ""}>
            <span><strong>{e.item_name}</strong><small>{e.serial || "sin serial"} · {e.responsible_name || "sin responsable"} · {e.status}</small></span>
            {e.status !== "devuelto" && <button type="button" className="btn-mini" onClick={() => returnItem(e.id)}>Devuelto</button>}
          </li>
        ))}
        {!rows.length && <li className="bs-suite-empty">Sin equipos entregados.</li>}
      </ul>
      <form className="bs-suite-form" onSubmit={add}>
        <input placeholder="Equipo" value={form.item_name}
          onChange={(e) => setForm((f) => ({ ...f, item_name: e.target.value }))} />
        <input placeholder="Serial (opcional)" value={form.serial}
          onChange={(e) => setForm((f) => ({ ...f, serial: e.target.value }))} />
        <button type="submit" className="btn-primary">Entregar</button>
      </form>
    </section>
  );
}

function BookingSection({ venueId }) {
  const ui = useUI();
  const { rows, error, reload } = useList(() => listBookings(venueId), [venueId]);
  const [form, setForm] = useState({ title: "", starts_at: "", ends_at: "" });
  async function add(e) {
    e.preventDefault();
    if (!form.title.trim() || !form.starts_at || !form.ends_at) return;
    try {
      await createBooking(venueId, {
        ...form, title: form.title.trim(), status: "tentativa",
      });
      setForm({ title: "", starts_at: "", ends_at: "" });
      ui.toast("Reserva creada.", "success");
      reload();
    } catch (err) { ui.error(err.message); }
  }
  return (
    <section>
      <SectionHead title="Calendario de reservas"
        hint="Fechas tentativas, montaje y desmontaje. Enty avisa si se cruzan." />
      {error && <p className="admin-note" data-tone="warn">{error}</p>}
      <ul className="bs-suite-list">
        {rows.map((b) => (
          <li key={b.id}>
            <span><strong>{b.title}</strong><small>{new Date(b.starts_at).toLocaleDateString("es-CO")} → {new Date(b.ends_at).toLocaleDateString("es-CO")} · {b.status}{b.event_name ? ` · ${b.event_name}` : ""}</small></span>
          </li>
        ))}
        {!rows.length && <li className="bs-suite-empty">Sin reservas.</li>}
      </ul>
      <form className="bs-suite-form" onSubmit={add}>
        <input placeholder="Título" value={form.title}
          onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} />
        <input type="datetime-local" value={form.starts_at}
          onChange={(e) => setForm((f) => ({ ...f, starts_at: e.target.value }))} />
        <input type="datetime-local" value={form.ends_at}
          onChange={(e) => setForm((f) => ({ ...f, ends_at: e.target.value }))} />
        <button type="submit" className="btn-primary">Reservar</button>
      </form>
    </section>
  );
}

function MilestoneSection({ venueId, eventId }) {
  const ui = useUI();
  const { rows, error, reload } = useList(
    () => listMilestones(venueId, eventId), [venueId, eventId],
  );
  const [form, setForm] = useState({ title: "", due_date: "" });
  async function add(e) {
    e.preventDefault();
    if (!form.title.trim() || !form.due_date) return;
    try {
      await createMilestone(venueId, eventId, { ...form, status: "pendiente" });
      setForm({ title: "", due_date: "" });
      ui.toast("Hito agregado.", "success");
      reload();
    } catch (err) { ui.error(err.message); }
  }
  async function toggle(m) {
    try {
      await updateMilestone(venueId, eventId, m.id, {
        title: m.title, due_date: m.due_date,
        status: m.status === "hecho" ? "pendiente" : "hecho",
      });
      reload();
    } catch (err) { ui.error(err.message); }
  }
  return (
    <section>
      <SectionHead title="Hitos de producción"
        hint="Fechas límite con responsable y estado. Lo que falta se ve primero." />
      {error && <p className="admin-note" data-tone="warn">{error}</p>}
      <ul className="bs-suite-list">
        {rows.map((m) => (
          <li key={m.id} className={m.status === "hecho" ? "is-done" : ""}>
            <span><strong>{m.title}</strong><small>{m.due_date} · {m.owner_name || "sin responsable"} · {m.status}</small></span>
            <button type="button" className="btn-mini" onClick={() => toggle(m)}>
              {m.status === "hecho" ? "Reabrir" : "Hecho"}
            </button>
          </li>
        ))}
        {!rows.length && <li className="bs-suite-empty">Sin hitos.</li>}
      </ul>
      <form className="bs-suite-form" onSubmit={add}>
        <input placeholder="Hito" value={form.title}
          onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} />
        <input type="date" value={form.due_date}
          onChange={(e) => setForm((f) => ({ ...f, due_date: e.target.value }))} />
        <button type="submit" className="btn-primary">Agregar</button>
      </form>
    </section>
  );
}

function DocumentSection({ venueId, eventId }) {
  const ui = useUI();
  const { rows, error, reload } = useList(
    () => listDocuments(venueId, eventId), [venueId, eventId],
  );
  const [form, setForm] = useState({ title: "", url: "", version: "1" });
  async function add(e) {
    e.preventDefault();
    if (!form.title.trim() || !form.url.trim()) return;
    try {
      await createDocument(venueId, eventId, {
        ...form, title: form.title.trim(), url: form.url.trim(),
        access_role: "equipo",
      });
      setForm({ title: "", url: "", version: "1" });
      ui.toast("Documento agregado.", "success");
      reload();
    } catch (err) { ui.error(err.message); }
  }
  return (
    <section>
      <SectionHead title="Folder de documentación"
        hint="Rider, contratos, planos y permisos con versión y responsable." />
      {error && <p className="admin-note" data-tone="warn">{error}</p>}
      <ul className="bs-suite-list">
        {rows.map((d) => (
          <li key={d.id}>
            <span><strong>{d.title}</strong><small>v{d.version} · {d.access_role} · {d.owner_name || "sin responsable"}</small></span>
            <a className="btn-mini" href={d.url} target="_blank" rel="noreferrer">Abrir</a>
          </li>
        ))}
        {!rows.length && <li className="bs-suite-empty">Sin documentos.</li>}
      </ul>
      <form className="bs-suite-form" onSubmit={add}>
        <input placeholder="Título" value={form.title}
          onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} />
        <input placeholder="https://..." value={form.url}
          onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))} />
        <input placeholder="Versión" value={form.version}
          onChange={(e) => setForm((f) => ({ ...f, version: e.target.value }))} />
        <button type="submit" className="btn-primary">Agregar</button>
      </form>
    </section>
  );
}

function CourtesySection({ venueId, eventId, types }) {
  const ui = useUI();
  const { rows, error, reload } = useList(
    () => listCourtesyRequests(venueId, eventId), [venueId, eventId],
  );
  const [form, setForm] = useState({ quantity: "1", reason: "", ticket_type_id: "" });
  const [issued, setIssued] = useState([]);
  async function add(e) {
    e.preventDefault();
    try {
      await createCourtesyRequest(venueId, eventId, {
        quantity: Number(form.quantity) || 1,
        reason: form.reason,
        ticket_type_id: form.ticket_type_id ? Number(form.ticket_type_id) : null,
      });
      setForm({ quantity: "1", reason: "", ticket_type_id: "" });
      ui.toast("Solicitud enviada.", "success");
      reload();
    } catch (err) { ui.error(err.message); }
  }
  async function review(id, status) {
    try {
      const res = await reviewCourtesyRequest(venueId, eventId, id, { status });
      setIssued(res.tickets || []);
      ui.toast(
        status === "aprobada"
          ? `Cortesía aprobada. ${res.tickets?.length || 0} boleta(s) emitida(s).`
          : "Solicitud rechazada.",
        "success",
      );
      reload();
    } catch (err) { ui.error(err.message); }
  }
  return (
    <section>
      <SectionHead title="Cortesías con aprobación"
        hint="El equipo pide, Administración ve el cupo disponible y aprueba." />
      {error && <p className="admin-note" data-tone="warn">{error}</p>}
      <ul className="bs-suite-list">
        {rows.map((c) => (
          <li key={c.id}>
            <span>
              <strong>{c.quantity} × {c.type_name || "cortesía"}</strong>
              <small>{c.reason || "sin motivo"} · {c.requested_by_name} · cupo: {c.available ?? "—"} · {c.status}</small>
            </span>
            {c.status === "pendiente" && (
              <span className="bs-suite-actions">
                <button type="button" className="btn-mini" onClick={() => review(c.id, "aprobada")}>Aprobar</button>
                <button type="button" className="btn-mini" onClick={() => review(c.id, "rechazada")}>Rechazar</button>
              </span>
            )}
          </li>
        ))}
        {!rows.length && <li className="bs-suite-empty">Sin solicitudes.</li>}
      </ul>
      {issued.length > 0 && (
        <div className="bs-suite-result">
          <strong>Cortesías emitidas</strong>
          {issued.map((t) => (
            <p key={t.id}>
              Boleta #{t.id}{" "}
              <button type="button" className="btn-mini"
                onClick={() => navigator.clipboard?.writeText(t.raw_token)}>
                Copiar QR
              </button>
            </p>
          ))}
        </div>
      )}
      <form className="bs-suite-form" onSubmit={add}>
        <select value={form.ticket_type_id}
          onChange={(e) => setForm((f) => ({ ...f, ticket_type_id: e.target.value }))}>
          <option value="">Sin localidad</option>
          {(types || []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <input type="number" min="1" value={form.quantity}
          onChange={(e) => setForm((f) => ({ ...f, quantity: e.target.value }))} />
        <input placeholder="Motivo" value={form.reason}
          onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} />
        <button type="submit" className="btn-primary">Solicitar</button>
      </form>
    </section>
  );
}

function RecoverySection({ venueId, eventId }) {
  const { rows, error } = useList(
    () => listRecoveries(venueId, eventId), [venueId, eventId],
  );
  return (
    <section>
      <SectionHead title="Compras interrumpidas"
        hint="Personas que pidieron retomar su compra. Copia el enlace y envíalo por WhatsApp." />
      {error && <p className="admin-note" data-tone="warn">{error}</p>}
      <ul className="bs-suite-list">
        {rows.map((r) => (
          <li key={r.id}>
            <span><strong>{r.customer_name || "Sin nombre"} · {r.type_name || "localidad"}</strong><small>{r.customer_phone || r.customer_email || "sin contacto"} · {r.status}</small></span>
            <button type="button" className="btn-mini"
              onClick={() => navigator.clipboard?.writeText(`${window.location.origin}/evento/${eventId}?retomar=${r.token}`)}>
              Copiar enlace
            </button>
          </li>
        ))}
        {!rows.length && <li className="bs-suite-empty">Sin solicitudes.</li>}
      </ul>
    </section>
  );
}

function ResaleSection({ venueId, eventId }) {
  const ui = useUI();
  const { rows, error, reload } = useList(
    () => listResales(venueId, eventId), [venueId, eventId],
  );
  const [form, setForm] = useState({ ticket_id: "", price: "", seller_name: "" });
  const [buyer, setBuyer] = useState({ resale_id: "", buyer_name: "", buyer_phone: "" });
  async function add(e) {
    e.preventDefault();
    try {
      await createResale(venueId, eventId, {
        ticket_id: Number(form.ticket_id),
        price_cents: Math.round(Number(form.price) * 100),
        seller_name: form.seller_name || null,
      });
      setForm({ ticket_id: "", price: "", seller_name: "" });
      ui.toast("Boleta publicada para reventa.", "success");
      reload();
    } catch (err) { ui.error(err.message); }
  }
  async function sell(e) {
    e.preventDefault();
    try {
      const res = await sellResale(venueId, eventId, Number(buyer.resale_id), {
        buyer_name: buyer.buyer_name,
        buyer_phone: buyer.buyer_phone || null,
        payment_method: "efectivo",
      });
      setBuyer({ resale_id: "", buyer_name: "", buyer_phone: "" });
      ui.toast(`Reventa lista. Nueva boleta: ${res.new_ticket_id}`, "success");
      reload();
    } catch (err) { ui.error(err.message); }
  }
  return (
    <section>
      <SectionHead title="Reventa oficial"
        hint="Precio controlado: nunca por encima del original. Al vender, el QR viejo se anula." />
      {error && <p className="admin-note" data-tone="warn">{error}</p>}
      <ul className="bs-suite-list">
        {rows.map((r) => (
          <li key={r.id}>
            <span><strong>{r.type_name} · {money(r.price_cents)}</strong><small>{r.seller_name || r.original_name} · {r.status}{r.buyer_name ? ` · comprador: ${r.buyer_name}` : ""}</small></span>
            <span className="bs-suite-actions">
              {["publicada", "solicitada"].includes(r.status) && (
                <button type="button" className="btn-mini"
                  onClick={() => setBuyer({ resale_id: String(r.id), buyer_name: r.buyer_name || "", buyer_phone: r.buyer_phone || "" })}>
                  Vender
                </button>
              )}
            </span>
          </li>
        ))}
        {!rows.length && <li className="bs-suite-empty">Sin reventas.</li>}
      </ul>
      <form className="bs-suite-form" onSubmit={add}>
        <input placeholder="ID de boleta" value={form.ticket_id}
          onChange={(e) => setForm((f) => ({ ...f, ticket_id: e.target.value }))} />
        <input placeholder="Precio COP" type="number" value={form.price}
          onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))} />
        <input placeholder="Vendedor" value={form.seller_name}
          onChange={(e) => setForm((f) => ({ ...f, seller_name: e.target.value }))} />
        <button type="submit" className="btn-primary">Publicar</button>
      </form>
      {buyer.resale_id && (
        <form className="bs-suite-form" onSubmit={sell}>
          <input placeholder="Comprador" value={buyer.buyer_name}
            onChange={(e) => setBuyer((b) => ({ ...b, buyer_name: e.target.value }))} />
          <input placeholder="Teléfono" value={buyer.buyer_phone}
            onChange={(e) => setBuyer((b) => ({ ...b, buyer_phone: e.target.value }))} />
          <button type="submit" className="btn-primary">Confirmar venta</button>
        </form>
      )}
    </section>
  );
}

function ChangeSection({ venueId, eventId, types }) {
  const ui = useUI();
  const [form, setForm] = useState({ ticket_id: "", new_type_id: "", reason: "" });
  const [result, setResult] = useState(null);
  async function submit(e) {
    e.preventDefault();
    try {
      const res = await changeTicket(venueId, eventId, Number(form.ticket_id), {
        new_event_id: eventId,
        new_type_id: Number(form.new_type_id),
        reason: form.reason,
      });
      setResult(res);
      ui.toast("Cambio realizado. El QR anterior quedó anulado.", "success");
    } catch (err) { ui.error(err.message); }
  }
  return (
    <section>
      <SectionHead title="Cambio de función y upgrade"
        hint="Misma noche: mejora la localidad. Otra fecha: cambia la boleta. Se cobra o devuelve la diferencia." />
      <form className="bs-suite-form" onSubmit={submit}>
        <input placeholder="ID de boleta" value={form.ticket_id}
          onChange={(e) => setForm((f) => ({ ...f, ticket_id: e.target.value }))} />
        <select value={form.new_type_id}
          onChange={(e) => setForm((f) => ({ ...f, new_type_id: e.target.value }))}>
          <option value="">Nueva localidad</option>
          {(types || []).map((t) => <option key={t.id} value={t.id}>{t.name} · {money(t.price_cents)}</option>)}
        </select>
        <input placeholder="Motivo" value={form.reason}
          onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} />
        <button type="submit" className="btn-primary">Cambiar</button>
      </form>
      {result && (
        <div className="bs-suite-result">
          <strong>Cambio listo</strong>
          <p>Nueva boleta #{result.new_ticket_id} · {result.new_type_name} · {result.new_event_name}</p>
          <p>{result.amount_due_cents ? `Cobrar ${money(result.amount_due_cents)}` : "Sin cobro"}{result.refund_cents ? ` · Devolver ${money(result.refund_cents)}` : ""}</p>
          <code>{result.raw_token}</code>
        </div>
      )}
    </section>
  );
}

function ForecastSection({ venueId, eventId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    getForecast(venueId, eventId).then(setData).catch((e) => setError(e.message));
  }, [venueId, eventId]);
  return (
    <section>
      <SectionHead title="Pronóstico de demanda"
        hint="Ritmo actual contra eventos parecidos. No promete el futuro: dice qué esperar." />
      {error && <p className="admin-note" data-tone="warn">{error}</p>}
      {data && (
        <div className="bs-suite-kpis">
          <div><span>Vendidas</span><strong>{data.sold}/{data.capacity}</strong></div>
          <div><span>Proyección</span><strong>{data.projected_sold} ({data.projected_pct}%)</strong></div>
          <div><span>Ritmo diario</span><strong>{data.daily_pace}</strong></div>
          <div><span>Similares</span><strong>{data.comparable_avg_pct}%</strong></div>
        </div>
      )}
      {data && <p className="admin-note">{data.message}</p>}
      {data?.comparable_events?.length > 0 && (
        <ul className="bs-suite-list">
          {data.comparable_events.map((e) => (
            <li key={e.id}><span><strong>{e.name}</strong><small>{e.sold}/{e.capacity} · {e.sold_pct}%</small></span></li>
          ))}
        </ul>
      )}
    </section>
  );
}

function BundleSection({ venueId, eventId }) {
  const ui = useUI();
  const [form, setForm] = useState({ name: "", event_ids: "", price: "", quantity: "" });
  async function submit(e) {
    e.preventDefault();
    try {
      const res = await createBundle(venueId, eventId, {
        name: form.name,
        event_ids: form.event_ids.split(",").map((x) => Number(x.trim())).filter(Boolean),
        price_cents: Math.round(Number(form.price) * 100),
        quantity: Number(form.quantity),
      });
      ui.toast(`Paquete creado con ${res.events.length} eventos.`, "success");
      setForm({ name: "", event_ids: "", price: "", quantity: "" });
    } catch (err) { ui.error(err.message); }
  }
  return (
    <section>
      <SectionHead title="Paquete de varios eventos"
        hint="Vende un abono que emite una boleta por cada noche. Los eventos deben ser independientes." />
      <form className="bs-suite-form" onSubmit={submit}>
        <input placeholder="Nombre del paquete" value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
        <input placeholder="IDs de eventos separados por coma" value={form.event_ids}
          onChange={(e) => setForm((f) => ({ ...f, event_ids: e.target.value }))} />
        <input placeholder="Precio COP" type="number" value={form.price}
          onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))} />
        <input placeholder="Cupos" type="number" value={form.quantity}
          onChange={(e) => setForm((f) => ({ ...f, quantity: e.target.value }))} />
        <button type="submit" className="btn-primary">Crear paquete</button>
      </form>
    </section>
  );
}

export default function EventExtrasPanel({ venueId, eventId, types = [] }) {
  const [view, setView] = useState("transporte");
  const current = VIEWS.find((v) => v.id === view) || VIEWS[0];
  return (
    <div className="admin-panel-card bs-suite">
      <div className="bs-subnav-head">
        <div><h2>Operación y crecimiento</h2></div>
      </div>
      <div className="bs-subnav" role="tablist" aria-label="Secciones de operación">
        {VIEWS.map((v) => (
          <button key={v.id} type="button" role="tab" aria-selected={view === v.id}
            className="bs-subnav-tab" onClick={() => setView(v.id)}>
            {v.label}
          </button>
        ))}
      </div>
      <div className="bs-suite-body" role="tabpanel" aria-label={current.label}>
        {view === "transporte" && <TransportSection venueId={venueId} eventId={eventId} />}
        {view === "plano" && <MapSection venueId={venueId} eventId={eventId} />}
        {view === "turnos" && <ShiftSection venueId={venueId} eventId={eventId} />}
        {view === "checkin" && <CheckinSection venueId={venueId} eventId={eventId} />}
        {view === "ordens" && <OrdersSection venueId={venueId} eventId={eventId} />}
        {view === "equipos" && <EquipmentSection venueId={venueId} eventId={eventId} />}
        {view === "reservas" && <BookingSection venueId={venueId} />}
        {view === "hitos" && <MilestoneSection venueId={venueId} eventId={eventId} />}
        {view === "documentos" && <DocumentSection venueId={venueId} eventId={eventId} />}
        {view === "cortesias" && <CourtesySection venueId={venueId} eventId={eventId} types={types} />}
        {view === "recoberi" && <RecoverySection venueId={venueId} eventId={eventId} />}
        {view === "reventa" && <ResaleSection venueId={venueId} eventId={eventId} />}
        {view === "cambios" && <ChangeSection venueId={venueId} eventId={eventId} types={types} />}
        {view === "pronostico" && <ForecastSection venueId={venueId} eventId={eventId} />}
        {view === "paquete" && <BundleSection venueId={venueId} eventId={eventId} />}
      </div>
    </div>
  );
}
