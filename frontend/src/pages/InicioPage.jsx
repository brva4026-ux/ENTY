import { useEffect, useState } from "react";
import { fetchPublicEvents } from "../lib/api";
import { money } from "../lib/format";
import { forceDarkOnce } from "../lib/theme";
import { track } from "../lib/analytics";
import TransitionLink from "../components/TransitionLink";
// Heart SVG inline (four-point star) – usamos un componente simples
function Heart({ filled }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 20s-7-4.6-7-9.5A3.9 3.9 0 0 1 12 7a3.9 3.9 0 0 1 7 3.5C19 15.4 12 20 12 20z"
        fill={filled ? "#7C3AED" : "none"}
        stroke={filled ? "#7C3AED" : "currentColor"}
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}
import { useAuth } from "../lib/auth";
import useDocumentTitle from "../lib/useDocumentTitle";
import { useLocation } from "react-router-dom";

const prefersReducedMotion = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const reducedMotionClass = prefersReducedMotion ? "motion-reduced" : "";

/** Inicio — presentación de Enty para el fan (landing page). */

function isEventAvailable(e) {
  const now = new Date();
  const starts = new Date(e.starts_at);
  if (Number.isNaN(starts.getTime())) return false;
  const isLiveOrPublished = ["live", "published"].includes(e.status || "");
  const isFutureOrToday = starts >= now;
  return isLiveOrPublished && isFutureOrToday;
}

// Favoritos en localStorage (modo privado: se pierde al recargar)
const FAVS_KEY = "tf_fan_favs";
function readFavsLocal() {
  try {
    const raw = localStorage.getItem(FAVS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr.map(Number) : []);
  } catch {
    return new Set();
  }
}
function toggleFavLocal(id) {
  try {
    const prev = readFavsLocal();
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    localStorage.setItem(FAVS_KEY, JSON.stringify([...next]));
  } catch {
    /* modo privado: se pierde al recargar, la UI ya refleja el toggle */
  }
}

