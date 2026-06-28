import { useGlobalFilters } from "@/hooks/use-global-filters";
import { useGetDashboardSummary, useGetPositionGroups } from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Users, Shield, BarChart3 } from "lucide-react";
import { Link } from "wouter";

export function Dashboard() {
  const { season, team } = useGlobalFilters();
  
  const { data: summary, isLoading: loadingSummary } = useGetDashboardSummary({ season, team });
  const { data: posGroups, isLoading: loadingPosGroups } = useGetPositionGroups({ season, team });

  return (
    <div className="p-6 md:p-8 space-y-8 max-w-7xl mx-auto">
      <header>
        <h1 className="text-3xl font-black tracking-tight text-foreground">Overview</h1>
        <p className="text-muted-foreground mt-1 text-lg">
          {team || "All Teams"} {season ? `• ${season} Season` : "• All Seasons"}
        </p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <StatCard 
          title="Total Players" 
          value={summary?.totalPlayers} 
          icon={Users} 
          loading={loadingSummary} 
        />
        <StatCard 
          title="Total Teams" 
          value={summary?.totalTeams} 
          icon={Shield} 
          loading={loadingSummary} 
        />
        <Link href="/stats">
          <StatCard 
            title="Explore Raw Stats" 
            value="Open" 
            icon={BarChart3} 
            loading={false} 
          />
        </Link>
      </div>

      <Card className="shadow-sm border-border">
        <CardHeader>
          <CardTitle>Position Groups</CardTitle>
          <CardDescription>Player counts by unit</CardDescription>
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
              {posGroups.slice().sort((a,b) => (b.count || 0) - (a.count || 0)).map((pg) => (
                <div key={pg.posGroup} className="flex justify-between items-center py-3 px-6 hover:bg-muted/50 transition-colors">
                  <div className="font-semibold">{pg.posGroup}</div>
                  <div className="text-right">
                    <div className="font-bold text-primary">{pg.count}</div>
                    <div className="text-xs text-muted-foreground">players</div>
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
