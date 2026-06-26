import type { AnsiPalette } from "./types";
import { buildAppVars, buildTerminalTheme, makeTheme } from "./build";
import type { AppTheme } from "./types";
import { DEFAULT_THEME_ID } from "./types";

/* ------------------------------------------------------------------ ANSI 调色板预设 */

const ANSI_DEFAULT: AnsiPalette = {
  black: "#1a1f2b",
  red: "#ff5c5c",
  green: "#3fd9a0",
  yellow: "#ff9f1c",
  blue: "#5b9cf5",
  magenta: "#c678dd",
  cyan: "#56b6c2",
  white: "#e6e9f0",
  brightBlack: "#6b7388",
  brightRed: "#ff8080",
  brightGreen: "#6ee7b7",
  brightYellow: "#ffb13d",
  brightBlue: "#82b1ff",
  brightMagenta: "#e0a8f0",
  brightCyan: "#7dd3fc",
  brightWhite: "#ffffff",
};

const ANSI_DRACULA: AnsiPalette = {
  black: "#21222c",
  red: "#ff5555",
  green: "#50fa7b",
  yellow: "#f1fa8c",
  blue: "#bd93f9",
  magenta: "#ff79c6",
  cyan: "#8be9fd",
  white: "#f8f8f2",
  brightBlack: "#6272a4",
  brightRed: "#ff6e6e",
  brightGreen: "#69ff94",
  brightYellow: "#ffffa5",
  brightBlue: "#d6acff",
  brightMagenta: "#ff92df",
  brightCyan: "#a4ffff",
  brightWhite: "#ffffff",
};

const ANSI_NORD: AnsiPalette = {
  black: "#3b4252",
  red: "#bf616a",
  green: "#a3be8c",
  yellow: "#ebcb8b",
  blue: "#81a1c1",
  magenta: "#b48ead",
  cyan: "#88c0d0",
  white: "#eceff4",
  brightBlack: "#4c566a",
  brightRed: "#d08770",
  brightGreen: "#a3be8c",
  brightYellow: "#ebcb8b",
  brightBlue: "#81a1c1",
  brightMagenta: "#b48ead",
  brightCyan: "#8fbcbb",
  brightWhite: "#eceff4",
};

const ANSI_ONE_DARK: AnsiPalette = {
  black: "#282c34",
  red: "#e06c75",
  green: "#98c379",
  yellow: "#e5c07b",
  blue: "#61afef",
  magenta: "#c678dd",
  cyan: "#56b6c2",
  white: "#abb2bf",
  brightBlack: "#5c6370",
  brightRed: "#e06c75",
  brightGreen: "#98c379",
  brightYellow: "#e5c07b",
  brightBlue: "#61afef",
  brightMagenta: "#c678dd",
  brightCyan: "#56b6c2",
  brightWhite: "#ffffff",
};

const ANSI_GRUVBOX: AnsiPalette = {
  black: "#282828",
  red: "#cc241d",
  green: "#98971a",
  yellow: "#d79921",
  blue: "#458588",
  magenta: "#b16286",
  cyan: "#689d6a",
  white: "#ebdbb2",
  brightBlack: "#928374",
  brightRed: "#fb4934",
  brightGreen: "#b8bb26",
  brightYellow: "#fabd2f",
  brightBlue: "#83a598",
  brightMagenta: "#d3869b",
  brightCyan: "#8ec07c",
  brightWhite: "#fbf1c7",
};

const ANSI_SOLARIZED_DARK: AnsiPalette = {
  black: "#073642",
  red: "#dc322f",
  green: "#859900",
  yellow: "#b58900",
  blue: "#268bd2",
  magenta: "#d33682",
  cyan: "#2aa198",
  white: "#eee8d5",
  brightBlack: "#002b36",
  brightRed: "#cb4b16",
  brightGreen: "#586e75",
  brightYellow: "#657b83",
  brightBlue: "#839496",
  brightMagenta: "#6c71c4",
  brightCyan: "#93a1a1",
  brightWhite: "#fdf6e3",
};

