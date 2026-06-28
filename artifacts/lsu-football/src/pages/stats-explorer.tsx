import { StatsExplorer } from "@/components/stats-explorer";

export function StatsExplorerPage() {
  return (
    <div className="p-6 md:p-8 space-y-6 max-w-7xl mx-auto flex flex-col h-[calc(100vh-2rem)]">
      <header>
        <h1 className="text-3xl font-black tracking-tight">Stats Explorer</h1>
        <p className="text-muted-foreground mt-1">
          Raw per-source player stats across all of college football.
        </p>
      </header>
      <StatsExplorer />
    </div>
  );
}
