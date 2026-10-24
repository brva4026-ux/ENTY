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

// Contadores del dock en caché de módulo: el dock se desmonta/monta con cada
// cambio de tab o al abrir/cerrar un evento, y sin caché repetía /payouts,
// /invitations y /users en cada vuelta (admin ya pide /users una vez más en
// su carga). Con caché, la segunda vuelta pinta el último valor AL INSTANTE y
// refresca en segundo plano (stale-while-revalidate): el badge es orientativo,
// siempre se re-valida contra el server al montar.
const _countsCache = new Map(); // venueId -> counts

export default function BusinessDock({ venueId, section, onNavigate }) {
  const [counts, setCounts] = useState(() => _countsCache.get(venueId) ?? {});

  useEffect(() => {
    if (!venueId) return;
    // Cambio de venue: partir de la caché de ESA venue (no mezclar contadores).
    setCounts(_countsCache.get(venueId) ?? {});
    const safe = (key, url, pick) =>
      apiFetch(url)
        .then((data) =>
          setCounts((c) => {
            const next = { ...c, [key]: pick(data) };
            _countsCache.set(venueId, next);
            return next;
          }),
        )
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
    <nav
      className="bizdock card"
      aria-label="Secciones del negocio"
      data-tour="negocio"
    >
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
          ["puerta", "Puerta", "Qué pasa ahora en la puerta del bar", "door"],
          ["promotores", "Promotores", "Cupo, avance y comisión del mes", "users"],
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

      {/* Fila "Pendientes": lo que espera una acción del admin, no un acceso
          más. Solo existe si hay algo que revisar — una fila vacía permanente
          es ruido y entrena a ignorarla. Hoy la única bandeja con estado
          "pendiente" es Liquidaciones (pending + disputed); si suma otra, se
          agrega un chip aquí sin tocar la grilla de accesos. */}
      {counts.payouts > 0 && (
        <div className="bizdock-pending">
          <span className="bizdock-pending-label">Pendientes</span>
          <button
            type="button"
            className="bizdock-chip"
            onClick={() => {
              haptics.tick();
              onNavigate("liquidaciones");
            }}
          >
            <Icon name="money" className="h-3.5 w-3.5" />
            {counts.payouts} liquidación{counts.payouts === 1 ? "" : "es"} por
            revisar
          </button>
        </div>
      )}
    </nav>
  );
}
