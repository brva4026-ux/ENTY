/* Módulo Equipo — administración de accesos con identidad visual por rol.
 *
 * Patrones tomados de los proyectos de referencia del dueño:
 * - distri-stream: pestañas por rol con icono + contador (Clientes/Revendedores/Administradores)
 * - unicall-blue: avatar con iniciales, chip de estado y acciones de icono por fila
 *
 * Adaptado a la identidad V-Pass (dark, sobrio, motion con reduced-motion).
 * Los datos siguen viniendo de GET /users/stats: iconos sí, decoración no.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "../lib/api";
import { ROLE_VISUALS } from "../lib/roles";
import { useUI } from "../lib/ui";
import { missingList } from "../lib/passwordPolicy";
import PasswordMeter from "./PasswordMeter";

const fmtCOP = (cents) =>
  `$${(cents / 100).toLocaleString("es-CO", { maximumFractionDigits: 0 })}`;

/* ---------------------------------------------------------------------------
 * Iconografía: cada icono significa una acción, no decora.
 * ------------------------------------------------------------------------ */
const ico = "h-4 w-4 shrink-0";

function IconRole({ role, className = ico }) {
  if (role === "bouncer")
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        className={className}
        aria-hidden
      >
        <path d="M12 3 5 6v5c0 4.4 3 8.4 7 10 4-1.6 7-5.6 7-10V6l-7-3Z" />
      </svg>
    );
  if (role === "admin" || role === "super_admin")
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        className={className}
        aria-hidden
      >
        <path d="M16 10l-4 4-4-4" />
        <circle cx="12" cy="12" r="9" />
      </svg>
    );
  /* promotor: boletos */
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className={className}
      aria-hidden
    >
      <path d="M3 9a2 2 0 0 0 0 6v3a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-3a2 2 0 0 1 0-6V6a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v3Z" />
      <path d="M14 5v2M14 11v2M14 17v2" strokeDasharray="2 2" />
    </svg>
  );
}

function IconKey({ className = ico }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className={className}
      aria-hidden
    >
      <circle cx="8" cy="15" r="4" />
      <path d="m11 12 9-9M17 5l2 2M14 8l2 2" />
    </svg>
  );
}
function IconBan({ className = ico }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className={className}
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M5.6 5.6l12.8 12.8" />
    </svg>
  );
}
function IconCheck({ className = ico }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className={className}
      aria-hidden
    >
      <path d="m4 12.5 5 5L20 6.5" />
    </svg>
  );
}
function IconDoorOut({ className = ico }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className={className}
      aria-hidden
    >
      <path d="M14 4h5v16h-5M10 8l-4 4 4 4M6 12h10" />
    </svg>
  );
}
function IconTrash({ className = ico }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className={className}
      aria-hidden
    >
      <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" />
    </svg>
  );
}
function IconSwap({ className = ico }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className={className}
      aria-hidden
    >
      <path d="M4 8h13l-3-3M20 16H7l3 3" />
    </svg>
  );
}
function IconSearch({ className = ico }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className={className}
      aria-hidden
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}
function IconPlus({ className = ico }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      className={className}
      aria-hidden
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

/* ---------------------------------------------------------------------------
 * Identidad por rol: color (ROLE_VISUALS, fuente única) + etiqueta de equipo.
 * ------------------------------------------------------------------------ */
const ROLE_TEXT = {
  promotor: {
    label: "Promotor",
    plural: "Promotores",
    hint: "venden boletas y cortesías",
  },
  bouncer: {
    label: "Portero",
    plural: "Puerta",
    hint: "escanean y validan en puerta",
  },
  admin: {
    label: "Admin",
    plural: "Administración",
    hint: "gestionan eventos, caja y equipo",
  },
};

const ROLE_META = Object.fromEntries(
  Object.entries(ROLE_TEXT).map(([role, text]) => [
    role,
    { ...text, ...ROLE_VISUALS[role] },
  ]),
);

function primaryRoleOf(m) {
  if (m.roles.includes("promotor")) return "promotor";
  if (m.roles.includes("bouncer")) return "bouncer";
  if (m.roles.includes("admin")) return "admin";
  if (m.roles.includes("super_admin")) return "admin";
  return "promotor";
}

function initials(name) {
  return (name || "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");
}

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
  return new Date(value).toLocaleDateString("es-CO", {
    day: "numeric",
    month: "short",
  });
}

