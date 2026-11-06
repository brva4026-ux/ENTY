import { useNavigate } from "react-router-dom";
import { useAuth } from "../../../lib/auth";
import { activeVenueId } from "../../../lib/venue";
import Icon from "../../../components/Icon";
import AllocationManager from "../../../components/AllocationManager";

export default function Cupos() {
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
        <Icon name="users" className="h-4 w-4 text-zinc-500" />
        <h2 className="display text-lg">{venueName ?? "Cupos"}</h2>
      </div>
      <AllocationManager
        venueId={venueId}
        eventId={null}
        users={[]}
        onChange={async () => {}}
      />
    </div>
  );
}
