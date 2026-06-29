import { useMemo } from "react";
import { useListTeams } from "@workspace/api-client-react";

/**
 * Builds a school -> logo URL map from the teams list. The underlying query is
 * shared/deduped by React Query, so calling this from many rows or components
 * triggers a single fetch. Schools without a logo (e.g. TruMedia-only or FCS
 * opponents not in the teams table) are simply absent from the map.
 */
export function useTeamLogos(): Map<string, string> {
  const { data: teams } = useListTeams();
  return useMemo(() => {
    const map = new Map<string, string>();
    for (const t of teams ?? []) {
      if (t.school && t.logo) map.set(t.school, t.logo);
    }
    return map;
  }, [teams]);
}

export function TeamBadge({
  team,
  logo,
  className = "",
}: {
  team?: string | null;
  logo?: string | null;
  className?: string;
}) {
  if (!team) return <>-</>;
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      {logo ? (
        <img
          src={logo}
          alt=""
          aria-hidden="true"
          loading="lazy"
          className="h-5 w-5 shrink-0 object-contain"
        />
      ) : null}
      <span>{team}</span>
    </span>
  );
}
