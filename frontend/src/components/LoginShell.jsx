import { EntySymbol, Logo } from "./Brand";
import { LegalLinks } from "./LegalLinks";
import { roleIdentity } from "../lib/roles";
import { useI18n } from "../i18n";

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
            <h2>{registration ? "Organiza tu próximo evento." : t("login.showcaseTitle")}</h2>
            <p>{registration ? "Publica tu fecha, distribuye boletas y controla el aforo con Enty." : t("login.brandTag")}</p>
          </div>
          <div className="entry-product-preview" aria-hidden="true">
            <img src="/media/enty-puerta.webp" alt="" width="420" height="747" loading="lazy" />
            <img src="/media/enty-aforo.webp" alt="" width="420" height="747" loading="lazy" />
          </div>
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
