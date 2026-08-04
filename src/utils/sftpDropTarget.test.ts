// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { logicalDropPoint, resolveSftpDropTarget } from "./sftpDropTarget";

describe("SFTP operating-system drop targeting", () => {
  it("converts physical webview coordinates to CSS coordinates", () => {
    expect(logicalDropPoint({ x: 400, y: 240 }, 2)).toEqual({ x: 200, y: 120 });
  });
  it("only accepts the remote panel and prefers a hovered directory", () => {
    const panel = document.createElement("div");
    const directory = document.createElement("div");
    directory.dataset.sftpDropDir = "/srv/app";
    const child = document.createElement("span");
    directory.append(child); panel.append(directory); document.body.append(panel);
    expect(resolveSftpDropTarget(child, panel, "/srv")).toBe("/srv/app");
    expect(resolveSftpDropTarget(panel, panel, "/srv")).toBe("/srv");
    expect(resolveSftpDropTarget(document.body, panel, "/srv")).toBeNull();
  });
});
