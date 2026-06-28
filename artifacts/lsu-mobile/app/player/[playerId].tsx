import { Feather } from "@expo/vector-icons";
import {
  useGetPlayer,
  type GradeItem,
} from "@workspace/api-client-react";
import { LinearGradient } from "expo-linear-gradient";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import React, { useMemo } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

import { GradeBar } from "@/components/cards";
import {
  Badge,
  Card,
  ErrorState,
  fmt,
  LoadingState,
  SectionTitle,
  useInsets,
} from "@/components/ui";
import { useColors } from "@/hooks/useColors";

function MetricBox({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  const colors = useColors();
  return (
    <Card style={{ flex: 1, padding: 14, alignItems: "center", gap: 4 }}>
      <Text
        style={{
          color: colors.brandPurple,
          fontSize: 20,
          fontFamily: "Inter_700Bold",
        }}
      >
        {value}
      </Text>
      <Text
        style={{
          color: colors.mutedForeground,
          fontSize: 11,
          fontFamily: "Inter_500Medium",
          letterSpacing: 0.5,
        }}
      >
        {label}
      </Text>
    </Card>
  );
}

export default function PlayerDetailScreen() {
  const colors = useColors();
  const insets = useInsets();
  const router = useRouter();
  const { playerId } = useLocalSearchParams<{ playerId: string }>();

  const query = useGetPlayer(playerId);
  const player = query.data;

  const groupedGrades = useMemo(() => {
    const grades = player?.grades ?? [];
    const map = new Map<string, GradeItem[]>();
    for (const g of grades) {
      const cat = g.category ?? "Overall";
      const arr = map.get(cat) ?? [];
      arr.push(g);
      map.set(cat, arr);
    }
    return Array.from(map.entries());
  }, [player?.grades]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <Stack.Screen
        options={{ title: player?.playerName ?? "Player" }}
      />
      {query.isLoading ? (
        <LoadingState label="Loading player…" />
      ) : query.isError || !player ? (
        <ErrorState onRetry={() => query.refetch()} />
      ) : (
        <ScrollView
          contentContainerStyle={{
            paddingBottom: insets.bottom + 24,
          }}
        >
          <LinearGradient
            colors={[colors.brandPurple, colors.brandPurpleDark]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={{ padding: 20, gap: 10 }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              {player.jersey ? (
                <Badge label={`#${player.jersey}`} tone="gold" />
              ) : null}
              {player.playerTier ? (
                <Badge label={player.playerTier} tone="gold" />
              ) : null}
            </View>
            <Text
              style={{
                color: "#ffffff",
                fontSize: 28,
                fontFamily: "Inter_700Bold",
              }}
            >
              {player.playerName}
            </Text>
            <View
              style={{ flexDirection: "row", alignItems: "center", gap: 12 }}
            >
              <Text
                style={{
                  color: "rgba(255,255,255,0.85)",
                  fontSize: 15,
                  fontFamily: "Inter_500Medium",
                }}
              >
                {player.position ?? "—"}
              </Text>
              {player.team ? (
                <Pressable
                  onPress={() =>
                    router.push({
                      pathname: "/team/[school]",
                      params: { school: player.team as string },
                    })
                  }
                  style={({ pressed }) => ({
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 4,
                    opacity: pressed ? 0.7 : 1,
                  })}
                >
                  <Text
                    style={{
                      color: colors.brandGold,
                      fontSize: 15,
                      fontFamily: "Inter_600SemiBold",
                    }}
                  >
                    {player.team}
                  </Text>
                  <Feather
                    name="chevron-right"
                    size={15}
                    color={colors.brandGold}
                  />
                </Pressable>
              ) : null}
            </View>
          </LinearGradient>

          <View style={{ padding: 16, gap: 24 }}>
            <View style={{ flexDirection: "row", gap: 12 }}>
              <MetricBox label="WAR" value={fmt(player.war)} />
              <MetricBox label="TWAR" value={fmt(player.twar)} />
            </View>
            <View style={{ flexDirection: "row", gap: 12, marginTop: -12 }}>
              <MetricBox label="PAR" value={fmt(player.par)} />
              <MetricBox
                label="SNAPS"
                value={fmt(player.snapsNonSt, 0)}
              />
            </View>

            {(player.playerValue != null ||
              player.playerValuePct != null ||
              player.conference) && (
              <Card style={{ gap: 12 }}>
                {player.conference ? (
                  <Row label="Conference" value={player.conference} />
                ) : null}
                {player.playerValue != null ? (
                  <Row
                    label="Player Value"
                    value={fmt(player.playerValue)}
                  />
                ) : null}
                {player.playerValuePct != null ? (
                  <Row
                    label="Value Percentile"
                    value={`${fmt(player.playerValuePct, 0)}%`}
                  />
                ) : null}
                <Row label="Season" value={String(player.season)} />
              </Card>
            )}

            {groupedGrades.length > 0 ? (
              <View>
                <SectionTitle title="Grade Breakdown" />
                <View style={{ gap: 16 }}>
                  {groupedGrades.map(([category, items]) => (
                    <Card key={category} style={{ gap: 4 }}>
                      <Text
                        style={{
                          color: colors.mutedForeground,
                          fontSize: 12,
                          fontFamily: "Inter_600SemiBold",
                          letterSpacing: 0.5,
                          textTransform: "uppercase",
                          marginBottom: 8,
                        }}
                      >
                        {category}
                      </Text>
                      {items.map((g) => (
                        <GradeBar key={g.key} label={g.label} value={g.value} />
                      ))}
                    </Card>
                  ))}
                </View>
              </View>
            ) : null}
          </View>
        </ScrollView>
      )}
    </View>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  const colors = useColors();
  return (
    <View
      style={{
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "center",
      }}
    >
      <Text
        style={{
          color: colors.mutedForeground,
          fontSize: 14,
          fontFamily: "Inter_400Regular",
        }}
      >
        {label}
      </Text>
      <Text
        style={{
          color: colors.foreground,
          fontSize: 14,
          fontFamily: "Inter_600SemiBold",
        }}
      >
        {value}
      </Text>
    </View>
  );
}
