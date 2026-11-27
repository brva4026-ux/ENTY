import { Logo } from "./Brand";
import { LegalLinks } from "./LegalLinks";
import { roleIdentity } from "../lib/roles";
import { useI18n } from "../i18n";

export function LoginShell({ children, accent = null, footerControl }) {
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
          </div>

          <div className="login-showcase-copy">
            <h2>{t("login.showcaseTitle")}</h2>
            <p>{t("login.brandTag")}</p>
          </div>
        </div>
      </section>

      <main className="login-main">
        <div className="login-main-inner">
          <div className="login-compact-brand"><Logo animated={false} /></div>
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
