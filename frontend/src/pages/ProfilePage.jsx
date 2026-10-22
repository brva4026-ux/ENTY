import { useNavigate } from "react-router-dom";
import { useMemo, useRef, useState } from "react";
import { useAuth } from "../lib/auth";
import { apiFetch } from "../lib/api";
import { activeVenueId, setActiveVenueId } from "../lib/venue";
import { ROLE_LABELS, ROLE_VISUALS, topRole } from "../lib/roles";
import { useUI } from "../lib/ui";
import { haptics } from "../lib/haptics";
import Icon from "../components/Icon";
import PasswordMeter from "../components/PasswordMeter";
import ThemeChooser from "../components/ThemeChooser";
import { PushToggle } from "../components/PushToggle";
import useDocumentTitle from "../lib/useDocumentTitle";

const prefersReducedMotion =
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const roleLabel = (role) => ROLE_LABELS[role] ?? role;

/** Avatar con anillo del color del rol: un admin se distingue de un portero
 *  de un vistazo, sin leer la etiqueta. Decorativo: el nombre va al lado. */
function PremiumAvatar({ user, className: extraClass }) {
  const visual = ROLE_VISUALS[topRole(user)] ?? ROLE_VISUALS.bouncer;
  const initials = (user.full_name || "?")
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <span className={`pf-avatar ${visual.avatar} ${extraClass}`} aria-hidden="true">
      <span className={`pf-avatar-ring ${visual.tabAccent}`} />
      {initials}
    </span>
  );
}

/** Fecha larga ("14 de septiembre de 2026") para "miembro desde". */
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

/** Fecha relativa ("hoy", "hace 3 días") para el último ingreso. */
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

/** Cabecera de panel: un `h2` por panel, colgando del `h1` del hero. */
function PanelHead({ title, hint }) {
  return (
    <header className="pf-panel-head">
      <h2 className="pf-panel-title">{title}</h2>
      {hint && <p className="pf-panel-hint">{hint}</p>}
    </header>
  );
}

/** Campo con etiqueta y ayuda. Una sola etiqueta por control: el control va
 *  dentro del `label`, así el nombre accesible sale del texto visible. */
function Field({ id, label, hint, children }) {
  return (
    <label className="pf-field" htmlFor={id}>
      <span className="pf-label">{label}</span>
      {children}
      {hint && <span className="pf-hint">{hint}</span>}
    </label>
  );
}

/** Página de perfil: la ficha de la persona (identidad, cuenta, seguridad,
 *  negocio y preferencias) con la eliminación de cuenta separada al pie.
 *  Una cosa a la vez: cada bloque vive en su pestaña, no todo apilado. */
