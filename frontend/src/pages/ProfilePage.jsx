import { useNavigate } from "react-router-dom";
import { useState } from "react";
import { useAuth } from "../lib/auth";
import { apiFetch } from "../lib/api";

const roleLabel = (role) =>
  ({ admin: "Administrador", promotor: "Promotor", bouncer: "Portero" })[role] ?? role;

/** Página de perfil: identidad del usuario, cambio de contraseña y
 *  eliminación definitiva de la cuenta (zona de peligro). */
export default function ProfilePage() {
  const { user, logout, setUser } = useAuth();
  const nav = useNavigate();

  // Edición de datos propios
  const [name, setName] = useState(user?.full_name || "");
  const [nameMsg, setNameMsg] = useState(null);
  const [nameBusy, setNameBusy] = useState(false);

  // Edición del negocio (primer venue donde tiene rol admin)
  const adminVenue = (user?.venues || []).find((v) =>
    (user?.roles?.[String(v.id)] || []).includes("admin")
  );
  const [venueName, setVenueName] = useState(adminVenue?.name || "");
  const [venueLogo, setVenueLogo] = useState(adminVenue?.logo_url || "");
  const [logoError, setLogoError] = useState("");
  const [venueMsg, setVenueMsg] = useState(null);
  const [venueBusy, setVenueBusy] = useState(false);

  // Cambio de contraseña
  const [curPass, setCurPass] = useState("");
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

  const roles = Object.values(user.roles || {}).flat();
  const role = roles.includes("admin")
    ? "admin"
    : roles.includes("promotor")
      ? "promotor"
      : "bouncer";
  const initials = (user.full_name || "?")
    .split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();

  async function submitPassword(e) {
    e.preventDefault();
    setPassMsg(null);
    if (newPass.length < 8) {
      setPassMsg({ ok: false, text: "La nueva contraseña debe tener al menos 8 caracteres." });
      return;
    }
    setPassBusy(true);
    try {
      const res = await apiFetch("/auth/change-password", {
        method: "POST",
        body: JSON.stringify({ current_password: curPass, new_password: newPass }),
      });
      setPassMsg({ ok: true, text: res.detail });
      setCurPass("");
      setNewPass("");
    } catch (err) {
      setPassMsg({ ok: false, text: err.message });
    } finally {
      setPassBusy(false);
    }
  }

  async function submitName(e) {
    e.preventDefault();
    setNameMsg(null);
    if (name.trim().length < 2) {
      setNameMsg({ ok: false, text: "El nombre debe tener al menos 2 caracteres." });
      return;
    }
    setNameBusy(true);
    try {
      const updated = await apiFetch("/auth/profile", {
        method: "PATCH",
        body: JSON.stringify({ full_name: name }),
      });
      setUser(updated);
      setNameMsg({ ok: true, text: "Nombre actualizado." });
    } catch (err) {
      setNameMsg({ ok: false, text: err.message });
    } finally {
      setNameBusy(false);
    }
  }

  async function submitVenue(e) {
    e.preventDefault();
    setVenueMsg(null);
    setLogoError("");
    setVenueBusy(true);
    try {
      const updated = await apiFetch(`/auth/venues/${adminVenue.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: venueName, logo_url: venueLogo }),
      });
      // Refrescar la venue dentro del user del contexto global
      setUser({
        ...user,
        venues: user.venues.map((v) =>
          v.id === updated.id ? { ...v, name: updated.name, logo_url: updated.logo_url } : v
        ),
      });
      setVenueMsg({ ok: true, text: "Datos del negocio actualizados." });
    } catch (err) {
      setVenueMsg({ ok: false, text: err.message });
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
    <div className="mx-auto max-w-2xl space-y-5">
      <h2 className="display text-2xl text-white">Tu perfil</h2>

      {/* Identidad */}
      <div className="card flex items-center gap-4 p-5">
        <span className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-zinc-800 text-lg font-bold text-zinc-200 ring-1 ring-zinc-700">
          {initials}
        </span>
        <div className="min-w-0">
          <p className="text-base font-bold text-white">{user.full_name}</p>
          <p className="truncate text-sm text-zinc-400">{user.email}</p>
          <p className="mt-1 text-xs text-zinc-500">
            {roleLabel(role)}
            {user.venues?.length > 0 && ` · ${user.venues.map((v) => v.name).join(", ")}`}
          </p>
        </div>
      </div>

      {/* Datos propios */}
      <div className="card p-5">
        <h3 className="display mb-1 text-base">Tus datos</h3>
        <p className="mb-4 text-xs text-zinc-500">
          Tu nombre es el que ven tu equipo y quedó registrado en las boletas que emitas.
        </p>
        <form onSubmit={submitName} className="space-y-3">
          <div>
            <label htmlFor="full-name" className="mb-1 block text-xs font-medium text-zinc-400">
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
          <button type="submit" disabled={nameBusy || name.trim() === user.full_name} className="btn-primary disabled:opacity-40">
            {nameBusy ? "Guardando…" : "Guardar nombre"}
          </button>
        </form>
      </div>

      {/* Negocio (solo admins) */}
      {adminVenue && (
        <div className="card p-5">
          <h3 className="display mb-1 text-base">Tu negocio</h3>
          <p className="mb-4 text-xs text-zinc-500">
            El nombre y el logo representan tu negocio ante tu equipo y tus clientes.
          </p>
          <form onSubmit={submitVenue} className="space-y-3">
            <div>
              <label htmlFor="venue-name" className="mb-1 block text-xs font-medium text-zinc-400">
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
              <label htmlFor="venue-logo" className="mb-1 block text-xs font-medium text-zinc-400">
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
              {logoError && <p className="mt-1 text-xs text-amber-400">{logoError} — revisa la URL.</p>}
            </div>
            {venueMsg && (
              <div
                role="status"
                className={`rounded-lg border px-3 py-2 text-sm ${
                  venueMsg.ok
                    ? "border-emerald-800/60 bg-emerald-950/40 text-emerald-300"
                    : "border-red-900/60 bg-red-950/40 text-red-300"
                }`}
              >
                {venueMsg.text}
              </div>
            )}
            <button
              type="submit"
              disabled={venueBusy || (venueName.trim() === adminVenue.name && venueLogo === (adminVenue.logo_url || ""))}
              className="btn-primary disabled:opacity-40"
            >
              {venueBusy ? "Guardando…" : "Guardar negocio"}
            </button>
          </form>
        </div>
      )}

      {/* Cambiar contraseña */}
      <div className="card p-5">
        <h3 className="display mb-1 text-base">Cambiar contraseña</h3>
        <p className="mb-4 text-xs text-zinc-500">
          Se te pedirá la contraseña actual para confirmar que eres tú.
        </p>

        <form onSubmit={submitPassword} className="space-y-3">
          <div>
            <label htmlFor="cur-pass" className="mb-1 block text-xs font-medium text-zinc-400">
              Contraseña actual
            </label>
            <input
              id="cur-pass"
              type="password"
              value={curPass}
              onChange={(e) => setCurPass(e.target.value)}
              className="field"
              autoComplete="current-password"
              required
            />
          </div>

          <div>
            <label htmlFor="new-pass" className="mb-1 block text-xs font-medium text-zinc-400">
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
                required
              />
              <button
                type="button"
                onClick={() => setShowNew((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md px-2 py-1 text-xs font-semibold text-zinc-400 transition hover:text-zinc-200"
                aria-label={showNew ? "Ocultar contraseña" : "Mostrar contraseña"}
              >
                {showNew ? "Ocultar" : "Ver"}
              </button>
            </div>
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

      {/* Zona de peligro */}
      <div className="card border-red-900/40 p-5">
        <h3 className="display mb-1 text-base text-red-300">Zona de peligro</h3>
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
          <form onSubmit={submitDelete} className="space-y-3 rounded-lg border border-red-900/40 bg-red-950/20 p-4">
            <p className="text-sm text-red-200">
              Escribe tu contraseña para confirmar. Esta acción no tiene deshacer.
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
              <div role="alert" className="rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-300">
                {delErr}
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => { setDelOpen(false); setDelErr(""); setDelPass(""); }}
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
  );
}
