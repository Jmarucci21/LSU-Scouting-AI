import { useGetPlayerStats, getGetPlayerStatsQueryKey } from "@workspace/api-client-react";
import type { PlayerStatItem } from "@workspace/api-client-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Activity, Lock } from "lucide-react";

const KNOWN_SOURCES = ["statsbomb", "telemetry", "cfbd", "trumedia", "pff"];

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

function formatValue(stat: PlayerStatItem): string {
  if (stat.strValue != null && stat.strValue !== "") return stat.strValue;
  if (stat.value == null) return "-";
  const v = stat.value;
  const formatted = Number.isInteger(v) ? v.toString() : v.toFixed(2);
  return stat.unit ? `${formatted} ${stat.unit}` : formatted;
}

function StatGrid({ stats }: { stats: PlayerStatItem[] }) {
  const byCategory = stats.reduce<Record<string, PlayerStatItem[]>>(
    (acc, s) => {
      const cat = s.category || "General";
      (acc[cat] ??= []).push(s);
      return acc;
    },
    {},
  );

  return (
    <div className="space-y-8">
      {Object.entries(byCategory).map(([cat, items]) => (
        <div key={cat} className="space-y-3">
          <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
            <Activity className="w-4 h-4" /> {cat}
          </h3>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {items.map((stat) => (
              <div
                key={`${stat.key}-${stat.season}-${stat.week ?? "na"}`}
                className="bg-muted/30 p-3 rounded-md border border-border"
              >
                <div className="text-xs text-muted-foreground mb-1 truncate" title={stat.label}>
                  {stat.label}
                </div>
                <div className="text-lg font-black">{formatValue(stat)}</div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function PlayerStatsTabs({ playerId }: { playerId: string }) {
  const { data, isLoading } = useGetPlayerStats(playerId, {
    query: { enabled: !!playerId, queryKey: getGetPlayerStatsQueryKey(playerId) },
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-full" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
      </div>
    );
  }

  const sources = data?.sources ?? [];
  const available = new Set(sources.map((s) => s.source));
  const tabs = [
    ...sources.map((s) => s.source),
    ...KNOWN_SOURCES.filter((s) => !available.has(s)),
  ];

  if (tabs.length === 0) {
    return (
      <div className="h-[200px] flex items-center justify-center text-muted-foreground">
        No raw stats available yet. Run a data sync.
      </div>
    );
  }

  return (
    <Tabs defaultValue={tabs[0]} className="w-full">
      <TabsList className="flex flex-wrap h-auto justify-start">
        {tabs.map((source) => (
          <TabsTrigger key={source} value={source}>
            {sourceLabel(source)}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((source) => {
        const entry = sources.find((s) => s.source === source);
        return (
          <TabsContent key={source} value={source} className="pt-6">
            {entry && entry.stats.length > 0 ? (
              <StatGrid stats={entry.stats} />
            ) : (
              <div className="h-[200px] flex flex-col items-center justify-center gap-2 text-muted-foreground">
                <Lock className="w-6 h-6" />
                <p className="font-medium">No {sourceLabel(source)} stats for this player</p>
                <p className="text-xs">
                  This source may not be entitled or ingested yet.
                </p>
              </div>
            )}
          </TabsContent>
        );
      })}
    </Tabs>
  );
}
