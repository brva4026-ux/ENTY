import { useAuth } from "react-router-dom";
import { lazy, Suspense } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { useUI } from "../lib/ui";
import { haptics } from "../lib/haptics";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import Icon from "../components/Icon";
import { BrandLogo } from "../components/Brand";
import BusinessDock from "../components/BusinessDock";

const Resumen = lazy(() => import("./Sections/Resumen"));
const Entradas = lazy(() => import("./Sections/Entradas"));
const Cupos = lazy(() => import("./Sections/Cupos"));
const Boletas = lazy(() => import("./Sections/Boletas"));
const Noche = lazy(() => import("./Sections/Noche"));
const Cobros = lazy(() => import("./Sections/Cobros"));
const Puerta = lazy(() => import("./Sections/Puerta"));
const Promotores = lazy(() => import("./Sections/Promotores"));
const Equipo = lazy(() => import("./Sections/Equipo"));
const Liquidaciones = lazy(() => import("./Sections/Liquidaciones"));
const Invitaciones = lazy(() => import("./Sections/Invitaciones"));

const SECTION_ENTRIES = [
  ["resumen", Resumen],
  ["entradas", Entradas],
  ["cupos", Cupos],
  ["boletas", Boletas],
  ["noche", Noche],
  ["cobros", Cobros],
  ["puerta", Puerta],
  ["promotores", Promotores],
  ["equipo", Equipo],
  ["liquidaciones", Liquidaciones],
  ["invitaciones", Invitaciones],
];

const ACTIVE_SECTIONS = new Set([
  "resumen",
  "entradas",
  "cupos",
  "boletas",
  "noche",
  "cobros",
  "puerta",
  "promotores",
  "equipo",
  "liquidaciones",
  "invitaciones",
]);

export default function AdminSection() {
  const { user } = useAuth();
  const ui = useUI();
  const location = useLocation();
  useDocumentTitle("Negocio");
  return (
    <div className="mx-auto max-w-5xl px-4 py-6 pb-28 md:pb-8">
      <div key={location.pathname} className="reveal">
        <BusinessDock />
        <Outlet />
      </div>
    </div>
  );
}

export function SectionRoute({ tab, icon, label, description, ...rest }) {
  const [Section] = ACTIVE_SECTIONS.has(tab) ? [null] : [];
  return (
    <Route
      key={tab}
      path={`/${tab}`}
      element={
        <RequireActiveSection tab={tab}>
          <Suspense fallback={<SectionSkeleton />}>
            <Section />
          </Suspense>
        </RequireActiveSection>
      }
    />
  );
}

export default function AdminSectionRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Resumen />} />
      <Route path="/resumen" element={<Resumen />} />
      <Route path="/entradas" element={<Entradas />} />
      <Route path="/cupos" element={<Cupos />} />
      <Route path="/boletas" element={<Boletas />} />
      <Route path="/noche" element={<Noche />} />
      <Route path="/cobros" element={<Cobros />} />
      <Route path="/puerta" element={<Puerta />} />
      <Route path="/promotores" element={<Promotores />} />
      <Route path="/equipo" element={<Equipo />} />
      <Route path="/liquidaciones" element={<Liquidaciones />} />
      <Route path="/invitaciones" element={<Invitaciones />} />
    </Routes>
  );
}

function SectionSkeleton() {
  return (
    <div className="card p-5">
      <div className="h-5 w-28 animate-pulse rounded bg-zinc-800" />
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-20 animate-pulse rounded-lg bg-zinc-800" />
        ))}
      </div>
    </div>
  );
}

function RequireActiveSection({ tab, children }) {
  const { user } = useAuth();
  const allowed = ACTIVE_SECTIONS.has(tab);
  if (!allowed) return null;
  return <>{children}</>;
}
