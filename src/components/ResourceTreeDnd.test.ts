import { describe, expect, it } from "vitest";
import { resolveResourceDrop, type ResourceDragData, type ResourceDropData } from "./ResourceTreeDnd";

const source: ResourceDragData = { treeKind: "connection", nodeType: "item", id: "a", parentId: "g", position: 0, label: "A" };

describe("resource tree drop projection", () => {
  it("adjusts same-parent indices after removing the source", () => {
    const target: ResourceDropData = { treeKind: "connection", targetType: "item", targetId: "c", parentId: "g", position: 2, mode: "before" };
    expect(resolveResourceDrop(source, target)).toEqual({ parentId: "g", position: 1 });
  });
  it("moves an item inside a group and to root", () => {
    expect(resolveResourceDrop(source, { treeKind: "connection", targetType: "group", targetId: "new", parentId: "new", position: 0, mode: "inside" }))
      .toEqual({ parentId: "new", position: Number.MAX_SAFE_INTEGER });
    expect(resolveResourceDrop(source, { treeKind: "connection", targetType: "root", parentId: null, position: 0, mode: "root" }))
      .toEqual({ parentId: null, position: Number.MAX_SAFE_INTEGER });
  });
  it("rejects cross-tree and mixed before/after targets", () => {
    expect(resolveResourceDrop(source, { treeKind: "project", targetType: "item", targetId: "x", parentId: null, position: 0, mode: "before" })).toBeNull();
    expect(resolveResourceDrop(source, { treeKind: "connection", targetType: "group", targetId: "x", parentId: null, position: 0, mode: "before" })).toBeNull();
  });
});
