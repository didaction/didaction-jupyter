use std::process::Command;

fn git(args: &[&str]) -> Option<String> {
    let output = Command::new("git").args(args).output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

fn main() {
    println!("cargo:rerun-if-env-changed=DIDACTION_BUILD_GIT_SHA");
    println!("cargo:rerun-if-env-changed=DIDACTION_BUILD_DIRTY");
    // Re-evaluate provenance on each requested build, including unstaged edits.
    println!("cargo:rerun-if-changed=build-provenance-always-check");
    let sha = std::env::var("DIDACTION_BUILD_GIT_SHA")
        .ok()
        .filter(|s| s.len() == 40 && s.chars().all(|c| c.is_ascii_hexdigit()))
        .or_else(|| git(&["rev-parse", "HEAD"]))
        .unwrap_or_else(|| "unknown".into());
    let dirty = std::env::var("DIDACTION_BUILD_DIRTY")
        .ok()
        .filter(|s| s == "true" || s == "false")
        .or_else(|| git(&["status", "--porcelain"]).map(|s| (!s.is_empty()).to_string()))
        .unwrap_or_else(|| "unknown".into());
    println!("cargo:rustc-env=DIDACTION_WASM_GIT_SHA={sha}");
    println!("cargo:rustc-env=DIDACTION_WASM_DIRTY={dirty}");
}
