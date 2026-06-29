import { Feather } from "@expo/vector-icons";
import {
  getGetStatsMetaQueryKey,
  getListPlayersQueryKey,
  getListStatsQueryKey,
  useGetFilters,
  useGetStatsMeta,
  useGetTeam,
  useListPlayers,
  type ListPlayersSort,
  useListStats,
  type StatRow,
  type StatsMetaResponse,
} from "@workspace/api-client-react";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";

import { PlayerRow } from "@/components/cards";
import {
  Badge,
  Card,
  Chip,
  EmptyState,
  ErrorState,
  LoadingState,
  SearchBar,
  useInsets,
} from "@/components/ui";
import { useColors } from "@/hooks/useColors";

const PAGE_SIZE = 200;
const STATS_PAGE_SIZE = 50;

const SOURCE_LABELS: Record<string, string> = {
  statsbomb: "Hudl StatsBomb",
  telemetry: "Telemetry",
  cfbd: "CFBD",
  trumedia: "TruMedia",
  pff: "PFF",
};

function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

function formatValue(row: StatRow): string {
  if (row.strValue != null && row.strValue !== "") return row.strValue;
  if (row.value == null) return "—";
  const v = row.value;
  const formatted = Number.isInteger(v) ? v.toString() : v.toFixed(2);
  return row.unit ? `${formatted} ${row.unit}` : formatted;
}

// Stat keys belonging to the selected source (or every source when none is
// selected), deduped by key and sorted by label.
function keysForSource(
  meta: StatsMetaResponse | undefined,
  source: string | undefined,
): { key: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const group of meta?.keysBySource ?? []) {
    if (source && group.source !== source) continue;
    for (const k of group.keys) {
      if (!seen.has(k.key)) seen.set(k.key, k.label);
    }
  }
  return Array.from(seen, ([key, label]) => ({ key, label })).sort((a, b) =>
    a.label.localeCompare(b.label),
  );
}

function useDebounced<T>(value: T, delay = 350): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

type Tab = "roster" | "stats";

const SORTS: { key: ListPlayersSort; label: string }[] = [
  { key: "war", label: "WAR" },
  { key: "twar", label: "TWAR" },
  { key: "snaps", label: "Snaps" },
  { key: "name", label: "Name" },
  { key: "position", label: "Position" },
];

