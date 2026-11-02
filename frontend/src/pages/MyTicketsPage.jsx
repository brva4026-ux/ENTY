import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import QRCode from "qrcode";
import { fetchMyTickets, fetchMyTicketToken, fetchFanTicketsWithAccess } from "../lib/api";
import { forceDarkOnce } from "../lib/theme";
import FanNav from "../components/FanNav";
import { Spark } from "../components/Brand";
import useDocumentTitle from "../lib/useDocumentTitle";
import TransitionLink from "../components/TransitionLink";

/**
 * Mis boletas — la entrada del fan (magic link, sin cuenta).
 *
 * El contacto NO es la credencial: es un dato público. Al pedirlo, se envía un
 * enlace firmado de vida corta al correo (o, si no hay correo configurado, se
 * indica pedírselo al organizador). Con ese enlace —o con el token de otra
 * boleta propia— la pantalla lista las boletas y dibuja el QR.
 *
 * El token crudo se muestra una sola vez y se guarda en localStorage: la DB
 * solo tiene su hash, y es la llave para reabrir la lista sin pedir correo.
 */
const CONTACT_KEY = "tf_fan_contact";
const TOKEN_KEY = "tf_fan_token";
const STATUS = {
  issued: { label: "Válida", tone: "ok" },
  redeemed: { label: "Ya usada", tone: "warn" },
  voided: { label: "Anulada", tone: "bad" },
  refunded: { label: "Reembolsada", tone: "bad" },
};

