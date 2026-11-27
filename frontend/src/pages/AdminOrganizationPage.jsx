import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { activeVenueId } from "../lib/venue";
import { apiFetch } from "../lib/api";
import { useUI } from "../lib/ui";
import useDocumentTitle from "../lib/useDocumentTitle";
import TeamManager from "../components/TeamManager";
import InvitationsManager from "../components/InvitationsManager";
import VenueImportPanel from "../components/VenueImportPanel";
import VenueExitPanel from "../components/VenueExitPanel";
import PayoutProfilePanel from "../components/PayoutProfilePanel";
import { PushToggle } from "../components/PushToggle";
import { LegalLinks } from "../components/LegalLinks";
import TransitionLink from "../components/TransitionLink";
import SectionDisclosure from "../components/SectionDisclosure";

const PRIMARY_TABS = [
  { id: "equipo", label: "Equipo" },
  { id: "invitaciones", label: "Invitaciones" },
  { id: "cobros", label: "Cobros" },
  { id: "ajustes", label: "Ajustes" },
];
const MORE_TABS = [
  { id: "importar", label: "Importar datos" },
  { id: "salida", label: "Salida de la organización" },
];
const TABS = [...PRIMARY_TABS, ...MORE_TABS];

const EMPTY_FORM = {
  name: "",
  logo_url: "",
  primary_color: "",
  commission_pct: "0",
  contact_name: "",
  contact_phone: "",
};

