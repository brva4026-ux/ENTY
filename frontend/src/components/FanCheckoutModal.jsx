import { useEffect, useRef, useState } from "react";
import { useDialogA11y } from "../lib/useDialogA11y";
import {
  startPublicCheckout,
  fetchPublicCheckoutStatus,
  quotePublicCoupon,
} from "../lib/api";
import { money } from "../lib/format";

/**
 * Checkout público del fan: elige localidad, deja su contacto y va a pagar a
 * Wompi. Sin cuenta. El monto lo pone el servidor (precio de la localidad).
 *
 * Tras pagar, Wompi devuelve al detalle con `?pago=<reference>`; el padre
 * abre el modal en modo "espera/resultado" y aquí se hace el polling del
 * estado. La boleta no se entrega aquí: cuando el pago queda aprobado, el fan
 * la reclama con su contacto en "Mis boletas" (el camino auditado de siempre).
 */
const CONTACT_KEY = "tf_fan_contact";

function paidTypes(types) {
  return (types || []).filter(
    (t) => t.is_courtesy === false && (t.price_cents || 0) > 0,
  );
}

export default function FanCheckoutModal({ event, reference, onClose, onPaid }) {
  const { dialogRef, titleId } = useDialogA11y({ onClose });

  const types = paidTypes(event?.ticket_types);
  const [typeId, setTypeId] = useState(
    () => (types.find((t) => !t.sold_out) ?? types[0])?.id ?? null,
  );
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  // Cupón (mig 043): el fan escribe el código y ve el precio final antes de
  // ir a Wompi. La cotización NO consume el cupón (eso pasa en el checkout).
  const [coupon, setCoupon] = useState("");
  const [quote, setQuote] = useState(null);
  const [quoting, setQuoting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Que campo provoco el aviso: el mensaje se enlaza a ESE campo con
  // aria-describedby y se limpia en cuanto el fan lo corrige.
  const [errorField, setErrorField] = useState(null);
  // Campos del formulario, para llevar el foco al que causó el aviso.
  const fieldRefs = useRef({});

  // Modo "en curso": venimos de vuelta de Wompi con una referencia. Se sondea
  // el estado hasta que el webhook resuelva (aprobado/rechazado). El primer
  // sondeo espera unos segundos: el webhook suele tardar menos, pero no es
  // instantáneo.
  const [status, setStatus] = useState(null);
  const [polling, setPolling] = useState(Boolean(reference));

  useEffect(() => {
    if (!reference) return;
    let alive = true;
    let tries = 0;
    let timer;
    const tick = async () => {
      tries += 1;
      try {
        const s = await fetchPublicCheckoutStatus(reference);
        if (!alive) return;
        setStatus(s);
        if (s.status === "pending") {
          if (tries < 20) timer = setTimeout(tick, 3000);
          else setPolling(false);
        } else {
          setPolling(false);
        }
      } catch {
        if (!alive) return;
        if (tries < 20) timer = setTimeout(tick, 3000);
        else setPolling(false);
      }
    };
    timer = setTimeout(tick, 2500);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [reference]);

  // Precarga el contacto recordado (mismo que usa "Mis boletas").
  useEffect(() => {
    if (reference) return;
    try {
      const saved = localStorage.getItem(CONTACT_KEY);
      if (saved && saved.includes("@")) setEmail(saved);
      else if (saved) setPhone(saved);
    } catch {
      /* modo privado */
    }
  }, [reference]);

  const selected = types.find((t) => t.id === typeId) || null;

  // Marca un campo como culpable del aviso. `field` alimenta aria-describedby.
  //
  // Además se lleva el foco ahí: en un móvil, con el teclado abierto, un aviso
  // que nombra "tu teléfono" sin mover el cursor obliga a buscarlo a ciegas
  // por el formulario. El role="alert" ya lo anuncia; esto lo deja listo para
  // corregir.
  function fail(field, message) {
    setErrorField(field);
    setError(message);
    fieldRefs.current[field]?.focus();
  }

  // Corregir un campo destraba el aviso: sin esto el error se quedaba pegado
  // aunque el fan ya hubiera escrito lo que faltaba.
  function clearErrorOn(field) {
    if (errorField === field) {
      setErrorField(null);
      setError("");
    }
  }

  // Al cambiar de localidad, la cotización del cupón deja de ser válida (el
  // descuento depende del precio). Se limpia para no mostrar un precio falso.
  useEffect(() => {
    setQuote(null);
  }, [typeId]);

  async function applyCoupon() {
    const code = coupon.trim();
    if (!code || !typeId) return;
    setQuoting(true);
    setError("");
    try {
      const res = await quotePublicCoupon(event.id, typeId, code);
      setQuote(res);
      if (!res.valid) setError("Ese código no aplica a esta localidad.");
    } catch {
      setQuote(null);
      setError("No pudimos validar el cupón. Intenta de nuevo.");
    } finally {
      setQuoting(false);
    }
  }

  async function submit(e) {
    e.preventDefault();
    if (!typeId || busy) return;
    // El aviso nombra solo lo que falta: decir "nombre y telefono" cuando el
    // fallo es uno solo manda al usuario a revisar un campo que ya estaba bien.
    if (name.trim().length < 1) {
      fail("name", "Escribe tu nombre: va impreso en la boleta.");
      return;
    }
    if (phone.trim().length < 5) {
      fail("phone", "Escribe tu teléfono de WhatsApp (al menos 5 dígitos).");
      return;
    }
    // El form lleva noValidate para que el aviso salga en español, no en inglés
    // como el nativo. Eso deja el correo sin validar: se comprueba aquí.
    const emailTrim = email.trim();
    if (emailTrim && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailTrim)) {
      fail("email", "Ese correo no parece válido. Revísalo o déjalo vacío.");
      return;
    }
    setBusy(true);
    setError("");
    setErrorField(null);
    try {
      const res = await startPublicCheckout(event.id, {
        ticket_type_id: typeId,
        customer_name: name.trim(),
        customer_phone: phone.trim(),
        customer_email: email.trim() || null,
        // Solo se manda el cupón si la cotización lo validó: un código a
        // medias no debe viajar al cobro.
        coupon_code: quote?.valid ? coupon.trim() : null,
      });
      // Recuerda el contacto: es con el que reclamará su QR en /boletas.
      const contact = (email.trim() || phone.trim()).toLowerCase();
      try {
        localStorage.setItem(CONTACT_KEY, contact);
      } catch {
        /* modo privado */
      }
      try {
        sessionStorage.setItem("tf_checkout_ref", res.reference);
      } catch {
        /* modo privado */
      }
      // Sale de la app hacia el checkout de Wompi.
      window.location.assign(res.payment_url);
    } catch (err) {
      setError(err.message || "No pudimos iniciar la compra");
      setBusy(false);
    }
  }

  const approved = status?.approved;

  return (
    <div
      className="dialog-backdrop fixed inset-0 z-[90] flex items-end justify-center overflow-y-auto p-4 sm:items-center"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="dialog-panel my-auto w-full max-w-md p-5"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h3 id={titleId} className="display text-lg">
              {reference ? "Confirmando tu pago" : "Comprar boleto"}
            </h3>
            <p className="mt-0.5 text-xs text-zinc-500">
              {reference
                ? "Esto puede tardar unos segundos."
                : event?.name}
            </p>
          </div>
          <button type="button" onClick={onClose} className="btn-mini">
            Cerrar ✕
          </button>
        </div>

        {reference ? (
          // Región viva: el resultado del pago llega solo, por polling. Sin
          // esto el "¡Pago aprobado!" aparece y nadie lo anuncia.
          <div className="space-y-3" aria-live="polite">
            {approved ? (
              <>
                <p className="text-sm font-semibold text-emerald-300">
                  ¡Pago aprobado! Tu boleta ya está lista.
                </p>
                <p className="text-xs text-zinc-400">
                  Recógela con tu contacto en “Mis boletas”, donde verás tu QR
                  para la puerta.
                </p>
                <button
                  type="button"
                  className="btn-primary w-full"
                  onClick={() => onPaid()}
                >
                  Ver mis boletas
                </button>
              </>
            ) : status?.status === "paid_unfulfilled" ? (
              <>
                <p className="text-sm font-semibold text-amber-300">Recibimos tu pago y requiere revisión.</p>
                <p className="text-xs text-zinc-400">No vuelvas a pagar. El organizador recibió un aviso para resolver tu entrada o gestionar el reembolso.</p>
                <p className="text-xs text-zinc-400">Referencia: {reference}</p>
              </>
            ) : status && status.status !== "pending" ? (
              <>
                <p className="text-sm font-semibold text-rose-300">
                  El pago no se completó.
                </p>
                <p className="text-xs text-zinc-400">
                  No se emitió ninguna boleta. Puedes intentar de nuevo.
                </p>
                <button
                  type="button"
                  className="btn-primary w-full"
                  onClick={onClose}
                >
                  Reintentar
                </button>
              </>
            ) : polling ? (
              <p className="flex items-center gap-2 text-sm text-zinc-300">
                <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                Estamos confirmando el pago con Wompi…
              </p>
            ) : (
              <>
                <p className="text-sm text-zinc-300">
                  Aún no vemos el pago confirmado.
                </p>
                <p className="text-xs text-zinc-400">
                  Si ya pagaste, en unos minutos aparecerá tu boleta. Vuelve a
                  “Mis boletas” con tu contacto.
                </p>
                <button
                  type="button"
                  className="btn-primary w-full"
                  onClick={() => onPaid()}
                >
                  Ver mis boletas
                </button>
              </>
            )}
          </div>
        ) : types.length === 0 ? (
          <p className="text-sm text-zinc-300">
            Este evento no tiene localidades de pago disponibles por ahora.
          </p>
        ) : (
          <form onSubmit={submit} noValidate className="space-y-3">
            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-zinc-400">
                Localidad
              </span>
              <select
                className="field"
                value={typeId ?? ""}
                onChange={(e) => setTypeId(Number(e.target.value))}
              >
                {types.map((t) => (
                  <option key={t.id} value={t.id} disabled={t.sold_out}>
                    {t.name} — {money(t.price_cents)}
                    {t.sold_out ? " (agotada)" : ""}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-zinc-400">
                Tu nombre (va impreso en la boleta)
              </span>
              <input
                ref={(el) => {
                  fieldRefs.current.name = el;
                }}
                className="field"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  clearErrorOn("name");
                }}
                maxLength={200}
                autoComplete="name"
                required
                data-dialog-autofocus
                aria-invalid={errorField === "name" ? "true" : undefined}
                aria-describedby={
                  errorField === "name" ? "checkout-error" : undefined
                }
              />
            </label>

            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-zinc-400">
                Teléfono (WhatsApp)
              </span>
              <input
                ref={(el) => {
                  fieldRefs.current.phone = el;
                }}
                className="field"
                value={phone}
                onChange={(e) => {
                  setPhone(e.target.value);
                  clearErrorOn("phone");
                }}
                maxLength={30}
                autoComplete="tel"
                placeholder="300 123 4567"
                inputMode="tel"
                required
                aria-invalid={errorField === "phone" ? "true" : undefined}
                aria-describedby={
                  errorField === "phone" ? "checkout-error" : undefined
                }
              />
            </label>

            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-zinc-400">
                Correo (opcional)
              </span>
              <input
                ref={(el) => {
                  fieldRefs.current.email = el;
                }}
                className="field"
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  clearErrorOn("email");
                }}
                maxLength={200}
                autoComplete="email"
                inputMode="email"
                aria-invalid={errorField === "email" ? "true" : undefined}
                aria-describedby={
                  errorField === "email" ? "checkout-error" : undefined
                }
              />
            </label>

            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-zinc-400">
                Código de descuento (opcional)
              </span>
              <div className="flex gap-2">
                <input
                  className="field uppercase tracking-wider"
                  value={coupon}
                  onChange={(e) => {
                    setCoupon(e.target.value.toUpperCase());
                    setQuote(null);
                  }}
                  maxLength={40}
                  placeholder="TEMPRANO20"
                  autoComplete="off"
                  aria-label="Código de descuento"
                />
                <button
                  type="button"
                  onClick={applyCoupon}
                  disabled={quoting || coupon.trim().length < 2 || !typeId}
                  className="btn-ghost shrink-0 !px-3 !py-1.5 text-2xs font-bold"
                >
                  {quoting ? "…" : "Aplicar"}
                </button>
              </div>
              {quote?.valid && (
                <span className="mt-1 block text-2xs font-semibold text-emerald-300">
                  Cupón {quote.code} aplicado: −{money(quote.discount_in_cents)}
                </span>
              )}
            </label>

            <p className="text-2xs text-zinc-500">
              Usamos tu WhatsApp para entregarte la boleta. El correo es
              opcional.
            </p>

            {error && (
              <p
                id="checkout-error"
                className="text-xs text-rose-300"
                role="alert"
              >
                {error}
              </p>
            )}

            <button
              type="submit"
              className="btn-primary w-full"
              disabled={!selected || busy || selected.sold_out}
            >
              {busy
                ? "Abriendo pago…"
                : selected
                  ? `Pagar ${money(
                      quote?.valid
                        ? quote.final_in_cents
                        : selected.price_cents,
                    )}`
                  : "Comprar"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
