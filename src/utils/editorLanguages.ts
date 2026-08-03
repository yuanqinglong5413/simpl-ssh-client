import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { go } from "@codemirror/lang-go";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { sql } from "@codemirror/lang-sql";
import { yaml } from "@codemirror/lang-yaml";
import { StreamLanguage } from "@codemirror/language";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { java as javaMode, c as cMode, cpp as cppMode, kotlin as kotlinMode, scala as scalaMode, dart as dartMode } from "@codemirror/legacy-modes/mode/clike";
import { xml as xmlMode } from "@codemirror/legacy-modes/mode/xml";
import { ruby as rubyMode } from "@codemirror/legacy-modes/mode/ruby";
import { lua as luaMode } from "@codemirror/legacy-modes/mode/lua";
import { perl as perlMode } from "@codemirror/legacy-modes/mode/perl";
import { powerShell as powershellMode } from "@codemirror/legacy-modes/mode/powershell";
import { r as rMode } from "@codemirror/legacy-modes/mode/r";
import { swift as swiftMode } from "@codemirror/legacy-modes/mode/swift";
import { toml as tomlMode } from "@codemirror/legacy-modes/mode/toml";
import { cmake as cmakeMode } from "@codemirror/legacy-modes/mode/cmake";
import { groovy as groovyMode } from "@codemirror/legacy-modes/mode/groovy";
import { haskell as haskellMode } from "@codemirror/legacy-modes/mode/haskell";
import { properties as propertiesMode } from "@codemirror/legacy-modes/mode/properties";
import { nginx as nginxMode } from "@codemirror/legacy-modes/mode/nginx";
import type { Extension } from "@codemirror/state";

/**
 * 文件扩展名到语言标识的映射表。
 * 用于编辑器自动检测语法高亮语言。
 */

const EXT_MAP: Record<string, string> = {
  // JavaScript / TypeScript
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",

  // Web
  html: "html",
  htm: "html",
  css: "css",
  scss: "css",
  less: "css",
  vue: "html",
  svelte: "html",

  // Data / Config
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  conf: "ini",
  env: "ini",
  xml: "xml",
  svg: "xml",

  // Systems
  rs: "rust",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cc: "cpp",
  go: "go",
  zig: "zig",

  // Scripting
  py: "python",
  pyw: "python",
  rb: "ruby",
  lua: "lua",
  pl: "perl",
  pm: "perl",

  // Shell
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  ps1: "powershell",
  psm1: "powershell",

  // Docs
  md: "markdown",
  mdx: "markdown",
  rst: "markdown",
  txt: "text",
  log: "text",

  // Database
  sql: "sql",

  // Java / Kotlin / Scala
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  scala: "scala",
  sc: "scala",
  groovy: "groovy",
  hs: "haskell",

  // Other
  php: "php",
  swift: "swift",
  dart: "dart",
  r: "r",
  R: "r",
  dockerfile: "dockerfile",
  makefile: "makefile",
  cmake: "cmake",
  nginx: "nginx",
};

export type LanguageDefinition = {
  id: string;
  label: string;
  extensions: string[];
  lspId: string;
  defaultIndent: number;
};

