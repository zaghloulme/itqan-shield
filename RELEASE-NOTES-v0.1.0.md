# itqan Shield v0.1.0 — first release (M1: proxy core)

On-device AI governance filter for **itqan enforce**. Runs in the tray on
**Windows and macOS**; inspects AI traffic **on this device, before it leaves** —
nothing is sent to a server for inspection.

> ⚠️ **Milestone M1:** this release delivers the local MITM proxy core, the tray
> shell, the agent-routing toggle, and CA trust management. **Keyword filtering
> (M2), the agent selector, and the ask-each-time dialog are the next milestone.**
> The filter seam is ready; the matching engine lands next.

## What works in this release

- Local HTTPS interception proxy on `127.0.0.1` (port 8080, auto-increments if busy)
- On-device CA: `itqan Shield Local CA`, generated per device, RSA-2048, key at 0600
- Per-host certificates minted on demand; upstream connections verified against the
  public PKI (`rejectUnauthorized: true`) — the proxy does not weaken the trust chain
- Tray app: Filter on/off (routes the OS through the proxy), Install/Remove CA, Quit
- Verified: 50/50 automated tests (unit + integration incl. chunked, SSE, keep-alive,
  block path, untrusted rejection, 10-client stress, port fallback)

## Install — macOS

1. Download `itqan Shield-0.1.0-mac-arm64.zip` (Apple Silicon) or
   `itqan Shield-0.1.0-mac.zip` (Intel) and unzip.
2. The app is **unsigned** (built from Linux; signing lands via CI later), so
   Gatekeeper will try to block it. Open it once with:
   `xattr -dr com.apple.quarantine "itqan Shield.app"` — or right-click the app
   in Finder → **Open**.
3. Launch `itqan Shield` — it sits in the menu bar.
4. First run: tray menu → **Install CA (trust this device)** and enter your
   password if prompted (login keychain).
5. Tray menu → **Filter active** to route device AI traffic through the proxy.
   Toggle off or Quit to restore the previous system proxy state.

## Install — Windows

1. Download `itqan Shield Setup 0.1.0.exe` and run it.
2. SmartScreen may warn (unsigned) → **More info** → **Run anyway**.
3. Tray menu → **Install CA** (per-user root store, no admin needed; restart
   browsers so they pick it up).
4. **Filter active** to route traffic through the proxy.

## Verify it works

```bash
# macOS/Linux terminal (macOS: point curl at the proxy)
curl -x http://127.0.0.1:8080 http://example.com/          # plain HTTP
curl -x http://127.0.0.1:8080 --cacert "$HOME/Library/Application Support/itqan Shield/ca.pem" https://example.com/   # HTTPS via MITM
```

## Checksums (SHA-256)

`SHA256SUMS` file in this release. Verify:

```bash
shasum -a 256 -c SHA256SUMS   # macOS
certutil -hashfile <file> SHA256   # Windows
```

## Notes

- The CA is per-device, never leaves the machine, and can be removed with one click
  (tray → Remove CA).
- Quitting the app restores your previous system proxy settings.
- Security design follows the client-end TLS interception literature
  (unique CA per device, 0600 key, no shared keys, upstream verification).
