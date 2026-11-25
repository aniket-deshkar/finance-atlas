# Finance Atlas QA and evaluation

The suite checks three user journeys. A user can unlock the local vault, import and reconcile a statement, and recover encrypted copies. The authenticated chat API validates the selected facts, dispatches them to the worker and accounts for the reply. The deployed web app and API report the same release revision.

## Running the pipeline

Install the workspace and API npm dependencies on Node 24. For the worker, install the pinned dependencies in `agent/requirements.txt` with Python 3.12. The pipeline uses `agent/.venv` when present. Set `ATLAS_EVAL_PYTHON` to use a different interpreter. The browser suite uses Chrome on Windows. Set `ATLAS_CHROME` to use a different Chrome executable.

| Command | Coverage |
| --- | --- |
| `npm run eval` | Unit tests, API contracts, static build and browser journeys, Python worker tests, and API-to-ADK integration |
| `npm run eval -- --suite web` | Finance and application tests, API contracts, type-checked production build and browser journeys |
| `npm run eval -- --suite worker` | Worker unit tests and real loopback HTTP from the Node API to FastAPI and ADK with a deterministic model |
| `npm run eval -- --suite native` | Windows Rust tests, debug Tauri build and WebView2 journeys with a disposable vault |
| `npm run eval -- --suite models` | Opt-in live Gemini evaluation with synthetic questions and local Google Cloud credentials |

Add `--hosting https://PROJECT.web.app` and set `ATLAS_RELEASE_SHA` to the expected deployed commit to run the public Hosting smoke check. Run this separately from a candidate build when the live and candidate commits differ. Set `NEXT_PUBLIC_ATLAS_FIREBASE_AUTH_DOMAIN` to include verification of the sign-in frame policy.

The web and worker CI jobs run deterministic gates and upload the stage results. The pipeline exits nonzero on a failed stage and skips browser checks after a failed build. Each suite writes `artifacts/atlas-eval/<suite>/results.json`. The live suite also records per-case checks, provider status, response time and token counts in `model-results.json`. Evaluation artifacts omit credentials, prompt text and response text.

The model suite uses the production prompt, ADK runner and structured reply schema. It checks source references, exact rupee values, missing data, leakage from unrelated history and token reporting. It runs three synthetic cases per model and stops sending requests to a model after an HTTP 403. These cases provide regression signals for specific behavior. They do not establish general financial accuracy or the quality of real policy sources. [Google Cloud evaluation overview](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/evaluation-overview)

## Defects and fixes

| Severity | Reproduced behavior | Fix and regression check |
| --- | --- | --- |
| High | Two rows in one statement could reconcile to the same recorded movement. The second row appeared matched without its own ledger entry. | The import rejects repeated matches per statement account and leaves the ledger unchanged. The review screen tells the user which issue to resolve before saving. |
| Medium | The chat API accepted a nonexistent date such as November 31, which let invalid input reserve budget and reach the worker. | Chat and dashboard analysis share calendar-date validation. The HTTP regression test expects HTTP 400 and verifies zero worker calls for invalid input. |
| Medium | A model entry with rates and no processing location could appear enabled because the location check coerced missing values to text. | The catalog requires a string location. Unit tests cover missing and null locations. Chat also caps fact fields to the worker schema's limit before dispatch. |
| Medium | The first live scoring rule rejected a correct response that expressed the same value in paise and rupees. | The evaluator now checks amounts explicitly labeled in rupees and compares them to the expected rupee value. |
| Medium | The ADK adapter discarded the provider's error category. An access denial looked like a generic model failure in QA. | The worker keeps a bounded status code for evaluation. User-facing API errors omit provider details. A fixture verifies both behaviors at the worker boundary. |

## Results

| Check | Result |
| --- | --- |
| Application and finance unit tests | 46 passed. Six legacy fixture cases skipped. |
| Node API unit and contract tests | 11 passed. |
| Python ADK worker tests | 7 passed. |
| Loopback HTTP API-to-ADK integration | 7 scenarios passed. Covered owner authorization, replay, malformed facts, unexpected references, partial answers, policy sources and budget limits. |
| Browser journeys | Passed in Chrome on desktop and mobile. Covered keyboard navigation, privacy, encrypted recovery across vaults, card statement review and import, and stale-write rejection. |
| Windows desktop | Four Rust tests and the WebView2 journey passed. |
| Public production smoke | Hosting and API reported `1934908`. The script policy, cache rules and anonymous access checks passed for that deployed release. |

The current QA changes were tested in the workspace. The production smoke result applies to the deployed revision above. The GitHub Actions configuration was validated locally.

## Live model results and open work

| Model | Result | Follow-up |
| --- | --- | --- |
| Gemini 3.1 Flash-Lite | Passed all three synthetic cases. | Verify with the Cloud Run worker identity before changing the live catalog. |
| Gemini 4 Hydrogen | No scored answers. The provider reported `RESOURCE_EXHAUSTED` for all three requests in the final run. | Check quota and capacity using the deployed worker identity. The public smoke check cannot establish whether production chat is affected. |
| Gemini 4 Carbon | No scored answers. The provider denied access on the first case and the runner skipped the remaining two. | Confirm billing and regional eligibility before enabling it. Do not use this run as a quality comparison. |

The live suite correctly returned a failing status because two model runs were blocked upstream. CI uses the deterministic suite as the merge gate. The live suite is a separate operator check for candidate models.

## Coverage limits

- The browser journeys exercise the local encrypted vault and review workflows. The HTTP integration uses synthetic identities and an in-memory usage store. Real Google sign-in, cross-device production sync and persistence of the AI budget in production Firestore require an authenticated test owner and a dedicated test project or fixture account.
- The policy contract verifies that ADK receives its search tool and returns grounded source metadata from a fixture. Live policy source relevance and search costs still need a targeted provider evaluation.
- Six comparison cases require the repository's approved legacy fixture. They are skipped when it is absent.
