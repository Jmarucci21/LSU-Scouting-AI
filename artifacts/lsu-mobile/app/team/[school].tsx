import { Feather } from "@expo/vector-icons";
import {
  getListPlayersQueryKey,
  useGetFilters,
  useGetTeam,
  useListPlayers,
} from "@workspace/api-client-react";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import React, { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, ScrollView, Text, View } from "react-native";

import { PlayerRow } from "@/components/cards";
import {
  Badge,
  Chip,
  EmptyState,
  ErrorState,
  LoadingState,
  useInsets,
} from "@/components/ui";
import { useColors } from "@/hooks/useColors";

const PAGE_SIZE = 200;

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

  const rosterParams = {
    team: school ?? "",
    season,
    sort: "war" as const,
    order: "desc" as const,
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

  const header = (
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
            <Feather name="calendar" size={14} color={colors.mutedForeground} />
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
          Roster by WAR
        </Text>
        {rosterSeason != null ? (
          <Badge label={`${rosterSeason} Roster`} tone="gold" />
        ) : null}
      </View>
    </View>
  );

  const showInitialLoading =
    teamQuery.isLoading || (rosterQuery.isLoading && roster.length === 0);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <Stack.Screen options={{ title: team?.school ?? "Team" }} />
      {showInitialLoading ? (
        <LoadingState label="Loading team…" />
      ) : teamQuery.isError || !team ? (
        <ErrorState onRetry={() => teamQuery.refetch()} />
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