/** 编辑器、CodeMirror 和 LSP 共用的语言注册表。 */
export const LANGUAGE_DEFINITIONS: LanguageDefinition[] = [
  { id: "javascript", label: "JavaScript", extensions: ["js", "jsx", "mjs"], lspId: "javascript", defaultIndent: 2 },
  { id: "typescript", label: "TypeScript", extensions: ["ts", "tsx", "mts"], lspId: "typescript", defaultIndent: 2 },
  { id: "python", label: "Python", extensions: ["py", "pyw"], lspId: "python", defaultIndent: 4 },
  { id: "rust", label: "Rust", extensions: ["rs"], lspId: "rust", defaultIndent: 4 },
  { id: "go", label: "Go", extensions: ["go"], lspId: "go", defaultIndent: 8 },
  { id: "java", label: "Java", extensions: ["java"], lspId: "java", defaultIndent: 4 },
  { id: "kotlin", label: "Kotlin", extensions: ["kt", "kts"], lspId: "kotlin", defaultIndent: 4 },
  { id: "scala", label: "Scala", extensions: ["scala", "sc"], lspId: "scala", defaultIndent: 2 },
  { id: "c", label: "C", extensions: ["c", "h"], lspId: "c", defaultIndent: 4 },
  { id: "cpp", label: "C++", extensions: ["cpp", "hpp", "cc"], lspId: "cpp", defaultIndent: 4 },
  { id: "json", label: "JSON", extensions: ["json", "jsonc"], lspId: "json", defaultIndent: 2 },
  { id: "markdown", label: "Markdown", extensions: ["md", "mdx", "rst"], lspId: "markdown", defaultIndent: 2 },
  { id: "html", label: "HTML", extensions: ["html", "htm", "vue", "svelte"], lspId: "html", defaultIndent: 2 },
  { id: "xml", label: "XML", extensions: ["xml", "svg"], lspId: "xml", defaultIndent: 2 },
  { id: "css", label: "CSS", extensions: ["css", "scss", "less"], lspId: "css", defaultIndent: 2 },
  { id: "yaml", label: "YAML", extensions: ["yaml", "yml"], lspId: "yaml", defaultIndent: 2 },
  { id: "sql", label: "SQL", extensions: ["sql"], lspId: "sql", defaultIndent: 2 },
  { id: "shell", label: "Shell", extensions: ["sh", "bash", "zsh", "fish"], lspId: "shellscript", defaultIndent: 2 },
  { id: "ruby", label: "Ruby", extensions: ["rb"], lspId: "ruby", defaultIndent: 2 },
  { id: "lua", label: "Lua", extensions: ["lua"], lspId: "lua", defaultIndent: 2 },
  { id: "perl", label: "Perl", extensions: ["pl", "pm"], lspId: "perl", defaultIndent: 4 },
  { id: "powershell", label: "PowerShell", extensions: ["ps1", "psm1"], lspId: "powershell", defaultIndent: 4 },
  { id: "r", label: "R", extensions: ["r", "R"], lspId: "r", defaultIndent: 2 },
  { id: "swift", label: "Swift", extensions: ["swift"], lspId: "swift", defaultIndent: 4 },
  { id: "toml", label: "TOML", extensions: ["toml"], lspId: "toml", defaultIndent: 2 },
  { id: "cmake", label: "CMake", extensions: ["cmake"], lspId: "cmake", defaultIndent: 2 },
  { id: "groovy", label: "Groovy", extensions: ["groovy"], lspId: "groovy", defaultIndent: 4 },
  { id: "haskell", label: "Haskell", extensions: ["hs"], lspId: "haskell", defaultIndent: 2 },
  { id: "ini", label: "INI / Properties", extensions: ["ini", "conf", "env"], lspId: "ini", defaultIndent: 2 },
  { id: "nginx", label: "Nginx", extensions: ["nginx"], lspId: "nginx", defaultIndent: 2 },
  { id: "dart", label: "Dart", extensions: ["dart"], lspId: "dart", defaultIndent: 2 },
  { id: "dockerfile", label: "Dockerfile", extensions: ["dockerfile"], lspId: "dockerfile", defaultIndent: 2 },
  { id: "php", label: "PHP（通用模式）", extensions: ["php"], lspId: "php", defaultIndent: 4 },
  { id: "zig", label: "Zig（通用模式）", extensions: ["zig"], lspId: "zig", defaultIndent: 4 },
  { id: "makefile", label: "Makefile（Shell 模式）", extensions: ["makefile"], lspId: "makefile", defaultIndent: 4 },
];

/**
 * 根据文件路径推断语言标识。
 */
export function detectLanguage(filePath: string): string {
  const name = filePath.split("/").pop()?.toLowerCase() ?? "";

  // 特殊文件名
  if (name === "dockerfile") return "dockerfile";
  if (name === "makefile" || name === "gnumakefile") return "makefile";
  if (name === "cmakelists.txt") return "cmake";

  const ext = name.split(".").pop() ?? "";
  return EXT_MAP[ext] ?? "text";
}

