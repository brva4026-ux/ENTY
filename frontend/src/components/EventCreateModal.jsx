import { useEffect, useId, useRef, useState } from "react";
import { apiFetch } from "../lib/api";
import { useUI } from "../lib/ui";
import { eventDate } from "../lib/format";
import Icon from "./Icon";
import { useDialogA11y } from "../lib/useDialogA11y";

/** Date -> valor para <input type="datetime-local"> (hora LOCAL, sin zona). */
function pad2(n) {
  return String(n).padStart(2, "0");
}

function toLocalInput(date) {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    `T${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  );
}

/** Siguiente dia de semana (0=dom) a cierta hora: "proximo viernes 8pm". */
function nextWeekday(weekday, hour) {
  const d = new Date();
  d.setSeconds(0, 0);
  const delta = (weekday - d.getDay() + 7) % 7 || 7;
  d.setDate(d.getDate() + delta);
  d.setHours(hour, 0, 0, 0);
  return toLocalInput(d);
}

/** Evento nuevo por defecto: dentro de una semana a las 8 p.m. */
export function defaultEventForm() {
  const start = new Date(Date.now() + 7 * 86400000);
  start.setHours(20, 0, 0, 0);
  return {
    name: "",
    capacity: 100,
    // Ventana de activación del QR del invitado (patrón DICE): 60 min
    // antes de la apertura el QR "existe". 0 = solo con la apertura.
    qr_unlock_minutes: 60,
    starts_at: toLocalInput(start),
    ends_at: "",
    flyer_url: "",
    location: "",
    description: "",
  };
}

/** Ideas de descripción: un toque llena algo decente, editable después. */
const DESCRIPTION_IDEAS = [
  ["🎵 DJ set toda la noche", "DJ set toda la noche."],
  ["🍹 Open bar 2 h", "Open bar las primeras 2 horas."],
  ["🎉 Bienvenida con shots", "Bienvenida con shots para los primeros grupos."],
  ["💃 Zona VIP con mesa", "Zona VIP con mesa y botella incluida."],
];

/**
 * Reduce la imagen elegida en un canvas (máx 900px, JPEG 0.82) y devuelve
 * un data-URL listo para POST /media. Sin librerías: canvas nativo.
 */
function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("No se pudo leer el archivo."));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () =>
        reject(new Error("El archivo no es una imagen válida."));
      img.onload = () => {
        const maxSide = 900;
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas
          .getContext("2d")
          .drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.82));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

const STEPS = [
  { id: "basico", label: "El evento" },
  { id: "cuando", label: "Cuándo y puerta" },
  { id: "aforo", label: "Aforo" },
];

/** Chip de opción rápida (atajos de fecha, QR, aforo): pill seleccionable
 * del sistema (.opt-chip), con hundimiento fisico y estado activo de marca. */
function Chip({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="opt-chip"
    >
      {children}
    </button>
  );
}

/** Microcopy explicativa de un campo: el "para qué" de cada cosa.
 *
 * Se renderiza FUERA del <label> y el campo la referencia con
 * aria-describedby: dentro del label, todo su texto se concatena al nombre
 * accesible ("Nombre del evento * Es lo primero que ven el promotor…"), que
 * es lo que anuncia el lector al enfocar. Como descripción se lee aparte y se
 * puede repetir con el atajo del lector. */
function Hint({ id, children, tone = "zinc" }) {
  return (
    <span
      id={id}
      className={`mt-1 block text-2xs leading-snug ${
        tone === "amber" ? "text-amber-300/80" : "text-zinc-500"
      }`}
    >
      {children}
    </span>
  );
}

/**
 * Modal de creación de evento — asistente de 3 pasos.
 *
 * Un formulario plano de 10 campos pedía adivinar: ¿qué es el aforo?, ¿el QR
 * para qué?, ¿el cierre obligatorio? Cada paso ahora agrupa una decisión con
 * su explicación, atajos de un toque (viernes 8 p. m., aforo 100, QR 1 h) y
 * una vista previa final de cómo quedará el evento. El API y el payload no
 * cambiaron: esto es puramente la experiencia de llenarlo.
 */
export default function EventCreateModal({ venueId, onClose, onCreated }) {
  const { dialogRef, titleId } = useDialogA11y({ onClose });
  const ui = useUI();
  // El input de archivo vive oculto: quien lo abre es el botón, que sí entra
  // en el orden de tabulación (un `label` con un input display:none no).
  const flyerInputRef = useRef(null);
  // Contenedor del paso montado, para llevar ahí el foco al cambiar de paso.
  const stepRef = useRef(null);
  const stepMounted = useRef(false);
  // Ids de campo/texto de ayuda: unicos por instancia, para que
  // aria-describedby no apunte al Hint de otro montaje del modal.
  const uid = useId();
  const fid = (key) => `${uid}-${key}`;
  const [step, setStep] = useState(0);
  const [form, setForm] = useState(defaultEventForm);
  const [formError, setFormError] = useState("");
  const [creating, setCreating] = useState(false);
  // URL de flyer que ya falló al cargar: evita pintar el ícono de imagen rota.
  const [badFlyer, setBadFlyer] = useState("");
  // Subida de flyer: estado del archivo en vuelo.
  const [uploading, setUploading] = useState(false);
  // "Otra fecha": el calendario nativo solo aparece cuando se pide.
  const [customDate, setCustomDate] = useState(false);
  // Modo del flyer: "subir" (archivo) o "enlace" (URL). Empieza oculto:
  // el flyer es opcional y no debe ocupar la pantalla si no se quiere.
  const [flyerMode, setFlyerMode] = useState(null);

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  // Al cambiar de paso, el contenido anterior se desmonta. Si el foco estaba
  // en "Continuar" (o el paso se movió solo porque falló la validación final)
  // el usuario de teclado aterriza en el body y pierde el hilo. Se lleva al
  // primer control del paso nuevo; el primer render no cuenta, ahí manda el
  // foco inicial del diálogo.
  useEffect(() => {
    if (!stepMounted.current) {
      stepMounted.current = true;
      return;
    }
    const first = stepRef.current?.querySelector(
      "input:not([type='file']), textarea, select, button",
    );
    (first ?? stepRef.current)?.focus?.();
  }, [step]);
  const showFlyer = form.flyer_url && form.flyer_url !== badFlyer;

  /** Sube el archivo reducido y guarda su URL /media/{id} en el form. */
  async function uploadFlyer(file) {
    if (!file) return;
    setFormError("");
    setUploading(true);
    try {
      const dataUrl = await fileToDataUrl(file);
      const res = await apiFetch(`/venues/${venueId}/media`, {
        method: "POST",
        body: JSON.stringify({ data_url: dataUrl }),
      });
      set({ flyer_url: res.url });
      setBadFlyer("");
      ui.success("Flyer listo 📸");
    } catch (err) {
      setFormError(err.message);
    } finally {
      setUploading(false);
    }
  }

  /** Valida un paso; devuelve "" si está listo para avanzar. */
  function validate(s) {
    if (s === 0) {
      if (form.name.trim().length < 3) {
        return "Ponle un nombre al evento (mínimo 3 letras).";
      }
    }
    if (s === 1) {
      const start = new Date(form.starts_at);
      if (Number.isNaN(start.getTime())) {
        return "Elige una fecha y hora de apertura válidas.";
      }
      if (start.getTime() < Date.now() - 60000) {
        return "La apertura no puede ser en el pasado: elige otro día.";
      }
      const end = form.ends_at ? new Date(form.ends_at) : null;
      if (end && Number.isNaN(end.getTime())) {
        return "La fecha de cierre no es válida.";
      }
      if (end && end <= start) {
        return "El cierre debe ser posterior a la apertura.";
      }
      const qr = Number(form.qr_unlock_minutes);
      if (!Number.isInteger(qr) || qr < 0) {
        return "La ventana del QR debe ser 0 o más minutos.";
      }
    }
    if (s === 2) {
      const cap = Number(form.capacity);
      if (!Number.isInteger(cap) || cap < 1) {
        return "El aforo debe ser un número de 1 en adelante.";
      }
    }
    return "";
  }

  function next() {
    const err = validate(step);
    if (err) {
      setFormError(err);
      return;
    }
    setFormError("");
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  }

  function back() {
    setFormError("");
    setStep((s) => Math.max(s - 1, 0));
  }

  async function createEvent(e) {
    e.preventDefault();
    // Revalida todo el recorrido: nada se crea con un paso a medias.
    for (let s = 0; s < STEPS.length; s++) {
      const err = validate(s);
      if (err) {
        setFormError(err);
        setStep(s);
        return;
      }
    }

    setCreating(true);
    try {
      const startsAt = new Date(form.starts_at);
      const endsAt = form.ends_at ? new Date(form.ends_at) : null;
      const ev = await apiFetch(`/venues/${venueId}/events`, {
        method: "POST",
        body: JSON.stringify({
          name: form.name.trim(),
          capacity: Number(form.capacity),
          qr_unlock_minutes: Number(form.qr_unlock_minutes),
          // datetime-local viene SIN zona horaria: new Date(...) lo interpreta
          // como hora local del navegador y toISOString() lo lleva al instante
          // UTC correcto. Mandarlo crudo lo guardaría como si fuera UTC.
          starts_at: startsAt.toISOString(),
          ends_at: endsAt ? endsAt.toISOString() : null,
          description: form.description.trim() || null,
          flyer_url: form.flyer_url.trim() || null,
          location: form.location.trim() || null,
          // La zona del evento es la del admin que lo crea: así la hora que
          // escribió es la que queda impresa en la boleta del cliente.
          event_timezone:
            Intl.DateTimeFormat().resolvedOptions().timeZone ||
            "America/Bogota",
        }),
      });
      // Crear el evento AVANZA el paso 1 del checklist, no lo mata: la guia
      // la apaga el admin (o la completa). Antes esta linea escribia
      // `tf_onboarding_done` y la guia desaparecia aqui, con 3 pasos por
      // delante (tipos, cupos, publicar).
      onCreated(ev);
      ui.success("Evento creado: añade tipos y cupos 🎟️");
    } catch (err) {
      setFormError(err.message);
    } finally {
      setCreating(false);
    }
  }

  const qr = Number(form.qr_unlock_minutes) || 0;
  const qrLabel =
    qr === 0 ? "solo al abrir puertas" : `${qr} min antes de la apertura`;

  return (
    <div
      className="dialog-backdrop fixed inset-0 z-[80] flex items-end justify-center overflow-y-auto p-4 sm:items-center"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* El role vive en el panel, no en el backdrop: así el elemento que el
          lector anuncia como diálogo es el mismo que atrapa el foco. */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="dialog-panel my-auto max-w-2xl"
      >
        <span className="dialog-grab" aria-hidden="true" />

        {/* ====== Cabecera + pasos ====== */}
        <div className="dialog-head">
          <div className="min-w-0">
            <h3 id={titleId} className="dialog-title">Nuevo evento</h3>
            <p className="dialog-sub">
              Nace en borrador: lo montas (tipos y cupos) antes de publicarlo.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="dialog-close"
            aria-label="Cerrar"
          >
            ✕
          </button>
        </div>

        <ol
          className="mb-1 flex items-center gap-1.5 px-5 pt-4"
          aria-label="Pasos"
        >
          {STEPS.map((s, i) => (
            <li key={s.id} className="flex flex-1 items-center gap-1.5">
              <span
                aria-current={i === step ? "step" : undefined}
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-2xs font-bold transition ${
                  i < step
                    ? "bg-brand-500/20 text-brand-300"
                    : i === step
                      ? "bg-brand-500 text-white"
                      : "bg-zinc-800 text-zinc-500"
                }`}
              >
                {i < step ? (
                  <Icon name="check" className="h-3.5 w-3.5" />
                ) : (
                  i + 1
                )}
              </span>
              <span
                className={`hidden text-2xs font-semibold sm:block ${
                  i === step ? "text-zinc-100" : "text-zinc-500"
                }`}
              >
                {s.label}
              </span>
              {i < STEPS.length - 1 && (
                <span
                  className={`h-px flex-1 ${
                    i < step ? "bg-brand-500/60" : "bg-zinc-800"
                  }`}
                  aria-hidden
                />
              )}
            </li>
          ))}
        </ol>

        <form onSubmit={createEvent} className="dialog-body">
          {/* ====== Paso 1: qué es y dónde ====== */}
          {step === 0 && (
            <div
              key="s0"
              ref={stepRef}
              tabIndex={-1}
              className="animate-rise grid gap-3.5 focus:outline-none sm:grid-cols-2"
            >
              <div className="sm:col-span-full">
                <label
                  htmlFor={fid("name")}
                  className="mb-1 block text-xs font-medium text-zinc-400"
                >
                  Nombre del evento *
                </label>
                <input
                  id={fid("name")}
                  value={form.name}
                  onChange={(e) => set({ name: e.target.value })}
                  placeholder="Noche Electrónica"
                  className="field"
                  maxLength={200}
                  data-dialog-autofocus
                  aria-required="true"
                  aria-describedby={fid("name-hint")}
                />
                <Hint id={fid("name-hint")}>
                  Es lo primero que ven el promotor y la puerta. Sin tildes
                  problemáticas: aparecerá tal cual en la boleta.
                </Hint>
              </div>
              <div className="sm:col-span-full">
                <label
                  htmlFor={fid("location")}
                  className="mb-1 block text-xs font-medium text-zinc-400"
                >
                  Lugar del evento
                </label>
                <input
                  id={fid("location")}
                  value={form.location}
                  onChange={(e) => set({ location: e.target.value })}
                  className="field"
                  placeholder="Calle 45 #12-30, Medellín"
                  maxLength={200}
                  aria-describedby={fid("location-hint")}
                />
                <Hint id={fid("location-hint")}>
                  La dirección que leerá el invitado en su boleta y el mensaje
                  de WhatsApp. Déjalo vacío solo si es siempre la misma del bar.
                </Hint>
              </div>{" "}
              <div className="sm:col-span-full">
                <span className="mb-1 block text-xs font-medium text-zinc-400">
                  Flyer del evento (opcional)
                </span>
                <div className="flex items-center gap-3">
                  {showFlyer ? (
                    <img
                      src={form.flyer_url}
                      alt="Previsualización del flyer"
                      onError={() => setBadFlyer(form.flyer_url)}
                      className="h-14 w-14 shrink-0 rounded-xl object-cover ring-1 ring-zinc-700"
                    />
                  ) : (
                    <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-zinc-800 text-zinc-600">
                      <Icon name="camera" className="h-5 w-5" />
                    </span>
                  )}
                  {flyerMode === null && !showFlyer && (
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => flyerInputRef.current?.click()}
                        disabled={uploading}
                        className="btn-ghost !px-3 !py-1.5 text-2xs font-bold"
                      >
                        {uploading ? "Subiendo…" : "📷 Subir imagen"}
                      </button>
                      {/* Oculto pero enfocable por script; se limpia para
                          poder elegir la misma foto dos veces seguidas. */}
                      <input
                        ref={flyerInputRef}
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        className="hidden"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          e.target.value = "";
                          uploadFlyer(file);
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => setFlyerMode("enlace")}
                        className="btn-ghost !px-3 !py-1.5 text-2xs font-bold"
                      >
                        🔗 Pegar enlace
                      </button>
                    </div>
                  )}
                  {flyerMode === "enlace" && (
                    <input
                      aria-label="Enlace del flyer"
                      type="url"
                      value={form.flyer_url}
                      onChange={(e) => set({ flyer_url: e.target.value })}
                      className="field"
                      placeholder="https://…/flyer.jpg"
                    />
                  )}
                  {showFlyer && (
                    <button
                      type="button"
                      onClick={() => {
                        set({ flyer_url: "" });
                        setFlyerMode(null);
                      }}
                      className="text-2xs font-semibold text-zinc-500 transition hover:text-red-400"
                    >
                      Quitar
                    </button>
                  )}
                </div>
                <Hint>
                  Sube la foto del flyer desde tu celular o pega un enlace. Si
                  no tienes, déjalo vacío: puedes agregarlo después con Editar.
                </Hint>
              </div>
              <label className="sm:col-span-full">
                <span className="mb-1 block text-xs font-medium text-zinc-400">
                  Descripción (opcional)
                </span>
                <textarea
                  value={form.description}
                  onChange={(e) => set({ description: e.target.value })}
                  className="field"
                  rows={2}
                  maxLength={2000}
                  placeholder="¿Qué hay esta noche? Toca una idea y edítala…"
                />
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {DESCRIPTION_IDEAS.map(([chip, text]) => (
                    <Chip
                      key={chip}
                      active={form.description.includes(text)}
                      onClick={() =>
                        set({
                          description: form.description.trim()
                            ? `${form.description.trim()} ${text}`
                            : text,
                        })
                      }
                    >
                      {chip}
                    </Chip>
                  ))}
                </div>
              </label>
            </div>
          )}

          {/* ====== Paso 2: cuándo y puerta ====== */}
          {step === 1 && (
            <div
              key="s1"
              ref={stepRef}
              tabIndex={-1}
              className="animate-rise grid gap-3.5 focus:outline-none sm:grid-cols-2"
            >
              <div className="sm:col-span-full">
                <span className="mb-1 block text-xs font-medium text-zinc-400">
                  ¿Cuándo abre? *
                </span>
                {/* Atajos primero: un toque y listo. El calendario nativo es
                  la vía de escape para la fecha rara, no la puerta de entrada. */}
                <div className="flex flex-wrap gap-1.5">
                  <Chip
                    active={form.starts_at === nextWeekday(5, 20)}
                    onClick={() => set({ starts_at: nextWeekday(5, 20) })}
                  >
                    🗓 Viernes 8 p. m.
                  </Chip>
                  <Chip
                    active={form.starts_at === nextWeekday(6, 21)}
                    onClick={() => set({ starts_at: nextWeekday(6, 21) })}
                  >
                    🗓 Sábado 9 p. m.
                  </Chip>
                  <Chip
                    active={
                      form.starts_at ===
                      toLocalInput(
                        (() => {
                          const d = new Date();
                          d.setDate(d.getDate() + 1);
                          d.setHours(21, 0, 0, 0);
                          return d;
                        })(),
                      )
                    }
                    onClick={() =>
                      set({
                        starts_at: toLocalInput(
                          (() => {
                            const d = new Date();
                            d.setDate(d.getDate() + 1);
                            d.setHours(21, 0, 0, 0);
                            return d;
                          })(),
                        ),
                      })
                    }
                  >
                    🗓 Mañana 9 p. m.
                  </Chip>
                  <Chip
                    active={
                      form.starts_at ===
                      toLocalInput(
                        (() => {
                          const d = new Date(Date.now() + 7 * 86400000);
                          d.setHours(20, 0, 0, 0);
                          return d;
                        })(),
                      )
                    }
                    onClick={() =>
                      set({
                        starts_at: toLocalInput(
                          (() => {
                            const d = new Date(Date.now() + 7 * 86400000);
                            d.setHours(20, 0, 0, 0);
                            return d;
                          })(),
                        ),
                      })
                    }
                  >
                    🗓 En una semana
                  </Chip>
                </div>
                {customDate ? (
                  <input
                    aria-label="Fecha y hora de inicio"
                    type="datetime-local"
                    value={form.starts_at}
                    onChange={(e) => set({ starts_at: e.target.value })}
                    className="field mt-2"
                    required
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => setCustomDate(true)}
                    className="mt-2 text-2xs font-semibold text-zinc-500 underline-offset-2 transition hover:text-zinc-300 hover:underline"
                  >
                    Otra fecha u hora…
                  </button>
                )}
                <Hint>Día y hora en que abren las puertas del local.</Hint>
              </div>

              <div className="sm:col-span-full">
                <span className="mb-1 block text-xs font-medium text-zinc-400">
                  ¿Cuánto dura la fiesta? (opcional)
                </span>
                {/* Duración, no fecha-absoluta: nadie piensa "cierra 3:00 a.m.
                  mientras crea el evento"; piensa "dura 6 horas". */}
                <div className="flex flex-wrap gap-1.5">
                  {form.starts_at &&
                    [4, 5, 6, 7, 8].map((h) => {
                      const isThis =
                        !!form.ends_at &&
                        Math.abs(
                          new Date(form.ends_at) - new Date(form.starts_at),
                        ) ===
                          h * 3600000;
                      return (
                        <Chip
                          key={h}
                          active={isThis}
                          onClick={() =>
                            set({
                              ends_at: toLocalInput(
                                new Date(
                                  new Date(form.starts_at).getTime() +
                                    h * 3600000,
                                ),
                              ),
                            })
                          }
                        >
                          {h} horas
                        </Chip>
                      );
                    })}
                  {form.ends_at && (
                    <Chip active={false} onClick={() => set({ ends_at: "" })}>
                      Sin cierre
                    </Chip>
                  )}
                </div>
                <Hint>
                  Si lo dejas sin cierre, el evento sigue "en puerta" hasta que
                  tú lo cierres desde el backstage cuando acaba la noche.
                </Hint>
              </div>

              <div>
                <label
                  htmlFor={fid("qr")}
                  className="mb-1 block text-xs font-medium text-zinc-400"
                >
                  El QR del invitado se activa *
                </label>
                <input
                  id={fid("qr")}
                  type="number"
                  value={form.qr_unlock_minutes}
                  onChange={(e) => set({ qr_unlock_minutes: e.target.value })}
                  className="field"
                  min="0"
                  required
                  aria-describedby={fid("qr-hint")}
                />
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  <Chip
                    active={qr === 0}
                    onClick={() => set({ qr_unlock_minutes: 0 })}
                  >
                    Con las puertas
                  </Chip>
                  <Chip
                    active={qr === 60}
                    onClick={() => set({ qr_unlock_minutes: 60 })}
                  >
                    1 h antes ✓
                  </Chip>
                  <Chip
                    active={qr === 180}
                    onClick={() => set({ qr_unlock_minutes: 180 })}
                  >
                    3 h antes
                  </Chip>
                </div>
                <Hint id={fid("qr-hint")} tone="amber">
                  Anti reenvío: el invitado solo ve su QR dentro de esta
                  ventana, así que el enlace no circula por WhatsApp días antes.
                  1 hora es el estándar del rubro.
                </Hint>
              </div>

              <p className="sm:col-span-full text-2xs text-zinc-600">
                La hora se guarda en tu zona (
                {Intl.DateTimeFormat().resolvedOptions().timeZone}).
              </p>
            </div>
          )}

          {/* ====== Paso 3: aforo + revisión ====== */}
          {step === 2 && (
            <div
              key="s2"
              ref={stepRef}
              tabIndex={-1}
              className="animate-rise space-y-4 focus:outline-none"
            >
              <div>
                <label
                  htmlFor={fid("capacity")}
                  className="mb-1 block text-xs font-medium text-zinc-400"
                >
                  Aforo total (personas) *
                </label>
                <input
                  id={fid("capacity")}
                  type="number"
                  value={form.capacity}
                  onChange={(e) => set({ capacity: e.target.value })}
                  className="field"
                  placeholder="100"
                  min="1"
                  required
                  aria-describedby={
                    Number(form.capacity) > 500
                      ? `${fid("capacity-hint")} ${fid("capacity-high")}`
                      : fid("capacity-hint")
                  }
                />
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {[50, 100, 150, 200, 300].map((n) => (
                    <Chip
                      key={n}
                      active={Number(form.capacity) === n}
                      onClick={() => set({ capacity: n })}
                    >
                      {n}
                    </Chip>
                  ))}
                </div>
                <Hint id={fid("capacity-hint")}>
                  Es el cupo FÍSICO del local (el que dice seguridad/bomberos),
                  no lo que esperas vender: las boletas emitidas nunca pueden
                  pasarse de aquí.
                </Hint>
                {Number(form.capacity) > 500 && (
                  <Hint id={fid("capacity-high")} tone="amber">
                    Aforo alto: confirma que el local realmente tenga esa
                    capacidad antes de publicar.
                  </Hint>
                )}
              </div>

              {/* Vista previa: cómo se verá el evento en la lista y la boleta */}
              <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
                <p className="mb-2 text-2xs font-bold uppercase tracking-wide text-zinc-500">
                  Así se verá
                </p>
                <div className="flex items-start gap-3">
                  {showFlyer ? (
                    <img
                      src={form.flyer_url}
                      alt=""
                      onError={() => setBadFlyer(form.flyer_url)}
                      className="h-16 w-16 shrink-0 rounded-xl object-cover ring-1 ring-zinc-700"
                    />
                  ) : (
                    <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-xl bg-zinc-800 text-zinc-600">
                      <Icon name="door" className="h-6 w-6" />
                    </span>
                  )}
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold text-ink">
                      {form.name.trim() || "Evento sin nombre"}
                    </p>
                    <p className="mt-0.5 text-xs text-zinc-400">
                      {form.starts_at
                        ? eventDate(new Date(form.starts_at).toISOString())
                        : "—"}
                      {form.ends_at &&
                        ` → ${eventDate(new Date(form.ends_at).toISOString())}`}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-zinc-500">
                      {form.location || "Sin dirección"} · aforo{" "}
                      {form.capacity || "—"} · QR {qrLabel}
                    </p>
                    {form.description.trim() && (
                      <p className="mt-1 line-clamp-2 text-xs text-zinc-500">
                        {form.description}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {formError && (
            <p className="mt-3 text-xs text-red-400" role="alert">
              {formError}
            </p>
          )}

          {/* ====== Navegación del asistente ====== */}
          <div className="dialog-foot dialog-foot--split">
            <span className="text-xs text-zinc-600">
              Paso {step + 1} de {STEPS.length}
            </span>
            <div className="flex items-center gap-2">
              {step > 0 && (
                <button
                  type="button"
                  onClick={back}
                  className="btn-ghost text-sm font-bold"
                >
                  Atrás
                </button>
              )}
              {/* key distinta por paso: sin ella React reutiliza el mismo nodo
                  <button> y lo muta de "Continuar / type=button" a "Crear
                  evento / type=submit". El navegador resuelve la acción por
                  defecto del clic DESPUÉS de esa mutación, así que el último
                  "Continuar" enviaba el formulario y creaba el evento saltándose
                  el paso Aforo. Con keys propias React reemplaza el nodo y el
                  clic no puede heredar el type del paso siguiente. */}
              {step < STEPS.length - 1 ? (
                <button
                  key="next"
                  type="button"
                  onClick={next}
                  className="btn-primary"
                >
                  Continuar
                </button>
              ) : (
                <button key="submit" className="btn-primary" disabled={creating}>
                  {creating && (
                    <svg
                      className="btn-spinner"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <circle cx="12" cy="12" r="9" />
                    </svg>
                  )}
                  {creating ? "Creando…" : "Crear evento"}
                </button>
              )}
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
