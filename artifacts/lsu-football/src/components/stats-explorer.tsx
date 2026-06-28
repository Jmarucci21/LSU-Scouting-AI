import { useMemo, useState } from "react";
import { useListStats, useGetStatsMeta } from "@workspace/api-client-react";
import type { StatRow, StatsMetaResponse } from "@workspace/api-client-react";
import { useGlobalFilters } from "@/hooks/use-global-filters";
import { useDebounce } from "@/hooks/use-debounce";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { MultiSelect } from "@/components/multi-select";
import { Search } from "lucide-react";
import { Link } from "wouter";

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

export function StatsExplorer({ fixedTeam }: { fixedTeam?: string }) {
  const { season } = useGlobalFilters();
  const [sources, setSources] = useState<string[]>([]);
  const [statKeys, setStatKeys] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 300);
  const [page, setPage] = useState(1);
  const pageSize = 50;

  const { data: meta } = useGetStatsMeta({ season });

  const { data, isLoading } = useListStats({
    source: sources.length ? sources.join(",") : undefined,
    season,
    team: fixedTeam,
    search: debouncedSearch || undefined,
    key: statKeys.length ? statKeys.join(",") : undefined,
    page,
    pageSize,
  });

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

  return (
    <div className="space-y-4 flex flex-col flex-1 min-h-0">
      <div className="flex flex-col md:flex-row gap-4 items-center bg-card p-4 rounded-lg border border-border shadow-sm">
        <div className="relative flex-1 w-full">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground w-4 h-4" />
          <Input
            placeholder="Search players..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
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
              setPage(1);
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
              setPage(1);
            }}
            placeholder="All Stats"
            searchPlaceholder="Search stats..."
            emptyText="No stats."
            disabled={keyOptions.length === 0}
          />
        </div>
      </div>

      <Card className="flex-1 overflow-hidden shadow-sm flex flex-col border-border min-h-0">
        <div className="overflow-x-auto flex-1">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-muted-foreground text-sm uppercase tracking-wider">
                <th className="p-4 font-semibold">Player</th>
                <th className="p-4 font-semibold">Pos</th>
                {!fixedTeam && <th className="p-4 font-semibold">Team</th>}
                <th className="p-4 font-semibold">Source</th>
                <th className="p-4 font-semibold">Stat</th>
                <th className="p-4 font-semibold text-right">Value</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {isLoading ? (
                Array.from({ length: 12 }).map((_, i) => (
                  <tr key={i}>
                    <td className="p-4"><Skeleton className="h-6 w-32" /></td>
                    <td className="p-4"><Skeleton className="h-6 w-12" /></td>
                    {!fixedTeam && <td className="p-4"><Skeleton className="h-6 w-24" /></td>}
                    <td className="p-4"><Skeleton className="h-6 w-20" /></td>
                    <td className="p-4"><Skeleton className="h-6 w-28" /></td>
                    <td className="p-4"><Skeleton className="h-6 w-12 ml-auto" /></td>
                  </tr>
                ))
              ) : data?.rows?.length === 0 ? (
                <tr>
                  <td colSpan={fixedTeam ? 5 : 6} className="p-8 text-center text-muted-foreground">
                    No stats found. Adjust filters or run a data sync.
                  </td>
                </tr>
              ) : (
                data?.rows?.map((row, i) => (
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

        {data && data.total > 0 && (
          <div className="p-4 border-t border-border flex items-center justify-between bg-card text-sm text-muted-foreground">
            <div>
              Showing{" "}
              <span className="font-medium text-foreground">
                {(page - 1) * pageSize + 1}
              </span>{" "}
              to{" "}
              <span className="font-medium text-foreground">
                {Math.min(page * pageSize, data.total)}
              </span>{" "}
              of <span className="font-medium text-foreground">{data.total}</span>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page === 1}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page * pageSize >= data.total}
                onClick={() => setPage((p) => p + 1)}
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
