/* Módulo Equipo — organización por función con métricas de productividad.
 *
 * Se alimenta de GET /users/stats (backend/app/routers/team.py): KPIs de
 * resumen, ventas contra cupo de promotores, escaneos de porteros y
 * actividad real de login (no una fecha decorativa).
 *
 * Estructura: buscador + resumen KPI + grupos por función (Promotores /
 * Puerta / Administración). Cada fila es desplegable con sus métricas y las
 * acciones de siempre (rol, reset, activar, quitar, purgar).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "../lib/api";
import { useUI } from "../lib/ui";

const fmtCOP = (cents) =>
  `$${(cents / 100).toLocaleString("es-CO", { maximumFractionDigits: 0 })}`;

function relTime(value) {
  if (!value) return "nunca ha entrado";
  const diff = Date.now() - new Date(value).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "ahora";
  if (mins < 60) return `hace ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `hace ${days} d`;
  return new Date(value).toLocaleDateString("es-CO", { day: "numeric", month: "short" });
}

const ROLE_LABEL = { promotor: "Promotor", bouncer: "Portero", admin: "Admin", super_admin: "Dueño" };

function GroupHeader({ label, hint, count }) {
  return (
    <div className="mt-5 mb-2 flex items-baseline gap-2 first:mt-0">
      <h4 className="text-xs font-bold uppercase tracking-wider text-zinc-500">{label}</h4>
      <span className="tnum text-[11px] text-zinc-600">
        {count} {hint}
      </span>
    </div>
  );
}

function Kpi({ label, value, accent }) {
  return (
    <div className="px-2 py-2 text-center">
      <p className="text-xs text-zinc-500">{label}</p>
      <p className={`tnum display mt-0.5 text-2xl ${accent || "text-white"}`}>{value}</p>
    </div>
  );
}

function MemberRow({ u, venueId, onChanged, menuFor, setMenuFor, resetFor, setResetFor }) {
  const ui = useUI();
  const [err, setErr] = useState("");
  const [newPass, setNewPass] = useState("");

  const isPromoter = u.roles.includes("promotor");
  const isBouncer = u.roles.includes("bouncer");
  const isAdmin = u.roles.includes("admin") || u.roles.includes("super_admin");

  async function patchUser(body, confirmSpec) {
    if (confirmSpec) {
      const ok = await ui.confirm(confirmSpec.title, {
        message: confirmSpec.message,
        danger: confirmSpec.danger,
        confirmLabel: confirmSpec.confirmLabel,
      });
      if (!ok) return;
    }
    setErr("");
    try {
      await apiFetch(`/venues/${venueId}/users/${u.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      setMenuFor(null);
      await onChanged();
    } catch (e2) {
      setErr(e2.message);
    }
  }

  async function removeUser() {
    const ok = await ui.confirm(`¿Quitar a ${u.full_name} de la venue?`, {
      message: "Perderá el acceso de inmediato.",
      danger: true,
      confirmLabel: "Quitar",
    });
    if (!ok) return;
    setErr("");
    try {
      await apiFetch(`/venues/${venueId}/users/${u.id}`, { method: "DELETE" });
      setMenuFor(null);
      await onChanged();
      ui.success(`${u.full_name} removido de la venue`);
    } catch (e2) {
      setErr(e2.message);
    }
  }

  async function purgeUser() {
    const confirm = await ui.prompt(`Eliminar definitivamente a ${u.full_name}`, {
      message: `Se borra su cuenta de la plataforma. Sus boletas emitidas conservan su nombre en el historial.\nEscribe su email (${u.email}) para confirmar:`,
      placeholder: u.email,
      danger: true,
      confirmLabel: "Eliminar definitivamente",
    });
    if (confirm === null) return;
    setErr("");
    try {
      await apiFetch(`/venues/${venueId}/users/${u.id}/purge`, {
        method: "DELETE",
        body: JSON.stringify({ confirm }),
      });
      setMenuFor(null);
      await onChanged();
    } catch (e2) {
      setErr(e2.message);
    }
  }

  async function resetPassword() {
    setErr("");
    try {
      await apiFetch(`/venues/${venueId}/users/${u.id}/reset-password`, {
        method: "POST",
        body: JSON.stringify({ new_password: newPass }),
      });
      setResetFor(null);
      setNewPass("");
      setMenuFor(null);
      ui.success(`Contraseña actualizada para ${u.full_name}. Comunícasela por un canal seguro.`);
    } catch (e2) {
      setErr(e2.message);
    }
  }

  const primaryRole = u.roles.find((r) => r !== "super_admin") || u.roles[0] || "promotor";

  return (
    <li className={`rounded-lg border border-zinc-800/60 bg-zinc-900/40 ${u.is_active === false ? "opacity-50" : ""}`}>
      <button
        onClick={() => setMenuFor(menuFor === u.id ? null : u.id)}
        className="w-full px-3 py-2.5 text-left"
        aria-expanded={menuFor === u.id}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <span className="font-semibold text-zinc-200">{u.full_name}</span>
            {u.is_active === false && (
              <span className="ml-2 rounded-full bg-red-950/60 px-2 py-0.5 text-[10px] font-bold uppercase text-red-300 ring-1 ring-red-800/60">
                inactivo
              </span>
            )}
            {/* Chip de actividad: la pregunta real es "¿esta persona entró?" */}
            <span
              className={`ml-2 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                u.last_login_at
                  ? "bg-zinc-800/80 text-zinc-400"
                  : "bg-amber-950/50 text-amber-400 ring-1 ring-amber-900/50"
              }`}
              title={u.last_login_at ? new Date(u.last_login_at).toLocaleString("es-CO") : "Sin accesos registrados"}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${u.last_login_at ? "bg-emerald-400" : "bg-amber-400"}`} />
              {relTime(u.last_login_at)}
            </span>
            <p className="truncate text-xs text-zinc-500">{u.email}</p>
          </div>

          {/* Métricas inline: lo que importa de un vistazo */}
          <div className="flex items-center gap-4">
            {isPromoter && u.quota && (u.quota.capacity > 0 || u.quota.issued > 0) && (
              <div className="text-right">
                <p className="tnum text-sm font-semibold text-zinc-200">
                  {u.quota.issued}
                  <span className="text-zinc-600">/{u.quota.capacity || "–"}</span>
                </p>
                <p className="text-[10px] uppercase tracking-wide text-zinc-600">vendidas</p>
              </div>
            )}
            {isBouncer && u.door && u.door.total > 0 && (
              <div className="text-right">
                <p className="tnum text-sm font-semibold text-zinc-200">{u.door.granted}</p>
                <p className="text-[10px] uppercase tracking-wide text-zinc-600">escaneos</p>
              </div>
            )}
            <span className="rounded-full bg-brand-500/15 px-2 py-0.5 text-[10px] font-bold uppercase text-brand-300 ring-1 ring-brand-500/30">
              {ROLE_LABEL[primaryRole] || primaryRole}
            </span>
            <span className="text-zinc-600">{menuFor === u.id ? "▴" : "▾"}</span>
          </div>
        </div>
      </button>

      {menuFor === u.id && (
        <div className="space-y-3 border-t border-zinc-800 px-3 pb-3 pt-2.5">
          {err && <p className="text-xs text-red-400">{err}</p>}

          {/* Panel de métricas del miembro */}
          {(isPromoter || isBouncer) && (
            <div className="rounded-lg border border-zinc-800/60 bg-zinc-950/40 p-3">
              {isPromoter && u.quota && (
                <div>
                  <div className="mb-1 flex items-baseline justify-between text-xs">
                    <span className="text-zinc-500">Cupo usado</span>
                    <span className="tnum text-zinc-300">
                      {u.quota.issued} de {u.quota.capacity || "—"} en {u.quota.allocations}{" "}
                      {u.quota.allocations === 1 ? "evento" : "eventos"}
                    </span>
                  </div>
                  <div className="meter">
                    <div
                      className="meter-fill"
                      style={{ width: `${u.quota.capacity ? Math.min((u.quota.issued / u.quota.capacity) * 100, 100) : 0}%` }}
                    />
                  </div>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-zinc-500">
                    <span className="tnum">
                      Canjeadas: <span className="text-zinc-300">{u.quota.redeemed}</span>
                    </span>
                    <span className="tnum">
                      Recaudo: <span className="text-zinc-300">{fmtCOP(u.quota.revenue_cents)}</span>
                    </span>
                  </div>
                </div>
              )}
              {isBouncer && u.door && (
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-zinc-500">
                  <span className="tnum">
                    Accesos concedidos: <span className="text-emerald-400">{u.door.granted}</span>
                  </span>
                  <span className="tnum">
                    Bloqueados: <span className="text-amber-400">{u.door.rejected}</span>
                  </span>
                  <span className="tnum">
                    Total escaneos: <span className="text-zinc-300">{u.door.total}</span>
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Acciones */}
          <div className="flex flex-wrap items-center gap-1.5">
            <select
              value={primaryRole}
              onChange={(e) =>
                patchUser(
                  { role: e.target.value },
                  {
                    title: `¿Cambiar el rol de ${u.full_name}?`,
                    message: `Pasa a ser ${e.target.value === "bouncer" ? "portero" : e.target.value} en esta venue.`,
                    confirmLabel: "Cambiar rol",
                  },
                )
              }
              className="field py-1 text-xs"
            >
              <option value="promotor">Rol: Promotor</option>
              <option value="bouncer">Rol: Portero</option>
              <option value="admin">Rol: Admin</option>
            </select>
            <button onClick={() => setResetFor(resetFor === u.id ? null : u.id)} className="btn-ghost text-xs font-bold">
              Reset contraseña
            </button>
            {u.is_active === false ? (
              <button onClick={() => patchUser({ is_active: true })} className="btn-ghost text-xs font-bold">
                Reactivar
              </button>
            ) : (
              <button
                onClick={() =>
                  patchUser(
                    { is_active: false },
                    {
                      title: `¿Desactivar a ${u.full_name}?`,
                      message: "No podrá iniciar sesión hasta que lo reactives.",
                      danger: true,
                      confirmLabel: "Desactivar",
                    },
                  )
                }
                className="btn-ghost text-xs font-bold text-amber-400"
              >
                Desactivar
              </button>
            )}
            <button onClick={removeUser} className="btn-ghost text-xs font-bold text-red-400">
              Quitar de la venue
            </button>
            <button
              onClick={purgeUser}
              className="btn-ghost text-xs font-bold text-red-500 underline decoration-red-500/40"
            >
              Eliminar definitivamente
            </button>
          </div>

          {resetFor === u.id && (
            <div className="flex gap-1.5">
              <input
                value={newPass}
                onChange={(e) => setNewPass(e.target.value)}
                className="field py-1 text-xs"
                type="password"
                placeholder="Nueva contraseña (mín. 8)"
                minLength={8}
              />
              <button
                onClick={resetPassword}
                disabled={newPass.length < 8}
                className="btn-primary px-3 py-1 text-xs font-bold disabled:opacity-40"
              >
                Guardar
              </button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

export default function TeamManager({ venueId, users, onChanged }) {
  const ui = useUI();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ full_name: "", email: "", password: "", role: "promotor" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [stats, setStats] = useState(null);

  const [menuFor, setMenuFor] = useState(null);
  const [resetFor, setResetFor] = useState(null);

  const loadStats = useCallback(() => {
    apiFetch(`/venues/${venueId}/users/stats`)
      .then(setStats)
      .catch(() => {});
  }, [venueId]);

  // Carga inicial + recarga cuando el equipo cambia (alta/baja/edición:
  // `onChanged` actualiza `users` en el padre y dispara este efecto).
  useEffect(() => {
    loadStats();
  }, [loadStats, users]);

  async function createUser(e) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      await apiFetch(`/venues/${venueId}/users`, {
        method: "POST",
        body: JSON.stringify(form),
      });
      await onChanged();
      setForm({ full_name: "", email: "", password: "", role: "promotor" });
      setOpen(false);
      ui.success(`${form.full_name} agregado al equipo`);
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusy(false);
    }
  }

  // Filtrado instantáneo por nombre/email/rol sobre el detalle de stats.
  const filtered = useMemo(() => {
    const members = stats?.members || [];
    const q = query.trim().toLowerCase();
    if (!q) return members;
    return members.filter(
      (m) =>
        m.full_name.toLowerCase().includes(q) ||
        m.email.toLowerCase().includes(q) ||
        m.roles.some((r) => r.includes(q)),
    );
  }, [stats, query]);

  const promoters = filtered.filter((m) => m.roles.includes("promotor"));
  const bouncers = filtered.filter((m) => m.roles.includes("bouncer") && !m.roles.includes("promotor"));
  const admins = filtered.filter(
    (m) => (m.roles.includes("admin") || m.roles.includes("super_admin")) && !m.roles.includes("promotor") && !m.roles.includes("bouncer"),
  );

  return (
    <div className="space-y-4">
      {/* Resumen ejecutivo */}
      {stats && (
        <div className="card">
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-zinc-800/80 px-5 py-4">
            <div>
              <p className="eyebrow">Resumen del equipo</p>
              <h3 className="display mt-0.5 text-lg">Quién hace qué — y qué tan bien</h3>
            </div>
            <p className="text-xs text-zinc-500">Últimos {stats.days_window} días</p>
          </div>
          <div className="grid grid-cols-2 divide-zinc-800/80 sm:grid-cols-4 sm:divide-x">
            <Kpi label="Miembros activos" value={`${stats.active_members}/${stats.total_members}`} />
            <Kpi label="Promotores" value={stats.promoters_active} />
            <Kpi label="Porteros" value={stats.bouncers_active} />
            <Kpi
              label="Entraron a trabajar"
              value={stats.active_in_window}
              accent={stats.active_in_window === 0 ? "text-amber-400" : "text-emerald-400"}
            />
          </div>
        </div>
      )}

      {/* Buscador */}
      <div className="relative">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="field pl-9"
          placeholder="Buscar por nombre, correo o rol…"
          aria-label="Buscar miembro del equipo"
        />
        <svg className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
      </div>

      {/* Grupos por función */}
      <div className="card p-5">
        {filtered.length === 0 ? (
          <p className="rounded-lg border border-zinc-800/60 bg-zinc-900/40 px-3 py-6 text-center text-sm text-zinc-500">
            {query ? "Nadie coincide con la búsqueda." : "Sin usuarios todavía — agrega a tu equipo abajo."}
          </p>
        ) : (
          <>
            {promoters.length > 0 && (
              <>
                <GroupHeader label="Promotores" hint="venden cortesías por cupo" count={promoters.length} />
                <ul className="space-y-2">
                  {promoters.map((m) => (
                    <MemberRow
                      key={m.id}
                      u={m}
                      venueId={venueId}
                      onChanged={onChanged}
                      menuFor={menuFor}
                      setMenuFor={setMenuFor}
                      resetFor={resetFor}
                      setResetFor={setResetFor}
                    />
                  ))}
                </ul>
              </>
            )}
            {bouncers.length > 0 && (
              <>
                <GroupHeader label="Puerta" hint="escanean y validan boletas" count={bouncers.length} />
                <ul className="space-y-2">
                  {bouncers.map((m) => (
                    <MemberRow
                      key={m.id}
                      u={m}
                      venueId={venueId}
                      onChanged={onChanged}
                      menuFor={menuFor}
                      setMenuFor={setMenuFor}
                      resetFor={resetFor}
                      setResetFor={setResetFor}
                    />
                  ))}
                </ul>
              </>
            )}
            {admins.length > 0 && (
              <>
                <GroupHeader label="Administración" hint="gestionan eventos y caja" count={admins.length} />
                <ul className="space-y-2">
                  {admins.map((m) => (
                    <MemberRow
                      key={m.id}
                      u={m}
                      venueId={venueId}
                      onChanged={onChanged}
                      menuFor={menuFor}
                      setMenuFor={setMenuFor}
                      resetFor={resetFor}
                      setResetFor={setResetFor}
                    />
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </div>

      {/* Alta de personal */}
      <div className="card p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="eyebrow">Personal</p>
            <h3 className="display mt-0.5 text-base">Agregar al equipo</h3>
          </div>
          <button onClick={() => setOpen((v) => !v)} className="btn-ghost text-xs font-bold">
            {open ? "Cerrar" : "+ Agregar"}
          </button>
        </div>
        {err && <p className="mt-2 text-xs text-red-400">{err}</p>}
        {open && (
          <form onSubmit={createUser} className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <input
              value={form.full_name}
              onChange={(e) => setForm({ ...form, full_name: e.target.value })}
              className="field"
              placeholder="Nombre completo"
              required
            />
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} className="field">
              <option value="promotor">Promotor</option>
              <option value="bouncer">Portero (puerta)</option>
              <option value="admin">Admin</option>
            </select>
            <input
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              className="field"
              type="email"
              placeholder="correo@ejemplo.com"
              required
            />
            <input
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              className="field"
              type="password"
              placeholder="Contraseña (mín. 8)"
              minLength={8}
              required
            />
            <button disabled={busy} className="btn-primary col-span-full">
              {busy ? "Creando…" : "Crear usuario"}
            </button>
            <p className="col-span-full text-xs text-zinc-500">
              Si el correo ya existe, solo se le agrega el rol en esta venue.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
