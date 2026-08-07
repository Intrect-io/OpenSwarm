// OpenSwarm desktop entry point — hide the Windows console and call run() from the lib.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    openswarm_desktop_lib::run()
}
