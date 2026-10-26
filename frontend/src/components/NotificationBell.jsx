import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import Icon from "./Icon";
import DoorAlertBanner from "./DoorAlertBanner";
import { useAuth } from "../lib/auth";
import { hasRole } from "../lib/roles";
import {
  fetchUnreadCount,
  listNotifications,
  markNotificationsRead,
} from "../lib/notifications";
import { timeAgo } from "../lib/useLiveRefresh";
import { withViewTransition } from "../lib/viewTransition";

/**
 * Campana de notificaciones in-app (mig 012, transplante de unicall-blue).
 *
 * - Badge con el conteo de no leídas (polling ligero mientras hay sesión).
 * - Dropdown con el feed: las no leídas con punto, "hace X" relativo.
 * - Tap en "Marcar leídas": POST /notifications/read con los ids visibles.
 * - Notificación con `link`: navega a la ruta interna que dejó el trigger.
 *
 * El contenido lo escribe la DB (triggers sobre liquidaciones, invitaciones
 * y reemisiones): este componente no interpreta eventos de negocio.
 */
/** Tile de icono por tipo (patrón activity-icon de distri-stream): color
    del módulo de origen, icono del set común. Desconocido = campana gris. */
const KIND_TILE = {
  payout_created: { icon: "money", tile: "bg-emerald-500/15 text-emerald-400" },
  payout_reviewed: { icon: "check", tile: "bg-emerald-500/15 text-emerald-400" },
  payout_disputed: { icon: "flag", tile: "bg-amber-500/15 text-amber-400" },
  invitation_accepted: { icon: "users", tile: "bg-sky-500/15 text-sky-400" },
  ticket_reissued: { icon: "qr", tile: "bg-violet-500/15 text-violet-300" },
  event_autoclosed: { icon: "clock", tile: "bg-amber-500/15 text-amber-400" },
  door_anomaly: { icon: "shield", tile: "bg-rose-500/15 text-rose-400" },
};

const KIND_LABEL = {
  payout_created: "Liquidación",
  payout_reviewed: "Liquidación",
  payout_disputed: "Disputa",
  invitation_accepted: "Equipo",
  ticket_reissued: "Boleta",
  event_autoclosed: "Evento",
  door_anomaly: "Puerta",
};

