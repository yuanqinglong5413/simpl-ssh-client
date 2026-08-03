import { describe, expect, it } from "vitest";
import { cmExtension, detectLanguage, languageDefinition, languageServerId, LANGUAGE_DEFINITIONS } from "./editorLanguages";

describe("editor language registry", () => {
  it("recognizes extensions and special files", () => {
    expect(detectLanguage("src/main.tsx")).toBe("typescript");
    expect(detectLanguage("Dockerfile")).toBe("dockerfile");
    expect(detectLanguage("src/Main.java")).toBe("java");
    expect(cmExtension("java").length).toBeGreaterThan(0);
    expect(detectLanguage("assets/icon.xml")).toBe("xml");
    expect(cmExtension("xml").length).toBeGreaterThan(0);
    expect(languageDefinition("python")?.lspId).toBe("python");
    expect(languageServerId("unknown")).toBe("unknown");
  });

  it("falls back to a plain editor for unsupported languages", () => {
    expect(cmExtension("made-up-language")).toEqual([]);
  });

  it("keeps every registered language connected to a highlighter", () => {
    for (const language of LANGUAGE_DEFINITIONS) {
      expect(cmExtension(language.id).length, language.id).toBeGreaterThan(0);
    }
  });
});
