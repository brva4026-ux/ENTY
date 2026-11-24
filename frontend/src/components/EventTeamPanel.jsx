import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { haptics } from "../lib/haptics";
import { useUI } from "../lib/ui";
import Icon from "./Icon";

/**
 * QUIÉN TRABAJA ESTA NOCHE + el link de su puerta.
 *
 * Por qué vive DENTRO del backstage y no en "Del negocio": el equipo del bar
 * es de la venue, pero "quién abre la puerta el viernes" es de esa noche.
 * Con el roster aca, cada evento tiene su propia gente y su propio link, y el
 * bouncer que abre /puerta?token=... entra directo a ESA noche sin elegir.
 *
 * El link se genera acá y se muestra UNA vez (el backend solo guarda el
 * SHA-256). Por eso el estado `linkReciente` vive en el componente: si el
 * admin recarga, tiene que pedir uno nuevo en vez de creer que lo tiene.
 */
export default function EventTeamPanel({ venueId, event, preflight, onLinkSent }) {
  const ui = useUI();
  const [rows, setRows] = useState(null); // null = cargando
  const [candidatos, setCandidatos] = useState([]);
  const [elegido, setElegido] = useState("");
  const [rolNuevo, setRolNuevo] = useState("bouncer");
  const [puestoNuevo, setPuestoNuevo] = useState("");
  const [tipoNuevo, setTipoNuevo] = useState("");
  // Turno (opcional): la ventana en que esa persona trabaja la noche. Sin
  // turno, el link vale para toda la noche. Con turno, el escáner se cierra
  // fuera de la ventana y quien queda en puerta a las 3 a.m. es el que estaba
  // asignado a esa hora, no cualquiera del bar.
  const [turnoInicio, setTurnoInicio] = useState("");
  const [turnoFin, setTurnoFin] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const [emitiendo, setEmitiendo] = useState(false);
  // El último link emitido, en claro, SOLO en memoria de esta sesión.
  const [linkReciente, setLinkReciente] = useState(null);
  // Puesto y teléfono con los que se emite el link. No se generan links
  // "sueltos": la autorización es de un teléfono y un acceso concretos.
  const [linkDraft, setLinkDraft] = useState(null);
  const [tipos, setTipos] = useState([]);
  const [relevos, setRelevos] = useState([]);
  const [relevoDraft, setRelevoDraft] = useState({});
  const [transferFor, setTransferFor] = useState(null);
  const [transferTo, setTransferTo] = useState("");
  const [transferPhone, setTransferPhone] = useState("");

  const cargar = useCallback(async () => {
    const data = await apiFetch(`/venues/${venueId}/events/${event.id}/staff`);
    setRows(data);
  }, [venueId, event.id]);

  useEffect(() => {
    cargar().catch((e) => ui.error(e.message));
  }, [cargar, ui]);

  const cargarRelevos = useCallback(async () => {
    try {
      const data = await apiFetch(
        `/venues/${venueId}/events/${event.id}/door-shift-requests`,
      );
      setRelevos(data);
    } catch {
      setRelevos([]);
    }
  }, [venueId, event.id]);

  useEffect(() => {
    cargarRelevos();
  }, [cargarRelevos]);

  useEffect(() => {
    apiFetch(`/venues/${venueId}/events/${event.id}/types`)
      .then((data) => setTipos((data || []).filter((t) => t.is_active !== false)))
      .catch(() => setTipos([]));
  }, [venueId, event.id]);

  // Candidatos: el equipo de la venue, para elegir a quién poner esta noche.
  // Se cargan una vez: son pocas personas y no cambian durante la noche.
  useEffect(() => {
    let vivo = true;
    apiFetch(`/venues/${venueId}/users?include_inactive=false`)
      .then((us) => {
        if (!vivo) return;
        const yaEnNoche = new Set((rows ?? []).map((r) => r.user_id));
        setCandidatos(us.filter((u) => u.is_active && !yaEnNoche.has(u.id)));
      })
      .catch(() => {});
    return () => {
      vivo = false;
    };
  }, [venueId, rows]);

  async function asignar() {
    if (!elegido) return;
    setOcupado(true);
    try {
      await apiFetch(`/venues/${venueId}/events/${event.id}/staff`, {
        method: "POST",
        // `datetime-local` da "2026-11-08T22:00" sin zona: se manda como
        // instante ISO (UTC) para que la DB lo guarde sin ambigüedad.
        body: JSON.stringify({
          user_id: Number(elegido),
          role: rolNuevo,
          shift_start: turnoInicio ? new Date(turnoInicio).toISOString() : null,
          shift_end: turnoFin ? new Date(turnoFin).toISOString() : null,
          door_name: puestoNuevo.trim() || null,
          door_ticket_type_id: tipoNuevo ? Number(tipoNuevo) : null,
        }),
      });
      haptics.success();
      setElegido("");
      setTurnoInicio("");
      setTurnoFin("");
      setPuestoNuevo("");
      setTipoNuevo("");
      await cargar();
      ui.success("Persona asignada a esta noche");
    } catch (e) {
      ui.error(e.message);
    } finally {
      setOcupado(false);
    }
  }

  async function quitar(userId, nombre) {
    setOcupado(true);
    try {
      await apiFetch(`/venues/${venueId}/events/${event.id}/staff/${userId}`, {
        method: "DELETE",
      });
      // Si le habíamos generado un link, ya no sirve: no-mostrarlo es el
      // comportamiento honesto (el backend tambien lo borro).
      setLinkReciente((l) => (l && l.user_id === userId ? null : l));
      await cargar();
      ui.success(`${nombre} ya no trabaja esta noche`);
    } catch (e) {
      ui.error(e.message);
    } finally {
      setOcupado(false);
    }
  }

  async function revocarLink(uid, nombre) {
    setOcupado(true);
    try {
      await apiFetch(
        `/venues/${venueId}/events/${event.id}/staff/${uid}/link`,
        { method: "DELETE" },
      );
      setLinkReciente((l) => (l && l.user_id === uid ? null : l));
      await cargar();
      ui.success(`Enlace de ${nombre} revocado`);
    } catch (e) {
      ui.error(e.message);
    } finally {
      setOcupado(false);
    }
  }

  function abrirLinkForm(persona) {
    setLinkDraft({
      user_id: persona.user_id,
      full_name: persona.full_name,
      door_name: persona.door_name || "",
      ticket_type_id: persona.door_ticket_type_id
        ? String(persona.door_ticket_type_id)
        : "",
      phone: persona.device_phone || persona.phone || "",
    });
  }

  async function generarLink() {
    if (!linkDraft) return;
    setEmitiendo(linkDraft.user_id);
    try {
      const r = await apiFetch(
        `/venues/${venueId}/events/${event.id}/staff/${linkDraft.user_id}/link`,
        {
          method: "POST",
          body: JSON.stringify({
            door_name: linkDraft.door_name.trim() || null,
            ticket_type_id: linkDraft.ticket_type_id
              ? Number(linkDraft.ticket_type_id)
              : null,
            phone: linkDraft.phone.trim() || null,
          }),
        },
      );
      haptics.success();
      setLinkReciente({ user_id: linkDraft.user_id, ...r });
      onLinkSent?.(r);
      setLinkDraft(null);
      await cargar();
    } catch (e) {
      ui.error(e.message);
    } finally {
      setEmitiendo(null);
    }
  }

  function abrirTransferencia(persona) {
    setTransferFor(persona);
    setTransferTo("");
    setTransferPhone(persona.device_phone || persona.phone || "");
  }

  async function transferirTelefono() {
    if (!transferFor?.device_id || !transferTo) {
      ui.error("Elegí el teléfono o la persona de reemplazo.");
      return;
    }
    setOcupado(true);
    try {
      const r = await apiFetch(
        `/venues/${venueId}/events/${event.id}/door-devices/${transferFor.device_id}/transfer`,
        {
          method: "POST",
          body: JSON.stringify({
            user_id: Number(transferTo),
            phone: transferPhone.trim() || null,
            note: "Transferencia directa desde Administración.",
          }),
        },
      );
      setLinkReciente({
        user_id: Number(transferTo),
        access_url: r.access_url,
        event_name: event.name,
        expires_at: new Date(Date.now() + 72 * 3600 * 1000).toISOString(),
      });
      setTransferFor(null);
      await Promise.all([cargar(), cargarRelevos()]);
      ui.success("Puesto transferido. El teléfono anterior quedó fuera.");
    } catch (e) {
      ui.error(e.message);
    } finally {
      setOcupado(false);
    }
  }

  async function aprobarRelevo(solicitud) {
    const draft = relevoDraft[solicitud.id] || {};
    if (!draft.user_id) {
      ui.error("Elegí a la persona de relevo.");
      return;
    }
    setOcupado(true);
    try {
      const r = await apiFetch(
        `/venues/${venueId}/events/${event.id}/door-shift-requests/${solicitud.id}/approve`,
        {
          method: "POST",
          body: JSON.stringify({
            user_id: Number(draft.user_id),
            phone: draft.phone || solicitud.requested_phone || null,
            note: "Relevo aprobado desde Administración.",
          }),
        },
      );
      setLinkReciente({
        user_id: Number(draft.user_id),
        access_url: r.access_url,
        event_name: event.name,
        expires_at: new Date(Date.now() + 72 * 3600 * 1000).toISOString(),
      });
      await Promise.all([cargar(), cargarRelevos()]);
      ui.success("Puesto relevado. El teléfono anterior quedó fuera.");
    } catch (e) {
      ui.error(e.message);
    } finally {
      setOcupado(false);
    }
  }

  async function rechazarRelevo(solicitud) {
    setOcupado(true);
    try {
      await apiFetch(
        `/venues/${venueId}/events/${event.id}/door-shift-requests/${solicitud.id}/reject`,
        { method: "POST", body: JSON.stringify({ note: "Rechazado por Administración." }) },
      );
      await cargarRelevos();
      ui.success("Solicitud rechazada.");
    } catch (e) {
      ui.error(e.message);
    } finally {
      setOcupado(false);
    }
  }

  const porRol = (rol) => (rows ?? []).filter((r) => r.role === rol);
  const puerta = porRol("bouncer");
  const venta = porRol("promotor");
  // Quién YA canjeó su link (escáner abierto): viene del preflight del padre.
  // `has_link` solo dice que hay token vigente; `link_used` dice que la
  // persona YA entró con él. Distinguirlos es la diferencia entre "te mandé
  // el link" y "ya está trabajando".
  const usados = new Set(
    (preflight?.door_staff ?? []).filter((s) => s.link_used).map((s) => s.user_id),
  );

  return (
    <div className="space-y-4">
      {/* ---------- El link que se acaba de emitir ---------- */}
      {linkReciente && (
        <div className="card border-emerald-800 bg-emerald-950/40 p-4">
          <p className="eyebrow">Link de puerta</p>
          <p className="mt-1 text-sm text-zinc-300">
            Envíale este link a{" "}
            <strong className="text-emerald-200">
              {(rows ?? []).find((r) => r.user_id === linkReciente.user_id)?.full_name ??
                "la persona"}
            </strong>
            . Al abrirlo entra{" "}
            <strong className="text-zinc-50">{linkReciente.event_name}</strong>{" "}
            directo: no tiene que elegir la noche.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg bg-black/40 px-3 py-2 text-xs text-emerald-200">
              {window.location.origin + linkReciente.access_url}
            </code>
            <button
              onClick={() => {
                navigator.clipboard?.writeText(
                  window.location.origin + linkReciente.access_url,
                );
                haptics.tick();
                ui.success("Link copiado");
              }}
              className="btn-mini shrink-0"
              data-variant="success"
            >
              <Icon name="copy" className="h-3.5 w-3.5" />
              Copiar
            </button>
            <button
              onClick={() => setLinkReciente(null)}
              className="btn-mini shrink-0"
            aria-label="Cerrar el link"
            >
              <Icon name="close" className="h-3.5 w-3.5" />
            </button>
          </div>
          <p className="mt-2 text-2xs text-zinc-500">
            Se muestra una sola vez y vence el{" "}
            {new Date(linkReciente.expires_at).toLocaleString("es-CO", {
              day: "numeric",
              month: "short",
              hour: "2-digit",
              minute: "2-digit",
            })}
            . Si lo perdes, generá uno nuevo.
          </p>
        </div>
      )}

      {/* ---------- Puesto y teléfono del link ---------- */}
      {linkDraft && (
        <div className="card p-4">
          <p className="eyebrow">Puesto de {linkDraft.full_name}</p>
          <p className="mt-0.5 text-xs text-zinc-500">
            Un link = una noche + un puesto + un teléfono. El puesto define qué
            tipo de boleta puede entrar y las cifras de aforo.
          </p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-2xs text-zinc-500">
              Nombre del acceso
              <input
                value={linkDraft.door_name}
                onChange={(e) => setLinkDraft({ ...linkDraft, door_name: e.target.value })}
                placeholder="Acceso VIP, General…"
                className="field"
                maxLength={60}
              />
            </label>
            <label className="flex flex-col gap-1 text-2xs text-zinc-500">
              Tipo de boleta
              <select
                value={linkDraft.ticket_type_id}
                onChange={(e) => setLinkDraft({ ...linkDraft, ticket_type_id: e.target.value })}
                className="field"
              >
                <option value="">Todas las boletas</option>
                {tipos.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-2xs text-zinc-500 sm:col-span-2">
              Teléfono autorizado
              <input
                value={linkDraft.phone}
                onChange={(e) => setLinkDraft({ ...linkDraft, phone: e.target.value })}
                placeholder="300 123 4567"
                className="field"
                inputMode="tel"
                maxLength={40}
              />
            </label>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={generarLink}
              disabled={emitiendo === linkDraft.user_id}
              className="btn-primary"
            >
              {emitiendo === linkDraft.user_id ? "Generando…" : "Generar link de puesto"}
            </button>
            <button type="button" onClick={() => setLinkDraft(null)} className="bs-secondary">
              Cancelar
            </button>
          </div>
        </div>
      )}

      {transferFor && (
        <div className="card p-4">
          <p className="eyebrow">Transferir {transferFor.door_name || "puesto"}</p>
          <p className="mt-0.5 text-xs text-zinc-500">
            El teléfono de {transferFor.full_name} deja de operar en el acto.
            La persona nueva recibe un link para abrir el puesto desde su teléfono.
          </p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-2xs text-zinc-500">
              Persona de reemplazo
              <select
                value={transferTo}
                onChange={(e) => setTransferTo(e.target.value)}
                className="field"
              >
                <option value="">Elegí a la persona…</option>
                {(rows ?? [])
                  .filter((p) => p.role === "bouncer" && p.user_id !== transferFor.user_id)
                  .map((p) => (
                    <option key={p.user_id} value={p.user_id}>{p.full_name}</option>
                  ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-2xs text-zinc-500">
              Teléfono autorizado
              <input
                value={transferPhone}
                onChange={(e) => setTransferPhone(e.target.value)}
                className="field"
                inputMode="tel"
                placeholder="300 123 4567"
              />
            </label>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className="btn-primary" disabled={ocupado || !transferTo} onClick={transferirTelefono}>
              Transferir puesto
            </button>
            <button type="button" className="bs-secondary" onClick={() => setTransferFor(null)}>
              Cancelar
            </button>
          </div>
        </div>
      )}

      {/* ---------- Asignar ---------- */}
      {candidatos.length > 0 && (
        <div className="card p-4">
          <p className="eyebrow">Sumar a esta noche</p>
          <p className="mt-0.5 text-xs text-zinc-500">
            Son del equipo del bar. Lo que definís acá es quién trabaja{" "}
            <strong className="text-zinc-300">esta</strong> noche.
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <select
              value={elegido}
              onChange={(e) => setElegido(e.target.value)}
              className="field flex-1"
            aria-label="Persona del equipo"
            >
              <option value="">Elegí a quién…</option>
              {candidatos.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.full_name}
                </option>
              ))}
            </select>
            {/* El rol del picker: "puerta" / "venta" en palabras del bar, no
                del enum. Quien elige no tiene que saber qué guarda la DB. */}
            <select
              value={rolNuevo}
              onChange={(e) => setRolNuevo(e.target.value)}
              className="field sm:w-40"
            aria-label="Rol en esta noche"
            >
              <option value="bouncer">Puerta</option>
              <option value="promotor">Venta</option>
            </select>
            <button
              onClick={asignar}
              disabled={!elegido || ocupado}
              className="btn-primary shrink-0"
            >
              Asignar
            </button>
          </div>
          {/* Turno opcional: si se define, la puerta de esa persona solo
              acepta escaneos dentro de la ventana. Dejarlo vacío = toda la
              noche. Es la respuesta a "el bouncer de las 22:00 no debería
              seguir abriendo a las 4:00". */}
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-2xs text-zinc-500">
              Turno desde (opcional)
              <input
                type="datetime-local"
                value={turnoInicio}
                onChange={(e) => setTurnoInicio(e.target.value)}
                className="field"
                aria-label="Inicio del turno"
              />
            </label>
            <label className="flex flex-col gap-1 text-2xs text-zinc-500">
              Turno hasta (opcional)
              <input
                type="datetime-local"
                value={turnoFin}
                onChange={(e) => setTurnoFin(e.target.value)}
                className="field"
                aria-label="Fin del turno"
              />
            </label>
          </div>
          {rolNuevo === "bouncer" && (
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-2xs text-zinc-500">
                Puesto de puerta
                <input
                  value={puestoNuevo}
                  onChange={(e) => setPuestoNuevo(e.target.value)}
                  placeholder="Acceso VIP, General…"
                  className="field"
                  maxLength={60}
                />
              </label>
              <label className="flex flex-col gap-1 text-2xs text-zinc-500">
                Tipo de boleta del puesto
                <select
                  value={tipoNuevo}
                  onChange={(e) => setTipoNuevo(e.target.value)}
                  className="field"
                >
                  <option value="">Todas las boletas</option>
                  {tipos.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </label>
            </div>
          )}
          {(turnoInicio || turnoFin) && (
            <p className="mt-1.5 text-2xs text-zinc-500">
              Fuera de esta ventana su escáner rechaza los ingresos.
            </p>
          )}
        </div>
      )}

      {/* ---------- Relevos pendientes ---------- */}
      {relevos.some((r) => r.status === "pending") && (
        <div className="card border-amber-800 bg-amber-950/30 p-4">
          <p className="eyebrow">Relevos pendientes</p>
          <p className="mt-0.5 text-xs text-zinc-400">
            Puerta pidió cambiar de teléfono o de persona. Aprobar revoca el
            teléfono anterior y emite un link nuevo al reemplazo.
          </p>
          <div className="mt-3 space-y-3">
            {relevos.filter((r) => r.status === "pending").map((r) => {
              const puerta = (rows ?? []).filter(
                (p) => p.role === "bouncer" && p.user_id !== r.requested_by,
              );
              const draft = relevoDraft[r.id] || {};
              return (
                <div key={r.id} className="rounded-lg bg-black/20 p-3">
                  <p className="text-sm font-semibold text-zinc-100">
                    {r.requested_by_name} · {r.door_name || "Puerta"}
                  </p>
                  <p className="text-xs text-zinc-400">{r.reason}</p>
                  {r.requested_phone && (
                    <p className="mt-1 text-2xs text-zinc-500">
                      Teléfono pedido: {r.requested_phone}
                    </p>
                  )}
                  <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                    <select
                      value={draft.user_id || ""}
                      onChange={(e) =>
                        setRelevoDraft({
                          ...relevoDraft,
                          [r.id]: { ...draft, user_id: e.target.value },
                        })
                      }
                      className="field flex-1"
                      aria-label="Persona de relevo"
                    >
                      <option value="">Elegí el relevo…</option>
                      {puerta.map((p) => (
                        <option key={p.user_id} value={p.user_id}>{p.full_name}</option>
                      ))}
                    </select>
                    <input
                      value={draft.phone || r.requested_phone || ""}
                      onChange={(e) =>
                        setRelevoDraft({
                          ...relevoDraft,
                          [r.id]: { ...draft, phone: e.target.value },
                        })
                      }
                      className="field sm:w-44"
                      placeholder="Teléfono"
                      aria-label="Teléfono del relevo"
                    />
                    <button
                      type="button"
                      className="btn-primary shrink-0"
                      disabled={ocupado}
                      onClick={() => aprobarRelevo(r)}
                    >
                      Aprobar
                    </button>
                    <button
                      type="button"
                      className="btn-mini shrink-0"
                      data-variant="danger"
                      disabled={ocupado}
                      onClick={() => rechazarRelevo(r)}
                    >
                      Rechazar
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ---------- El roster ---------- */}
      {rows === null ? (
        <div className="card p-4">
          <div className="skeleton h-4 w-32" />
          <div className="skeleton mt-3 h-11 w-full" />
        </div>
      ) : rows.length === 0 ? (
        <div className="card p-5 text-center">
          <p className="display text-base">Todavía no hay nadie</p>
          <p className="mt-1 text-sm text-zinc-500">
            Esta noche todavía no tiene puerta asignada. Sumá a quien va a
            escanear y generale su link.
          </p>
        </div>
      ) : (
        <>
          <Roster
            titulo="Puerta"
            desc="Escanean boletas. Cada uno con su link a esta noche."
            icon="door"
            filas={puerta}
            usados={usados}
            onLink={abrirLinkForm}
            onTransfer={abrirTransferencia}
            onRevoke={revocarLink}
            onQuitar={quitar}
            emitiendo={emitiendo}
            ocupado={ocupado}
            linkReciente={linkReciente}
            event={event}
          />
          <Roster
            titulo="Venta"
            desc="Pueden emitir boletas de esta noche."
            icon="ticket"
            filas={venta}
            usados={usados}
            onLink={abrirLinkForm}
            onTransfer={abrirTransferencia}
            onRevoke={revocarLink}
            onQuitar={quitar}
            emitiendo={emitiendo}
            ocupado={ocupado}
            linkReciente={linkReciente}
            event={event}
          />
        </>
      )}
    </div>
  );
}

function Roster({
  titulo,
  desc,
  icon,
  filas,
  usados,
  onLink,
  onTransfer,
  onRevoke,
  onQuitar,
  emitiendo,
  ocupado,
  linkReciente,
  event,
}) {
  const linkState = (p) => {
    if (p.device_status === "active") {
      return {
        label: "Teléfono activo",
        tone: "live",
        detail: `${p.door_name || "Puerta"}${p.device_phone ? ` · ${p.device_phone}` : ""}`,
      };
    }
    if (p.device_status === "revoked" || p.device_status === "replaced") {
      return {
        label: p.device_status === "replaced" ? "Relevado" : "Revocado",
        tone: "warn",
        detail: "El teléfono anterior ya no opera",
      };
    }
    if (usados.has(p.user_id) || p.link_used_at) {
      return { label: "Activado", tone: "live", detail: "Enlace canjeado · escáner activo" };
    }
    if (p.link_revoked_at) {
      return { label: "Revocado", tone: "warn", detail: "Enlace revocado" };
    }
    if (p.has_link && p.link_expires_at && new Date(p.link_expires_at) <= new Date()) {
      return {
        label: "Vencido",
        tone: "warn",
        detail: `Enlace vencido el ${new Date(p.link_expires_at).toLocaleDateString("es-CO")}`,
      };
    }
    if (p.has_link) {
      return {
        label: "Pendiente",
        tone: "pending",
        detail: `Vigente hasta ${
          p.link_expires_at
            ? new Date(p.link_expires_at).toLocaleString("es-CO", {
                day: "2-digit",
                month: "short",
                hour: "2-digit",
                minute: "2-digit",
              })
            : "—"
        }${linkReciente?.user_id === p.user_id ? " · lo tenés en pantalla" : ""}`,
      };
    }
    return {
      label: "Sin enlace",
      tone: "muted",
      detail: "Sin enlace: no puede entrar a la puerta",
    };
  };

  return (
    <div className="card p-4">
      <div className="flex items-center gap-2">
        <Icon name={icon} className="h-4 w-4 text-zinc-500" />
        <h3 className="display text-base">{titulo}</h3>
        <span className="tnum ml-auto text-xs text-zinc-500">
          {filas.length}
        </span>
      </div>
      <p className="mt-0.5 text-xs text-zinc-500">
        {desc}
        {event?.name ? ` · ${event.name}` : ""}
      </p>
      <ul className="mt-3 space-y-2">
        {filas.map((p) => (
          <li
            key={p.id}
            className="flex items-center gap-2 rounded-lg bg-zinc-940 px-3 py-2"
          >
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-zinc-100">
                <span className="truncate">{p.full_name}</span>
                {(() => {
                  const state = linkState(p);
                  return (
                    <span
                      className="bs-status"
                      data-status={state.tone === "live" ? "live" : undefined}
                      data-tone={state.tone}
                    >
                      <span className="bs-status-dot" aria-hidden="true" />
                      {state.label}
                    </span>
                  );
                })()}
              </p>
              <p className="truncate text-2xs text-zinc-500">
                {linkState(p).detail}
              </p>
            </div>
            <button
              onClick={() => onLink(p)}
              disabled={emitiendo === p.user_id || ocupado}
              className="btn-mini shrink-0"
              data-variant={p.has_link ? undefined : "brand"}
              aria-label={
                p.has_link
                  ? `Generar un link nuevo para ${p.full_name}`
                  : `Generar el link de puerta para ${p.full_name}`
              }
            >
              {emitiendo === p.user_id ? (
                <svg className="btn-spinner" viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="12" cy="12" r="9" />
                </svg>
              ) : (
                <Icon name="link" className="h-3.5 w-3.5" />
              )}
              {p.device_status === "active" ? "Rotar" : p.has_link ? "Reenviar" : "Link"}
            </button>
            {p.device_status === "active" && onTransfer && (
              <button
                onClick={() => onTransfer(p)}
                className="btn-mini shrink-0"
                aria-label={`Transferir el puesto de ${p.full_name}`}
              >
                Transferir
              </button>
            )}
            {(p.has_link || p.device_status === "active") && (
              <button
                onClick={() => onRevoke(p.user_id, p.full_name)}
                disabled={ocupado}
                className="btn-mini shrink-0"
                data-variant="danger"
                aria-label={`Revocar el enlace de ${p.full_name}`}
              >
                Revocar
              </button>
            )}
            <button
              onClick={() => onQuitar(p.user_id, p.full_name)}
              disabled={ocupado}
              className="btn-mini btn-icon shrink-0"
              data-variant="danger"
              aria-label={`Sacar a ${p.full_name} de esta noche`}
              data-tip="Sacar de esta noche"
            >
              <Icon name="trash" className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}