const ANSI_SOLARIZED_LIGHT: AnsiPalette = {
  black: "#073642",
  red: "#dc322f",
  green: "#859900",
  yellow: "#b58900",
  blue: "#268bd2",
  magenta: "#d33682",
  cyan: "#2aa198",
  white: "#586e75",
  brightBlack: "#839496",
  brightRed: "#cb4b16",
  brightGreen: "#586e75",
  brightYellow: "#657b83",
  brightBlue: "#839496",
  brightMagenta: "#6c71c4",
  brightCyan: "#93a1a1",
  brightWhite: "#fdf6e3",
};

const ANSI_MONOKAI: AnsiPalette = {
  black: "#272822",
  red: "#f92672",
  green: "#a6e22e",
  yellow: "#f4bf75",
  blue: "#66d9ef",
  magenta: "#ae81ff",
  cyan: "#a1efe4",
  white: "#f8f8f2",
  brightBlack: "#75715e",
  brightRed: "#f92672",
  brightGreen: "#a6e22e",
  brightYellow: "#f4bf75",
  brightBlue: "#66d9ef",
  brightMagenta: "#ae81ff",
  brightCyan: "#a1efe4",
  brightWhite: "#f9f8f5",
};

const ANSI_TOKYO_NIGHT: AnsiPalette = {
  black: "#15161e",
  red: "#f7768e",
  green: "#9ece6a",
  yellow: "#e0af68",
  blue: "#7aa2f7",
  magenta: "#bb9af7",
  cyan: "#7dcfff",
  white: "#c0caf5",
  brightBlack: "#565f89",
  brightRed: "#f7768e",
  brightGreen: "#9ece6a",
  brightYellow: "#e0af68",
  brightBlue: "#7aa2f7",
  brightMagenta: "#bb9af7",
  brightCyan: "#7dcfff",
  brightWhite: "#ffffff",
};

const ANSI_CATPPUCCIN_MOCHA: AnsiPalette = {
  black: "#45475a",
  red: "#f38ba8",
  green: "#a6e3a1",
  yellow: "#f9e2af",
  blue: "#89b4fa",
  magenta: "#f5c2e7",
  cyan: "#94e2d5",
  white: "#cdd6f4",
  brightBlack: "#585b70",
  brightRed: "#f38ba8",
  brightGreen: "#a6e3a1",
  brightYellow: "#f9e2af",
  brightBlue: "#89b4fa",
  brightMagenta: "#f5c2e7",
  brightCyan: "#94e2d5",
  brightWhite: "#ffffff",
};

const ANSI_CATPPUCCIN_LATTE: AnsiPalette = {
  black: "#5c5f77",
  red: "#d20f39",
  green: "#40a02b",
  yellow: "#df8e1d",
  blue: "#1e66f5",
  magenta: "#ea76cb",
  cyan: "#179299",
  white: "#4c4f69",
  brightBlack: "#6c6f85",
  brightRed: "#d20f39",
  brightGreen: "#40a02b",
  brightYellow: "#df8e1d",
  brightBlue: "#1e66f5",
  brightMagenta: "#ea76cb",
  brightCyan: "#179299",
  brightWhite: "#eff1f5",
};

const ANSI_AYU_DARK: AnsiPalette = {
  black: "#0d1017",
  red: "#f07178",
  green: "#c2d94c",
  yellow: "#ffb454",
  blue: "#59c2ff",
  magenta: "#d2a6ff",
  cyan: "#95e6cb",
  white: "#bfbdb6",
  brightBlack: "#626a73",
  brightRed: "#f07178",
  brightGreen: "#c2d94c",
  brightYellow: "#ffb454",
  brightBlue: "#59c2ff",
  brightMagenta: "#d2a6ff",
  brightCyan: "#95e6cb",
  brightWhite: "#e6e1cf",
};

const ANSI_EVERFOREST: AnsiPalette = {
  black: "#414d41",
  red: "#e67e80",
  green: "#a7c080",
  yellow: "#dbbc7f",
  blue: "#7fbbb3",
  magenta: "#d699b6",
  cyan: "#83c092",
  white: "#d3c6aa",
  brightBlack: "#859289",
  brightRed: "#e67e80",
  brightGreen: "#a7c080",
  brightYellow: "#dbbc7f",
  brightBlue: "#7fbbb3",
  brightMagenta: "#d699b6",
  brightCyan: "#83c092",
  brightWhite: "#fdf6e3",
};