export default function TeamDetailScreen() {
  const colors = useColors();
  const insets = useInsets();
  const router = useRouter();
  const { school } = useLocalSearchParams<{ school: string }>();

  const teamQuery = useGetTeam(school ?? "");
  const team = teamQuery.data?.team;

  const filters = useGetFilters();
  const seasons = useMemo(() => {
    const list = filters.data?.seasons ?? [];
    return [...list].sort((a, b) => b - a);
  }, [filters.data?.seasons]);

  // Default to the latest synced season once the season list loads.
  const [season, setSeason] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (season === undefined && seasons.length > 0) {
      setSeason(seasons[0]);
    }
  }, [season, seasons]);

  const defaultOrder = (key: ListPlayersSort): "asc" | "desc" =>
    key === "name" || key === "position" ? "asc" : "desc";

  const [sort, setSort] = useState<ListPlayersSort>("war");
  const [order, setOrder] = useState<"asc" | "desc">(defaultOrder("war"));

  const handleSort = (key: ListPlayersSort) => {
    if (key === sort) {
      setOrder((o) => (o === "asc" ? "desc" : "asc"));
    } else {
      setSort(key);
      setOrder(defaultOrder(key));
    }
  };

  const [tab, setTab] = useState<Tab>("roster");

  // --- Roster ---
  const rosterParams = {
    team: school ?? "",
    season,
    sort,
    order,
    page: 1,
    pageSize: PAGE_SIZE,
  };
  const rosterQuery = useListPlayers(rosterParams, {
    query: {
      enabled: !!school && season !== undefined,
      queryKey: getListPlayersQueryKey(rosterParams),
    },
  });

  const roster = rosterQuery.data?.players ?? [];
  const rosterTotal = rosterQuery.data?.total ?? roster.length;

  const rosterSeason = roster[0]?.season ?? null;

  // --- Raw stats (team-scoped explorer) ---
  const { data: meta } = useGetStatsMeta(
    { season },
    {
      query: {
        enabled: season !== undefined,
        queryKey: getGetStatsMetaQueryKey({ season }),
      },
    },
  );

  const [statSource, setStatSource] = useState<string | undefined>(undefined);
  const [statKey, setStatKey] = useState<string | undefined>(undefined);
  const [statSearchInput, setStatSearchInput] = useState("");
  const statSearch = useDebounced(statSearchInput);
  const [statPage, setStatPage] = useState(1);
  const [statRows, setStatRows] = useState<StatRow[]>([]);

  const sourceOptions = meta?.sources ?? [];
  const keyOptions = useMemo(
    () => keysForSource(meta, statSource),
    [meta, statSource],
  );

  // Reset paging whenever a filter or the season changes.
  useEffect(() => {
    setStatPage(1);
  }, [statSource, statKey, statSearch, season]);

  const statsParams = {
    team: school ?? "",
    season,
    source: statSource,
    key: statKey,
    search: statSearch || undefined,
    sort: "name" as const,
    order: "asc" as const,
    page: statPage,
    pageSize: STATS_PAGE_SIZE,
  };
  const statsQuery = useListStats(statsParams, {
    query: {
      enabled: tab === "stats" && !!school && season !== undefined,
      queryKey: getListStatsQueryKey(statsParams),
    },
  });

  useEffect(() => {
    if (!statsQuery.data) return;
    setStatRows((prev) =>
      statsQuery.data.page === 1
        ? statsQuery.data.rows
        : [...prev, ...statsQuery.data.rows],
    );
  }, [statsQuery.data]);

  const statTotal = statsQuery.data?.total ?? 0;
  const statHasMore = statRows.length < statTotal;

  const isStats = tab === "stats";

  const header = useMemo(
    () => (
      <View>
        <LinearGradient
          colors={[colors.brandPurple, colors.brandPurpleDark]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={{ padding: 20, gap: 14 }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
            {team?.logo ? (
              <Image
                source={{ uri: team.logo }}
                style={{ width: 56, height: 56 }}
                contentFit="contain"
                transition={150}
              />
            ) : (
              <View
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: 28,
                  backgroundColor: "rgba(255,255,255,0.15)",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Text
                  style={{
                    color: "#ffffff",
                    fontSize: 22,
                    fontFamily: "Inter_700Bold",
                  }}
                >
                  {team?.school?.charAt(0) ?? "?"}
                </Text>
              </View>
            )}
            <View style={{ flex: 1, gap: 4 }}>
              <Text
                style={{
                  color: "#ffffff",
                  fontSize: 22,
                  fontFamily: "Inter_700Bold",
                }}
                numberOfLines={2}
              >
                {team?.school}
              </Text>
              {team?.mascot ? (
                <Text
                  style={{
                    color: "rgba(255,255,255,0.75)",
                    fontSize: 14,
                    fontFamily: "Inter_400Regular",
                  }}
                >
                  {team.mascot}
                </Text>
              ) : null}
            </View>
          </View>
          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
            {team?.conference ? (
              <Badge label={team.conference} tone="gold" />
            ) : null}
            {team?.classification ? (
              <Badge label={team.classification} tone="gold" />
            ) : null}
            <Badge label={`${rosterTotal} players`} tone="gold" />
          </View>
        </LinearGradient>

        {seasons.length > 0 ? (
          <View style={{ paddingTop: 16, gap: 8 }}>
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                paddingHorizontal: 16,
              }}
            >
              <Feather
                name="calendar"
                size={14}
                color={colors.mutedForeground}
              />
              <Text
                style={{
                  color: colors.mutedForeground,
                  fontSize: 12,
                  fontFamily: "Inter_500Medium",
                }}
              >
                Season
              </Text>
            </View>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }}
            >
              {seasons.map((s) => (
                <Chip
                  key={s}
                  label={String(s)}
                  active={s === season}
                  onPress={() => setSeason(s)}
                />
              ))}
            </ScrollView>
          </View>
        ) : null}

        {/* Roster / Raw Stats tab toggle */}
        <View style={{ paddingHorizontal: 16, paddingTop: 16 }}>
          <View
            style={{
              flexDirection: "row",
              backgroundColor: colors.muted,
              borderRadius: 999,
              padding: 4,
            }}
          >
            {(
              [
                { key: "roster" as Tab, label: "Roster" },
                { key: "stats" as Tab, label: "Raw Stats" },
              ]
            ).map((t) => {
              const active = tab === t.key;
              return (
                <Pressable
                  key={t.key}
                  onPress={() => setTab(t.key)}
                  style={{
                    flex: 1,
                    paddingVertical: 9,
                    borderRadius: 999,
                    backgroundColor: active
                      ? colors.brandPurple
                      : "transparent",
                    alignItems: "center",
                  }}
                >
                  <Text
                    style={{
                      color: active ? "#ffffff" : colors.mutedForeground,
                      fontSize: 14,
                      fontFamily: active
                        ? "Inter_600SemiBold"
                        : "Inter_500Medium",
                    }}
                  >
                    {t.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        {isStats ? (
          <View style={{ paddingTop: 16, gap: 12 }}>
            <View style={{ paddingHorizontal: 16 }}>
              <SearchBar
                value={statSearchInput}
                onChangeText={setStatSearchInput}
                placeholder="Search players…"
              />
            </View>

            <View style={{ gap: 8 }}>
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 8,
                  paddingHorizontal: 16,
                }}
              >
                <Feather
                  name="database"
                  size={14}
                  color={colors.mutedForeground}
                />
                <Text
                  style={{
                    color: colors.mutedForeground,
                    fontSize: 12,
                    fontFamily: "Inter_500Medium",
                  }}
                >
                  Source
                </Text>
              </View>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }}
              >
                <Chip
                  label="All"
                  active={statSource === undefined}
                  onPress={() => {
                    setStatSource(undefined);
                    setStatKey(undefined);
                  }}
                />
                {sourceOptions.map((s) => (
                  <Chip
                    key={s}
                    label={sourceLabel(s)}
                    active={statSource === s}
                    onPress={() => {
                      setStatSource(s);
                      setStatKey(undefined);
                    }}
                  />
                ))}
              </ScrollView>
            </View>

            {statSource && keyOptions.length > 0 ? (
              <View style={{ gap: 8 }}>
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 8,
                    paddingHorizontal: 16,
                  }}
                >
                  <Feather
                    name="sliders"
                    size={14}
                    color={colors.mutedForeground}
                  />
                  <Text
                    style={{
                      color: colors.mutedForeground,
                      fontSize: 12,
                      fontFamily: "Inter_500Medium",
                    }}
                  >
                    Stat
                  </Text>
                </View>
                <FlatList
                  horizontal
                  data={[{ key: "__all__", label: "All" }, ...keyOptions]}
                  keyExtractor={(item) => item.key}
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }}
                  renderItem={({ item }) => {
                    const isAll = item.key === "__all__";
                    return (
                      <Chip
                        label={item.label}
                        active={
                          isAll ? statKey === undefined : statKey === item.key
                        }
                        onPress={() =>
                          setStatKey(isAll ? undefined : item.key)
                        }
                      />
                    );
                  }}
                />
              </View>
            ) : null}

            <Text
              style={{
                color: colors.mutedForeground,
                fontSize: 12,
                fontFamily: "Inter_400Regular",
                paddingHorizontal: 16,
              }}
            >
              {statTotal} stat line{statTotal === 1 ? "" : "s"}
            </Text>
          </View>
        ) : (
          <>
            <View style={{ paddingTop: 16, gap: 8 }}>
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 8,
                  paddingHorizontal: 16,
                }}
              >
                <Feather
                  name="sliders"
                  size={14}
                  color={colors.mutedForeground}
                />
                <Text
                  style={{
                    color: colors.mutedForeground,
                    fontSize: 12,
                    fontFamily: "Inter_500Medium",
                  }}
                >
                  Sort
                </Text>
              </View>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }}
              >
                {SORTS.map((s) => (
                  <Chip
                    key={s.key}
                    label={s.label}
                    active={s.key === sort}
                    icon={
                      s.key === sort
                        ? order === "asc"
                          ? "arrow-up"
                          : "arrow-down"
                        : undefined
                    }
                    onPress={() => handleSort(s.key)}
                  />
                ))}
              </ScrollView>
            </View>

            <View
              style={{
                paddingHorizontal: 16,
                paddingTop: 20,
                marginBottom: 12,
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
              }}
            >
              <Text
                style={{
                  color: colors.foreground,
                  fontSize: 18,
                  fontFamily: "Inter_700Bold",
                }}
              >
                {`Roster by ${SORTS.find((s) => s.key === sort)?.label ?? "WAR"}`}
              </Text>
              {rosterSeason != null ? (
                <Badge label={`${rosterSeason} Roster`} tone="gold" />
              ) : null}
            </View>
          </>
        )}
      </View>
    ),
    [
      colors,
      team,
      seasons,
      season,
      sort,
      order,
      rosterTotal,
      rosterSeason,
      tab,
      isStats,
      statSearchInput,
      statSource,
      statKey,
      sourceOptions,
      keyOptions,
      statTotal,
    ],
  );

  const showInitialLoading =
    teamQuery.isLoading ||
    (!isStats && rosterQuery.isLoading && roster.length === 0);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <Stack.Screen options={{ title: team?.school ?? "Team" }} />
      {showInitialLoading ? (
        <LoadingState label="Loading team…" />
      ) : teamQuery.isError || !team ? (
        <ErrorState onRetry={() => teamQuery.refetch()} />
      ) : isStats ? (
        <FlatList
          data={statRows}
          keyExtractor={(item, index) =>
            `${item.playerId}-${item.source}-${item.key}-${index}`
          }
          ListHeaderComponent={header}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
          renderItem={({ item }) => (
            <View style={{ paddingHorizontal: 16, marginTop: 10 }}>
              <StatLineRow row={item} />
            </View>
          )}
          onEndReachedThreshold={0.4}
          onEndReached={() => {
            if (statHasMore && !statsQuery.isFetching) {
              setStatPage((p) => p + 1);
            }
          }}
          ListEmptyComponent={
            statsQuery.isError ? (
              <ErrorState onRetry={() => statsQuery.refetch()} />
            ) : statsQuery.isFetching ? (
              <View style={{ paddingVertical: 24 }}>
                <ActivityIndicator color={colors.brandPurple} />
              </View>
            ) : (
              <EmptyState
                icon="bar-chart-2"
                title="No stats found"
                message={`No raw stat lines for ${team.school} in ${season}. Try a different source or season.`}
              />
            )
          }
          ListFooterComponent={
            statsQuery.isFetching && statRows.length > 0 ? (
              <View style={{ paddingVertical: 20 }}>
                <ActivityIndicator color={colors.brandPurple} />
              </View>
            ) : null
          }
        />
      ) : (
        <FlatList
          data={roster}
          keyExtractor={(item) => `${item.playerId}-${item.season}`}
          ListHeaderComponent={header}
          contentContainerStyle={{
            paddingBottom: insets.bottom + 24,
          }}
          renderItem={({ item, index }) => (
            <View style={{ paddingHorizontal: 16, marginBottom: 10 }}>
              <PlayerRow
                player={item}
                rank={index + 1}
                onPress={() =>
                  router.push({
                    pathname: "/player/[playerId]",
                    params: { playerId: item.playerId },
                  })
                }
              />
            </View>
          )}
          ListEmptyComponent={
            rosterQuery.isError ? (
              <ErrorState onRetry={() => rosterQuery.refetch()} />
            ) : rosterQuery.isFetching ? (
              <View style={{ paddingVertical: 24 }}>
                <ActivityIndicator color={colors.brandPurple} />
              </View>
            ) : (
              <EmptyState
                icon="users"
                title="No roster data"
                message={`No graded players for ${team.school} in ${season}.`}
              />
            )
          }
        />
      )}
    </View>
  );
}

