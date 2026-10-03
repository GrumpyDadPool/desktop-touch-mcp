/**
 * internal #216 — `uiaClient: "classic"` reaches the bridge only inside the call that asked for it,
 * and the reply made through it says what that client costs.
 */
import { describe, it, expect } from "vitest";
import { withUiaClient, uiaClassicRequested, markClassicUsed, markClassicRefused, CLASSIC_NOTE, CLASSIC_NOTE_NOT_USED } from "../../src/engine/uia-client-scope.js";

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
  it("says it came from the classic client only when a native call went there (gate 2 on 74d5f6bc)", async () => {
    const { withClassicNote } = await import("../../src/tools/desktop-register.js");
    const reply = { content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }] };
    const used = await withClassicNote("classic", async () => { markClassicUsed(); return reply; });
    expect(JSON.parse((used.content[0] as { text: string }).text)).toEqual({ ok: true, uiaClient: { client: "classic", used: true, stillRunning: false, note: CLASSIC_NOTE } });
    const unused = await withClassicNote("classic", async () => reply);
    expect(JSON.parse((unused.content[0] as { text: string }).text)).toEqual({ ok: true, uiaClient: { client: "classic", used: false, note: CLASSIC_NOTE_NOT_USED } });
    expect(await withClassicNote(undefined, async () => reply)).toBe(reply);
  });

  it("a classic call refused before it ran says why (win2 R28: a busy discover said nothing)", async () => {
    const { withClassicNote } = await import("../../src/tools/desktop-register.js");
    const reply = { content: [{ type: "text" as const, text: JSON.stringify({ ok: false }) }] };
    const refused = await withClassicNote("classic", async () => { markClassicRefused("The classic UI Automation client is busy with an earlier call"); return reply; });
    expect(JSON.parse((refused.content[0] as { text: string }).text).uiaClient)
      .toEqual({ client: "classic", used: false, why: "The classic UI Automation client is busy with an earlier call", note: CLASSIC_NOTE_NOT_USED });
  });

  it("marking outside a classic call does nothing", () => {
    expect(() => markClassicUsed()).not.toThrow();
    expect(uiaClassicRequested()).toBe(false);
  });

  it("leaves a reply that is not JSON as it is", async () => {
    const { withClassicNote } = await import("../../src/tools/desktop-register.js");
    const reply = { content: [{ type: "text" as const, text: "not json" }] };
    expect(await withClassicNote("classic", async () => reply)).toBe(reply);
  });
});
