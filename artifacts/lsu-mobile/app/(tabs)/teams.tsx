import {
  useGetFilters,
  useListTeams,
} from "@workspace/api-client-react";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import React, { useState } from "react";
import { FlatList, ScrollView, Text, View } from "react-native";

import { TeamCard } from "@/components/cards";
import {
  Chip,
  EmptyState,
  ErrorState,
  LoadingState,
  TAB_BAR_SPACE,
  useInsets,
} from "@/components/ui";
import { useColors } from "@/hooks/useColors";

export default function TeamsScreen() {
  const colors = useColors();
  const insets = useInsets();
  const router = useRouter();

  const [conference, setConference] = useState<string | undefined>(undefined);

  const filters = useGetFilters();
  const query = useListTeams({ conference });

  const conferences = filters.data?.conferences ?? [];
  const teams = query.data ?? [];

  const header = (
    <View style={{ paddingVertical: 16 }}>
      {conferences.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }}
        >
          <Chip
            label="All"
            active={conference === undefined}
            onPress={() => setConference(undefined)}
          />
          {conferences.map((c) => (
            <Chip
              key={c}
              label={c}
              active={conference === c}
              onPress={() => setConference(c)}
            />
          ))}
        </ScrollView>
      ) : null}
    </View>
  );

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
          style={{ color: "#ffffff", fontSize: 26, fontFamily: "Inter_700Bold" }}
        >
          Teams
        </Text>
        <Text
          style={{
            color: "rgba(255,255,255,0.7)",
            fontSize: 14,
            fontFamily: "Inter_400Regular",
            marginTop: 4,
          }}
        >
          {teams.length} program{teams.length === 1 ? "" : "s"}
        </Text>
      </LinearGradient>

      {query.isLoading ? (
        <LoadingState label="Loading teams…" />
      ) : query.isError ? (
        <ErrorState onRetry={() => query.refetch()} />
      ) : (
        <FlatList
          data={teams}
          keyExtractor={(item) => item.school}
          numColumns={2}
          ListHeaderComponent={header}
          columnWrapperStyle={{ gap: 12, paddingHorizontal: 16 }}
          contentContainerStyle={{
            gap: 12,
            paddingBottom: insets.bottom + TAB_BAR_SPACE,
          }}
          renderItem={({ item }) => (
            <TeamCard
              team={item}
              onPress={() =>
                router.push({
                  pathname: "/team/[school]",
                  params: { school: item.school },
                })
              }
            />
          )}
          ListEmptyComponent={
            <EmptyState
              icon="shield"
              title="No teams found"
              message="Try a different conference filter."
            />
          }
        />
      )}
    </View>
  );
}
