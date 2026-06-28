import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Layout } from "@/components/layout";
import { Dashboard } from "@/pages/dashboard";
import { PlayersExplorer } from "@/pages/players-explorer";
import { PlayerDetail } from "@/pages/player-detail";
import { Teams } from "@/pages/teams";
import { TeamDetail } from "@/pages/team-detail";
import { StatsExplorerPage } from "@/pages/stats-explorer";
import { SyncAdmin } from "@/pages/sync-admin";
import NotFound from "@/pages/not-found";

const queryClient = new QueryClient();

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/players" component={PlayersExplorer} />
        <Route path="/players/:playerId" component={PlayerDetail} />
        <Route path="/teams" component={Teams} />
        <Route path="/teams/:school" component={TeamDetail} />
        <Route path="/stats" component={StatsExplorerPage} />
        <Route path="/sync" component={SyncAdmin} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
