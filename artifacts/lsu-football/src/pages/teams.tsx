import { useState } from "react";
import { useListTeams, useGetFilters } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Search, Shield, Users } from "lucide-react";
import { Link } from "wouter";
import { useDebounce } from "@/hooks/use-debounce";

export function Teams() {
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 300);
  const [conference, setConference] = useState<string | undefined>();
  
  const { data: filters } = useGetFilters();
  const { data: teams, isLoading } = useListTeams({
    conference: conference
  });

  const filteredTeams = teams?.filter(t => 
    !debouncedSearch || 
    t.school.toLowerCase().includes(debouncedSearch.toLowerCase()) ||
    t.mascot?.toLowerCase().includes(debouncedSearch.toLowerCase())
  );

  return (
    <div className="p-6 md:p-8 space-y-6 max-w-7xl mx-auto flex flex-col h-[calc(100vh-2rem)]">
      <header>
        <h1 className="text-3xl font-black tracking-tight">Teams Directory</h1>
      </header>

      <div className="flex flex-col md:flex-row gap-4 items-center bg-card p-4 rounded-lg border border-border shadow-sm">
        <div className="relative flex-1 w-full">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground w-4 h-4" />
          <Input 
            placeholder="Search teams..." 
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 bg-background"
          />
        </div>
        
        <div className="w-full md:w-64">
          <Select value={conference || "all"} onValueChange={(v) => setConference(v === "all" ? undefined : v)}>
            <SelectTrigger className="bg-background">
              <SelectValue placeholder="All Conferences" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Conferences</SelectItem>
              {filters?.conferences?.map(c => (
                <SelectItem key={c} value={c}>{c}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto pr-2 pb-8">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {isLoading ? (
            Array.from({ length: 12 }).map((_, i) => (
              <Card key={i} className="shadow-sm border-border">
                <CardContent className="p-6">
                  <div className="flex items-center gap-4">
                    <Skeleton className="w-12 h-12 rounded-full" />
                    <div className="space-y-2">
                      <Skeleton className="h-5 w-24" />
                      <Skeleton className="h-4 w-16" />
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))
          ) : filteredTeams?.length === 0 ? (
            <div className="col-span-full py-12 text-center text-muted-foreground">
              No teams found matching your criteria.
            </div>
          ) : (
            filteredTeams?.map((team) => (
              <Link key={team.school} href={`/teams/${encodeURIComponent(team.school)}`}>
                <Card className="shadow-sm border-border hover:border-primary transition-colors cursor-pointer group overflow-hidden relative">
                  <div 
                    className="absolute top-0 left-0 w-full h-1" 
                    style={{ backgroundColor: team.color || 'hsl(var(--primary))' }} 
                  />
                  <CardContent className="p-6">
                    <div className="flex items-start gap-4">
                      <div className="w-14 h-14 bg-muted rounded-full flex items-center justify-center p-2 shadow-sm border border-border bg-white flex-shrink-0">
                        {team.logo ? (
                          <img src={team.logo} alt={`${team.school} logo`} className="w-full h-full object-contain" />
                        ) : (
                          <Shield className="w-6 h-6 text-muted-foreground" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <h3 className="font-bold text-lg truncate group-hover:text-primary transition-colors" title={team.school}>
                          {team.school}
                        </h3>
                        <p className="text-sm text-muted-foreground truncate" title={team.mascot || ''}>
                          {team.mascot || 'No mascot'}
                        </p>
                        <div className="mt-3 flex items-center gap-2 text-xs font-medium bg-muted/50 w-fit px-2 py-1 rounded-md text-muted-foreground">
                          <Users className="w-3 h-3" />
                          {team.playerCount || 0} Players
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
