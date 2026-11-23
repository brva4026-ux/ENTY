import { LoginShowcase } from "./LoginShowcase";
import { Logo } from "./Brand";
import { LegalLinks } from "./LegalLinks";
import Icon from "./Icon";
import { roleI18nKey, roleIdentity } from "../lib/roles";
import { useI18n } from "../i18n";

const SHOWCASE_ROLES = ["admin", "promotor", "bouncer"];

/**
 * Marco de la entrada profesional: video de operación a la izquierda y
 * formulario sobre una superficie sólida a la derecha. En móvil el video se
 * convierte en una portada con reproducción a pedido y el formulario queda
 * debajo, en una sola columna que puede desplazarse con el teclado abierto.
 *
 * `accent` solo llega con una sesión ya autenticada: antes de entrar no se
 * adivina el rol de nadie. Cuando llega, tiñe el panel visual y la portada.
 */
export function LoginShell({ children, accent = null }) {
  const { t } = useI18n();
  const activeIdentity = accent ? roleIdentity(accent) : null;

  return (
    <div
      className="login-page"
      data-role-accent={activeIdentity?.accent}
    >
      <section className="login-showcase" aria-label={t("login.showcaseLabel")}>
        <div className="login-showcase-inner">
          <div className="login-showcase-brand">
            <Logo size="lg" />
            <span className="login-showcase-kicker">{t("login.brandTag")}</span>
          </div>

          <div className="login-showcase-frame">
            <LoginShowcase />
          </div>

          <div className="login-showcase-copy">
            <p className="login-showcase-eyebrow">Enty · operación</p>
            <h2>Una boleta. Un ingreso. Un aforo actualizado.</h2>
            <p>
              Administración, promotores y puerta trabajan sobre la misma
              sesión, con permisos reales y datos en vivo.
            </p>
          </div>

          <ul className="login-showcase-roles" aria-label="Roles de Enty">
            {SHOWCASE_ROLES.map((role) => {
              const identity = roleIdentity(role);
              return (
                <li key={role}>
                  <Icon name={identity.icon} className="h-4 w-4" />
                  {t(`login.roles.${roleI18nKey(role)}.label`)}
                </li>
              );
            })}
          </ul>
        </div>
      </section>

      <main className="login-main">
        <div className="login-main-inner">{children}</div>
        <footer className="login-legal">
          <LegalLinks />
        </footer>
      </main>
    </div>
  );
}
