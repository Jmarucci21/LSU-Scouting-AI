import { Feather } from "@expo/vector-icons";
import { useGetTeam } from "@workspace/api-client-react";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import React, { useMemo } from "react";
import { FlatList, Text, View } from "react-native";

import { PlayerRow } from "@/components/cards";
import {
  Badge,
  EmptyState,
  ErrorState,
  LoadingState,
  useInsets,
} from "@/components/ui";
import { useColors } from "@/hooks/useColors";

export default function TeamDetailScreen() {
  const colors = useColors();
  const insets = useInsets();
  const router = useRouter();
  const { school } = useLocalSearchParams<{ school: string }>();

  const query = useGetTeam(school ?? "");
  const team = query.data?.team;

  const roster = useMemo(() => {
    const list = query.data?.roster ?? [];
    return [...list].sort((a, b) => (b.war ?? -Infinity) - (a.war ?? -Infinity));
  }, [query.data?.roster]);

  const header = (
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
        {team?.conference ? <Badge label={team.conference} tone="gold" /> : null}
        {team?.classification ? (
          <Badge label={team.classification} tone="gold" />
        ) : null}
        <Badge label={`${roster.length} players`} tone="gold" />
      </View>
    </LinearGradient>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <Stack.Screen options={{ title: team?.school ?? "Team" }} />
      {query.isLoading ? (
        <LoadingState label="Loading team…" />
      ) : query.isError || !team ? (
        <ErrorState onRetry={() => query.refetch()} />
      ) : (
        <FlatList
          data={roster}
          keyExtractor={(item) => item.playerId}
          ListHeaderComponent={
            <View>
              {header}
              <View style={{ paddingHorizontal: 16, paddingTop: 20 }}>
                <Text
                  style={{
                    color: colors.foreground,
                    fontSize: 18,
                    fontFamily: "Inter_700Bold",
                    marginBottom: 12,
                  }}
                >
                  Roster by WAR
                </Text>
              </View>
            </View>
          }
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
            <EmptyState
              icon="users"
              title="No roster data"
              message="This team has no graded players for the loaded seasons."
            />
          }
        />
      )}
    </View>
  );
}
