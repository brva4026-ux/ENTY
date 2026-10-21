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
    chip: "bg-brand-500/15 text-brand-300 ring-brand-500/30",
    avatar: "bg-brand-500/20 text-brand-300 ring-brand-500/40",
    tabAccent: "text-brand-300",
  },
  bouncer: {
    chip: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
    avatar: "bg-emerald-500/20 text-emerald-300 ring-emerald-500/40",
    tabAccent: "text-emerald-300",
  },
  admin: {
    chip: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
    avatar: "bg-amber-500/20 text-amber-300 ring-amber-500/40",
    tabAccent: "text-amber-300",
  },
  super_admin: {
    chip: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
    avatar: "bg-amber-500/20 text-amber-300 ring-amber-500/40",
    tabAccent: "text-amber-300",
  },
};

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
    tabs.push({ to: "/admin/metricas", label: "Métricas" });
  }
  if (hasRole(user, "promotor"))
    tabs.push({ to: "/promotor", label: "Vender" });
  if (hasRole(user, "bouncer")) tabs.push({ to: "/bouncer", label: "Escanear" });
  return tabs;
}
