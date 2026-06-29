import { Feather } from "@expo/vector-icons";
import {
  useGetFilters,
  useListPlayers,
  type ListPlayersSort,
  type Player,
} from "@workspace/api-client-react";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
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
  Chip,
  EmptyState,
  ErrorState,
  LoadingState,
  SearchBar,
  TAB_BAR_SPACE,
  useInsets,
} from "@/components/ui";
import { useSeason } from "@/context/filters";
import { useColors } from "@/hooks/useColors";

const PAGE_SIZE = 25;

const SORTS: { key: ListPlayersSort; label: string }[] = [
  { key: "war", label: "WAR" },
  { key: "twar", label: "TWAR" },
  { key: "snaps", label: "Snaps" },
  { key: "name", label: "Name" },
];

function useDebounced<T>(value: T, delay = 350): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

export default function PlayersScreen() {
  const colors = useColors();
  const insets = useInsets();
  const router = useRouter();
  const { season } = useSeason();

  const [searchInput, setSearchInput] = useState("");
  const search = useDebounced(searchInput);
  const [posGroup, setPosGroup] = useState<string | undefined>(undefined);
  const defaultOrder = (key: ListPlayersSort): "asc" | "desc" =>
    key === "name" ? "asc" : "desc";

  const [sort, setSort] = useState<ListPlayersSort>("war");
  const [order, setOrder] = useState<"asc" | "desc">(defaultOrder("war"));
  const [page, setPage] = useState(1);
  const [accumulated, setAccumulated] = useState<Player[]>([]);

  const handleSort = (key: ListPlayersSort) => {
    if (key === sort) {
      setOrder((o) => (o === "asc" ? "desc" : "asc"));
    } else {
      setSort(key);
      setOrder(defaultOrder(key));
    }
  };

  const filters = useGetFilters();

  const query = useListPlayers({
    search: search || undefined,
    posGroup,
    season,
    sort,
    order,
    page,
    pageSize: PAGE_SIZE,
  });

  useEffect(() => {
    setPage(1);
  }, [search, posGroup, sort, order, season]);

  useEffect(() => {
    if (!query.data) return;
    setAccumulated((prev) =>
      query.data.page === 1
        ? query.data.players
        : [...prev, ...query.data.players],
    );
  }, [query.data]);

  const total = query.data?.total ?? 0;
  const hasMore = accumulated.length < total;

  const posGroups = filters.data?.posGroups ?? [];

  const header = useMemo(
    () => (
      <View style={{ padding: 16, gap: 14 }}>
        <SearchBar
          value={searchInput}
          onChangeText={setSearchInput}
          placeholder="Search players…"
        />
        {posGroups.length > 0 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 8 }}
          >
            <Chip
              label="All"
              active={posGroup === undefined}
              onPress={() => setPosGroup(undefined)}
            />
            {posGroups.map((pg) => (
              <Chip
                key={pg}
                label={pg}
                active={posGroup === pg}
                onPress={() => setPosGroup(pg)}
              />
            ))}
          </ScrollView>
        ) : null}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Feather name="sliders" size={14} color={colors.mutedForeground} />
          <Text
            style={{
              color: colors.mutedForeground,
              fontSize: 12,
              fontFamily: "Inter_500Medium",
              marginRight: 4,
            }}
          >
            Sort
          </Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 8 }}
          >
            {SORTS.map((s) => (
              <Chip
                key={s.key}
                label={s.label}
                active={sort === s.key}
                icon={
                  sort === s.key
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
        <Text
          style={{
            color: colors.mutedForeground,
            fontSize: 12,
            fontFamily: "Inter_400Regular",
          }}
        >
          {total} player{total === 1 ? "" : "s"}
        </Text>
      </View>
    ),
    [searchInput, posGroups, posGroup, sort, order, total, colors.mutedForeground],
  );

  const showInitialLoading = query.isLoading && accumulated.length === 0;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <StatusBar style="light" />
      <LinearGradient
        colors={[colors.brandPurple, colors.brandPurpleDark]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={{
          paddingTop: insets.top + 14,
          paddingBottom: 18,
          paddingHorizontal: 20,
        }}
      >
        <Text
          style={{
            color: "#ffffff",
            fontSize: 26,
            fontFamily: "Inter_700Bold",
          }}
        >
          Player Explorer
        </Text>
        <Text
          style={{
            color: "rgba(255,255,255,0.7)",
            fontSize: 14,
            fontFamily: "Inter_400Regular",
            marginTop: 4,
          }}
        >
          {season} season · search, filter & sort
        </Text>
      </LinearGradient>

      {query.isError && accumulated.length === 0 ? (
        <ErrorState onRetry={() => query.refetch()} />
      ) : (
        <FlatList
          data={accumulated}
          keyExtractor={(item) => item.playerId}
          ListHeaderComponent={header}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{
            paddingHorizontal: 16,
            paddingBottom: insets.bottom + TAB_BAR_SPACE,
            gap: 10,
          }}
          renderItem={({ item }) => (
            <PlayerRow
              player={item}
              onPress={() =>
                router.push({
                  pathname: "/player/[playerId]",
                  params: { playerId: item.playerId },
                })
              }
            />
          )}
          onEndReachedThreshold={0.4}
          onEndReached={() => {
            if (hasMore && !query.isFetching) setPage((p) => p + 1);
          }}
          ListEmptyComponent={
            showInitialLoading ? (
              <LoadingState label="Loading players…" />
            ) : (
              <EmptyState
                icon="search"
                title="No players found"
                message="Try a different search or filter."
              />
            )
          }
          ListFooterComponent={
            query.isFetching && accumulated.length > 0 ? (
              <View style={{ paddingVertical: 20 }}>
                <ActivityIndicator color={colors.brandPurple} />
              </View>
            ) : null
          }
        />
      )}
    </View>
  );
}
