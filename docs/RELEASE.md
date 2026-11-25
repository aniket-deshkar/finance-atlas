# Finance Atlas release and recovery

## Build and verify

Use Node 24, Python 3.12, and a current stable Rust toolchain for Windows. The checks workflow builds the static export, runs browser testing with fictional data, checks the API and ADK worker, and tests the debug Windows bundle in an isolated profile. It audits the npm and Python dependencies. Review the high and critical vulnerability findings from the API and worker container builds before promotion. The container scan reports findings in the workflow log.

```powershell
npm.cmd ci
npm.cmd run build
npm.cmd run check
npm.cmd test
npm.cmd run test:browser
npm.cmd ci --prefix api
npm.cmd test --prefix api
```

`npm run build` creates `out/release.json` and `firebase.release.json`. Supply `ATLAS_RELEASE_SHA` with the full commit ID for a release. Use the generated Firebase configuration for Hosting deploys and emulators. It authorizes the inline scripts in the static export by hash. It also pins Hosting rewrites to the ready API revision and leaves hashed assets immutable.

The worker installs the hash-locked dependencies in `agent/requirements.txt`. To change them, edit `agent/requirements.in`, regenerate with `uv pip compile --python-version 3.12 --universal --generate-hashes --output-file agent/requirements.txt agent/requirements.in`, then run the tests from `agent/` using Python 3.12. The ADK tests substitute a model fixture while exercising the real runner.

## Staging deployment

Use a separate Firebase and Google Cloud project with a test owner, private snapshot bucket and dedicated API and worker service identities. Configure Firebase Google sign-in for the exact staging Hosting origin. Use the [pilot setup](CLOUD-PILOT.md#configure-the-test-project) for first-time provisioning. Make the GitHub `staging` environment available only to trusted `dev` releases. Configure the workload identity provider to allow this repository and environment, and grant the staging release identity only the permissions needed to build and deploy these services.

Set the environment variables `ATLAS_GCP_PROJECT`, `ATLAS_HOSTING_SITE_ID`, `ATLAS_FIREBASE_WEB_API_KEY`, `ATLAS_PRODUCTION_PROJECT`, `ATLAS_PRODUCTION_SITE`, `ATLAS_WIF_PROVIDER` and `ATLAS_RELEASE_SERVICE_ACCOUNT` in that GitHub environment. The Firebase browser key is public configuration. Store any server-only data token as a Secret Manager reference on the API. The staging workflow uses short-lived credentials through workload identity federation.

Run **Deploy verified staging release** from `dev`. It expects already provisioned Cloud Run services and preserves their service settings and secrets except for the explicit concurrency, timeout, IAM invocation settings, and release metadata in the workflow. It rejects the declared production project and site. It checks that the worker rejects unauthenticated requests, records both ready service revisions, deploys the static export and validates that both Hosting and the API report the expected commit. The smoke check also requires the expected CSP and anonymous rejection on protected routes.

Before promoting, use a fictional vault to check owner sign-in, a non-owner denial, WebView2 pairing, and a snapshot close to 30 MB. Check simultaneous transfer memory usage and compare the worker's invoker policy to the expected API identity. Verify the configured analysis model and location match the worker's `ATLAS_VERTEX_MODEL` and `GOOGLE_CLOUD_LOCATION`. Run one approved question, one attention analysis, and one public policy research request. Review the output, usage, and provider-region settings. To publish a Windows installer, build a signed installer for the intended architectures and record its SHA-256 alongside the Hosting and Cloud Run revisions.

Record the prior worker revision before promotion. Rolling back Hosting also restores the pinned API route revision. Restore the corresponding worker revision's traffic independently in Cloud Run, then rerun the checks with the restored commit. Keep the verified release's images and revision identifiers available until its rollback window ends.

## Data recovery and operations

- The ledger archive `.atlasenc` and device library archive `.atlasdevice` protect different records. The device archive contains documents and Assistant history. It requires the original vault passphrase and an empty destination device library. It never overwrites the ledger. Use **Settings → Data, backup & security** to export or recover it. The export supports up to 30 MB of decrypted record data and a 42 MB encrypted archive. After a cloud vault switch, a local recovery snapshot can export records from the old namespace using the old passphrase while those records are still in the browser.
- Enable Firestore TTL for the `expires` field of the `pairings` collection group in staging. Expired tickets are rejected immediately by the API regardless of TTL scheduling. Confirm the TTL policy before enabling it in production.
- Snapshots are retained by default. Run `node api/scripts/snapshot-inventory.mjs` with an explicit `ATLAS_FIREBASE_PROJECT`, `ATLAS_SYNC_BUCKET`, and `ATLAS_OWNER_UID` and read-only Application Default Credentials. It reports counts of committed snapshots and older objects missing matching metadata. Before any cleanup, suspend writers, verify a current encrypted export, and recheck the head and retained metadata. The inventory never deletes data.
- The optional `ATLAS_HTTP_LOGGING=true` mode records response status, elapsed time, request ID, and route template for Cloud Run. Alert on repeated authorization failures, request timeouts, and dependency failures. Keep request bodies, credentials, and vault contents out of logs. Keep an independent budget alert on the staging and production projects.
