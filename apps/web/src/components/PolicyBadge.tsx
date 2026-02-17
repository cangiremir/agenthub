import { AgentPolicy } from "../lib/types";

export const PolicyBadge = ({ policy }: { policy: AgentPolicy }) => (
  <span className={`policy-badge policy-${policy.toLowerCase()}`}>{policy}</span>
);
