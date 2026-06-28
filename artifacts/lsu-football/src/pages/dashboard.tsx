import { useGlobalFilters } from "@/hooks/use-global-filters";
import { useGetDashboardSummary, useGetTopPlayers, useGetPositionGroups } from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell } from "recharts";
import { Users, Shield, TrendingUp, Trophy } from "lucide-react";
import { Link } from "wouter";

export function Dashboard() {
  const { season, team } = useGlobalFilters();
  
  const { data: summary, isLoading: loadingSummary } = useGetDashboardSummary({ season, team });
  const { data: topPlayers, isLoading: loadingTopPlayers } = useGetTopPlayers({ season, team, metric: 'war', limit: 10 });
  const { data: posGroups, isLoading: loadingPosGroups } = useGetPositionGroups({ season, team });

  return (
    <div className="p-6 md:p-8 space-y-8 max-w-7xl mx-auto">
      <header>
        <h1 className="text-3xl font-black tracking-tight text-foreground">Overview</h1>
        <p className="text-muted-foreground mt-1 text-lg">
          {team || "All Teams"} {season ? `• ${season} Season` : "• All Seasons"}
        </p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard 
          title="Total Players" 
          value={summary?.totalPlayers} 
          icon={Users} 
          loading={loadingSummary} 
        />
        <StatCard 
          title="Avg PPA" 
          value={summary?.avgWar?.toFixed(2)} 
          icon={TrendingUp} 
          loading={loadingSummary} 
        />
        <StatCard 
          title="Top Player PPA" 
          value={summary?.topPlayer?.war?.toFixed(2)} 
          subtext={summary?.topPlayer?.playerName}
          icon={Trophy} 
          loading={loadingSummary} 
        />
        <StatCard 
          title="Total Teams" 
          value={summary?.totalTeams} 
          icon={Shield} 
          loading={loadingSummary} 
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2 shadow-sm border-border">
          <CardHeader>
            <CardTitle>Top Players by PPA</CardTitle>
            <CardDescription>Highest Predicted Points Added for {season || "all time"}</CardDescription>
          </CardHeader>
          <CardContent>
            {loadingTopPlayers ? (
              <Skeleton className="w-full h-[300px]" />
            ) : topPlayers && topPlayers.length > 0 ? (
              <div className="h-[300px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={topPlayers} layout="vertical" margin={{ top: 5, right: 30, left: 40, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" horizontal={true} vertical={true} stroke="hsl(var(--border))" />
                    <XAxis type="number" stroke="hsl(var(--muted-foreground))" />
                    <YAxis dataKey="playerName" type="category" width={100} stroke="hsl(var(--muted-foreground))" tick={{fontSize: 12}} />
                    <Tooltip 
                      contentStyle={{ backgroundColor: 'hsl(var(--card))', border: '1px solid hsl(var(--border))' }}
                      itemStyle={{ color: 'hsl(var(--foreground))' }}
                      formatter={(value: number) => [value?.toFixed(2) || '-', 'PPA']}
                    />
                    <Bar dataKey="war" radius={[0, 4, 4, 0]}>
                      {topPlayers.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill="hsl(var(--primary))" />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="h-[300px] flex items-center justify-center text-muted-foreground">No data available</div>
            )}
          </CardContent>
        </Card>

        <Card className="shadow-sm border-border">
          <CardHeader>
            <CardTitle>Position Groups</CardTitle>
            <CardDescription>Average PPA by unit</CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            {loadingPosGroups ? (
              <div className="px-6 space-y-4">
                <Skeleton className="w-full h-12" />
                <Skeleton className="w-full h-12" />
                <Skeleton className="w-full h-12" />
              </div>
            ) : posGroups && posGroups.length > 0 ? (
              <div className="divide-y border-t border-border">
                {posGroups.slice().sort((a,b) => (b.avgWar || 0) - (a.avgWar || 0)).map((pg) => (
                  <div key={pg.posGroup} className="flex justify-between items-center py-3 px-6 hover:bg-muted/50 transition-colors">
                    <div>
                      <div className="font-semibold">{pg.posGroup}</div>
                      <div className="text-xs text-muted-foreground">{pg.count} players</div>
                    </div>
                    <div className="text-right">
                      <div className="font-bold text-primary">{pg.avgWar?.toFixed(2) || '-'}</div>
                      <div className="text-xs text-muted-foreground">Avg PPA</div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-6 text-center text-muted-foreground">No data available</div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function StatCard({ title, value, subtext, icon: Icon, loading }: { title: string, value: React.ReactNode, subtext?: React.ReactNode, icon: any, loading: boolean }) {
  return (
    <Card className="shadow-sm border-border">
      <CardContent className="p-6 flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-muted-foreground uppercase tracking-wider">{title}</p>
          {loading ? (
            <Skeleton className="h-8 w-24 mt-2" />
          ) : (
            <div className="mt-1 flex items-baseline gap-2">
              <p className="text-3xl font-black">{value || '-'}</p>
              {subtext && <p className="text-sm font-medium text-muted-foreground">{subtext}</p>}
            </div>
          )}
        </div>
        <div className="h-12 w-12 bg-primary/10 rounded-full flex items-center justify-center">
          <Icon className="h-6 w-6 text-primary" />
        </div>
      </CardContent>
    </Card>
  );
}
