import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import Icon from "./Icon";

/**
 * Aviso EN VIVO de duplicados en puerta.
 *
 * mig 026 ya convierte una rafaga de reescaneos del mismo ticket (firma de un
 * QR reenviado) en una notificacion in-app + push. Pero la campana es pasiva:
 * el admin solo la ve si la abre. Este banner es la parte activa — cuando
 * llega un `door_anomaly` nuevo, se planta encima del contenido hasta que el
 * admin lo atiende. Es la diferencia entre "el dato esta ahi" y "el dato te
 * encuentra".
 *
 * Presentacional a proposito: quien detecta el aviso (y lo marca leido) es la
 * campana (`NotificationBell`), que ya polea el feed; este componente solo lo
 * pinta. Asi no hay una segunda peticion por el mismo dato.
 *
 * Se pinta por PORTAL a document.body: el aviso nace dentro del topbar, que
 * lleva `backdrop-filter` — eso lo vuelve containing block de sus `fixed` y
 * atraparia el banner dentro de la cabecera. El portal lo saca a la raiz.
 *
 * `alert` es la notificacion: { id, title, body, link }. `link` apunta a
 * `/admin?event=<id>` (mig 027), asi que un toque abre el backstage de ESA
 * noche, donde la salud de puerta se ve en vivo.
 */
export default function DoorAlertBanner({ alert, onOpen, onDismiss }) {
  const navigate = useNavigate();
  if (!alert) return null;

  const open = () => {
    onOpen?.(alert);
    navigate(alert.link || "/admin");
  };

  return createPortal(
    <div
      role="alert"
      data-door-alert
      className="door-alert-in fixed inset-x-0 top-14 z-[45] mx-auto flex max-w-5xl items-start gap-3 px-4"
    >
      <div className="flex w-full items-start gap-3 rounded-xl border var(--e-border-strong) bg var(--e-surface-2) px-4 py-3 text var(--e-text-primary) shadow-lg var(--e-shadow-card) backdrop-blur">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg var(--e-brand-400) / 20 text var(--e-brand-400)">
          <Icon name="shield" className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold leading-tight">{alert.title}</p>
          <p className="mt-0.5 text-xs leading-snug text-rose-200/90">
            {alert.body}
          </p>
          <button
            onClick={open}
            className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg var(--e-brand-500) / 90 px-3 py-1.5 text-xs font-bold text var(--e-paper) transition hover:bg var(--e-brand-400) active:scale-[0.98]"
          >
            Ver la noche
            <Icon name="back" className="h-3.5 w-3.5 rotate-180" />
          </button>
        </div>
        <button
          onClick={() => onDismiss?.(alert)}
          aria-label="Descartar aviso"
          className="-m-1 shrink-0 rounded p-1 text var(--e-text-subtle) transition hover:text var(--e-text-on-surface)"
        >
          <Icon name="close" className="h-4 w-4" />
        </button>
      </div>
    </div>,
    document.body,
  );
}
