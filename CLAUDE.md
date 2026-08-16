# CLAUDE.md

Compact context for Claude Code when working on Orbyx.

## Stack And Architecture

Orbyx is a multi-tenant SaaS booking platform.

- Frontend: Next.js App Router in `orbyx-web/`.
- Backend: Node.js + Express monolith in root `server.js`.
- Database/storage: Supabase.
- Email: Resend through `email.js`.
- WhatsApp: Twilio through `whatsapp.js` (Content Templates, confirmation + reminder only — see "WhatsApp (Twilio) Integration" below).
- Calendar: Google Calendar OAuth/API, using `calendar_connections` and legacy `calendar_tokens`.

Most business logic lives in `server.js`. Most frontend dashboard/public pages are client components with page-local state and direct `fetch`.

## Main Modules

| Module | Main files | Backend areas |
|---|---|---|
| Public booking | `orbyx-web/app/[slug]/page.tsx`, `orbyx-web/app/api/public-*`, `orbyx-web/app/api/appointments/slot/route.ts` | `/public/services`, `/public/staff`, `/public/slots`, `/appointments/slot` |
| Dashboard shell | `orbyx-web/app/dashboard/[slug]/layout.tsx` | `/public/business`, `/branches` |
| Agenda | `orbyx-web/app/dashboard/[slug]/agenda/page.tsx` | `/appointments/by-range`, `/appointments/status`, `/appointments/close` |
| Business config | `orbyx-web/app/dashboard/[slug]/business/page.tsx` | `/tenants/:id`, `/business-hours`, `/business-special-dates`, `/booking-fields` |
| Branches | `orbyx-web/app/dashboard/[slug]/branches/page.tsx` | `/branches` |
| Staff | `orbyx-web/app/dashboard/[slug]/staff/page.tsx` | `/staff`, `/staff-hours`, `/staff-special-dates`, `/staff-services` |
| Services | `orbyx-web/app/dashboard/[slug]/services/page.tsx` | `/services`, `/staff-services` |
| Customers/campaigns | `customers/*`, `campaigns/*` | `/customers`, `/pets`, `/campaigns/*` |

## IA Editing Rules

- Analyze first, edit after understanding the exact owner file/block.
- Make minimal changes.
- Do not restructure the project without explicit authorization.
- Do not modify backend unless the task explicitly requires backend changes.
- Do not modify global styles unless explicitly requested.
- State which files will be modified before editing and why.
- Do not remove existing code without explaining the reason.
- Do not rename critical files unnecessarily.
- Prefer reusing existing components, helpers, endpoints, and page-local patterns.
- Keep mobile responsive behavior intact.
- Maintain multi-branch compatibility.
- Do not break availability logic.
- Do not break public booking flow.
- Validate relationships between `appointments`, `services`, `staff`, `branches`, and `tenants`.
- Avoid massive refactors and broad formatting churn.
- Avoid unnecessary reads of very large files; inspect targeted sections with search/context.
- Preserve existing API response shapes and Supabase table contracts.

## Multi-Branch Rules

Multi-branch behavior is critical.

- Dashboard active branch is stored as `orbyx_active_branch_${slug}`.
- Dashboard pages listen for `orbyx-branch-changed`.
- Staff, services, hours, appointments, slots, agenda, and public booking depend on `branch_id`.
- Backend `resolveBranchId({ tenant_id, branch_id })` validates provided branches and may fall back to the first active branch when missing.
- Do not use fallback as a substitute for the dashboard active branch.
- Do not add tenant-wide reads/writes to branch-specific screens.

## Availability Flow

Availability is calculated in `server.js`; treat it as high risk.

Core helpers:

- `getEffectiveBusinessAvailability`
- `getEffectiveStaffAvailability`
- `applySpecialDatesToWindows`
- `subtractAppointmentsFromWindows`
- `buildSlotsFromWindows`
- `filterSlotsForServiceDuration`
- `filterSlotsByVisibleStep`
- `filterPastSlots`

Rules:

- Timezone is `America/Santiago`.
- Business hours can be global or branch-specific.
- Branches can use global hours or local hours.
- Global special dates are applied; branch special dates may also apply depending on branch flags.
- Staff can use business hours or staff-specific hours.
- Staff availability must fit inside business availability.
- Staff special dates apply after staff hours are resolved.
- Individual bookings subtract existing booked appointments.
- Group bookings use capacity and available spots.
- Service total duration is `duration_minutes + buffer_before_minutes + buffer_after_minutes`.
- Public slots respect min booking notice and max days ahead.

## Booking Flow

Public booking:

1. `/{slug}` loads business, branches, and services.
2. Service selection loads staff.
3. Date/staff selection loads slots.
4. Submit calls `/api/appointments/slot`.
5. Next route forwards to backend `/appointments/slot`.
6. Backend validates, inserts appointment, upserts customer/pet data, attempts calendar sync, and sends email when configured.

Booking validation must preserve:

