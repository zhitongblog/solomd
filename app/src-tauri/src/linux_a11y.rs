//! #253 / #200 — keep a wedged accessibility bus from freezing the window.
//!
//! On Linux, three separate pieces of our stack look up the AT-SPI bus address
//! with a *blocking* D-Bus call on the UI thread:
//!
//! * GTK's atk-bridge → `atspi_get_a11y_bus()`, which passes `-1` to
//!   `dbus_connection_send_with_reply_and_block()` — libdbus's default 25 s;
//! * WebKitGTK's `queryAccessibilityBusAddress()` in the UI process —
//!   `g_dbus_connection_send_message_with_reply_sync(..., 30000, ...)`;
//! * the same lookup again from the web process side.
//!
//! When `org.a11y.Bus` answers, all three return in microseconds. When it is
//! *present but not answering* — a wedged `at-spi-bus-launcher`, a session
//! whose activation environment is broken — each one burns its full timeout
//! back to back with the window either unpainted or completely unresponsive.
//! Measured headless on Ubuntu 24.04 (webkit2gtk 2.52.3) with a bus that owns
//! `org.a11y.Bus` and never replies: first paint went from 3 s to 50 s.
//!
//! Note this is not the same as *no* accessibility bus: a missing name gets an
//! immediate `ServiceUnknown` back from dbus-daemon, and D-Bus activation of a
//! healthy at-spi starts it in well under a second. Only a bus that accepts
//! the call and never answers hurts, and libatspi's X11 shortcut (reading the
//! `AT_SPI_BUS` root-window property) doesn't exist under Wayland, so Wayland
//! sessions take the blocking path every time.
//!
//! So: ask the bus ourselves, first, with a deadline we choose. If it answers,
//! change nothing — accessibility keeps working exactly as before. If it does
//! not, tell GTK and WebKit not to go looking, and let the app start.

#[cfg(target_os = "linux")]
use std::sync::mpsc;
use std::time::Duration;

/// Env vars that mean "the user (or their desktop) has already decided how
/// accessibility should be wired up here" — we never override those.
const USER_OWNED: [&str; 3] = [
    "NO_AT_BRIDGE",
    "AT_SPI_BUS_ADDRESS",
    "WEBKIT_A11Y_BUS_ADDRESS",
];

/// An address that is syntactically valid but cannot connect, so every
/// consumer fails immediately instead of waiting out a timeout.
const DEAD_ADDRESS: &str = "unix:path=/nonexistent/solomd-a11y-unavailable";

/// How long we give the a11y bus to answer before declaring it wedged.
///
/// A bus that is already running replies in microseconds; the only case that
/// needs real time here is D-Bus *activation* of `at-spi-bus-launcher` on a
/// desktop that doesn't start it at login, and that is a small binary. Two
/// seconds leaves room for a cold, loaded boot while still being 12x better
/// than the 25 s we're protecting against.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
const PROBE_BUDGET: Duration = Duration::from_millis(2000);

/// True when nothing in the environment has already pinned the a11y wiring.
// Only the Linux path calls these; the tests exercise them everywhere.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn should_probe<F: Fn(&str) -> bool>(is_set: F) -> bool {
    !USER_OWNED.iter().any(|k| is_set(k))
}

/// What to export when the bus never answered.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn disable_vars() -> [(&'static str, &'static str); 3] {
    [
        // GTK: don't load atk-bridge at all (that's the libdbus 25 s call).
        ("NO_AT_BRIDGE", "1"),
        // libatspi: short-circuit its own lookup with an address that fails fast.
        ("AT_SPI_BUS_ADDRESS", DEAD_ADDRESS),
        // WebKitGTK: set means "don't query", for the UI and web processes both.
        ("WEBKIT_A11Y_BUS_ADDRESS", DEAD_ADDRESS),
    ]
}

/// Ask `org.a11y.Bus` for the bus address, with our own timeout.
///
/// Runs on a throwaway thread: `GetAddress` is only *usually* the thing that
/// hangs — connecting to the session bus can hang too, and neither has a
/// cancellation story we can rely on. A detached thread that finishes late
/// costs nothing; a blocked main thread is the bug we're fixing.
#[cfg(target_os = "linux")]
fn bus_answers_in_time() -> bool {
    let (tx, rx) = mpsc::channel();
    std::thread::Builder::new()
        .name("a11y-bus-probe".into())
        .spawn(move || {
            let answered = probe_once();
            let _ = tx.send(answered);
        })
        .ok();

    // A late answer is the same as no answer: we've already decided by then.
    rx.recv_timeout(PROBE_BUDGET).unwrap_or(false)
}

#[cfg(target_os = "linux")]
fn probe_once() -> bool {
    let Ok(bus) = gio::bus_get_sync(gio::BusType::Session, gio::Cancellable::NONE) else {
        // No session bus at all (a bare TTY, a container). Nothing will be
        // asking it anything, so there is nothing to guard against.
        return true;
    };

    bus.call_sync(
        Some("org.a11y.Bus"),
        "/org/a11y/bus",
        "org.a11y.Bus",
        "GetAddress",
        None,
        None,
        gio::DBusCallFlags::NONE,
        PROBE_BUDGET.as_millis() as i32,
        gio::Cancellable::NONE,
    )
    .is_ok()
}

/// Called once, before GTK is initialised.
#[cfg(target_os = "linux")]
pub fn guard_against_wedged_a11y_bus() {
    if !should_probe(|k| std::env::var_os(k).is_some()) {
        return;
    }
    if bus_answers_in_time() {
        return;
    }
    for (key, value) in disable_vars() {
        std::env::set_var(key, value);
    }
    eprintln!(
        "SoloMD: the accessibility bus did not answer within {} ms — starting with \
         accessibility disabled for this process so the window can't hang on it (#253).",
        PROBE_BUDGET.as_millis()
    );
}

#[cfg(not(target_os = "linux"))]
pub fn guard_against_wedged_a11y_bus() {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probes_when_nothing_is_pinned() {
        assert!(should_probe(|_| false));
    }

    #[test]
    fn respects_every_user_owned_variable() {
        for owned in USER_OWNED {
            assert!(
                !should_probe(|k| k == owned),
                "{owned} should suppress the probe"
            );
        }
    }

    #[test]
    fn disable_set_covers_gtk_atspi_and_webkit() {
        let vars = disable_vars();
        let keys: Vec<&str> = vars.iter().map(|(k, _)| *k).collect();
        assert_eq!(keys, USER_OWNED.to_vec());
        // Every consumer must get something non-empty: WebKit treats an empty
        // string as "set", but libatspi ignores an empty AT_SPI_BUS_ADDRESS
        // and falls back to the blocking lookup we're trying to avoid.
        assert!(vars.iter().all(|(_, v)| !v.is_empty()));
    }

    #[test]
    fn probe_budget_is_far_below_the_timeouts_it_replaces() {
        // libdbus defaults to 25 s and WebKit asks for 30 s; the whole point is
        // to decide long before either of those, while still leaving room for
        // D-Bus activation of at-spi on a cold boot.
        assert!(PROBE_BUDGET < Duration::from_secs(5));
        assert!(PROBE_BUDGET >= Duration::from_secs(1));
    }

    #[test]
    fn dead_address_is_a_unix_socket_path_that_cannot_exist() {
        assert!(DEAD_ADDRESS.starts_with("unix:path=/"));
        assert!(!std::path::Path::new(&DEAD_ADDRESS["unix:path=".len()..]).exists());
    }
}
