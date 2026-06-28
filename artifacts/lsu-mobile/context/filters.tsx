import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { createContext, useContext, useEffect, useState } from "react";

type SeasonContextValue = {
  season: number;
  setSeason: (s: number) => void;
};

const SeasonContext = createContext<SeasonContextValue | undefined>(undefined);

const STORAGE_KEY = "scoutpro.season";
const DEFAULT_SEASON = 2025;

export function SeasonProvider({ children }: { children: React.ReactNode }) {
  const [season, setSeasonState] = useState<number>(DEFAULT_SEASON);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((value) => {
        if (!value) return;
        const parsed = Number(value);
        if (!Number.isNaN(parsed)) setSeasonState(parsed);
      })
      .catch(() => {});
  }, []);

  const setSeason = (next: number) => {
    setSeasonState(next);
    AsyncStorage.setItem(STORAGE_KEY, String(next)).catch(() => {});
  };

  return (
    <SeasonContext.Provider value={{ season, setSeason }}>
      {children}
    </SeasonContext.Provider>
  );
}

export function useSeason(): SeasonContextValue {
  const ctx = useContext(SeasonContext);
  if (!ctx) throw new Error("useSeason must be used within a SeasonProvider");
  return ctx;
}
