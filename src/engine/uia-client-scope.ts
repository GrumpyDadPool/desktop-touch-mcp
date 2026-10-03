/**
 * internal #216 — which UI Automation client a `desktop_discover` / `desktop_act` call asked for
 * (`uiaClient`), carried through the call without threading it through every layer.
 *
 * The engine's clients are `CUIAutomation8` with `AutoSetFocus` off. `"classic"` asks for the older
 * `CUIAutomation`, the client 2.0 used, on its own thread, made for the one call and released after
 * it (`src/uia/thread.rs::execute_classic_with_timeout`). The user's decision (2026-10-03): an agent
 * that the default client cannot serve may choose it, knowing what it costs (`CLASSIC_NOTE`).
 *
 * The bridge reads the scope (`uia-bridge.ts`), so only the calls made inside `withUiaClient` go to
 * the classic client — the V1 tools and every other caller keep the default.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export type UiaClient = "default" | "classic";

const scope = new AsyncLocalStorage<UiaClient>();

/** Run `fn` with `client` in scope. `"default"` and `undefined` change nothing. */
export function withUiaClient<T>(client: UiaClient | undefined, fn: () => Promise<T>): Promise<T> {
  return client === "classic" ? scope.run("classic", fn) : fn();
}

/** Whether the call in progress asked for the classic client. */
export function uiaClassicRequested(): boolean {
  return scope.getStore() === "classic";
}

/**
 * What a reply made through the classic client says about it. MEASURED win2 2026-10-03 (internal
 * #216, R16–R27): that client moves the keyboard focus before a press or write — a window behind came
 * to the front and took 64–94 % of the keys typed meanwhile, and closing the acted-on window left the
 * foreground on GameInputSvc's invisible window, where moving the mouse and bringing a window forward
 * failed until the user clicked; and it waited as long as a WinForms modal box stayed open.
 */
export const CLASSIC_NOTE =
  "Read or acted through the classic UI Automation client (the one 2.0 used). It moves the keyboard focus: " +
  "a window behind can come to the front and take keys typed meanwhile, and after the window closes the " +
  "foreground can be left on an invisible window where the mouse and window switching fail until the user " +
  "clicks. It was released after this call.";
