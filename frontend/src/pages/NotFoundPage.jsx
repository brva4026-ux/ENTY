import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { homeForRole } from "../lib/roles";
import { Logo } from "../components/Brand";
import useDocumentTitle from "../lib/useDocumentTitle";
import TransitionLink from "../components/TransitionLink";

/**
 * Pantalla de ruta inexistente.
 *
 * Antes `*` redirigía en silencio a "/" (y de ahí, según el rol, a la vitrina
 * o al panel). Un enlace roto, un QR viejo o un typo aterrizaban como si nada
 * hubiera pasado: la persona no entendía por qué veía otra cosa que la pedida.
 * Esta pantalla lo dice y ofrece la salida correcta para cada caso.
 *
 * Es pública (no monta `Layout`): la mayoría de quien llega con un enlace roto
 * no tiene sesión — el QR de una boleta vieja es el caso típico.
 */
export default function NotFoundPage() {
  useDocumentTitle("Página no encontrada");
  const { user } = useAuth();
  const nav = useNavigate();
  const { pathname } = useLocation();

  // Con sesión, "volver" es el panel de su rol; sin sesión, la vitrina.
  const home = user ? homeForRole(user) : "/inicio";
  const homeLabel = user ? "Ir a mi panel" : "Ver la cartelera";

  return (
    <div className="auth-shell grid min-h-screen place-items-center px-4 py-10">
      <div className="w-full max-w-md text-center">
        <div className="flex justify-center">
          <Logo />
        </div>

        <p className="mt-8 font-mono text-5xl font-bold text-brand-400">404</p>
        <h1 className="mt-3 text-2xl font-semibold text-zinc-100">
          Esta página no existe
        </h1>
        <p className="mt-2 text-sm text-zinc-400">
          Puede que el enlace esté mal escrito o que ya no esté disponible.
        </p>
        {/* La ruta pedida, en mono y con corte: ayuda a distinguir un typo de
            un enlace viejo sin exponer nada sensible (es la URL, ya pública). */}
        <p className="mt-4 truncate rounded-lg bg-zinc-900/70 px-3 py-2 font-mono text-xs text-zinc-500">
          {pathname}
        </p>

        <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
          <button onClick={() => nav(-1)} className="btn-ghost">
            Volver atrás
          </button>
          <TransitionLink to={home} className="btn-primary">
            {homeLabel}
          </TransitionLink>
        </div>
      </div>
    </div>
  );
}
