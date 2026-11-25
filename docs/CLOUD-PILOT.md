# Finance Atlas Cloud pilot

The existing Windows identity and encrypted vault format are retained. A local
build works offline. A cloud-enabled build adds optional Google sign-in, encrypted
snapshot sync, contextual Assistant responses, and public research. Use synthetic
records in the first deployment. Passwords, uploaded originals, and the document
library are stored only on the importing device. Gmail and Android are outside
the pilot.

## Configure the test project

1. In **Firebase Console → Authentication → Sign-in method**, enable Google.
   Firebase creates the user at the first successful Google sign-in. The **Add
   user** dialog creates an email/password user. The Dynamic Links shutdown
   banner concerns mobile email links and legacy OAuth flows. Finance Atlas uses
   browser Google OAuth and pairs Windows through the hosted browser flow.
   [Firebase Dynamic Links FAQ](https://firebase.google.com/support/dynamic-links-faq)
2. In **Firebase Console → Hosting**, confirm the actual site's `web.app` domain.
   Firebase creates default sites on demand for newer projects. The Hosting site
   ID can differ from the Firebase project ID. Add the exact hostname under
   **Authentication → Settings → Authorized domains** if it is missing. Use this
   same hostname as the web build's Firebase `authDomain`. If Google returns
   `redirect_uri_mismatch`, verify the exact `https://SITE_ID.web.app/__/auth/handler`
   URI under **Google Auth Platform → Clients** on the Web OAuth client used by
   the Firebase Google provider. Keep existing authorized redirects.
   [Default Hosting sites](https://firebase.google.com/docs/hosting/default-site) ·
   [Firebase Auth domain setup](https://firebase.google.com/docs/auth/web/redirect-best-practices)
3. In Mumbai (`asia-south1`), create the default Firestore database and a private
   regional Standard Cloud Storage bucket. Use uniform bucket-level access and
   public access prevention. Keep client Firestore access denied. Enable
   Cloud Run, Cloud Build, Artifact Registry, Vertex AI, Firestore, Cloud Storage,
   Firebase Authentication and IAM Service Account Credentials in the test project.
4. Create two dedicated Cloud Run runtime identities. Grant only the API identity
   Firestore access, Firebase Authentication user lookup for revoked-token checks,
   and bucket object read/create access. Grant it token signing on its own Firebase
   signer identity for custom tokens, with no downloaded JSON key. Give the worker
   identity Vertex AI User and keep it out of the database and bucket. Grant the API
   identity Cloud Run Invoker on the worker. Configure source deployment permissions
   for the deployer and Cloud Build separately from those runtime identities.
5. Configure a monthly ₹1,000 alert budget and check current region prices and
   Vertex AI model availability. Use a GA model that supports structured
   output in your project and chosen Vertex region. Pin that model ID in the worker
   configuration. Use the provider's regional endpoint where available and verify
   provider retention before enabling AI for personal figures. A Mumbai Cloud Run
   deployment does not constrain a `global` model endpoint to India. Hydrogen is
   a short-term GA model, and durable implicit caching is enabled by default.
   [Model lifecycle](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions) ·
   [Residency](https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/data-residency) ·
   [Caching and retention controls](https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/zero-data-retention)

## Deploy and build

Run the commands from the Finance Atlas project. Set the values locally from the
test project and Hosting setup. The API must exist before deploying the Hosting
rewrites. If the owner has not signed in before, deploy with
`ATLAS_OWNER_UID=unassigned` so the API denies vault access during setup.

On Windows, if PowerShell blocks `gcloud.ps1`, point the `gcloud` alias in the
current PowerShell session to the SDK’s Windows launcher. This allows the
commands below to run under the existing execution policy.

```powershell
Set-Alias -Name gcloud -Value '<path-to-google-cloud-sdk>\bin\gcloud.cmd'
gcloud auth login
```

```powershell
$atlasProject = 'your-test-project'
$atlasOwner = 'unassigned' # Use the actual Firebase Authentication UID if it already exists.
$atlasSiteHost = 'your-hosting-site.web.app'
$atlasBucket = 'your-private-bucket'
$atlasApiAccount = "atlas-api@$atlasProject.iam.gserviceaccount.com"
$atlasAgentAccount = "atlas-agent@$atlasProject.iam.gserviceaccount.com"
$atlasModel = 'your-verified-gemini-model-id'
$atlasVertexRegion = 'your-verified-vertex-region'

gcloud run deploy finance-atlas-agent --project $atlasProject --region asia-south1 --source agent --service-account $atlasAgentAccount --invoker-iam-check --no-allow-unauthenticated --min 0 --max 1 --timeout 45 --set-env-vars "GOOGLE_GENAI_USE_ENTERPRISE=true,GOOGLE_GENAI_USE_VERTEXAI=true,GOOGLE_CLOUD_PROJECT=$atlasProject,GOOGLE_CLOUD_LOCATION=$atlasVertexRegion,ATLAS_VERTEX_MODEL=$atlasModel"

$atlasAgentUrl = gcloud run services describe finance-atlas-agent --project $atlasProject --region asia-south1 --format 'value(status.url)'
gcloud run services add-iam-policy-binding finance-atlas-agent --project $atlasProject --region asia-south1 --member "serviceAccount:$atlasApiAccount" --role roles/run.invoker
gcloud run deploy finance-atlas-api --project $atlasProject --region asia-south1 --source api --service-account $atlasApiAccount --no-invoker-iam-check --min 0 --max 1 --timeout 55 --set-env-vars "ATLAS_FIREBASE_PROJECT=$atlasProject,ATLAS_OWNER_UID=$atlasOwner,ATLAS_SYNC_BUCKET=$atlasBucket,ATLAS_AGENT_URL=$atlasAgentUrl,ATLAS_ENABLE_AI=false"

$env:NEXT_PUBLIC_ATLAS_FIREBASE_API_KEY = 'your-firebase-browser-api-key'
$env:NEXT_PUBLIC_ATLAS_FIREBASE_PROJECT = $atlasProject
$env:NEXT_PUBLIC_ATLAS_FIREBASE_AUTH_DOMAIN = $atlasSiteHost
$env:NEXT_PUBLIC_ATLAS_ORIGIN = "https://$atlasSiteHost"
$env:ATLAS_HOSTING_SITE_ID = $atlasSiteHost -replace '\.web\.app$', ''
$env:ATLAS_RELEASE_SHA = (git rev-parse HEAD).Trim()
$env:NEXT_TELEMETRY_DISABLED = '1'
npm.cmd run build
npx.cmd --yes firebase-tools@15.37.0 deploy --only hosting,firestore:rules --config firebase.release.json --project $atlasProject
npm.cmd run desktop:build
```

If the worker already exists, use its actual service URL for `ATLAS_AGENT_URL`
and verify that the API identity has `roles/run.invoker` on that service.
`--set-env-vars` is for initial deployment. Use `--update-env-vars` when changing
settings on an existing service so you keep its other variables.

Open the deployed `web.app` address, create or unlock a local workspace, then go
to **Settings → AI & providers → Cloud connection → Connect to Google Cloud**.
Choose the owner account in the popup. If the API is waiting for its owner,
Firebase creates the account and Finance Atlas asks you to finish the owner
setup. Refresh **Firebase Console → Authentication → Users** and copy **User
UID**. In **Cloud Run → finance-atlas-api → Containers → Variables & Secrets**,
update `ATLAS_OWNER_UID`, then review and deploy the revision. Or run:

```powershell
$atlasOwner = 'your-firebase-authentication-uid'
gcloud run services update finance-atlas-api --project $atlasProject --region asia-south1 --update-env-vars "ATLAS_OWNER_UID=$atlasOwner"
```

Repeat **Connect to Google Cloud** with the same account. The Windows pairing
flow uses the live Hosting origin, so verify the web flow before testing Windows.

Cloud Run permits invocation of the API at its transport layer so Firebase
Hosting can route requests to it. Every finance route authenticates the owner
inside the API. The worker uses private IAM invocation. Desktop pairing requires
a one-time code and its matching verifier. It opens the system browser and
stores the resulting Firebase session in memory. The release build's CSP limits
desktop connections to the configured Hosting domain and Firebase token APIs.

## Verify before loading your finance history

- Open the hosted site and confirm `/health` responds. Cloud Run reserves some
  paths ending in `z`, including the previous public `/healthz` path.
  [Cloud Run reserved paths](https://docs.cloud.google.com/run/docs/known-issues#reserved-url-paths)
  Check that unauthenticated
  and non-owner requests to `/v1/sync/head` fail and that the worker rejects direct
  external invocation. Use the actual Hosting URL to test authorization forwarding,
  preflight and synthetic binary uploads including one near the 30 MB vault cap.
- Open a fictional vault in the upgraded Windows build. Use the gear to open
  **Settings → AI & providers → Connect to Google Cloud**, complete browser pairing,
  then select **Enable encrypted sync**. On a
  second device, create a temporary local vault, connect, select sync and choose
  **Use cloud version** with the first vault's passphrase. Confirm a later save on
  one device reaches the other with **Sync now**. Check divergent changes, wrong
  passphrases, backup export and restoration of both copies.
- Enable `ATLAS_ENABLE_AI=true` on the API only after those checks. Preview the
  transmitted fields, explicitly approve a synthetic analysis and verify both
  specialists, no-data and partial-failure cases. The five-analysis daily limit
  uses India time and is enforced transactionally before model calls.
- Monitor model usage, storage growth and authorization failures without bodies,
  raw finances or token logging. The pilot retains cloud revisions. Before
  automating cleanup, verify a retention job skips the current revision and any
  protected backups. Keep independent encrypted exports and test restoration
  outside the GCP project. Revoking Google account access and setting
  `ATLAS_ENABLE_AI=false` provide separate operational controls.

Google sign-in does not unlock or recover the vault. The passphrase is entered
on the device. Cloud Storage contains ciphertext and Firestore contains sync
metadata and counters. Gemini receives the approved figures for each analysis.

## Enable Assistant models and optional data feeds

Configure the API with `ATLAS_CHAT_MODELS`, a JSON object keyed by tested
model ID. Each value has `location`, `input` and `output` (USD per million
tokens) and an optional `pricingDate` in ISO format. Verify endpoint and project
availability and provider retention before enabling any model for personal
summaries. Use a regional model when you require regional processing.

```json
{
  "gemini-3.1-flash-lite": {
    "location": "global",
    "input": 0.25,
    "output": 1.5,
    "pricingDate": "2026-11-25"
  },
  "gpt-oss-120b-maas": {
    "location": "global",
    "input": 0.09,
    "output": 0.36,
    "pricingDate": "2026-11-25"
  }
}
```

GPT-OSS 120B uses the managed Model Garden chat endpoint and the Cloud Run
worker's Google Cloud identity. Verify Model Garden access with that identity
before adding the model to the deployed catalog. Its endpoint is global and
Google lists the United States as its processing location.

GPT-6 Luna (`gpt-6-luna`) and GPT-6.1 Terra (`gpt-6.1-terra`) use the
OpenAI Responses endpoint hosted by Google Cloud. Both require Model Garden
private-preview access and available project capacity. Add each ID to
`ATLAS_CHAT_MODELS` with `location: "global"` and the rates from the
project's approved offer after the worker identity returns a valid result.
The worker sends previews with response storage disabled. [OpenAI on Google Cloud](https://developers.openai.com/api/docs/guides/google-cloud)

Dashboard analysis and policy research use their configured Gemini models.
Verify pricing at deployment, including grounding, cache, reasoning, regional and long-context
charges where applicable. The app reports an estimate calculated from usage.
Provider invoices determine the final charge. Set
`ATLAS_AI_MONTHLY_USD_MICROS` to the app's shared monthly AI budget in millionths
of a USD. The default is 5,000,000 (USD 5). Set `ATLAS_ANALYSIS_MODEL` on the API
to the catalog ID that matches `ATLAS_VERTEX_MODEL` on the worker. Dashboard
analysis reserves an estimated cost from the shared budget and also has a
five-run daily quota. Firestore stores usage
metadata for the chat and policy flows without questions or answers.

Before sending personal figures, review the project cache configuration and
model request logging settings. Disabling durable caching preserves the
in-memory cache. Turning off caching disables both tiers and does not alter
other provider retention settings. Google Search grounding has separate
retention terms, so keep policy research limited to public product identifiers.
[Provider data retention](https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/zero-data-retention)

Set `ATLAS_POLICY_MODEL` on the API to a catalog model with Google Search
grounding, then test with an insurer's public product identifier. Google Search
receives the approved public fields. The worker IAM identity lacks access to
the sync database and snapshot bucket. The chat worker partitions the approved
facts among cash-flow, tax and portfolio specialists and makes no more than
three model calls. Direct OpenAI is disabled and Terra remains unavailable in
this build.

Investments uses the official AMFI NAV feed. To enable Dhan historical closes,
verify your personal data entitlement and supply a valid
`ATLAS_DHAN_DATA_TOKEN` through a restricted Secret Manager reference on the API.
The adapter uses the read-only historical-data endpoint. Refresh the credential
as required by Dhan. Use a synthetic holdings fixture to verify access and quote
dates. The portfolio keeps the most recent price available when refresh fails.
