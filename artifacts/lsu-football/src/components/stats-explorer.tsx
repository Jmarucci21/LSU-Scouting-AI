import { useMemo, useState } from "react";
import {
  useListStats,
  useGetStatsMeta,
  useListCareerStats,
  getListStatsQueryKey,
  getListCareerStatsQueryKey,
} from "@workspace/api-client-react";
import type {
  StatRow,
  StatsMetaResponse,
  CareerStatRow,
  ListStatsDivision,
} from "@workspace/api-client-react";
import { useGlobalFilters } from "@/hooks/use-global-filters";
import { useDebounce } from "@/hooks/use-debounce";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { MultiSelect } from "@/components/multi-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Search, ChevronRight, ChevronDown, ChevronUp } from "lucide-react";
import { Link } from "wouter";
import { SortableHeader } from "@/components/sortable-header";

type CareerSortKey = "total" | "seasonsCount" | "name";
type SeasonSortKey = "value" | "name" | "team";

const SOURCE_LABELS: Record<string, string> = {
  statsbomb: "Hudl StatsBomb",
  telemetry: "Telemetry",
  cfbd: "CFBD",
  trumedia: "TruMedia",
  pff: "PFF",
};

function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

type Division = ListStatsDivision | undefined;

const DIVISIONS: { value: Division; label: string }[] = [
  { value: undefined, label: "All" },
  { value: "fbs", label: "FBS" },
  { value: "fcs", label: "FCS" },
  { value: "power4", label: "Power 4" },
];

// Deduped union of stat keys across the given sources (or every source when
// none are selected), sorted by label.
function keysForSources(
  meta: StatsMetaResponse | undefined,
  sources: string[],
): { value: string; label: string }[] {
  const activeSources = sources.length ? sources : (meta?.sources ?? []);
  const seen = new Map<string, string>();
  for (const group of meta?.keysBySource ?? []) {
    if (!activeSources.includes(group.source)) continue;
    for (const k of group.keys) {
      if (!seen.has(k.key)) seen.set(k.key, k.label);
    }
  }
  return Array.from(seen, ([value, label]) => ({ value, label })).sort((a, b) =>
    a.label.localeCompare(b.label),
  );
}

function formatValue(row: StatRow): string {
  if (row.strValue != null && row.strValue !== "") return row.strValue;
  if (row.value == null) return "-";
  const v = row.value;
  const formatted = Number.isInteger(v) ? v.toString() : v.toFixed(2);
  return row.unit ? `${formatted} ${row.unit}` : formatted;
}

function formatNumber(v: number | null | undefined, unit?: string | null): string {
  if (v == null) return "-";
  const formatted = Number.isInteger(v) ? v.toString() : v.toFixed(2);
  return unit ? `${formatted} ${unit}` : formatted;
}

function seasonSpan(row: CareerStatRow): string {
  return row.firstSeason === row.lastSeason
    ? `${row.firstSeason}`
    : `${row.firstSeason}\u2013${row.lastSeason}`;
}

