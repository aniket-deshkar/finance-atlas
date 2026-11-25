# Finance Atlas live deployment audit

Checked on 23 November 2026 with Chrome DevTools MCP 1.13.0, headless Chrome 158, Lighthouse 13.6.0, and read-only HTTP checks. Compared public Hosting assets with the local production export of `dev` at `71e495d`. [Live Finance Atlas](https://project-28fd15da-8fbd-4bb6-99e.web.app/) · [Project analysis](project-analysis-0.2.1.md)

The deployment serves the frontend and routes requests to the API. Its first screen paints quickly in the sampled lab runs, but it visibly shifts during initialization on mobile. On the unlocked dashboard, the floating Assistant launcher partly obscures Documents. Chrome's accessibility tree also confirms that the account editor opens as a modal without an accessible name.

## Live routing and release identity

| Endpoint | Result |
| --- | --- |
| [Workspace](https://project-28fd15da-8fbd-4bb6-99e.web.app/) | 200. Chrome showed the Finance Atlas welcome screen and the Google sign-in option. |
| [Windows pairing](https://project-28fd15da-8fbd-4bb6-99e.web.app/connect/) | 200. Continuing from a direct visit displayed the instruction to start in the Windows app. There was no Google sign-in prompt in that flow. |
| [App icon](https://project-28fd15da-8fbd-4bb6-99e.web.app/favicon.ico) | 200 and `image/x-icon`. |
| [Health](https://project-28fd15da-8fbd-4bb6-99e.web.app/health) | 200 with `{"status":"ok"}` and `Cache-Control: no-store`. This verifies the rewrite and process response. |
| [Cloud sync head](https://project-28fd15da-8fbd-4bb6-99e.web.app/v1/sync/head) and [model catalog](https://project-28fd15da-8fbd-4bb6-99e.web.app/v1/ai/models) | Both returned 401 with `Cache-Control: no-store` for anonymous requests. The allowed owner flow was outside this test. |

Hosting sent HSTS, `nosniff`, a no-referrer policy, restrictions on camera, microphone, and geolocation, and the expected content security policy. The page HTML advertised a one-hour cache lifetime. A sampled hashed stylesheet advertised one year with `immutable` and used Brotli. Browser requests during account creation and editing stayed on the app origin. The page contained no personal ledger in the isolated Chrome profile. [Hosting headers and rewrites](../../firebase.json) · [API checks](../../api/app.mjs#L27)

Eight of ten hashed asset names extracted from the live homepage HTML also existed in the local production export. Two JS names differed. The live build exposes cloud configuration and the prior local export used the offline build settings, so the difference is compatible with build-time configuration. The hashes alone cannot verify the deployed commit or show which channel built it. Publish a non-sensitive build identifier with the web export and record the matching API and worker revisions at release time. [Cloud build configuration](../../lib/cloud.ts#L6) · [Release runbook](../CLOUD-PILOT.md)

## Browser performance

| Welcome page measurement | Desktop, no throttling | 390 × 844 mobile, Fast 4G, 4× CPU slowdown |
| --- | ---: | ---: |
| Time to first byte | 24–28 ms | 168–169 ms |
| Largest Contentful Paint | 177–193 ms | 968–1,060 ms |
| Cumulative Layout Shift | 0.00 | About 0.12 |

These are two cache-bypassed lab samples per mode. Live user percentiles and interaction latency were unmeasured. The mobile Lighthouse navigation audit independently measured a layout shift of 0.126. Chrome's worst shift cluster scored 0.119 and identified both the welcome story and the form panel as affected elements. The desktop trace did not reproduce it. [Chrome DevTools layout shift guidance](https://developer.chrome.com/docs/performance/insights/cls-culprit) · [CLS measurement](https://web.dev/articles/cls)

An instrumented mobile reload confirmed the trigger. The welcome panel started at 155 px with “Checking local storage…”. At about 1.44 seconds the Google button and new-vault form replaced that state, increasing the panel to 407 px. Both panels moved up 118 px on the next frame. Reserve mobile space for the resolved form or keep the welcome panels aligned to a stable top position while IndexedDB loads. Repeat the cold trace for both a fresh browser profile and an existing vault, targeting CLS at or below 0.10. [Welcome state rendering](../../app/page.tsx#L487) · [Welcome layout](../../app/globals.css#L198)

Cold desktop resource timing counted eight JS requests totaling approximately 218 kB on the wire and 873 kB decoded, plus one stylesheet at approximately 12 kB on the wire and 62 kB decoded. The largest decoded JavaScript response was about 243 kB. Rendering delay made up about 800–890 ms of the sampled mobile LCP. The build loads workspace and cloud dependencies through the main client entry. Profile module evaluation before splitting by feature, and track initial transfer and vault unlock latency on the same fixture and device profile. [Workspace imports](../../app/page.tsx#L3) · [Cloud client](../../lib/cloud.ts#L1)

## UI and accessibility

The welcome page and the unlocked Accounts screen scored 100 for Lighthouse accessibility and best practices. The welcome navigation audit flagged layout shift in its agentic browsing category. Manual inspection of the 390 px dashboard and the editor's accessibility tree caught issues outside those automated checks.

| Priority | Live evidence | Suggested acceptance check |
| --- | --- | --- |
| High | At 390 × 844 px, the floating Assistant launcher overlaps the Documents button. The screenshot and DOM rectangles both show the obstruction. The page itself has no horizontal overflow at that size. | At widths from 320 to 430 px, confirm the launcher leaves Documents and other visible controls fully tappable as the user scrolls. [Launcher CSS](../../app/workspace.css#L18) · [Documents button](../../app/attention.tsx#L210) |
| Medium | The live account editor appears as an unnamed modal in the accessibility tree. Initial focus lands on Close editor. Escape closes the dialog, and the following focus sample did not identify the launch button. | Connect the heading to the dialog with `aria-labelledby`. Verify keyboard focus returns to Edit / confirm balance on Escape, Cancel, and Save. [Shared editor](../../app/feature-ui.tsx#L42) |
| Medium | Top-bar buttons are 30 px high in the 390 px layout. Navigation and Back measure 30 × 30 px. The calendar, dues, privacy, and settings buttons measure 33 × 30 px. | Increase the effective hit area around the icons where space permits and check adjacent controls on touch screens. [Mobile CSS](../../app/workspace.css#L64) |
| Low | Chrome reports missing field identifiers and autocomplete hints on the unlocked Accounts view. The search input and account Type selector have labels, but lack both `id` and `name`. | Add stable identifiers and appropriate autocomplete values. Preserve the existing accessible labels and form behavior. [Search](../../app/page.tsx#L532) · [Account form](../../app/page.tsx#L69) |

## Data and authorization tested

The browser profile started with a local-vault creation screen. A fictional passphrase and bank account enabled the dashboard and account editor checks in that disposable browser profile. The supplied passphrases were unused. The public page, local encrypted workflow, pairing guard, and anonymous API authorization were checked. Personal-vault access, a full Google sign-in, owner API behavior, real Windows pairing, cloud sync, AI inference, and rollback were unverified.

The Chrome DevTools and accessibility skills guided the live DOM, keyboard, console, and network checks. Cloudflare's web performance skill guided the desktop and mobile traces and resource timing review. [Chrome DevTools skill](https://skills.sh/chromedevtools/chrome-devtools-mcp/chrome-devtools) · [Accessibility debugging](https://skills.sh/chromedevtools/chrome-devtools-mcp/a11y-debugging) · [Web performance audit](https://skills.sh/cloudflare/skills/web-perf)
