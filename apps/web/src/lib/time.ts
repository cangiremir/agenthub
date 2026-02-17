import { formatDistanceToNowStrict } from "date-fns";

const ONLINE_THRESHOLD_MS = 60_000;
const OFFLINE_THRESHOLD_MS = 300_000;

export const relativeTime = (value: string | null): string => {
  if (!value) return "never";
  return `${formatDistanceToNowStrict(new Date(value))} ago`;
};

export const statusFromLastSeen = (value: string | null): "online" | "stale" | "offline" => {
  if (!value) return "offline";
  const age = Date.now() - new Date(value).getTime();
  if (age < ONLINE_THRESHOLD_MS) return "online";
  if (age < OFFLINE_THRESHOLD_MS) return "stale";
  return "offline";
};
