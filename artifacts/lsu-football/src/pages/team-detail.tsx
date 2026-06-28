import { useRoute, Link } from "wouter";
import { useGetTeam, getGetTeamQueryKey } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, Shield, MapPin, Users } from "lucide-react";

export function TeamDetail() {
  const [, params] = useRoute("/teams/:school");
  const school = params?.school ? decodeURIComponent(params.school) : "";

  const { data: teamData, isLoading } = useGetTeam(school, {
    query: {
      enabled: !!school,
      queryKey: getGetTeamQueryKey(school)
    }
  });

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

  const { team, roster } = teamData;

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
            <span className="flex items-center gap-1"><Users className="w-4 h-4" /> {roster.length} Players</span>
          </div>
        </div>
      </div>

      <Card className="flex-1 overflow-hidden shadow-sm flex flex-col border-border">
        <div className="p-4 border-b border-border bg-muted/30">
          <h3 className="font-bold text-lg">Team Roster</h3>
        </div>
        <div className="overflow-x-auto flex-1">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-muted-foreground text-sm uppercase tracking-wider">
                <th className="p-4 font-semibold">Player</th>
                <th className="p-4 font-semibold">Pos</th>
                <th className="p-4 font-semibold text-right">Snaps</th>
                <th className="p-4 font-semibold text-right">PPA/play</th>
                <th className="p-4 font-semibold text-right">Total PPA</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {roster.length === 0 ? (
                <tr>
                  <td colSpan={5} className="p-8 text-center text-muted-foreground">No players found for this team.</td>
                </tr>
              ) : (
                roster.sort((a,b) => (b.war || 0) - (a.war || 0)).map((player) => (
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
                    <td className="p-4 text-sm font-bold text-right">{player.war?.toFixed(2) || '-'}</td>
                    <td className="p-4 text-sm font-semibold text-right text-muted-foreground">{player.playerValue?.toFixed(2) || '-'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
