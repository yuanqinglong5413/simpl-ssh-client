// @vitest-environment jsdom
import { createRef } from "react";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PopoverMenu } from "./PopoverMenu";

describe("PopoverMenu", () => {
  it("supports arrow navigation, Escape and outside click", async () => {
    const close = vi.fn();
    const triggerRef = createRef<HTMLButtonElement>();
    const view = render(<><button ref={triggerRef}>trigger</button><PopoverMenu open onClose={close} triggerRef={triggerRef} label="menu"><button role="menuitem">one</button><button role="menuitem">two</button></PopoverMenu></>);
    const [one, two] = view.getAllByRole("menuitem");
    await waitFor(() => expect(document.activeElement).toBe(one));
    fireEvent.keyDown(one, { key: "ArrowDown" });
    expect(document.activeElement).toBe(two);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(close).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(document.body);
    expect(close).toHaveBeenCalledTimes(2);
  });
});
