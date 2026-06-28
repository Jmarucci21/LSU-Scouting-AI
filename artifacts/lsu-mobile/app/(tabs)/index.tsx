import {
  useGetDashboardSummary,
  useGetFilters,
  useGetPositionGroups,
  useGetTopPlayers,
} from "@workspace/api-client-react";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import React from "react";
import { RefreshControl, ScrollView, Text, View } from "react-native";

import {
  PlayerRow,
  PositionGroupRow,
  StatTile,
} from "@/components/cards";
import {
  Card,
  Chip,
  ErrorState,
  fmt,
  LoadingState,
  SectionTitle,
  TAB_BAR_SPACE,
  useInsets,
} from "@/components/ui";
import { useSeason } from "@/context/filters";
import { useColors } from "@/hooks/useColors";

export default function DashboardScreen() {
  const colors = useColors();
  const insets = useInsets();
  const router = useRouter();
  const { season, setSeason } = useSeason();

  const filters = useGetFilters();
  const summary = useGetDashboardSummary({ season });
  const top = useGetTopPlayers({ season, metric: "war", limit: 8 });
  const groups = useGetPositionGroups({ season });

  const isLoading =
    summary.isLoading || top.isLoading || groups.isLoading;
  const isError = summary.isError || top.isError || groups.isError;

  const onRefresh = () => {
    summary.refetch();
    top.refetch();
    groups.refetch();
    filters.refetch();
  };

  const seasons = filters.data?.seasons ?? summary.data?.seasons ?? [];
  const positionGroups = groups.data ?? summary.data?.positionGroups ?? [];
  const topPlayers = top.data ?? [];

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <StatusBar style="light" />
      <LinearGradient
        colors={[colors.brandPurple, colors.brandPurpleDark]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={{
          paddingTop: insets.top + 14,
          paddingBottom: 20,
          paddingHorizontal: 20,
        }}
      >
        <Text
          style={{
            color: colors.brandGold,
            fontSize: 13,
            fontFamily: "Inter_600SemiBold",
            letterSpacing: 1.5,
          }}
        >
          SCOUTPRO
        </Text>
        <Text
          style={{
            color: "#ffffff",
            fontSize: 26,
            fontFamily: "Inter_700Bold",
            marginTop: 2,
          }}
        >
          Scouting War Room
        </Text>
        <Text
          style={{
            color: "rgba(255,255,255,0.7)",
            fontSize: 14,
            fontFamily: "Inter_400Regular",
            marginTop: 4,
          }}
        >
          Advanced college football grades
        </Text>

        {seasons.length > 0 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 8, paddingTop: 16 }}
          >
            {seasons.map((s) => {
              const active = s === season;
              return (
                <Chip
                  key={s}
                  label={String(s)}
                  active={active}
                  onPress={() => setSeason(s)}
                />
              );
            })}
          </ScrollView>
        ) : null}
      </LinearGradient>

      {isLoading ? (
        <LoadingState label="Loading dashboard…" />
      ) : isError ? (
        <ErrorState onRetry={onRefresh} />
      ) : (
        <ScrollView
          contentContainerStyle={{
            padding: 16,
            paddingBottom: insets.bottom + TAB_BAR_SPACE,
            gap: 24,
          }}
          refreshControl={
            <RefreshControl
              refreshing={summary.isFetching}
              onRefresh={onRefresh}
              tintColor={colors.brandPurple}
            />
          }
        >
          <View style={{ flexDirection: "row", gap: 12 }}>
            <StatTile
              icon="users"
              label="Players"
              value={String(summary.data?.totalPlayers ?? 0)}
            />
            <StatTile
              icon="shield"
              label="Teams"
              value={String(summary.data?.totalTeams ?? 0)}
            />
          </View>
          <View style={{ flexDirection: "row", gap: 12, marginTop: -12 }}>
            <StatTile
              icon="trending-up"
              label="Avg WAR"
              value={fmt(summary.data?.avgWar)}
            />
            <StatTile
              icon="award"
              label="Top WAR"
              value={fmt(summary.data?.topPlayer?.war)}
            />
          </View>

          {topPlayers.length > 0 ? (
            <View>
              <SectionTitle title="Top Players by WAR" />
              <View style={{ gap: 10 }}>
                {topPlayers.map((p, i) => (
                  <PlayerRow
                    key={p.playerId}
                    player={p}
                    rank={i + 1}
                    onPress={() =>
                      router.push({
                        pathname: "/player/[playerId]",
                        params: { playerId: p.playerId },
                      })
                    }
                  />
                ))}
              </View>
            </View>
          ) : null}

          {positionGroups.length > 0 ? (
            <View>
              <SectionTitle title="Position Groups" />
              <Card style={{ paddingVertical: 0 }}>
                {positionGroups.map((g, i) => (
                  <View
                    key={g.posGroup}
                    style={
                      i === positionGroups.length - 1
                        ? { borderBottomWidth: 0 }
                        : undefined
                    }
                  >
                    <PositionGroupRow group={g} />
                  </View>
                ))}
              </Card>
            </View>
          ) : null}
        </ScrollView>
      )}
    </View>
  );
}
