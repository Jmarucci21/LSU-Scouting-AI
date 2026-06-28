import { useRoute, Link } from "wouter";
import { useGetPlayer, getGetPlayerQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell, Radar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis } from "recharts";
import { ArrowLeft, User, Shield, Activity, Star } from "lucide-react";
import { Badge } from "@/components/ui/badge";

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

  const categoryGrades = player.grades?.reduce((acc: any, grade) => {
    const cat = grade.category || "General";
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(grade);
    return acc;
  }, {});

  const radarData = player.grades?.filter(g => g.category !== "General").map(g => ({
    subject: g.label,
    A: g.value,
    fullMark: 100,
  })) || [];

  return (
    <div className="p-6 md:p-8 space-y-8 max-w-7xl mx-auto">
      <Link href="/players">
        <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground cursor-pointer transition-colors w-fit">
          <ArrowLeft className="w-4 h-4" /> Back to Players
        </div>
      </Link>

      <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-6 bg-card border border-border p-6 rounded-xl shadow-sm">
        <div className="flex items-center gap-6">
          <div className="w-24 h-24 bg-primary/10 text-primary rounded-full flex items-center justify-center font-black text-4xl border-4 border-card shadow-sm">
            {player.jersey ? `#${player.jersey}` : <User className="w-10 h-10" />}
          </div>
          <div>
            <h1 className="text-4xl font-black tracking-tight flex items-center gap-3">
              {player.playerName}
              {player.playerTier && (
                <Badge variant="secondary" className="text-xs uppercase bg-secondary/20 text-secondary border-secondary/30">
                  {player.playerTier} Tier
                </Badge>
              )}
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
        
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 w-full md:w-auto text-right">
          <div>
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">WAR</div>
            <div className="text-2xl font-black">{player.war?.toFixed(2) || '-'}</div>
          </div>
          <div>
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">TWAR</div>
            <div className="text-2xl font-black text-primary">{player.twar?.toFixed(2) || '-'}</div>
          </div>
          <div>
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Value</div>
            <div className="text-2xl font-black">{player.playerValue?.toFixed(1) || '-'}</div>
          </div>
          <div>
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Snaps</div>
            <div className="text-2xl font-black">{((player.snapsNonSt || 0) + (player.snapsSt || 0)) || '-'}</div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-1 shadow-sm border-border">
          <CardHeader>
            <CardTitle>Grade Overview</CardTitle>
          </CardHeader>
          <CardContent className="flex justify-center h-[350px]">
            {radarData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <RadarChart cx="50%" cy="50%" outerRadius="70%" data={radarData}>
                  <PolarGrid stroke="hsl(var(--border))" />
                  <PolarAngleAxis dataKey="subject" tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11 }} />
                  <PolarRadiusAxis angle={30} domain={[0, 100]} tick={false} axisLine={false} />
                  <Radar name="Player" dataKey="A" stroke="hsl(var(--primary))" fill="hsl(var(--primary))" fillOpacity={0.4} />
                  <Tooltip 
                    contentStyle={{ backgroundColor: 'hsl(var(--card))', border: '1px solid hsl(var(--border))' }}
                    itemStyle={{ color: 'hsl(var(--foreground))' }}
                  />
                </RadarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center text-muted-foreground">No radar data</div>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2 shadow-sm border-border">
          <CardHeader>
            <CardTitle>Grade Breakdown</CardTitle>
            <CardDescription>Detailed scouting grades by category</CardDescription>
          </CardHeader>
          <CardContent>
            {categoryGrades && Object.keys(categoryGrades).length > 0 ? (
              <div className="space-y-8">
                {Object.entries(categoryGrades).map(([cat, grades]: [string, any]) => (
                  <div key={cat} className="space-y-3">
                    <h3 className="text-sm font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
                      <Activity className="w-4 h-4" /> {cat}
                    </h3>
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                      {grades.map((grade: any) => (
                        <div key={grade.key} className="bg-muted/30 p-3 rounded-md border border-border">
                          <div className="text-xs text-muted-foreground mb-1">{grade.label}</div>
                          <div className="flex items-end gap-2">
                            <span className="text-xl font-black">{grade.value.toFixed(1)}</span>
                            <div className="flex-1 mb-1">
                              <div className="h-1.5 w-full bg-border rounded-full overflow-hidden">
                                <div 
                                  className="h-full bg-primary transition-all" 
                                  style={{ width: `${Math.min(100, Math.max(0, grade.value))}%` }}
                                />
                              </div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="h-[300px] flex items-center justify-center text-muted-foreground">No detailed grades available</div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