/* ---------------------------------------------------------------------------
 * Fila de persona: avatar, identidad, métricas y acciones de icono.
 * ------------------------------------------------------------------------ */
function MemberRow({
  m,
  venueId,
  onChanged,
  openId,
  setOpenId,
  resetId,
  setResetId,
}) {
  const ui = useUI();
  const [err, setErr] = useState("");
  const [newPass, setNewPass] = useState("");
  const [busyAction, setBusyAction] = useState("");

  const meta = ROLE_META[primaryRoleOf(m)];
  const isOpen = openId === m.id;

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
    setBusyAction("patch");
    try {
      await apiFetch(`/venues/${venueId}/users/${m.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      setOpenId(null);
      await onChanged();
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusyAction("");
    }
  }

  async function removeUser() {
    const ok = await ui.confirm(`¿Quitar a ${m.full_name} de la venue?`, {
      message: "Perderá el acceso de inmediato.",
      danger: true,
      confirmLabel: "Quitar",
    });
    if (!ok) return;
    setErr("");
    setBusyAction("remove");
    try {
      await apiFetch(`/venues/${venueId}/users/${m.id}`, { method: "DELETE" });
      setOpenId(null);
      await onChanged();
      ui.success(`${m.full_name} removido de la venue`);
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusyAction("");
    }
  }

  async function purgeUser() {
    const confirm = await ui.prompt(
      `Eliminar definitivamente a ${m.full_name}`,
      {
        message: `Se borra su cuenta de la plataforma. Sus boletas emitidas conservan su nombre en el historial.\nEscribe su email (${m.email}) para confirmar:`,
        placeholder: m.email,
        danger: true,
        confirmLabel: "Eliminar definitivamente",
      },
    );
    if (confirm === null) return;
    setErr("");
    setBusyAction("purge");
    try {
      await apiFetch(`/venues/${venueId}/users/${m.id}/purge`, {
        method: "DELETE",
        body: JSON.stringify({ confirm }),
      });
      setOpenId(null);
      await onChanged();
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusyAction("");
    }
  }

  async function resetPassword() {
    setErr("");
    // Misma política que el backend: el admin no descubre el 422 a ciegas.
    const missing = missingList(newPass);
    if (missing.length > 0) {
      setErr(`Le falta a la contraseña: ${missing.join(", ")}.`);
      return;
    }
    setBusyAction("reset");
    try {
      await apiFetch(`/venues/${venueId}/users/${m.id}/reset-password`, {
        method: "POST",
        body: JSON.stringify({ new_password: newPass }),
      });
      setResetId(null);
      setNewPass("");
      setOpenId(null);
      ui.success(
        `Contraseña actualizada para ${m.full_name}. Comunícasela por un canal seguro.`,
      );
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusyAction("");
    }
  }

  const isPromoter = m.roles.includes("promotor");
  const isBouncer = m.roles.includes("bouncer");
  const showMetrics =
    (isPromoter && m.quota && (m.quota.capacity > 0 || m.quota.issued > 0)) ||
    (isBouncer && m.door && m.door.total > 0);

  /* Acciones de icono (patrón unicall-blue): cada una con tooltip claro. */
  const actions = [
    {
      key: "reset",
      label: `Reset contraseña de ${m.full_name}`,
      icon: <IconKey />,
      cls: "text-zinc-400 hover:text-brand-300 hover:bg-brand-500/10",
      onClick: () => setResetId(resetId === m.id ? null : m.id),
    },
    m.is_active === false
      ? {
          key: "activate",
          label: `Reactivar a ${m.full_name}`,
          icon: <IconCheck />,
          cls: "text-zinc-400 hover:text-emerald-300 hover:bg-emerald-500/10",
          onClick: () => patchUser({ is_active: true }),
        }
      : {
          key: "deactivate",
          label: `Desactivar a ${m.full_name}`,
          icon: <IconBan />,
          cls: "text-zinc-400 hover:text-amber-300 hover:bg-amber-500/10",
          onClick: () =>
            patchUser(
              { is_active: false },
              {
                title: `¿Desactivar a ${m.full_name}?`,
                message: "No podrá iniciar sesión hasta que lo reactives.",
                danger: true,
                confirmLabel: "Desactivar",
              },
            ),
        },
    {
      key: "remove",
      label: `Quitar a ${m.full_name} de la venue`,
      icon: <IconDoorOut />,
      cls: "text-zinc-400 hover:text-orange-300 hover:bg-orange-500/10",
      onClick: removeUser,
    },
    {
      key: "purge",
      label: `Eliminar definitivamente a ${m.full_name}`,
      icon: <IconTrash />,
      cls: "text-zinc-500 hover:text-red-400 hover:bg-red-500/10",
      onClick: purgeUser,
    },
  ];

  return (
    <li
      className={`rounded-xl border transition-colors ${isOpen ? "border-zinc-700 bg-zinc-900/70" : "border-zinc-800/60 bg-zinc-900/40"} ${m.is_active === false ? "opacity-60" : ""}`}
    >
      <div className="flex items-center gap-3 px-3 py-2.5">
        {/* Avatar con iniciales + anillo del rol (patrón unicall-blue) */}
        <button
          onClick={() => setOpenId(isOpen ? null : m.id)}
          className={`grid h-9 w-9 shrink-0 place-items-center rounded-full text-xs font-bold ring-1 ${meta.avatar}`}
          aria-label={
            isOpen
              ? `Ocultar detalles de ${m.full_name}`
              : `Ver detalles de ${m.full_name}`
          }
          aria-expanded={isOpen}
        >
          {initials(m.full_name)}
        </button>

        <button
          onClick={() => setOpenId(isOpen ? null : m.id)}
          className="min-w-0 flex-1 text-left"
        >
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="truncate font-semibold text-zinc-200">
              {m.full_name}
            </span>
            {/* Chip de estado con icono (patrón unicall-blue "Registrado") */}
            <span
              className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-2xs font-bold uppercase tracking-wide ring-1 ${
                m.is_active === false
                  ? "bg-zinc-800/80 text-zinc-500 ring-zinc-700"
                  : "bg-emerald-950/50 text-emerald-400 ring-emerald-900/60"
              }`}
            >
              {m.is_active === false ? (
                <IconBan className="h-2.5 w-2.5" />
              ) : (
                <IconCheck className="h-2.5 w-2.5" />
              )}
              {m.is_active === false ? "inactivo" : "activo"}
            </span>
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-bold uppercase ring-1 ${meta.chip}`}
            >
              <IconRole role={primaryRoleOf(m)} className="h-3 w-3" />
              {meta.label}
            </span>
          </div>
          <p className="truncate text-xs text-zinc-500">
            {m.email}
            <span className="mx-1.5 text-zinc-700">·</span>
            <span
              className={
                m.last_login_at ? "text-zinc-400" : "text-amber-500/90"
              }
            >
              {relTime(m.last_login_at)}
            </span>
          </p>
        </button>

        {/* Métricas productivas inline */}
        {showMetrics && (
          <div className="hidden shrink-0 text-right sm:block">
            {isPromoter &&
              m.quota &&
              (m.quota.capacity > 0 || m.quota.issued > 0) && (
                <>
                  <p className="tnum text-sm font-semibold text-zinc-200">
                    {m.quota.issued}
                    <span className="text-zinc-600">
                      /{m.quota.capacity || "–"}
                    </span>
                  </p>
                  <p className="text-2xs uppercase tracking-wide text-zinc-600">
                    vendidas
                  </p>
                </>
              )}
            {isBouncer && m.door && m.door.total > 0 && (
              <>
                <p className="tnum text-sm font-semibold text-zinc-200">
                  {m.door.granted}
                </p>
                <p className="text-2xs uppercase tracking-wide text-zinc-600">
                  escaneos
                </p>
              </>
            )}
          </div>
        )}

        {/* Acciones de icono, siempre visibles (patrón unicall-blue) */}
        <div className="flex shrink-0 items-center gap-0.5">
          {actions.map((a) => (
            <button
              key={a.key}
              onClick={a.onClick}
              disabled={busyAction === a.key}
              data-tip={a.label}
              aria-label={a.label}
              className={`rounded-md p-1.5 transition-colors disabled:opacity-40 ${a.cls}`}
            >
              {a.icon}
            </button>
          ))}
        </div>
      </div>

      {isOpen && (
        <div className="space-y-3 border-t border-zinc-800 px-3 pb-3 pt-2.5">
          {err && <p className="text-xs text-red-400">{err}</p>}

          {/* Panel de métricas productivas */}
          {(isPromoter || isBouncer) && (
            <div className="rounded-lg border border-zinc-800/60 bg-zinc-950/40 p-3">
              {isPromoter && m.quota && (
                <div>
                  <div className="mb-1 flex items-baseline justify-between text-xs">
                    <span className="text-zinc-500">Cupo usado</span>
                    <span className="tnum text-zinc-300">
                      {m.quota.issued} de {m.quota.capacity || "—"} en{" "}
                      {m.quota.allocations}{" "}
                      {m.quota.allocations === 1 ? "evento" : "eventos"}
                    </span>
                  </div>
                  <div className="meter">
                    <div
                      className="meter-fill"
                      style={{
                        width: `${m.quota.capacity ? Math.min((m.quota.issued / m.quota.capacity) * 100, 100) : 0}%`,
                      }}
                    />
                  </div>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-2xs text-zinc-500">
                    <span className="tnum">
                      Canjeadas:{" "}
                      <span className="text-zinc-300">{m.quota.redeemed}</span>
                    </span>
                    <span className="tnum">
                      Recaudo:{" "}
                      <span className="text-zinc-300">
                        {fmtCOP(m.quota.revenue_cents)}
                      </span>
                    </span>
                  </div>
                </div>
              )}
              {isBouncer && m.door && (
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-2xs text-zinc-500">
                  <span className="tnum">
                    Accesos concedidos:{" "}
                    <span className="text-emerald-400">{m.door.granted}</span>
                  </span>
                  <span className="tnum">
                    Bloqueados:{" "}
                    <span className="text-amber-400">{m.door.rejected}</span>
                  </span>
                  <span className="tnum">
                    Total escaneos:{" "}
                    <span className="text-zinc-300">{m.door.total}</span>
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Cambio de rol: el icono del nuevo rol hace la intención obvia */}
          <div className="flex flex-wrap items-center gap-2">
            <IconSwap className="h-3.5 w-3.5 text-zinc-600" />
            <select
              value={
                m.roles.find((r) => r !== "super_admin") ||
                m.roles[0] ||
                "promotor"
              }
              onChange={(e) =>
                patchUser(
                  { role: e.target.value },
                  {
                    title: `¿Cambiar el rol de ${m.full_name}?`,
                    message: `Pasa a ser ${ROLE_META[e.target.value]?.label.toLowerCase() ?? e.target.value} en esta venue.`,
                    confirmLabel: "Cambiar rol",
                  },
                )
              }
              className="field w-auto py-1 text-xs"
              aria-label={`Rol de ${m.full_name}`}
            >
              <option value="promotor">Promotor</option>
              <option value="bouncer">Portero</option>
              <option value="admin">Admin</option>
            </select>
            <span className="text-2xs text-zinc-600">
              El cambio es inmediato en esta venue.
            </span>
          </div>

          {resetId === m.id && (
            <div className="w-full">
              <div className="flex gap-1.5">
                <input
                  value={newPass}
                  onChange={(e) => setNewPass(e.target.value)}
                  className="field py-1 text-xs"
                  type="password"
                  placeholder="Nueva contraseña (mín. 8)"
                  minLength={8}
                  maxLength={128}
                />
                <button
                  onClick={resetPassword}
                  disabled={newPass.length < 8}
                  className="btn-primary px-3 py-1 text-xs font-bold disabled:opacity-40"
                >
                  Guardar
                </button>
              </div>
              {newPass && <PasswordMeter value={newPass} />}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/* ---------------------------------------------------------------------------
 * Componente principal: KPIs + pestañas por rol + buscador + alta
 * ------------------------------------------------------------------------ */
const TABS = [
  { id: "all", label: "Todos", icon: null },
  { id: "promotor", label: "Promotores", icon: "promotor" },
  { id: "bouncer", label: "Puerta", icon: "bouncer" },
  { id: "admin", label: "Admins", icon: "admin" },
];

export default function TeamManager({ venueId, users, onChanged }) {
  const ui = useUI();
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState({
    full_name: "",
    email: "",
    password: "",
    role: "promotor",
  });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState("all");
  const [stats, setStats] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [resetId, setResetId] = useState(null);

  const loadStats = useCallback(() => {
    apiFetch(`/venues/${venueId}/users/stats`)
      .then(setStats)
      .catch(() => {});
  }, [venueId]);

  useEffect(() => {
    loadStats();
  }, [loadStats, users]);

  async function createUser(e) {
    e.preventDefault();
    setErr("");
    const missing = missingList(form.password);
    if (missing.length > 0) {
      setErr(`Le falta a la contraseña: ${missing.join(", ")}.`);
      return;
    }
    setBusy(true);
    try {
      await apiFetch(`/venues/${venueId}/users`, {
        method: "POST",
        body: JSON.stringify(form),
      });
      await onChanged();
      setForm({ full_name: "", email: "", password: "", role: "promotor" });
      setAddOpen(false);
      setTab(form.role);
      ui.success(`${form.full_name} agregado al equipo`);
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusy(false);
    }
  }

  const members = stats?.members || [];

  /* Contadores por pestaña (patrón distri-stream: contador junto al icono) */
  const counts = useMemo(
    () => ({
      all: members.length,
      promotor: members.filter((m) => m.roles.includes("promotor")).length,
      bouncer: members.filter(
        (m) => m.roles.includes("bouncer") && !m.roles.includes("promotor"),
      ).length,
      admin: members.filter(
        (m) =>
          (m.roles.includes("admin") || m.roles.includes("super_admin")) &&
          !m.roles.includes("promotor") &&
          !m.roles.includes("bouncer"),
      ).length,
    }),
    [members],
  );

  const filtered = useMemo(() => {
    let list = members;
    if (tab !== "all") {
      list = list.filter((m) => {
        const r = primaryRoleOf(m);
        if (tab === "admin") return r === "admin";
        return r === tab;
      });
    }
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (m) =>
          m.full_name.toLowerCase().includes(q) ||
          m.email.toLowerCase().includes(q) ||
          m.roles.some((r) => r.includes(q)),
      );
    }
    return list;
  }, [members, tab, query]);

  return (
    <div className="space-y-4">
      {/* Resumen ejecutivo */}
      {stats && (
        <div className="card">
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-zinc-800/80 px-5 py-4">
            <div>
              <p className="eyebrow">Resumen del equipo</p>
              <h3 className="display mt-0.5 text-lg">
                Quién hace qué — y qué tan bien
              </h3>
            </div>
            <p className="text-xs text-zinc-500">
              Últimos {stats.days_window} días
            </p>
          </div>
          <div className="grid grid-cols-2 divide-zinc-800/80 sm:grid-cols-4 sm:divide-x">
            <div className="px-2 py-2 text-center">
              <p className="text-xs text-zinc-500">Miembros activos</p>
              <p className="tnum display mt-0.5 text-2xl text-white">
                {stats.active_members}
                <span className="text-base text-zinc-600">
                  /{stats.total_members}
                </span>
              </p>
            </div>
            <div className="px-2 py-2 text-center">
              <p className="text-xs text-zinc-500">Promotores</p>
              <p className="tnum display mt-0.5 text-2xl text-white">
                {stats.promoters_active}
              </p>
            </div>
            <div className="px-2 py-2 text-center">
              <p className="text-xs text-zinc-500">Porteros</p>
              <p className="tnum display mt-0.5 text-2xl text-white">
                {stats.bouncers_active}
              </p>
            </div>
            <div className="px-2 py-2 text-center">
              <p className="text-xs text-zinc-500">Entraron a trabajar</p>
              <p
                className={`tnum display mt-0.5 text-2xl ${stats.active_in_window === 0 ? "text-amber-400" : "text-emerald-400"}`}
              >
                {stats.active_in_window}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Cabecera de accesos: buscador + alta (patrón distri-stream) */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-52 flex-1">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="field pl-9"
            placeholder="Buscar por nombre, correo o rol…"
            aria-label="Buscar miembro del equipo"
          />
          <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-600" />
        </div>
        <button
          onClick={() => setAddOpen((v) => !v)}
          className="btn-primary inline-flex items-center gap-1.5 whitespace-nowrap"
        >
          <IconPlus className="h-3.5 w-3.5" />
          Nuevo usuario
        </button>
      </div>

      {/* Pestañas por rol con icono + contador (patrón distri-stream) */}
      <div className="card p-5">
        <div
          className="tabbar no-scrollbar mb-4 max-w-full"
          role="tablist"
          aria-label="Filtrar por rol"
        >
          {TABS.map((t) => {
            const active = tab === t.id;
            const meta = t.icon ? ROLE_META[t.icon] : null;
            return (
              <button
                key={t.id}
                role="tab"
                aria-selected={active}
                onClick={() => setTab(t.id)}
                className="tabbar-item shrink-0 !text-xs"
              >
                {meta ? (
                  <IconRole role={t.icon} className="h-3.5 w-3.5" />
                ) : (
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    className="h-3.5 w-3.5"
                    aria-hidden
                  >
                    <path d="M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M10 3.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7ZM21 19v-1a4 4 0 0 0-2.5-3.7M15 3.6a3.5 3.5 0 0 1 0 6.8" />
                  </svg>
                )}
                {t.label}
                <span
                  className={`tnum rounded-full px-1.5 text-2xs ring-1 ${
                    active
                      ? "bg-zinc-700/80 text-zinc-200 ring-zinc-600"
                      : "bg-zinc-800/80 text-zinc-500 ring-zinc-700/70"
                  }`}
                >
                  {counts[t.id]}
                </span>
              </button>
            );
          })}
        </div>

        {/* Lista filtrada */}
        {filtered.length === 0 ? (
          <p className="rounded-lg border border-zinc-800/60 bg-zinc-900/40 px-3 py-8 text-center text-sm text-zinc-500">
            {query
              ? "Nadie coincide con la búsqueda."
              : counts.all === 0
                ? "Sin usuarios todavía — agrega a tu equipo con «Nuevo usuario»."
                : "Nadie en esta pestaña todavía."}
          </p>
        ) : (
          <ul className="space-y-2">
            {filtered.map((m) => (
              <MemberRow
                key={m.id}
                m={m}
                venueId={venueId}
                onChanged={onChanged}
                openId={openId}
                setOpenId={setOpenId}
                resetId={resetId}
                setResetId={setResetId}
              />
            ))}
          </ul>
        )}

        {tab !== "all" && filtered.length > 0 && (
          <p className="mt-3 text-2xs text-zinc-600">
            {ROLE_META[tab]?.hint} — mostrando {filtered.length} de{" "}
            {counts[tab]}.
          </p>
        )}
      </div>

      {/* Alta de personal */}
      {addOpen && (
        <div className="card p-5">
          <div className="mb-3">
            <p className="eyebrow">Personal</p>
            <h3 className="display mt-0.5 text-base">Agregar al equipo</h3>
          </div>
          {err && <p className="mb-2 text-xs text-red-400">{err}</p>}
          <form
            onSubmit={createUser}
            className="grid grid-cols-1 gap-2 sm:grid-cols-2"
          >
            <input
              value={form.full_name}
              onChange={(e) => setForm({ ...form, full_name: e.target.value })}
              className="field"
              placeholder="Nombre completo"
              required
            />
            {/* Selector con icono del rol: la intención se ve antes de guardar */}
            <div className="grid grid-cols-3 gap-1.5">
              {["promotor", "bouncer", "admin"].map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setForm({ ...form, role: r })}
                  aria-pressed={form.role === r}
                  className={`inline-flex items-center justify-center gap-1.5 rounded-lg border px-2 py-2 text-xs font-bold transition-colors ${
                    form.role === r
                      ? "border-zinc-500 bg-zinc-800 text-white"
                      : "border-zinc-800 bg-zinc-900/40 text-zinc-400 hover:border-zinc-700"
                  }`}
                >
                  <IconRole
                    role={r}
                    className={`h-3.5 w-3.5 ${ROLE_META[r].tabAccent}`}
                  />
                  {ROLE_META[r].label}
                </button>
              ))}
            </div>
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
              maxLength={128}
              required
            />
            {form.password && <PasswordMeter value={form.password} />}
            <button disabled={busy} className="btn-primary col-span-full">
              {busy ? "Creando…" : "Crear usuario"}
            </button>
            <p className="col-span-full text-xs text-zinc-500">
              Si el correo ya existe, solo se le agrega el rol en esta venue.
            </p>
          </form>
        </div>
      )}
    </div>
  );
}