const ANSI_ROSE_PINE: AnsiPalette = {
  black: "#26233a",
  red: "#eb6f92",
  green: "#31748f",
  yellow: "#f6c177",
  blue: "#9ccfd8",
  magenta: "#c4a7e7",
  cyan: "#ebbcba",
  white: "#e0def4",
  brightBlack: "#6e6a86",
  brightRed: "#eb6f92",
  brightGreen: "#31748f",
  brightYellow: "#f6c177",
  brightBlue: "#9ccfd8",
  brightMagenta: "#c4a7e7",
  brightCyan: "#ebbcba",
  brightWhite: "#ffffff",
};

const ANSI_GITHUB_DARK: AnsiPalette = {
  black: "#484f58",
  red: "#ff7b72",
  green: "#3fb950",
  yellow: "#d29922",
  blue: "#58a6ff",
  magenta: "#bc8cff",
  cyan: "#39c5cf",
  white: "#c9d1d9",
  brightBlack: "#6e7681",
  brightRed: "#ffa198",
  brightGreen: "#56d364",
  brightYellow: "#e3b341",
  brightBlue: "#79c0ff",
  brightMagenta: "#d2a8ff",
  brightCyan: "#56d4dd",
  brightWhite: "#ffffff",
};

const ANSI_MATERIAL: AnsiPalette = {
  black: "#263238",
  red: "#ff5370",
  green: "#c3e88d",
  yellow: "#ffcb6b",
  blue: "#82aaff",
  magenta: "#c792ea",
  cyan: "#89ddff",
  white: "#eeffff",
  brightBlack: "#546e7a",
  brightRed: "#ff5370",
  brightGreen: "#c3e88d",
  brightYellow: "#ffcb6b",
  brightBlue: "#82aaff",
  brightMagenta: "#c792ea",
  brightCyan: "#89ddff",
  brightWhite: "#ffffff",
};

const ANSI_COBALT2: AnsiPalette = {
  black: "#000000",
  red: "#ff0000",
  green: "#38de21",
  yellow: "#ffe50a",
  blue: "#1460d2",
  magenta: "#ff008d",
  cyan: "#00bbbb",
  white: "#ffffff",
  brightBlack: "#555555",
  brightRed: "#f40e17",
  brightGreen: "#3bd01d",
  brightYellow: "#edc809",
  brightBlue: "#11b5f4",
  brightMagenta: "#ed0d68",
  brightCyan: "#00a8c6",
  brightWhite: "#ffffff",
};

const ANSI_SNAZZY: AnsiPalette = {
  black: "#000000",
  red: "#ff5c57",
  green: "#5af78e",
  yellow: "#f3f99d",
  blue: "#57c7ff",
  magenta: "#ff6ac1",
  cyan: "#9aedfe",
  white: "#f1f1f0",
  brightBlack: "#686868",
  brightRed: "#ff5c57",
  brightGreen: "#5af78e",
  brightYellow: "#f3f99d",
  brightBlue: "#57c7ff",
  brightMagenta: "#ff6ac1",
  brightCyan: "#9aedfe",
  brightWhite: "#ffffff",
};

const ANSI_NIGHT_OWL: AnsiPalette = {
  black: "#011627",
  red: "#ef5350",
  green: "#22da6e",
  yellow: "#c5e478",
  blue: "#82aaff",
  magenta: "#c792ea",
  cyan: "#21c7a8",
  white: "#d6deeb",
  brightBlack: "#637777",
  brightRed: "#ef5350",
  brightGreen: "#22da6e",
  brightYellow: "#ffeb95",
  brightBlue: "#82aaff",
  brightMagenta: "#c792ea",
  brightCyan: "#21c7a8",
  brightWhite: "#ffffff",
};

