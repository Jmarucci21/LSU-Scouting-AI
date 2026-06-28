import { useState } from "react";
import { useGlobalFilters } from "@/hooks/use-global-filters";
import { useListPlayers, useGetFilters } from "@workspace/api-client-react";
import type { ListPlayersSort, ListPlayersOrder } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Search, ChevronDown, ChevronUp } from "lucide-react";
import { Link } from "wouter";
import { useDebounce } from "@/hooks/use-debounce";

export function PlayersExplorer() {
  const { season, team } = useGlobalFilters();
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 300);
  
  const [posGroup, setPosGroup] = useState<string | undefined>();
  const [sort, setSort] = useState<ListPlayersSort>("war");
  const [order, setOrder] = useState<ListPlayersOrder>("desc");
  const [page, setPage] = useState(1);
  const pageSize = 50;

  const { data: filters } = useGetFilters();
  const { data: listData, isLoading } = useListPlayers({
    season,
    team,
    search: debouncedSearch || undefined,
    posGroup,
    sort,
    order,
    page,
    pageSize
  });

  const toggleSort = (newSort: ListPlayersSort) => {
    if (sort === newSort) {
      setOrder(order === "desc" ? "asc" : "desc");
    } else {
      setSort(newSort);
      setOrder("desc");
    }
    setPage(1);
  };

  const renderSortIcon = (column: ListPlayersSort) => {
    if (sort !== column) return null;
    return order === "desc" ? <ChevronDown className="w-4 h-4 inline" /> : <ChevronUp className="w-4 h-4 inline" />;
  };

  return (
    <div className="p-6 md:p-8 space-y-6 max-w-7xl mx-auto flex flex-col h-[calc(100vh-2rem)]">
      <header>
        <h1 className="text-3xl font-black tracking-tight">Player Explorer</h1>
      </header>

      <div className="flex flex-col md:flex-row gap-4 items-center bg-card p-4 rounded-lg border border-border shadow-sm">
        <div className="relative flex-1 w-full">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground w-4 h-4" />
          <Input 
            placeholder="Search players..." 
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            className="pl-9 bg-background"
          />
        </div>
        
        <div className="w-full md:w-64">
          <Select value={posGroup || "all"} onValueChange={(v) => { setPosGroup(v === "all" ? undefined : v); setPage(1); }}>
            <SelectTrigger className="bg-background">
              <SelectValue placeholder="All Position Groups" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Pos Groups</SelectItem>
              {filters?.posGroups?.map(pg => (
                <SelectItem key={pg} value={pg}>{pg}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <Card className="flex-1 overflow-hidden shadow-sm flex flex-col border-border">
        <div className="overflow-x-auto flex-1">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-muted-foreground text-sm uppercase tracking-wider">
                <th className="p-4 font-semibold cursor-pointer hover:bg-muted" onClick={() => toggleSort("name")}>Player {renderSortIcon("name")}</th>
                <th className="p-4 font-semibold">Pos</th>
                <th className="p-4 font-semibold">Team</th>
                <th className="p-4 font-semibold text-right cursor-pointer hover:bg-muted" onClick={() => toggleSort("snaps")}>Snaps {renderSortIcon("snaps")}</th>
                <th className="p-4 font-semibold text-right cursor-pointer hover:bg-muted" onClick={() => toggleSort("war")}>WAR {renderSortIcon("war")}</th>
                <th className="p-4 font-semibold text-right cursor-pointer hover:bg-muted" onClick={() => toggleSort("twar")}>TWAR {renderSortIcon("twar")}</th>
                <th className="p-4 font-semibold text-right cursor-pointer hover:bg-muted" onClick={() => toggleSort("player_value")}>Value {renderSortIcon("player_value")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {isLoading ? (
                Array.from({ length: 10 }).map((_, i) => (
                  <tr key={i}>
                    <td className="p-4"><Skeleton className="h-6 w-32" /></td>
                    <td className="p-4"><Skeleton className="h-6 w-12" /></td>
                    <td className="p-4"><Skeleton className="h-6 w-24" /></td>
                    <td className="p-4"><Skeleton className="h-6 w-12 ml-auto" /></td>
                    <td className="p-4"><Skeleton className="h-6 w-16 ml-auto" /></td>
                    <td className="p-4"><Skeleton className="h-6 w-16 ml-auto" /></td>
                    <td className="p-4"><Skeleton className="h-6 w-16 ml-auto" /></td>
                  </tr>
                ))
              ) : listData?.players?.length === 0 ? (
                <tr>
                  <td colSpan={7} className="p-8 text-center text-muted-foreground">No players found matching your criteria.</td>
                </tr>
              ) : (
                listData?.players?.map((player) => (
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
                    <td className="p-4 text-sm text-muted-foreground">{player.team}</td>
                    <td className="p-4 text-sm text-right">{((player.snapsNonSt || 0) + (player.snapsSt || 0)) || '-'}</td>
                    <td className="p-4 text-sm font-bold text-right">{player.war?.toFixed(2) || '-'}</td>
                    <td className="p-4 text-sm font-semibold text-right text-muted-foreground">{player.twar?.toFixed(2) || '-'}</td>
                    <td className="p-4 text-sm font-semibold text-right text-muted-foreground">{player.playerValue?.toFixed(2) || '-'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        
        {listData && listData.total > 0 && (
          <div className="p-4 border-t border-border flex items-center justify-between bg-card text-sm text-muted-foreground">
            <div>
              Showing <span className="font-medium text-foreground">{(page - 1) * pageSize + 1}</span> to <span className="font-medium text-foreground">{Math.min(page * pageSize, listData.total)}</span> of <span className="font-medium text-foreground">{listData.total}</span>
            </div>
            <div className="flex gap-2">
              <Button 
                variant="outline" 
                size="sm" 
                disabled={page === 1}
                onClick={() => setPage(p => p - 1)}
              >
                Previous
              </Button>
              <Button 
                variant="outline" 
                size="sm" 
                disabled={page * pageSize >= listData.total}
                onClick={() => setPage(p => p + 1)}
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
