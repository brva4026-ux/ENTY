/**
 * Dock "Del negocio": los accesos que NO dependen de una noche puntual.
 *
 * Vive en modo lista (fuera de un evento abierto). Se extrajo de
 * AdminDashboard porque creció hasta traer sus propios datos: los contadores
 * de cada tarjeta (liquidaciones abiertas, invitaciones vigentes, equipo
 * activo) son una foto fire-and-forget — si un endpoint falla, el contador
 * queda oculto y el dock funciona igual. Nunca bloquea la navegación.
 */
import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { haptics } from "../lib/haptics";
import Icon from "./Icon";

export default function BusinessDock({ venueId, section, onNavigate }) {
  const [counts, setCounts] = useState({});

  useEffect(() => {
    if (!venueId) return;
    const safe = (key, url, pick) =>
      apiFetch(url)
        .then((data) => setCounts((c) => ({ ...c, [key]: pick(data) })))
        .catch(() => {});
    // Liquidaciones que NO están cerradas: acción pendiente del admin.
    safe("payouts", `/venues/${venueId}/payouts`, (rows) =>
      (rows || []).filter((p) => p.status === "pending" || p.status === "disputed")
        .length,
    );
    // Invitaciones vigentes: sin aceptar, sin revocar y no vencidas
    // (la misma definición de validez que usa el backend al aceptar).
    safe("invites", `/auth/venues/${venueId}/invitations`, (rows) =>
      (rows || []).filter(
        (i) => !i.accepted_at && !i.revoked_at && new Date(i.expires_at) > new Date(),
      ).length,
    );
    safe("team", `/venues/${venueId}/users?include_inactive=true`, (rows) =>
      (rows || []).filter((u) => u.is_active !== false).length,
    );
  }, [venueId]);

  return (
    <nav className="bizdock card" aria-label="Secciones del negocio">
      <div className="bizdock-head">
        <div>
          <p className="eyebrow">Gestión de la venue</p>
          <h2 className="display text-lg">Del negocio</h2>
        </div>
        <p className="hidden text-xs text-zinc-500 sm:block">
          Lo que no depende de una noche puntual: números del bar, equipo y
          pagos.
        </p>
      </div>
      <div className="bizdock-grid" role="tablist">
        {[
          ["negocio", "Reportes", "La foto del mes: ventas, puerta y equipo", "chart"],
          ["cobros", "Cobros", "Enlaces de pago y quién ya pagó", "ticket"],
          ["equipo", "Equipo", "Quién vende, quién abre la puerta", "users", counts.team],
          [
            "liquidaciones",
            "Liquidaciones",
            "Comisiones de promotores por periodo",
            "money",
            counts.payouts,
          ],
          [
            "invitaciones",
            "Invitaciones",
            "Suma gente a tu equipo con un enlace",
            "door",
            counts.invites,
          ],
        ].map(([id, label, desc, icon, count]) => {
          const active = section === id;
          return (
            <button
              key={id}
              role="tab"
              aria-selected={active}
              aria-current={active ? "page" : undefined}
              onClick={() => {
                haptics.tick();
                onNavigate(id);
              }}
              className={`bizdock-item${active ? " is-active" : ""}`}
            >
              <span className="bizdock-icon">
                <Icon name={icon} className="h-5 w-5" />
              </span>
              <span className="bizdock-text">
                <span className="bizdock-label">{label}</span>
                <span className="bizdock-desc">{desc}</span>
              </span>
              {count > 0 && <span className="bizdock-count tnum">{count}</span>}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
