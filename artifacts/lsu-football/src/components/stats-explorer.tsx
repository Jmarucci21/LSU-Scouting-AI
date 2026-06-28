import { useState } from "react";
import { useListStats, useGetStatsMeta } from "@workspace/api-client-react";
import type { StatRow } from "@workspace/api-client-react";
import { useGlobalFilters } from "@/hooks/use-global-filters";
import { useDebounce } from "@/hooks/use-debounce";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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

function formatValue(row: StatRow): string {
  if (row.strValue != null && row.strValue !== "") return row.strValue;
  if (row.value == null) return "-";
  const v = row.value;
  const formatted = Number.isInteger(v) ? v.toString() : v.toFixed(2);
  return row.unit ? `${formatted} ${row.unit}` : formatted;
}

export function StatsExplorer({ fixedTeam }: { fixedTeam?: string }) {
  const { season } = useGlobalFilters();
  const [source, setSource] = useState<string | undefined>();
  const [statKey, setStatKey] = useState<string | undefined>();
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 300);
  const [page, setPage] = useState(1);
  const pageSize = 50;

  const { data: meta } = useGetStatsMeta({ season });

  const { data, isLoading } = useListStats({
    source,
    season,
    team: fixedTeam,
    search: debouncedSearch || undefined,
    key: statKey,
    page,
    pageSize,
  });

  const keysForSource = source
    ? meta?.keysBySource?.find((k) => k.source === source)?.keys ?? []
    : [];

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
          <Select
            value={source || "all"}
            onValueChange={(v) => {
              setSource(v === "all" ? undefined : v);
              setStatKey(undefined);
              setPage(1);
            }}
          >
            <SelectTrigger className="bg-background">
              <SelectValue placeholder="All Sources" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Sources</SelectItem>
              {meta?.sources?.map((s) => (
                <SelectItem key={s} value={s}>
                  {sourceLabel(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="w-full md:w-56">
          <Select
            value={statKey || "all"}
            onValueChange={(v) => {
              setStatKey(v === "all" ? undefined : v);
              setPage(1);
            }}
            disabled={!source}
          >
            <SelectTrigger className="bg-background">
              <SelectValue placeholder="All Stats" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Stats</SelectItem>
              {keysForSource.map((k) => (
                <SelectItem key={k.key} value={k.key}>
                  {k.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
