import { Feather } from "@expo/vector-icons";
import React from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useColors } from "@/hooks/useColors";

export const TAB_BAR_SPACE = 96;

export function useInsets() {
  const insets = useSafeAreaInsets();
  return {
    top: Platform.OS === "web" ? Math.max(insets.top, 67) : insets.top,
    bottom: Platform.OS === "web" ? Math.max(insets.bottom, 34) : insets.bottom,
    left: insets.left,
    right: insets.right,
  };
}

export function fmt(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toFixed(digits);
}

export function Card({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: ViewStyle | ViewStyle[];
}) {
  const colors = useColors();
  return (
    <View
      style={[
        {
          backgroundColor: colors.card,
          borderColor: colors.border,
          borderWidth: 1,
          borderRadius: colors.radius + 4,
          padding: 16,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function Badge({
  label,
  tone = "neutral",
}: {
  label: string;
  tone?: "neutral" | "brand" | "gold";
}) {
  const colors = useColors();
  const bg =
    tone === "brand"
      ? colors.brandPurple
      : tone === "gold"
        ? colors.brandGold
        : colors.muted;
  const fg =
    tone === "brand"
      ? "#ffffff"
      : tone === "gold"
        ? colors.brandPurple
        : colors.mutedForeground;
  return (
    <View
      style={{
        backgroundColor: bg,
        borderRadius: 999,
        paddingHorizontal: 10,
        paddingVertical: 4,
        alignSelf: "flex-start",
      }}
    >
      <Text style={{ color: fg, fontSize: 12, fontFamily: "Inter_600SemiBold" }}>
        {label}
      </Text>
    </View>
  );
}

export function Chip({
  label,
  active,
  onPress,
  icon,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  icon?: keyof typeof Feather.glyphMap;
}) {
  const colors = useColors();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        backgroundColor: active ? colors.brandPurple : colors.muted,
        borderColor: active ? colors.brandPurple : colors.border,
        borderWidth: 1,
        borderRadius: 999,
        paddingHorizontal: 14,
        paddingVertical: 8,
        opacity: pressed ? 0.8 : 1,
      })}
    >
      <Text
        style={{
          color: active ? "#ffffff" : colors.foreground,
          fontSize: 13,
          fontFamily: active ? "Inter_600SemiBold" : "Inter_500Medium",
        }}
      >
        {label}
      </Text>
      {icon ? (
        <Feather
          name={icon}
          size={14}
          color={active ? "#ffffff" : colors.foreground}
        />
      ) : null}
    </Pressable>
  );
}

export function SearchBar({
  value,
  onChangeText,
  placeholder,
}: {
  value: string;
  onChangeText: (t: string) => void;
  placeholder: string;
}) {
  const colors = useColors();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        backgroundColor: colors.muted,
        borderRadius: colors.radius + 4,
        paddingHorizontal: 12,
        height: 46,
        gap: 8,
      }}
    >
      <Feather name="search" size={18} color={colors.mutedForeground} />
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.mutedForeground}
        style={{
          flex: 1,
          color: colors.foreground,
          fontSize: 15,
          fontFamily: "Inter_400Regular",
          ...(Platform.OS === "web" ? { outlineStyle: "none" as never } : {}),
        }}
        returnKeyType="search"
        autoCorrect={false}
      />
      {value.length > 0 ? (
        <Pressable onPress={() => onChangeText("")} hitSlop={8}>
          <Feather name="x" size={18} color={colors.mutedForeground} />
        </Pressable>
      ) : null}
    </View>
  );
}

export function LoadingState({ label }: { label?: string }) {
  const colors = useColors();
  return (
    <View style={styles.center}>
      <ActivityIndicator color={colors.brandPurple} size="large" />
      {label ? (
        <Text style={[styles.stateText, { color: colors.mutedForeground }]}>
          {label}
        </Text>
      ) : null}
    </View>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message?: string;
  onRetry?: () => void;
}) {
  const colors = useColors();
  return (
    <View style={styles.center}>
      <Feather name="alert-triangle" size={36} color={colors.destructive} />
      <Text style={[styles.stateTitle, { color: colors.foreground }]}>
        Something went wrong
      </Text>
      <Text style={[styles.stateText, { color: colors.mutedForeground }]}>
        {message ?? "Unable to load data. Check your connection."}
      </Text>
      {onRetry ? (
        <Pressable
          onPress={onRetry}
          style={({ pressed }) => ({
            marginTop: 16,
            backgroundColor: colors.brandPurple,
            borderRadius: colors.radius + 2,
            paddingHorizontal: 20,
            paddingVertical: 10,
            opacity: pressed ? 0.85 : 1,
          })}
        >
          <Text style={{ color: "#ffffff", fontFamily: "Inter_600SemiBold" }}>
            Retry
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function EmptyState({
  icon = "inbox",
  title,
  message,
}: {
  icon?: keyof typeof Feather.glyphMap;
  title: string;
  message?: string;
}) {
  const colors = useColors();
  return (
    <View style={styles.center}>
      <Feather name={icon} size={36} color={colors.mutedForeground} />
      <Text style={[styles.stateTitle, { color: colors.foreground }]}>
        {title}
      </Text>
      {message ? (
        <Text style={[styles.stateText, { color: colors.mutedForeground }]}>
          {message}
        </Text>
      ) : null}
    </View>
  );
}

export function SectionTitle({
  title,
  action,
}: {
  title: string;
  action?: React.ReactNode;
}) {
  const colors = useColors();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: 12,
      }}
    >
      <Text
        style={{
          color: colors.foreground,
          fontSize: 18,
          fontFamily: "Inter_700Bold",
        }}
      >
        {title}
      </Text>
      {action}
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 40,
    gap: 8,
    minHeight: 200,
  },
  stateTitle: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    marginTop: 4,
  },
  stateText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    lineHeight: 20,
  },
});