export default function NotificationBell() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  // Aviso EN VIVO de duplicados en puerta (mig 026/027). Solo el admin lo
  // recibe; el feed ya lo trae, así que no hay una segunda petición.
  const [doorAlert, setDoorAlert] = useState(null);
  // Ids de door_anomaly ya "vistos" en esta sesión. El primer poll no alerta
  // por avisos viejos: solo los que llegan DESPUÉS de montar el panel.
  const seenDoorIds = useRef(null);
  const isAdmin = hasRole(user, "admin");
  const rootRef = useRef(null);

  const refresh = useCallback(async () => {
    try {
      const [feed, count] = await Promise.all([
        listNotifications(),
        fetchUnreadCount(),
      ]);
      setItems(feed);
      setUnread(count.count);

      // Detección del aviso en vivo: primer poll siembra el set (no alerta
      // por el historial); a partir de ahí, un door_anomaly sin leer y NUEVO
      // se levanta como banner. Un aviso ya leído nunca vuelve a alertar.
      const doorIds = feed
        .filter((n) => n.kind === "door_anomaly")
        .map((n) => n.id);
      if (seenDoorIds.current === null) {
        seenDoorIds.current = new Set(doorIds);
      } else {
        const fresh = feed.find(
          (n) =>
            n.kind === "door_anomaly" &&
            !n.read_at &&
            !seenDoorIds.current.has(n.id),
        );
        doorIds.forEach((id) => seenDoorIds.current.add(id));
        if (fresh) setDoorAlert(fresh);
      }
    } catch {
      // Silencio: la campana nunca debe romper la app (401 redirige solo).
    }
  }, []);

  // No alertar en pantallas de otros roles: la campana vive en el Layout, que
  // también sirve a promotor/bouncer. El aviso es operativo del negocio.
  useEffect(() => {
    if (!isAdmin && doorAlert) setDoorAlert(null);
  }, [isAdmin, doorAlert]);

  const dismissDoorAlert = useCallback(async (n) => {
    setDoorAlert(null);
    setItems((prev) =>
      prev.map((x) => (x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x)),
    );
    setUnread((u) => Math.max(0, u - 1));
    markNotificationsRead([n.id]).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    // Polling suave: igual cadencia que el reporte en vivo (useLiveRefresh).
    const id = setInterval(() => {
      if (!document.hidden) refresh();
    }, 15_000);
    return () => clearInterval(id);
  }, [refresh]);

  // Cerrar al hacer click fuera (patrón dropdown).
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const markAll = async () => {
    const pending = items.filter((n) => !n.read_at).map((n) => n.id);
    if (!pending.length) return;
    try {
      await markNotificationsRead(pending);
      await refresh();
    } catch {
      // Silencio: reintenta en el próximo poll.
    }
  };

  const openItem = async (n) => {
    if (!n.read_at) {
      // Optimista: la UI responde al toque; el server confirma después.
      setItems((prev) =>
        prev.map((x) => (x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x)),
      );
      setUnread((u) => Math.max(0, u - 1));
      markNotificationsRead([n.id]).catch(() => {});
    }
    setOpen(false);
    if (n.link) withViewTransition(() => navigate(n.link));
  };

  return (
    <>
      <div className="relative" ref={rootRef}>
      <button
        onClick={() => {
          setOpen((o) => !o);
          if (!open) refresh();
        }}
        aria-label={`Notificaciones${unread ? ` (${unread} sin leer)` : ""}`}
        className="topbar-hit relative grid h-8 w-8 place-items-center rounded-full text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-200"
      >
        <Icon name="bell" className="h-5 w-5" />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-brand-500 px-1 text-2xs font-bold text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Notificaciones"
          className="absolute right-0 z-40 mt-2 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 shadow-xl shadow-black/40"
        >
          <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2.5">
            <p className="text-sm font-semibold text-zinc-200">Notificaciones</p>
            {unread > 0 && (
              <button
                onClick={markAll}
                className="text-xs font-medium text-brand-400 hover:text-brand-300"
              >
                Marcar leídas
              </button>
            )}
          </div>

          <div className="max-h-96 overflow-y-auto">
            {items.length === 0 && (
              <p className="px-4 py-6 text-center text-sm text-zinc-500">
                Todo tranquilo por acá.
              </p>
            )}            {items.map((n) => {
              const meta = KIND_TILE[n.kind] || { icon: "bell", tile: "bg-zinc-700/40 text-zinc-300" };
              return (
                <button
                  key={n.id}
                  onClick={() => openItem(n)}
                  className={`flex w-full items-start gap-3 border-b border-zinc-800/60 px-4 py-3 text-left transition last:border-0 hover:bg-zinc-800/60 ${
                    n.read_at ? "opacity-60" : ""
                  }`}
                >
                  <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${meta.tile}`}>
                    <Icon name={meta.icon} className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-2xs font-bold uppercase tracking-wide text-zinc-500">
                        {KIND_LABEL[n.kind] || "Aviso"}
                      </span>
                      {!n.read_at && (
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand-400" aria-hidden />
                      )}
                    </span>
                    <span className="mt-0.5 block truncate text-sm font-semibold text-zinc-100">
                      {n.title}
                    </span>
                    <span className="line-clamp-2 block text-xs text-zinc-400">
                      {n.body}
                    </span>
                    <span className="mt-1 block text-2xs text-zinc-500">
                      {timeAgo(new Date(n.created_at))}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
      </div>
      {isAdmin && (
        <DoorAlertBanner
          alert={doorAlert}
          onOpen={dismissDoorAlert}
          onDismiss={dismissDoorAlert}
        />
      )}
    </>
  );
}
