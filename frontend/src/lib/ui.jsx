/**
 * Sistema de feedback premium: toasts (éxito/error/info) y confirmDialog/
 * prompt/alert promise-based. Reemplaza window.confirm/prompt/alert por
 * componentes con la estética de la marca, animaciones de entrada/salida,
 * foco gestionado y cierre con Escape / clic exterior.
 *
 * Uso:
 *   const ui = useUI();
 *   ui.toast("Boleta emitida", "success");
 *   if (await ui.confirm("¿Anular la boleta?", { danger: true })) { ... }
 *   const nombre = await ui.prompt("Escribe el nombre del evento para confirmar");
 *
 * ToastHost + ConfirmHost se montan una vez en <App/> (main.jsx).
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { haptics } from "./haptics";

const UIContext = createContext(null);

let _nextId = 1;

// ---------------------------------------------------------------------------
// Iconos (inline, sin dependencias)
// ---------------------------------------------------------------------------
function Icon({ path, className = "h-5 w-5" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d={path} />
    </svg>
  );
}
const ICONS = {
  success: "M20 6 9 17l-5-5",
  error: "M18 6 6 18M6 6l12 12",
  info: "M12 8v5m0 3v.5M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z",
};
const ALERT_ICONS = {
  danger: "M12 9v4m0 4v.5M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  confirm: "M9 12l2 2 4-4m6-1a9 9 0 1 1-18 0 9 9 0 0 1 18 0z",
};

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------
const TOAST_STYLES = {
  success: { cls: "border-emerald-800/60 bg-emerald-950/90 text-emerald-200", icon: ICONS.success },
  error: { cls: "border-red-800/60 bg-red-950/90 text-red-200", icon: ICONS.error },
  info: { cls: "border-zinc-700 bg-zinc-900/95 text-zinc-200", icon: ICONS.info },
};

export function ToastHost({ toasts, dismiss }) {
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-20 z-[70] flex flex-col items-center gap-2 px-4 md:bottom-6"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          data-kind={t.kind}
          className={`toast-in pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-xl border px-4 py-3 text-sm ${TOAST_STYLES[t.kind]?.cls ?? TOAST_STYLES.info.cls}`}
        >
          <Icon path={TOAST_STYLES[t.kind]?.icon ?? ICONS.info} className="mt-0.5 h-4 w-4 shrink-0" />
          <p className="min-w-0 flex-1 break-words leading-snug">{t.message}</p>
          <button
            onClick={() => dismiss(t.id)}
            aria-label="Cerrar aviso"
            className="-m-1 shrink-0 rounded p-1 opacity-60 transition hover:opacity-100"
          >
            <Icon path={ICONS.error} className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Diálogo (confirm / prompt / alert) — una instancia a la vez
// ---------------------------------------------------------------------------
function Dialog({ spec, resolve, onClose }) {
  const inputRef = useRef(null);
  const [value, setValue] = useState(spec.initial ?? "");
  const [closing, setClosing] = useState(false);

  const finish = useCallback(
    (result) => {
      setClosing(true);
      setTimeout(() => {
        resolve(result);
        onClose();
      }, 140); // dura lo mismo que la animación de salida
    },
    [resolve, onClose]
  );

  useEffect(() => {
    // Foco al montar: al input (prompt) o al botón seguro (confirm/alert).
    const t = setTimeout(() => {
      if (spec.kind === "prompt" && inputRef.current) inputRef.current.select();
      else document.getElementById("dialog-primary-btn")?.focus();
    }, 30);
    const onKey = (e) => {
      if (e.key === "Escape") finish(spec.kind === "prompt" ? null : false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", onKey);
    };
  }, [spec, finish]);

  const primaryCls = spec.danger
    ? "rounded-lg bg-red-600 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-red-500 active:scale-[0.98]"
    : "btn-primary";
  const icon = spec.danger ? ALERT_ICONS.danger : ALERT_ICONS.confirm;

  return (
    <div
      className={`fixed inset-0 z-[80] flex items-end justify-center p-4 sm:items-center ${closing ? "dialog-backdrop-out" : "dialog-backdrop"}`}
      onMouseDown={(e) => e.target === e.currentTarget && finish(spec.kind === "prompt" ? null : false)}
      role="dialog"
      aria-modal="true"
    >
      <div className={`dialog-panel w-full max-w-sm p-5 ${closing ? "dialog-out" : "dialog-in"}`}>
        <div className="flex items-start gap-3">
          <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-full ${spec.danger ? "bg-red-950/70 text-red-400 ring-1 ring-red-500/30" : "bg-brand-500/15 text-brand-300 ring-1 ring-brand-500/30"}`}>
            <Icon path={icon} className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="display text-base text-white">{spec.title}</h3>
            {spec.message && (
              <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-zinc-400">
                {spec.message}
              </p>
            )}
          </div>
        </div>

        {spec.kind === "prompt" && (
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && finish(value)}
            placeholder={spec.placeholder}
            autoComplete="off"
            className="field mt-4"
          />
        )}

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          {spec.kind !== "alert" && (
            <button onClick={() => finish(spec.kind === "prompt" ? null : false)} className="btn-ghost text-sm font-semibold">
              {spec.cancelLabel ?? "Cancelar"}
            </button>
          )}
          <button
            id="dialog-primary-btn"
            onClick={() => finish(spec.kind === "prompt" ? value : true)}
            className={primaryCls}
          >
            {spec.confirmLabel ?? (spec.kind === "prompt" ? "Confirmar" : spec.kind === "alert" ? "Entendido" : spec.danger ? "Sí, continuar" : "Aceptar")}
          </button>
        </div>
      </div>
    </div>
  );
}

export function UIProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const [dialog, setDialog] = useState(null); // { spec, resolve }
  const timers = useRef(new Map());

  const dismiss = useCallback((id) => {
    setToasts((ts) => ts.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const toast = useCallback(
    (message, kind = "info", { duration = 4000 } = {}) => {
      const id = _nextId++;
      setToasts((ts) => [...ts.slice(-3), { id, message, kind }]); // máx 4 en pantalla
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), duration)
      );
      if (kind === "error") haptics.warn();
      return id;
    },
    [dismiss]
  );

  const openDialog = useCallback((spec) => {
    haptics.tick();
    return new Promise((resolve) => setDialog({ spec, resolve }));
  }, []);

  const ui = {
    toast,
    success: (m, o) => toast(m, "success", o),
    error: (m, o) => toast(m, "error", o),
    info: (m, o) => toast(m, "info", o),
    confirm: (title, opts = {}) =>
      openDialog({ kind: "confirm", danger: !!opts.danger, ...opts, title }),
    prompt: (title, opts = {}) =>
      openDialog({ kind: "prompt", danger: !!opts.danger, ...opts, title }),
    alert: (title, opts = {}) => openDialog({ kind: "alert", ...opts, title }),
  };

  return (
    <UIContext.Provider value={ui}>
      {children}
      <ToastHost toasts={toasts} dismiss={dismiss} />
      {dialog && (
        <Dialog
          spec={dialog.spec}
          resolve={dialog.resolve}
          onClose={() => setDialog(null)}
        />
      )}
    </UIContext.Provider>
  );
}

export function useUI() {
  return useContext(UIContext);
}
