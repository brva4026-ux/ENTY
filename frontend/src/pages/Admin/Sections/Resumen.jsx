import { useNavigate } from "react-router-dom";
import { useAuth } from "../../../lib/auth";
import { activeVenueId } from "../../../lib/venue";
import BusinessOverview from "../../../components/BusinessOverview";

export default function Resumen() {
  const { user } = useAuth();
  const nav = useNavigate();
  const venueId = activeVenueId(user);
  const venueName = (user?.venues || []).find((v) => v.id === venueId)?.name;

  if (!venueId) {
    return (
      <div className="card p-5 text-center text-zinc-400">
        No tienes venues asociadas. Habla con un super admin.
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <Icon name="chart" className="h-4 w-4 text-zinc-500" />
        <h2 className="display text-lg">Resumen del mes</h2>
      </div>
      <BusinessOverview
        venueId={venueId}
        month={null}
        onOpenEvent={(id) => nav(`/admin?event=${id}&tab=resumen`)}
      />
    </div>
  );
}
