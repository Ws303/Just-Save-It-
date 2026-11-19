export type FigmaAccentThemeId = "sharely" | "christmas" | "collab";

export interface FigmaAccentTheme {
  id: FigmaAccentThemeId;
  name: string;
  subtitle: string;
  accent: string;
  accentStrong: string;
  accentText: string;
  swatch: string;
  soft: string;
  softBorder: string;
  previewBg: string;
}

export const FIGMA_THEME_PRESETS: Record<FigmaAccentThemeId, FigmaAccentTheme> = {
  sharely: {
    id: "sharely",
    name: "Sherlink",
    subtitle: "ธีมมาตรฐาน",
    accent: "#C72D2D",
    accentStrong: "#BE1429",
    accentText: "#A81C1C",
    swatch: "#C52732",
    soft: "#FCF0F0",
    softBorder: "#F3D2D7",
    previewBg: "#FDF0F1",
  },
  christmas: {
    id: "christmas",
    name: "คริสมาสต์",
    subtitle: "ธีมเทศกาลตัวอย่าง",
    accent: "#9B3976",
    accentStrong: "#822B61",
    accentText: "#822B61",
    swatch: "#9B3976",
    soft: "#FCEEF7",
    softBorder: "#EBC7DE",
    previewBg: "#FCEEF7",
  },
  collab: {
    id: "collab",
    name: "คอลแลบแบรนด์",
    subtitle: "ธีมร่วมกับแบรนด์ตัวอย่าง",
    accent: "#16756A",
    accentStrong: "#0F5C53",
    accentText: "#0F5C53",
    swatch: "#16756A",
    soft: "#EAF7F4",
    softBorder: "#BFE3DC",
    previewBg: "#EAF7F4",
  },
};

export const FIGMA_THEME_OPTIONS: FigmaAccentTheme[] = [
  FIGMA_THEME_PRESETS.sharely,
  FIGMA_THEME_PRESETS.christmas,
  FIGMA_THEME_PRESETS.collab,
];

export function getFigmaTheme(id?: string | null): FigmaAccentTheme {
  if (id === "christmas" || id === "collab" || id === "sharely") {
    return FIGMA_THEME_PRESETS[id];
  }
  return FIGMA_THEME_PRESETS.sharely;
}

export const FIGMA_INK = {
  bgApp: "#FFFFFF",
  bgMuted: "#F6F6F6",
  bgChip: "#EEEEEE",
  bgThumb: "#E3E3E3",
  bgCreamLogin: "#FFF8EE",
  inkPrimary: "#233642",
  inkStrong: "#222222",
  inkNavy: "#07112F",
  inkSecondary: "#61666B",
  inkSubtle: "#666666",
  inkNav: "#4F4F4F",
  borderLight: "#E6E6E6",
  borderCard: "#DDDDDD",
  borderInput: "#BBBBBB",
  lavenderBg: "#F1EEFF",
  lavenderBorder: "#E2DAFF",
  lavenderTag: "#F0ECFA",
  aiInk: "#4331A8",
} as const;
