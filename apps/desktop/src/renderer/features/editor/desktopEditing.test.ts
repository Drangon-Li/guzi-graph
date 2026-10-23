import { KEYS } from "@excalidraw/common";

import { handleDesktopEditingCommand } from "./desktopEditing";

describe("desktop undo routing", () => {
  let root: HTMLDivElement;
  const editText = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    root = document.createElement("div");
    root.innerHTML =
      '<section class="desktop-editor-pane is-active"><div class="excalidraw"></div></section>';
    document.body.append(root);
    window.desktop = { editText } as any;
    editText.mockClear();
  });

  afterEach(() => root.remove());

  it.each(["undo", "redo"] as const)(
    "routes %s to native text editing while a dialog is open",
    async (command) => {
      const input = document.createElement("textarea");
      root.append(input);
      input.focus();
      const keydown = vi.fn();
      root.addEventListener("keydown", keydown);
      await handleDesktopEditingCommand(root, command, {
        canvasActive: true,
        blocked: true,
      });
      expect(editText).toHaveBeenCalledTimes(1);
      expect(editText).toHaveBeenCalledWith(command);
      expect(keydown).not.toHaveBeenCalled();
    },
  );

  it.each(["undo", "redo"] as const)(
    "delivers %s once to the active canvas after text editing ends",
    async (command) => {
      const editor = root.querySelector(".excalidraw")!;
      const events: KeyboardEvent[] = [];
      const keydown = (event: KeyboardEvent) => events.push(event);
      document.addEventListener("keydown", keydown);
      try {
        await handleDesktopEditingCommand(root, command, {
          canvasActive: true,
          blocked: false,
        });
        expect(events).toHaveLength(1);
        expect(events[0].target).toBe(editor);
        expect(events[0][KEYS.CTRL_OR_CMD]).toBe(true);
        expect(events[0].shiftKey).toBe(command === "redo");
        expect(editText).not.toHaveBeenCalled();
      } finally {
        document.removeEventListener("keydown", keydown);
      }
    },
  );

  it("does not undo a hidden or blocked canvas", async () => {
    const keydown = vi.fn();
    root.addEventListener("keydown", keydown);
    for (const options of [
      { canvasActive: false, blocked: false },
      { canvasActive: true, blocked: true },
    ]) {
      await handleDesktopEditingCommand(root, "undo", options);
    }
    expect(keydown).not.toHaveBeenCalled();
    expect(editText).not.toHaveBeenCalled();
  });

  it.each(["undo", "redo"] as const)(
    "routes %s to the focused thumbnail ahead of the open child editor",
    async (command) => {
      const pane = root.querySelector(".desktop-editor-pane")!;
      pane.insertAdjacentHTML(
        "beforeend",
        '<div class="desktop-subcanvas"><div class="excalidraw"></div></div><aside class="desktop-presentation-filmstrip"><button>Slide</button></aside>',
      );
      const thumbnail = pane.querySelector("button")!;
      thumbnail.focus();
      const events: KeyboardEvent[] = [];
      root.addEventListener("keydown", (event) => events.push(event));
      await handleDesktopEditingCommand(root, command, {
        canvasActive: true,
        blocked: false,
      });
      expect(events).toHaveLength(1);
      expect(events[0].target).toBe(thumbnail);
      expect(events[0][KEYS.CTRL_OR_CMD]).toBe(true);
      expect(events[0].shiftKey).toBe(command === "redo");
      expect(editText).not.toHaveBeenCalled();
    },
  );

  it("routes thumbnail history while the editor is mounting and keeps title undo native", async () => {
    root.innerHTML =
      '<section class="desktop-editor-pane is-active"><aside class="desktop-presentation-filmstrip"><button>Slide</button><input /></aside></section>';
    const thumbnail = root.querySelector("button")!;
    thumbnail.focus();
    const keydown = vi.fn();
    thumbnail.addEventListener("keydown", keydown);
    await handleDesktopEditingCommand(root, "undo", {
      canvasActive: true,
      blocked: false,
    });
    expect(keydown).toHaveBeenCalledTimes(1);
    root.querySelector("input")!.focus();
    await handleDesktopEditingCommand(root, "redo", {
      canvasActive: true,
      blocked: false,
    });
    expect(keydown).toHaveBeenCalledTimes(1);
    expect(editText).toHaveBeenCalledWith("redo");
  });

  it("keeps child editor routing when focus is outside the active filmstrip", async () => {
    root
      .querySelector(".desktop-editor-pane")!
      .insertAdjacentHTML(
        "beforeend",
        '<div class="desktop-subcanvas"><div class="excalidraw"></div></div>',
      );
    root.insertAdjacentHTML(
      "beforeend",
      '<section class="desktop-editor-pane"><aside class="desktop-presentation-filmstrip"><button>Hidden slide</button></aside></section>',
    );
    root.querySelector("button")!.focus();
    const events: KeyboardEvent[] = [];
    root.addEventListener("keydown", (event) => events.push(event));
    await handleDesktopEditingCommand(root, "undo", {
      canvasActive: true,
      blocked: false,
    });
    expect(events).toHaveLength(1);
    expect(events[0].target).toBe(
      root.querySelector(".desktop-subcanvas .excalidraw"),
    );
  });

  it("does not redirect readonly input undo into canvas history", async () => {
    const input = document.createElement("input");
    input.readOnly = true;
    root.append(input);
    input.focus();
    const keydown = vi.fn();
    root.addEventListener("keydown", keydown);
    await handleDesktopEditingCommand(root, "undo", {
      canvasActive: true,
      blocked: false,
    });
    expect(editText).not.toHaveBeenCalled();
    expect(keydown).not.toHaveBeenCalled();
  });
});
