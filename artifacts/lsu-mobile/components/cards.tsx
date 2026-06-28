import { Feather } from "@expo/vector-icons";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import React from "react";
import { Pressable, Text, View } from "react-native";

import type { Player, PositionGroupStat, Team } from "@workspace/api-client-react";

import { Card, fmt } from "@/components/ui";
import { useColors } from "@/hooks/useColors";

export function StatTile({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon: keyof typeof Feather.glyphMap;
}) {
  const colors = useColors();
  return (
    <Card style={{ flex: 1, padding: 14, gap: 10 }}>
      <Feather name={icon} size={18} color={colors.brandPurple} />
      <View style={{ gap: 2 }}>
        <Text
          style={{
            color: colors.foreground,
            fontSize: 22,
            fontFamily: "Inter_700Bold",
          }}
          numberOfLines={1}
        >
          {value}
        </Text>
        <Text
          style={{
            color: colors.mutedForeground,
            fontSize: 12,
            fontFamily: "Inter_500Medium",
          }}
        >
          {label}
        </Text>
      </View>
    </Card>
  );
}

export function WarPill({
  value,
  label,
}: {
  value: number | null | undefined;
  label: string;
}) {
  const colors = useColors();
  return (
    <View style={{ alignItems: "flex-end", minWidth: 56 }}>
      <Text
        style={{
          color: colors.brandPurple,
          fontSize: 16,
          fontFamily: "Inter_700Bold",
        }}
      >
        {fmt(value)}
      </Text>
      <Text
        style={{
          color: colors.mutedForeground,
          fontSize: 10,
          fontFamily: "Inter_500Medium",
          letterSpacing: 0.5,
        }}
      >
        {label}
      </Text>
    </View>
  );
}

export function PlayerRow({
  player,
  rank,
  onPress,
}: {
  player: Player;
  rank?: number;
  onPress: () => void;
}) {
  const colors = useColors();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        backgroundColor: colors.card,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: colors.radius + 4,
        padding: 14,
        gap: 12,
        opacity: pressed ? 0.85 : 1,
      })}
    >
      {rank !== undefined ? (
        <View
          style={{
            width: 28,
            height: 28,
            borderRadius: 14,
            backgroundColor: colors.brandPurple,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text
            style={{
              color: colors.brandGold,
              fontSize: 13,
              fontFamily: "Inter_700Bold",
            }}
          >
            {rank}
          </Text>
        </View>
      ) : null}
      <View style={{ flex: 1, gap: 3 }}>
        <Text
          style={{
            color: colors.foreground,
            fontSize: 15,
            fontFamily: "Inter_600SemiBold",
          }}
          numberOfLines={1}
        >
          {player.playerName}
        </Text>
        <Text
          style={{
            color: colors.mutedForeground,
            fontSize: 12,
            fontFamily: "Inter_400Regular",
          }}
          numberOfLines={1}
        >
          {[player.position, player.team].filter(Boolean).join(" · ") || "—"}
        </Text>
      </View>
      <WarPill value={player.war} label="WAR" />
      <WarPill value={player.twar} label="TWAR" />
      <Feather name="chevron-right" size={18} color={colors.mutedForeground} />
    </Pressable>
  );
}

export function TeamCard({
  team,
  onPress,
}: {
  team: Team;
  onPress: () => void;
}) {
  const colors = useColors();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flex: 1,
        backgroundColor: colors.card,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: colors.radius + 4,
        padding: 14,
        gap: 10,
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        {team.logo ? (
          <Image
            source={{ uri: team.logo }}
            style={{ width: 40, height: 40 }}
            contentFit="contain"
            transition={150}
          />
        ) : (
          <View
            style={{
              width: 40,
              height: 40,
              borderRadius: 20,
              backgroundColor: team.color ?? colors.brandPurple,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text
              style={{
                color: "#ffffff",
                fontSize: 16,
                fontFamily: "Inter_700Bold",
              }}
            >
              {team.school.charAt(0)}
            </Text>
          </View>
        )}
      </View>
      <View style={{ gap: 2 }}>
        <Text
          style={{
            color: colors.foreground,
            fontSize: 15,
            fontFamily: "Inter_700Bold",
          }}
          numberOfLines={1}
        >
          {team.school}
        </Text>
        <Text
          style={{
            color: colors.mutedForeground,
            fontSize: 12,
            fontFamily: "Inter_400Regular",
          }}
          numberOfLines={1}
        >
          {team.mascot ?? team.conference ?? "—"}
        </Text>
      </View>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          marginTop: 2,
        }}
      >
        <Feather name="users" size={13} color={colors.brandPurple} />
        <Text
          style={{
            color: colors.mutedForeground,
            fontSize: 12,
            fontFamily: "Inter_500Medium",
          }}
        >
          {team.playerCount ?? 0} players
        </Text>
      </View>
    </Pressable>
  );
}

export function PositionGroupRow({ group }: { group: PositionGroupStat }) {
  const colors = useColors();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        paddingVertical: 12,
        borderBottomColor: colors.border,
        borderBottomWidth: 1,
        gap: 12,
      }}
    >
      <View
        style={{
          width: 46,
          height: 46,
          borderRadius: colors.radius + 2,
          backgroundColor: colors.accent,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text
          style={{
            color: colors.brandPurple,
            fontSize: 13,
            fontFamily: "Inter_700Bold",
          }}
        >
          {group.posGroup}
        </Text>
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text
          style={{
            color: colors.foreground,
            fontSize: 14,
            fontFamily: "Inter_600SemiBold",
          }}
        >
          {group.count} players
        </Text>
        {group.topPlayerName ? (
          <Text
            style={{
              color: colors.mutedForeground,
              fontSize: 12,
              fontFamily: "Inter_400Regular",
            }}
            numberOfLines={1}
          >
            Top: {group.topPlayerName}
          </Text>
        ) : null}
      </View>
      <View style={{ alignItems: "flex-end" }}>
        <Text
          style={{
            color: colors.brandPurple,
            fontSize: 16,
            fontFamily: "Inter_700Bold",
          }}
        >
          {fmt(group.avgWar)}
        </Text>
        <Text
          style={{
            color: colors.mutedForeground,
            fontSize: 10,
            fontFamily: "Inter_500Medium",
            letterSpacing: 0.5,
          }}
        >
          AVG WAR
        </Text>
      </View>
    </View>
  );
}

export function GradeBar({
  label,
  value,
}: {
  label: string;
  value: number;
}) {
  const colors = useColors();
  const pct = Math.max(0, Math.min(100, value));
  return (
    <View style={{ gap: 6, marginBottom: 12 }}>
      <View
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <Text
          style={{
            color: colors.foreground,
            fontSize: 13,
            fontFamily: "Inter_500Medium",
            flex: 1,
          }}
          numberOfLines={1}
        >
          {label}
        </Text>
        <Text
          style={{
            color: colors.brandPurple,
            fontSize: 13,
            fontFamily: "Inter_700Bold",
          }}
        >
          {fmt(value)}
        </Text>
      </View>
      <View
        style={{
          height: 8,
          borderRadius: 4,
          backgroundColor: colors.muted,
          overflow: "hidden",
        }}
      >
        <LinearGradient
          colors={[colors.brandPurple, colors.brandGold]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={{ width: `${pct}%`, height: "100%", borderRadius: 4 }}
        />
      </View>
    </View>
  );
}
