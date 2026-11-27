import { EntySymbol, Logo } from "./Brand";
import { LegalLinks } from "./LegalLinks";
import Icon from "./Icon";
import { roleIdentity } from "../lib/roles";
import { useI18n } from "../i18n";

const FEATURES = ["calendar", "ticket", "qr"];

export function LoginShell({ children, accent = null, footerControl, registration = false }) {
  const { t } = useI18n();
  const activeIdentity = accent ? roleIdentity(accent) : null;

  return (
    <div
      className={`login-page entry-page${registration ? " entry-page--register" : ""}`}
      data-role-accent={activeIdentity?.accent}
    >
      <section className="login-showcase" aria-label={t("login.showcaseLabel")}>
        <div className="login-showcase-inner">
          <div className="login-showcase-brand">
            <Logo size="lg" />
          </div>

          <div className="login-showcase-copy">
            <h2>{registration ? t("login.registerShowcaseTitle") : t("login.showcaseTitle")}</h2>
          </div>
          <ul className="entry-feature-list">
            {FEATURES.map((feature) => (
              <li key={feature}>
                <span className="entry-feature-icon"><Icon name={feature} className="h-5 w-5" aria-hidden="true" /></span>
                {t(`login.showcaseFeatures.${feature}`)}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <main className="login-main">
        <div className="login-main-inner">
          <div className="login-compact-brand">
            <Logo animated={false} />
            <EntySymbol className="entry-brand-watermark" size={144} />
          </div>
          {children}
        </div>
        <footer className="login-legal login-footer">
          <details className="login-legal-disclosure">
            <summary>{t("login.legalLinks")}</summary>
            <LegalLinks />
          </details>
          {footerControl}
        </footer>
      </main>
    </div>
  );
}
