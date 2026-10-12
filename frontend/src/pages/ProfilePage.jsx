import { useNavigate } from "react-router-dom";
import { useState } from "react";
import { useAuth } from "../lib/auth";
import { apiFetch } from "../lib/api";
import { activeVenueId, setActiveVenueId } from "../lib/venue";
import { ROLE_LABELS, ROLE_VISUALS, topRole } from "../lib/roles";
import { useUI } from "../lib/ui";
import Icon from "../components/Icon";
import PasswordMeter from "../components/PasswordMeter";
import ThemeChooser from "../components/ThemeChooser";

const roleLabel = (role) => ROLE_LABELS[role] ?? role;

/** Fecha larga para "Miembro desde": "12 de octubre de 2026". */
function longDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("es-CO", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/** Fecha relativa compacta para el último ingreso: "hoy", "ayer", "hace 3 días". */
function sinceLabel(iso) {
  if (!iso) return null;
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return null;
  const days = Math.floor((Date.now() - then.getTime()) / 86_400_000);
  if (days <= 0) return "hoy";
  if (days === 1) return "ayer";
  if (days < 30) return `hace ${days} días`;
  return longDate(iso);
}

/** Encabezado de sección unificado: eyebrow + título + explicación. */
function SectionHead({ eyebrow, title, hint }) {
  return (
    <div className="pf-section-head">
      {eyebrow && <p className="eyebrow">{eyebrow}</p>}
      <h3 className="pf-section-title">{title}</h3>
      {hint && (
        <p className="mt-1 text-xs leading-relaxed text-zinc-500">{hint}</p>
      )}
    </div>
  );
}

/** Página de perfil: identidad del usuario, cambio de contraseña y
 *  eliminación definitiva de la cuenta (zona de peligro). */
export default function ProfilePage() {
  const { user, logout, setUser } = useAuth();
  const nav = useNavigate();
  const ui = useUI();
  // Negocio activo (multi-negocio): estado local para re-pintar el selector
  // al instante; los paneles leen el valor persistido en cada carga.
  const [currentVenueId, setCurrentVenueId] = useState(() =>
    activeVenueId(user),
  );

  // Edición de datos propios
  const [name, setName] = useState(user?.full_name || "");
  const [nameMsg, setNameMsg] = useState(null);
  const [nameBusy, setNameBusy] = useState(false);

  // Edición del negocio (primer venue donde tiene rol admin)
  const adminVenue = (user?.venues || []).find((v) =>
    (user?.roles?.[String(v.id)] || []).includes("admin"),
  );
  const [venueName, setVenueName] = useState(adminVenue?.name || "");
  const [venueLogo, setVenueLogo] = useState(adminVenue?.logo_url || "");
  const [venueCommission, setVenueCommission] = useState(
    adminVenue?.commission_pct != null
      ? String(adminVenue.commission_pct)
      : "0",
  );
  const [logoError, setLogoError] = useState("");
  const [venueBusy, setVenueBusy] = useState(false);

  // Cambio de contraseña
  const [curPass, setCurPass] = useState("");
  const [showCur, setShowCur] = useState(false);
  const [newPass, setNewPass] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [passMsg, setPassMsg] = useState(null); // {ok, text}
  const [passBusy, setPassBusy] = useState(false);

  // Borrado de cuenta
  const [delOpen, setDelOpen] = useState(false);
  const [delPass, setDelPass] = useState("");
  const [delErr, setDelErr] = useState("");
  const [delBusy, setDelBusy] = useState(false);

  if (!user) return null;

  // Rol de cabecera = el más alto (mismo criterio que el topbar), y su
  // identidad visual sale de ROLE_VISUALS para no divergir del equipo.
  const role = topRole(user) ?? "bouncer";
  const visual = ROLE_VISUALS[role] ?? ROLE_VISUALS.bouncer;
  const initials = (user.full_name || "?")
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  const memberSince = longDate(user.created_at);
  const lastSeen = sinceLabel(user.last_login_at);

  async function submitPassword(e) {
    e.preventDefault();
    setPassMsg(null);
    if (newPass.length > 128) {
      setPassMsg({
        ok: false,
        text: "La nueva contraseña no puede superar 128 caracteres.",
      });
      return;
    }
    if (newPass.length < 8) {
      setPassMsg({
        ok: false,
        text: "La nueva contraseña debe tener al menos 8 caracteres.",
      });
      return;
    }
    setPassBusy(true);
    try {
      const res = await apiFetch("/auth/change-password", {
        method: "POST",
        body: JSON.stringify({
          current_password: curPass,
          new_password: newPass,
        }),
      });
      ui.success(res.detail);
      setCurPass("");
      setNewPass("");
    } catch (err) {
      ui.error(err.message);
    } finally {
      setPassBusy(false);
    }
  }

  async function submitName(e) {
    e.preventDefault();
    setNameMsg(null);
    if (name.trim().length < 2) {
      setNameMsg({
        ok: false,
        text: "El nombre debe tener al menos 2 caracteres.",
      });
      return;
    }
    setNameBusy(true);
    try {
      const updated = await apiFetch("/auth/profile", {
        method: "PATCH",
        body: JSON.stringify({ full_name: name }),
      });
      setUser(updated);
      ui.success("Nombre actualizado.");
    } catch (err) {
      ui.error(err.message);
    } finally {
      setNameBusy(false);
    }
  }

  async function submitVenue(e) {
    e.preventDefault();
    setLogoError("");
    setVenueBusy(true);
    try {
      const updated = await apiFetch(`/auth/venues/${adminVenue.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: venueName,
          logo_url: venueLogo,
          commission_pct: Number(venueCommission) || 0,
        }),
      });
      // Refrescar la venue dentro del user del contexto global
      setUser({
        ...user,
        venues: user.venues.map((v) =>
          v.id === updated.id
            ? {
                ...v,
                name: updated.name,
                logo_url: updated.logo_url,
                commission_pct: updated.commission_pct,
              }
            : v,
        ),
      });
      ui.success("Datos del negocio actualizados.");
    } catch (err) {
      ui.error(err.message);
    } finally {
      setVenueBusy(false);
    }
  }

  async function submitDelete(e) {
    e.preventDefault();
    setDelErr("");
    setDelBusy(true);
    try {
      await apiFetch("/auth/account", {
        method: "DELETE",
        body: JSON.stringify({ password: delPass }),
      });
      logout();
      nav("/login", { state: { deleted: true } });
    } catch (err) {
      setDelErr(err.message);
    } finally {
      setDelBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      {/* Hero de identidad: la ficha de la persona, no un formulario. */}
      <div className="pf-hero">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
          <span className={`pf-avatar ${visual.avatar}`}>
            <span
              className={`pf-avatar-ring ${visual.tabAccent}`}
              aria-hidden="true"
            />
            {initials}
          </span>
          <div className="min-w-0 flex-1">
            <p className="eyebrow">Tu perfil</p>
            <h2 className="pf-name mt-0.5 truncate">
              {user.full_name}
            </h2>
            <p className="pf-email truncate text-sm text-zinc-400">
              {user.email}
            </p>

            {/* Roles por negocio: cada negocio con el chip de su rol. */}
            {user.venues?.length > 0 && (
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {user.venues.map((v) => {
                  const vRoles = user.roles?.[String(v.id)] || [];
                  const vRole = topRole({
                    roles: { [String(v.id)]: vRoles },
                  });
                  const vVisual = ROLE_VISUALS[vRole] ?? visual;
                  return (
                    <span
                      key={v.id}
                      className={`pf-role-chip ${vVisual.tabAccent}`}
                    >
                      {v.name}
                      {vRole && (
                        <span className="opacity-80">· {roleLabel(vRole)}</span>
                      )}
                    </span>
                  );
                })}
              </div>
            )}

            {/* Contexto de cuenta: desde cuándo y último ingreso. */}
            {(memberSince || lastSeen) && (
              <div className="pf-meta mt-3">
                {memberSince && (
                  <span className="pf-meta-item">
                    <Icon name="calendar" className="h-3.5 w-3.5" />
                    Miembro desde {memberSince}
                  </span>
                )}
                {lastSeen && (
                  <span className="pf-meta-item">
                    <Icon name="clock" className="h-3.5 w-3.5" />
                    Último ingreso {lastSeen}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="pf-grid">
        {/* Columna izquierda: la cuenta (tú). */}
        <div className="space-y-5">
          {/* Negocio activo (solo si pertenece a varias): qué panel abre y
              sobre qué venue trabaja cada pantalla. */}
          {user.venues?.length > 1 && (
            <div className="card p-5">
              <SectionHead
                eyebrow="Paneles"
                title="Negocio activo"
                hint="Trabajas con varios negocios: elige con cuál abren los paneles."
              />
              <div className="grid gap-2 sm:grid-cols-2">
                {user.venues.map((v) => {
                  const active = v.id === currentVenueId;
                  return (
                    <button
                      key={v.id}
                      type="button"
                      onClick={() => {
                        setActiveVenueId(v.id);
                        setCurrentVenueId(v.id);
                      }}
                      className={`flex items-center gap-3 rounded-xl border p-3 text-left transition ${
                        active
                          ? "border-brand-500/60 bg-brand-500/[0.06]"
                          : "border-zinc-800/80 hover:border-zinc-700"
                      }`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-bold text-zinc-200">
                          {v.name}
                        </span>
                        <span className="block text-xs text-zinc-500">
                          {(user.roles?.[String(v.id)] || [])
                            .map(roleLabel)
                            .join(", ")}
                        </span>
                      </span>
                      {active && (
                        <span className="shrink-0 rounded-full bg-brand-500/15 px-2 py-0.5 text-[10px] font-bold uppercase text-brand-300 ring-1 ring-brand-500/40">
                          Activa
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Datos propios */}
          <div className="card p-5">
            <SectionHead
              eyebrow="Cuenta"
              title="Tus datos"
              hint="Tu nombre es el que ven tu equipo y quedó registrado en las boletas que emitas."
            />
            <form onSubmit={submitName} className="space-y-3">
              <div>
                <label
                  htmlFor="full-name"
                  className="mb-1 block text-xs font-medium text-zinc-400"
                >
                  Nombre completo
                </label>
                <input
                  id="full-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="field"
                  maxLength={120}
                  minLength={2}
                  required
                />
              </div>
              {nameMsg && (
                <div
                  role="status"
                  className={`rounded-lg border px-3 py-2 text-sm ${
                    nameMsg.ok
                      ? "border-emerald-800/60 bg-emerald-950/40 text-emerald-300"
                      : "border-red-900/60 bg-red-950/40 text-red-300"
                  }`}
                >
                  {nameMsg.text}
                </div>
              )}
              <button
                type="submit"
                disabled={nameBusy || name.trim() === user.full_name}
                className="btn-primary disabled:opacity-40"
              >
                {nameBusy ? "Guardando…" : "Guardar nombre"}
              </button>
            </form>
          </div>

          {/* Cambiar contraseña */}
          <div className="card p-5">
            <SectionHead
              eyebrow="Seguridad"
              title="Cambiar contraseña"
              hint="Se te pedirá la contraseña actual para confirmar que eres tú."
            />

            <form onSubmit={submitPassword} className="space-y-3">
              <div>
                <label
                  htmlFor="cur-pass"
                  className="mb-1 block text-xs font-medium text-zinc-400"
                >
                  Contraseña actual
                </label>
                <div className="relative">
                  <input
                    id="cur-pass"
                    type={showCur ? "text" : "password"}
                    value={curPass}
                    onChange={(e) => setCurPass(e.target.value)}
                    className="field !pr-16"
                    autoComplete="current-password"
                    maxLength={128}
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowCur((v) => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md px-2 py-1 text-xs font-semibold text-zinc-400 transition hover:text-zinc-200"
                    aria-label={
                      showCur ? "Ocultar contraseña" : "Mostrar contraseña"
                    }
                  >
                    {showCur ? "Ocultar" : "Ver"}
                  </button>
                </div>
              </div>

              <div>
                <label
                  htmlFor="new-pass"
                  className="mb-1 block text-xs font-medium text-zinc-400"
                >
                  Nueva contraseña (mínimo 8 caracteres)
                </label>
                <div className="relative">
                  <input
                    id="new-pass"
                    type={showNew ? "text" : "password"}
                    value={newPass}
                    onChange={(e) => setNewPass(e.target.value)}
                    className="field !pr-16"
                    autoComplete="new-password"
                    minLength={8}
                    maxLength={128}
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowNew((v) => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md px-2 py-1 text-xs font-semibold text-zinc-400 transition hover:text-zinc-200"
                    aria-label={
                      showNew ? "Ocultar contraseña" : "Mostrar contraseña"
                    }
                  >
                    {showNew ? "Ocultar" : "Ver"}
                  </button>
                </div>
                {newPass && <PasswordMeter value={newPass} idPrefix="new-pass" />}
              </div>

              {passMsg && (
                <div
                  role="status"
                  className={`rounded-lg border px-3 py-2 text-sm ${
                    passMsg.ok
                      ? "border-emerald-800/60 bg-emerald-950/40 text-emerald-300"
                      : "border-red-900/60 bg-red-950/40 text-red-300"
                  }`}
                >
                  {passMsg.text}
                </div>
              )}

              <button type="submit" disabled={passBusy} className="btn-primary">
                {passBusy ? "Guardando…" : "Actualizar contraseña"}
              </button>
            </form>
          </div>
        </div>

        {/* Columna derecha: tu negocio, apariencia y la zona de peligro. */}
        <div className="space-y-5">
          {/* Negocio (solo admins) */}
          {adminVenue && (
            <div className="card p-5">
              <SectionHead
                eyebrow="Negocio"
                title="Tu negocio"
                hint="El nombre y el logo representan tu negocio ante tu equipo y tus clientes."
              />
              <form onSubmit={submitVenue} className="space-y-3">
                <div>
                  <label
                    htmlFor="venue-name"
                    className="mb-1 block text-xs font-medium text-zinc-400"
                  >
                    Nombre del negocio
                  </label>
                  <input
                    id="venue-name"
                    value={venueName}
                    onChange={(e) => setVenueName(e.target.value)}
                    className="field"
                    maxLength={120}
                    minLength={2}
                    required
                  />
                </div>
                <div>
                  <label
                    htmlFor="venue-logo"
                    className="mb-1 block text-xs font-medium text-zinc-400"
                  >
                    Logo (URL de imagen)
                  </label>
                  <div className="flex items-center gap-3">
                    {venueLogo && !logoError ? (
                      <img
                        src={venueLogo}
                        alt="Logo actual"
                        onError={() => setLogoError("No se pudo cargar la imagen")}
                        className="h-12 w-12 shrink-0 rounded-lg object-cover ring-1 ring-zinc-700"
                      />
                    ) : (
                      <span className="grid h-12 w-12 shrink-0 place-items-center rounded-lg bg-zinc-800 text-lg font-bold text-zinc-500 ring-1 ring-zinc-700">
                        {(venueName || "?")[0].toUpperCase()}
                      </span>
                    )}
                    <input
                      id="venue-logo"
                      type="url"
                      value={venueLogo}
                      onChange={(e) => {
                        setVenueLogo(e.target.value);
                        setLogoError("");
                      }}
                      className="field"
                      placeholder="https://…/logo.png"
                      maxLength={500}
                    />
                  </div>
                  {logoError && (
                    <p className="mt-1 text-xs text-amber-400">
                      {logoError} — revisa la URL.
                    </p>
                  )}
                </div>
                {/* Comisión del promotor: base de las liquidaciones (se congela
                    por liquidación al cerrar el periodo). */}
                <div className="mt-4">
                  <label
                    htmlFor="venue-commission"
                    className="mb-1 block text-xs font-medium text-zinc-400"
                  >
                    Comisión del promotor (%)
                  </label>
                  <input
                    id="venue-commission"
                    type="number"
                    min="0"
                    max="100"
                    step="0.5"
                    value={venueCommission}
                    onChange={(e) => setVenueCommission(e.target.value)}
                    className="field"
                  />
                  <p className="mt-1 text-xs text-zinc-500">
                    Se aplica al recaudo de cada promotor al cerrar su liquidación.
                  </p>
                </div>
                <button
                  type="submit"
                  disabled={
                    venueBusy ||
                    (venueName.trim() === adminVenue.name &&
                      venueLogo === (adminVenue.logo_url || "") &&
                      venueCommission === String(adminVenue.commission_pct ?? 0))
                  }
                  className="btn-primary disabled:opacity-40"
                >
                  {venueBusy ? "Guardando…" : "Guardar negocio"}
                </button>
              </form>
            </div>
          )}

          {/* Apariencia: las tres opciones visibles (no un toggle escondido) */}
          <div className="card p-5">
            <SectionHead
              eyebrow="Interfaz"
              title="Apariencia"
              hint='El modo "Sistema" sigue la preferencia de tu dispositivo. La puerta (escáner) siempre es oscura: un flash de blanco en un recinto a oscuras ciega.'
            />
            <ThemeChooser />
          </div>

          {/* Zona de peligro */}
          <div className="card border-red-900/40 p-5">
            <h3 className="pf-danger-title mb-1 text-base font-bold text-red-300">
              Zona de peligro
            </h3>
            <p className="mb-4 text-xs leading-relaxed text-zinc-500">
              Eliminar tu cuenta es permanente. Si eres el único administrador con
              equipo a cargo, deberás asignar otro admin antes. Si eres el único
              miembro, tu negocio entero se elimina con ella.
            </p>

            {!delOpen ? (
              <button
                onClick={() => setDelOpen(true)}
                className="btn-ghost text-xs font-bold text-red-400"
              >
                Eliminar mi cuenta…
              </button>
            ) : (
              <form
                onSubmit={submitDelete}
                className="space-y-3 rounded-lg border border-red-900/40 bg-red-950/20 p-4"
              >
                <p className="text-sm text-red-200">
                  Escribe tu contraseña para confirmar. Esta acción no tiene
                  deshacer.
                </p>
                <input
                  type="password"
                  value={delPass}
                  onChange={(e) => setDelPass(e.target.value)}
                  className="field"
                  placeholder="Tu contraseña"
                  autoComplete="current-password"
                  required
                />
                {delErr && (
                  <div
                    role="alert"
                    className="rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-300"
                  >
                    {delErr}
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setDelOpen(false);
                      setDelErr("");
                      setDelPass("");
                    }}
                    className="btn-ghost text-xs font-bold"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    disabled={delBusy || !delPass}
                    className="rounded-lg bg-red-600 px-4 py-2 text-sm font-bold text-white transition hover:bg-red-500 disabled:opacity-40"
                  >
                    {delBusy ? "Eliminando…" : "Eliminar definitivamente"}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
