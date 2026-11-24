import { useNavigate, useSearchParams } from "react-router-dom";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../lib/auth";
import { apiFetch } from "../lib/api";
import { activeVenueId, setActiveVenueId } from "../lib/venue";
import { ROLE_LABELS, ROLE_VISUALS, operationalRoles, roleIdentity, topRole } from "../lib/roles";
import { useUI } from "../lib/ui";
import { haptics } from "../lib/haptics";
import { fileToDataUrl } from "../lib/imageUpload";
import { isValidUsername, normalizeUsername } from "../lib/username";
import { clearToken } from "../lib/tokenStore";
import { prefersReducedMotion } from "../lib/motion";
import Icon from "../components/Icon";
import { LegalLinks } from "../components/LegalLinks";
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
function PremiumAvatar({ user, src, className: extraClass }) {
  const visual = ROLE_VISUALS[topRole(user)] ?? ROLE_VISUALS.bouncer;
  const initials = (user.full_name || "?")
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  const photo = src === undefined ? user.avatar_url : src;

  return (
    <span className={`pf-avatar ${visual.avatar} ${extraClass}`} aria-hidden="true">
      <span className={`pf-avatar-ring ${visual.tabAccent}`} />
      {photo ? (
        // La foto sustituye a las iniciales; el anillo del rol se mantiene, así
        // que un admin sigue distinguiéndose a un vistazo.
        <img
          src={photo}
          alt=""
          decoding="async"
          className="pf-avatar-img"
        />
      ) : (
        initials
      )}
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

/** Fecha del último cambio de contraseña (mig 037): relativa cuando es
 *  reciente ("hace 3 días") y absoluta cuando es vieja ("el 14 de septiembre de
 *  2026"), porque a esa distancia "hace 240 días" no dice nada. */
function changedLabel(iso) {
  if (!iso) return null;
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return null;
  const days = Math.floor((Date.now() - then.getTime()) / 86_400_000);
  return days < 30 ? sinceLabel(iso) : `el ${longDate(iso)}`;
}

const SECURITY_LABELS = {
  password_changed: "Contraseña actualizada",
  sessions_revoked: "Sesiones cerradas",
  session_revoked: "Sesión cerrada",
  email_change_requested: "Verificación de correo solicitada",
  email_changed: "Correo actualizado",
  data_exported: "Datos descargados",
};

function sessionStamp(iso) {
  if (!iso) return "sin registro";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "sin registro";
  return d.toLocaleString("es-CO", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
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
  // Nombre de usuario para entrar (mig 035/058). Toda cuenta conserva uno.
  const [username, setUsername] = useState(user?.username || "");
  const [usernameMsg, setUsernameMsg] = useState(null); // {ok, text}
  const [usernameChecking, setUsernameChecking] = useState(false);
  const usernameRef = useRef(username);
  usernameRef.current = username;
  // Telefono de contacto: la columna existia en la DB pero el perfil no la
  // mostraba. Opcional, y se guarda tal como se escribe.
  const [phone, setPhone] = useState(user?.phone || "");
  // Contacto personal y permiso de compartirlo con el equipo (mig 059).
  const [contactEmail, setContactEmail] = useState(user?.contact_email || "");
  const [shareContact, setShareContact] = useState(
    Boolean(user?.share_contact_with_team),
  );
  const [nameMsg, setNameMsg] = useState(null);
  const [nameBusy, setNameBusy] = useState(false);

  // La organización activa es el contexto de TODA la página. Solo se edita
  // si la persona la administra: nunca se cae en silencio a otro negocio,
  // porque entonces el formulario hablaría de una organización que no es la
  // que el hero muestra.
  const isAdminOf = (v) => (user?.roles?.[String(v.id)] || []).includes("admin");
  const activeVenue =
    (user?.venues || []).find((v) => v.id === currentVenueId) ??
    (user?.venues || [])[0] ??
    null;
  const adminVenue = activeVenue && isAdminOf(activeVenue) ? activeVenue : null;
  const venuePlaceholder = Boolean(adminVenue?.is_placeholder);
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
  const [venueContactEmail, setVenueContactEmail] = useState(
    adminVenue?.contact_email || "",
  );
  // Publicar no es guardar: son dos permisos distintos (mig 059).
  const [publicContactEnabled, setPublicContactEnabled] = useState(
    Boolean(adminVenue?.public_contact_enabled),
  );
  const [publicChannels, setPublicChannels] = useState(
    adminVenue?.public_contact_channels || [],
  );
  const [contactTeamVisible, setContactTeamVisible] = useState(
    adminVenue?.contact_team_visible !== false,
  );
  const [logoError, setLogoError] = useState("");
  const [logoBusy, setLogoBusy] = useState(false);
  const venueLogoInputRef = useRef(null);
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

  // Foto de perfil (mig 038): se elige y previsualiza; viaja al servidor al
  // guardar, no en el instante en que se elige el archivo.
  const [avatarAction, setAvatarAction] = useState(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarMsg, setAvatarMsg] = useState(null);
  const avatarInputRef = useRef(null);
  const avatarPreview =
    avatarAction?.type === "upload"
      ? avatarAction.dataUrl
      : avatarAction?.type === "remove"
        ? null
        : undefined;
  const hasAvatar = Boolean(
    avatarPreview !== undefined ? avatarPreview : user?.avatar_url,
  );

  // Cambio de correo: es la llave de recuperación de la cuenta, así que el
  // formulario solo se abre a propósito y pide la contraseña vigente.
  const [emailOpen, setEmailOpen] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [emailPass, setEmailPass] = useState("");
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailMsg, setEmailMsg] = useState(null);
  // El servidor devuelve el cambio pendiente aunque la página se recargue.
  const [pendingEmail, setPendingEmail] = useState(user?.pending_email || "");

  // Descarga de los propios datos (reautenticada)
  const [exportOpen, setExportOpen] = useState(false);
  const [exportPass, setExportPass] = useState("");
  const [exportBusy, setExportBusy] = useState(false);

  // Estado de borrado confirmado por el servidor: la UI no promete que se
  // puede borrar hasta que el backend dice que no hay bloqueos.
  const [deletionCheck, setDeletionCheck] = useState(null);
  const [deletionCheckLoading, setDeletionCheckLoading] = useState(false);
  const [deletionCheckError, setDeletionCheckError] = useState("");

  // Cambio de sección u organización con ediciones pendientes.
  const [pendingAction, setPendingAction] = useState(null);

  // Sesiones y actividad de seguridad (mig 059)
  const [sessions, setSessions] = useState([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsMsg, setSessionsMsg] = useState(null);
  const [sessionTarget, setSessionTarget] = useState(null);
  const [sessionPass, setSessionPass] = useState("");
  const [sessionBusy, setSessionBusy] = useState(false);
  const [securityEvents, setSecurityEvents] = useState([]);
  const [securityLoading, setSecurityLoading] = useState(false);
  const [venueSwitchBusy, setVenueSwitchBusy] = useState(false);
  const emailTokenHandled = useRef(false);

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
    normalizeUsername(username) !== (user?.username || "") ||
    phone.trim() !== (user?.phone || "") ||
    contactEmail.trim() !== (user?.contact_email || "") ||
    shareContact !== Boolean(user?.share_contact_with_team) ||
    avatarAction !== null;
  const venueDirty =
    !!adminVenue &&
    (venueName.trim() !== adminVenue.name ||
      venueLogo !== (adminVenue.logo_url || "") ||
      venueCommission !== String(adminVenue.commission_pct ?? 0) ||
      venueColor !== (adminVenue.primary_color || "") ||
      venueContactName !== (adminVenue.contact_name || "") ||
      venueContactPhone !== (adminVenue.contact_phone || "") ||
      venueContactEmail !== (adminVenue.contact_email || "") ||
      publicContactEnabled !== Boolean(adminVenue.public_contact_enabled) ||
      [...publicChannels].sort().join(",") !==
        [...(adminVenue.public_contact_channels || [])].sort().join(",") ||
      contactTeamVisible !== (adminVenue.contact_team_visible !== false));
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
    setVenueContactEmail(adminVenue?.contact_email || "");
    setPublicContactEnabled(Boolean(adminVenue?.public_contact_enabled));
    setPublicChannels(adminVenue?.public_contact_channels || []);
    setContactTeamVisible(adminVenue?.contact_team_visible !== false);
    setLogoError("");
    setVenueMsg(null);
  }, [venueFormId]);

  // El negocio solo aparece como pestaña propia si administra alguno: para el
  // resto era una tarjeta que nunca se pintaba y dejaba un hueco.
  const tabs = useMemo(
    () => [
      { id: "cuenta", label: "Mi perfil", icon: "users", dirty: nameDirty },
      { id: "seguridad", label: "Seguridad", icon: "shield" },
      ...(adminVenue
        ? [{ id: "negocio", label: "Organización", icon: "money", dirty: venueDirty }]
        : []),
      { id: "preferencias", label: "Preferencias", icon: "sparkle" },
      { id: "privacidad", label: "Privacidad y datos", icon: "lock" },
    ],
    [adminVenue, nameDirty, venueDirty],
  );
  // Pestañas con cambios sin guardar: alimentan el resumen de la barra.
  const dirtyTabs = tabs.filter((t) => t.dirty);

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

  // La bienvenida enlaza a /perfil?tab=cuenta#username. El foco es la señal
  // de que "Cambiar usuario" llevó exactamente al campo que prometió.
  useEffect(() => {
    if (window.location.hash !== "#username") return;
    const t = window.setTimeout(() => {
      const el = document.getElementById("username");
      el?.focus();
      el?.scrollIntoView({ block: "center" });
    }, 80);
    return () => window.clearTimeout(t);
  }, []);

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
    const search = next.toString();
    // El hash #username es una intención de foco, no estado de la pestaña:
    // solo se conserva mientras la pestaña sea Cuenta. En otra pestaña sería
    // un ancla muerta que sobrevive a los clics.
    const hash =
      activeTab === "cuenta" && window.location.hash === "#username"
        ? "#username"
        : "";
    nav(
      {
        pathname: "/perfil",
        search: search ? `?${search}` : "",
        hash,
      },
      { replace: true },
    );
  }, [tabIsCanonical, canonicalTab, searchParams, nav, activeTab]);

  // Enlace de verificación del correo nuevo: se canjea UNA vez al abrir la
  // página. El correo solo cambia si el servidor acepta el token; la URL se
  // limpia para que recargar no intente canjearlo otra vez.
  useEffect(() => {
    const token = searchParams.get("email_token");
    if (!token || emailTokenHandled.current) return;
    emailTokenHandled.current = true;
    (async () => {
      try {
        const updated = await apiFetch("/auth/change-email/confirm", {
          method: "POST",
          body: JSON.stringify({ token }),
        });
        setUser(updated);
        setPendingEmail("");
        setEmailMsg({
          ok: true,
          text: "Correo verificado y actualizado. Ya puedes entrar con él.",
        });
        ui.success("Tu correo quedó verificado.");
      } catch (err) {
        setEmailMsg({ ok: false, text: err.message });
        ui.error(err.message);
      } finally {
        const next = new URLSearchParams(searchParams);
        next.delete("email_token");
        setSearchParams(next, { replace: true });
      }
    })();
  }, [searchParams, setSearchParams, setUser, ui]);

  // Sesiones y actividad: se leen del servidor al abrir Seguridad, no de un
  // estado local que podría estar desactualizado.
  useEffect(() => {
    if (activeTab !== "seguridad") return;
    let alive = true;
    setSessionsLoading(true);
    setSecurityLoading(true);
    Promise.all([
      apiFetch("/auth/sessions"),
      apiFetch("/auth/security/activity"),
    ])
      .then(([sessionRows, events]) => {
        if (!alive) return;
        setSessions(sessionRows);
        setSecurityEvents(events);
      })
      .catch((err) => {
        if (alive) setSessionsMsg({ ok: false, text: err.message });
      })
      .finally(() => {
        if (!alive) return;
        setSessionsLoading(false);
        setSecurityLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [activeTab]);

  // Elegibilidad de borrado: se consulta al abrir Privacidad, no se deduce
  // del rol en el navegador.
  useEffect(() => {
    if (activeTab !== "privacidad") return;
    let alive = true;
    setDeletionCheckLoading(true);
    setDeletionCheckError("");
    apiFetch("/auth/account/deletion-check")
      .then((res) => {
        if (alive) setDeletionCheck(res);
      })
      .catch((err) => {
        if (alive) {
          setDeletionCheck(null);
          setDeletionCheckError(err.message);
        }
      })
      .finally(() => {
        if (alive) setDeletionCheckLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [activeTab]);

  async function retryDeletionCheck() {
    setDeletionCheckLoading(true);
    setDeletionCheckError("");
    try {
      setDeletionCheck(await apiFetch("/auth/account/deletion-check"));
    } catch (err) {
      setDeletionCheck(null);
      setDeletionCheckError(err.message);
    } finally {
      setDeletionCheckLoading(false);
    }
  }

  // Al cambiar de pestaña el panel se trae a la vista: si estabas al final de
  // un panel largo, la nueva pestaña empezaba a media altura y con su título
  // bajo la barra pegajosa. Se compara contra la pestaña anterior (y no un
  // "primer render") porque StrictMode ejecuta el efecto dos veces y el
  // segundo pase arrastraba la página al panel nada más cargar.
  const previousTab = useRef(activeTab);
  useEffect(() => {
    if (previousTab.current === activeTab) return;
    previousTab.current = activeTab;
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

  // El aviso de cambios pendientes vale para toda la página, incluso antes
  // de que el usuario esté cargado.
  const guardDirty = nameDirty || venueDirty;

  // Cerrar o recargar la pestaña con ediciones pendientes también avisa.
  useEffect(() => {
    if (!guardDirty) return;
    const onBeforeUnload = (e) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [guardDirty]);

  // Salir del perfil por un enlace interno (topbar, menú) con ediciones
  // pendientes: se intercepta antes de que el router navegue.
  useEffect(() => {
    if (!guardDirty) return;
    const onClick = (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey) return;
      const anchor = e.target.closest?.("a[href]");
      if (!anchor || anchor.target || anchor.hasAttribute("download")) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname) return;
      e.preventDefault();
      e.stopPropagation();
      setPendingAction({ type: "link", href: url.pathname + url.search });
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [guardDirty]);

  if (!user) return null;

  // Rol de cabecera = el de la organización activa, no el más alto de la
  // cuenta: el perfil debe decir desde dónde estás operando ahora.
  const activeVenueRole = activeVenue
    ? topRole({
        roles: {
          [String(activeVenue.id)]: user.roles?.[String(activeVenue.id)] || [],
        },
      })
    : null;
  const role = activeVenueRole ?? topRole(user) ?? "bouncer";
  const visual = ROLE_VISUALS[role] ?? ROLE_VISUALS.bouncer;
  const activeVenueVisual = ROLE_VISUALS[activeVenueRole] ?? visual;
  const switchableRoles = operationalRoles(user);

  const memberSince = longDate(user.created_at);
  const lastSeen = sinceLabel(user.last_login_at);
  // None en cuentas que nunca cambiaron la contraseña desde la mig 037: en ese
  // caso la línea no se pinta, en vez de inventar una fecha.
  const passwordChanged = changedLabel(user.password_changed_at);
  const venueCount = user.venues?.length || 0;
  // Cuántos de esos negocios administra: es el dato que hace concreta la
  // advertencia de la zona de peligro.
  const adminCount =
    user.venues?.filter((v) =>
      (user.roles?.[String(v.id)] || []).includes("admin"),
    ).length || 0;

  function applyTab(id) {
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

  function selectTab(id) {
    if (id === activeTab) return;
    if (guardDirty) {
      setPendingAction({ type: "tab", id });
      return;
    }
    applyTab(id);
  }

  function resetProfileDraft() {
    setName(user?.full_name || "");
    setUsername(user?.username || "");
    setPhone(user?.phone || "");
    setContactEmail(user?.contact_email || "");
    setShareContact(Boolean(user?.share_contact_with_team));
    setAvatarAction(null);
    setAvatarMsg(null);
    setUsernameMsg(null);
    setNameMsg(null);
  }

  function resetVenueDraft() {
    if (!adminVenue) return;
    setVenueName(adminVenue.name || "");
    setVenueLogo(adminVenue.logo_url || "");
    setVenueColor(adminVenue.primary_color || "");
    setVenueCommission(
      adminVenue.commission_pct != null ? String(adminVenue.commission_pct) : "0",
    );
    setVenueContactName(adminVenue.contact_name || "");
    setVenueContactPhone(adminVenue.contact_phone || "");
    setVenueContactEmail(adminVenue.contact_email || "");
    setPublicContactEnabled(Boolean(adminVenue.public_contact_enabled));
    setPublicChannels(adminVenue.public_contact_channels || []);
    setContactTeamVisible(adminVenue.contact_team_visible !== false);
    setLogoError("");
    setVenueMsg(null);
  }

  function discardAndContinue() {
    const action = pendingAction;
    setPendingAction(null);
    resetProfileDraft();
    resetVenueDraft();
    if (action?.type === "tab") applyTab(action.id);
    if (action?.type === "venue") performVenueSwitch(action.venue);
    if (action?.type === "role") switchRole(action.role);
    if (action?.type === "link") nav(action.href);
  }

  async function saveAndContinue() {
    const action = pendingAction;
    const saved =
      activeTab === "negocio" ? await saveVenue() : await saveProfile();
    if (!saved) return;
    setPendingAction(null);
    if (action?.type === "tab") applyTab(action.id);
    if (action?.type === "venue") performVenueSwitch(action.venue);
    if (action?.type === "role") switchRole(action.role);
    if (action?.type === "link") nav(action.href);
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
      // El cambio invalida el token de esta sesión (token_version). Mantener
      // la pantalla "logueada" con una credencial muerta sería mentir: se
      // cierra la sesión y se pide entrar con la clave nueva.
      ui.success("Contraseña actualizada. Entra de nuevo con la clave nueva.");
      await logout();
      nav("/login", { replace: true, state: { passwordChanged: true } });
    } catch (err) {
      setPassMsg({ ok: false, text: err.message });
    } finally {
      setPassBusy(false);
    }
  }

  async function checkUsername() {
    const candidate = normalizeUsername(username);
    if (!candidate) {
      // Cuentas legadas sin username pueden seguir entrando por correo.
      setUsernameMsg(
        user?.username
          ? { ok: false, text: "Elige un nombre de usuario." }
          : null,
      );
      return;
    }
    if (candidate === (user?.username || "")) {
      setUsernameMsg(null);
      return;
    }
    if (!isValidUsername(candidate)) {
      setUsernameMsg({
        ok: false,
        text: "Entre 3 y 32 caracteres: letras, números, punto, guion o guion bajo.",
      });
      return;
    }
    setUsernameChecking(true);
    try {
      const r = await apiFetch(
        `/auth/username-available?username=${encodeURIComponent(candidate)}`
      );
      if (normalizeUsername(usernameRef.current) !== candidate) return;
      setUsernameMsg(
        r.available
          ? { ok: true, text: `@${r.username} está disponible.` }
          : { ok: false, text: `@${r.username} ya está en uso. Elige otro.` }
      );
    } catch {
      // La disponibilidad es una ayuda; el PATCH sigue siendo la autoridad.
      if (normalizeUsername(usernameRef.current) === candidate) {
        setUsernameMsg(null);
      }
    } finally {
      setUsernameChecking(false);
    }
  }

  async function saveProfile() {
    setNameMsg(null);
    if (name.trim().length < 2) {
      setNameMsg({
        ok: false,
        text: "El nombre debe tener al menos 2 caracteres.",
      });
      return false;
    }
    const candidate = normalizeUsername(username);
    if (!candidate && user?.username) {
      setUsernameMsg({
        ok: false,
        text: "Elige un nombre de usuario: tu cuenta ya entra con uno.",
      });
      return false;
    }
    if (candidate && !isValidUsername(candidate)) {
      setUsernameMsg({
        ok: false,
        text: "Entre 3 y 32 caracteres: letras, números, punto, guion o guion bajo.",
      });
      return false;
    }
    if (usernameMsg && !usernameMsg.ok) return false;
    const avatar = avatarAction;
    setNameBusy(true);
    try {
      const updated = await apiFetch("/auth/profile", {
        method: "PATCH",
        // Nombre y usuario van juntos: el backend valida el formato y responde
        // 409 si el usuario ya esta tomado. El catch de abajo muestra ese
        // mensaje real en vez de un texto generico.
        body: JSON.stringify({
          full_name: name,
          ...(candidate ? { username: candidate } : {}),
          phone: phone.trim(),
          contact_email: contactEmail.trim(),
          share_contact_with_team: shareContact,
        }),
      });
      let finalUser = updated;
      if (avatar) {
        setAvatarBusy(true);
        try {
          finalUser = await apiFetch("/auth/avatar", {
            method: avatar.type === "remove" ? "DELETE" : "POST",
            ...(avatar.type === "upload"
              ? { body: JSON.stringify({ data_url: avatar.dataUrl }) }
              : {}),
          });
          setAvatarAction(null);
          setAvatarMsg({ ok: true, text: "Foto actualizada." });
        } catch (err) {
          // El perfil ya quedó guardado; no se oculta el fallo de la foto.
          setUser(updated);
          setNameMsg({
            ok: false,
            text: `Tus datos se guardaron, pero la foto no: ${err.message}`,
          });
          return false;
        } finally {
          setAvatarBusy(false);
        }
      }
      setUser(finalUser);
      setName(finalUser.full_name || "");
      setUsername(finalUser.username || "");
      setPhone(finalUser.phone || "");
      setContactEmail(finalUser.contact_email || "");
      setShareContact(Boolean(finalUser.share_contact_with_team));
      setUsernameMsg(null);
      const stamp = new Date().toLocaleTimeString("es-CO", {
        hour: "2-digit",
        minute: "2-digit",
      });
      setNameMsg({
        ok: true,
        text: `Guardado confirmado por el servidor a las ${stamp}.`,
      });
      haptics.success();
      return true;
    } catch (err) {
      // 409 = el usuario se ocupó entre la comprobación y el guardado. El
      // usuario anterior queda intacto; el aviso va junto al campo.
      if (err?.status === 409) {
        setUsernameMsg({ ok: false, text: err.message });
      } else {
        setNameMsg({ ok: false, text: err.message });
      }
      return false;
    } finally {
      setNameBusy(false);
    }
  }

  function submitName(e) {
    e.preventDefault();
    saveProfile();
  }

  /** Elige y previsualiza la foto; el servidor la recibe al guardar. */
  async function onAvatarFile(e) {
    const file = e.target.files?.[0];
    // Se limpia el input para poder volver a elegir el mismo archivo (si no,
    // el segundo intento con la misma foto no dispara onChange).
    e.target.value = "";
    if (!file) return;
    setAvatarBusy(true);
    setAvatarMsg(null);
    try {
      const dataUrl = await fileToDataUrl(file, { maxSide: 512 });
      setAvatarAction({ type: "upload", dataUrl });
      setAvatarMsg({ ok: true, text: "Vista previa lista. Guarda para subirla." });
    } catch (err) {
      setAvatarMsg({ ok: false, text: err.message });
    } finally {
      setAvatarBusy(false);
    }
  }

  function removeAvatar() {
    setAvatarAction({ type: "remove" });
    setAvatarMsg({ ok: true, text: "La foto se quitará al guardar." });
  }

  /** Logo del negocio: misma reducción local que el avatar. Se envía en el
   *  PATCH del formulario para que un solo guardado no deje estados a medias. */
  async function onVenueLogoFile(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setLogoBusy(true);
    setLogoError("");
    try {
      const dataUrl = await fileToDataUrl(file, { maxSide: 512 });
      setVenueLogo(dataUrl);
      setVenueMsg(null);
    } catch (err) {
      setLogoError(err.message || "No pudimos preparar la imagen.");
    } finally {
      setLogoBusy(false);
    }
  }

  async function submitEmail(e) {
    e.preventDefault();
    setEmailMsg(null);
    setEmailBusy(true);
    try {
      const res = await apiFetch("/auth/change-email", {
        method: "POST",
        body: JSON.stringify({
          new_email: newEmail.trim(),
          current_password: emailPass,
        }),
      });
      if (res.verification_sent) {
        setEmailOpen(false);
        setNewEmail("");
        setEmailPass("");
        setPendingEmail(res.pending_email);
        setEmailMsg({ ok: true, text: res.detail });
        haptics.success();
        ui.success("Revisa el correo nuevo para confirmar el cambio.");
      } else {
        setEmailMsg({ ok: false, text: res.detail });
      }
    } catch (err) {
      setEmailMsg({ ok: false, text: err.message });
    } finally {
      setEmailBusy(false);
    }
  }

  async function saveVenue() {
    setLogoError("");
    if (publicContactEnabled && publicChannels.length === 0) {
      setVenueMsg({
        ok: false,
        text: "Para publicar el contacto elige al menos un canal.",
      });
      return false;
    }
    if (publicContactEnabled && publicChannels.includes("whatsapp") && !venueContactPhone.trim()) {
      setVenueMsg({
        ok: false,
        text: "Elegiste WhatsApp pero no hay un teléfono guardado.",
      });
      return false;
    }
    if (publicContactEnabled && publicChannels.includes("email") && !venueContactEmail.trim()) {
      setVenueMsg({
        ok: false,
        text: "Elegiste correo pero no hay un correo de contacto guardado.",
      });
      return false;
    }
    setVenueBusy(true);
    try {
      const logoIsData = venueLogo.startsWith("data:");
      const updated = await apiFetch(`/auth/venues/${adminVenue.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: venueName,
          ...(logoIsData ? { logo_data_url: venueLogo } : { logo_url: venueLogo }),
          commission_pct: Number(venueCommission) || 0,
          primary_color: venueColor,
          contact_name: venueContactName,
          contact_phone: venueContactPhone,
          contact_email: venueContactEmail,
          public_contact_enabled: publicContactEnabled,
          public_contact_channels: publicChannels,
          contact_team_visible: contactTeamVisible,
        }),
      });
      // La respuesta del servidor es la fuente de verdad: se copia entera.
      setUser({
        ...user,
        venues: user.venues.map((v) =>
          v.id === updated.id ? { ...v, ...updated } : v,
        ),
      });
      setVenueName(updated.name || "");
      setVenueLogo(updated.logo_url || "");
      setVenueColor(updated.primary_color || "");
      setVenueCommission(
        updated.commission_pct != null ? String(updated.commission_pct) : "0",
      );
      setVenueContactName(updated.contact_name || "");
      setVenueContactPhone(updated.contact_phone || "");
      setVenueContactEmail(updated.contact_email || "");
      setPublicContactEnabled(Boolean(updated.public_contact_enabled));
      setPublicChannels(updated.public_contact_channels || []);
      setContactTeamVisible(updated.contact_team_visible !== false);
      const stamp = new Date().toLocaleTimeString("es-CO", {
        hour: "2-digit",
        minute: "2-digit",
      });
      setVenueMsg({
        ok: true,
        text: `Organización guardada y confirmada por el servidor a las ${stamp}.`,
      });
      haptics.success();
      return true;
    } catch (err) {
      setVenueMsg({ ok: false, text: err.message });
      return false;
    } finally {
      setVenueBusy(false);
    }
  }

  function submitVenue(e) {
    e.preventDefault();
    saveVenue();
  }

  async function performVenueSwitch(venue) {
    if (venueSwitchBusy || venue.id === currentVenueId) return;
    setVenueSwitchBusy(true);
    try {
      // Sin optimismo: el contexto cambia cuando el servidor confirma que
      // guardó la preferencia. Si falla, la organización visible no miente.
      const updated = await apiFetch("/auth/me/active-venue", {
        method: "PUT",
        body: JSON.stringify({ venue_id: venue.id }),
      });
      setActiveVenueId(venue.id);
      setCurrentVenueId(venue.id);
      setUser(updated);
      ui.success(`Trabajando en ${venue.name}.`);
      return true;
    } catch (err) {
      ui.error(err.message || "No pudimos cambiar de organización.");
      return false;
    } finally {
      setVenueSwitchBusy(false);
    }
  }

  /** Cambia de rol llevando la organización activa a una donde ese rol exista. */
  async function switchRole(nextRole) {
    if (venueSwitchBusy) return;
    const wanted = nextRole === "admin" ? ["admin", "super_admin"] : [nextRole];
    const targetVenue = (user.venues || []).find((v) =>
      (user.roles?.[String(v.id)] || []).some((r) => wanted.includes(r)),
    );
    if (targetVenue && targetVenue.id !== currentVenueId) {
      const ok = await performVenueSwitch(targetVenue);
      if (!ok) return;
    }
    nav(roleIdentity(nextRole).home);
  }

  function requestRoleSwitch(nextRole) {
    if (guardDirty) {
      setPendingAction({ type: "role", role: nextRole });
      return;
    }
    switchRole(nextRole);
  }

  function switchVenue(venue) {
    if (venue.id === currentVenueId) return;
    if (guardDirty) {
      setPendingAction({ type: "venue", venue });
      return;
    }
    performVenueSwitch(venue);
  }

  function toggleChannel(channel) {
    setPublicChannels((prev) =>
      prev.includes(channel)
        ? prev.filter((c) => c !== channel)
        : [...prev, channel],
    );
    setVenueMsg(null);
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
      // El backend invalida las otras sesiones y renueva nuestra cookie.
      clearToken();
      setUser(res.user);
      setSessPass("");
      setSessOpen(false);
      setSessMsg({
        ok: true,
        text: "Listo: las demás sesiones quedaron cerradas. Esta sigue abierta.",
      });
      const [sessionRows, events] = await Promise.all([
        apiFetch("/auth/sessions"),
        apiFetch("/auth/security/activity"),
      ]);
      setSessions(sessionRows);
      setSecurityEvents(events);
      haptics.success();
    } catch (err) {
      setSessMsg({ ok: false, text: err.message });
    } finally {
      setSessBusy(false);
    }
  }

  async function submitRevokeSession(e) {
    e.preventDefault();
    if (!sessionTarget) return;
    setSessionBusy(true);
    setSessionsMsg(null);
    try {
      const res = await apiFetch(`/auth/sessions/${sessionTarget.id}`, {
        method: "DELETE",
        body: JSON.stringify({ password: sessionPass }),
      });
      setSessionsMsg({ ok: true, text: res.detail });
      setSessionTarget(null);
      setSessionPass("");
      const [sessionRows, events] = await Promise.all([
        apiFetch("/auth/sessions"),
        apiFetch("/auth/security/activity"),
      ]);
      setSessions(sessionRows);
      setSecurityEvents(events);
    } catch (err) {
      setSessionsMsg({ ok: false, text: err.message });
    } finally {
      setSessionBusy(false);
    }
  }

  /** Descarga de los propios datos como JSON.
   *  Se usa fetch + blob (no un <a href>): el token viaja en el header, nunca
   *  en la URL, y así no queda en el historial ni en los logs del servidor. */
  async function downloadData(e) {
    e.preventDefault();
    setExportBusy(true);
    try {
      // Reautenticación: el JSON contiene datos personales y de los negocios.
      const data = await apiFetch("/auth/export", {
        method: "POST",
        body: JSON.stringify({ password: exportPass }),
      });
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "mis-datos-enty.json";
      a.click();
      URL.revokeObjectURL(a.href);
      setExportOpen(false);
      setExportPass("");
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
      await logout();
      nav("/login", { state: { deleted: true } });
    } catch (err) {
      setDelErr(err.message);
    } finally {
      setDelBusy(false);
    }
  }

  return (
    <div className="pf-page mx-auto max-w-6xl">
      {/* Hero de identidad: la ficha de la persona, no un formulario. Fijo
          arriba: quién eres no cambia al moverte entre pestañas. */}
      <div className="pf-hero">
        <div className="pf-hero-main">
          <PremiumAvatar user={user} src={avatarPreview} />

          <div className="pf-hero-id">
            <p className="eyebrow">Tu perfil</p>
            <h1 className="pf-name">{user.full_name}</h1>
            <p className="pf-handle">
              {user.username ? `@${user.username}` : "Sin nombre de usuario"}
            </p>

            <div className="pf-hero-badges">
              <span className={`pf-role-chip ${visual.tabAccent}`}>
                {roleLabel(role)}
              </span>
              <span className="pf-hero-org">
                {activeVenue
                  ? `Organización activa: ${activeVenue.name}`
                  : "Sin organización activa"}
              </span>
            </div>
            {switchableRoles.length > 1 && (
              <div className="pf-role-switch" role="group" aria-label="Cambiar de rol">
                <span className="pf-hint">Cambiar de rol:</span>
                {switchableRoles.map((r) => {
                  const ident = roleIdentity(r);
                  return (
                    <button
                      key={r}
                      type="button"
                      className={`pf-context-option${r === role ? " is-on" : ""}`}
                      aria-pressed={r === role}
                      onClick={() => requestRoleSwitch(r)}
                    >
                      <Icon name={ident.icon} className="h-3.5 w-3.5" aria-hidden="true" />
                      {roleLabel(r)}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Acciones de la sesión: el perfil es donde se cierra sesión. */}
          <div className="pf-hero-actions">
            <button
              type="button"
              onClick={async () => {
                try {
                  await logout();
                  nav("/login", { replace: true });
                } catch {
                  ui.toast("No pudimos cerrar la sesión. Intenta de nuevo.", "error");
                }
              }}
              className="btn-ghost pf-action"
            >
              <Icon name="logout" className="h-4 w-4" aria-hidden="true" />
              Cerrar sesión
            </button>
          </div>
        </div>
      </div>

      <div className="pf-shell">
      {/* Navegación lateral en escritorio e índice vertical en móvil. */}
      <div className="pf-side">
        <p className="pf-side-title">Secciones de tu cuenta</p>
        <div
          ref={tabbarRef}
          className="tabbar no-scrollbar pf-tabs"
          role="tablist"
          aria-label="Secciones del perfil"
          aria-orientation="vertical"
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
      </div>

      <div className="pf-main">
      {/* Contexto de trabajo: qué organización está activa AHORA. No es un
          detalle del formulario: decide qué eventos, equipo y reportes ve el
          admin. El cambio solo se pinta cuando el servidor lo confirma. */}
      {activeVenue && (
        <section className="pf-context" aria-labelledby="pf-context-title">
          <div className="pf-context-main">
            <span className={`pf-context-logo ${activeVenueVisual.tabAccent}`}>
              {activeVenue.logo_url ? (
                <img src={activeVenue.logo_url} alt="" decoding="async" />
              ) : (
                (activeVenue.name || "?").trim().charAt(0).toUpperCase()
              )}
            </span>
            <div className="pf-context-copy">
              <p className="pf-context-label" id="pf-context-title">
                Organización activa
              </p>
              <p className="pf-context-name">{activeVenue.name}</p>
              <p className="pf-context-meta">
                {activeVenueRole ? roleLabel(activeVenueRole) : "Sin rol"}
                {activeVenue.is_placeholder
                  ? " · identidad interna, aún no pública"
                  : ""}
                {venueCount > 1
                  ? ` · ${venueCount} organizaciones en tu cuenta`
                  : ""}
              </p>
            </div>
            <span className={`pf-context-badge ${activeVenueVisual.tabAccent}`}>
              Activa
            </span>
          </div>

          {venueCount > 1 && (
            <div className="pf-context-switch" role="group" aria-label="Cambiar organización activa">
              <p className="pf-hint">
                Cambia el contexto de todos los paneles. Se guarda en tu cuenta,
                no en este navegador.
              </p>
              <div className="pf-context-options">
                {user.venues.map((v) => {
                  const on = v.id === activeVenue.id;
                  return (
                    <button
                      key={v.id}
                      type="button"
                      aria-pressed={on}
                      disabled={venueSwitchBusy}
                      onClick={() => switchVenue(v)}
                      className={`pf-context-option ${on ? "is-on" : ""}`}
                    >
                      <span className="pf-context-option-name">{v.name}</span>
                      <span className="pf-context-option-role">
                        {(user.roles?.[String(v.id)] || []).map(roleLabel).join(", ")}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </section>
      )}

      {/* Resumen de cambios sin guardar (M-1): los puntos ámbar de cada
          pestaña dicen DÓNDE hay cambios, pero no cuántos. Una frase a nivel
          de barra responde "¿me falta guardar algo?" sin recorrer pestañas. */}
      {dirtyTabs.length > 0 && (
        <p className="pf-dirty-summary" role="status">
          {dirtyTabs.length === 1
            ? "Tienes cambios sin guardar en "
            : `Tienes cambios sin guardar en ${dirtyTabs.length} secciones: `}
          {dirtyTabs.map((t) => t.label).join(", ")}
        </p>
      )}

      {/* En móvil, volver al inicio del perfil sin depender del gesto atrás. */}
      {activeTab !== "cuenta" && (
        <button
          type="button"
          onClick={() => selectTab("cuenta")}
          className="pf-back"
        >
          <Icon name="back" className="h-4 w-4" aria-hidden="true" />
          Volver a Mi perfil
        </button>
      )}

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
              label="Nombre de usuario"
              hint={
                user?.username
                  ? "Así entras sin escribir el correo. Puedes cambiarlo cuando quieras; el anterior deja de funcionar."
                  : "Aún no tienes uno. Elige un nombre para entrar sin escribir el correo; si lo dejas vacío, seguirás entrando con tu correo."
              }
            >
              <input
                id="username"
                value={username}
                onChange={(e) => {
                  setUsername(e.target.value);
                  setUsernameMsg(null);
                  setNameMsg(null);
                }}
                onBlur={checkUsername}
                className="field"
                maxLength={32}
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="@tu.usuario"
                aria-invalid={usernameMsg && !usernameMsg.ok ? "true" : undefined}
                aria-describedby="username-hint username-status"
              />
            </Field>
            <p id="username-hint" className="sr-only">
              Entre 3 y 32 caracteres: letras, números, punto, guion o guion bajo.
            </p>
            {/* Una sola línea siempre presente: si el aviso apareciera solo al
                salir del campo, el botón de guardar se movería justo cuando el
                clic lo busca y el submit se perdería. */}
            <p
              id="username-status"
              className={`pf-hint ${
                usernameMsg && !usernameChecking
                  ? usernameMsg.ok
                    ? "pf-hint-ok"
                    : "pf-hint-warn"
                  : ""
              }`}
              role={usernameMsg && !usernameChecking && !usernameMsg.ok ? "alert" : "status"}
            >
              {usernameChecking
                ? "Comprobando disponibilidad…"
                : usernameMsg?.text || "\u00A0"}
            </p>

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

            <Field
              id="contact-email"
              label="Correo de contacto (opcional)"
              hint="No es el correo con el que entras. Es el que puedes compartir con tu equipo."
            >
              <input
                id="contact-email"
                type="email"
                value={contactEmail}
                onChange={(e) => {
                  setContactEmail(e.target.value);
                  setNameMsg(null);
                }}
                className="field"
                maxLength={200}
                inputMode="email"
                autoComplete="email"
                placeholder="equipo@tubar.com"
              />
            </Field>

            <label className="pf-check-row" htmlFor="share-contact">
              <input
                id="share-contact"
                type="checkbox"
                checked={shareContact}
                onChange={(e) => {
                  setShareContact(e.target.checked);
                  setNameMsg(null);
                }}
                className="pf-check"
              />
              <span>
                <span className="pf-label">Compartir mi contacto con mi equipo</span>
                <span className="pf-hint">
                  Solo el equipo de tus organizaciones verá el teléfono y el
                  correo de contacto. Nunca se publican en la página del evento.
                </span>
              </span>
            </label>

            <p className="pf-saved-state">
              <Icon name="check" className="h-4 w-4" aria-hidden="true" />
              {user.share_contact_with_team
                ? "Ahora mismo tu equipo puede ver tu teléfono y correo de contacto."
                : "Ahora mismo tu contacto personal no se comparte con el equipo."}
            </p>

            {nameMsg && (
              <div
                role={nameMsg.ok ? "status" : "alert"}
                className={`pf-alert ${nameMsg.ok ? "pf-alert-ok" : "pf-alert-bad"}`}
              >
                <span>{nameMsg.text}</span>
                {!nameMsg.ok && !nameBusy && (
                  <button
                    type="button"
                    onClick={saveProfile}
                    className="btn-ghost pf-action"
                  >
                    Reintentar
                  </button>
                )}
              </div>
            )}
          </form>

          <div className="pf-sub">
            <h3 className="pf-sub-title">Foto de perfil</h3>
            <p className="pf-hint pf-hint-block">
              Se recorta en círculo y se reduce antes de subirla. La vista
              previa es local; la foto se guarda cuando pulsas Guardar.
            </p>
            <div className="pf-photo-row">
              <PremiumAvatar user={user} src={avatarPreview} />
              <button
                type="button"
                onClick={() => avatarInputRef.current?.click()}
                disabled={avatarBusy || nameBusy}
                className="btn-ghost pf-action"
              >
                <Icon name="camera" className="h-4 w-4" aria-hidden="true" />
                {avatarBusy
                  ? "Preparando…"
                  : hasAvatar
                    ? "Cambiar foto"
                    : "Elegir foto"}
              </button>
              {hasAvatar && (
                <button
                  type="button"
                  onClick={removeAvatar}
                  disabled={avatarBusy || nameBusy}
                  className="btn-ghost pf-action"
                >
                  <Icon name="trash" className="h-4 w-4" aria-hidden="true" />
                  Quitar
                </button>
              )}
            </div>
            {/* `hidden` y no sr-only: el control accesible es el botón de
                arriba, así el input no aparece como un foco perdido. */}
            <input
              ref={avatarInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={onAvatarFile}
            />
            {avatarMsg && (
              <div
                role={avatarMsg.ok ? "status" : "alert"}
                className={`pf-alert ${avatarMsg.ok ? "pf-alert-ok" : "pf-alert-bad"}`}
              >
                {avatarMsg.text}
              </div>
            )}
          </div>

          <div className="pf-form-actions pf-form-actions-sticky">
            <button
              type="button"
              onClick={saveProfile}
              disabled={nameBusy || !nameDirty}
              className="btn-primary"
            >
              {nameBusy ? "Guardando…" : "Guardar cambios"}
            </button>
            <button
              type="button"
              onClick={() => {
                resetProfileDraft();
                setAvatarMsg(null);
              }}
              disabled={nameBusy || !nameDirty}
              className="btn-ghost pf-action"
            >
              Cancelar
            </button>
            {nameDirty && !nameBusy && (
              <span className="pf-dirty-chip">Cambios sin guardar</span>
            )}
          </div>

          <div className="pf-sub">
            <h3 className="pf-sub-title">Detalles de la cuenta</h3>
            <dl className="pf-details">
              <div className="pf-detail-row">
                <dt>Miembro desde</dt>
                <dd>{memberSince || "Sin registro"}</dd>
              </div>
              <div className="pf-detail-row">
                <dt>Nombre de usuario</dt>
                <dd>{username ? `@${username.replace(/^@/, "")}` : "Sin definir"}</dd>
              </div>
            </dl>
            <p className="pf-hint pf-hint-block">
              El correo de acceso, la contraseña y las sesiones se gestionan en
              Seguridad.
            </p>
          </div>

          <div className="pf-sub">
            <h3 className="pf-sub-title">Documentos legales</h3>
            <p className="pf-hint pf-hint-block">
              Los documentos vigentes de Enty. Las aceptaciones obligatorias
              quedan registradas en tu cuenta.
            </p>
            <LegalLinks />
          </div>
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
            title="Seguridad de la cuenta"
            hint="El correo, la contraseña y las sesiones son las llaves de tu cuenta. Cada cambio queda registrado."
          />

          <div className="pf-sub">
            <h3 className="pf-sub-title">Correo de acceso</h3>
            <div className="pf-readonly">
              <Icon name="link" className="h-4 w-4" aria-hidden="true" />
              <span className="pf-readonly-value">{user.email}</span>
            </div>
            {pendingEmail && (
              <p className="pf-alert pf-alert-warn">
                Cambio pendiente a <strong>{pendingEmail}</strong>. Tu cuenta
                sigue con {user.email} hasta que confirmes desde el buzón nuevo.
              </p>
            )}
            {!emailOpen ? (
              <>
                <p className="pf-hint">
                  Con este correo entras y recuperas tu cuenta. El cambio se
                  activa solo después de verificar el buzón nuevo; mientras
                  tanto, tu correo actual sigue funcionando y la cuenta conserva
                  su identificador, roles, eventos y asignaciones.
                </p>
                <div className="pf-form-actions">
                  <button
                    type="button"
                    onClick={() => {
                      setEmailMsg(null);
                      setEmailOpen(true);
                    }}
                    className="btn-ghost pf-action"
                  >
                    Cambiar correo
                  </button>
                </div>
              </>
            ) : (
              <form onSubmit={submitEmail} className="pf-form">
                <Field
                  id="new-email"
                  label="Nuevo correo"
                  hint="Lo usaremos para entrar y para recuperar la cuenta. Enviaremos un enlace de un solo uso al buzón nuevo y avisaremos al anterior."
                >
                  <input
                    id="new-email"
                    type="email"
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                    className="field"
                    autoComplete="email"
                    inputMode="email"
                    maxLength={200}
                    required
                  />
                </Field>

                <Field
                  id="email-pass"
                  label="Contraseña actual"
                  hint="Confirmamos que eres tú antes de mover la cuenta."
                >
                  <input
                    id="email-pass"
                    type="password"
                    value={emailPass}
                    onChange={(e) => setEmailPass(e.target.value)}
                    className="field"
                    autoComplete="current-password"
                    maxLength={128}
                    required
                  />
                </Field>

                <div className="pf-form-actions">
                  <button type="submit" disabled={emailBusy} className="btn-primary">
                    {emailBusy ? "Enviando…" : "Enviar verificación"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setEmailOpen(false);
                      setNewEmail("");
                      setEmailPass("");
                    }}
                    className="btn-ghost pf-action"
                  >
                    Cancelar
                  </button>
                </div>
              </form>
            )}
            {emailMsg && (
              <div
                role={emailMsg.ok ? "status" : "alert"}
                className={`pf-alert ${emailMsg.ok ? "pf-alert-ok" : "pf-alert-bad"}`}
              >
                {emailMsg.text}
              </div>
            )}
          </div>

          <div className="pf-sub">
            <h3 className="pf-sub-title">Accesos</h3>
            <dl className="pf-details">
              <div className="pf-detail-row">
                <dt>Último ingreso</dt>
                <dd>{lastSeen || "Sin registro"}</dd>
              </div>
              <div className="pf-detail-row">
                <dt>Contraseña actualizada</dt>
                <dd>{passwordChanged || "Sin registro"}</dd>
              </div>
            </dl>
          </div>

          <div className="pf-sub">
            <h3 className="pf-sub-title">Cambiar contraseña</h3>
            <p className="pf-hint pf-hint-block">
              Se te pedirá la contraseña actual. Al cambiarla se cierran las
              demás sesiones abiertas.
            </p>
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
          </div>

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

            <div className="pf-session-list" aria-busy={sessionsLoading}>
              {sessionsLoading && <p className="pf-hint">Leyendo sesiones…</p>}
              {!sessionsLoading && sessions.length === 0 && (
                <p className="pf-hint">
                  El servidor no reporta sesiones individuales todavía. Usa
                  “Cerrar las demás” para revocar las credenciales anteriores.
                </p>
              )}
              {sessions.map((s) => (
                <div key={s.id} className={`pf-session ${s.current ? "is-current" : ""}`}>
                  <div className="pf-session-main">
                    <p className="pf-session-device">
                      {s.device}
                      {s.current && <span className="pf-session-tag">Esta sesión</span>}
                    </p>
                    <p className="pf-session-meta">
                      Inició {sessionStamp(s.created_at)} · Última actividad{" "}
                      {sessionStamp(s.last_seen_at)}
                    </p>
                  </div>
                  {!s.current && (
                    <button
                      type="button"
                      onClick={() => {
                        setSessionsMsg(null);
                        setSessionPass("");
                        setSessionTarget(s);
                      }}
                      className="btn-ghost pf-action pf-action-danger"
                    >
                      Cerrar
                    </button>
                  )}
                </div>
              ))}
            </div>

            {sessionsMsg && (
              <div
                role="status"
                className={`pf-alert ${sessionsMsg.ok ? "pf-alert-ok" : "pf-alert-bad"}`}
              >
                {sessionsMsg.text}
              </div>
            )}

            {sessionTarget && (
              <form onSubmit={submitRevokeSession} className="pf-session-confirm">
                <p className="pf-hint">
                  Para cerrar <strong>{sessionTarget.device}</strong> confirma tu
                  contraseña. El servidor marcará esa sesión como revocada.
                </p>
                <div className="pf-inline-form">
                  <input
                    type="password"
                    value={sessionPass}
                    onChange={(e) => setSessionPass(e.target.value)}
                    className="field"
                    autoComplete="current-password"
                    placeholder="Tu contraseña"
                    required
                  />
                  <button type="submit" disabled={sessionBusy} className="btn-primary">
                    {sessionBusy ? "Cerrando…" : "Cerrar sesión"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setSessionTarget(null);
                      setSessionPass("");
                    }}
                    className="btn-ghost"
                  >
                    Cancelar
                  </button>
                </div>
              </form>
            )}
          </div>

          <div className="pf-sub">
            <h3 className="pf-sub-title">Actividad de seguridad</h3>
            <p className="pf-hint pf-hint-block">
              Solo cambios reales registrados por el servidor. No inventamos
              ubicaciones ni dispositivos que no sepamos.
            </p>
            {securityLoading && <p className="pf-hint">Leyendo actividad…</p>}
            {!securityLoading && securityEvents.length === 0 && (
              <p className="pf-hint">Todavía no hay cambios registrados.</p>
            )}
            {!securityLoading && securityEvents.length > 0 && (
              <ul className="pf-security-list">
                {securityEvents.map((ev) => (
                  <li key={ev.id} className="pf-security-item">
                    <Icon name="shield" className="h-4 w-4" aria-hidden="true" />
                    <span className="pf-security-copy">
                      <span className="pf-security-kind">
                        {SECURITY_LABELS[ev.kind] || ev.kind}
                      </span>
                      {ev.detail && (
                        <span className="pf-security-detail">{ev.detail}</span>
                      )}
                    </span>
                    <time className="pf-security-time" dateTime={ev.created_at}>
                      {sessionStamp(ev.created_at)}
                    </time>
                  </li>
                ))}
              </ul>
            )}
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
            title="Organización"
            hint={
              venuePlaceholder
                ? "Aún no tienes identidad pública. El nombre interno no se muestra en tus fichas."
                : "Estás editando la organización activa. El nombre y el logo la representan ante tu equipo y tus clientes."
            }
          />
          <div className="pf-editing" role="status">
            <span className={`pf-editing-logo ${activeVenueVisual.tabAccent}`}>
              {adminVenue.logo_url ? (
                <img src={adminVenue.logo_url} alt="" decoding="async" />
              ) : (
                (adminVenue.name || "?").trim().charAt(0).toUpperCase()
              )}
            </span>
            <span className="pf-editing-copy">
              <span className="pf-editing-label">Editando esta organización</span>
              <strong>{adminVenue.name}</strong>
              <span className="pf-editing-role">
                {activeVenueRole ? roleLabel(activeVenueRole) : "Sin rol"} · solo
                se guardan cambios sobre esta organización
              </span>
            </span>
          </div>
          {venuePlaceholder && (
            <p className="pf-hint pf-hint-warn">
              Tu espacio aparece como “Mi organización” porque aún no tiene
              nombre. Escribe el nombre de tu negocio para mostrarlo en tus
              eventos públicos.
            </p>
          )}
          <form onSubmit={submitVenue} className="pf-form">
            {/* Seis campos en columna se leían como un muro. Los títulos no
                envuelven nada: agrupan con la viga del sistema y dejan el
                ritmo del grid intacto. */}
            <h3 className="pf-sub-title">Identidad</h3>
            <Field
              id="venue-name"
              label="Nombre del negocio"
              hint="Este nombre se muestra en tus fichas públicas y en las boletas. Puedes cambiarlo cuando quieras."
            >
              <input
                id="venue-name"
                value={venueName}
                onChange={(e) => setVenueName(e.target.value)}
                className="field"
                maxLength={120}
                minLength={2}
                placeholder="Bar La Esquina"
                required
              />
            </Field>

            <div className="pf-field">
              <span className="pf-label">Logo de la organización</span>
              <div className="pf-logo-row">
                {venueLogo && !logoError ? (
                  <img
                    src={venueLogo}
                    alt="Logo actual"
                    onError={() => setLogoError("No se pudo cargar la imagen")}
                    decoding="async"
                    className="pf-logo"
                  />
                ) : (
                  <span className="pf-logo pf-logo-empty" aria-hidden="true">
                    {(venueName || "?")[0].toUpperCase()}
                  </span>
                )}
                <div className="pf-logo-actions">
                  <button
                    type="button"
                    onClick={() => venueLogoInputRef.current?.click()}
                    disabled={logoBusy || venueBusy}
                    className="btn-ghost pf-action"
                  >
                    <Icon name="camera" className="h-4 w-4" aria-hidden="true" />
                    {logoBusy ? "Preparando…" : venueLogo ? "Cambiar logo" : "Subir logo"}
                  </button>
                  {venueLogo && (
                    <button
                      type="button"
                      onClick={() => {
                        setVenueLogo("");
                        setLogoError("");
                      }}
                      className="btn-ghost pf-action"
                    >
                      Quitar
                    </button>
                  )}
                </div>
              </div>
              <input
                ref={venueLogoInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                onChange={onVenueLogoFile}
              />
              <label className="pf-label pf-label-secondary" htmlFor="venue-logo-url">
                O pega una URL
              </label>
              <input
                id="venue-logo-url"
                type="url"
                value={venueLogo.startsWith("data:") ? "" : venueLogo}
                onChange={(e) => {
                  setVenueLogo(e.target.value);
                  setLogoError("");
                }}
                className="field"
                placeholder="https://…/logo.png"
                maxLength={500}
              />
              {venueLogo.startsWith("data:") && (
                <span className="pf-hint">Imagen lista; se guardará al guardar la organización.</span>
              )}
              {logoError && (
                <span className="pf-hint pf-hint-warn">{logoError} — revisa la imagen o la URL.</span>
              )}
            </div>

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
              <div className="pf-brand-previews">
                <div
                  className="pf-brand-preview pf-brand-preview-light"
                  aria-label="Vista previa del color en modo claro"
                >
                  <span
                    className="pf-brand-preview-banner"
                    style={{ background: brandColor }}
                  />
                  <span className="pf-brand-preview-copy">
                    <strong>Modo claro</strong>
                    Así se verá el banner de tu portada
                  </span>
                </div>
                <div
                  className="pf-brand-preview pf-brand-preview-dark"
                  aria-label="Vista previa del color en modo oscuro"
                >
                  <span
                    className="pf-brand-preview-banner"
                    style={{ background: brandColor }}
                  />
                  <span className="pf-brand-preview-copy">
                    <strong>Modo oscuro</strong>
                    Así se verá el banner de tu portada
                  </span>
                </div>
              </div>
            </div>

            {/* Contacto del organizador (mig 036): es lo que la pagina publica
                muestra en "encargar por WhatsApp". Quien organiza esa noche
                responde por el telefono; sin el, el evento solo vende en linea. */}
            <h3 className="pf-sub-title">Contacto</h3>
            <p className="pf-hint pf-hint-block">
              Guardar un dato no lo publica. Elige explícitamente qué ve el
              público en tus fichas y qué ve tu equipo en el panel.
            </p>
            <Field
              id="venue-contact-name"
              label="Nombre del encargado"
              hint="Aparece junto al contacto cuando decides publicarlo."
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
              hint="Con código de país (ej. +57 300 123 4567). Se guarda aunque no se publique."
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

            <Field
              id="venue-contact-email"
              label="Correo del encargado"
              hint="Solo se publica si activas el canal Correo."
            >
              <input
                id="venue-contact-email"
                type="email"
                value={venueContactEmail}
                onChange={(e) => setVenueContactEmail(e.target.value)}
                className="field"
                maxLength={200}
                inputMode="email"
                placeholder="reservas@tubar.com"
              />
            </Field>

            <label className="pf-check-row" htmlFor="venue-contact-team">
              <input
                id="venue-contact-team"
                type="checkbox"
                checked={contactTeamVisible}
                onChange={(e) => setContactTeamVisible(e.target.checked)}
                className="pf-check"
              />
              <span>
                <span className="pf-label">Mostrar este contacto a mi equipo</span>
                <span className="pf-hint">
                  Visible para las personas con acceso a esta organización.
                </span>
              </span>
            </label>

            <label className="pf-check-row" htmlFor="venue-public-contact">
              <input
                id="venue-public-contact"
                type="checkbox"
                checked={publicContactEnabled}
                onChange={(e) => {
                  setPublicContactEnabled(e.target.checked);
                  if (e.target.checked && publicChannels.length === 0) {
                    const available = [
                      venueContactPhone.trim() && "whatsapp",
                      venueContactEmail.trim() && "email",
                    ].filter(Boolean);
                    setPublicChannels(available.slice(0, 1));
                  }
                  setVenueMsg(null);
                }}
                className="pf-check"
              />
              <span>
                <span className="pf-label">Publicar contacto en la página del evento</span>
                <span className="pf-hint">
                  Sin esta autorización, el contacto guardado no aparece en
                  ninguna ficha pública.
                </span>
              </span>
            </label>

            <div className="pf-channel-box" aria-disabled={!publicContactEnabled}>
              <p className="pf-label">Canales publicados</p>
              <label className="pf-check-row" htmlFor="channel-whatsapp">
                <input
                  id="channel-whatsapp"
                  type="checkbox"
                  checked={publicChannels.includes("whatsapp")}
                  disabled={!publicContactEnabled}
                  onChange={() => toggleChannel("whatsapp")}
                  className="pf-check"
                />
                <span>
                  <span className="pf-label">WhatsApp</span>
                  <span className="pf-hint">
                    {venueContactPhone.trim()
                      ? `Se publicará ${venueContactPhone.trim()}.`
                      : "Falta el teléfono: no se puede publicar este canal."}
                  </span>
                </span>
              </label>
              <label className="pf-check-row" htmlFor="channel-email">
                <input
                  id="channel-email"
                  type="checkbox"
                  checked={publicChannels.includes("email")}
                  disabled={!publicContactEnabled}
                  onChange={() => toggleChannel("email")}
                  className="pf-check"
                />
                <span>
                  <span className="pf-label">Correo</span>
                  <span className="pf-hint">
                    {venueContactEmail.trim()
                      ? `Se publicará ${venueContactEmail.trim()}.`
                      : "Falta el correo de contacto: no se puede publicar este canal."}
                  </span>
                </span>
              </label>
            </div>

            {/* Estado REAL guardado en el servidor, no el borrador local. */}
            <p className="pf-saved-state">
              <Icon name="check" className="h-4 w-4" aria-hidden="true" />
              {adminVenue.public_contact_enabled
                ? `Publicado ahora: ${
                    (adminVenue.public_contact_channels || []).join(", ") ||
                    "sin canales (no se muestra)"
                  }.`
                : "Ahora mismo tu contacto no se publica."}
            </p>

            <div className="pf-public-preview">
              <p className="pf-label">Así lo verá el público</p>
              <div className="pf-public-card">
                <strong>{venueContactName.trim() || venueName.trim() || "Tu organización"}</strong>
                {publicContactEnabled &&
                (publicChannels.includes("whatsapp") ||
                  publicChannels.includes("email")) ? (
                  <ul className="pf-public-channels">
                    {publicChannels.includes("whatsapp") && venueContactPhone.trim() && (
                      <li>
                        <Icon name="whatsapp" className="h-4 w-4" aria-hidden="true" />
                        {venueContactPhone.trim()}
                      </li>
                    )}
                    {publicChannels.includes("email") && venueContactEmail.trim() && (
                      <li>
                        <Icon name="link" className="h-4 w-4" aria-hidden="true" />
                        {venueContactEmail.trim()}
                      </li>
                    )}
                  </ul>
                ) : (
                  <p className="pf-hint">Sin contacto publicado en la ficha.</p>
                )}
              </div>
              <p className="pf-hint">
                Esta vista usa lo que tienes en el formulario. La ficha pública
                solo cambia cuando guardas y el servidor lo confirma.
              </p>
            </div>

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
                <span>{venueMsg.text}</span>
                {!venueMsg.ok && !venueBusy && (
                  <button
                    type="button"
                    onClick={saveVenue}
                    className="btn-ghost pf-action"
                  >
                    Reintentar
                  </button>
                )}
              </div>
            )}

            <div className="pf-form-actions pf-form-actions-sticky">
              <button
                type="submit"
                disabled={venueBusy || !venueDirty}
                className="btn-primary"
              >
                {venueBusy ? "Guardando…" : "Guardar organización"}
              </button>
              <button
                type="button"
                onClick={resetVenueDraft}
                disabled={venueBusy || !venueDirty}
                className="btn-ghost pf-action"
              >
                Cancelar
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
            <h3 className="pf-sub-title">Avisos de puerta</h3>
            <p className="pf-hint pf-hint-block">
              Comprobamos tres cosas antes de decir que está activo: permiso del
              navegador, suscripción de este dispositivo y registro confirmado
              por el servidor. La campana interna funciona aunque el push falle.
            </p>
            <PushToggle venueId={activeVenue?.id ?? currentVenueId} />
          </div>
        </section>
      )}

      {/* ---------------- Privacidad y datos ---------------- */}
      {activeTab === "privacidad" && (
        <section
          id="pf-panel-privacidad"
          role="tabpanel"
          aria-labelledby="pf-tab-privacidad"
          tabIndex={0}
          className="card pf-panel"
        >
          <PanelHead
            title="Privacidad y datos"
            hint="Qué compartes, qué puedes descargar y qué pasa si eliminas tu cuenta. Nada se publica sin una autorización explícita."
          />

          <div className="pf-sub">
            <h3 className="pf-sub-title">Visibilidad del contacto</h3>
            <dl className="pf-details">
              <div className="pf-detail-row">
                <dt>Contacto personal</dt>
                <dd>
                  {user.share_contact_with_team
                    ? "Compartido con tu equipo"
                    : "Privado"}
                </dd>
              </div>
              {adminVenue && (
                <div className="pf-detail-row">
                  <dt>Fichas públicas de {adminVenue.name}</dt>
                  <dd>
                    {adminVenue.public_contact_enabled &&
                    (adminVenue.public_contact_channels || []).length > 0
                      ? `Visible: ${(adminVenue.public_contact_channels || [])
                          .map((c) => (c === "whatsapp" ? "WhatsApp" : "Correo"))
                          .join(" y ")}`
                      : "Sin contacto publicado"}
                  </dd>
                </div>
              )}
            </dl>
            <p className="pf-hint pf-hint-block">
              El teléfono y el correo nuevos son privados hasta que autorices
              compartirlos o publicarlos. Los datos que ya estaban publicados
              siguen visibles con el mismo alcance hasta que cambies esa
              autorización.
            </p>
            <div className="pf-form-actions">
              <button
                type="button"
                onClick={() => selectTab("cuenta")}
                className="btn-ghost pf-action"
              >
                Gestionar contacto personal
              </button>
              {adminVenue && (
                <button
                  type="button"
                  onClick={() => selectTab("negocio")}
                  className="btn-ghost pf-action"
                >
                  Gestionar contacto público
                </button>
              )}
            </div>
          </div>

          <div className="pf-sub">
            <h3 className="pf-sub-title">Descargar mis datos</h3>
            <p className="pf-hint pf-hint-block">
              Incluye tus datos de cuenta, tus membresías, los documentos que
              aceptaste y tus preferencias. No incluye contraseñas, tokens ni
              los datos de tus clientes. Pedimos tu contraseña otra vez porque
              el archivo contiene información personal.
            </p>
            {!exportOpen ? (
              <button
                type="button"
                onClick={() => setExportOpen(true)}
                className="btn-ghost pf-action"
              >
                <Icon name="download" className="h-4 w-4" aria-hidden="true" />
                Descargar mis datos (JSON)
              </button>
            ) : (
              <form onSubmit={downloadData} className="pf-inline-form">
                <input
                  type="password"
                  value={exportPass}
                  onChange={(e) => setExportPass(e.target.value)}
                  className="field"
                  autoComplete="current-password"
                  placeholder="Tu contraseña"
                  required
                />
                <button type="submit" disabled={exportBusy} className="btn-primary">
                  {exportBusy ? "Preparando…" : "Descargar"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setExportOpen(false);
                    setExportPass("");
                  }}
                  className="btn-ghost"
                >
                  Cancelar
                </button>
              </form>
            )}
          </div>

          <div className="pf-danger-wrap">
            <div className="enty-perf" aria-hidden="true" />
            <div className="card pf-danger" aria-labelledby="pf-danger-title">
              <h2 id="pf-danger-title" className="pf-danger-title">
                Eliminar mi cuenta
              </h2>
              <p className="pf-danger-copy">
                Es permanente. Si eres el único administrador de una
                organización con equipo o eventos, primero debes asignar otro
                admin. Si no administras datos de terceros, tu cuenta y sus
                organizaciones vacías se eliminan con ella.
              </p>
              {venueCount > 0 && (
                <p className="pf-danger-copy pf-danger-facts">
                  {venueCount === 1
                    ? "Tu cuenta figura en 1 organización."
                    : `Tu cuenta figura en ${venueCount} organizaciones${
                        adminCount > 0 ? ` y administras ${adminCount} de ellas` : ""
                      }.`}{" "}
                  Al eliminarla pierdes el acceso a{" "}
                  {venueCount === 1 ? "ella" : "todas"}, sin vuelta atrás.
                </p>
              )}

              {deletionCheckLoading && (
                <p className="pf-hint" role="status">
                  Comprobando si hay organizaciones que bloqueen el borrado…
                </p>
              )}
              {deletionCheckError && (
                <div role="alert" className="pf-alert pf-alert-bad">
                  <span>
                    No pudimos comprobar si puedes eliminar la cuenta:{" "}
                    {deletionCheckError}
                  </span>
                  <button
                    type="button"
                    onClick={retryDeletionCheck}
                    className="btn-ghost pf-action"
                  >
                    Reintentar
                  </button>
                </div>
              )}
              {deletionCheck && !deletionCheck.can_delete && (
                <div className="pf-deletion-blockers">
                  <p className="pf-delete-warn">
                    El servidor encontró bloqueos. Transfiere la administración
                    antes de eliminar:
                  </p>
                  <ul>
                    {deletionCheck.blockers.map((b) => (
                      <li key={b.venue_id}>
                        <strong>{b.venue_name}</strong>
                        <span>{b.detail}</span>
                      </li>
                    ))}
                  </ul>
                  <button
                    type="button"
                    onClick={() => nav("/admin/organizacion?tab=equipo")}
                    className="btn-ghost pf-action"
                  >
                    Ir al equipo de la organización
                  </button>
                </div>
              )}

              {deletionCheck?.can_delete &&
                (!delOpen ? (
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
                      Escribe tu contraseña y tu correo para confirmar. Esta
                      acción no tiene deshacer.
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
                ))}
            </div>
          </div>
        </section>
      )}
      </div>
      </div>

      {pendingAction && (
        <div
          className="pf-guard"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setPendingAction(null);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="pf-guard-title"
            aria-describedby="pf-guard-copy"
            className="pf-guard-card"
          >
            <h2 id="pf-guard-title" className="pf-guard-title">
              Tienes cambios sin guardar
            </h2>
            <p id="pf-guard-copy" className="pf-guard-copy">
              Si sales ahora, los cambios de esta sección se pierden. Puedes
              guardarlos, descartarlos o seguir editando.
            </p>
            <div className="pf-guard-actions">
              <button
                type="button"
                autoFocus
                onClick={() => setPendingAction(null)}
                className="btn-ghost pf-action"
              >
                Seguir editando
              </button>
              <button
                type="button"
                onClick={discardAndContinue}
                className="btn-ghost pf-action pf-action-danger"
              >
                Descartar y salir
              </button>
              {(activeTab === "cuenta" || activeTab === "negocio") && (
                <button
                  type="button"
                  onClick={saveAndContinue}
                  disabled={nameBusy || venueBusy}
                  className="btn-primary"
                >
                  Guardar y continuar
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
