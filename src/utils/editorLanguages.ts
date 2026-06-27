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
