import { Navigate, useLocation, useSearchParams } from "react-router-dom";
import PromoterEventsView from "./promoter/PromoterEventsView";
import PromoterEventView from "./promoter/PromoterEventView";
import PromoterSalesView from "./promoter/PromoterSalesView";
import PromoterCommissionsView from "./promoter/PromoterCommissionsView";

/**
 * Puerta de entrada del espacio de promotor. La URL manda:
 *   /promotor                 Mis eventos
 *   /promotor/evento/:id      Vender dentro de un evento
 *   /promotor/ventas          Historial y acciones sobre boletas
 *   /promotor/comisiones      Liquidaciones
 *
 * Las URLs viejas (`?tab=liquidaciones`, `?event=`) se redirigen para no
 * romper enlaces ya enviados por notificaciones o WhatsApp.
 */
export default function PromoterDashboard() {
  const { pathname } = useLocation();
  const [searchParams] = useSearchParams();
  const legacyEvent = searchParams.get("event");
  const legacyTab = searchParams.get("tab");

  if (legacyEvent) {
    return <Navigate to={`/promotor/evento/${legacyEvent}`} replace />;
  }
  if (legacyTab === "liquidaciones" || legacyTab === "comisiones") {
    return <Navigate to="/promotor/comisiones" replace />;
  }
  if (legacyTab === "boletas" || legacyTab === "ventas") {
    return <Navigate to="/promotor/ventas" replace />;
  }

  if (pathname === "/promotor" || pathname === "/promotor/") return <PromoterEventsView />;
  if (/^\/promotor\/evento\/\d+\/?$/.test(pathname)) return <PromoterEventView />;
  if (pathname.startsWith("/promotor/ventas")) return <PromoterSalesView />;
  if (pathname.startsWith("/promotor/comisiones")) return <PromoterCommissionsView />;
  return <Navigate to="/promotor" replace />;
}
