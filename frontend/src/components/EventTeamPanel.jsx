import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
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
  const { user } = useAuth();
  const ui = useUI();
  const [rows, setRows] = useState(null); // null = cargando
  const [candidatos, setCandidatos] = useState([]);
  const [elegido, setElegido] = useState("");
  const [rolNuevo, setRolNuevo] = useState("bouncer");
  const [ocupado, setOcupado] = useState(false);
  const [emitiendo, setEmitiendo] = useState(false);
  // El último link emitido, en claro, SOLO en memoria de esta sesión.
  const [linkReciente, setLinkReciente] = useState(null);

  const cargar = useCallback(async () => {
    const data = await apiFetch(`/venues/${venueId}/events/${event.id}/staff`);
    setRows(data);
  }, [venueId, event.id]);

  useEffect(() => {
    cargar().catch((e) => ui.error(e.message));
  }, [cargar, ui]);

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
        body: JSON.stringify({ user_id: Number(elegido), role: rolNuevo }),
      });
      haptics.success();
      setElegido("");
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

  async function generarLink(uid) {
    setEmitiendo(uid);
    try {
      const r = await apiFetch(
        `/venues/${venueId}/events/${event.id}/staff/${uid}/link`,
        { method: "POST" },
      );
      haptics.success();
      setLinkReciente({ user_id: uid, ...r });
      onLinkSent?.(r);
    } catch (e) {
      ui.error(e.message);
    } finally {
      setEmitiendo(null);
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
            onLink={generarLink}
            onQuitar={quitar}
            emitiendo={emitiendo}
            ocupado={ocupado}
            linkReciente={linkReciente}
          />
          <Roster
            titulo="Venta"
            desc="Pueden emitir boletas de esta noche."
            icon="ticket"
            filas={venta}
            usados={usados}
            onLink={generarLink}
            onQuitar={quitar}
            emitiendo={emitiendo}
            ocupado={ocupado}
            linkReciente={linkReciente}
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
  onQuitar,
  emitiendo,
  ocupado,
  linkReciente,
}) {
  return (
    <div className="card p-4">
      <div className="flex items-center gap-2">
        <Icon name={icon} className="h-4 w-4 text-zinc-500" />
        <h3 className="display text-base">{titulo}</h3>
        <span className="tnum ml-auto text-xs text-zinc-500">
          {filas.length}
        </span>
      </div>
      <p className="mt-0.5 text-xs text-zinc-500">{desc}</p>
      <ul className="mt-3 space-y-2">
        {filas.map((p) => (
          <li
            key={p.id}
            className="flex items-center gap-2 rounded-lg bg-zinc-940 px-3 py-2"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-zinc-100">
                {p.full_name}
              </p>
              <p className="truncate text-2xs text-zinc-500">
                {usados.has(p.user_id) ? (
                  <span className="text-emerald-400">
                    Escáner activo: ya entró con su link
                  </span>
                ) : p.has_link ? (
                  <span className="text-emerald-400">
                    Link vigente —{" "}
                    {linkReciente?.user_id === p.user_id
                      ? "lo tienes en pantalla"
                      : "reenvíaselo si no lo abrió"}
                  </span>
                ) : (
                  "Sin link: no puede entrar a la puerta"
                )}
              </p>
            </div>
            <button
              onClick={() => onLink(p.user_id)}
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
              {usados.has(p.user_id) ? "Rotar" : p.has_link ? "Reenviar" : "Link"}
            </button>
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