function StatLineRow({ row }: { row: StatRow }) {
  const colors = useColors();
  const router = useRouter();
  return (
    <Pressable
      onPress={() =>
        router.push({
          pathname: "/player/[playerId]",
          params: { playerId: row.playerId },
        })
      }
      style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
    >
      <Card style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <View style={{ flex: 1, gap: 4 }}>
          <Text
            style={{
              color: colors.foreground,
              fontSize: 15,
              fontFamily: "Inter_600SemiBold",
            }}
            numberOfLines={1}
          >
            {row.playerName}
          </Text>
          <View
            style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
          >
            <Badge label={sourceLabel(row.source)} tone="neutral" />
            {row.position ? (
              <Text
                style={{
                  color: colors.mutedForeground,
                  fontSize: 12,
                  fontFamily: "Inter_400Regular",
                }}
              >
                {row.position}
              </Text>
            ) : null}
          </View>
          <Text
            style={{
              color: colors.mutedForeground,
              fontSize: 13,
              fontFamily: "Inter_400Regular",
            }}
            numberOfLines={2}
          >
            {row.label}
          </Text>
        </View>
        <View style={{ alignItems: "flex-end", minWidth: 64 }}>
          <Text
            style={{
              color: colors.brandPurple,
              fontSize: 16,
              fontFamily: "Inter_700Bold",
            }}
            numberOfLines={1}
          >
            {formatValue(row)}
          </Text>
        </View>
      </Card>
    </Pressable>
  );
}
