# itqan Shield v0.2.0 — the filter (M2)

The keyword filter, agent selector, and ask-each-time dialog are here — the
product core. Local-only: prompts are inspected on-device, before egress.

> **How to try it:** install the CA (tray → Install CA), keep **Filter active**,
> add a keyword in the **Keywords** card (e.g. `production-database`, whole word),
> then ask ChatGPT/Claude about it — the **ask dialog** appears with the matched
> context and Allow / Deny / Allow-for-session. Deny = the request never leaves
> the device. Every decision lands in the **Decisions** log.

## What's new in v0.2.0

- **Keyword filter** — Aho-Corasick matching (fast with hundreds of words),
  word / substring / regex modes, Unicode-aware, case-insensitive
- **Agent selector** — ChatGPT, Claude, Copilot, Cursor, Gemini, Perplexity,
  OpenAI API + your own custom endpoints; per-agent on/off
- **Ask-each-time** — dialog with matched context; Allow once / Deny /
  Allow for this session (per agent); **fail-closed**: timeout → deny
- **Silent `block` action** per keyword (no dialog) for hard policies
- **Decision log** — local JSONL audit trail, visible in the window
- Design inspired by [privacy-filter.cpp](https://github.com/localai-org/privacy-filter.cpp):
  span-based matches (offsets + context), labels/categories, windowed scanning —
  the scanner seam is ready for an NER model sidecar later

## Install — macOS

1. Download `itqan Shield-0.2.0-arm64-mac.zip` (Apple Silicon) or
   `itqan Shield-0.2.0-mac.zip` (Intel), unzip.
2. Unsigned build → open once with:
   `xattr -dr com.apple.quarantine "itqan Shield.app"` (or right-click → Open).
3. Launch (menu bar) → tray → **Install CA** (enter password if prompted) →
   **Filter active**.

## Install — Windows

1. Download `itqan Shield-0.2.0-win.zip` (x64) / `-arm64-win.zip`, unzip, run
   `itqan Shield.exe`. SmartScreen: More info → Run anyway.
2. Tray → **Install CA** (per-user store; restart browsers) → **Filter active**.

## Checksums

`SHA256SUMS` file in this release — verify with `shasum -a 256 -c SHA256SUMS`
(macOS) or `certutil -hashfile <file> SHA256`.

## Notes

- CA is per-device, never leaves the machine, removable with one click.
- Quitting restores your previous system proxy settings.
- Keyword rules: `central` list (cloud sync, later) + `local` (yours now).
