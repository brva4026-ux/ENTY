/* Panel de invitaciones de staff (vista admin).
 *
 * El admin nunca inventa contraseñas: genera un enlace para una persona
 * concreta, se lo pasa por WhatsApp (o el canal que prefiera) y esa persona
 * crea SU propia contraseña. El enlace se muestra UNA vez, es de un solo uso,
 * expira y se puede revocar.
 *
 * Patrones del dueño (unicall-blue + distri-stream): acciones de icono con
 * tooltip por fila, pestañas por estado con contador, identidad dark Enty.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "../lib/api";
import EmptyState from "./EmptyState";
import { useUI } from "../lib/ui";

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
  if (role === "admin")
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
        <path d="M16 10l-4 4-4-4" />
      </svg>
    );
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
function IconCopy({ className = ico }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className={className}
      aria-hidden
    >
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
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
function IconClock({ className = ico }) {
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
      <path d="M12 7v5l3 2" />
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
function IconLink({ className = ico }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className={className}
      aria-hidden
    >
      <path d="M10 14a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.2 1.1" />
      <path d="M14 10a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.2-1.1" />
    </svg>
  );
}

/* Misma identidad por rol que el módulo Equipo. */
const ROLE_META = {
  promotor: {
    label: "Promotor",
    chip: "bg-brand-500/15 text-brand-300 ring-brand-500/30",
    tabAccent: "text-brand-300",
  },
  bouncer: {
    label: "Portero",
    chip: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
    tabAccent: "text-emerald-300",
  },
  admin: {
    label: "Admin",
    chip: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
    tabAccent: "text-amber-300",
  },
};

function initials(name) {
  return (name || "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");
}