export default function MyTicketsPage() {
  useDocumentTitle("Mis boletas");
  const [params] = useSearchParams();
  const [contact, setContact] = useState("");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  // Solo el error de validacion del campo (no los fallos de red) marca el input
  // como invalido: "No pudimos abrir tus boletas" no es culpa del valor escrito.
  const [contactInvalid, setContactInvalid] = useState(false);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  // Credencial vigente: el enlace firmado del correo o el token de una boleta.
  const [credential, setCredential] = useState(null);

  // QR abierto (boleta cuyo enlace se acaba de generar) + su data URL.
  const [openId, setOpenId] = useState(null);
  const [qr, setQr] = useState(null);
  const [qrError, setQrError] = useState("");
  const [qrBusy, setQrBusy] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    const restore = forceDarkOnce();
    mounted.current = true;
    load();
    return () => {
      mounted.current = false;
      restore();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Abre la lista con la mejor credencial disponible: el enlace de la URL,
   *  o el token de una boleta guardado de una visita anterior. */
  async function load() {
    const access = params.get("acceso");
    let saved = null;
    try {
      saved = localStorage.getItem(TOKEN_KEY);
    } catch {
      /* modo privado */
    }
    const cred = access ? { token: access } : saved ? { raw_token: saved } : null;
    if (!cred) return;
    try {
      const d = await fetchFanTicketsWithAccess(cred);
      if (!mounted.current) return;
      setCredential(cred);
      setData(d);
      // El enlace de la URL ya cumplió: se limpia para no dejarlo en el
      // historial ni en un marcador compartido.
      if (access) window.history.replaceState({}, "", "/boletas");
    } catch (e) {
      if (mounted.current) setError(e.message || "No pudimos abrir tus boletas");
    }
  }

  async function requestLink() {
    const q = contact.trim();
    if (q.length < 5) {
      setContactInvalid(true);
      setError("Escribe el correo o teléfono con que compraste.");
      return;
    }
    setContactInvalid(false);
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const res = await fetchMyTickets(q);
      try {
        localStorage.setItem(CONTACT_KEY, q);
      } catch {
        /* modo privado */
      }
      setNotice(
        res.email_configured
          ? "Te enviamos un enlace a tu correo. Ábrelo desde este dispositivo."
          : "Pídele el enlace al organizador del evento: te lo reenvía al instante.",
      );
    } catch (e) {
      setError(e.message || "No pudimos enviar el enlace");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function showQr(ticket) {
    setOpenId(ticket.ticket_id);
    setQr(null);
    setQrError("");
    setQrBusy(true);
    try {
      const { raw_token: token } = await fetchMyTicketToken(ticket.ticket_id, credential);
      // El QR se dibuja local: se ve aunque falle la red despues. Mismo nivel
      // de correccion que la boleta (H): escanear en la puerta falla menos.
      const url = await QRCode.toDataURL(token, {
        width: 640,
        margin: 1,
        errorCorrectionLevel: "H",
        color: { dark: "#0B0B0F", light: "#ffffff" },
      });
      // El token recien emitido pasa a ser la credencial guardada: la próxima
      // visita abre la lista sin depender del correo.
      try {
        localStorage.setItem(TOKEN_KEY, token);
      } catch {
        /* modo privado */
      }
      if (mounted.current) setQr(url);
    } catch (e) {
      if (mounted.current) setQrError(e.message || "No pudimos generar tu QR");
    } finally {
      if (mounted.current) setQrBusy(false);
    }
  }

  const tickets = data?.tickets ?? [];

  return (
    <div className="home fan">
      <header className="home-head">
        <div className="home-wordmark">
          <span>Enty</span>
          <svg width="8" height="8" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 0 L14.6 9.4 L24 12 L14.6 14.6 L12 24 L9.4 14.6 L0 12 L9.4 9.4 Z" fill="#8B5CF6" />
          </svg>
        </div>
        <TransitionLink to="/inicio" className="home-avatar" aria-label="Cartelera">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
            <path d="M4 11l8-7 8 7v9a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z" />
          </svg>
        </TransitionLink>
      </header>

      <main className="home-main">
        <div className="home-title">
          <h1>Mis boletas</h1>
          <p>
            Escribe el correo o teléfono con que compraste. Te enviamos un enlace
            seguro para verlas — así nadie más puede abrirlas.
          </p>
        </div>

        <form
          className="fan-lookup"
          onSubmit={(e) => {
            e.preventDefault();
            requestLink();
          }}
        >
          <input
            type="text"
            inputMode="email"
            autoComplete="email"
            placeholder="tucorreo@ejemplo.com o 300 123 4567"
            value={contact}
            onChange={(e) => {
              setContact(e.target.value);
              if (contactInvalid) setContactInvalid(false);
              if (error) setError("");
            }}
            aria-label="Correo o teléfono"
            aria-invalid={contactInvalid ? "true" : undefined}
            aria-describedby={error ? "fan-lookup-error" : undefined}
          />
          <button type="submit" disabled={busy}>
            {busy ? "Enviando…" : "Enviar enlace"}
          </button>
        </form>

        {error ? (
          <div className="home-empty" role="alert" id="fan-lookup-error">
            <p>No pudimos continuar</p>
            <span>{error}</span>
          </div>
        ) : notice && !data ? (
          <div className="home-empty" role="status">
            <p>Revisa tu correo</p>
            <span>{notice}</span>
          </div>
        ) : data && tickets.length === 0 ? (
          <div className="home-empty">
            <p>No encontramos boletas</p>
            <span>Revisa que sea el mismo contacto con el que te las emitieron.</span>
          </div>
        ) : (
          <div className="fan-list">
            {tickets.map((t) => {
              const s = STATUS[t.status] ?? { label: t.status, tone: "warn" };
              const isOpen = openId === t.ticket_id;
              return (
                <article key={t.ticket_id} className="fan-ticket">
                  <div className="fan-ticket-head">
                    <div className="fan-ticket-info">
                      <strong>{t.event_name}</strong>
                      <em>
                        {t.starts_at}
                        {t.location ? ` · ${t.location}` : ""}
                        {t.venue_name ? ` · ${t.venue_name}` : ""}
                      </em>
                    </div>
                    <span className={`fan-badge is-${s.tone}`}>{s.label}</span>
                  </div>

                  {t.has_link ? (
                    <div className="fan-ticket-foot">
                      <span className="fan-ticket-num">Boleta #{t.ticket_id}</span>
                      {isOpen ? (
                        <button
                          type="button"
                          className="fan-link"
                          onClick={() => {
                            setOpenId(null);
                            setQr(null);
                          }}
                        >
                          Ocultar QR
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="home-cta fan-cta"
                          onClick={() => showQr(t)}
                          disabled={!t.qr_active}
                        >
                          {t.qr_active ? "Ver mi QR" : "Aún no activo"}
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="fan-ticket-foot">
                      <span className="fan-ticket-num">Boleta #{t.ticket_id}</span>
                    </div>
                  )}

                  {isOpen && t.qr_active ? (
                    <div className="fan-qr">
                      {qrBusy ? (
                        <p className="fan-qr-hint fan-qr-loading">
                          <Spark size={14} color="var(--e-green-500)" />
                          Generando tu QR…
                        </p>
                      ) : qrError ? (
                        <p className="fan-qr-hint is-bad">{qrError}</p>
                      ) : qr ? (
                        <>
                          <span className="fan-qr-frame reveal-qr">
                            <img src={qr} alt="Código QR de tu boleta" />
                            <Spark size={34} color="var(--e-green-500)" className="fan-qr-spark" />
                          </span>
                          <p className="fan-qr-hint">
                            Presenta este QR en la puerta junto con tu documento.
                          </p>
                        </>
                      ) : null}
                    </div>
                  ) : null}

                  {t.has_link && !t.qr_active ? (
                    <p className="fan-qr-hint fan-qr-wait">{t.qr_message}</p>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}

      </main>
      <FanNav active="boletos" />
    </div>
  );
}
