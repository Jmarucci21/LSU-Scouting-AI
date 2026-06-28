import { useGetSyncStatus, useRunSync, getGetSyncStatusQueryKey, getGetDashboardSummaryQueryKey, getGetTopPlayersQueryKey, getGetPositionGroupsQueryKey, getListPlayersQueryKey, getListTeamsQueryKey, getGetFiltersQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Database, RefreshCw, CheckCircle2, XCircle, AlertCircle } from "lucide-react";
import { format } from "date-fns";

export function SyncAdmin() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  const { data: status, isLoading } = useGetSyncStatus();
  const runSync = useRunSync();

  const handleSync = () => {
    runSync.mutate({}, {
      onSuccess: (data) => {
        toast({
          title: "Sync completed",
          description: data.message || `Synced ${data.playersSynced} players and ${data.teamsSynced} teams.`,
        });
        
        // Invalidate all related queries to refresh the UI
        queryClient.invalidateQueries({ queryKey: getGetSyncStatusQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetTopPlayersQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetPositionGroupsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListPlayersQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListTeamsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetFiltersQueryKey() });
      },
      onError: (error: any) => {
        toast({
          title: "Sync failed",
          description: error.message || "An error occurred during data synchronization.",
          variant: "destructive",
        });
      }
    });
  };

  return (
    <div className="p-6 md:p-8 space-y-8 max-w-5xl mx-auto">
      <header className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-3xl font-black tracking-tight">Data Synchronization</h1>
          <p className="text-muted-foreground mt-1">Manage external scouting data imports</p>
        </div>
        <Button 
          onClick={handleSync} 
          disabled={runSync.isPending}
          className="gap-2 font-bold shadow-sm"
          size="lg"
        >
          <RefreshCw className={`w-4 h-4 ${runSync.isPending ? 'animate-spin' : ''}`} />
          {runSync.isPending ? "Syncing..." : "Run Full Sync"}
        </Button>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card className="md:col-span-2 shadow-sm border-border">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Database className="w-5 h-5 text-primary" /> Sync Status</CardTitle>
            <CardDescription>Overview of the most recent synchronization</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-4">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-3/4" />
                <Skeleton className="h-8 w-5/6" />
              </div>
            ) : status ? (
              <div className="space-y-6">
                <div className="grid grid-cols-2 gap-4 bg-muted/30 p-4 rounded-lg border border-border">
                  <div>
                    <div className="text-sm font-semibold text-muted-foreground uppercase">Last Sync</div>
                    <div className="text-lg font-bold">
                      {status.lastSyncAt ? format(new Date(status.lastSyncAt), "MMM d, yyyy 'at' h:mm a") : "Never"}
                    </div>
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-muted-foreground uppercase">Status</div>
                    <div className="flex items-center gap-1.5 mt-1">
                      {status.status === 'success' ? <CheckCircle2 className="w-5 h-5 text-green-500" /> : <AlertCircle className="w-5 h-5 text-amber-500" />}
                      <span className="font-bold capitalize">{status.status}</span>
                    </div>
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-muted-foreground uppercase">Players</div>
                    <div className="text-2xl font-black text-primary">{status.playersSynced || 0}</div>
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-muted-foreground uppercase">Teams</div>
                    <div className="text-2xl font-black text-primary">{status.teamsSynced || 0}</div>
                  </div>
                </div>
                
                {status.message && (
                  <div className="p-4 bg-primary/10 text-primary-foreground border border-primary/20 rounded-md text-sm font-medium">
                    {status.message}
                  </div>
                )}
              </div>
            ) : (
              <div className="text-center text-muted-foreground py-8">No sync history available.</div>
            )}
          </CardContent>
        </Card>

        <Card className="shadow-sm border-border">
          <CardHeader>
            <CardTitle>Data Sources</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-3">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            ) : status?.sources ? (
              <div className="space-y-3">
                {status.sources.map((source, idx) => (
                  <div key={idx} className="flex items-center justify-between p-3 border border-border rounded-md bg-card">
                    <div className="font-semibold">{source.name}</div>
                    <div>
                      {!source.configured ? (
                        <span className="text-xs font-medium text-muted-foreground bg-muted px-2 py-1 rounded">Not Configured</span>
                      ) : source.ok ? (
                        <span className="flex items-center gap-1 text-xs font-bold text-green-600 bg-green-500/10 px-2 py-1 rounded">
                          <CheckCircle2 className="w-3.5 h-3.5" /> OK
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-xs font-bold text-red-600 bg-red-500/10 px-2 py-1 rounded">
                          <XCircle className="w-3.5 h-3.5" /> Error
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">No data sources configured.</div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