- required fields, valid email, Chilean mobile phone normalization
- active calendar
- tenant and branch ownership
- service belongs to tenant/branch and is not deleted
- staff belongs to tenant/branch and performs selected service when `staff_id` is provided
- slot still exists after backend recalculation
- duplicate individual appointment prevention
- group capacity enforcement
- customer overlap prevention
- min notice and max days ahead

Google Calendar failure must not delete a valid local booking.

## Agenda Rules

- Agenda must load appointments with `branch_id`.
- Optional filters: `staff_id`, service, status.
- Statuses: `booked`, `completed`, `no_show`, `rescheduled`, `canceled`.
- Manual booking must use the same backend booking validation path.
- Group appointments display grouped blocks using service metadata.
- Veterinary close flow creates followups and marks appointments completed.
- Agenda visual availability is not the source of truth; backend booking validation is.

## WhatsApp (Twilio) Integration

Implemented 2026-08-01. Confirmation + reminder only — WhatsApp AI conversational (`max_ia_wa`) is a separate, not-yet-implemented piece.

- Send wrapper: `whatsapp.js`, `sendWhatsAppTemplate({ to, contentSid, variables })` — mirrors `email.js`'s error-isolation pattern exactly: internal try/catch, never throws, returns `{ ok, reason }`. `to` must already be E.164 with `+` (e.g. `+56912345678`); the `whatsapp:` prefix is added inside the function. `variables` is a plain object with numeric keys (`{ 1: "...", 2: "..." }`), JSON.stringify'd into Twilio's `contentVariables`.
- Twilio client uses API Key auth (`twilio(TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, { accountSid: TWILIO_ACCOUNT_SID })`), not the classic auth token. Sends directly from `TWILIO_WHATSAPP_NUMBER` — no Messaging Service SID is used or required. **Confirmed (not assumed) as of 2026-08-01**: this env var's value in Render already includes the `whatsapp:` prefix (e.g. `whatsapp:+56967960624`), not just the bare E.164 number. `whatsapp.js`'s `toWhatsAppAddress()` helper normalizes this defensively (strips/re-adds the prefix so it's never duplicated) — do not revert to a bare template-literal `` `whatsapp:${TWILIO_WHATSAPP_NUMBER}` `` without going through that helper, or sends will silently fail with Twilio error "The 'From' number ... is not a valid phone number" (seen in prod 2026-08-01, root cause was exactly this double-prefix).
- Env vars (already set in Render, redeployed 2026-08-01): `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, `TWILIO_WHATSAPP_NUMBER`, `TEMPLATE_CONFIRMACION_SID`, `TEMPLATE_RECORDATORIO_SID`. **Plus `TWILIO_AUTH_TOKEN` (added 2026-08-02, classic Account Auth Token, different from the API Key pair)** — needed only to validate `X-Twilio-Signature` on the status-callback webhook below, never used for outbound sends. As of the 2026-08-02 session end, not yet confirmed as actually added in Render — check before assuming cupo counting works.
- Two independent per-tenant toggles, plain columns on `tenants` (no JSON settings bag — matches the table's existing convention): `wa_confirmation_enabled` (bool, default false), `wa_reminder_enabled` (bool, default false), `wa_reminder_hours_before` (smallint, 1 or 2, default 1). All default OFF for every tenant — nothing sends until explicitly enabled. `PATCH /tenants/:id` also accepts these 3 fields (same conditional-spread pattern as `business_category`/`business_subcategory`) but is **not** what the dashboard UI calls — see next bullet.
- **Dashboard UI (added 2026-08-02)**: `components/billing/AccountStatusWidget.tsx` — a "Notificaciones a clientes" sub-section inside the existing account-status dropdown (the same one showing trial/pago/cupos WA-IA), visible only when `isOwnerOrAdmin` (new prop, passed from `dashboard/[slug]/layout.tsx` where it was already computed). Two `MiniToggle` switches + a 1h/2h button pair for the reminder (only rendered when the reminder toggle is on), each saving immediately (optimistic update, reverts on failure) against `PATCH /tenants/:id/whatsapp-settings` — a **new, deliberately separate** endpoint from `PATCH /tenants/:id`. Reason: `PATCH /tenants/:id` requires `name` and nulls out every other optional field not present in the body (safe only for the full Business-settings form, which always sends the whole payload) — calling it with a partial `{ wa_confirmation_enabled: true }` from a small widget would have silently wiped `phone`/`address`/`email`/`logo_url`/etc. The new endpoint only ever touches the 3 wa_* columns, uses the same `tenantAuthParamWrite` middleware (owner/admin-only via `WRITE_ACCESS_MODULE_RULES`'s `/tenants` prefix rule). Initial toggle state comes from `GET /billing/account-status`, which now also returns `wa_confirmation_enabled`/`wa_reminder_enabled`/`wa_reminder_hours_before` (3 columns added to its existing `tenants` select — no new query). The "Uso este mes: X/Y" line in that sub-section reuses `status.wa_confirmacion` from the same response, not a new query.
- Confirmation (event-driven): hooked into `POST /appointments/slot` right after the existing Resend email call. Checks `tenants.wa_confirmation_enabled`, then `checkMonthlyUsage(tenant_id, "wa_confirmacion")` before sending; on a successful send calls `trackWhatsAppMessage()` (records the attempt, does NOT increment cupo yet — see below). Template vars in order: `{{1}}` customer name, `{{2}}` business name, `{{3}}` date (`formatDateCL`), `{{4}}` time (`formatTimeCL`), `{{5}}` address or service name as fallback.
- Reminder (time-driven cron): `POST /whatsapp/maintenance/send-reminders`, guarded by the existing `requireSignupMaintenanceSecret` + `publicLimiter` (same pattern/secret as `/signup/maintenance/sweep` and `/billing/addons/maintenance/charge-recurring` — header `x-maintenance-secret`, env var `SIGNUP_MAINTENANCE_SECRET`). Meant to be hit by an external cron (cron-job.org) every 15-30 min. Pulls `booked` appointments with `wa_recordatorio_enviado = false` inside a wide window (`now+1h` to `now+2h+30min`), then per-row resolves the tenant's actual `wa_reminder_hours_before` and only sends if `now` falls inside that specific target-time ± 30min margin. On successful send calls `trackWhatsAppMessage()` (same as confirmation, no immediate increment), then sets `appointments.wa_recordatorio_enviado = true` right after to prevent duplicate sends across cron runs. Template vars in order: `{{1}}` customer name, `{{2}}` business name, `{{3}}` time, `{{4}}` address.
- **Confirmation and reminder share one monthly counter**: both use resource `"wa_confirmacion"` — this matches the existing `addon_config` addon definition (`"WA confirmación+recordatorio"`, `grants: { wa_confirmacion: 50 }`) which was already designed for a shared pool, not two separate counters. `plan_config.max_wa_confirmacion` is the per-plan base cap; `GET /billing/account-status` and `GET /billing/addons` already read/display this counter and needed no changes.
- **Cupo is only counted on confirmed delivery (added 2026-08-02), not on send attempt.** Originally `incrementMonthlyUsage` was called right after `sendWhatsAppTemplate` returned `ok: true` — but `ok: true` only means Twilio *accepted* the send (`queued`/`sent`), not that WhatsApp actually delivered it (see error 63016 below: a send can be accepted and still end up `Undelivered`/`Failed`, which was wrongly consuming cupo). Fixed with a Twilio Status Callback:
  - `whatsapp.js` now sets `statusCallback: "https://orbyx-backend.onrender.com/whatsapp/status-callback"` (hardcoded self-reference, same pattern as Flow's `urlCallback`/`url_return`) on every `messages.create()` call, and returns `sid` on success.
  - New table `whatsapp_message_log` (migration `2026-08-02-whatsapp-message-log.sql`): `message_sid` (unique), `tenant_id`, `resource`, `status`, `counted`. Both send call sites (`POST /appointments/slot` confirmation, reminder cron) now call a new `trackWhatsAppMessage()` helper (next to `checkMonthlyUsage`/`incrementMonthlyUsage`) to insert a row here instead of incrementing directly.
  - New `POST /whatsapp/status-callback` (`publicLimiter` + `express.urlencoded`): Twilio POSTs here on every status change (`queued`→`sent`→`delivered`/`read`, or `failed`/`undelivered`). Validates `X-Twilio-Signature` via `twilio.validateRequest(TWILIO_AUTH_TOKEN, signature, hardcodedUrl, req.body)` — the officially Twilio-recommended way to verify a webhook actually came from them. **Can't use this codebase's usual `x-maintenance-secret` shared-secret pattern here** — Twilio Status Callbacks don't support custom headers, only a URL. If `TWILIO_AUTH_TOKEN` isn't set, the endpoint logs an error and no-ops (fails safe: nothing gets counted, rather than accepting unverified requests).
  - Only increments `incrementMonthlyUsage` the *first* time a given `message_sid` reaches `MessageStatus === "delivered"` (guarded by the `counted` column, since WhatsApp can also later send a `read` event for the same message — must not double-count). `failed`/`undelivered` just update `status`, never increment.
  - Chose `"delivered"` over `"sent"` deliberately, per Twilio's own semantics: `"sent"` only means Twilio handed the message to WhatsApp's servers, not that the phone received it — `"delivered"` is WhatsApp's actual acceptance confirmation. This is exactly why `"sent"` was the wrong signal originally.
  - **No historical backfill**: sends made before this fix already incremented `tenant_monthly_usage` directly at send time (old behavior) and have no `whatsapp_message_log` row. If any of those old attempts failed and over-counted, that needs a manual correction in `tenant_monthly_usage` — see [[project_whatsapp_twilio_integration]] memory for the exact tenant/count from the 2026-08-02 test batch.
- Both send paths are best-effort and never block/break their caller: a missing toggle, an exhausted cupo, or a Twilio failure all just `console.warn` and continue — appointment creation and the reminder loop are unaffected.
- Migrations: `2026-08-01-whatsapp-twilio-toggles.sql` (the 3 `tenants` toggle columns, `appointments.wa_recordatorio_enviado`, partial index) and `2026-08-02-whatsapp-message-log.sql` (the `whatsapp_message_log` table above) — both repo root.
- **Known gap**: `GET /jobs/send-reminders` (the pre-existing 24h *email* reminder job, unrelated to this WhatsApp reminder) has no auth check at all — flagged but intentionally not touched this session, since it's a separate pre-existing concern.
- **Not built (explicitly out of scope)**: WhatsApp AI conversational (`max_ia_wa`) sending — that's Piece 2, future session.
- **Debug logging still live in prod as of 2026-08-02**: `server.js`'s WA confirmation block (in `POST /appointments/slot`) and `whatsapp.js`'s `sendWhatsAppTemplate` both have verbose `[WA] ...` console logs added while chasing the double-prefix bug and error 63016 (raw Twilio payload, raw response/error, cupo check results, a 15s manual timeout via `Promise.race` since the Twilio SDK v6 client exposes no timeout option without a custom `httpClient`). None of this is gated behind a debug flag — it logs on every real send. Worth trimming once the integration is confirmed stable in production, but intentionally left in for now since active troubleshooting is still ongoing (see error 63016 below).
- **Known unresolved issue as of 2026-08-02**: confirmation sends reach Twilio (`queued`/`sent` in Twilio Console) but end up `Undelivered`/`Failed` with error 63016 ("Outside messaging window. For WhatsApp, use a Message Template instead."), despite `contentSid`/`contentVariables` being sent correctly (verified: no `body`/`mediaUrl` mixed in, correct JSON-string format). Per Twilio's own docs this error can fire even with a valid `contentSid` if the underlying Content Template's WhatsApp approval status isn't actually "Approved", or its content type isn't eligible for business-initiated messages. **Needs to be checked in Twilio Console → Content Template Builder** for `TEMPLATE_CONFIRMACION_SID` (`HX01cc29af2e1cca0a1e12a88c6bb9a0f6`) — this is a Twilio/Meta-side config check, not a code fix.

## Account Status Widget — Realtime Cupo (added 2026-08-02)

`orbyx-web/components/billing/AccountStatusWidget.tsx`'s "Estado de mi cuenta" dropdown now updates its `wa_confirmacion`/`ia_wa` usage pills live instead of only on initial fetch.

- Subscribes to `postgres_changes` (`event: "*"`) on `tenant_monthly_usage`, filtered by `tenant_id=eq.${tenantId}`, in a `useEffect` gated on `open` (the dropdown's open state) — subscribes on open, `supabase.removeChannel()` on close/unmount. Reuses the exact same channel pattern already established in `dashboard/[slug]/layout.tsx`'s appointment-notification channel, not a new one.
- Incoming rows are matched against the current `YYYY-MM` period client-side (`row.period !== currentPeriod` rows are ignored) and stored in a local `liveUsage` override map, layered on top of (not replacing) the `status` object from `useAccountStatus` — keeps the initial-fetch hook untouched.
- A brief boxShadow pulse (900ms, `pulseField` state) highlights whichever pill (`wa_confirmacion` or `ia_wa`) just changed.
- Threshold-based alert coloring (`getUsageAlertState`, both counters, independent): `<80%` normal, `80–99%` amber + "Cerca del límite", `>=100%` red + "Cupo agotado este mes". Replaced the old ad-hoc `nearLimit` (remaining ≤ 10%) heuristic.
- **Requires `2026-08-02-tenant-monthly-usage-rls.sql` to actually be run** — without RLS + the table being in the `supabase_realtime` publication, either no events arrive at all (table not in publication) or, worse, events arrive for every tenant, not just the current one (RLS not enabled) — see Security Rules above. Not yet confirmed as run against prod as of session end.

## Deposit Required (Pre-Payment Hold) — added 2026-08-02

Optional per-tenant flow: customer must upload a bank-transfer receipt before the booking is confirmed. Orbyx never touches money — this is proof-of-payment + manual tenant review, no payment gateway involved.

- **No new `appointments.status` value.** The de-facto status enum (`booked`, `completed`, `no_show`, `rescheduled`, `canceled`) is validated only at the app level (server.js, `PATCH /appointments/:id/status`'s `allowed` array) — no DB enum/CHECK constraint found in the repo. Slot-blocking logic is scattered across at least 4 separate call sites that each filter on `status = 'booked'` (`subtractAppointmentsFromWindows`, the capacity/duplicate checks in `POST /appointments/slot`, `GET /public/slots/:slug/:service_id`). Adding a new status would have required touching all 4 consistently — high risk of missing one and allowing double-booking. Instead: a deposit-pending appointment is inserted with `status: "booked"` immediately (blocks the slot for free via every existing check, untouched), and the review state lives in a separate `deposit_status` column (`pending`/`confirmed`/`rejected`/`expired`) plus `deposit_hold_expires_at`. Rejecting or expiring just flips `status` to `"canceled"`, which already frees the slot everywhere with zero additional code changes. Full reasoning also documented at the top of `2026-08-02-deposit-required.sql`.
- **Tenant config**: `tenants.deposit_required` (bool, default false) + 5 flat columns (`deposit_bank_name`, `deposit_account_type`, `deposit_account_number`, `deposit_holder_rut`, `deposit_holder_name`). **Turning the toggle off does NOT clear the bank fields** (deliberate — Camilo confirmed this preference; re-enabling shouldn't require re-entering data). Saved via a new, deliberately separate `PATCH /tenants/:id/deposit-settings` endpoint (same reasoning as `whatsapp-settings`: `PATCH /tenants/:id` requires `name` and nulls unlisted optional fields, unsafe for a small widget sending one field at a time).
- **Dashboard UI**: `AccountStatusWidget.tsx`'s "Estado de mi cuenta" dropdown, new "Depósito previo" sub-section below "Notificaciones a clientes" — toggle + 5 text inputs (account type is a `<select>` with 3 common Chilean options, not free text) that reveal when the toggle is on, each saving on blur/change individually. If any of the 5 fields is empty, an inline amber warning shows ("los clientes no verán esta sección hasta entonces") but the toggle save is NOT blocked — the public page simply skips rendering empty fields. `GET /billing/account-status` returns the current values (3 more columns added to its existing `tenants` select, same pattern as the WA toggles).
- **Public booking (`orbyx-web/app/[Slug]/page.tsx`)**: when `business.deposit_required` (already present in the page's business fetch via `select("*")`, no backend change needed there — see `BusinessItem` type), the form shows the bank details + a file input (JPG/PNG/PDF, 5MB max, validated client-side and server-side) right before the submit button. On submit: `POST /appointments/slot` creates the appointment (unchanged request shape — the backend decides deposit handling from `tenants.deposit_required`, not from anything the client sends) and returns `deposit_required: true`, `deposit_hold_expires_at`, `deposit_upload_token` (= the appointment's existing `cancel_token`, reused as the receipt-attach secret — same pattern as the public cancel flow, no new auth mechanism invented). The frontend then uploads the file and attaches it in two calls (see Storage below), and renders a new, separate "Pendiente de confirmación" screen (NOT the existing "Reserva confirmada" screen, which is untouched and still used for non-deposit tenants) with a 15-minute countdown that's purely informational — the real hold expiry is enforced server-side by the cron below, not the client's clock.
- **Storage (`deposit-receipts` bucket, created in the migration)**: unlike `business-logos` (public bucket, `getPublicUrl`), this bucket is **private** — a payment receipt is a financial document, more sensitive than a logo. Upload route `orbyx-web/app/api/upload-deposit-receipt/route.ts` mirrors `upload-business-logo`'s pattern exactly (formData → service role key → `storage.upload()`) but returns only the Storage `path`, never a public URL. Attaching that path to a specific appointment is done by the backend (`POST /appointments/:id/deposit-receipt`), gated by the `cancel_token`. Viewing a receipt from the dashboard uses `GET /appointments/:id/deposit-receipt-url`, which generates a 5-minute signed URL on demand (owner/admin or agenda-write role only, via `requireTenantWriteAccessForResource`). **No automatic old-receipt cleanup implemented this session** — flagged as future work.
- **Agenda review (`dashboard/[slug]/agenda/page.tsx`)**: new "Depósitos pendientes" toolbar button next to Semana/Día (visible only when `deposit_required`), with a live count badge. Realtime: subscribes to `postgres_changes` on `appointments` filtered by `tenant_id`, same channel/lifecycle shape as the account-status widget's cupo subscription, but simplified to "refetch the pending-deposits list on any event" rather than patching state from the payload — appropriate here since what's needed is an accurate count, not a single live number. Clicking the button opens a modal (no reusable modal component exists in this codebase — built by mirroring the existing inline `fixed inset-0 z-[90]` overlay markup already used 6 times elsewhere in this same file) listing one card per pending deposit: customer/service/time, a per-card countdown (one shared 1s interval, not one timer per card), receipt thumbnail (image inline, PDF as a link — both via the signed-URL endpoint, fetched lazily per card), and Confirmar/Rechazar buttons.
- **Confirm** (`POST /appointments/:id/deposit/confirm`): sets `deposit_status = "confirmed"`, then calls `sendBookingConfirmations()` — a function **extracted from the inline email+WhatsApp block that already existed in `POST /appointments/slot`**, so the deposit-approval path sends the exact same Resend email and `TEMPLATE_CONFIRMACION_SID` WhatsApp template a normal booking gets, no Twilio-side changes. Known limitation: pet name/species aren't re-resolved from `appointments.pet_id` at confirm time, so the confirmation email for a veterinary tenant using deposits will be missing that detail — acceptable edge case, not fixed this session.
- **Reject** (`POST /appointments/:id/deposit/reject`): cancels immediately (no waiting for the 15-min hold), frees the slot. **No automated rejection notice to the customer** — no approved WhatsApp Content Template exists for this (creating one requires Meta/Twilio approval, out of scope) and `sendBookingEmail`'s copy is confirmation-only, doesn't fit a rejection. Tenant is expected to contact the customer directly. Flagged as future work, not silently skipped.
- **Expiry cron** (`POST /appointments/maintenance/release-expired-deposits`): same `requireSignupMaintenanceSecret`/`x-maintenance-secret`/`publicLimiter` pattern as the other maintenance jobs — **Camilo needs to add this as a 4th job on cron-job.org** (every 15-30 min, same cadence recommendation as the WhatsApp reminder cron). Sets `deposit_status = "expired"` (distinct from tenant-initiated `"rejected"`, for reporting) and `status = "canceled"`.
- **Migration**: `2026-08-02-deposit-required.sql` (repo root) — tenant columns, appointment columns + partial index, and the `deposit-receipts` Storage bucket (inserted via SQL into `storage.buckets`; if that insert fails on permissions, the migration file has manual Dashboard-creation instructions as a fallback). Not yet confirmed as run against prod as of session end.

## Terms of Service (Legal Acceptances) — added 2026-08-16

Mandatory Terms of Service acceptance (Ley 19.496 art. 12 A compliance) across both registration flows. `legal_acceptances` table + its RLS policy were created directly in Supabase by Camilo this session (join against `tenant_users` on `user_id = auth.uid() AND is_active = true`, matching this project's existing RLS pattern — see `2026-08-02-tenant-monthly-usage-rls.sql` — not a `auth.jwt()` custom claim, which this project doesn't set). No corresponding `.sql` migration file exists in the repo for this table — same as `appointments`' RLS, see Known Risks.

- **Content source**: `orbyx-web/terminos-de-servicio-orbyx.md` (repo root of orbyx-web, left untracked — not committed) is the canonical legal text, drafted with Anexo A (Acuerdo de Tratamiento de Datos / DPA) in the same file. Its block-structured content (`h2`/`h3`/`p`/`ul`/`ol`/`table`/`hr`) is duplicated **verbatim, unaltered text** in two places that must be kept in sync if a new version is published: `orbyx-web/app/terminos/page.tsx` (`content` array, same JSX rendering pattern as `app/privacidad/page.tsx`) and `email.js` (`LEGAL_TERMS_BLOCKS` array, rendered to inline-styled HTML for the confirmation email by `renderLegalBlocksToHtml`). Cross-repo duplication is unavoidable: orbyx-web is a separate submodule/Vercel deploy, can't import from the backend repo at build time.
- **`/terminos` page**: mirrors `/privacidad`'s structure exactly (same `PublicThemeProvider`/`PublicHeader`/`PublicFooter`, same `Block` renderer, tables with contained horizontal scroll). Adds a "🖨️ Imprimir o guardar como PDF" button (`window.print()`) plus `@media print` rules (`.pub-print-hide` / `.pub-print-content` classes) that hide header/footer/nav and force black-on-white text for the printed/PDF copy — the legal requirement is that the customer can store/print the contract *before* accepting it. `FECHA_PUBLICACION` is hardcoded to the deploy date (`"16 de agosto de 2026"`), same pattern as `/privacidad`'s `FECHA_PUBLICACION` — update by hand on the next version.
- **Footer**: `PublicFooter.tsx` now shows both "Términos de Servicio" (→ `/terminos`) and "Política de Privacidad" (→ `/privacidad`) side by side.
- **Checkbox — two registration flows, one shared component**: `orbyx-web/components/auth/TermsAcceptanceCheckbox.tsx` (never pre-checked, `required`, links to `/terminos` and `/privacidad` with `target="_blank" rel="noopener"`) is used in both:
  - `app/signup/page.tsx` (Pro plan / free onboarding — `supabase.auth.signUp()` directly from the client).
  - `app/checkout-premium/page.tsx` (Premium/VIP/Platinum — shown *before* the Flow card-registration redirect, per Camilo's explicit requirement that the customer must be able to read/accept before being charged, not after).
  In both, the submit button's `disabled` expression got `|| !acceptedTerms` added alongside the existing loading/validation/captcha conditions — this is the actual enforcement; the backend does not re-check a "consent" flag, since there was no natural place to thread one through (see below).
- **Two distinct places a registration actually "completes"**: this app has two separate signup flows that both eventually create a `tenant_users` row, and `legal_acceptances` needs a real `tenant_id`, so recording happens at whichever backend call is the one that pairs `tenant_id` + `user_id` together for the first time — not at the checkbox's page itself, which is often much earlier:
  - **Pro flow**: `POST /tenants/provision` (`server.js`) — called from `orbyx-web/app/login/page.tsx`'s `resolveTenantDestination()` on the user's *first login after email verification* (not from `/signup` itself — email verification means the actual tenant/owner link happens later, at first login). Fires exactly once per user (guarded by `tenant_users` not existing yet).
  - **Premium/VIP/Platinum flow**: `POST /signup/claim-account` (`server.js`) — called from `/completar-registro` after Flow payment succeeded and the customer sets their password. Fires exactly once per `signup_intent` (guarded by the existing-owner check).
  - Both call the new shared helper `recordLegalAcceptancesAndSendConfirmation()` (defined next to `linkTenantOwner` in `server.js`), passing `ip_address` (from `x-forwarded-for` via the new `extractClientIp(req)` helper — first entry, matching Render/Vercel-as-proxy) and `user_agent` from **that** request (the login/claim-account request itself, not the earlier moment the checkbox was actually ticked — there's a time gap, especially in the paid flow, but this matches what was explicitly asked for and avoids inventing a way to carry IP/UA across requests/days just to shave that gap).
- **`legal_acceptances` rows**: 2 per completed registration (`document_type: "terms"` v1.0 → `https://www.orbyx.cl/terminos`, `document_type: "privacy"` v2.0 → `https://www.orbyx.cl/privacidad`), same `accepted_at`, inserted with the service role key (never from the client). Insert failure is caught and logged, never blocks the registration response.
- **Confirmation email**: `sendLegalAcceptanceConfirmationEmail()` (`email.js`) sends the full Términos + Anexo A text (via `renderLegalBlocksToHtml`) in the email body, not just a link — the legal requirement is "copia íntegra, clara y legible". Follows the same internal-try/catch, never-throws pattern as `whatsapp.js`'s `sendWhatsAppTemplate` (`{ ok, reason }` return, not a thrown error), so `recordLegalAcceptancesAndSendConfirmation()` can retry: up to 2 attempts with a 1.5s gap. On success, updates `legal_acceptances.confirmation_email_sent_at` on the `terms` row (never on `privacy`). A send failure after both attempts is only logged — does not block or retry beyond that, and does not affect the already-inserted `legal_acceptances` rows.
- **Not yet confirmed live**: this feature has not yet been verified end-to-end against production (real signup through `/signup` and `/checkout-premium`, checking the 2 rows + email actually land) — see Known Risks / verification checklist for this session.

## Business Categories

Known categories:

- `veterinaria`
- `vet`
- `fitness`
- `clases`
- `talleres`
- `eventos`
- `group_booking`

Preserve:

- veterinary mode for `veterinaria`/`vet`
- group controls for `group_booking`
- group-like public capacity display for `fitness`, `clases`, `talleres`, `eventos`, `group_booking`
- generic mode without pet fields or group controls

## Sensitive Files

| File | Risk |
|---|---|
| `server.js` | Core backend, booking, availability, branches, calendar, campaigns, plans |
| `orbyx-web/app/[Slug]/page.tsx` | Public booking, deposit bank details + receipt upload + pending screen |
| `orbyx-web/app/dashboard/[slug]/agenda/page.tsx` | Agenda, statuses, group/vet/manual booking, pending-deposits review modal |
| `orbyx-web/app/dashboard/[slug]/layout.tsx` | Active branch and dashboard shell |
| `orbyx-web/app/dashboard/[slug]/services/page.tsx` | Services, buffers, group settings, staff relations |
| `orbyx-web/app/dashboard/[slug]/staff/page.tsx` | Staff, staff hours, special dates |
| `orbyx-web/app/dashboard/[slug]/business/page.tsx` | Business settings, hours, booking fields |
| `orbyx-web/lib/use-theme.ts` | Dashboard theme: `clasico`, `nocturno`, `orbyx-dashboard-theme`, `data-theme` |
| `email.js` | Booking confirmation email |
| `whatsapp.js` | WhatsApp confirmation/reminder send (Twilio) |
| `orbyx-web/components/billing/AccountStatusWidget.tsx` | Account status pill/dropdown, WA notification toggles, Realtime cupo subscription, deposit toggle+bank fields |
| `orbyx-web/app/api/upload-deposit-receipt/route.ts` | Public, unauthenticated file upload to a private Storage bucket — mirrors `upload-business-logo` |

## Security Rules

- Never expose service role keys, OAuth tokens, API keys, or secrets to client code or logs.
- Validate tenant ownership before mutating branches, staff, services, appointments, customers, or pets.
- Preserve cancel token checks for public cancellation.
- Keep uploads server-side and validate file type, size, and ownership when modifying upload behavior.
- **Supabase Realtime tenant isolation**: a client-side `filter: tenant_id=eq.X` on a `postgres_changes` subscription is NOT a security boundary by itself — Realtime only respects it if the table has RLS enabled with a matching SELECT policy. Before adding a new Realtime subscription from the frontend (anon-key client) on any table, confirm RLS is enabled with a tenant-scoped policy **by querying prod directly** (`SELECT relrowsecurity FROM pg_class WHERE relname = '<table>'`), not by grepping the repo's `.sql` files — those can be (and have been, for `appointments`) incomplete relative to what's actually applied. `tenant_monthly_usage` was fixed this way in `2026-08-02-tenant-monthly-usage-rls.sql`. `appointments` (already used for Realtime in `dashboard/[slug]/layout.tsx`'s notification bell) was suspected of the same gap from a repo grep, but verified live in prod on 2026-08-02 to already have RLS enabled — false alarm, no action needed, see Known Risks.

## Important Commands

Frontend changed:

```bash
cd orbyx-web
npm run build
```

Backend changed:

```bash
npm start
```

Documentation-only changes require no build or deploy.

## Deploy

- Frontend: build, then deploy to configured frontend host, normally Vercel.
- Backend: run/start verification, then deploy or restart backend service, normally Render.
- Both changed: provide both command sets.

## Known Risks

- `server.js` is a large monolith with overlapping old/new availability helpers.
- Hardcoded backend URLs appear in frontend files.
- Branch fallback can hide missing `branch_id` bugs.
- Timezone logic mixes `America/Santiago` with fixed offsets in some places.
- Campaign/customer flows can become tenant-wide when branch-specific behavior is expected.
- Group booking capacity needs race-safe handling.
- Veterinary and group booking share the public booking path.
- `requireWriteAccess` granular per-module permission enforcement is RESOLVED (commit `dd04e05`, 2026-07-05) — do not re-open as pending.
- Any new dashboard write endpoint guarded only by `[dashboardLimiter, requireTenantAuth, requireWriteAccess]` (not via the `tenantAuthWrite`/`tenantAuthSlugWrite`/`tenantAuthParamWrite` composites) will NOT have `role`/`tenant_id`/`permissions` populated, since only the composites call `resolveTenantMembership`. Use `requireTenantWriteAccessForResource(req, res, resourceTenantId, moduleKey)` (defined next to `resolveTenantMembership`) after fetching the resource, before mutating it.
- **Terms of Service + checkbox gap — CLOSED (2026-08-16)**: `checkout-premium` now shows a mandatory, not-pre-checked `TermsAcceptanceCheckbox` (`orbyx-web/components/auth/TermsAcceptanceCheckbox.tsx`, shared with `/signup`) before the Flow card-registration redirect, linking to the new `/terminos` page (includes Anexo A/DPA) and `/privacidad`. `POST /tenants/provision` (Pro flow) and `POST /signup/claim-account` (Premium/VIP/Platinum flow) — the two points where a registration actually completes and `tenant_id`+`user_id` both exist — insert the 2 `legal_acceptances` rows (terms + privacy, with ip from `x-forwarded-for` and user-agent) and send the full contract text by email via `sendLegalAcceptanceConfirmationEmail` (`email.js`). See "Terms of Service (Legal Acceptances)" section below for full detail.
- Still PENDING before public launch, separate from the above: the `dashboard/[slug]/billing` "Suscribirme" button (plan upgrades from inside the dashboard, not new signups) still has no consent UI of its own before redirecting to Flow's card form, and `texto_autorizacion_version` is still hardcoded to `"v1"` in `POST /billing/flow/create-customer` calls. Not touched this session — only the two registration-completion points above got the checkbox. Needs a real consent UI before relying on `consentimiento` for anything legally meaningful in that specific flow.
- **`appointments` RLS — checked and cleared (2026-08-02)**: repo-grep found no matching `.sql` migration file, which raised a suspicion that RLS might be off. Camilo verified directly against prod (`SELECT relrowsecurity FROM pg_class WHERE relname = 'appointments'` → `true`) — RLS is enabled live, even though the repo has no corresponding migration file for it (applied some other way, e.g. directly via Supabase Dashboard). No action needed. **Lesson reinforced**: this repo's `.sql` files are not a reliable inventory of what's actually applied in prod — always verify live for anything security-relevant, in either direction (don't assume broken *or* assume fine, from the file list alone). See [[project_schema_drift_tenant_invitations]].
- **Deposit Required feature (added 2026-08-02) — not yet live, Camilo action items pending**: (1) run `2026-08-02-deposit-required.sql`; (2) add `POST /appointments/maintenance/release-expired-deposits` as a 4th job on cron-job.org, same cadence as the WhatsApp reminder cron — without it, expired 15-min holds never get released automatically; (3) no automated cleanup of old files in the `deposit-receipts` Storage bucket — flagged as future work; (4) rejecting a deposit sends no automated notice to the customer (no approved WhatsApp template for it) — tenant must contact them manually, also flagged as future work, not an oversight.
- **Terms of Service feature (added 2026-08-16) — pushed to main, not yet verified in prod, Render Manual Deploy still pending as of session end**: once deployed, needs a real end-to-end check: `https://www.orbyx.cl/terminos` loads and reads well at 375px, print button works; footer shows both legal links; a real signup through `/signup` (Pro) and one through `/checkout-premium` (paid) both show the submit button disabled without the checkbox; both produce their 2 `legal_acceptances` rows with `ip_address`/`user_agent` populated; the confirmation email with the full contract text actually arrives. The `legal_acceptances` table + RLS policy were created directly in Supabase by Camilo this session, with no corresponding `.sql` file added to the repo (same pattern as `appointments`' RLS, see the lesson above: don't trust the repo's `.sql` file list as a live inventory) — if the exact column set (`tenant_id`, `user_id`, `document_type`, `document_version`, `document_url`, `accepted_at`, `ip_address`, `user_agent`, `confirmation_email_sent_at`) ever needs re-deriving, check prod directly rather than assuming from this file.