export function StatsExplorer({ fixedTeam }: { fixedTeam?: string }) {
  const { season } = useGlobalFilters();
  // Career view is cross-team by nature (it merges a player's seasons across
  // every school), so it is only offered in the global explorer, never on a
  // team-scoped page.
  const careerAllowed = !fixedTeam;
  const [mode, setMode] = useState<"season" | "career">("season");
  const isCareer = careerAllowed && mode === "career";

  const [sources, setSources] = useState<string[]>([]);
  const [statKeys, setStatKeys] = useState<string[]>([]);
  const [positionGroup, setPositionGroup] = useState<string | undefined>();
  const [division, setDivision] = useState<Division>(undefined);
  const [conference, setConference] = useState<string | undefined>();
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 300);
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [careerSort, setCareerSort] = useState<CareerSortKey>("total");
  const [careerOrder, setCareerOrder] = useState<"asc" | "desc">("desc");
  const [seasonSort, setSeasonSort] = useState<SeasonSortKey>("name");
  const [seasonOrder, setSeasonOrder] = useState<"asc" | "desc">("asc");
  const pageSize = 50;

  const { data: meta } = useGetStatsMeta({ season });

  const seasonParams = {
    source: sources.length ? sources.join(",") : undefined,
    season,
    team: fixedTeam,
    // Conference/division are team-level scopes — meaningless on a team-scoped
    // page (a single team has one conference), so only send them globally.
    conference: fixedTeam ? undefined : conference,
    division: fixedTeam ? undefined : division,
    positionGroup,
    search: debouncedSearch || undefined,
    key: statKeys.length ? statKeys.join(",") : undefined,
    sort: seasonSort,
    order: seasonOrder,
    page,
    pageSize,
  };
  const careerParams = {
    source: sources.length ? sources.join(",") : undefined,
    search: debouncedSearch || undefined,
    key: statKeys.length ? statKeys.join(",") : undefined,
    sort: careerSort,
    order: careerOrder,
    page,
    pageSize,
  };

  const { data: seasonData, isLoading: seasonLoading } = useListStats(
    seasonParams,
    {
      query: {
        enabled: !isCareer,
        queryKey: getListStatsQueryKey(seasonParams),
      },
    },
  );

  const { data: careerData, isLoading: careerLoading } = useListCareerStats(
    careerParams,
    {
      query: {
        enabled: isCareer,
        queryKey: getListCareerStatsQueryKey(careerParams),
      },
    },
  );

  const isLoading = isCareer ? careerLoading : seasonLoading;
  const total = isCareer ? (careerData?.total ?? 0) : (seasonData?.total ?? 0);

  const sourceOptions = useMemo(
    () =>
      (meta?.sources ?? []).map((s) => ({ value: s, label: sourceLabel(s) })),
    [meta?.sources],
  );

  // Stat keys are the union across the selected sources (or every source when
  // none are selected), deduped by key. Lets you mix metrics from sources.
  const keyOptions = useMemo(
    () => keysForSources(meta, sources),
    [meta, sources],
  );

  const resetPaging = () => {
    setPage(1);
    setExpanded(new Set());
  };

  // Click a Career column header: toggle direction if it's already the active
  // sort, otherwise switch to it with a sensible default (numbers high→low,
  // names A→Z). Resets paging so the new ordering starts at page 1.
  const handleCareerSort = (col: CareerSortKey) => {
    if (careerSort === col) {
      setCareerOrder((o) => (o === "asc" ? "desc" : "asc"));
    } else {
      setCareerSort(col);
      setCareerOrder(col === "name" ? "asc" : "desc");
    }
    resetPaging();
  };

  // Same interaction for the By Season table: toggle direction on the active
  // column, otherwise switch with a sensible default (value high→low, text A→Z).
  const handleSeasonSort = (col: SeasonSortKey) => {
    if (seasonSort === col) {
      setSeasonOrder((o) => (o === "asc" ? "desc" : "asc"));
    } else {
      setSeasonSort(col);
      setSeasonOrder(col === "value" ? "desc" : "asc");
    }
    resetPaging();
  };

  const toggleRow = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const colCount = isCareer ? 6 : fixedTeam ? 5 : 6;

  return (
    <div className="space-y-4 flex flex-col flex-1 min-h-0">
      <div className="flex flex-col md:flex-row md:flex-wrap gap-4 items-center bg-card p-4 rounded-lg border border-border shadow-sm">
        {careerAllowed && (
          <div className="inline-flex rounded-md border border-border overflow-hidden shrink-0">
            <button
              type="button"
              onClick={() => {
                setMode("season");
                resetPaging();
              }}
              className={`px-4 py-2 text-sm font-semibold transition-colors ${
                !isCareer
                  ? "bg-primary text-primary-foreground"
                  : "bg-background text-muted-foreground hover:bg-muted"
              }`}
            >
              By Season
            </button>
            <button
              type="button"
              onClick={() => {
                setMode("career");
                resetPaging();
              }}
              className={`px-4 py-2 text-sm font-semibold transition-colors ${
                isCareer
                  ? "bg-primary text-primary-foreground"
                  : "bg-background text-muted-foreground hover:bg-muted"
              }`}
            >
              Career
            </button>
          </div>
        )}

        <div className="relative flex-1 w-full">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground w-4 h-4" />
          <Input
            placeholder="Search players..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              resetPaging();
            }}
            className="pl-9 bg-background"
          />
        </div>

        <div className="w-full md:w-56">
          <MultiSelect
            options={sourceOptions}
            selected={sources}
            onChange={(v) => {
              setSources(v);
              // Drop any selected stat keys that no longer belong to the
              // selected sources, so the key filter can't silently zero out
              // the results.
              const valid = new Set(keysForSources(meta, v).map((k) => k.value));
              setStatKeys((prev) => prev.filter((k) => valid.has(k)));
              resetPaging();
            }}
            placeholder="All Sources"
            searchPlaceholder="Search sources..."
            emptyText="No sources."
          />
        </div>

        <div className="w-full md:w-56">
          <MultiSelect
            options={keyOptions}
            selected={statKeys}
            onChange={(v) => {
              setStatKeys(v);
              resetPaging();
            }}
            placeholder="All Stats"
            searchPlaceholder="Search stats..."
            emptyText="No stats."
            disabled={keyOptions.length === 0}
          />
        </div>

        {/* Position / team-scope filters apply to By Season rows only. The
            Career table is name-based with no position or conference, so these
            are hidden in Career mode (and conference/division are hidden on a
            team-scoped page, where the team already fixes them). */}
        {!isCareer && (
          <div className="w-full md:w-44">
            <Select
              value={positionGroup || "all"}
              onValueChange={(v) => {
                setPositionGroup(v === "all" ? undefined : v);
                resetPaging();
              }}
            >
              <SelectTrigger className="bg-background">
                <SelectValue placeholder="All Positions" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Positions</SelectItem>
                {meta?.positionGroups?.map((pg) => (
                  <SelectItem key={pg.value} value={pg.value}>
                    {pg.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {!isCareer && !fixedTeam && (
          <div className="w-full md:w-52">
            <Select
              value={conference || "all"}
              onValueChange={(v) => {
                setConference(v === "all" ? undefined : v);
                resetPaging();
              }}
            >
              <SelectTrigger className="bg-background">
                <SelectValue placeholder="All Conferences" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Conferences</SelectItem>
                {meta?.conferences?.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {!isCareer && !fixedTeam && (
          <div className="inline-flex rounded-md border border-border overflow-hidden shrink-0">
            {DIVISIONS.map((d) => {
              const active = division === d.value;
              return (
                <button
                  key={d.label}
                  type="button"
                  onClick={() => {
                    setDivision(d.value);
                    resetPaging();
                  }}
                  className={`px-3 py-2 text-sm font-semibold transition-colors ${
                    active
                      ? "bg-primary text-primary-foreground"
                      : "bg-background text-muted-foreground hover:bg-muted"
                  }`}
                >
                  {d.label}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <Card className="flex-1 overflow-hidden shadow-sm flex flex-col border-border min-h-0">
        <div className="overflow-x-auto flex-1">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-muted-foreground text-sm uppercase tracking-wider">
                {isCareer ? (
                  <>
                    <SortableHeader
                      label="Player"
                      active={careerSort === "name"}
                      order={careerOrder}
                      onClick={() => handleCareerSort("name")}
                    />
                    <th className="p-4 font-semibold">Team</th>
                    <th className="p-4 font-semibold">Source</th>
                    <th className="p-4 font-semibold">Stat</th>
                    <SortableHeader
                      label="Seasons"
                      active={careerSort === "seasonsCount"}
                      order={careerOrder}
                      onClick={() => handleCareerSort("seasonsCount")}
                    />
                    <SortableHeader
                      label="Career Total"
                      align="right"
                      active={careerSort === "total"}
                      order={careerOrder}
                      onClick={() => handleCareerSort("total")}
                    />
                  </>
                ) : (
                  <>
                    <SortableHeader
                      label="Player"
                      active={seasonSort === "name"}
                      order={seasonOrder}
                      onClick={() => handleSeasonSort("name")}
                    />
                    <th className="p-4 font-semibold">Pos</th>
                    {!fixedTeam && (
                      <SortableHeader
                        label="Team"
                        active={seasonSort === "team"}
                        order={seasonOrder}
                        onClick={() => handleSeasonSort("team")}
                      />
                    )}
                    <th className="p-4 font-semibold">Source</th>
                    <th className="p-4 font-semibold">Stat</th>
                    <SortableHeader
                      label="Value"
                      align="right"
                      active={seasonSort === "value"}
                      order={seasonOrder}
                      onClick={() => handleSeasonSort("value")}
                    />
                  </>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {isLoading ? (
                Array.from({ length: 12 }).map((_, i) => (
                  <tr key={i}>
                    <td className="p-4"><Skeleton className="h-6 w-32" /></td>
                    <td className="p-4"><Skeleton className="h-6 w-12" /></td>
                    {!isCareer && !fixedTeam && <td className="p-4"><Skeleton className="h-6 w-24" /></td>}
                    <td className="p-4"><Skeleton className="h-6 w-20" /></td>
                    <td className="p-4"><Skeleton className="h-6 w-28" /></td>
                    <td className="p-4"><Skeleton className="h-6 w-12 ml-auto" /></td>
                  </tr>
                ))
              ) : isCareer ? (
                careerData?.rows?.length === 0 ? (
                  <tr>
                    <td colSpan={colCount} className="p-8 text-center text-muted-foreground">
                      {search ? (
                        <>
                          No career stats found for &ldquo;{search}&rdquo;. Try a
                          different name, or run a data sync to populate career
                          totals.
                        </>
                      ) : (
                        <>
                          No career stats yet. Career totals are built during a
                          data sync &mdash; run one to populate them.
                        </>
                      )}
                    </td>
                  </tr>
                ) : (
                  careerData?.rows?.map((row, i) => {
                    const id = `${row.latestPlayerId}-${row.source}-${row.key}-${i}`;
                    const isOpen = expanded.has(id);
                    return (
                      <CareerRows
                        key={id}
                        id={id}
                        row={row}
                        isOpen={isOpen}
                        onToggle={() => toggleRow(id)}
                      />
                    );
                  })
                )
              ) : seasonData?.rows?.length === 0 ? (
                <tr>
                  <td colSpan={colCount} className="p-8 text-center text-muted-foreground">
                    {search ? (
                      <>
                        No stats found for &ldquo;{search}&rdquo; in the{" "}
                        <span className="font-semibold text-foreground">
                          {season}
                        </span>{" "}
                        season. That player may not have played this season &mdash;
                        try changing the Season filter on the left.
                      </>
                    ) : (
                      <>
                        No stats found for the{" "}
                        <span className="font-semibold text-foreground">
                          {season}
                        </span>{" "}
                        season. Adjust the filters or run a data sync.
                      </>
                    )}
                  </td>
                </tr>
              ) : (
                seasonData?.rows?.map((row, i) => (
                  <tr
                    key={`${row.playerId}-${row.source}-${row.key}-${i}`}
                    className="hover:bg-muted/30 transition-colors group"
                  >
                    <td className="p-4">
                      <Link href={`/players/${row.playerId}`}>
                        <div className="font-bold text-foreground group-hover:text-primary cursor-pointer">
                          {row.playerName}
                        </div>
                      </Link>
                    </td>
                    <td className="p-4 text-sm font-medium">{row.position || "-"}</td>
                    {!fixedTeam && (
                      <td className="p-4 text-sm text-muted-foreground">{row.team || "-"}</td>
                    )}
                    <td className="p-4 text-sm text-muted-foreground">{sourceLabel(row.source)}</td>
                    <td className="p-4 text-sm">{row.label}</td>
                    <td className="p-4 text-sm font-bold text-right">{formatValue(row)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {total > 0 && (
          <div className="p-4 border-t border-border flex items-center justify-between bg-card text-sm text-muted-foreground">
            <div>
              Showing{" "}
              <span className="font-medium text-foreground">
                {(page - 1) * pageSize + 1}
              </span>{" "}
              to{" "}
              <span className="font-medium text-foreground">
                {Math.min(page * pageSize, total)}
              </span>{" "}
              of <span className="font-medium text-foreground">{total}</span>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page === 1}
                onClick={() => {
                  setPage((p) => p - 1);
                  setExpanded(new Set());
                }}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page * pageSize >= total}
                onClick={() => {
                  setPage((p) => p + 1);
                  setExpanded(new Set());
                }}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

function CareerRows({
  id,
  row,
  isOpen,
  onToggle,
}: {
  id: string;
  row: CareerStatRow;
  isOpen: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        className="hover:bg-muted/30 transition-colors group cursor-pointer"
        onClick={onToggle}
        aria-expanded={isOpen}
      >
        <td className="p-4">
          <div className="flex items-center gap-2">
            {isOpen ? (
              <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
            ) : (
              <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
            )}
            <Link href={`/players/${row.latestPlayerId}`}>
              <span
                className="font-bold text-foreground group-hover:text-primary cursor-pointer"
                onClick={(e) => e.stopPropagation()}
              >
                {row.displayName}
              </span>
            </Link>
          </div>
        </td>
        <td className="p-4 text-sm text-muted-foreground">{row.latestTeam || "-"}</td>
        <td className="p-4 text-sm text-muted-foreground">{sourceLabel(row.source)}</td>
        <td className="p-4 text-sm">{row.label}</td>
        <td className="p-4 text-sm">
          <span className="font-medium text-foreground">{seasonSpan(row)}</span>
          <span className="text-muted-foreground">
            {" "}
            ({row.seasonsCount} {row.seasonsCount === 1 ? "season" : "seasons"})
          </span>
        </td>
        <td className="p-4 text-sm font-bold text-right">
          {formatNumber(row.total, row.unit)}
          {row.agg === "avg" && (
            <span
              className="ml-1.5 text-xs font-normal text-muted-foreground"
              title="Per-season average — this is a rate/percentage stat, which cannot be summed across seasons"
            >
              avg
            </span>
          )}
        </td>
      </tr>
      {isOpen && (
        <tr className="bg-muted/20">
          <td colSpan={6} className="px-4 pb-4 pt-0">
            <div className="ml-6 border-l-2 border-primary/40 pl-4">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-muted-foreground uppercase text-xs tracking-wider">
                    <th className="py-2 text-left font-semibold">Season</th>
                    <th className="py-2 text-left font-semibold">Team</th>
                    <th className="py-2 text-right font-semibold">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {row.breakdown.map((b) => (
                    <tr key={`${id}-${b.season}-${b.team ?? ""}`}>
                      <td className="py-1.5 font-medium text-foreground">{b.season}</td>
                      <td className="py-1.5 text-muted-foreground">{b.team || "-"}</td>
                      <td className="py-1.5 text-right font-semibold text-foreground">
                        {formatNumber(b.value, row.unit)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
