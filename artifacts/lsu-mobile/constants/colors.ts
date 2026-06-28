/**
 * Semantic design tokens for SCOUTPRO Mobile.
 *
 * Derived from the sibling web artifact (artifacts/lsu-football/src/index.css).
 * LSU brand: purple #461D7C, gold #FDD023. HSL values from the web theme were
 * converted to hex so both artifacts share one visual identity.
 */

const colors = {
  light: {
    // Legacy aliases
    text: "#170A29",
    tint: "#461D7C",

    // Core surfaces
    background: "#ffffff",
    foreground: "#170A29",

    // Cards / elevated surfaces
    card: "#ffffff",
    cardForeground: "#170A29",

    // Primary action color
    primary: "#461D7C",
    primaryForeground: "#FDD023",

    // Secondary
    secondary: "#FDD023",
    secondaryForeground: "#461D7C",

    // Muted / subdued
    muted: "#F2F0F5",
    mutedForeground: "#71677E",

    // Accent
    accent: "#F1EEF5",
    accentForeground: "#461D7C",

    // Destructive
    destructive: "#EF4343",
    destructiveForeground: "#ffffff",

    // Borders and inputs
    border: "#E5E0EB",
    input: "#D8D1E0",

    // Fixed LSU brand colors (scheme-independent, used for hero/headers)
    brandPurple: "#461D7C",
    brandPurpleDark: "#2A1149",
    brandGold: "#FDD023",
  },

  dark: {
    text: "#FAFAFA",
    tint: "#FDD023",

    background: "#0C0613",
    foreground: "#FAFAFA",

    card: "#11091B",
    cardForeground: "#FAFAFA",

    primary: "#FDD023",
    primaryForeground: "#170A29",

    secondary: "#241736",
    secondaryForeground: "#FDD023",

    muted: "#1D122B",
    mutedForeground: "#A394B8",

    accent: "#241736",
    accentForeground: "#FAFAFA",

    destructive: "#7F1D1D",
    destructiveForeground: "#FAFAFA",

    border: "#241736",
    input: "#241736",

    brandPurple: "#461D7C",
    brandPurpleDark: "#1A0A2E",
    brandGold: "#FDD023",
  },

  // Border radius (px). Synced from web --radius: 0.5rem.
  radius: 8,
};

export default colors;
