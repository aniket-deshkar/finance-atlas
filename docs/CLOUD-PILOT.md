# Finance Atlas Cloud pilot

The existing Windows identity and encrypted vault format are retained. A local
build works offline. A cloud-enabled build adds optional Google sign-in, encrypted
snapshot sync, contextual Assistant responses, and public research. Use synthetic
records in the first deployment. Passwords, uploaded originals, and the document
library are stored only on the importing device. Gmail and Android are outside
the pilot.

## Configure the test project

1. In a dedicated Firebase-enabled GCP test project, enable Google as a Firebase
   Authentication provider. Sign in once with the intended account and record
   its Firebase Authentication UID. If the user does not exist yet, first deploy
   with `ATLAS_OWNER_UID=unassigned`. Sign in on the hosted app. The backend will
   deny access, but Firebase will create the signed-in account. Look up the
   intended UID in Firebase Authentication, update the API environment, and
   repeat sign-in. Authorize the test Hosting domain and use
   the corresponding Firebase web app configuration. Use the Hosting domain
   itself as the Firebase auth domain so the SDK's reserved auth helper is
   same-origin. Register its `/__/auth/handler` redirect with the Google provider.
2. In Mumbai (`asia-south1`), create the default Firestore database and a private
   regional Standard Cloud Storage bucket. Use uniform bucket-level access and
   public access prevention. Keep client Firestore access denied. Enable
   Cloud Run, Cloud Build, Artifact Registry, Vertex AI, Firestore, Cloud Storage,
   Firebase Authentication and IAM Service Account Credentials in the test project.
3. Create two dedicated Cloud Run runtime identities. Grant only the API identity
   Firestore access, Firebase Authentication user lookup for revoked-token checks,
   and bucket object read/create access. Grant it token signing on its own Firebase
   signer identity for custom tokens, with no downloaded JSON key. Give the worker
   identity Vertex AI User and keep it out of the database and bucket. Grant the API
   identity Cloud Run Invoker on the worker. Configure source deployment permissions
   for the deployer and Cloud Build separately from those runtime identities.
4. Configure a monthly ₹1,000 alert budget and check current region prices and
   Vertex AI model availability. Use a GA Flash-family model that supports structured
   output in your project and chosen Vertex region. Pin that model ID in the worker
   configuration. Use the provider's regional endpoint where available and verify
   provider retention before enabling AI for personal figures.

## Deploy and build

Run the commands from the Finance Atlas project. The variable names below are
examples. Set them locally from the test project and Hosting setup.

On Windows, if PowerShell blocks `gcloud.ps1`, point the `gcloud` alias in the
current PowerShell session to the SDK’s Windows launcher. This allows the
commands below to run under the existing execution policy.

```powershell
Set-Alias -Name gcloud -Value '<path-to-google-cloud-sdk>\bin\gcloud.cmd'
gcloud auth login
```

```powershell
$atlasProject = 'your-test-project'
$atlasOwner = 'your-firebase-uid'
$atlasBucket = 'your-private-bucket'
$atlasApiAccount = "atlas-api@$atlasProject.iam.gserviceaccount.com"
$atlasAgentAccount = "atlas-agent@$atlasProject.iam.gserviceaccount.com"
$atlasModel = 'your-verified-gemini-model-id'
$atlasVertexRegion = 'your-verified-vertex-region'

gcloud run deploy finance-atlas-agent --project $atlasProject --region asia-south1 --source agent --service-account $atlasAgentAccount --no-allow-unauthenticated --min 0 --max 1 --timeout 45 --set-env-vars "GOOGLE_GENAI_USE_VERTEXAI=true,GOOGLE_CLOUD_PROJECT=$atlasProject,GOOGLE_CLOUD_LOCATION=$atlasVertexRegion,ATLAS_VERTEX_MODEL=$atlasModel"

$atlasAgentUrl = gcloud run services describe finance-atlas-agent --project $atlasProject --region asia-south1 --format 'value(status.url)'
gcloud run services add-iam-policy-binding finance-atlas-agent --project $atlasProject --region asia-south1 --member "serviceAccount:$atlasApiAccount" --role roles/run.invoker
gcloud run deploy finance-atlas-api --project $atlasProject --region asia-south1 --source api --service-account $atlasApiAccount --allow-unauthenticated --min 0 --max 1 --timeout 55 --set-env-vars "ATLAS_FIREBASE_PROJECT=$atlasProject,ATLAS_OWNER_UID=$atlasOwner,ATLAS_SYNC_BUCKET=$atlasBucket,ATLAS_AGENT_URL=$atlasAgentUrl,ATLAS_ENABLE_AI=false"

$env:NEXT_PUBLIC_ATLAS_FIREBASE_API_KEY = 'your-firebase-browser-api-key'
$env:NEXT_PUBLIC_ATLAS_FIREBASE_PROJECT = $atlasProject
$env:NEXT_PUBLIC_ATLAS_FIREBASE_AUTH_DOMAIN = "$atlasProject.web.app"
$env:NEXT_PUBLIC_ATLAS_ORIGIN = "https://$atlasProject.web.app"
$env:NEXT_TELEMETRY_DISABLED = '1'
npm.cmd run build
npx.cmd firebase-tools deploy --only hosting,firestore:rules --project $atlasProject
npm.cmd run desktop:build
```

Cloud Run permits invocation of the API at its transport layer so Firebase
Hosting can route requests to it. Every finance route authenticates the owner
inside the API. The worker uses private IAM invocation. Desktop pairing requires
a one-time code and its matching verifier. It opens the system browser and
stores the resulting Firebase session in memory. The release build's CSP limits
desktop connections to the configured Hosting domain and Firebase token APIs.

## Verify before loading your finance history

- Open the hosted site and confirm `/healthz` responds. Check that unauthenticated
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
  "gemini-4-hydrogen": {
    "location": "global",
    "input": 1.5,
    "output": 7.5,
    "pricingDate": "2026-11-16"
  }
}
```

This example uses the published global standard rates. Verify pricing at
deployment, including grounding, cache, reasoning, regional and long-context
charges where applicable. The app reports an estimate calculated from usage.
Provider invoices determine the final charge. Set
`ATLAS_AI_MONTHLY_USD_MICROS` to the app's monthly chat and policy budget in
millionths of a USD. The default is 5,000,000 (USD 5). The separate legacy
guided-review flow keeps its five-run daily quota. Firestore stores usage
metadata for the chat and policy flows without questions or answers.

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
