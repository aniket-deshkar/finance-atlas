# Finance Atlas 0.2.1: UI and release review

## Acceptance criteria

- Dashboard text and cards remain readable on laptop, tablet, and narrow mobile widths.
- The Assistant conversation and composer have a clear visual hierarchy and retain the existing local and cloud approval behavior.
- Search remains available on narrow screens without crowding the top bar.
- The web build and Windows app use the same UI and the installer has one consistent version.
- Prior financial data, account settings, and encrypted backups remain untouched.

## Differential security review

**Scope:** `app/assistant.tsx`, `app/layout.tsx`, `app/modern.css`, `tests/browser-smoke.mjs`, version manifests and lockfiles. Compared with the prior `dev` HEAD. The change affects presentation, responsive styling, optional test screenshots, and release metadata. It does not change vault storage, authentication, cloud authorization, payment calculations, or network requests.

| Severity | Count |
| --- | ---: |
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low | 0 |

**Overall risk:** Low. **Recommendation:** Approve, subject to the verification below. The browser test writes screenshots only when an explicit environment variable points to a path. Those synthetic screenshots are removed from the working tree after visual review.

## Verification

- `npm.cmd run check`: passed.
- `npm.cmd test`: 43 passed, 6 legacy comparison cases skipped, 0 failed.
- `npm.cmd test` in `api/`: 8 passed, 0 failed.
- `npm.cmd run desktop:test`: 4 native Rust tests passed, 0 failed.
- `npm.cmd run build`: static production export built.
- `npm.cmd run test:browser`: fictional encrypted vault exercised across all app sections and eight viewport sizes, including 430px and 390px; card payments, bills, EMIs, recoveries, budget updates, PDF password prompt, reload, restore, and stale-write rejection passed.
- `node tests/desktop-smoke.mjs`: isolated synthetic WebView2 profile passed vault, persistence, theme, native command, and dashboard checks.
- Firebase Hosting deployment completed. Anonymous checks returned HTTP 200 for the app and `/health`; the app response includes its configured Content Security Policy.
- Windows installer: `Finance Atlas_0.2.1_arm64-setup.exe` (196,002,754 bytes), SHA-256 `C2D1488F4D46F37CE451E0A0BAF51B075DEC574607432A02FA4A74AA9A17ACB2`.

## Tooling used

Modern Web Guidance was consulted before CSS changes and its legacy scan identified four pre-existing suggestions. The frontend design and Vercel React guidance shaped the responsive layout and component review. Superpowers' verification gate was applied to release claims. Trail of Bits' differential review was applied to the changed files. GitHub Spec Kit 1.4.2 is installed for future feature specifications. Context7 and the Playwright and Chrome DevTools MCP servers are configured for future Codex sessions; their tools were not hot loaded into this running session, so the existing Chrome DevTools Protocol browser harness was used for end-to-end testing.

## Limits

This pass did not sign into the personal vault, run a live Google OAuth flow, or spend tokens on live AI model calls. Browser and desktop end-to-end tests use fictional data and isolated profiles. The six skipped cases compare with legacy HTML fixtures that are not present in this repository.
