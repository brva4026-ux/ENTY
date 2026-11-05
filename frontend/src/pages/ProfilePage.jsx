import { useNavigate, useSearchParams } from "react-router-dom";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../lib/auth";
import { apiFetch } from "../lib/api";
import { activeVenueId, setActiveVenueId } from "../lib/venue";
import { ROLE_LABELS, ROLE_VISUALS, topRole } from "../lib/roles";
import { useUI } from "../lib/ui";
import { haptics } from "../lib/haptics";
import { prefersReducedMotion } from "../lib/motion";
import Icon from "../components/Icon";
import PasswordMeter from "../components/PasswordMeter";
import ThemeChooser from "../components/ThemeChooser";
import MotionChooser from "../components/MotionChooser";
import { PushToggle } from "../components/PushToggle";
import useDocumentTitle from "../lib/useDocumentTitle";

const roleLabel = (role) => ROLE_LABELS[role] ?? role;

/** Paleta sugerida para el color de marca. Son los pasos 500 de los tokens de
 *  la casa, en hex porque el backend guarda #RRGGBB y no resuelve variables. */
const BRAND_COLORS = [
  { name: "Violeta de Enty", hex: "#7c3aed" },
  { name: "Verde menta", hex: "#00e6ab" },
  { name: "Esmeralda", hex: "#059669" },
  { name: "Rosa", hex: "#ff2d98" },
  { name: "Ámbar", hex: "#f5a524" },
  { name: "Rojo", hex: "#ef4444" },
];
const BRAND_DEFAULT = "#7c3aed";

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
  const [searchParams, setSearchParams] = useSearchParams();

  // Negocio activo (multi-negocio): estado local para re-pintar el selector
  // al instante; los paneles leen el valor persistido en cada carga.
  const [currentVenueId, setCurrentVenueId] = useState(() => activeVenueId(user));

  // Edición de datos propios
  const [name, setName] = useState(user?.full_name || "");
  // Nombre de usuario para entrar (mig 035). "" es valido: libera el usuario y
  // la cuenta vuelve a entrar solo con correo.
  const [username, setUsername] = useState(user?.username || "");
  // Telefono de contacto: la columna existia en la DB pero el perfil no la
  // mostraba. Opcional, y se guarda tal como se escribe.
  const [phone, setPhone] = useState(user?.phone || "");
  const [nameMsg, setNameMsg] = useState(null);
  const [nameBusy, setNameBusy] = useState(false);

  // Edición del negocio: se edita el negocio ACTIVO si lo administra y, si
  // no, el primero que administre. Antes era siempre el primero de la lista,
  // así que el enlace del header (/perfil?tab=negocio) podía abrir un negocio
  // distinto del que la persona estaba viendo.
  const isAdminOf = (v) => (user?.roles?.[String(v.id)] || []).includes("admin");
  const adminVenue =
    (user?.venues || []).find((v) => v.id === currentVenueId && isAdminOf(v)) ??
    (user?.venues || []).find(isAdminOf) ??
    null;
  const [venueName, setVenueName] = useState(adminVenue?.name || "");
  const [venueLogo, setVenueLogo] = useState(adminVenue?.logo_url || "");
  // Color de marca: viaja como #RRGGBB. "" = sin color propio (violeta de Enty).
  const [venueColor, setVenueColor] = useState(adminVenue?.primary_color || "");
  const [venueCommission, setVenueCommission] = useState(
    adminVenue?.commission_pct != null ? String(adminVenue.commission_pct) : "0",
  );
  // Contacto del organizador (mig 036): lo que la pagina publica muestra en
  // "encargar por WhatsApp". "" lo deja sin publicar.
  const [venueContactName, setVenueContactName] = useState(
    adminVenue?.contact_name || "",
  );
  const [venueContactPhone, setVenueContactPhone] = useState(
    adminVenue?.contact_phone || "",
  );
  const [logoError, setLogoError] = useState("");
  const [venueMsg, setVenueMsg] = useState(null);
  const [venueBusy, setVenueBusy] = useState(false);

  // Cambio de contraseña
  const [curPass, setCurPass] = useState("");
  const [showCur, setShowCur] = useState(false);
  const [newPass, setNewPass] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [passMsg, setPassMsg] = useState(null); // {ok, text}
  const [passBusy, setPassBusy] = useState(false);

  // Cierre de las demás sesiones
  const [sessOpen, setSessOpen] = useState(false);
  const [sessPass, setSessPass] = useState("");
  const [sessMsg, setSessMsg] = useState(null);
  const [sessBusy, setSessBusy] = useState(false);

  // Descarga de los propios datos
  const [exportBusy, setExportBusy] = useState(false);

  // Borrado de cuenta
  const [delOpen, setDelOpen] = useState(false);
  const [delPass, setDelPass] = useState("");
  const [delConfirm, setDelConfirm] = useState("");
  const [delErr, setDelErr] = useState("");
  const [delBusy, setDelBusy] = useState(false);

  const tabbarRef = useRef(null);

  // Cambios pendientes de guardar: exactamente los mismos predicados que
  // apagan el botón. Antes el botón se veía apagado sin decir por qué, y el
  // usuario no sabía si era un fallo o que no había nada que guardar.
  const nameDirty =
    name.trim() !== (user?.full_name || "") ||
    username.trim().toLowerCase() !== (user?.username || "") ||
    phone.trim() !== (user?.phone || "");
  const venueDirty =
    !!adminVenue &&
    (venueName.trim() !== adminVenue.name ||
      venueLogo !== (adminVenue.logo_url || "") ||
      venueCommission !== String(adminVenue.commission_pct ?? 0) ||
      venueColor !== (adminVenue.primary_color || "") ||
      venueContactName !== (adminVenue.contact_name || "") ||
      venueContactPhone !== (adminVenue.contact_phone || ""));
  const brandColor = venueColor || BRAND_DEFAULT;

  // El formulario del negocio se recarga al cambiar de negocio activo. Se
  // dispara por id, no por el objeto: guardar devuelve una venue nueva y no
  // queremos pisar lo que la persona escribe ni el mensaje de confirmación.
  const venueFormId = adminVenue?.id ?? null;
  useEffect(() => {
    setVenueName(adminVenue?.name || "");
    setVenueLogo(adminVenue?.logo_url || "");
    setVenueColor(adminVenue?.primary_color || "");
    setVenueCommission(
      adminVenue?.commission_pct != null ? String(adminVenue.commission_pct) : "0",
    );
    setVenueContactName(adminVenue?.contact_name || "");
    setVenueContactPhone(adminVenue?.contact_phone || "");
    setLogoError("");
    setVenueMsg(null);
  }, [venueFormId]);

  // El negocio solo aparece como pestaña propia si administra alguno: para el
  // resto era una tarjeta que nunca se pintaba y dejaba un hueco.
  const tabs = useMemo(
    () => [
      { id: "cuenta", label: "Cuenta", icon: "users", dirty: nameDirty },
      { id: "seguridad", label: "Seguridad", icon: "shield" },
      ...(adminVenue
        ? [{ id: "negocio", label: "Negocio", icon: "money", dirty: venueDirty }]
        : []),
      { id: "preferencias", label: "Preferencias", icon: "sparkle" },
    ],
    [adminVenue, nameDirty, venueDirty],
  );

  // La pestaña vive SOLO en la URL: una única fuente de verdad. Con estado
  // aparte habría que sincronizarlo a mano con el botón atrás, y ahí es donde
  // se desincronizan la URL y lo que se ve.
  // Si el negocio desaparece (dejó de ser admin), la pestaña pedida puede
  // apuntar a un panel que ya no existe: se cae a la primera.
  const rawTab = searchParams.get("tab");
  const requestedTab = (rawTab || "cuenta").toLowerCase();
  const activeTab = tabs.some((t) => t.id === requestedTab)
    ? requestedTab
    : tabs[0].id;

  // URL canónica: minúsculas, sin `tab` para Cuenta y solo pestañas que
  // existen para este usuario. Antes `?tab=negocio` sin ser admin caía a
  // Cuenta dejando la barra de direcciones afirmando otra cosa. `replace`:
  // corregir la URL no debe sumar una entrada de historial.
  const canonicalTab = activeTab === "cuenta" ? null : activeTab;
  const tabIsCanonical = (rawTab ?? null) === canonicalTab;
  useEffect(() => {
    if (tabIsCanonical) return;
    const next = new URLSearchParams(searchParams);
    if (canonicalTab === null) next.delete("tab");
    else next.set("tab", canonicalTab);
    setSearchParams(next, { replace: true });
  }, [tabIsCanonical, canonicalTab, searchParams, setSearchParams]);

  // Al cambiar de pestaña el panel se trae a la vista: si estabas al final de
  // un panel largo, la nueva pestaña empezaba a media altura y con su título
  // bajo la barra pegajosa. En el primer render no se toca el scroll.
  const firstTabRender = useRef(true);
  useEffect(() => {
    if (firstTabRender.current) {
      firstTabRender.current = false;
      return;
    }
    document.getElementById(`pf-panel-${activeTab}`)?.scrollIntoView({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      block: "start",
    });
  }, [activeTab]);

  // El indicador deslizante mide la pestaña activa: las pestañas cambian de
  // posición según el rol, así que la geometría no se puede saber en CSS.
  // useLayoutEffect: se mide antes del paint, para que el indicador no
  // aparezca un frame en la posición anterior.
  useLayoutEffect(() => {
    const el = tabbarRef.current;
    if (!el) return;
    const measure = () => {
      const active = el.querySelector('[aria-selected="true"]');
      if (!active) return;
      // offsetLeft (y no rect + scrollLeft): el indicador es absoluto dentro
      // del scroller, así que vive en el espacio del contenido y ya se
      // desplaza con él. Restarle scrollLeft lo desfasa justo ese tanto, y
      // medir con getBoundingClientRect se rompe si un ancestro lleva
      // transform (la escala se cuela en la cuenta).
      el.style.setProperty("--pf-tab-x", `${active.offsetLeft}px`);
      el.style.setProperty("--pf-tab-w", `${active.offsetWidth}px`);
      // Con enlace directo o "atrás" la barra puede venir scrolleada y la
      // pestaña activa quedar fuera del tramo visible: el subrayado estaría
      // bien puesto pero no se vería. `nearest` no mueve nada si ya se ve.
      active.scrollIntoView({ inline: "nearest", block: "nearest" });
    };
    measure();
    // Al girar el teléfono o cambiar el ancho, las pestañas se reacomodan.
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [activeTab, tabs]);

  if (!user) return null;

  // Rol de cabecera = el más alto (mismo criterio que el topbar), y su
  // identidad visual sale de ROLE_VISUALS para no divergir del equipo.
  const role = topRole(user) ?? "bouncer";
  const visual = ROLE_VISUALS[role] ?? ROLE_VISUALS.bouncer;

  const memberSince = longDate(user.created_at);
  const lastSeen = sinceLabel(user.last_login_at);
  const venueCount = user.venues?.length || 0;
  // Cuántos de esos negocios administra: es el dato que hace concreta la
  // advertencia de la zona de peligro.
  const adminCount =
    user.venues?.filter((v) =>
      (user.roles?.[String(v.id)] || []).includes("admin"),
    ).length || 0;

  function selectTab(id) {
    haptics.tick();
    // La pestaña vive en la URL: se puede enlazar ("/perfil?tab=seguridad").
    // `replace` y no push: moverse entre pestañas no es navegar. Con push,
    // cuatro pestañas eran cuatro toques de "atrás" antes de salir del
    // perfil. La entrada la apila el enlace que trajo aquí (/perfil desde el
    // menú, o el lockup del header con ?tab=negocio), así que "atrás" sale
    // del perfil de una vez.
    // Solo se toca `tab`: un objeto nuevo borraba el resto del query
    // (`?from=`, parámetros de campaña) al cambiar de pestaña.
    const next = new URLSearchParams(searchParams);
    if (id === "cuenta") next.delete("tab");
    else next.set("tab", id);
    setSearchParams(next, { replace: true });
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
        // Nombre y usuario van juntos: el backend valida el formato y responde
        // 409 si el usuario ya esta tomado. El catch de abajo muestra ese
        // mensaje real en vez de un texto generico.
        body: JSON.stringify({
          full_name: name,
          username: username.trim(),
          phone: phone.trim(),
        }),
      });
      setUser(updated);
      setNameMsg({ ok: true, text: "Datos actualizados." });
    } catch (err) {
      setNameMsg({ ok: false, text: err.message });
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
          primary_color: venueColor,
          contact_name: venueContactName,
          contact_phone: venueContactPhone,
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
                primary_color: updated.primary_color,
                contact_name: updated.contact_name,
                contact_phone: updated.contact_phone,
              }
            : v,
        ),
      });
      setVenueMsg({ ok: true, text: "Datos del negocio actualizados." });
    } catch (err) {
      setVenueMsg({ ok: false, text: err.message });
    } finally {
      setVenueBusy(false);
    }
  }

  async function submitCloseSessions(e) {
    e.preventDefault();
    setSessMsg(null);
    setSessBusy(true);
    try {
      const res = await apiFetch("/auth/close-other-sessions", {
        method: "POST",
        body: JSON.stringify({ password: sessPass }),
      });
      // El backend invalida TODOS los tokens (bump de token_version) y nos
      // devuelve uno nuevo: si no lo guardáramos, esta misma sesión caería
      // al login junto con las demás.
      localStorage.setItem("tf_token", res.access_token);
      setUser(res.user);
      setSessPass("");
      setSessOpen(false);
      setSessMsg({
        ok: true,
        text: "Listo: las demás sesiones quedaron cerradas. Esta sigue abierta.",
      });
      haptics.success();
    } catch (err) {
      setSessMsg({ ok: false, text: err.message });
    } finally {
      setSessBusy(false);
    }
  }

  /** Descarga de los propios datos como JSON.
   *  Se usa fetch + blob (no un <a href>): el token viaja en el header, nunca
   *  en la URL, y así no queda en el historial ni en los logs del servidor. */
  async function downloadData() {
    setExportBusy(true);
    try {
      const data = await apiFetch("/auth/export");
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "mis-datos-enty.json";
      a.click();
      URL.revokeObjectURL(a.href);
      haptics.success();
      ui.success("Descargamos tus datos.");
    } catch (err) {
      ui.error(err.message);
    } finally {
      setExportBusy(false);
    }
  }

  async function submitDelete(e) {
    e.preventDefault();
    setDelErr("");
    setDelBusy(true);
    try {
      await apiFetch("/auth/account", {
        method: "DELETE",
        body: JSON.stringify({ password: delPass, confirm: delConfirm }),
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
          </div>
        </div>
      </div>

      {/* Pestañas: una cosa a la vez en lugar de un scroll con todo a la vista. */}
      <div
        ref={tabbarRef}
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
              aria-label={
                t.dirty ? `${t.label} (cambios sin guardar)` : t.label
              }
              className="tabbar-item"
            >
              <Icon name={t.icon} className="h-4 w-4" aria-hidden="true" />
              <span className="pf-tab-label">{t.label}</span>
              {t.dirty && <span className="pf-tab-dot" aria-hidden="true" />}
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
                onChange={(e) => {
                  setName(e.target.value);
                  setNameMsg(null);
                }}
                className="field"
                maxLength={120}
                minLength={2}
                required
              />
            </Field>

            <Field
              id="username"
              label="Usuario"
              hint="Con esto entras sin escribir el correo. Minúsculas, números, punto, guion o guion bajo (3 a 32). Déjalo vacío para entrar solo con tu correo."
            >
              <input
                id="username"
                value={username}
                onChange={(e) => {
                  setUsername(e.target.value);
                  setNameMsg(null);
                }}
                className="field"
                maxLength={32}
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="tu.usuario"
              />
            </Field>

            <Field
              id="phone"
              label="Teléfono de contacto"
              hint="Opcional. Queda en tu ficha de cuenta para que tu equipo te ubique; no se publica en la página del evento. Déjalo vacío para no tener teléfono."
            >
              <input
                id="phone"
                type="tel"
                inputMode="tel"
                value={phone}
                onChange={(e) => {
                  setPhone(e.target.value);
                  setNameMsg(null);
                }}
                className="field"
                maxLength={30}
                autoComplete="tel"
                placeholder="+57 300 123 4567"
              />
            </Field>

            {nameMsg && (
              <div
                role={nameMsg.ok ? "status" : "alert"}
                className={`pf-alert ${nameMsg.ok ? "pf-alert-ok" : "pf-alert-bad"}`}
              >
                {nameMsg.text}
              </div>
            )}

            <div className="pf-form-actions">
              <button
                type="submit"
                disabled={nameBusy || !nameDirty}
                className="btn-primary"
              >
                {nameBusy ? "Guardando…" : "Guardar datos"}
              </button>
              {nameDirty && !nameBusy && (
                <span className="pf-dirty-chip">Cambios sin guardar</span>
              )}
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

          <div className="pf-sub">
            <h3 className="pf-sub-title">Sesiones abiertas</h3>
            <p className="pf-hint pf-hint-block">
              Si dejaste la sesión abierta en otro dispositivo o crees que
              alguien más entró, ciérralas todas de una vez. Esta sesión se
              mantiene abierta.
            </p>

            {!sessOpen ? (
              <button
                type="button"
                onClick={() => {
                  setSessMsg(null);
                  setSessOpen(true);
                }}
                className="btn-ghost pf-action"
              >
                <Icon name="shield" className="h-4 w-4" aria-hidden="true" />
                Cerrar las demás sesiones…
              </button>
            ) : (
              <form onSubmit={submitCloseSessions} className="pf-form">
                <Field
                  id="sess-pass"
                  label="Confirma tu contraseña"
                  hint="Pedimos tu contraseña para que nadie más pueda expulsarte de tu propia cuenta."
                >
                  <div className="pf-input-wrap">
                    <input
                      id="sess-pass"
                      type="password"
                      value={sessPass}
                      onChange={(e) => setSessPass(e.target.value)}
                      className="field"
                      autoComplete="current-password"
                      required
                    />
                  </div>
                </Field>
                <div className="pf-form-actions">
                  <button
                    type="button"
                    onClick={() => {
                      setSessOpen(false);
                      setSessPass("");
                      setSessMsg(null);
                    }}
                    className="btn-ghost"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    disabled={sessBusy}
                    className="btn-primary"
                  >
                    {sessBusy ? "Cerrando…" : "Cerrar las demás"}
                  </button>
                </div>
              </form>
            )}

            {sessMsg && (
              <div
                role="status"
                className={`pf-alert ${sessMsg.ok ? "pf-alert-ok" : "pf-alert-bad"}`}
              >
                {sessMsg.text}
              </div>
            )}
          </div>

          <div className="pf-sub">
            <h3 className="pf-sub-title">Descargar mi información</h3>
            <p className="pf-hint pf-hint-block">
              Descarga una copia de lo que Enty sabe de tu cuenta: tus datos,
              tus negocios y los documentos que aceptaste. Tus contraseñas y
              los datos de tus clientes no se incluyen.
            </p>
            <button
              type="button"
              onClick={downloadData}
              disabled={exportBusy}
              className="btn-ghost pf-action"
            >
              <Icon name="download" className="h-4 w-4" aria-hidden="true" />
              {exportBusy ? "Preparando…" : "Descargar mis datos (JSON)"}
            </button>
          </div>
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
            {/* Seis campos en columna se leían como un muro. Los títulos no
                envuelven nada: agrupan con la viga del sistema y dejan el
                ritmo del grid intacto. */}
            <h3 className="pf-sub-title">Identidad</h3>
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

            {/* Color de marca: tiñe la portada del panel (banner, tile y viga
                del KPI). Vacío = violeta de Enty. El <input type="color"> no
                admite "sin valor", así que el botón "Quitar" es el que vuelve
                al color por defecto. */}
            <Field
              id="venue-color"
              label="Color de marca"
              hint="Se usa en la portada de tu panel. Sin elegir, usa el violeta de Enty."
            >
              <div className="pf-color-row">
                <input
                  id="venue-color"
                  type="color"
                  value={brandColor}
                  onChange={(e) => setVenueColor(e.target.value)}
                  className="pf-color-input"
                  aria-label="Color de marca"
                />
                <span className="pf-color-value">
                  {venueColor || "Violeta de Enty"}
                </span>
                {venueColor && (
                  <button
                    type="button"
                    onClick={() => setVenueColor("")}
                    className="btn-ghost !px-2.5 !py-1 text-xs"
                    aria-label="Quitar el color propio y volver al violeta de Enty"
                  >
                    Quitar
                  </button>
                )}
              </div>
            </Field>

            {/* El selector nativo no dice qué cambia: las muestras evitan
                adivinar un hex y la vista previa enseña el resultado. */}
            <div className="pf-colors">
              <span id="pf-swatches-label" className="pf-label">
                Colores sugeridos
              </span>
              <div
                className="pf-swatches"
                role="group"
                aria-labelledby="pf-swatches-label"
              >
                {BRAND_COLORS.map((c) => (
                  <button
                    key={c.hex}
                    type="button"
                    onClick={() => setVenueColor(c.hex)}
                    aria-pressed={venueColor.toLowerCase() === c.hex}
                    aria-label={c.name}
                    className={`pf-swatch ${
                      venueColor.toLowerCase() === c.hex ? "is-on" : ""
                    }`}
                    style={{ background: c.hex }}
                  />
                ))}
              </div>
              <div className="pf-brand-preview" aria-hidden="true">
                <span
                  className="pf-brand-preview-banner"
                  style={{ background: brandColor }}
                />
                <span className="pf-brand-preview-copy">
                  Así se verá el banner de tu portada
                </span>
              </div>
            </div>

            {/* Contacto del organizador (mig 036): es lo que la pagina publica
                muestra en "encargar por WhatsApp". Quien organiza esa noche
                responde por el telefono; sin el, el evento solo vende en linea. */}
            <h3 className="pf-sub-title">Contacto público</h3>
            <Field
              id="venue-contact-name"
              label="Nombre del encargado"
              hint="Aparece en la pagina publica: a quien le escriben para encargar boleta."
            >
              <input
                id="venue-contact-name"
                value={venueContactName}
                onChange={(e) => setVenueContactName(e.target.value)}
                className="field"
                maxLength={80}
                placeholder="Ej: Reservas Bar Esquina"
              />
            </Field>

            <Field
              id="venue-contact-phone"
              label="WhatsApp del encargado"
              hint="Con código de país (ej. +57 300 123 4567). Déjalo vacío para no publicar contacto."
            >
              <input
                id="venue-contact-phone"
                value={venueContactPhone}
                onChange={(e) => setVenueContactPhone(e.target.value)}
                className="field"
                maxLength={40}
                inputMode="tel"
                placeholder="+57 300 123 4567"
              />
            </Field>

            {/* Comisión del promotor: base de las liquidaciones (se congela
                por liquidación al cerrar el periodo). */}
            <h3 className="pf-sub-title">Liquidación</h3>
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

            {venueMsg && (
              <div
                role={venueMsg.ok ? "status" : "alert"}
                className={`pf-alert ${venueMsg.ok ? "pf-alert-ok" : "pf-alert-bad"}`}
              >
                {venueMsg.text}
              </div>
            )}

            <div className="pf-form-actions">
              <button
                type="submit"
                disabled={venueBusy || !venueDirty}
                className="btn-primary"
              >
                {venueBusy ? "Guardando…" : "Guardar negocio"}
              </button>
              {venueDirty && !venueBusy && (
                <span className="pf-dirty-chip">Cambios sin guardar</span>
              )}
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
            <h3 className="pf-sub-title">Movimiento</h3>
            <p className="pf-hint pf-hint-block">
              Cuánto se mueve la interfaz al cambiar de pantalla o de pestaña.
            </p>
            <MotionChooser />
          </div>

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
      <div className="pf-danger-wrap">
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
          {/* Qué se pierde, en cifras: una advertencia genérica se lee y se
              olvida; "administras 2 de 3" obliga a mirar. */}
          {venueCount > 0 && (
            <p className="pf-danger-copy pf-danger-facts">
              {venueCount === 1
                ? "Tu cuenta figura en 1 negocio."
                : `Tu cuenta figura en ${venueCount} negocios${
                    adminCount > 0 ? ` y administras ${adminCount} de ellos` : ""
                  }.`}{" "}
              Al eliminarla pierdes el acceso a{" "}
              {venueCount === 1 ? "él" : "todos"}, sin vuelta atrás.
            </p>
          )}

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
                Escribe tu contraseña y tu correo para confirmar. Esta acción no
                tiene deshacer.
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
              <label className="pf-field" htmlFor="del-confirm">
                <span className="pf-label">
                  Escribe tu correo para confirmar
                </span>
                <input
                  id="del-confirm"
                  type="text"
                  value={delConfirm}
                  onChange={(e) => setDelConfirm(e.target.value)}
                  className="field"
                  placeholder={user.email}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
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
                    setDelConfirm("");
                  }}
                  className="btn-ghost"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={
                    delBusy ||
                    !delPass ||
                    delConfirm.trim().toLowerCase() !==
                      user.email.trim().toLowerCase()
                  }
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
