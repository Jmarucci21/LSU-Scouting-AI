import { useState } from "react";
import { useRoute, Link } from "wouter";
import {
  useGetTeam,
  getGetTeamQueryKey,
  useListPlayers,
  getListPlayersQueryKey,
} from "@workspace/api-client-react";
import type { ListPlayersSort, ListPlayersOrder } from "@workspace/api-client-react";
import { useGlobalFilters } from "@/hooks/use-global-filters";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { StatsExplorer } from "@/components/stats-explorer";
import { SortableHeader } from "@/components/sortable-header";
import { ArrowLeft, Shield, MapPin, Users } from "lucide-react";

export function TeamDetail() {
  const [, params] = useRoute("/teams/:school");
  const school = params?.school ? decodeURIComponent(params.school) : "";
  const { season } = useGlobalFilters();

  const [sort, setSort] = useState<ListPlayersSort>("snaps");
  const [order, setOrder] = useState<ListPlayersOrder>("desc");
  const [page, setPage] = useState(1);
  const pageSize = 50;

  // Toggle direction on the active column, otherwise switch to it with a
  // sensible default (text columns A→Z, numeric columns high→low).
  const toggleSort = (newSort: ListPlayersSort) => {
    if (sort === newSort) {
      setOrder(order === "desc" ? "asc" : "desc");
    } else {
      setSort(newSort);
      setOrder(newSort === "snaps" ? "desc" : "asc");
    }
    setPage(1);
  };

  const { data: teamData, isLoading } = useGetTeam(school, {
    query: {
      enabled: !!school,
      queryKey: getGetTeamQueryKey(school)
    }
  });

  const rosterParams = { team: school, season, sort, order, page, pageSize };
  const { data: rosterData, isLoading: rosterLoading } = useListPlayers(
    rosterParams,
    {
      query: {
        enabled: !!school,
        queryKey: getListPlayersQueryKey(rosterParams),
      },
    },
  );
  const roster = rosterData?.players ?? [];
  const rosterTotal = rosterData?.total ?? 0;

  if (isLoading) {
    return (
      <div className="p-6 md:p-8 space-y-6 max-w-7xl mx-auto">
        <div className="flex items-center gap-4">
          <Skeleton className="w-24 h-24 rounded-xl" />
          <div>
            <Skeleton className="w-64 h-10 mb-2" />
            <Skeleton className="w-48 h-5" />
          </div>
        </div>
        <Skeleton className="h-96 w-full mt-8" />
      </div>
    );
  }

  if (!teamData) {
    return (
      <div className="p-6 md:p-8 text-center">
        <h2 className="text-2xl font-bold text-muted-foreground">Team not found</h2>
        <Link href="/teams" className="text-primary hover:underline mt-4 inline-block">Return to Teams Directory</Link>
      </div>
    );
  }

  const { team } = teamData;

  return (
    <div className="p-6 md:p-8 space-y-8 max-w-7xl mx-auto flex flex-col h-[calc(100vh-2rem)]">
      <Link href="/teams">
        <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground cursor-pointer transition-colors w-fit">
          <ArrowLeft className="w-4 h-4" /> Back to Teams
        </div>
      </Link>

      <div className="flex flex-col md:flex-row gap-6 items-start md:items-center bg-card border border-border p-6 rounded-xl shadow-sm relative overflow-hidden">
        <div 
          className="absolute top-0 left-0 w-2 h-full" 
          style={{ backgroundColor: team.color || 'hsl(var(--primary))' }} 
        />
        <div className="w-24 h-24 bg-white rounded-xl flex items-center justify-center p-3 shadow-sm border border-border flex-shrink-0 z-10 ml-4">
          {team.logo ? (
            <img src={team.logo} alt={`${team.school} logo`} className="w-full h-full object-contain" />
          ) : (
            <Shield className="w-12 h-12 text-muted-foreground" />
          )}
        </div>
        <div className="z-10 flex-1">
          <h1 className="text-4xl font-black tracking-tight">{team.school} {team.mascot}</h1>
          <div className="flex flex-wrap items-center gap-4 mt-3 text-sm font-medium text-muted-foreground">
            {team.conference && <span className="bg-muted px-2.5 py-1 rounded-md">{team.conference}</span>}
            {team.classification && <span>{team.classification}</span>}
            {(team.city || team.state) && (
              <span className="flex items-center gap-1"><MapPin className="w-4 h-4" /> {team.city}{team.city && team.state ? ', ' : ''}{team.state}</span>
            )}
            <span className="flex items-center gap-1"><Users className="w-4 h-4" /> {rosterTotal} Players</span>
          </div>
        </div>
      </div>

      <Tabs defaultValue="roster" className="flex-1 flex flex-col min-h-0">
        <TabsList className="w-fit">
          <TabsTrigger value="roster">Roster</TabsTrigger>
          <TabsTrigger value="stats">Raw Stats</TabsTrigger>
        </TabsList>

        <TabsContent value="roster" className="flex-1 min-h-0 mt-4">
          <Card className="h-full overflow-hidden shadow-sm flex flex-col border-border">
            <div className="p-4 border-b border-border bg-muted/30 flex items-center justify-between gap-3">
              <h3 className="font-bold text-lg">Team Roster</h3>
              <span className="text-sm font-semibold text-muted-foreground bg-muted px-2.5 py-1 rounded-md whitespace-nowrap">
                {season} Roster
              </span>
            </div>
            <div className="overflow-x-auto flex-1">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-border bg-muted/50 text-muted-foreground text-sm uppercase tracking-wider">
                    <SortableHeader
                      label="Player"
                      active={sort === "name"}
                      order={order}
                      onClick={() => toggleSort("name")}
                    />
                    <SortableHeader
                      label="Pos"
                      active={sort === "position"}
                      order={order}
                      onClick={() => toggleSort("position")}
                    />
                    <SortableHeader
                      label="Snaps"
                      align="right"
                      active={sort === "snaps"}
                      order={order}
                      onClick={() => toggleSort("snaps")}
                    />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rosterLoading ? (
                    Array.from({ length: 10 }).map((_, i) => (
                      <tr key={i}>
                        <td className="p-4"><Skeleton className="h-6 w-32" /></td>
                        <td className="p-4"><Skeleton className="h-6 w-12" /></td>
                        <td className="p-4"><Skeleton className="h-6 w-12 ml-auto" /></td>
                      </tr>
                    ))
                  ) : roster.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="p-8 text-center text-muted-foreground">No players found for this team.</td>
                    </tr>
                  ) : (
                    roster.map((player) => (
                      <tr key={`${player.playerId}-${player.season}`} className="hover:bg-muted/30 transition-colors group">
                        <td className="p-4">
                          <Link href={`/players/${player.playerId}`}>
                            <div className="font-bold text-foreground group-hover:text-primary cursor-pointer">
                              {player.playerName}
                              <span className="text-xs text-muted-foreground font-normal ml-2">#{player.jersey || '-'}</span>
                            </div>
                          </Link>
                        </td>
                        <td className="p-4 text-sm font-medium">{player.position}</td>
                        <td className="p-4 text-sm text-right">{((player.snapsNonSt || 0) + (player.snapsSt || 0)) || '-'}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {rosterTotal > 0 && (
              <div className="p-4 border-t border-border flex items-center justify-between bg-card text-sm text-muted-foreground">
                <div>
                  Showing <span className="font-medium text-foreground">{(page - 1) * pageSize + 1}</span> to <span className="font-medium text-foreground">{Math.min(page * pageSize, rosterTotal)}</span> of <span className="font-medium text-foreground">{rosterTotal}</span>
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
                    disabled={page * pageSize >= rosterTotal}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </Card>
        </TabsContent>

        <TabsContent value="stats" className="flex-1 min-h-0 mt-4 flex flex-col">
          <StatsExplorer fixedTeam={team.school} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
