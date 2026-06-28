import { useEffect, useRef } from "react";
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

  const { data: status, isLoading } = useGetSyncStatus({
    query: {
      queryKey: getGetSyncStatusQueryKey(),
      refetchInterval: (query) => (query.state.data?.running ? 2000 : false),
    },
  });
  const runSync = useRunSync();

  const isRunning = !!status?.running || runSync.isPending;
  const progress = status?.progress;
  const pct = progress && progress.total > 0
    ? Math.min(100, Math.round((progress.processed / progress.total) * 100))
    : 0;

  // Detect the running -> finished transition and refresh all data-backed views.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !status?.running) {
      queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetTopPlayersQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetPositionGroupsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListPlayersQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListTeamsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetFiltersQueryKey() });
      toast({
        title: status?.status === "error" ? "Sync failed" : "Sync completed",
        description: status?.message || `Synced ${status?.playersSynced ?? 0} players and ${status?.teamsSynced ?? 0} teams.`,
        variant: status?.status === "error" ? "destructive" : undefined,
      });
    }
    wasRunning.current = !!status?.running;
  }, [status?.running, status?.status, status?.message, status?.playersSynced, status?.teamsSynced, queryClient, toast]);

  const handleSync = () => {
    runSync.mutate({}, {
      onSuccess: () => {
        // Sync runs in the background; begin polling for progress.
        queryClient.invalidateQueries({ queryKey: getGetSyncStatusQueryKey() });
        toast({
          title: "Sync started",
          description: "Pulling all of college football. This runs in the background and may take a few minutes.",
        });
      },
      onError: (error: any) => {
        toast({
          title: "Could not start sync",
          description: error?.message || "An error occurred while starting data synchronization.",
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
          disabled={isRunning}
          className="gap-2 font-bold shadow-sm"
          size="lg"
        >
          <RefreshCw className={`w-4 h-4 ${isRunning ? 'animate-spin' : ''}`} />
          {isRunning ? "Syncing..." : "Run Full Sync"}
        </Button>
      </header>

      {isRunning && (
        <Card className="shadow-sm border-primary/30">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <RefreshCw className="w-5 h-5 text-primary animate-spin" /> Sync in Progress
            </CardTitle>
            <CardDescription>{progress?.phase || "Starting up..."}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <div className="h-3 w-full bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary transition-all duration-500"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <div className="flex justify-between text-sm font-medium text-muted-foreground">
                <span>
                  {progress
                    ? `${progress.processed.toLocaleString()} / ${progress.total.toLocaleString()}`
                    : "Preparing..."}
                </span>
                <span>{pct}%</span>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

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
                      {status.status === 'success' ? <CheckCircle2 className="w-5 h-5 text-green-500" /> : status.status === 'error' ? <XCircle className="w-5 h-5 text-red-500" /> : <AlertCircle className="w-5 h-5 text-amber-500" />}
                      <span className="font-bold capitalize">{status.running ? "running" : status.status}</span>
                    </div>
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-muted-foreground uppercase">Players</div>
                    <div className="text-2xl font-black text-primary">{(status.playersSynced || 0).toLocaleString()}</div>
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
