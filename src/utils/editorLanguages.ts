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

  // Other
  php: "php",
  swift: "swift",
  dart: "dart",
  r: "r",
  R: "r",
  dockerfile: "dockerfile",
  makefile: "makefile",
  cmake: "cmake",
};

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
    swift: "Swift",
    dart: "Dart",
    r: "R",
    dockerfile: "Dockerfile",
    makefile: "Makefile",
    text: "Plain Text",
  };
  return labels[lang] ?? lang;
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
    case "html":
    case "vue":
    case "svelte":
      return [html()];
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
    default:
      return [];
  }
}
