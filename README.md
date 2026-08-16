# itqan Shield

On-device AI governance filter for **itqan enforce** (see `../docs/`). Runs in the
tray on **Windows and macOS**, is built from a **Linux** machine, and filters AI
traffic **before it leaves the device** — nothing is sent to a server for inspection.

Current milestone: **M2 — keyword filter + agent selector + ask-each-time (83/83 tests passing)**.

---

## What it does (M2)

- **Local MITM proxy** on `127.0.0.1` (default port 8080, auto-increments if busy).
- **Keyword filter** (`src/filter/`): Aho-Corasick literal matching + regex rules,
  word-boundary mode, Unicode-aware, span-based output (offsets + context) —
  design borrowed from [privacy-filter.cpp](https://github.com/localai-org/privacy-filter.cpp)'s
  scanner contract so an NER model can slot in later as a second scanner.
- **Agent selector**: ChatGPT, Claude, Copilot, Cursor, Gemini, Perplexity,
  OpenAI API, plus custom endpoints — per-agent on/off, matched by host.
- **Ask-each-time**: when a keyword hits an enabled agent, a dialog shows the
  agent, keyword, and surrounding context with Allow / Deny / Allow-session.
  Fail-closed: timeout or dialog failure denies by default.
- **Keyword store**: `central` (future cloud sync) + `local` lists, per-rule
  match mode (`word` / `literal` / `regex`) and action (`ask` / `block`).
- **Decision log**: JSONL audit trail in the data dir, shown in the window.
- **On-device CA** (RSA-2048, per-device, key `0600`), upstream verified against
  the public PKI, OS system-proxy control with restore, CA trust install/remove.
- **Electron shell**: tray menu, status window (filter, agents, keywords, log).

**Not yet (M3+):** NER/PII model scanner (privacy-filter.cpp sidecar), cloud sync
(keyword push + decision reporting), MCP sync, signed installers.

## Layout

```
shield/
  src/
    main/            Electron main (tray, window, IPC, proxy lifecycle)
    preload/         contextBridge API
    renderer/        status UI (plain HTML/CSS/JS, brand-styled)
    proxy/           framework-agnostic proxy core (testable headless)
      ca.js          local CA + per-host certs (node-forge)
      mitm.js        TLS interception + HTTP relay
      server.js      proxy wiring (plain HTTP + CONNECT)
      inspect.js     filter seam (M2 keyword engine hooks here)
      system-proxy.js OS proxy on/off with restore
      ca-trust.js    OS trust-store install/remove
      index.js       headless CLI
  assets/            generated icons (scripts/make-icon.js)
  scripts/make-icon.js  zero-dependency PNG icon generator
```

## Requirements

- Node.js 22+ and npm (the build machine can be Linux; that's the supported flow)
- `npm install` (uses a project-local npm cache if the global one is root-owned:
  `npm install --cache ./.npm-cache`)

### Linux build-machine notes

- If the machine's caches are root-owned (common on shared/dev boxes), point
  tool caches at writable locations:
  ```bash
  npm install --cache ./.npm-cache
  electron_config_cache=./.electron-cache node node_modules/electron/install.js
  ```
- Running the Electron GUI needs the usual Chromium system libraries
  (`libgtk-3`, `libnss3`, `libgbm`, X11, …). Headless/minimal boxes can't render
  it; use `SHIELD_SMOKE_TEST=1 npx electron . --no-sandbox` on a machine with a
  display, or CI runners (`ubuntu-latest`), to exercise the app shell. The
  proxy core is fully testable headless (see below).

## Run

```bash
npm start                     # Electron app (tray + window)
npm run proxy -- --data-dir ./shield-data   # headless proxy CLI
```

## Verify the proxy core (M1 test)

```bash
# terminal 1 — start the proxy headless
node src/proxy/index.js --data-dir ./shield-data

# terminal 2 — test HTTP passthrough
curl -x http://127.0.0.1:8080 http://example.com/

# test HTTPS interception (trusting the local CA)
curl -x http://127.0.0.1:8080 --cacert shield-data/ca.pem https://example.com/

# POST a JSON body through (what AI agents send)
curl -x http://127.0.0.1:8080 --cacert shield-data/ca.pem \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-test","messages":[{"role":"user","content":"hi"}]}' \
  https://httpbin.org/post

# without trusting the CA, the same request must fail (exit 60)
curl -x http://127.0.0.1:8080 https://example.com/
```

## CLI reference

```bash
node src/proxy/index.js --help
node src/proxy/index.js --status --data-dir ./shield-data
node src/proxy/index.js --install-ca --data-dir ./shield-data   # trust this device
node src/proxy/index.js --uninstall-ca --data-dir ./shield-data
node src/proxy/index.js --proxy-on --port 8080                  # route OS through proxy
node src/proxy/index.js --proxy-off
```

## Build installers (from Linux)

```bash
npm run dist:win    # NSIS installer for Windows
npm run dist:mac    # DMG + ZIP for macOS (unsigned; signing needs a macOS runner/CI)
npm run dist:linux  # AppImage (for local testing)
```

Notes:
- Cross-building from Linux works for Windows (NSIS) and macOS **unsigned**
  artifacts. Signed/notarized releases should run on GitHub Actions
  (`windows-latest` / `macos-latest` runners).
- `electron-builder` outputs to `shield/dist/`.

## Security model

- The CA is generated **per device**, never leaves it, and can be removed with
  one click. Upstream connections are verified against the public PKI
  (`rejectUnauthorized: true`) — the proxy does not weaken the trust chain to
  the AI providers.
- The proxy binds to `127.0.0.1` only. It runs while the app runs; quitting the
  app reverts the OS proxy setting.
- See `docs/COMPETITIVE-LANDSCAPE.md` (repo root) for the security literature
  that shaped this design ("Killed by Proxy", Superfish, CA Report Card).
