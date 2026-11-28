import { Link } from "react-router-dom";
import Icon from "./Icon";
import { EntySymbol } from "./Brand";
import { roleI18nKey, roleIdentity } from "../lib/roles";
import { useDialogA11y } from "../lib/useDialogA11y";
import { useI18n } from "../i18n";

function firstNameOf(user) {
  const fullName = user?.full_name?.trim();
  return fullName?.split(/\s+/)[0] || user?.username || user?.email?.split("@")[0] || "";
}

const TASK_ICONS = {
  admin: ["calendar", "ticket", "chart"],
  promotor: ["ticket", "link", "chart"],
  bouncer: ["qr", "users", "flag"],
};

export function WelcomeOverlay({ user, role, roles, onSelectRole, onContinue }) {
  const { t } = useI18n();
  const { dialogRef, titleId } = useDialogA11y({});
  const identity = roleIdentity(role);
  const roleKey = roleI18nKey(role);
  const roleCopy = `login.roles.${roleKey}`;
  const roleLabel = t(`${roleCopy}.label`);
  const name = firstNameOf(user);
  const multiple = roles.length > 1;

  return (
    <div className="welcome-scrim" data-role-accent={identity.accent}>
      <section ref={dialogRef} className="welcome-card welcome-card--role" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="welcome-hero">
          <div className="welcome-hero-copy">
            <div className="welcome-hero-brand" aria-label="Enty">
              <EntySymbol size={24} />
              <span>Enty</span>
            </div>
            <span className="welcome-role-name">{roleLabel}</span>
            <h2 id={titleId} className={name ? "sr-only" : "welcome-title"}>{t(`${roleCopy}.welcome`)}</h2>
            {name && (
              <p className="welcome-title welcome-hello">{t("login.welcome.hello")} <strong>{name}</strong>.</p>
            )}
            <p className="welcome-session">
              <Icon name="check" className="h-4 w-4" aria-hidden="true" />
              {t("login.welcome.kicker")}
            </p>
          </div>
          <div className="welcome-emblem" aria-hidden="true">
            <span><Icon name={identity.icon} /></span>
          </div>
        </header>

        <div className="welcome-card-content">
          {multiple && (
            <div className="welcome-role-picker" role="group" aria-label={t("login.welcome.chooseRoleAria")}>
              <p className="welcome-role-picker-label">{t("login.welcome.rolesLabel")}</p>
              <div className="welcome-role-options">
                {roles.map((option) => (
                  <button key={option} type="button" className="welcome-role-option" aria-pressed={option === role} onClick={() => onSelectRole(option)}>
                    <Icon name={roleIdentity(option).icon} className="h-4 w-4" aria-hidden="true" />
                    {t(`login.roles.${roleI18nKey(option)}.label`)}
                  </button>
                ))}
              </div>
            </div>
          )}

          <ul className="welcome-role-tasks" aria-label={t("login.welcome.tasksLabel")}>
            {TASK_ICONS[roleKey].map((icon, index) => (
              <li key={icon}>
                <span className="welcome-task-icon"><Icon name={icon} aria-hidden="true" /></span>
                <span>{t(`${roleCopy}.task${index + 1}`)}</span>
              </li>
            ))}
          </ul>

          {role === "bouncer" && <p className="welcome-role-note">{t("login.welcome.doorNote")}</p>}

          <button type="button" className="welcome-continue" data-dialog-autofocus onClick={onContinue}>
            {t("login.welcome.continue", { role: roleLabel })}
            <Icon name="arrowRight" className="h-4 w-4" aria-hidden="true" />
          </button>

          <div className="welcome-role-footer">
            {user?.email && <span className="welcome-email">{user.email}</span>}
            <Link to="/perfil?tab=cuenta#username" className="welcome-account-link">
              {t("login.welcome.changeUsername")}
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
