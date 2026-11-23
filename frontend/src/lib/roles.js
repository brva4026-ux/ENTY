/**
 * Roles: UN solo lugar con la jerarquía, las etiquetas y las consultas.
 *
 * Antes cada página re-hacía `Object.values(user.roles).flat().includes(...)`
 * y "el rol más alto es admin" a mano — tres copias que se desincronizan.
 * La matriz completa (rol × acción, server-side) vive en
 * docs/arquitectura/08-rbac.md; aquí vive solo lo que la UI necesita.
 *
 * IMPORTANTE: esto gobierna la NAVEGACIÓN, no la seguridad. El backend
 * re-verifica roles en DB en cada request (`ensure_roles`): ocultar un menú
 * aquí es experiencia de usuario, no la cerradura.
 */

/** Jerarquía de menor a mayor (el último gana en el header, en el redirect…). */
export const ROLE_RANK = ["bouncer", "promotor", "admin", "super_admin"];

/** Etiquetas visibles (singular). */
export const ROLE_LABELS = {
  super_admin: "Administrador general",
  admin: "Administrador",
  promotor: "Promotor",
  bouncer: "Portero",
};

/** Identidad visual por rol: UN solo lugar decide cómo se ve cada rol.
 *  `chip` = pastilla de etiqueta, `avatar` = iniciales/anillo, `tabAccent`
 *  = acento de texto. El equipo (TeamManager) y el perfil consumen esto. */
export const ROLE_VISUALS = {
  promotor: {
    chip: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
    avatar: "bg-amber-500/20 text-amber-300 ring-amber-500/40",
    tabAccent: "text-amber-300",
  },
  bouncer: {
    chip: "bg-teal-500/15 text-teal-300 ring-teal-500/30",
    avatar: "bg-teal-500/20 text-teal-300 ring-teal-500/40",
    tabAccent: "text-teal-300",
  },
  admin: {
    chip: "bg-violet-500/15 text-violet-300 ring-violet-500/30",
    avatar: "bg-violet-500/20 text-violet-300 ring-violet-500/40",
    tabAccent: "text-violet-300",
  },
  super_admin: {
    chip: "bg-violet-500/15 text-violet-300 ring-violet-500/30",
    avatar: "bg-violet-500/20 text-violet-300 ring-violet-500/40",
    tabAccent: "text-violet-300",
  },
};

/** Identidad de producto por rol: nombre visible, icono, acento y mensaje.
 *  Es la fuente que consumen el login, la bienvenida y el encabezado. */
export const ROLE_IDENTITIES = {
  admin: {
    label: "Administración",
    plural: "Administración",
    icon: "chart",
    accent: "admin",
    welcome: "Bienvenido a Administración",
    description: "Ventas, aforo y equipo en un solo panel.",
    home: "/admin",
    animation: "sales",
  },
  super_admin: {
    label: "Administración general",
    plural: "Administración",
    icon: "shield",
    accent: "admin",
    welcome: "Bienvenido a Administración",
    description: "Control general de la plataforma y sus negocios.",
    home: "/admin",
    animation: "sales",
  },
  promotor: {
    label: "Promotor",
    plural: "Promotores",
    icon: "ticket",
    accent: "promotor",
    welcome: "Tu espacio de promotor",
    description: "Emite boletas y comparte tu cupo.",
    home: "/promotor",
    animation: "ticket",
  },
  bouncer: {
    label: "Puerta",
    plural: "Puerta",
    icon: "qr",
    accent: "bouncer",
    welcome: "Tu acceso de Puerta",
    description: "Escanea y valida el ingreso de esta noche.",
    home: "/bouncer",
    animation: "scan",
  },
};

/** Identidad neutra para roles internos que aún no tienen copy de producto.
 *  Nunca se disfraza de Puerta: un rol desconocido no debe heredar el acento
 *  ni el destino de otro. */
const NEUTRAL_IDENTITY = {
  label: "Acceso",
  plural: "Enty",
  icon: "shield",
  accent: "admin",
  welcome: "Bienvenido a Enty",
  description: "",
  home: "/login",
  animation: "scan",
};

/** Roles operativos en el orden en que se presentan. super_admin se pliega
 *  en administración para no ofrecer dos entradas al mismo panel. */
export function operationalRoles(user) {
  const set = roleSet(user);
  const out = [];
  if (set.has("admin") || set.has("super_admin")) {
    out.push(set.has("admin") ? "admin" : "super_admin");
  }
  if (set.has("promotor")) out.push("promotor");
  if (set.has("bouncer")) out.push("bouncer");
  return out;
}

/** Identidad de un rol, con una salida segura para roles internos nuevos. */
export function roleIdentity(role) {
  return ROLE_IDENTITIES[role] ?? NEUTRAL_IDENTITY;
}