/**
 * 获取语言显示名称。
 */
export function languageLabel(lang: string): string {
  const labels: Record<string, string> = {
    javascript: "JavaScript",
    typescript: "TypeScript",
    html: "HTML",
    css: "CSS",
    json: "JSON",
    yaml: "YAML",
    toml: "TOML",
    xml: "XML",
    rust: "Rust",
    c: "C",
    cpp: "C++",
    go: "Go",
    python: "Python",
    ruby: "Ruby",
    lua: "Lua",
    shell: "Shell",
    markdown: "Markdown",
    sql: "SQL",
    java: "Java",
    kotlin: "Kotlin",
    scala: "Scala",
    php: "PHP",
    zig: "Zig",
    swift: "Swift",
    dart: "Dart",
    powershell: "PowerShell",
    perl: "Perl",
    haskell: "Haskell",
    groovy: "Groovy",
    cmake: "CMake",
    ini: "INI / Properties",
    nginx: "Nginx",
    r: "R",
    dockerfile: "Dockerfile",
    makefile: "Makefile",
    text: "Plain Text",
  };
  return labels[lang] ?? lang;
}

export function languageDefinition(lang: string): LanguageDefinition | undefined {
  return LANGUAGE_DEFINITIONS.find((definition) => definition.id === lang);
}

export function languageServerId(lang: string): string {
  return languageDefinition(lang)?.lspId ?? lang;
}

/**
 * 语言标识 → CodeMirror 6 语言扩展。未知语言返回空（纯文本）。
 */
export function cmExtension(lang: string): Extension[] {
  switch (lang) {
    case "javascript":
      return [javascript({ jsx: true })];
    case "typescript":
      return [javascript({ jsx: true, typescript: true })];
    case "json":
      return [json()];
    case "markdown":
      return [markdown()];
    case "python":
      return [python()];
    case "rust":
      return [rust()];
    case "go":
      return [go()];
    case "java":
      return [StreamLanguage.define(javaMode)];
    case "kotlin":
      return [StreamLanguage.define(kotlinMode)];
    case "scala":
      return [StreamLanguage.define(scalaMode)];
    case "c":
      return [StreamLanguage.define(cMode)];
    case "cpp":
      return [StreamLanguage.define(cppMode)];
    case "html":
    case "vue":
    case "svelte":
      return [html()];
    case "xml":
      return [StreamLanguage.define(xmlMode)];
    case "css":
      return [css()];
    case "sql":
      return [sql()];
    case "yaml":
      return [yaml()];
    case "shell":
      return [StreamLanguage.define(shell)];
    case "dockerfile":
      return [StreamLanguage.define(dockerFile)];
    case "ruby": return [StreamLanguage.define(rubyMode)];
    case "lua": return [StreamLanguage.define(luaMode)];
    case "perl": return [StreamLanguage.define(perlMode)];
    case "powershell": return [StreamLanguage.define(powershellMode)];
    case "r": return [StreamLanguage.define(rMode)];
    case "swift": return [StreamLanguage.define(swiftMode)];
    case "toml": return [StreamLanguage.define(tomlMode)];
    case "cmake": return [StreamLanguage.define(cmakeMode)];
    case "groovy": return [StreamLanguage.define(groovyMode)];
    case "haskell": return [StreamLanguage.define(haskellMode)];
    case "ini": return [StreamLanguage.define(propertiesMode)];
    case "nginx": return [StreamLanguage.define(nginxMode)];
    case "dart": return [StreamLanguage.define(dartMode)];
    // legacy-modes 没有专用 PHP/Zig/Makefile parser，使用最接近的通用模式，
    // 同时在语言名称中明确标注，避免误认为是完整语义解析。
    case "php":
    case "zig": return [StreamLanguage.define(cppMode)];
    case "makefile": return [StreamLanguage.define(shell)];
    default:
      return [];
  }
}
