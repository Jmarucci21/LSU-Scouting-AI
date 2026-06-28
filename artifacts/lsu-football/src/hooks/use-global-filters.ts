import { create } from "zustand";

interface GlobalFiltersState {
  season: number | undefined;
  team: string | undefined;
  setSeason: (season: number | undefined) => void;
  setTeam: (team: string | undefined) => void;
}

export const useGlobalFilters = create<GlobalFiltersState>((set) => ({
  season: 2023, // Defaulting to a recent season
  team: "LSU",
  setSeason: (season) => set({ season }),
  setTeam: (team) => set({ team }),
}));