function relTime(value) {
  const diff = new Date(value).getTime() - Date.now();
  const mins = Math.round(diff / 60000);
  if (mins >= 0 && mins < 60) return `vence en ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours >= 0 && hours < 48) return `vence en ${hours} h`;
  if (diff < 0) return "expiró";
  return `vence ${new Date(value).toLocaleDateString("es-CO", { day: "numeric", month: "short" })}`;
}

function stateOf(inv) {
  if (inv.accepted_at) return "accepted";
  if (inv.revoked_at) return "revoked";
  if (new Date(inv.expires_at).getTime() < Date.now()) return "expired";
  return "pending";
}

const STATE_META = {
  pending: {
    label: "Pendiente",
    cls: "bg-sky-950/50 text-sky-300 ring-sky-800/60",
  },
  accepted: {
    label: "Canjeada",
    cls: "bg-emerald-950/50 text-emerald-400 ring-emerald-900/60",
  },
  revoked: {
    label: "Revocada",
    cls: "bg-zinc-800/80 text-zinc-500 ring-zinc-700",
  },
  expired: {
    label: "Expirada",
    cls: "bg-amber-950/50 text-amber-400 ring-amber-900/60",
  },
};

export default function InvitationsManager({ venueId }) {
  const ui = useUI();
  const [items, setItems] = useState(null);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState({
    full_name: "",
    email: "",
    role: "promotor",
    expires_hours: 72,
  });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState("pending");
  const [lastLink, setLastLink] = useState(null); // {url, email}

  const load = useCallback(() => {
    apiFetch(`/auth/venues/${venueId}/invitations`)
      .then(setItems)
      .catch((e) => setErr(e.message));
  }, [venueId]);

  useEffect(() => {
    load();
  }, [load]);

  async function createInvitation(e) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      const inv = await apiFetch(`/auth/venues/${venueId}/invitations`, {
        method: "POST",
        body: JSON.stringify(form),
      });
      const url = `${window.location.origin}${inv.invite_url}`;
      setLastLink({ url, email: inv.email, name: inv.full_name });
      setForm({
        full_name: "",
        email: "",
        role: "promotor",
        expires_hours: 72,
      });
      setFormOpen(false);
      load();
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusy(false);
    }
  }

  async function copyLink(url, email) {
    try {
      await navigator.clipboard.writeText(url);
      ui.success(
        `Enlace copiado — envíalo a ${email || "la persona invitada"}`,
      );
    } catch {
      ui.promptFallback?.();
    }
  }

  async function revoke(inv) {
    const ok = await ui.confirm(`¿Revocar la invitación de ${inv.full_name}?`, {
      message:
        "El enlace deja de funcionar de inmediato. No afecta a quien ya lo canjeó.",
      danger: true,
      confirmLabel: "Revocar",
    });
    if (!ok) return;
    try {
      await apiFetch(`/auth/venues/${venueId}/invitations/${inv.id}`, {
        method: "DELETE",
      });
      load();
      ui.success("Invitación revocada");
    } catch (e2) {
      setErr(e2.message);
    }
  }

  const list = items || [];

  /* Pestañas por estado con contador (patrón distri-stream). */
  const counts = useMemo(
    () => ({
      pending: list.filter((i) => stateOf(i) === "pending").length,
      accepted: list.filter((i) => stateOf(i) === "accepted").length,
      closed: list.filter((i) => ["revoked", "expired"].includes(stateOf(i)))
        .length,
      all: list.length,
    }),
    [list],
  );

  const filtered = useMemo(() => {
    let l = list;
    if (tab === "pending") l = l.filter((i) => stateOf(i) === "pending");
    else if (tab === "accepted") l = l.filter((i) => stateOf(i) === "accepted");
    else if (tab === "closed")
      l = l.filter((i) => ["revoked", "expired"].includes(stateOf(i)));
    const q = query.trim().toLowerCase();
    if (q)
      l = l.filter(
        (i) =>
          i.full_name.toLowerCase().includes(q) ||
          i.email.toLowerCase().includes(q),
      );
    return l;
  }, [list, tab, query]);

  const TABS = [
    { id: "pending", label: "Pendientes", dot: "bg-sky-400" },
    { id: "accepted", label: "Canjeadas", dot: "bg-emerald-400" },
    { id: "closed", label: "Cerradas", dot: "bg-zinc-500" },
    { id: "all", label: "Todas", dot: null },
  ];

  return (
    <div className="space-y-4">
      {/* Qué es cada persona: la explicación que faltaba. Quien entra a esta
          pantalla por primera vez no sabe que "crear un promotor" = invitarlo
          con un enlace; tres tarjetas lo dicen sin jerga. */}
      <div className="grid gap-2 sm:grid-cols-3">
        {[
          {
            role: "promotor",
            desc: "Vende boletas con su propio cupo y ve solo las suyas.",
          },
          {
            role: "bouncer",
            desc: "Escanea QR en la puerta. No ve precios ni reportes.",
          },
          {
            role: "admin",
            desc: "Control total: eventos, equipo, ingresos y ajustes.",
          },
        ].map(({ role, desc }) => {
          const m = ROLE_META[role] || ROLE_META.promotor;
          return (
            <div
              key={role}
              className="flex items-start gap-2.5 rounded-xl border border-zinc-800/60 bg-zinc-900/40 p-3"
            >
              <span
                className={`grid h-8 w-8 shrink-0 place-items-center rounded-full ring-1 ${m.chip}`}
              >
                <IconRole role={role} className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-zinc-200">{m.label}</p>
                <p className="mt-0.5 text-2xs leading-snug text-zinc-500">
                  {desc}
                </p>
              </div>
            </div>
          );
        })}
      </div>
      {/* El enlace recién creado: protagonista absoluto, se muestra UNA vez */}
      {lastLink && (
        <div className="card border-brand-500/40 p-5">
          <div className="flex items-start gap-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-500/20 text-brand-300 ring-1 ring-brand-500/40">
              <IconLink />
            </span>
            <div className="min-w-0 flex-1">
              <p className="eyebrow">Enlace listo — se muestra una sola vez</p>
              <p className="mt-0.5 text-sm text-zinc-300">
                Envíale este enlace a{" "}
                <span className="font-semibold text-ink">
                  {lastLink.name}
                </span>{" "}
                ({lastLink.email}). Al abrirlo, esa persona crea su propia
                contraseña: tú nunca la conoces.
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <code className="max-w-full truncate rounded-lg border border-zinc-800 bg-zinc-950/80 px-2.5 py-1.5 text-xs text-zinc-400">
                  {lastLink.url}
                </code>
                <button
                  onClick={() => copyLink(lastLink.url, lastLink.email)}
                  className="btn-primary inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold"
                >
                  <IconCopy className="h-3.5 w-3.5" />
                  Copiar enlace
                </button>
                <button
                  onClick={() => setLastLink(null)}
                  className="text-xs text-zinc-500 hover:text-zinc-300"
                >
                  Ocultar
                </button>
              </div>
              <p className="mt-2 text-2xs text-zinc-600">
                Un solo uso · expira automáticamente · revocable desde esta
                pantalla.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Cabecera: buscador + invitar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-52 flex-1">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="field pl-9"
            placeholder="Buscar por nombre o correo…"
            aria-label="Buscar invitación"
          />
          <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-600" />
        </div>
        <button
          onClick={() => setFormOpen((v) => !v)}
          className="btn-primary inline-flex items-center gap-1.5 whitespace-nowrap"
        >
          <IconPlus className="h-3.5 w-3.5" />
          Invitar
        </button>
      </div>

      {/* Formulario de invitación */}
      {formOpen && (
        <div className="card p-5">
          <div className="mb-3">
            <p className="eyebrow">Personal</p>
            <h3 className="display mt-0.5 text-base">Invitar a una persona</h3>
            <p className="mt-1 text-xs text-zinc-500">
              Recibirá un enlace para crear su propia contraseña. Elige el rol
              que tendrá en esta venue.
            </p>
          </div>
          {err && <p className="mb-2 text-xs text-red-400">{err}</p>}
          <form
            onSubmit={createInvitation}
            className="grid grid-cols-1 gap-2 sm:grid-cols-2"
          >
            <input
              aria-label="Nombre completo"
              value={form.full_name}
              onChange={(e) => setForm({ ...form, full_name: e.target.value })}
              className="field"
              placeholder="Nombre completo"
              required
            />
            {/* Rol con icono: la intención se ve antes de enviar (patrón Equipo) */}
            <div className="grid grid-cols-3 gap-1.5">
              {["promotor", "bouncer", "admin"].map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setForm({ ...form, role: r })}
                  aria-pressed={form.role === r}
                  className={`inline-flex items-center justify-center gap-1.5 rounded-lg border px-2 py-2 text-xs font-bold transition-colors ${
                    form.role === r
                      ? "border-zinc-500 bg-zinc-800 text-ink"
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
              aria-label="Correo de la persona"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              className="field"
              type="email"
              placeholder="correo@ejemplo.com"
              required
            />
            <select
              value={form.expires_hours}
              onChange={(e) =>
                setForm({ ...form, expires_hours: Number(e.target.value) })
              }
              className="field"
            aria-label="Vigencia del enlace"
            >
              <option value={24}>Vigencia: 24 horas</option>
              <option value={72}>Vigencia: 3 días</option>
              <option value={168}>Vigencia: 7 días</option>
              <option value={336}>Vigencia: 14 días</option>
            </select>
            <button disabled={busy} className="btn-primary sm:col-span-2">
              {busy ? "Generando…" : "Generar enlace de invitación"}
            </button>
          </form>
        </div>
      )}

      {/* Lista con pestañas por estado */}
      <div className="card p-5">
        <div
          className="-mx-1 mb-4 flex gap-1 overflow-x-auto px-1 pb-1"
          role="group"
          aria-label="Filtrar por estado"
        >
          {TABS.map((t) => {
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                aria-pressed={active}
                onClick={() => setTab(t.id)}
                className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-bold transition-colors ${
                  active
                    ? "border-zinc-600 bg-zinc-800 text-ink"
                    : "border-zinc-800/70 bg-zinc-900/40 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
                }`}
              >
                {t.dot && (
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${t.dot}`}
                    aria-hidden
                  />
                )}
                {t.label}
                <span
                  className={`tnum rounded-full px-1.5 text-2xs ring-1 ${active ? "bg-zinc-700/80 text-zinc-200 ring-zinc-600" : "bg-zinc-800/80 text-zinc-500 ring-zinc-700/70"}`}
                >
                  {counts[t.id]}
                </span>
              </button>
            );
          })}
        </div>

        {filtered.length === 0 ? (
          counts.all === 0 ? (
            <EmptyState icon="users" title="Aún no hay invitaciones">
              Pulsa «Invitar» para agregar a tu primer miembro sin contraseñas a
              mano.
            </EmptyState>
          ) : (
            <EmptyState icon="search" title="Nada en esta pestaña todavía">
              Prueba con otra pestaña: cada una agrupa un estado distinto del
              ciclo de vida.
            </EmptyState>
          )
        ) : (
          <ul className="space-y-2">
            {filtered.map((inv) => {
              const st = stateOf(inv);
              const meta = ROLE_META[inv.role] || ROLE_META.promotor;
              const sMeta = STATE_META[st];
              return (
                <li
                  key={inv.id}
                  className="rounded-xl border border-zinc-800/60 bg-zinc-900/40 px-3 py-2.5"
                >
                  <div className="flex items-center gap-3">
                    <span
                      className={`grid h-9 w-9 shrink-0 place-items-center rounded-full text-xs font-bold ring-1 ${meta.chip}`}
                    >
                      {initials(inv.full_name)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="truncate font-semibold text-zinc-200">
                          {inv.full_name}
                        </span>
                        <span
                          className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-2xs font-bold uppercase tracking-wide ring-1 ${sMeta.cls}`}
                        >
                          {st === "accepted" ? (
                            <IconCheck className="h-2.5 w-2.5" />
                          ) : st === "pending" ? (
                            <IconClock className="h-2.5 w-2.5" />
                          ) : (
                            <IconBan className="h-2.5 w-2.5" />
                          )}
                          {sMeta.label}
                        </span>
                        <span
                          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-bold uppercase ring-1 ${meta.chip}`}
                        >
                          <IconRole role={inv.role} className="h-3 w-3" />
                          {meta.label}
                        </span>
                      </div>
                      <p className="truncate text-xs text-zinc-500">
                        {inv.email}
                        <span className="mx-1.5 text-zinc-600">·</span>
                        {st === "pending"
                          ? relTime(inv.expires_at)
                          : st === "accepted"
                            ? "cuenta creada"
                            : sMeta.label.toLowerCase()}
                      </p>
                    </div>
                    {st === "pending" && (
                      <div className="flex shrink-0 items-center gap-0.5">
                        <button
                          onClick={() => revoke(inv)}
                          data-tip={`Revocar la invitación de ${inv.full_name}`}
                          aria-label={`Revocar la invitación de ${inv.full_name}`}
                          className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-amber-500/10 hover:text-amber-300"
                        >
                          <IconBan />
                        </button>
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
