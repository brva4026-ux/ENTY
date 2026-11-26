import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import QRCode from "qrcode";
import {
  fetchMyTickets,
  fetchMyTicketToken,
  fetchFanTicketsWithAccess,
  fetchMyTicketQuestions,
  saveMyTicketAnswer,
  fetchMyTicketStream,
  correctMyTicketContact,
} from "../lib/api";
import FanNav from "../components/FanNav";
import { Logo, Spark } from "../components/Brand";
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

/** Contacto recordado de una visita (o de la compra) anterior.
 *  Ley de Tesler: un dato ya escrito no se vuelve a pedir — se precarga. */
function savedContact() {
  try {
    return localStorage.getItem(CONTACT_KEY) || "";
  } catch {
    return ""; // modo privado: sin storage, el campo nace vacío
  }
}
const STATUS = {
  issued: { label: "Válida", tone: "ok" },
  redeemed: { label: "Ya usada", tone: "warn" },
  voided: { label: "Anulada", tone: "bad" },
  refunded: { label: "Reembolsada", tone: "bad" },
};

export default function MyTicketsPage() {
  useDocumentTitle("Mis boletas");
  const [params] = useSearchParams();
  const [contact, setContact] = useState(savedContact);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  // Solo el error de validacion del campo (no los fallos de red) marca el input
  // como invalido: "No pudimos abrir tus boletas" no es culpa del valor escrito.
  const [contactInvalid, setContactInvalid] = useState(false);
  const [notice, setNotice] = useState("");
  // El titulo del aviso depende de si el correo salio de verdad: cuando no hay
  // correo configurado el fan nunca recibira nada, asi que "Revisa tu correo"
  // seria una promesa falsa sobre el mensaje que va justo debajo.
  const [noticeTitle, setNoticeTitle] = useState("Revisa tu correo");
  const [busy, setBusy] = useState(false);
  // Credencial vigente: el enlace firmado del correo o el token de una boleta.
  const [credential, setCredential] = useState(null);

  // QR abierto (boleta cuyo enlace se acaba de generar) + su data URL.
  const [openId, setOpenId] = useState(null);
  const [qr, setQr] = useState(null);
  const [qrError, setQrError] = useState("");
  const [qrBusy, setQrBusy] = useState(false);
  const [panel, setPanel] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [answers, setAnswers] = useState({});
  const [panelBusy, setPanelBusy] = useState(false);
  const [panelError, setPanelError] = useState("");
  const [panelInfo, setPanelInfo] = useState("");
  const [stream, setStream] = useState(null);
  const [editForm, setEditForm] = useState({
    name: "",
    phone: "",
    current: "",
    reason: "",
  });
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    load();
    return () => {
      mounted.current = false;
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
      // El servidor redacta el aviso (mismo texto exista o no la cuenta, para
      // no permitir enumerar). Pero ese texto promete un envio por correo: sin
      // Resend no sale nada, asi que ahi se dice la verdad. Aclarar que este
      // despliegue no envia correos no revela si el contacto tiene boletas.
      if (res.email_configured) {
        setNotice(res.detail || "Te enviamos un enlace a tu correo.");
        setNoticeTitle("Revisa tu correo");
      } else {
        setNotice(
          "Este despliegue no envía correos. Pídeselo al organizador del evento: te lo reenvía al instante.",
        );
        setNoticeTitle("Pídele el enlace al organizador");
      }
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


  function resetPanel() {
    setPanel(null);
    setPanelError("");
    setPanelInfo("");
    setStream(null);
    setQuestions([]);
    setAnswers({});
  }

  async function openQuestions(ticket) {
    setPanel({ ticketId: ticket.ticket_id, kind: "questions" });
    setPanelError("");
    setPanelInfo("");
    setPanelBusy(true);
    try {
      const res = await fetchMyTicketQuestions(ticket.ticket_id, credential);
      setQuestions(res.questions || []);
      setAnswers(
        Object.fromEntries(
          (res.questions || []).map((q) => [q.id, q.answer ?? ""]),
        ),
      );
    } catch (e) {
      setPanelError(e.message || "No pudimos cargar las preguntas");
    } finally {
      setPanelBusy(false);
    }
  }

  async function saveAnswers() {
    const pending = questions.filter((q) => q.can_answer);
    const missing = pending.filter(
      (q) =>
        q.required &&
        (answers[q.id] === "" || answers[q.id] === null || answers[q.id] === undefined),
    );
    if (missing.length) {
      setPanelError("Responde las preguntas obligatorias antes de guardar.");
      return;
    }
    setPanelBusy(true);
    setPanelError("");
    try {
      for (const q of pending) {
        const value = answers[q.id];
        if (value === "" || value === null || value === undefined) continue;
        await saveMyTicketAnswer(
          panel.ticketId,
          q.id,
          credential,
          q.kind === "number" ? Number(value) : value,
        );
      }
      setPanelInfo("Respuestas guardadas. Gracias por ayudar al organizador.");
      const refreshed = await fetchMyTicketQuestions(panel.ticketId, credential);
      setQuestions(refreshed.questions || []);
    } catch (e) {
      setPanelError(e.message || "No pudimos guardar tus respuestas");
    } finally {
      setPanelBusy(false);
    }
  }

  async function openStream(ticket) {
    setPanel({ ticketId: ticket.ticket_id, kind: "stream" });
    setPanelError("");
    setPanelInfo("");
    setPanelBusy(true);
    try {
      setStream(await fetchMyTicketStream(ticket.ticket_id, credential));
    } catch (e) {
      setPanelError(e.message || "No pudimos abrir la transmisión");
    } finally {
      setPanelBusy(false);
    }
  }

  function openCorrection(ticket) {
    setPanel({ ticketId: ticket.ticket_id, kind: "contact" });
    setPanelError("");
    setPanelInfo("");
    setEditForm({
      name: ticket.customer_name || "",
      phone: ticket.customer_phone || "",
      current: "",
      reason: "",
    });
  }

  async function saveCorrection(ticket) {
    const phoneChanged = (editForm.phone || "").trim() !== (ticket.customer_phone || "");
    if (phoneChanged && !editForm.current.trim()) {
      setPanelError(
        "Para cambiar el teléfono confirma el correo o teléfono actual de la boleta.",
      );
      return;
    }
    setPanelBusy(true);
    setPanelError("");
    try {
      const res = await correctMyTicketContact(ticket.ticket_id, credential, {
        customer_name: editForm.name.trim() || undefined,
        customer_phone: editForm.phone.trim() || undefined,
        current_contact: phoneChanged ? editForm.current.trim() : undefined,
        reason: editForm.reason.trim() || undefined,
      });
      setData((prev) => ({
        ...prev,
        tickets: (prev?.tickets || []).map((row) =>
          row.ticket_id === ticket.ticket_id
            ? {
                ...row,
                customer_name: res.customer_name,
                customer_phone: res.customer_phone,
              }
            : row,
        ),
      }));
      setPanelInfo(res.message);
    } catch (e) {
      setPanelError(e.message || "No pudimos corregir tus datos");
    } finally {
      setPanelBusy(false);
    }
  }

  const tickets = data?.tickets ?? [];

  return (
    <div className="home fan">
      <header className="home-head">
        <div className="home-head-left">
          <div className="home-wordmark">
            <Logo />
          </div>
          {/* En escritorio la barra inferior no existe: sin esta nav, boletas
              se quedaba sin forma de volver al catálogo. */}
          <nav className="home-topnav" aria-label="Secciones">
            <TransitionLink to="/inicio">Inicio</TransitionLink>
            <TransitionLink to="/explorar">Explorar</TransitionLink>
            <TransitionLink to="/boletas" aria-current="page">
              Mis boletas
            </TransitionLink>
            <TransitionLink to="/login">Acceso</TransitionLink>
          </nav>
        </div>
        <div className="home-head-right">
          <TransitionLink to="/inicio" className="home-avatar" aria-label="Cartelera">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
              <path d="M4 11l8-7 8 7v9a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z" />
            </svg>
          </TransitionLink>
        </div>
      </header>

      <main className="home-main">
        <section className="fan-entry">
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
        </section>

        {error ? (
          <div className="home-empty" role="alert" id="fan-lookup-error">
            <p>No pudimos continuar</p>
            <span>{error}</span>
          </div>
        ) : notice && !data ? (
          <div className="home-empty" role="status">
            <p>{noticeTitle}</p>
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

                  {t.change_notice && (
                    <div className="fan-change-notice" role="status">
                      <strong>{t.change_notice.title}</strong>
                      <span>{t.change_notice.message}</span>
                    </div>
                  )}

                  <div className="fan-ticket-foot">
                    <span className="fan-ticket-num">Boleta #{t.ticket_id}</span>
                    {t.is_virtual ? (
                      <button
                        type="button"
                        className="home-cta fan-cta"
                        onClick={() => openStream(t)}
                        disabled={!t.stream_active}
                      >
                        {t.stream_active ? "Ver transmisión" : "Transmisión cerrada"}
                      </button>
                    ) : t.has_link ? (
                      isOpen ? (
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
                      )
                    ) : null}
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {t.has_questions && (
                      <button
                        type="button"
                        className="btn-mini"
                        onClick={() => openQuestions(t)}
                      >
                        Preguntas del organizador
                      </button>
                    )}
                    {t.status === "issued" && (
                      <button
                        type="button"
                        className="btn-mini"
                        onClick={() => openCorrection(t)}
                      >
                        Corregir mis datos
                      </button>
                    )}
                    {t.is_virtual && !t.stream_active && t.stream_message && (
                      <span className="text-2xs text-zinc-500">
                        {t.stream_message}
                      </span>
                    )}
                  </div>

                  {isOpen && !t.is_virtual && t.qr_active ? (
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
                            <img
                              src={qr}
                              alt="Código QR de tu boleta"
                              decoding="async"
                            />
                            <Spark size={34} color="var(--e-green-500)" className="fan-qr-spark" />
                          </span>
                          <p className="fan-qr-hint">
                            Presenta este QR en la puerta junto con tu documento.
                          </p>
                        </>
                      ) : null}
                    </div>
                  ) : null}

                  {!t.is_virtual && t.has_link && !t.qr_active ? (
                    <p className="fan-qr-hint fan-qr-wait">{t.qr_message}</p>
                  ) : null}

                  {panel?.ticketId === t.ticket_id && (
                    <div className="mt-3 rounded-xl border border-white/10 bg-white/5 p-3 text-sm">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <strong>
                          {panel.kind === "questions"
                            ? "Preguntas del organizador"
                            : panel.kind === "stream"
                              ? "Transmisión"
                              : "Corregir mis datos"}
                        </strong>
                        <button
                          type="button"
                          className="fan-link"
                          onClick={resetPanel}
                        >
                          Cerrar
                        </button>
                      </div>

                      {panelError && (
                        <p className="mb-2 rounded-lg bg-red-500/10 px-2 py-1 text-xs text-red-300">
                          {panelError}
                        </p>
                      )}
                      {panelInfo && (
                        <p className="mb-2 rounded-lg bg-emerald-500/10 px-2 py-1 text-xs text-emerald-300">
                          {panelInfo}
                        </p>
                      )}

                      {panel.kind === "questions" &&
                        (panelBusy && questions.length === 0 ? (
                          <p className="fan-qr-hint">Cargando preguntas…</p>
                        ) : questions.length === 0 ? (
                          <p className="fan-qr-hint">
                            Este evento no tiene preguntas activas.
                          </p>
                        ) : (
                          <div className="space-y-3">
                            {questions.map((q) => (
                              <label key={q.id} className="block">
                                <span className="block text-xs font-semibold text-zinc-200">
                                  {q.prompt}
                                  {q.required ? " *" : ""}
                                </span>
                                {q.help_text && (
                                  <small className="mb-1 block text-2xs text-zinc-500">
                                    {q.help_text}
                                  </small>
                                )}
                                {q.kind === "select" ? (
                                  <select
                                    className="field mt-1"
                                    value={answers[q.id] ?? ""}
                                    disabled={!q.can_answer || panelBusy}
                                    onChange={(e) =>
                                      setAnswers((prev) => ({
                                        ...prev,
                                        [q.id]: e.target.value,
                                      }))
                                    }
                                  >
                                    <option value="">Elige una opción</option>
                                    {(q.options || []).map((o) => (
                                      <option key={o} value={o}>{o}</option>
                                    ))}
                                  </select>
                                ) : q.kind === "boolean" ? (
                                  <select
                                    className="field mt-1"
                                    value={
                                      answers[q.id] === ""
                                        ? ""
                                        : String(answers[q.id])
                                    }
                                    disabled={!q.can_answer || panelBusy}
                                    onChange={(e) =>
                                      setAnswers((prev) => ({
                                        ...prev,
                                        [q.id]:
                                          e.target.value === ""
                                            ? ""
                                            : e.target.value === "true",
                                      }))
                                    }
                                  >
                                    <option value="">Elige una opción</option>
                                    <option value="true">Sí</option>
                                    <option value="false">No</option>
                                  </select>
                                ) : q.kind === "textarea" ? (
                                  <textarea
                                    className="field mt-1"
                                    rows={3}
                                    value={answers[q.id] ?? ""}
                                    disabled={!q.can_answer || panelBusy}
                                    onChange={(e) =>
                                      setAnswers((prev) => ({
                                        ...prev,
                                        [q.id]: e.target.value,
                                      }))
                                    }
                                  />
                                ) : (
                                  <input
                                    className="field mt-1"
                                    type={q.kind === "number" ? "number" : "text"}
                                    value={answers[q.id] ?? ""}
                                    disabled={!q.can_answer || panelBusy}
                                    onChange={(e) =>
                                      setAnswers((prev) => ({
                                        ...prev,
                                        [q.id]: e.target.value,
                                      }))
                                    }
                                  />
                                )}
                                {!q.can_answer && q.closed_reason && (
                                  <small className="mt-1 block text-2xs text-amber-300">
                                    {q.closed_reason}
                                  </small>
                                )}
                              </label>
                            ))}
                            <button
                              type="button"
                              className="btn-mini"
                              onClick={saveAnswers}
                              disabled={panelBusy}
                            >
                              {panelBusy ? "Guardando…" : "Guardar respuestas"}
                            </button>
                          </div>
                        ))}

                      {panel.kind === "stream" &&
                        (panelBusy ? (
                          <p className="fan-qr-hint">Abriendo transmisión…</p>
                        ) : stream ? (
                          <div className="space-y-2">
                            <p className="text-xs text-zinc-300">{stream.message}</p>
                            {stream.active && stream.url && (
                              <a
                                className="btn-mini inline-block"
                                href={stream.url}
                                target="_blank"
                                rel="noreferrer"
                              >
                                Abrir transmisión
                              </a>
                            )}
                            {stream.instructions && (
                              <p className="text-2xs text-zinc-500">
                                {stream.instructions}
                              </p>
                            )}
                          </div>
                        ) : null)}

                      {panel.kind === "contact" && (
                        <form
                          className="space-y-2"
                          onSubmit={(e) => {
                            e.preventDefault();
                            saveCorrection(t);
                          }}
                        >
                          <p className="text-2xs text-zinc-500">
                            Corrige el nombre o teléfono de esta boleta. No se
                            emite otra boleta ni cambia el titular.
                          </p>
                          <label className="block">
                            <span className="text-2xs text-zinc-400">Nombre</span>
                            <input
                              className="field mt-1"
                              value={editForm.name}
                              onChange={(e) =>
                                setEditForm({ ...editForm, name: e.target.value })
                              }
                            />
                          </label>
                          <label className="block">
                            <span className="text-2xs text-zinc-400">Teléfono</span>
                            <input
                              className="field mt-1"
                              value={editForm.phone}
                              onChange={(e) =>
                                setEditForm({ ...editForm, phone: e.target.value })
                              }
                            />
                          </label>
                          {(editForm.phone || "").trim() !==
                            (t.customer_phone || "") && (
                            <label className="block">
                              <span className="text-2xs text-zinc-400">
                                Confirma el correo o teléfono actual de la boleta
                              </span>
                              <input
                                className="field mt-1"
                                value={editForm.current}
                                onChange={(e) =>
                                  setEditForm({
                                    ...editForm,
                                    current: e.target.value,
                                  })
                                }
                                placeholder="Para cambiar el teléfono"
                              />
                            </label>
                          )}
                          <label className="block">
                            <span className="text-2xs text-zinc-400">
                              Motivo (opcional)
                            </span>
                            <input
                              className="field mt-1"
                              value={editForm.reason}
                              onChange={(e) =>
                                setEditForm({ ...editForm, reason: e.target.value })
                              }
                            />
                          </label>
                          <button
                            type="submit"
                            className="btn-mini"
                            disabled={panelBusy}
                          >
                            {panelBusy ? "Guardando…" : "Guardar corrección"}
                          </button>
                        </form>
                      )}
                    </div>
                  )}
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
