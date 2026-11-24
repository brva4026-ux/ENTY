import Icon from "./Icon";
import { useDialogA11y } from "../lib/useDialogA11y";

export function PromoterAlert({ tone = "info", children, action = null }) {
  const cls = tone === "danger" ? " promoter-alert--danger"
    : tone === "warn" ? " promoter-alert--warn"
    : tone === "ok" ? " promoter-alert--ok"
    : "";
  return (
    <div className={`promoter-alert${cls}`} role={tone === "danger" ? "alert" : "status"}>
      <Icon name={tone === "danger" ? "alert" : tone === "ok" ? "check" : "sparkle"} className="h-4 w-4" aria-hidden="true" />
      <div>{children}</div>
      {action}
    </div>
  );
}

export function PromoterEmpty({ icon = "ticket", title, children, action = null }) {
  return (
    <div className="promoter-empty">
      <Icon name={icon} className="h-6 w-6" aria-hidden="true" />
      <strong>{title}</strong>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function PromoterSkeleton({ rows = 3 }) {
  return (
    <div className="promoter-page" aria-busy="true" aria-label="Cargando">
      <div className="promoter-skeleton promoter-skeleton--title" />
      <div className="promoter-skeleton promoter-skeleton--line" />
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="promoter-skeleton promoter-skeleton--card" />
      ))}
    </div>
  );
}

export function PromoterDrawer({ title, subtitle, onClose, children, footer = null }) {
  const { dialogRef, titleId } = useDialogA11y({ onClose });
  return (
    <div
      className="promoter-drawer-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="promoter-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="promoter-drawer-head">
          <div>
            <h2 id={titleId}>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button
            type="button"
            className="promoter-btn promoter-btn--sm"
            onClick={onClose}
            aria-label="Cerrar"
          >
            <Icon name="close" aria-hidden="true" />
          </button>
        </div>
        <div className="promoter-drawer-body">{children}</div>
        {footer && <div className="promoter-drawer-actions">{footer}</div>}
      </div>
    </div>
  );
}

export function PromoterStatus({ tone = "neutral", children }) {
  return <span className={`promoter-status promoter-status--${tone}`}>{children}</span>;
}