export default function InicioPage() {
  useDocumentTitle("Enty - Inicio");
  const { user, loading } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [busquedaBoleta, setBusquedaBoleta] = useState("");
  const [mostrandoBoleta, setMostrandoBoleta] = useState(false);
  const [resultadoBoleta, setResultadoBoleta] = useState(null);
  const location = useLocation();
  const favs = readFavsLocal();

  // Cargar eventos al montar
  useEffect(() => {
    fetchPublicEvents({ limit: 100 }).then((d) => setData(d)).catch((e) =>
      setError(e.message || "No pudimos cargar la cartelera")
    );
  }, []);

  // Si aún cargando, mostrar esqueleto
  if (loading) {
    return (
      <div className="inicio motion-reduced">
        <div className="inicio-skeleton" />
      </div>
    );
  }

  // Si no hay datos aún, mostrar esqueleto
  if (!data && !error) {
    return (
      <div className="inicio motion-reduced">
        <div className="inicio-skeleton" />
      </div>
    );
  }

  // Verificar boleta por ID o token
  function verificarBoleta() {
    if (!busquedaBoleta.trim()) return;
    const events = data?.events ?? [];
    const found = events.find((e) => {
      return (
        e.id.toString() === busquedaBoleta.trim() ||
        e.name.toLowerCase().includes(busquedaBoleta.toLowerCase()) ||
        (e.location || "").toLowerCase().includes(busquedaBoleta.toLowerCase()) ||
        (e.venue || "").toLowerCase().includes(busquedaBoleta.toLowerCase())
      );
    });

    if (found) {
      setResultadoBoleta({
        id: found.id,
        name: found.name,
        status: found.status,
        where: found.where,
        price: money(found.price_cents),
        fecha: new Date(found.starts_at).toLocaleDateString("es-CO"),
        vendida: (found.sold_pct ?? 0) >= 70,
      });
      setMostrandoBoleta(true);
    } else {
      setError("Boleta no encontrada en el catalogo");
    }
  }

  function toggleLogin() {
    if (user?.isAuthenticated) {
      const from = location.state?.from;
      window.location.href = from || "/perfil";
    } else {
      window.location.href = "/login";
    }
  }

  const tieneSesion = user?.isAuthenticated ?? false;

  // Si no hay datos aún, mostrar esqueleto
  if (!data && !error) {
    return (
      <div className="inicio motion-reduced">
        <div className="inicio-skeleton" />
      </div>
    );
  }

  const events = data.events ?? [];
  const disponibles = events.filter(isEventAvailable);

  // Si hay error, mostrar mensaje
  if (error && !data) {
    return (
      <div className="inicio error">
        <span className="enty-spark" aria-hidden="true">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
        </span>
        <h2>Cartelera no disponible</h2>
        <p>{error}</p>
      </div>
    );
  }

  // Si no hay eventos disponibles, mostrar mensaje
  if (!disponibles.length) {
    return (
      <div className="inicio sin-eventos">
        <span className="enty-spark" aria-hidden="true">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
        </span>
        <h2>No hay eventos disponibles en este momento</h2>
        <p>Intenta más tarde o busca en otras categorías</p>
        <TransitionLink to="/boletas" className="btn-ghost">
          Ver mis boletos
        </TransitionLink>
      </div>
    );
  }

  return (
    <div className="inicio">
      {/* Header de presentación */}
      <header className="inicio-header">
        <TransitionLink to="/inicio" className="inicio-wordmark" aria-label="Enty, inicio">
          <span>Enty</span>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 0L4 6l8 6-8 6zm5 3l7 7-7 7zm-3 9H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h2" />
            <circle cx="3" cy="12" r="1" />
            <circle cx="21" cy="12" r="1" />
            <path d="M8 16l6-6 6 6z" />
          </svg>
        </TransitionLink>

        {/* CTA de login/registro */}
        <div className="inicio-cta">
          {tieneSesion ? (
            <TransitionLink to="/perfil" className="btn-primary">
              Hola, {user?.name || "Usuario"}
            </TransitionLink>
          ) : (
            <button
              type="button"
              onClick={toggleLogin}
              className="btn-primary w-full"
              aria-label="Iniciar sesión o crear cuenta"
            >
              {user?.role === "admin"
                ? "Panel Admin"
                : user?.role === "promotor"
                ? "Panel Promotor"
                : "Ingresar"}
            </button>
          )}
        </div>
      </header>

      {/* Sección: Eventos disponibles */}
      <main className="inicio-contenido">
        <h2 className="inicio-titulo">Eventos disponibles</h2>

        {/* Check de boleta */}
        <div className="inicio-busqueda-boleta">
          <input
            type="text"
            value={busquedaBoleta}
            onChange={(e) => setBusquedaBoleta(e.target.value)}
            placeholder="Ingresa ID o nombre de boleta..."
            aria-label="Buscar boleta"
            className="input-boleta"
          />
          <button
            type="button"
            onClick={verificarBoleta}
            className="btn-buscar"
            aria-label="Verificar boleta"
          >
            Verificar
          </button>
        </div>

        {/* Lista de eventos disponibles */}
        <div className="inicio-lista">
          {disponibles.map((e) => {
            const fav = favs.has(e.id);
            return (
              <div key={e.id} className="inicio-item">
                <TransitionLink
                  to={`/evento/${e.id}`}
                  className="inicio-item-link"
                  onClick={() => setMostrandoBoleta(false)}
                >
                  <h3 className="inicio-item-nombre">{e.name}</h3>
                  <p className="inicio-item-fecha">
                    {new Date(e.starts_at).toLocaleDateString("es-CO", {
                      weekday: "short",
                      day: "numeric",
                      month: "short",
                    })}
                  </p>
                  <p className="inicio-item-lugar">
                    {e.where || "Por definir"}
                  </p>
                  <p className="inicio-item-precio">
                    {money(e.price_cents)}
                  </p>
                </TransitionLink>
                <button
                  type="button"
                  className="inicio-item-fav transition-colors"
                  aria-label={fav ? `Quitar ${e.name} de favoritos` : `Guardar ${e.name} en favoritos`}
                  aria-pressed={fav}
                  onClick={() => toggleFavLocal(e.id)}
                >
                  <Heart filled={fav} />
                </button>
              </div>
            );
          })}

          {/* Mostrar resultado de boleta si hay */}
          {mostrandoBoleta && resultadoBoleta && (
            <div className="inicio-resultado-boleta">
              <h3>Resultado de boleta</h3>
              <p>
                <strong>{resultadoBoleta.name}</strong> - {resultadoBoleta.fecha}
              </p>
              <p>
                Estado: {resultadoBoleta.vendida ? "Casi agotado" : "Aún disponible"}
              </p>
              <p>
                Ubicación: {resultadoBoleta.where}
              </p>
              <p>
                Precio: {resultadoBoleta.price}
              </p>
              <TransitionLink
                to={`/evento/${resultadoBoleta.id}`}
                className="btn-primary mt-2"
              >
                Ver boleta
              </TransitionLink>
              <button
                type="button"
                onClick={() => setMostrandoBoleta(false)}
                className="btn-secondary ml-2"
              >
                Cerrar
              </button>
            </div>
          )}

          {/* Mensaje si no hay eventos disponibles */}
          {disponibles.length === 0 && (
            <p className="inicio-sin-eventos">
              No hay eventos disponibles en este momento
            </p>
          )}
        </div>
      </main>

      {/* Footer de la presentación */}
      <footer className="inicio-footer">
        <p className="inicio-footer-texto">
          <span>Enty</span> - Tu plataforma de boletería inteligente
        </p>
        <nav className="inicio-footer-links" aria-label="Enlaces rápidos">
          <TransitionLink to="/terminos">Términos</TransitionLink>
          <TransitionLink to="/privacidad">Privacidad</TransitionLink>
        </nav>
      </footer>
    </div>
  );
}