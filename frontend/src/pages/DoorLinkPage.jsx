import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
import { haptics } from "../lib/haptics";
import { saveDoorDevice } from "../lib/doorDevice";
import { Logo } from "../components/Brand";
import Icon from "../components/Icon";
import ContactSupport from "../components/ContactSupport";
import { roleHomeFor } from "../lib/roles";

/**
 * /puerta?token=… — el link que Administración le manda a quien abre la puerta.
 *
 * La noche y el puesto ya vienen adentro. Al canjearlo, el servidor devuelve
 * la credencial de ESTE teléfono (mig 064); sin ella la puerta no registra
 * ingresos. El token del link es de un solo uso y muere al canjearse.
 */
export default function DoorLinkPage() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const location = useLocation();
  const { user, logout } = useAuth();
  const token = params.get("token") || "";
  const returnTo = `${location.pathname}${location.search}`;

  const [preview, setPreview] = useState(null);
  const [error, setError] = useState("");
  const [entrando, setEntrando] = useState(false);

  const mirar = useCallback(async () => {
    setError("");
    try {
      const data = await apiFetch(`/escaner/acceso?token=${encodeURIComponent(token)}`);
      setPreview(data);
    } catch (e) {
      setPreview(null);
      setError(e.message);
    }
  }, [token]);

  useEffect(() => {
    if (token) mirar();
    else setError("Ese link no trae ningún acceso.");
  }, [token, mirar]);

  async function entrar() {
    setEntrando(true);
    setError("");
    try {
      const r = await apiFetch(
        `/escaner/acceso?token=${encodeURIComponent(token)}`,
        { method: "POST" },
      );
      if (r.device_token) {
        saveDoorDevice(r.event_id, {
          token: r.device_token,
          device_id: r.device_id,
          door_name: r.door_name,
          ticket_type_id: r.ticket_type_id,
          phone: r.phone,
          expires_at: r.expires_at,
        });
      }
      haptics.success();
      nav(`/bouncer?evento=${r.event_id}`, { replace: true });
    } catch (e) {
      setError(e.message);
      setPreview(null);
      setEntrando(false);
    }
  }

  if (!user) {
    return (
      <main className="door2-shell door2-linkpage">
        <div className="door2-link-card">
          <Logo size="lg" />
          <p className="door2-kicker">Puerta · Enty</p>
          <h1>Inicia sesión para abrir este puesto</h1>
          <p>
            El link es personal: entra con la cuenta que Administración asignó a
            esta noche y volvé a abrirlo.
          </p>
          <button
            type="button"
            className="door2-btn door2-btn--primary door2-btn--wide"
            onClick={() =>
              nav("/login", {
                state: { from: returnTo, task: { kind: "door" } },
              })
            }
          >
            Entrar para continuar a Puerta
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="door2-shell door2-linkpage">
      <div className="door2-link-card">
        <Logo size="lg" />
        {!token || error ? (
          <>
            <p className="door2-kicker">Link de Puerta</p>
            <h1>Este link no sirve</h1>
            <p>{error}</p>
            <p className="door2-hint">
              Los links de puerta son de un solo uso y vencen. Pedile uno nuevo
              al administrador del bar.
            </p>
            <div className="door2-link-actions">
              <button
                type="button"
                onClick={() => nav(roleHomeFor("bouncer"))}
                className="door2-btn door2-btn--primary door2-btn--wide"
              >
                Ir a mi panel
              </button>
              <button
                type="button"
                onClick={async () => {
                  await logout();
                  nav("/login", {
                    state: { from: returnTo, task: { kind: "door" } },
                  });
                }}
                className="door2-btn door2-btn--soft door2-btn--wide"
              >
                Probar con otra cuenta
              </button>
              <ContactSupport
                prompt=""
                label="Pedir un link nuevo"
                message="Hola, necesito un link de puerta nuevo."
                className="justify-center"
              />
            </div>
          </>
        ) : !preview ? (
          <div className="door2-link-skeleton">
            <span className="skeleton h-5 w-40" />
            <span className="skeleton h-4 w-full" />
            <span className="skeleton h-11 w-full" />
          </div>
        ) : (
          <>
            <p className="door2-kicker">Entrás directo a esta noche</p>
            <h1>{preview.event_name}</h1>
            <p className="door2-link-date">
              <Icon name="calendar" className="h-4 w-4" />
              {new Date(preview.starts_at).toLocaleString("es-CO", {
                weekday: "long",
                day: "numeric",
                month: "long",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </p>
            <div className="door2-link-assignment">
              <div>
                <span>Persona</span>
                <strong>{preview.full_name}</strong>
              </div>
              <div>
                <span>Puesto</span>
                <strong>{preview.door_name || "Puerta"}</strong>
              </div>
              <div>
                <span>Teléfono autorizado</span>
                <strong>{preview.phone || "Este dispositivo"}</strong>
              </div>
            </div>
            <p className="door2-hint">
              Este link ata el puesto a este teléfono. Si Administración lo
              revoca o lo releva, el teléfono deja de registrar ingresos.
            </p>
            {preview.used && (
              <p className="door2-warning">
                Este link ya se usó. Si perdiste el teléfono, pedí uno nuevo.
              </p>
            )}
            <button
              type="button"
              onClick={entrar}
              disabled={entrando || preview.used}
              className="door2-btn door2-btn--primary door2-btn--wide"
            >
              {entrando ? "Abriendo…" : "Entrar a la puerta"}
            </button>
          </>
        )}
      </div>
    </main>
  );
}
