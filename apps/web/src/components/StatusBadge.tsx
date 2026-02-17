import { clsx } from "clsx";
import { statusFromLastSeen } from "../lib/time";

export const StatusBadge = ({ lastSeen }: { lastSeen: string | null }) => {
  const status = statusFromLastSeen(lastSeen);
  return (
    <span className={clsx("status-badge", status)}>
      <span className="dot" />
      {status}
    </span>
  );
};
