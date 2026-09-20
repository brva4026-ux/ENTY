import { useState } from "react";
import { apiFetch } from "../lib/api";
import { useUI } from "../lib/ui";
import { eventDate } from "../lib/format";
import Icon from "./Icon";

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

const STEPS = [
  { id: "basico", label: "El evento" },
  { id: "cuando", label: "Cuándo y puerta" },
  { id: "aforo", label: "Aforo" },
];

/** Chip de opción rápida (atajos de fecha, QR, aforo). */
function Chip({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
        active
          ? "border-brand-500 bg-brand-500/15 text-brand-300"
          : "border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
      }`}
    >
      {children}
    </button>
  );
}

/** Microcopy explicativa de un campo: el "para qué" de cada cosa. */
function Hint({ children, tone = "zinc" }) {
  return (
    <span
      className={`mt-1 block text-[11px] leading-snug ${
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
  const ui = useUI();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState(defaultEventForm);
  const [formError, setFormError] = useState("");
  const [creating, setCreating] = useState(false);
  // URL de flyer que ya falló al cargar: evita pintar el ícono de imagen rota.
  const [badFlyer, setBadFlyer] = useState("");

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const showFlyer = form.flyer_url && form.flyer_url !== badFlyer;

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
      // La venue acaba de dejar de ser nueva: el checklist se despide solo.
      localStorage.setItem("tf_onboarding_done", "1");
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
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog-panel my-auto w-full max-w-2xl rounded-2xl border border-zinc-800 bg-zinc-900 p-5 shadow-2xl shadow-black/60">
        {/* ====== Cabecera + pasos ====== */}
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h3 className="display text-lg">Nuevo evento</h3>
            <p className="mt-0.5 text-xs text-zinc-500">
              Nace en borrador: lo montas (tipos y cupos) antes de publicarlo.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-xs font-semibold text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-200"
          >
            Cerrar ✕
          </button>
        </div>

        <ol className="mb-5 flex items-center gap-1.5" aria-label="Pasos">
          {STEPS.map((s, i) => (
            <li key={s.id} className="flex flex-1 items-center gap-1.5">
              <span
                aria-current={i === step ? "step" : undefined}
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold transition ${
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
                className={`hidden text-[11px] font-semibold sm:block ${
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

        <form onSubmit={createEvent}>
          {/* ====== Paso 1: qué es y dónde ====== */}
          {step === 0 && (
            <div key="s0" className="animate-rise grid gap-3.5 sm:grid-cols-2">
              <label className="sm:col-span-full">
                <span className="mb-1 block text-xs font-medium text-zinc-400">
                  Nombre del evento *
                </span>
                <input
                  value={form.name}
                  onChange={(e) => set({ name: e.target.value })}
                  placeholder="Noche Electrónica"
                  className="field"
                  maxLength={200}
                  autoFocus
                />
                <Hint>
                  Es lo primero que ven el promotor y la puerta. Sin tildes
                  problemáticas: aparecerá tal cual en la boleta.
                </Hint>
              </label>

              <label className="sm:col-span-full">
                <span className="mb-1 block text-xs font-medium text-zinc-400">
                  Lugar del evento
                </span>
                <input
                  value={form.location}
                  onChange={(e) => set({ location: e.target.value })}
                  className="field"
                  placeholder="Calle 45 #12-30, Medellín"
                  maxLength={200}
                />
                <Hint>
                  La dirección que leerá el invitado en su boleta y el mensaje
                  de WhatsApp. Déjalo vacío solo si es siempre la misma del bar.
                </Hint>
              </label>

              <label className="sm:col-span-full">
                <span className="mb-1 block text-xs font-medium text-zinc-400">
                  Flyer (enlace de la imagen)
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
                  <input
                    type="url"
                    value={form.flyer_url}
                    onChange={(e) => set({ flyer_url: e.target.value })}
                    className="field"
                    placeholder="https://…/flyer.jpg"
                  />
                </div>
                <Hint>
                  Es "la imagen del evento" (opcional). Si no tienes el enlace a
                  mano, déjalo vacío: puedes agregarlo luego con Editar.
                </Hint>
              </label>

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
                  placeholder="DJ set + open bar cortesías"
                />
              </label>
            </div>
          )}

          {/* ====== Paso 2: cuándo y puerta ====== */}
          {step === 1 && (
            <div key="s1" className="animate-rise grid gap-3.5 sm:grid-cols-2">
              <label className="sm:col-span-full">
                <span className="mb-1 block text-xs font-medium text-zinc-400">
                  Apertura de puertas *
                </span>
                <input
                  type="datetime-local"
                  value={form.starts_at}
                  onChange={(e) => set({ starts_at: e.target.value })}
                  className="field"
                  required
                />
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  <Chip
                    active={form.starts_at === nextWeekday(5, 20)}
                    onClick={() => set({ starts_at: nextWeekday(5, 20) })}
                  >
                    Viernes 8 p. m.
                  </Chip>
                  <Chip
                    active={form.starts_at === nextWeekday(6, 21)}
                    onClick={() => set({ starts_at: nextWeekday(6, 21) })}
                  >
                    Sábado 9 p. m.
                  </Chip>
                  <Chip
                    active={
                      form.starts_at ===
                        toLocalInput(
                          new Date(Date.now() + 7 * 86400000), // +7 días
                        ) && new Date(form.starts_at).getHours() === 20
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
                    En una semana
                  </Chip>
                </div>
              </label>

              <label>
                <span className="mb-1 block text-xs font-medium text-zinc-400">
                  Cierre (opcional)
                </span>
                <input
                  type="datetime-local"
                  value={form.ends_at}
                  onChange={(e) => set({ ends_at: e.target.value })}
                  className="field"
                />
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {form.starts_at && (
                    <Chip
                      active={
                        !!form.ends_at &&
                        Math.round(
                          (new Date(form.ends_at) - new Date(form.starts_at)) /
                            3600000,
                        ) === 6
                      }
                      onClick={() =>
                        set({
                          ends_at: toLocalInput(
                            new Date(
                              new Date(form.starts_at).getTime() + 6 * 3600000,
                            ),
                          ),
                        })
                      }
                    >
                      Apertura + 6 h
                    </Chip>
                  )}
                  {form.ends_at && (
                    <Chip active={false} onClick={() => set({ ends_at: "" })}>
                      Quitar cierre
                    </Chip>
                  )}
                </div>
                <Hint>
                  Si lo dejas vacío el evento no se cierra solo: lo cierras tú
                  desde el backstage cuando acaba la noche.
                </Hint>
              </label>

              <label>
                <span className="mb-1 block text-xs font-medium text-zinc-400">
                  El QR del invitado se activa *
                </span>
                <input
                  type="number"
                  value={form.qr_unlock_minutes}
                  onChange={(e) => set({ qr_unlock_minutes: e.target.value })}
                  className="field"
                  min="0"
                  required
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
                <Hint tone="amber">
                  Anti reenvío: el invitado solo ve su QR dentro de esta
                  ventana, así que el enlace no circula por WhatsApp días antes.
                  1 hora es el estándar del rubro.
                </Hint>
              </label>

              <p className="sm:col-span-full text-[11px] text-zinc-600">
                La hora se guarda en tu zona (
                {Intl.DateTimeFormat().resolvedOptions().timeZone}).
              </p>
            </div>
          )}

          {/* ====== Paso 3: aforo + revisión ====== */}
          {step === 2 && (
            <div key="s2" className="animate-rise space-y-4">
              <label>
                <span className="mb-1 block text-xs font-medium text-zinc-400">
                  Aforo total (personas) *
                </span>
                <input
                  type="number"
                  value={form.capacity}
                  onChange={(e) => set({ capacity: e.target.value })}
                  className="field"
                  placeholder="100"
                  min="1"
                  required
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
                <Hint>
                  Es el cupo FÍSICO del local (el que dice seguridad/bomberos),
                  no lo que esperas vender: las boletas emitidas nunca pueden
                  pasarse de aquí.
                </Hint>
                {Number(form.capacity) > 500 && (
                  <Hint tone="amber">
                    Aforo alto: confirma que el local realmente tenga esa
                    capacidad antes de publicar.
                  </Hint>
                )}
              </label>

              {/* Vista previa: cómo se verá el evento en la lista y la boleta */}
              <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
                <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-zinc-500">
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
                    <p className="truncate text-sm font-bold text-white">
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
          <div className="mt-4 flex items-center justify-between gap-3">
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
              {step < STEPS.length - 1 ? (
                <button type="button" onClick={next} className="btn-primary">
                  Continuar
                </button>
              ) : (
                <button className="btn-primary" disabled={creating}>
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