export default function AdminOrganizationPage() {
  useDocumentTitle("Organización");
  const { user, restoreSession } = useAuth();
  const ui = useUI();
  const venueId = activeVenueId(user);
  const venue = (user?.venues || []).find((v) => v.id === venueId);
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get("tab");
  const tab = TABS.some((t) => t.id === rawTab) ? rawTab : "equipo";

  const [users, setUsers] = useState([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!venueId) return;
    let alive = true;
    apiFetch(`/venues/${venueId}/users?include_inactive=true`)
      .then((rows) => alive && setUsers(rows || []))
      .catch(() => alive && setUsers([]));
    return () => {
      alive = false;
    };
  }, [venueId]);

  useEffect(() => {
    if (!venue) return;
    setForm({
      name: venue.name || "",
      logo_url: venue.logo_url || "",
      primary_color: venue.primary_color || "",
      commission_pct: String(venue.commission_pct ?? 0),
      contact_name: venue.contact_name || "",
      contact_phone: venue.contact_phone || "",
    });
  }, [venue]);

  const dirty = useMemo(() => {
    if (!venue) return false;
    return (
      form.name.trim() !== (venue.name || "") ||
      form.logo_url.trim() !== (venue.logo_url || "") ||
      form.primary_color.trim() !== (venue.primary_color || "") ||
      form.commission_pct !== String(venue.commission_pct ?? 0) ||
      form.contact_name.trim() !== (venue.contact_name || "") ||
      form.contact_phone.trim() !== (venue.contact_phone || "")
    );
  }, [form, venue]);

  function selectTab(id) {
    const next = new URLSearchParams(searchParams);
    if (id === "equipo") next.delete("tab");
    else next.set("tab", id);
    setSearchParams(next);
  }

  async function saveVenue(e) {
    e.preventDefault();
    if (!venueId) return;
    setSaving(true);
    setError("");
    try {
      await apiFetch(`/auth/venues/${venueId}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: form.name.trim(),
          logo_url: form.logo_url.trim() || null,
          primary_color: form.primary_color.trim() || null,
          commission_pct: Number(form.commission_pct) || 0,
          contact_name: form.contact_name.trim() || null,
          contact_phone: form.contact_phone.trim() || null,
        }),
      });
      await restoreSession();
      ui.success("Datos de la organización actualizados");
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (!venueId) {
    return (
      <div className="admin-empty">
        <h2>Sin organización activa</h2>
        <p>Habla con un administrador general para que te asigne un negocio.</p>
      </div>
    );
  }

  return (
    <div className="admin-events admin-organization-page">
      <header className="admin-page-head admin-hub-head">
        <div>
          <h1>Mi organización</h1>
          <p>{venue?.name || "Gestiona tu equipo y los ajustes del negocio."}</p>
        </div>
        <div className="admin-hub-navigation">
          <div className="admin-tabs" role="tablist" aria-label="Secciones de Organización">
            {PRIMARY_TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => selectTab(t.id)}
                className="admin-tab"
              >
                {t.label}
              </button>
            ))}
          </div>
          <SectionDisclosure label="Más ajustes" sections={MORE_TABS} selected={tab} onSelect={selectTab} />
        </div>
      </header>

      {tab === "equipo" && (
        <section className="space-y-4" role="tabpanel" aria-label="Equipo">
          <TeamManager venueId={venueId} users={users} onChanged={() => restoreSession()} />
        </section>
      )}

      {tab === "invitaciones" && (
        <section role="tabpanel" aria-label="Invitaciones">
          <InvitationsManager venueId={venueId} />
        </section>
      )}

      {tab === "importar" && (
        <section role="tabpanel" aria-label="Importar">
          <VenueImportPanel venueId={venueId} />
        </section>
      )}

      {tab === "salida" && (
        <section role="tabpanel" aria-label="Salida ordenada">
          <VenueExitPanel venueId={venueId} />
        </section>
      )}

      {tab === "cobros" && (
        <section role="tabpanel" aria-label="Cobros">
          <PayoutProfilePanel venueId={venueId} />
        </section>
      )}

      {tab === "ajustes" && (
        <section className="admin-org-grid" role="tabpanel" aria-label="Ajustes">
          <form className="admin-settings-card" onSubmit={saveVenue}>
            <h2>Identidad del negocio</h2>
            <p>
              Nombre, logo y color que ven tu equipo y tus compradores. Los
              cambios se reflejan en Eventos, Reportes y la ficha pública.
            </p>
            <div className="admin-settings-grid">
              <label className="is-full">
                Nombre
                <input
                  className="field"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  required
                  maxLength={200}
                />
              </label>
              <label className="is-full">
                Logo (URL)
                <input
                  className="field"
                  type="url"
                  value={form.logo_url}
                  onChange={(e) => setForm({ ...form, logo_url: e.target.value })}
                  placeholder="https://…/logo.png"
                />
              </label>
              <label>
                Color de marca
                <input
                  className="field"
                  type="color"
                  value={form.primary_color || "#7c3aed"}
                  onChange={(e) =>
                    setForm({ ...form, primary_color: e.target.value })
                  }
                />
              </label>
              <label>
                Comisión de promotores (%)
                <input
                  className="field"
                  type="number"
                  min="0"
                  max="100"
                  step="0.01"
                  value={form.commission_pct}
                  onChange={(e) =>
                    setForm({ ...form, commission_pct: e.target.value })
                  }
                />
              </label>
              <label>
                Contacto (nombre)
                <input
                  className="field"
                  value={form.contact_name}
                  onChange={(e) =>
                    setForm({ ...form, contact_name: e.target.value })
                  }
                  maxLength={120}
                />
              </label>
              <label>
                Contacto (WhatsApp)
                <input
                  className="field"
                  type="tel"
                  value={form.contact_phone}
                  onChange={(e) =>
                    setForm({ ...form, contact_phone: e.target.value })
                  }
                  maxLength={40}
                />
              </label>
            </div>
            {error && (
              <p className="mt-3 text-xs text-red-400" role="alert">
                {error}
              </p>
            )}
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button type="submit" className="btn-primary" disabled={saving || !dirty}>
                {saving ? "Guardando…" : "Guardar organización"}
              </button>
              {!dirty && (
                <span className="admin-note">Sin cambios pendientes.</span>
              )}
            </div>
          </form>

          <div className="space-y-4">
            <div className="admin-legal-card">
              <h2>Documentos y consentimientos</h2>
              <LegalLinks />
              <TransitionLink className="admin-inline-link" to="/perfil?tab=cuenta">
                Ver cuenta y aceptaciones
              </TransitionLink>
            </div>
            <div className="admin-legal-card">
              <h2>Avisos en el dispositivo</h2>
              <PushToggle venueId={venueId} />
            </div>
            <div className="admin-legal-card">
              <h2>Accesos rápidos</h2>
              <TransitionLink className="admin-inline-link" to="/perfil?tab=negocio">
                Editar ficha del negocio
              </TransitionLink>
              <TransitionLink className="admin-inline-link" to="/perfil?tab=seguridad">
                Seguridad de la cuenta
              </TransitionLink>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