/** Clave de traducción del rol: super_admin comparte la entrada de admin. */
export function roleI18nKey(role) {
  return role === "super_admin" ? "admin" : role;
}

/** Tarea de origen que se puede retomar después de autenticar. */
export function taskFromPath(path) {
  if (!path) return null;
  if (path.startsWith("/puerta")) return { kind: "door" };
  if (path.startsWith("/invitacion")) return { kind: "invitation" };
  return null;
}

/** Rol con el que conviene entrar cuando hay una tarea de origen. */
export function preferredRoleFor(user, roles, task, from) {
  if (task?.kind === "door" && roles.includes("bouncer")) return "bouncer";
  if (task?.kind === "invitation" && task.role && roles.includes(task.role)) {
    return task.role;
  }
  const pathRole = roleForPath(from, user);
  if (pathRole && roles.includes(pathRole)) return pathRole;
  return roles[0];
}

/** Destino final: la tarea de origen manda; si no, el `from` autorizado;
 *  si no, la herramienta propia del rol. */
export function destinationFor(role, from, task) {
  if (from && task) return from;
  if (from && pathAllowsRole(from, role)) return from;
  return roleHomeFor(role);
}

/** Destino propio de un rol (sin mirar la URL de origen). */
export function roleHomeFor(role) {
  return roleIdentity(role).home;
}

/** ¿La ruta pertenece al ámbito de este rol? Se usa para decidir si el
 *  `from` de un deep-link se puede respetar al entrar con ese rol. */
export function pathAllowsRole(pathname, role) {
  if (!pathname) return false;
  if (pathname.startsWith("/admin")) {
    return role === "admin" || role === "super_admin";
  }
  if (pathname.startsWith("/promotor")) return role === "promotor";
  if (pathname.startsWith("/bouncer")) return role === "bouncer";
  return true;
}

/** Rol que corresponde a una ruta autenticada (para el acento del header). */
export function roleForPath(pathname, user) {
  if (pathname?.startsWith("/admin") && hasRole(user, "admin")) {
    return roleSet(user).has("admin") ? "admin" : "super_admin";
  }
  if (pathname?.startsWith("/promotor") && hasRole(user, "promotor")) {
    return "promotor";
  }
  if (pathname?.startsWith("/bouncer") && hasRole(user, "bouncer")) {
    return "bouncer";
  }
  return topRole(user);
}

/** Todos los roles presentes en el usuario (cualquier venue), como set. */
export function roleSet(user) {
  const out = new Set();
  for (const list of Object.values(user?.roles || {})) {
    for (const r of list || []) out.add(r);
  }
  return out;
}

/** El rol más alto que tiene el usuario en cualquier venue (o null). */
export function topRole(user) {
  const set = roleSet(user);
  for (let i = ROLE_RANK.length - 1; i >= 0; i--) {
    if (set.has(ROLE_RANK[i])) return ROLE_RANK[i];
  }
  return null;
}

/** Etiqueta del rol más alto ("" si no tiene). */
export function topRoleLabel(user) {
  const r = topRole(user);
  return r ? ROLE_LABELS[r] : "";
}

/** ¿Tiene el rol (o uno superior) en alguna venue? */
export function hasRole(user, role) {
  const i = ROLE_RANK.indexOf(role);
  if (i < 0) return false;
  const set = roleSet(user);
  // admin implica super_admin no: son cosas distintas; pero para la UI,
  // un super_admin hace todo lo de admin.
  if (role === "admin" && set.has("super_admin")) return true;
  return set.has(role);
}

/** Ruta de inicio según el rol (el redirect de "/" vive sobre esto). */
export function homeForRole(user) {
  if (hasRole(user, "admin")) return "/admin";
  if (hasRole(user, "promotor")) return "/promotor";
  if (hasRole(user, "bouncer")) return "/bouncer";
  return "/login";
}

/** Pestañas de navegación principal (orden fijo, de gestión a puerta).
 *
 * Nombres de DESTINO ("qué hay ahí"), no de rol: "Admin"/"Promotor" le
 * dicen a la persona quién ES, no qué encontrará al tocar. El que tiene dos
 * roles ve dos destinos y entiende ambos sin conocer la org del bar.
 */
export function navTabsFor(user) {
  const tabs = [];
  if (hasRole(user, "admin")) {
    tabs.push({ to: "/admin", label: "Eventos" });
    tabs.push({ to: "/admin/reportes", label: "Reportes" });
    tabs.push({ to: "/admin/organizacion", label: "Organización" });
  }
  if (hasRole(user, "promotor"))
    tabs.push({ to: "/promotor", label: "Vender" });
  if (hasRole(user, "bouncer")) tabs.push({ to: "/bouncer", label: "Escanear" });
  return tabs;
}
