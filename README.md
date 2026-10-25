# Synexus Subscription Service

Next.js control plane for PANDAS ERP activation, independent business licenses,
annual support, plan changes, manual payments, and audit history.

1. Copy `.env.example` to `.env.local`. Configure MongoDB Atlas or a replica set;
   production requires `MONGODB_TRANSACTIONS=true`.
2. Generate an Ed25519 key pair and configure `ENTITLEMENT_PRIVATE_KEY` and
   `ENTITLEMENT_PUBLIC_KEY`. Copy **only the public key** to each ERP as
   `SUBSCRIPTION_SIGNING_PUBLIC_KEY`.
3. Run `npm ci`, then `npm run bootstrap-admin -- admin@example.com YOUR_PASSWORD`.
   Enroll the printed TOTP secret in your authenticator. Use a unique password of
   at least 12 characters.
4. Deploy with `APP_URL=https://service.pandas.com.pk`. Sign in at `/admin`.
   Review the plan catalog, register the business/owner, explicitly select its
   support-expiry policy, and copy its activation code. Empty databases receive
   Basic/Premium/Enterprise defaults; existing catalog entries are preserved.
5. Existing agreements require explicit review before v2 enrollment. Existing
   activated agreements use Transfer with their restored local database.

Installation includes the first support year, starting at completed activation.
Annual support expiry and ERP access are separate. Every business requires a
successful verification every 30 days. Downgrades wait for local staff reduction.
Manual payment records use idempotency IDs; renewal does not remove suspension.
Online checkout and EasyPaisa callbacks are disabled (HTTP 410).

`npm test` runs unit tests. `node ../scripts/test-synexus.mjs` from this directory
runs transactional cloud and ERP integration tests using a disposable replica set.
`npm run build` validates the production Next.js application.

The health probe is `GET /api/v1/health`. The optional reconciliation endpoint can
expire historical online orders; new agreements use manual payment records.
See the parent project's `docs/synexus-subscriptions.md` for deployment, migration,
backups, recovery and the pilot rollout checklist. No remote software installer is
included.