const ANSI_PALENIGHT: AnsiPalette = {
  black: "#292d3e",
  red: "#f07178",
  green: "#c3e88d",
  yellow: "#ffcb6b",
  blue: "#82aaff",
  magenta: "#c792ea",
  cyan: "#89ddff",
  white: "#a6accd",
  brightBlack: "#676e95",
  brightRed: "#f07178",
  brightGreen: "#c3e88d",
  brightYellow: "#ffcb6b",
  brightBlue: "#82aaff",
  brightMagenta: "#c792ea",
  brightCyan: "#89ddff",
  brightWhite: "#ffffff",
};

const ANSI_HIGH_CONTRAST: AnsiPalette = {
  black: "#000000",
  red: "#ff0000",
  green: "#00ff00",
  yellow: "#ffff00",
  blue: "#0000ff",
  magenta: "#ff00ff",
  cyan: "#00ffff",
  white: "#ffffff",
  brightBlack: "#808080",
  brightRed: "#ff4444",
  brightGreen: "#44ff44",
  brightYellow: "#ffff44",
  brightBlue: "#4444ff",
  brightMagenta: "#ff44ff",
  brightCyan: "#44ffff",
  brightWhite: "#ffffff",
};

/* ------------------------------------------------------------------ 20 套主题 */

export const themes: AppTheme[] = [
  // 1. 默认：深墨 + 琥珀（当前设计）
  makeTheme(
    "ink-amber",
    "深墨琥珀",
    buildAppVars({
      bg: "#0b0d12",
      panel: "#11141c",
      panel2: "#161a24",
      panel3: "#1c2230",
      border: "#232838",
      borderSoft: "#1a1f2b",
      text: "#e6e9f0",
      textDim: "#a8aec0",
      muted: "#6b7388",
      accent: "#ff9f1c",
      accentHover: "#ffb13d",
      green: "#3fd9a0",
      red: "#ff5c5c",
      scrollbarHover: "#2f3650",
      brandMarkFg: "#1a1205",
      btnPrimaryFg: "#1a1205",
    }),
    buildTerminalTheme("#0b0d12", "#e6e9f0", "#ff9f1c", "#ff9f1c", ANSI_DEFAULT)
  ),

  // 2. Dracula
  makeTheme(
    "dracula",
    "Dracula",
    buildAppVars({
      bg: "#282a36",
      panel: "#21222c",
      panel2: "#282a36",
      panel3: "#343746",
      border: "#44475a",
      borderSoft: "#383a4a",
      text: "#f8f8f2",
      textDim: "#bd93f9",
      muted: "#6272a4",
      accent: "#ff79c6",
      accentHover: "#ff92df",
      green: "#50fa7b",
      red: "#ff5555",
    }),
    buildTerminalTheme("#282a36", "#f8f8f2", "#ff79c6", "#ff79c6", ANSI_DRACULA)
  ),

  // 3. Nord
  makeTheme(
    "nord",
    "Nord",
    buildAppVars({
      bg: "#2e3440",
      panel: "#3b4252",
      panel2: "#434c5e",
      panel3: "#4c566a",
      border: "#4c566a",
      borderSoft: "#434c5e",
      text: "#eceff4",
      textDim: "#d8dee9",
      muted: "#81a1c1",
      accent: "#88c0d0",
      accentHover: "#8fbcbb",
      green: "#a3be8c",
      red: "#bf616a",
    }),
    buildTerminalTheme("#2e3440", "#eceff4", "#88c0d0", "#88c0d0", ANSI_NORD)
  ),

  // 4. One Dark
  makeTheme(
    "one-dark",
    "One Dark",
    buildAppVars({
      bg: "#282c34",
      panel: "#21252b",
      panel2: "#282c34",
      panel3: "#2c313a",
      border: "#3e4451",
      borderSoft: "#353b45",
      text: "#abb2bf",
      textDim: "#828997",
      muted: "#5c6370",
      accent: "#61afef",
      accentHover: "#82b1ff",
      green: "#98c379",
      red: "#e06c75",
    }),
    buildTerminalTheme("#282c34", "#abb2bf", "#61afef", "#61afef", ANSI_ONE_DARK)
  ),

  // 5. Gruvbox Dark
  makeTheme(
    "gruvbox-dark",
    "Gruvbox Dark",
    buildAppVars({
      bg: "#282828",
      panel: "#1d2021",
      panel2: "#282828",
      panel3: "#32302f",
      border: "#504945",
      borderSoft: "#3c3836",
      text: "#ebdbb2",
      textDim: "#d5c4a1",
      muted: "#928374",
      accent: "#fabd2f",
      accentHover: "#fe8019",
      green: "#b8bb26",
      red: "#fb4934",
    }),
    buildTerminalTheme("#282828", "#ebdbb2", "#fabd2f", "#fabd2f", ANSI_GRUVBOX)
  ),

  // 6. Solarized Dark
  makeTheme(
    "solarized-dark",
    "Solarized Dark",
    buildAppVars({
      bg: "#002b36",
      panel: "#073642",
      panel2: "#002b36",
      panel3: "#0a4050",
      border: "#586e75",
      borderSoft: "#073642",
      text: "#839496",
      textDim: "#657b83",
      muted: "#586e75",
      accent: "#268bd2",
      accentHover: "#2aa198",
      green: "#859900",
      red: "#dc322f",
    }),
    buildTerminalTheme("#002b36", "#839496", "#268bd2", "#268bd2", ANSI_SOLARIZED_DARK)
  ),

  // 7. Solarized Light
  makeTheme(
    "solarized-light",
    "Solarized Light",
    buildAppVars({
      bg: "#fdf6e3",
      panel: "#eee8d5",
      panel2: "#fdf6e3",
      panel3: "#e8e2d0",
      border: "#93a1a1",
      borderSoft: "#d6d0c0",
      text: "#586e75",
      textDim: "#657b83",
      muted: "#839496",
      accent: "#268bd2",
      accentHover: "#2aa198",
      green: "#859900",
      red: "#dc322f",
      overlayBg: "rgba(253, 246, 227, 0.75)",
      brandMarkFg: "#fdf6e3",
      btnPrimaryFg: "#fdf6e3",
    }),
    buildTerminalTheme("#fdf6e3", "#586e75", "#268bd2", "#268bd2", ANSI_SOLARIZED_LIGHT),
    true
  ),

  // 8. Monokai
  makeTheme(
    "monokai",
    "Monokai",
    buildAppVars({
      bg: "#272822",
      panel: "#1e1f1c",
      panel2: "#272822",
      panel3: "#3e3d32",
      border: "#49483e",
      borderSoft: "#3e3d32",
      text: "#f8f8f2",
      textDim: "#cfcfc2",
      muted: "#75715e",
      accent: "#f92672",
      accentHover: "#fd5ff0",
      green: "#a6e22e",
      red: "#f92672",
    }),
    buildTerminalTheme("#272822", "#f8f8f2", "#f92672", "#f92672", ANSI_MONOKAI)
  ),

  // 9. Tokyo Night
  makeTheme(
    "tokyo-night",
    "Tokyo Night",
    buildAppVars({
      bg: "#1a1b26",
      panel: "#16161e",
      panel2: "#1a1b26",
      panel3: "#24283b",
      border: "#414868",
      borderSoft: "#292e42",
      text: "#c0caf5",
      textDim: "#a9b1d6",
      muted: "#565f89",
      accent: "#7aa2f7",
      accentHover: "#89b4fa",
      green: "#9ece6a",
      red: "#f7768e",
    }),
    buildTerminalTheme("#1a1b26", "#c0caf5", "#7aa2f7", "#7aa2f7", ANSI_TOKYO_NIGHT)
  ),

  // 10. Catppuccin Mocha
  makeTheme(
    "catppuccin-mocha",
    "Catppuccin Mocha",
    buildAppVars({
      bg: "#1e1e2e",
      panel: "#181825",
      panel2: "#1e1e2e",
      panel3: "#313244",
      border: "#45475a",
      borderSoft: "#313244",
      text: "#cdd6f4",
      textDim: "#bac2de",
      muted: "#6c7086",
      accent: "#89b4fa",
      accentHover: "#b4befe",
      green: "#a6e3a1",
      red: "#f38ba8",
    }),
    buildTerminalTheme("#1e1e2e", "#cdd6f4", "#89b4fa", "#89b4fa", ANSI_CATPPUCCIN_MOCHA)
  ),

  // 11. Catppuccin Latte
  makeTheme(
    "catppuccin-latte",
    "Catppuccin Latte",
    buildAppVars({
      bg: "#eff1f5",
      panel: "#e6e9ef",
      panel2: "#eff1f5",
      panel3: "#dce0e8",
      border: "#bcc0cc",
      borderSoft: "#dce0e8",
      text: "#4c4f69",
      textDim: "#5c5f77",
      muted: "#8c8fa1",
      accent: "#1e66f5",
      accentHover: "#209fb5",
      green: "#40a02b",
      red: "#d20f39",
      overlayBg: "rgba(239, 241, 245, 0.75)",
      brandMarkFg: "#eff1f5",
      btnPrimaryFg: "#eff1f5",
    }),
    buildTerminalTheme("#eff1f5", "#4c4f69", "#1e66f5", "#1e66f5", ANSI_CATPPUCCIN_LATTE),
    true
  ),

  // 12. Ayu Dark
  makeTheme(
    "ayu-dark",
    "Ayu Dark",
    buildAppVars({
      bg: "#0a0e14",
      panel: "#0d1017",
      panel2: "#0a0e14",
      panel3: "#131721",
      border: "#253340",
      borderSoft: "#1a2332",
      text: "#bfbdb6",
      textDim: "#8a8987",
      muted: "#626a73",
      accent: "#ffb454",
      accentHover: "#ff9940",
      green: "#c2d94c",
      red: "#f07178",
    }),
    buildTerminalTheme("#0a0e14", "#bfbdb6", "#ffb454", "#ffb454", ANSI_AYU_DARK)
  ),

  // 13. Everforest
  makeTheme(
    "everforest",
    "Everforest",
    buildAppVars({
      bg: "#2d353b",
      panel: "#272e33",
      panel2: "#2d353b",
      panel3: "#343f44",
      border: "#4f585e",
      borderSoft: "#3d484d",
      text: "#d3c6aa",
      textDim: "#a7c080",
      muted: "#859289",
      accent: "#dbbc7f",
      accentHover: "#e69875",
      green: "#a7c080",
      red: "#e67e80",
    }),
    buildTerminalTheme("#2d353b", "#d3c6aa", "#dbbc7f", "#dbbc7f", ANSI_EVERFOREST)
  ),

  // 14. Rosé Pine
  makeTheme(
    "rose-pine",
    "Rosé Pine",
    buildAppVars({
      bg: "#191724",
      panel: "#1f1d2e",
      panel2: "#191724",
      panel3: "#26233a",
      border: "#403d52",
      borderSoft: "#26233a",
      text: "#e0def4",
      textDim: "#908caa",
      muted: "#6e6a86",
      accent: "#c4a7e7",
      accentHover: "#eb6f92",
      green: "#31748f",
      red: "#eb6f92",
    }),
    buildTerminalTheme("#191724", "#e0def4", "#c4a7e7", "#c4a7e7", ANSI_ROSE_PINE)
  ),

  // 15. GitHub Dark
  makeTheme(
    "github-dark",
    "GitHub Dark",
    buildAppVars({
      bg: "#0d1117",
      panel: "#161b22",
      panel2: "#0d1117",
      panel3: "#21262d",
      border: "#30363d",
      borderSoft: "#21262d",
      text: "#c9d1d9",
      textDim: "#8b949e",
      muted: "#6e7681",
      accent: "#58a6ff",
      accentHover: "#79c0ff",
      green: "#3fb950",
      red: "#ff7b72",
    }),
    buildTerminalTheme("#0d1117", "#c9d1d9", "#58a6ff", "#58a6ff", ANSI_GITHUB_DARK)
  ),

  // 16. Material
  makeTheme(
    "material",
    "Material",
    buildAppVars({
      bg: "#263238",
      panel: "#1e272c",
      panel2: "#263238",
      panel3: "#2e3c43",
      border: "#37474f",
      borderSoft: "#2e3c43",
      text: "#eeffff",
      textDim: "#546e7a",
      muted: "#546e7a",
      accent: "#82aaff",
      accentHover: "#89ddff",
      green: "#c3e88d",
      red: "#ff5370",
    }),
    buildTerminalTheme("#263238", "#eeffff", "#82aaff", "#82aaff", ANSI_MATERIAL)
  ),

  // 17. Cobalt2
  makeTheme(
    "cobalt2",
    "Cobalt2",
    buildAppVars({
      bg: "#193549",
      panel: "#122738",
      panel2: "#193549",
      panel3: "#1f4662",
      border: "#234e6d",
      borderSoft: "#1f4662",
      text: "#ffffff",
      textDim: "#aaaaaa",
      muted: "#888888",
      accent: "#ffc600",
      accentHover: "#ffe50a",
      green: "#38de21",
      red: "#ff0000",
    }),
    buildTerminalTheme("#193549", "#ffffff", "#ffc600", "#ffc600", ANSI_COBALT2)
  ),

  // 18. Snazzy
  makeTheme(
    "snazzy",
    "Snazzy",
    buildAppVars({
      bg: "#282a36",
      panel: "#1e1f29",
      panel2: "#282a36",
      panel3: "#34353f",
      border: "#44475a",
      borderSoft: "#34353f",
      text: "#eff0eb",
      textDim: "#a0a0a0",
      muted: "#686868",
      accent: "#57c7ff",
      accentHover: "#9aedfe",
      green: "#5af78e",
      red: "#ff5c57",
    }),
    buildTerminalTheme("#282a36", "#eff0eb", "#57c7ff", "#57c7ff", ANSI_SNAZZY)
  ),

  // 19. Night Owl
  makeTheme(
    "night-owl",
    "Night Owl",
    buildAppVars({
      bg: "#011627",
      panel: "#0b2942",
      panel2: "#011627",
      panel3: "#1d3b53",
      border: "#234d70",
      borderSoft: "#1d3b53",
      text: "#d6deeb",
      textDim: "#637777",
      muted: "#5f7e97",
      accent: "#82aaff",
      accentHover: "#c792ea",
      green: "#22da6e",
      red: "#ef5350",
    }),
    buildTerminalTheme("#011627", "#d6deeb", "#82aaff", "#82aaff", ANSI_NIGHT_OWL)
  ),

  // 20. Palenight
  makeTheme(
    "palenight",
    "Palenight",
    buildAppVars({
      bg: "#292d3e",
      panel: "#242837",
      panel2: "#292d3e",
      panel3: "#34394f",
      border: "#4b526d",
      borderSoft: "#34394f",
      text: "#a6accd",
      textDim: "#676e95",
      muted: "#676e95",
      accent: "#c792ea",
      accentHover: "#ffcb6b",
      green: "#c3e88d",
      red: "#f07178",
    }),
    buildTerminalTheme("#292d3e", "#a6accd", "#c792ea", "#c792ea", ANSI_PALENIGHT)
  ),

  // 21. 高对比度（无障碍）
  makeTheme(
    "high-contrast",
    "高对比度",
    buildAppVars({
      bg: "#000000",
      panel: "#0a0a0a",
      panel2: "#000000",
      panel3: "#1a1a1a",
      border: "#ffffff",
      borderSoft: "#333333",
      text: "#ffffff",
      textDim: "#cccccc",
      muted: "#999999",
      accent: "#ffff00",
      accentHover: "#ffff44",
      green: "#00ff00",
      red: "#ff0000",
      scrollbarHover: "#666666",
      brandMarkFg: "#000000",
      btnPrimaryFg: "#000000",
    }),
    buildTerminalTheme("#000000", "#ffffff", "#ffff00", "#ffff00", ANSI_HIGH_CONTRAST)
  ),
];

/** 按 id 查找主题，找不到则回退默认 */
export function getTheme(id: string): AppTheme {
  return themes.find((t) => t.id === id) ?? themes.find((t) => t.id === DEFAULT_THEME_ID)!;
}

export { DEFAULT_THEME_ID, THEME_STORAGE_KEY } from "./types";
