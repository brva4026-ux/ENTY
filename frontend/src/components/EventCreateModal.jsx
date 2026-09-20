import { useState } from "react";
import { apiFetch } from "../lib/api";
import { useUI } from "../lib/ui";

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

/**
 * Modal de creación de evento.
 *
 * Antes este formulario vivía SIEMPRE abierto en /admin: con un evento en
 * manejo era media pantalla de ruido entre la franja y el backstage. Ahora es
 * una acción ("＋ Nuevo evento") y al crear, el evento abre su backstage
 * (flyToEvent lo hace el llamador con onCreated).
 */
export default function EventCreateModal({ venueId, onClose, onCreated }) {
  const ui = useUI();
  const [form, setForm] = useState(defaultEventForm);
  const [formError, setFormError] = useState("");
  const [creating, setCreating] = useState(false);
  // URL de flyer que ya falló al cargar: evita pintar el ícono de imagen rota.
  const [badFlyer, setBadFlyer] = useState("");

  async function createEvent(e) {
    e.preventDefault();
    setFormError("");

    const startsAt = new Date(form.starts_at);
    if (Number.isNaN(startsAt.getTime())) {
      setFormError("Elige una fecha y hora de apertura validas.");
      return;
    }
    const endsAt = form.ends_at ? new Date(form.ends_at) : null;
    if (endsAt && Number.isNaN(endsAt.getTime())) {
      setFormError("La fecha de cierre no es valida.");
      return;
    }
    if (endsAt && endsAt <= startsAt) {
      setFormError("El cierre debe ser posterior a la apertura.");
      return;
    }

    setCreating(true);
    try {
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

        <form onSubmit={createEvent}>
          <div className="grid gap-3.5 sm:grid-cols-2">
            <label className="sm:col-span-full">
              <span className="mb-1 block text-xs font-medium text-zinc-400">
                Nombre del evento *
              </span>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Noche Electrónica"
                className="field"
                maxLength={200}
                required
              />
            </label>

            <label>
              <span className="mb-1 block text-xs font-medium text-zinc-400">
                Apertura de puertas *
              </span>
              <input
                type="datetime-local"
                value={form.starts_at}
                onChange={(e) =>
                  setForm({ ...form, starts_at: e.target.value })
                }
                className="field"
                required
              />
            </label>

            <label>
              <span className="mb-1 block text-xs font-medium text-zinc-400">
                Aforo (personas) *
              </span>
              <input
                type="number"
                value={form.capacity}
                onChange={(e) => setForm({ ...form, capacity: e.target.value })}
                className="field"
                placeholder="100"
                min="1"
                required
              />
            </label>

            <label>
              <span className="mb-1 block text-xs font-medium text-zinc-400">
                El QR se activa (min antes)
              </span>
              <input
                type="number"
                value={form.qr_unlock_minutes}
                onChange={(e) =>
                  setForm({ ...form, qr_unlock_minutes: e.target.value })
                }
                className="field"
                placeholder="60"
                min="0"
                required
              />
              <span className="mt-1 block text-[11px] text-zinc-500">
                Anti reenvío: el invitado ve su QR solo dentro de esta ventana
                (60 = estándar; 0 = al abrir puertas).
              </span>
            </label>

            <label>
              <span className="mb-1 block text-xs font-medium text-zinc-400">
                Cierre (opcional)
              </span>
              <input
                type="datetime-local"
                value={form.ends_at}
                onChange={(e) => setForm({ ...form, ends_at: e.target.value })}
                className="field"
              />
            </label>

            <label>
              <span className="mb-1 block text-xs font-medium text-zinc-400">
                Flyer (URL de la imagen)
              </span>
              <input
                type="url"
                value={form.flyer_url}
                onChange={(e) =>
                  setForm({ ...form, flyer_url: e.target.value })
                }
                className="field"
                placeholder="https://…/flyer.jpg"
              />
            </label>

            <label className="sm:col-span-full">
              <span className="mb-1 block text-xs font-medium text-zinc-400">
                Lugar del evento
              </span>
              <input
                value={form.location}
                onChange={(e) => setForm({ ...form, location: e.target.value })}
                className="field"
                placeholder="Calle 45 #12-30, Medellín"
                maxLength={200}
              />
              <span className="mt-1 block text-[11px] text-zinc-500">
                Aparece en la boleta del invitado y en la vista previa de
                WhatsApp.
              </span>
            </label>

            <label className="sm:col-span-full">
              <span className="mb-1 block text-xs font-medium text-zinc-400">
                Descripción (opcional)
              </span>
              <textarea
                value={form.description}
                onChange={(e) =>
                  setForm({ ...form, description: e.target.value })
                }
                className="field"
                rows={2}
                maxLength={2000}
                placeholder="DJ set + open bar cortesías"
              />
            </label>
          </div>

          {formError && (
            <p className="mt-3 text-xs text-red-400">{formError}</p>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button className="btn-primary" disabled={creating}>
              {creating ? "Creando…" : "Crear evento"}
            </button>
            {form.flyer_url && form.flyer_url !== badFlyer && (
              <img
                src={form.flyer_url}
                alt="Previsualización del flyer"
                onError={() => setBadFlyer(form.flyer_url)}
                className="h-12 w-12 rounded-lg object-cover ring-1 ring-zinc-700"
              />
            )}
            <span className="text-xs text-zinc-500">
              La hora se guarda en tu zona (
              {Intl.DateTimeFormat().resolvedOptions().timeZone}).
            </span>
          </div>
        </form>
      </div>
    </div>
  );
}
