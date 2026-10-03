//! internal #216 — move the keyboard focus to the element ourselves, before a pattern method acts.
//!
//! The client is created with `AutoSetFocus` off (`thread.rs`), so `Invoke` and `SetValue` no longer
//! move the focus. That is what stops the fall onto GameInputSvc's window, and it is also what an
//! application reads to commit a value: with nothing moving the focus, "write a field, press Save"
//! saved the OLD value (win2, VF V1: WinForms binding OnValidation 3/3, WPF binding LostFocus 3/3).
//! So the focus is moved here, by a road that does not raise the fall.
//!
//! MEASURED win2 2026-10-03 (internal `dev/v210-dogfood`, `dev/gis216-spike/fable-c2/RESULTS-R17*.md`,
//! a plain UIA client with `AutoSetFocus` off, 111 cells), the roads below and what they did:
//! - **The element has a window of its own** (WinForms TextBox, NumericUpDown's inner edit,
//!   ComboBox, CheckBox, ListBox, Button; a Win32 dialog's Edit): `AttachThreadInput` to its thread,
//!   then Win32 `SetFocus` on that window. Closing afterwards fell 0/18 (the default client: 18/18);
//!   with the window behind, the foreground stayed on the user's window at every step (60/60) and the
//!   keys the user's window was receiving all arrived (200/200 in 15/15 cells); the value reached the
//!   application's model when the focus left the field (the step that focuses the button).
//! - **A list item, inside a list that has a window of its own**: the same, on the list's window;
//!   then the item is invoked. 0/3 falls (the default client 3/3).
//! - **Anything else** (WPF, Chromium — no window of their own): UI Automation's own `SetFocus`.
//!   No fall and the value committed, but with the window behind it takes the foreground, and most
//!   keys typed meanwhile go to that window (153–183 of 200) — as the default client does there.
//!
//! What this does not cover (same rounds): a Win32 menu item with a submenu still falls (menu mode,
//! not focus); and a ListBox item written with `Select` or a ComboBox written with `SetValue` never
//! reaches a WinForms bound model whichever way the focus moves (internal #238).

use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
use windows::Win32::UI::Accessibility::*;
use windows::Win32::UI::Input::KeyboardAndMouse::SetFocus;
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowThreadProcessId, IsHungAppWindow, SMTO_ABORTIFHUNG, SendMessageTimeoutW, WM_NULL,
};

use super::thread::UiaContext;

/// How long the window's thread is given to answer before the focus is left where it is.
///
/// MEASURED win2 (R17c): Win32 `SetFocus` on a window whose thread was in `Sleep` did not return
/// until the sleep ended (2,446 and 2,462 ms after the call), with no limit of its own. The pattern
/// call that follows would wait on the same thread anyway, under the action's own timeout; this only
/// keeps the focus step from adding a second unbounded wait in front of it.
const ANSWER_MS: u32 = 300;

/// Which road moved the focus, as `ActionResult::focused_by` reports it.
pub(crate) const BY_WIN32: &str = "win32";
pub(crate) const BY_LIST_WINDOW: &str = "win32_list";
pub(crate) const BY_UIA: &str = "uia";
pub(crate) const ALREADY: &str = "already";
pub(crate) const NOT_ANSWERING: &str = "not_answering";
pub(crate) const FAILED: &str = "failed";

/// Move the keyboard focus to `elem` (or to the list that holds it), and say how.
///
/// Never fails the action: a focus that could not be moved leaves the press or the write to run as
/// it would have, and the answer says which.
pub(crate) fn move_focus_first(ctx: &UiaContext, elem: &IUIAutomationElement) -> &'static str {
    unsafe {
        if elem.CurrentHasKeyboardFocus().map(|b| b == true).unwrap_or(false) {
            return ALREADY;
        }
        if let Some(own) = own_window(elem) {
            return win32_focus(own, BY_WIN32);
        }
        if let Some(list) = list_window_of_item(ctx, elem) {
            return win32_focus(list, BY_LIST_WINDOW);
        }
        match elem.SetFocus() {
            Ok(()) => BY_UIA,
            Err(_) => FAILED,
        }
    }
}

/// The element's own window, when it has one. Zero is "none": UIA answers it for an element drawn
/// inside another window.
unsafe fn own_window(elem: &IUIAutomationElement) -> Option<HWND> {
    let h = unsafe { elem.CurrentNativeWindowHandle() }.ok()?;
    (!h.0.is_null()).then_some(HWND(h.0))
}

/// A list item's list, when the list has a window of its own — the shape R17c measured (a WinForms
/// ListBox). Only ListItem: other items inside a windowed container (tree, grid) were not measured,
/// and they take UI Automation's own `SetFocus`.
unsafe fn list_window_of_item(ctx: &UiaContext, elem: &IUIAutomationElement) -> Option<HWND> {
    let is_item = unsafe { elem.CurrentControlType() }
        .map(|t| t.0 == UIA_ListItemControlTypeId.0)
        .unwrap_or(false);
    if !is_item {
        return None;
    }
    let parent = unsafe { ctx.walker.GetParentElement(elem) }.ok()?;
    let is_list = unsafe { parent.CurrentControlType() }
        .map(|t| t.0 == UIA_ListControlTypeId.0)
        .unwrap_or(false);
    if !is_list {
        return None;
    }
    unsafe { own_window(&parent) }
}

/// `AttachThreadInput` to the window's thread, Win32 `SetFocus`, detach — after the thread has
/// answered once. Not `SetForegroundWindow`: the foreground is not asked for, and a window behind
/// stays behind (R17b).
unsafe fn win32_focus(hwnd: HWND, by: &'static str) -> &'static str {
    unsafe {
        if !answers(hwnd) {
            return NOT_ANSWERING;
        }
        let theirs = GetWindowThreadProcessId(hwnd, None);
        let mine = GetCurrentThreadId();
        if theirs == 0 {
            return FAILED;
        }
        let attached = theirs != mine && AttachThreadInput(mine, theirs, true).as_bool();
        let focused = SetFocus(Some(hwnd)).is_ok();
        if attached {
            let _ = AttachThreadInput(mine, theirs, false);
        }
        if focused { by } else { FAILED }
    }
}

/// Whether the window's thread processes a message within `ANSWER_MS`. The same question as
/// `win32_window_answers` (`win32/dwm.rs`), except that a failed send counts as "no" here whether
/// or not the OS calls the window hung yet: the cost of a wrong "no" is a focus not moved, the cost
/// of a wrong "yes" is a wait with no limit.
unsafe fn answers(hwnd: HWND) -> bool {
    let mut result: usize = 0;
    let r = unsafe {
        SendMessageTimeoutW(hwnd, WM_NULL, WPARAM(0), LPARAM(0), SMTO_ABORTIFHUNG, ANSWER_MS, Some(&mut result))
    };
    r.0 != 0 && !unsafe { IsHungAppWindow(hwnd) }.as_bool()
}
