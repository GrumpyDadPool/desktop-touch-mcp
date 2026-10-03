/**
 * internal #216 — which UI Automation client a `desktop_discover` / `desktop_act` call asked for
 * (`uiaClient`), carried through the call without threading it through every layer.
 *
 * The engine's clients are `CUIAutomation8` with `AutoSetFocus` off. `"classic"` asks for the older
 * `CUIAutomation`, the client 2.0 used, on its own thread, made for the one call and released after
 * it (`src/uia/thread.rs::execute_classic_with_timeout`). The user's decision (2026-10-03): an agent
 * that the default client cannot serve may choose it, knowing what it costs.
 *
 * The bridge reads the scope (`uia-bridge.ts`), so only the calls made inside it go to the classic
 * client — the V1 tools and every other caller keep the default. It also records whether a native
 * call actually went to that client, so a reply says so only when it did (gate 2 on `74d5f6bc`).
 */

import { AsyncLocalStorage } from "node:async_hooks";

export type UiaClient = "default" | "classic";

interface ClassicScope { used: boolean; refusal?: string }

const scope = new AsyncLocalStorage<ClassicScope>();

/** Run `fn` with `client` in scope. `"default"` and `undefined` change nothing. */
export function withUiaClient<T>(client: UiaClient | undefined, fn: () => Promise<T>): Promise<T> {
  return client === "classic" ? scope.run({ used: false }, fn) : fn();
}

/**
 * Like `withUiaClient("classic", fn)`, and also says whether a native call went to the classic
 * client while `fn` ran.
 */
export async function runClassic<T>(fn: () => Promise<T>): Promise<{ result: T; used: boolean; refusal?: string }> {
  const state: ClassicScope = { used: false };
  const result = await scope.run(state, fn);
  return { result, used: state.used, ...(state.refusal !== undefined && { refusal: state.refusal }) };
}

/** Whether the call in progress asked for the classic client. */
export function uiaClassicRequested(): boolean {
  return scope.getStore() !== undefined;
}

/** Called by the bridge when the classic client refused a call before running it (busy, unavailable). */
export function markClassicRefused(why: string): void {
  const state = scope.getStore();
  if (state && state.refusal === undefined) state.refusal = why;
}

/** Called by the bridge when a native call has gone to the classic client. */
export function markClassicUsed(): void {
  const state = scope.getStore();
  if (state) state.used = true;
}

/**
 * What a reply made through the classic client says about it. MEASURED win2 2026-10-03 (internal
 * #216, R16–R27): that client moves the keyboard focus before a press or write — a window behind came
 * to the front and took 64–94 % of the keys typed meanwhile, and closing the acted-on window left the
 * foreground on GameInputSvc's invisible window, where moving the mouse and bringing a window forward
 * failed until the user clicked; and it waited as long as a WinForms modal box stayed open. While it
 * is alive, the default client's writes to the windows it touched move the focus too (R23co, R24), so
 * a call that ran past its timeout says that it may still be running.
 */
export const CLASSIC_NOTE =
  "Read or acted through the classic UI Automation client (the one 2.0 used). It moves the keyboard focus: " +
  "a window behind can come to the front and take keys typed meanwhile, and after the window closes the " +
  "foreground can be left on an invisible window where the mouse and window switching fail until the user " +
  "clicks. It was released after this call.";

export const CLASSIC_NOTE_STILL_RUNNING =
  "Read or acted through the classic UI Automation client (the one 2.0 used), and that call is still running " +
  "(it ran past its time limit, for example on a window that is busy or showing a modal box). Until it finishes, " +
  "acts on the window it touched can move the keyboard focus even through the default client, and further " +
  "'classic' calls are refused.";

export const CLASSIC_NOTE_NOT_USED =
  "The classic UI Automation client did not answer this call (it was busy with an earlier call, the native " +
  "engine is unavailable, or this target is not read through UI Automation); nothing in this reply came from it.";