export default function ProfilePage() {
  useDocumentTitle("Tu perfil");
  const { user, logout, setUser } = useAuth();
  const nav = useNavigate();
  const ui = useUI();

  // Negocio activo (multi-negocio): estado local para re-pintar el selector
  // al instante; los paneles leen el valor persistido en cada carga.
  const [currentVenueId, setCurrentVenueId] = useState(() => activeVenueId(user));

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
    adminVenue?.commission_pct != null ? String(adminVenue.commission_pct) : "0",
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

  const dangerRef = useRef(null);

  // El negocio solo aparece como pestaña propia si administra alguno: para el
  // resto era una tarjeta que nunca se pintaba y dejaba un hueco.
  const tabs = useMemo(
    () => [
      { id: "cuenta", label: "Cuenta", icon: "users" },
      { id: "seguridad", label: "Seguridad", icon: "shield" },
      ...(adminVenue ? [{ id: "negocio", label: "Negocio", icon: "money" }] : []),
      { id: "preferencias", label: "Preferencias", icon: "sparkle" },
    ],
    [adminVenue],
  );

  const [tab, setTab] = useState("cuenta");
  // Si el negocio desaparece (dejó de ser admin), la pestaña activa no puede
  // quedar apuntando a un panel que ya no existe.
  const activeTab = tabs.some((t) => t.id === tab) ? tab : tabs[0].id;

  if (!user) return null;

  // Rol de cabecera = el más alto (mismo criterio que el topbar), y su
  // identidad visual sale de ROLE_VISUALS para no divergir del equipo.
  const role = topRole(user) ?? "bouncer";
  const visual = ROLE_VISUALS[role] ?? ROLE_VISUALS.bouncer;

  const memberSince = longDate(user.created_at);
  const lastSeen = sinceLabel(user.last_login_at);
  const venueCount = user.venues?.length || 0;

  function selectTab(id) {
    setTab(id);
    haptics.tick();
  }

  // Navegación por teclado del patrón ARIA tabs (flechas + Home/End).
  function onTabKeyDown(e) {
    const ids = tabs.map((t) => t.id);
    const i = ids.indexOf(activeTab);
    let next = null;
    if (e.key === "ArrowRight") next = ids[(i + 1) % ids.length];
    else if (e.key === "ArrowLeft") next = ids[(i - 1 + ids.length) % ids.length];
    else if (e.key === "Home") next = ids[0];
    else if (e.key === "End") next = ids[ids.length - 1];
    if (!next) return;
    e.preventDefault();
    selectTab(next);
    document.getElementById(`pf-tab-${next}`)?.focus();
  }

  function goToDanger() {
    setDelOpen(true);
    dangerRef.current?.scrollIntoView({
      behavior: prefersReducedMotion ? "auto" : "smooth",
      block: "start",
    });
  }

  async function submitPassword(e) {
    e.preventDefault();
    setPassMsg(null);
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
      setPassMsg({ ok: true, text: res.detail });
      setCurPass("");
      setNewPass("");
      ui.success(res.detail);
    } catch (err) {
      setPassMsg({ ok: false, text: err.message });
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
      {/* Hero de identidad: la ficha de la persona, no un formulario. Fijo
          arriba: quién eres no cambia al moverte entre pestañas. */}
      <div className="pf-hero">
        <div className="pf-hero-main">
          <PremiumAvatar user={user} />

          <div className="pf-hero-id">
            <p className="eyebrow">Tu perfil</p>
            <h1 className="pf-name">{user.full_name}</h1>
            <p className="pf-email">{user.email}</p>

            {/* Roles por negocio: cada negocio con el chip de su rol. */}
            {venueCount > 0 && (
              <div className="pf-chips">
                {user.venues.map((v) => {
                  const vRoles = user.roles?.[String(v.id)] || [];
                  const vRole = topRole({ roles: { [String(v.id)]: vRoles } });
                  const vVisual = ROLE_VISUALS[vRole] ?? visual;
                  return (
                    <span key={v.id} className={`pf-role-chip ${vVisual.tabAccent}`}>
                      {v.name}
                      {vRole && <span className="pf-chip-role">· {roleLabel(vRole)}</span>}
                    </span>
                  );
                })}
              </div>
            )}

            {/* Contexto de cuenta: desde cuándo y último ingreso. */}
            {(memberSince || lastSeen) && (
              <div className="pf-meta">
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

          {/* Acciones de la sesión: el perfil es donde se cierra sesión. */}
          <div className="pf-hero-actions">
            <button
              type="button"
              onClick={() => {
                logout();
                nav("/login", { replace: true });
              }}
              className="btn-ghost pf-action"
            >
              <Icon name="logout" className="h-4 w-4" aria-hidden="true" />
              Cerrar sesión
            </button>
            <button
              type="button"
              onClick={goToDanger}
              className="btn-ghost pf-action pf-action-danger"
            >
              <Icon name="alert" className="h-4 w-4" aria-hidden="true" />
              Zona de peligro
            </button>
          </div>
        </div>
      </div>

      {/* Pestañas: una cosa a la vez en lugar de un scroll con todo a la vista. */}
      <div
        className="tabbar no-scrollbar pf-tabs"
        role="tablist"
        aria-label="Secciones del perfil"
      >
        {tabs.map((t) => {
          const active = t.id === activeTab;
          return (
            <button
              key={t.id}
              id={`pf-tab-${t.id}`}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={`pf-panel-${t.id}`}
              tabIndex={active ? 0 : -1}
              onClick={() => selectTab(t.id)}
              onKeyDown={onTabKeyDown}
              className="tabbar-item"
            >
              <Icon name={t.icon} className="h-4 w-4" aria-hidden="true" />
              {t.label}
            </button>
          );
        })}
      </div>

      {/* ---------------- Cuenta ---------------- */}
      {activeTab === "cuenta" && (
        <section
          id="pf-panel-cuenta"
          role="tabpanel"
          aria-labelledby="pf-tab-cuenta"
          tabIndex={0}
          className="card pf-panel"
        >
          <PanelHead
            title="Tus datos"
            hint="Tu nombre es el que ve tu equipo y queda registrado en las boletas que emites."
          />
          <form onSubmit={submitName} className="pf-form">
            <Field
              id="full-name"
              label="Nombre completo"
              hint="Tu nombre tal como aparecerá en las boletas."
            >
              <input
                id="full-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="field"
                maxLength={120}
                minLength={2}
                required
              />
            </Field>

            {nameMsg && (
              <div role="alert" className="pf-alert pf-alert-bad">
                {nameMsg.text}
              </div>
            )}

            <div className="pf-form-actions">
              <button
                type="submit"
                disabled={nameBusy || name.trim() === user.full_name}
                className="btn-primary"
              >
                {nameBusy ? "Guardando…" : "Guardar nombre"}
              </button>
            </div>
          </form>

          <div className="pf-sub">
            <h3 className="pf-sub-title">Correo</h3>
            <div className="pf-readonly">
              <Icon name="link" className="h-4 w-4" aria-hidden="true" />
              <span className="pf-readonly-value">{user.email}</span>
            </div>
            <p className="pf-hint">
              El correo identifica tu cuenta y no se cambia desde aquí.
            </p>
          </div>

          {/* Negocio activo (solo si pertenece a varios): qué panel abre y
              sobre qué venue trabaja cada pantalla. */}
          {venueCount > 1 && (
            <div className="pf-sub">
              <h3 className="pf-sub-title">Negocio activo</h3>
              <p className="pf-hint pf-hint-block">
                Trabajas con varios negocios: elige con cuál abren los paneles.
              </p>
              <div className="pf-venue-grid">
                {user.venues.map((v) => {
                  const active = v.id === currentVenueId;
                  return (
                    <button
                      key={v.id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => {
                        setActiveVenueId(v.id);
                        setCurrentVenueId(v.id);
                        haptics.tick();
                      }}
                      className={`pf-venue ${active ? "is-on" : ""}`}
                    >
                      <span className="pf-venue-body">
                        <span className="pf-venue-name">{v.name}</span>
                        <span className="pf-venue-roles">
                          {(user.roles?.[String(v.id)] || []).map(roleLabel).join(", ")}
                        </span>
                      </span>
                      {active && <span className="pf-venue-badge">Activa</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </section>
      )}

      {/* ---------------- Seguridad ---------------- */}
      {activeTab === "seguridad" && (
        <section
          id="pf-panel-seguridad"
          role="tabpanel"
          aria-labelledby="pf-tab-seguridad"
          tabIndex={0}
          className="card pf-panel"
        >
          <PanelHead
            title="Cambiar contraseña"
            hint="Se te pedirá la contraseña actual para confirmar que eres tú. Al cambiarla se cierran las demás sesiones abiertas."
          />
          <form onSubmit={submitPassword} className="pf-form">
            <Field
              id="cur-pass"
              label="Contraseña actual"
              hint="Se usará para confirmar tu identidad al actualizar."
            >
              <div className="pf-input-wrap">
                <input
                  id="cur-pass"
                  type={showCur ? "text" : "password"}
                  value={curPass}
                  onChange={(e) => setCurPass(e.target.value)}
                  className="field"
                  autoComplete="current-password"
                  maxLength={128}
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowCur((v) => !v)}
                  className="pf-input-btn"
                  aria-label={showCur ? "Ocultar contraseña" : "Mostrar contraseña"}
                >
                  {showCur ? "Ocultar" : "Ver"}
                </button>
              </div>
            </Field>

            <Field id="new-pass" label="Nueva contraseña (mínimo 8 caracteres)">
              <div className="pf-input-wrap">
                <input
                  id="new-pass"
                  type={showNew ? "text" : "password"}
                  value={newPass}
                  onChange={(e) => setNewPass(e.target.value)}
                  className="field"
                  autoComplete="new-password"
                  minLength={8}
                  maxLength={128}
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowNew((v) => !v)}
                  className="pf-input-btn"
                  aria-label={showNew ? "Ocultar contraseña" : "Mostrar contraseña"}
                >
                  {showNew ? "Ocultar" : "Ver"}
                </button>
              </div>
              {newPass && <PasswordMeter value={newPass} idPrefix="new-pass" />}
            </Field>

            {passMsg && (
              <div
                role="status"
                className={`pf-alert ${passMsg.ok ? "pf-alert-ok" : "pf-alert-bad"}`}
              >
                {passMsg.text}
              </div>
            )}

            <div className="pf-form-actions">
              <button type="submit" disabled={passBusy} className="btn-primary">
                {passBusy ? "Guardando…" : "Actualizar contraseña"}
              </button>
            </div>
          </form>
        </section>
      )}

      {/* ---------------- Negocio (solo admin) ---------------- */}
      {activeTab === "negocio" && adminVenue && (
        <section
          id="pf-panel-negocio"
          role="tabpanel"
          aria-labelledby="pf-tab-negocio"
          tabIndex={0}
          className="card pf-panel"
        >
          <PanelHead
            title="Tu negocio"
            hint="El nombre y el logo representan tu negocio ante tu equipo y tus clientes."
          />
          <form onSubmit={submitVenue} className="pf-form">
            <Field id="venue-name" label="Nombre del negocio">
              <input
                id="venue-name"
                value={venueName}
                onChange={(e) => setVenueName(e.target.value)}
                className="field"
                maxLength={120}
                minLength={2}
                required
              />
            </Field>

            <Field id="venue-logo" label="Logo (URL de imagen)">
              <div className="pf-logo-row">
                {venueLogo && !logoError ? (
                  <img
                    src={venueLogo}
                    alt="Logo actual"
                    onError={() => setLogoError("No se pudo cargar la imagen")}
                    className="pf-logo"
                  />
                ) : (
                  <span className="pf-logo pf-logo-empty" aria-hidden="true">
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
                <span className="pf-hint pf-hint-warn">{logoError} — revisa la URL.</span>
              )}
            </Field>

            {/* Comisión del promotor: base de las liquidaciones (se congela
                por liquidación al cerrar el periodo). */}
            <Field
              id="venue-commission"
              label="Comisión del promotor (%)"
              hint="Se aplica al recaudo de cada promotor al cerrar su liquidación."
            >
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
            </Field>

            <div className="pf-form-actions">
              <button
                type="submit"
                disabled={
                  venueBusy ||
                  (venueName.trim() === adminVenue.name &&
                    venueLogo === (adminVenue.logo_url || "") &&
                    venueCommission === String(adminVenue.commission_pct ?? 0))
                }
                className="btn-primary"
              >
                {venueBusy ? "Guardando…" : "Guardar negocio"}
              </button>
            </div>
          </form>
        </section>
      )}

      {/* ---------------- Preferencias ---------------- */}
      {activeTab === "preferencias" && (
        <section
          id="pf-panel-preferencias"
          role="tabpanel"
          aria-labelledby="pf-tab-preferencias"
          tabIndex={0}
          className="card pf-panel"
        >
          <PanelHead
            title="Apariencia"
            hint='El modo "Sistema" sigue la preferencia de tu dispositivo. La puerta (escáner) siempre es oscura: un flash de blanco en un recinto a oscuras ciega.'
          />
          <ThemeChooser />

          <div className="pf-sub">
            <h3 className="pf-sub-title">Avisos</h3>
            <p className="pf-hint pf-hint-block">
              Elige si quieres que te avisemos cuando abran puertas en tu negocio.
            </p>
            <PushToggle venueId={currentVenueId} />
          </div>
        </section>
      )}

      {/* Zona de peligro: lo destructivo no vive "a la vista" junto a lo demás.
          Se separa con el troquel de la casa y arranca colapsado. */}
      <div className="pf-danger-wrap" ref={dangerRef}>
        <div className="enty-perf" aria-hidden="true" />
        <section className="card pf-danger" aria-labelledby="pf-danger-title">
          <h2 id="pf-danger-title" className="pf-danger-title">
            Zona de peligro
          </h2>
          <p className="pf-danger-copy">
            Eliminar tu cuenta es permanente. Si eres el único administrador con
            equipo a cargo, deberás asignar otro admin antes. Si eres el único
            miembro, tu negocio entero se elimina con ella.
          </p>

          {!delOpen ? (
            <button
              type="button"
              onClick={() => setDelOpen(true)}
              className="btn-ghost pf-action pf-action-danger"
            >
              <Icon name="trash" className="h-4 w-4" aria-hidden="true" />
              Eliminar mi cuenta…
            </button>
          ) : (
            <form onSubmit={submitDelete} className="pf-delete-form">
              <p className="pf-delete-warn">
                Escribe tu contraseña para confirmar. Esta acción no tiene
                deshacer.
              </p>
              <label className="pf-field" htmlFor="del-pass">
                <span className="pf-label">Tu contraseña</span>
                <input
                  id="del-pass"
                  type="password"
                  value={delPass}
                  onChange={(e) => setDelPass(e.target.value)}
                  className="field"
                  placeholder="Tu contraseña"
                  autoComplete="current-password"
                  required
                />
              </label>
              {delErr && (
                <div role="alert" className="pf-alert pf-alert-bad">
                  {delErr}
                </div>
              )}
              <div className="pf-form-actions">
                <button
                  type="button"
                  onClick={() => {
                    setDelOpen(false);
                    setDelErr("");
                    setDelPass("");
                  }}
                  className="btn-ghost"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={delBusy || !delPass}
                  className="pf-delete-btn"
                >
                  {delBusy ? "Eliminando…" : "Eliminar definitivamente"}
                </button>
              </div>
            </form>
          )}
        </section>
      </div>
    </div>
  );
}
