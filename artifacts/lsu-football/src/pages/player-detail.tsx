import { useRoute, Link } from "wouter";
import { useGetPlayer, getGetPlayerQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, User, Shield } from "lucide-react";
import { PlayerStatsTabs } from "@/components/player-stats-tabs";

export function PlayerDetail() {
  const [, params] = useRoute("/players/:playerId");
  const playerId = params?.playerId || "";

  const { data: player, isLoading } = useGetPlayer(playerId, {
    query: {
      enabled: !!playerId,
      queryKey: getGetPlayerQueryKey(playerId)
    }
  });

  if (isLoading) {
    return (
      <div className="p-6 md:p-8 space-y-6 max-w-7xl mx-auto">
        <div className="flex items-center gap-4">
          <Skeleton className="w-12 h-12 rounded-full" />
          <div>
            <Skeleton className="w-48 h-8 mb-2" />
            <Skeleton className="w-32 h-4" />
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (!player) {
    return (
      <div className="p-6 md:p-8 text-center">
        <h2 className="text-2xl font-bold text-muted-foreground">Player not found</h2>
        <Link href="/players" className="text-primary hover:underline mt-4 inline-block">Return to Player Explorer</Link>
      </div>
    );
  }

  return (
    <div className="p-6 md:p-8 space-y-8 max-w-7xl mx-auto">
      <Link href="/players">
        <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground cursor-pointer transition-colors w-fit">
          <ArrowLeft className="w-4 h-4" /> Back to Players
        </div>
      </Link>

      <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-6 bg-card border border-border p-6 rounded-xl shadow-sm">
        <div className="flex items-center gap-6">
          {player.photoUrl ? (
            <img
              src={player.photoUrl}
              alt={player.playerName}
              loading="lazy"
              className="w-24 h-24 rounded-full object-cover border-4 border-card shadow-sm bg-muted"
            />
          ) : (
            <div className="w-24 h-24 bg-primary/10 text-primary rounded-full flex items-center justify-center font-black text-4xl border-4 border-card shadow-sm">
              {player.jersey ? `#${player.jersey}` : <User className="w-10 h-10" />}
            </div>
          )}
          <div>
            <h1 className="text-4xl font-black tracking-tight">
              {player.playerName}
            </h1>
            <div className="flex items-center gap-4 mt-2 text-lg text-muted-foreground font-medium">
              <span className="flex items-center gap-1"><Shield className="w-4 h-4" /> {player.position}</span>
              <span>•</span>
              <Link href={`/teams/${encodeURIComponent(player.team || '')}`}>
                <span className="hover:text-primary cursor-pointer transition-colors">{player.team || 'Unknown Team'}</span>
              </Link>
              <span>•</span>
              <span>Class of {player.season}</span>
            </div>
          </div>
        </div>
        
        <div className="grid grid-cols-2 gap-4 w-full md:w-auto text-right">
          <div>
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Snaps</div>
            <div className="text-2xl font-black">{((player.snapsNonSt || 0) + (player.snapsSt || 0)) || '-'}</div>
          </div>
          <div>
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Season</div>
            <div className="text-2xl font-black">{player.season}</div>
          </div>
        </div>
      </div>

      <Card className="shadow-sm border-border">
        <CardHeader>
          <CardTitle>Raw Stats</CardTitle>
          <CardDescription>Per-source raw measurements and stat lines</CardDescription>
        </CardHeader>
        <CardContent>
          <PlayerStatsTabs playerId={playerId} />
        </CardContent>
      </Card>
    </div>
  );
}
