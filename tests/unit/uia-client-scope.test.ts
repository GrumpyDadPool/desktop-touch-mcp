/**
 * internal #216 — `uiaClient: "classic"` reaches the bridge only inside the call that asked for it,
 * and the reply made through it says what that client costs.
 */
import { describe, it, expect } from "vitest";
import { withUiaClient, uiaClassicRequested, CLASSIC_NOTE } from "../../src/engine/uia-client-scope.js";

describe("the classic scope", () => {
  it("is on inside withUiaClient('classic') and off outside it, and for 'default' and undefined", async () => {
    expect(uiaClassicRequested()).toBe(false);
    expect(await withUiaClient("classic", async () => uiaClassicRequested())).toBe(true);
    expect(await withUiaClient("default", async () => uiaClassicRequested())).toBe(false);
    expect(await withUiaClient(undefined, async () => uiaClassicRequested())).toBe(false);
    expect(uiaClassicRequested()).toBe(false);
  });

  it("survives an await inside the call, and does not leak into a call started alongside it", async () => {
    const inside = withUiaClient("classic", async () => {
      await new Promise((r) => setTimeout(r, 5));
      return uiaClassicRequested();
    });
    const outside = (async () => {
      await new Promise((r) => setTimeout(r, 1));
      return uiaClassicRequested();
    })();
    expect(await Promise.all([inside, outside])).toEqual([true, false]);
  });
});

describe("the reply made through the classic client", () => {
  it("carries the note on its JSON; a default reply is left as it is", async () => {
    const { withClassicNote } = await import("../../src/tools/desktop-register.js");
    const reply = { content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }] };
    const classic = await withClassicNote("classic", async () => reply);
    expect(JSON.parse((classic.content[0] as { text: string }).text)).toEqual({ ok: true, uiaClient: { client: "classic", note: CLASSIC_NOTE } });
    expect(await withClassicNote(undefined, async () => reply)).toBe(reply);
  });

  it("leaves a reply that is not JSON as it is", async () => {
    const { withClassicNote } = await import("../../src/tools/desktop-register.js");
    const reply = { content: [{ type: "text" as const, text: "not json" }] };
    expect(await withClassicNote("classic", async () => reply)).toBe(reply);
  });
});
