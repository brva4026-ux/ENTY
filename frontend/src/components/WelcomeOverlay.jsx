import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import Icon from "./Icon";
import { prefersReducedMotion } from "../lib/motion";
import { roleIdentity } from "../lib/roles";

/** Primer nombre para el saludo: "Ana Maria Lopez" -> "Ana". */
function firstNameOf(user) {
  const full = (user?.full_name || "").trim();
  if (full) return full.split(/\s+/)[0];
  return user?.username || (user?.email || "").split("@")[0] || "";
}

/** Dos tarjetas de operación para Administración; se animan una vez. */
function SalesArt() {
  return (
    <div className="welcome-art welcome-art--sales" aria-hidden="true">
      <span className="welcome-art-card welcome-art-card--sales">
        <span className="welcome-art-kicker">Ventas</span>
        <span className="welcome-art-bars">
          <i />
          <i />
          <i />
          <i />
        </span>
      </span>
      <span className="welcome-art-card welcome-art-card--capacity">
        <span className="welcome-art-kicker">Aforo</span>
        <span className="welcome-art-ring">
          <i />
        </span>
      </span>
    </div>
  );
}

/** Una boleta con brillo para Promotores. */
function TicketArt() {
  return (
    <div className="welcome-art welcome-art--ticket" aria-hidden="true">
      <span className="welcome-art-ticket">
        <Icon name="ticket" className="h-7 w-7" />
        <i />
      </span>
    </div>
  );
}

/** Una línea de escaneo cruza la boleta para Puerta. */
function ScanArt() {
  return (
    <div className="welcome-art welcome-art--scan" aria-hidden="true">
      <span className="welcome-art-ticket welcome-art-ticket--scan">
        <Icon name="qr" className="h-7 w-7" />
        <i />
        <b />
      </span>
    </div>
  );
}

function RoleArt({ animation }) {
  if (animation === "sales") return <SalesArt />;
  if (animation === "ticket") return <TicketArt />;
  return <ScanArt />;
}

/**
 * Bienvenida personalizada tras un login correcto.
 *
 * Solo se monta con una sesión ya autenticada: el rol, el acento y el destino
 * salen de `user.roles`, nunca de lo que la persona escribió. La barra es real
 * mientras el login termina; con varios roles la tarjeta se queda para que la
 * persona elija y el botón de entrada está disponible de inmediato.
 */
export function WelcomeOverlay({
  user,
  done,
  role,
  roles = [],
  onSelectRole,
  onContinue,
}) {
  const [progress, setProgress] = useState(0);
  const timer = useRef(0);
  const doneRef = useRef(done);
  doneRef.current = done;

  const identity = roleIdentity(role);
  const name = firstNameOf(user);
  const multiple = roles.length > 1;

  useEffect(() => {
    if (!done) return undefined;
    const id = setTimeout(() => setProgress(100), 160);
    return () => clearTimeout(id);
  }, [done]);

  useEffect(() => {
    if (prefersReducedMotion()) {
      setProgress(doneRef.current ? 100 : 60);
      return undefined;
    }
    let current = 0;
    const tick = () => {
      if (doneRef.current) return;
      current += (92 - current) * 0.11;
      setProgress(current);
      timer.current = window.setTimeout(tick, 30);
    };
    timer.current = window.setTimeout(tick, 30);
    return () => window.clearTimeout(timer.current);
  }, []);

  useEffect(() => {
    if (done) setProgress(100);
  }, [done]);

  const pct = Math.round(progress);
  const status = !done
    ? "Confirmando permisos…"
    : multiple
      ? "Elige cómo entrar"
      : "Permisos confirmados. Ingresando...";

  return (
    <div className="welcome-scrim" data-role-accent={identity.accent}>
      <div
        className="welcome-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="welcome-title"
        aria-busy={!done}
      >
        <div className="welcome-role-head">
          <span className="welcome-role-icon" aria-hidden="true">
            <Icon name={identity.icon} className="h-5 w-5" />
          </span>
          <span className="welcome-role-name">{identity.plural}</span>
        </div>

        <div key={role} className="welcome-art-wrap">
          <RoleArt animation={identity.animation} />
        </div>

        <h2 id="welcome-title" className="welcome-title">
          {identity.welcome}
        </h2>

        <p className="welcome-hello">
          Hola, <strong>{name}</strong>.
        </p>
        {user?.email && <p className="welcome-email">{user.email}</p>}
        <p className="welcome-account">
          {user?.username && <span>@{user.username} · </span>}
          <Link to="/perfil?tab=cuenta#username" className="welcome-account-link">
            Cambiar usuario
          </Link>
        </p>

        {multiple && (
          <div className="welcome-role-picker" role="group" aria-label="Elige tu rol">
            <p className="welcome-role-picker-label">Tus accesos</p>
            <div className="welcome-role-options">
              {roles.map((r) => {
                const option = roleIdentity(r);
                return (
                  <button
                    key={r}
                    type="button"
                    className="welcome-role-option"
                    aria-pressed={r === role}
                    onClick={() => onSelectRole?.(r)}
                  >
                    <Icon name={option.icon} className="h-4 w-4" />
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <p className="welcome-status" role="status" aria-live="polite">
          <span className="welcome-status-kicker">¡Bienvenido!</span>
          <span>{status}</span>
        </p>

        <div
          className="welcome-bar"
          role="progressbar"
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow={pct}
          aria-label="Preparando tu panel"
        >
          <span
            className={`welcome-bar-fill${pct >= 100 ? " is-complete" : ""}`}
            style={{ width: `${pct}%` }}
          />
        </div>

        {done && (
          <button type="button" className="welcome-continue" onClick={onContinue}>
            Entrar a {identity.plural}
            <Icon name="arrowRight" className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}
