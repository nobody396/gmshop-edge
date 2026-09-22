# Administrator second factor: decision and acceptance gate

Status: design only; no MFA runtime, migration, deployment, or account change.
Scope: GMShop Edge (VIP storefront). Do not infer the AI gateway's capabilities
from this repository. The incident coordinator reports that the AI gateway
already offers TOTP but administrator enrollment remains outstanding; confirm
that separately on its own account-security surface.

## Owner choice

- Google Authenticator uses TOTP: scan a setup QR code locally, then enter a
  rotating six-digit code after the password. Other compatible authenticators
  can also produce these codes. Keep recovery codes offline; never paste the
  QR seed or recovery codes into chat, audit logs, or a support ticket.
- A passkey uses a device/password-manager-held private key with biometric/PIN
  approval. It can live on a phone, Mac, password manager, or hardware key;
  it is not limited to a phone. Device sync/recovery depends on the chosen
  provider. The website receives a public key, not the private key.
- Passkey sign-in alone is not proof that password/social sign-in requires a
  second factor. Do not advertise administrator MFA until server enforcement
  below is implemented and verified.

The owner has asked about convenience, not selected a method. Do not bind a
credential, activate a policy, or generate recovery material on their behalf.

## Current inspected implementation

- `bun.lock` resolves Better Auth 1.6.23. No Passkey dependency/table or MFA
  enrollment fields exist in the inspected tree.
- `src/features/auth/server/reauthenticate.ts` checks the current password for
  sensitive actions; this is not a second factor.
- `requireAdmin` and `getAdminPermissions` share `loadUserAccess` in
  `src/features/access/server/require-admin.ts`. Server contexts use both
  entry points. This is the narrow enforcement seam, not only `/admin` UI.
- `/api/auth/*` is public in `src/server/api-boundaries.ts`. Credential
  enrollment, replacement, and removal need their own server checks.

## Smallest safe Passkey option, if selected

Use a version-compatible Better Auth Passkey plugin; do not upgrade the whole
identity stack during containment. Better Auth continues to own sessions and
credentials; do not hand-roll WebAuthn verification.

1. Add the plugin's credential storage plus minimal durable enrollment policy
   and session-bound step-up evidence. Store neither private keys nor a
   client-controlled `mfaVerified` flag. Keep cryptographic options server-owned:
   fixed canonical RP ID/origin, required user verification, short-lived and
   single-use challenge tied to the authenticated user/session.
2. Existing administrators remain unenrolled until a supervised first binding.
   The first binding needs a fresh password and owner confirmation through a
   separately trusted channel; a compromised password/session must not silently
   turn an attacker's passkey into the owner's second factor.
3. Enable enforcement only after a real verification using the new credential
   and owner confirmation of a tested recovery path. Activation invalidates old
   administrative sessions. Do not globally require unbound root credentials.
4. At the shared server seam, enrolled administrators need live, same-user,
   same-session step-up evidence, regardless of email/password, social,
   Telegram, or any other first-factor login. Recheck authoritative enrollment;
   no stale KV or client cookie bypass. Failure must not fall back to password.
5. Factor addition/removal, policy disabling, sensitive exports, password/email
   changes, and recovery must not bypass an active policy. Never allow deletion
   of the final usable factor as an ordinary account action. Recovery is an
   explicit owner-assisted procedure with audit and session revocation, not a
   password-only or email-only automatic MFA reset.
6. Provide a small localized enrollment/challenge screen outside the protected
   admin shell so a challenged administrator can complete verification without
   a redirect loop. Preserve current password confirmation for sensitive
   exports; reducing that protection is not part of this change.

No generic authentication-provider framework, policy DSL, parallel identity
system, optional-login-only shortcut, or emergency global lockout switch.

## Release acceptance (all required, not yet executed)

- Fresh database and upgrade migration; existing unbound root stays usable.
- Real WebAuthn registration and assertion with virtual authenticator; owner
  later verifies a real device before production enforcement.
- Wrong RP/origin/user/session, replay, expired challenge, missing UV and
  concurrent challenge consumption fail closed.
- Password-only, social and Telegram sessions cannot call enrolled admin
  Server Functions or management APIs, including the `getAdminPermissions`
  path. Direct requests work no better than hidden UI controls.
- Deleting/changing factors, email/password recovery, cached permissions and
  reused/revoked sessions cannot remove or bypass the requirement.
- Enrollment activation and recovery revoke old sessions; only enrolled
  administrators are affected; ordinary checkout/payment webhooks are intact.
- Recovery tested before activation; root cannot be permanently locked out.
- Both locales, keyboard, mobile, browser-cancel/retry, and biometric/PIN
  failure are handled without leaking credential material.
- Ablation: removing the shared server gate makes bypass tests fail; removing
  session binding makes cross-session tests fail; remove unused abstractions.

## Owner-operated rollout

1. Choose TOTP or Passkey (do not assume that recommending one is selection).
2. For AI gateway TOTP, use its existing account-security enrollment and verify
   a code personally; verify actual login enforcement and backup recovery on
   that product. This does not enable VIP MFA.
3. For VIP, implement and pass the acceptance gate first, then open the real
   production account-security page. Owner performs biometric/PIN approval or
   scans the TOTP seed privately; agents must not inspect the secret material.
4. Owner stores recovery material securely and tests a backup method. Activate
   their policy only after a successful fresh challenge; confirm old password-
   only session cannot access management. Report other admins still unenrolled.

## Official references

- [Better Auth Passkey](https://better-auth.com/docs/plugins/passkey): plugin,
  server-owned RP/origin/user-verification options, schema and device behavior.
- [Better Auth 2FA](https://better-auth.com/docs/plugins/2fa): TOTP and recovery;
  default credential sign-in enforcement does not automatically cover all
  passwordless/social paths. Check matching-version source before coding:
  latest docs describe features newer than the installed 1.6.23 package.
