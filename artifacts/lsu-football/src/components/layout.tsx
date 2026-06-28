import { Link, useLocation } from "wouter";
import { Database, Users, Shield, RefreshCw } from "lucide-react";
import { useGlobalFilters } from "@/hooks/use-global-filters";
import { useGetFilters } from "@workspace/api-client-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";

interface LayoutProps {
  children: React.ReactNode;
}

export function Layout({ children }: LayoutProps) {
  const [location] = useLocation();
  const { season, team, setSeason, setTeam } = useGlobalFilters();
  const { data: filters, isLoading } = useGetFilters();

  const navItems = [
    { href: "/", label: "Dashboard", icon: Database },
    { href: "/players", label: "Players", icon: Users },
    { href: "/teams", label: "Teams", icon: Shield },
    { href: "/sync", label: "Data Sync", icon: RefreshCw },
  ];

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col md:flex-row">
      <aside className="w-full md:w-64 bg-sidebar border-r border-sidebar-border flex flex-col">
        <div className="p-6">
          <Link href="/">
            <div className="flex items-center gap-3 cursor-pointer">
              <div className="w-8 h-8 bg-secondary rounded flex items-center justify-center font-bold text-secondary-foreground">
                LSU
              </div>
              <h1 className="text-xl font-black text-sidebar-foreground tracking-tight">SCOUT<span className="text-secondary">PRO</span></h1>
            </div>
          </Link>
        </div>

        <div className="px-6 pb-4 border-b border-sidebar-border/50">
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-sidebar-foreground/70 uppercase tracking-wider">Season</label>
              {isLoading ? <Skeleton className="h-9 w-full bg-sidebar-accent" /> : (
                <Select value={season?.toString()} onValueChange={(v) => setSeason(v === "all" ? undefined : parseInt(v, 10))}>
                  <SelectTrigger className="w-full bg-sidebar-accent border-sidebar-border text-sidebar-foreground">
                    <SelectValue placeholder="All Seasons" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Seasons</SelectItem>
                    {filters?.seasons?.map(s => (
                      <SelectItem key={s} value={s.toString()}>{s}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-sidebar-foreground/70 uppercase tracking-wider">Team</label>
              {isLoading ? <Skeleton className="h-9 w-full bg-sidebar-accent" /> : (
                <Select value={team || "all"} onValueChange={(v) => setTeam(v === "all" ? undefined : v)}>
                  <SelectTrigger className="w-full bg-sidebar-accent border-sidebar-border text-sidebar-foreground">
                    <SelectValue placeholder="All Teams" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Teams</SelectItem>
                    {filters?.teams?.map(t => (
                      <SelectItem key={t} value={t}>{t}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          </div>
        </div>

        <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
          {navItems.map((item) => {
            const isActive = location === item.href || (item.href !== "/" && location.startsWith(item.href));
            return (
              <Link key={item.href} href={item.href}>
                <div className={`flex items-center gap-3 px-3 py-2.5 rounded-md cursor-pointer transition-colors ${isActive ? 'bg-sidebar-primary text-sidebar-primary-foreground font-semibold shadow-sm' : 'text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-foreground'}`}>
                  <item.icon className="w-5 h-5" />
                  <span>{item.label}</span>
                </div>
              </Link>
            );
          })}
        </nav>
      </aside>
      <main className="flex-1 overflow-y-auto bg-muted/20">
        {children}
      </main>
    </div>
  );
}
