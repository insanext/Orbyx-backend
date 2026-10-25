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
- **Update 2026-10-02**: the confirmation now uses the 7-variable template `confirmacion_orbyx_final` (SID hardcoded as `WA_CONFIRMATION_CONTENT_SID` in `server.js`, no longer `TEMPLATE_CONFIRMACION_SID`): `{{6}}` professional (fallback `Equipo de <negocio>`), `{{7}}` contact = `tenants.whatsapp` → `tenants.phone` → `número de este chat`. The reminder is unchanged (4 variables, `TEMPLATE_RECORDATORIO_SID`). The variable list in the next bullet describes the older 5-variable version.
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
- **Public booking (`orbyx-web/app/[Slug]/page.tsx`)**: when `business.deposit_required` (already present in the page's business fetch via `select("*")`, no backend change needed there — see `BusinessItem` type), the form shows the bank details + a file input (JPG/PNG/PDF, 5MB max, validated client-side and server-side) right before the submit button. On submit: `POST /appointments/slot` creates the appointment (unchanged request shape — the backend decides deposit handling from `tenants.deposit_required`, not from anything the client sends) and returns `deposit_required: true`, `deposit_hold_expires_at`, `deposit_upload_token` (= the appointment's existing `cancel_token`, reused as the receipt-attach secret — same pattern as the public cancel flow, no new auth mechanism invented). The frontend then uploads the file and attaches it in two calls (see Storage below), and renders a new, separate "Pendiente de confirmación" screen (NOT the existing "Reserva confirmada" screen, which is untouched and still used for non-deposit tenants) with a 10-minute countdown (`DEPOSIT_HOLD_MINUTES = 10` in `server.js`; the page reads `deposit_hold_expires_at` from the server) that's purely informational — the real hold expiry is enforced server-side by the cron below, not the client's clock.
- **Storage (`deposit-receipts` bucket, created in the migration)**: unlike `business-logos` (public bucket, `getPublicUrl`), this bucket is **private** — a payment receipt is a financial document, more sensitive than a logo. Upload route `orbyx-web/app/api/upload-deposit-receipt/route.ts` mirrors `upload-business-logo`'s pattern exactly (formData → service role key → `storage.upload()`) but returns only the Storage `path`, never a public URL. Attaching that path to a specific appointment is done by the backend (`POST /appointments/:id/deposit-receipt`), gated by the `cancel_token`. Viewing a receipt from the dashboard uses `GET /appointments/:id/deposit-receipt-url`, which generates a 5-minute signed URL on demand (owner/admin or agenda-write role only, via `requireTenantWriteAccessForResource`). **No automatic old-receipt cleanup implemented this session** — flagged as future work.
- **Agenda review (`dashboard/[slug]/agenda/page.tsx`)**: new "Depósitos pendientes" toolbar button next to Semana/Día (visible only when `deposit_required`), with a live count badge. Realtime: subscribes to `postgres_changes` on `appointments` filtered by `tenant_id`, same channel/lifecycle shape as the account-status widget's cupo subscription, but simplified to "refetch the pending-deposits list on any event" rather than patching state from the payload — appropriate here since what's needed is an accurate count, not a single live number. Clicking the button opens a modal (no reusable modal component exists in this codebase — built by mirroring the existing inline `fixed inset-0 z-[90]` overlay markup already used 6 times elsewhere in this same file) listing one card per pending deposit: customer/service/time, a per-card countdown (one shared 1s interval, not one timer per card), receipt thumbnail (image inline, PDF as a link — both via the signed-URL endpoint, fetched lazily per card), and Confirmar/Rechazar buttons.
- **Confirm** (`POST /appointments/:id/deposit/confirm`): sets `deposit_status = "confirmed"`, then calls `sendBookingConfirmations()` — a function **extracted from the inline email+WhatsApp block that already existed in `POST /appointments/slot`**, so the deposit-approval path sends the exact same Resend email and `TEMPLATE_CONFIRMACION_SID` WhatsApp template a normal booking gets, no Twilio-side changes. Pet name/species and staff name are resolved inside `sendBookingConfirmations()` from `petId`/`staffId` (fixed 2026-09-29), so the deposit-approval email includes them too.
- **Reject** (`POST /appointments/:id/deposit/reject`): cancels immediately (no waiting for the 10-min hold), frees the slot. **No automated rejection notice to the customer** — no approved WhatsApp Content Template exists for this (creating one requires Meta/Twilio approval, out of scope) and `sendBookingEmail`'s copy is confirmation-only, doesn't fit a rejection. Tenant is expected to contact the customer directly. Flagged as future work, not silently skipped.
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

## Image Compression Pipeline (added 2026-09-06)

Every image upload to Supabase Storage goes through a server-side resize/compress step (sharp) before the buffer is uploaded, so Storage doesn't accumulate uncompressed camera-sized files.

- **Two implementations, one per repo** (can't share code across repos at build time — same reasoning as the Terms of Service content duplication above): `imageCompression.js` (root, CommonJS) for the 2 endpoints in `server.js`; `orbyx-web/lib/imageCompression.ts` for the 3 endpoints that live in Next.js API routes. Keep both in sync if a profile changes.
- **`sharp` added as an explicit dependency** in both `package.json` files (root and `orbyx-web`) — it was previously only a transitive dependency (via Next.js) in `orbyx-web`, and absent entirely from root.
- **3 profiles**, `compressImage(buffer, profileName)`:
  - `avatar` (staff photo, business logo): max width 800px, WebP quality 80. WebP chosen over JPEG specifically so business logos keep transparency (JPEG would flatten alpha to a solid background).
  - `campana` (campaign images): max width 1600px, WebP quality 83.
  - `documento` (deposit receipt, ticket attachment): max width 2200px, JPEG (broad compatibility, no transparency need), quality steps `[90, 85, 80, 75]` — re-encodes at each step until the result is ≤2MB, otherwise stops at the 75 floor rather than degrading further (prioritizes legibility of amounts/dates on receipts).
  - `.rotate()` (EXIF-aware) is applied before resize so photos taken on phones/cameras don't end up sideways; `withoutEnlargement: true` so smaller-than-target images are never upscaled.
- **Endpoints wired**: `server.js` `POST /upload/campaign-image` (`campana`) and `POST /upload/ticket-attachment` (`documento`); `orbyx-web` `app/api/upload-staff-photo`, `app/api/upload-business-logo` (both `avatar`), `app/api/upload-deposit-receipt` (`documento`).
- **PDF bypass**: `upload-deposit-receipt` also accepts `application/pdf` — those pass through uncompressed (sharp only handles raster images); only `image/jpeg`/`image/png` receipts go through the `documento` profile.
- **Existing per-endpoint input-size caps preserved, not replaced** — all 5 endpoints already validated a max upload size before this change (staff photo 2MB, business logo 5MB, campaign image 2MB via the shared `multer` instance, deposit receipt 5MB, ticket attachment 1MB), so no new pre-compression size limit was needed.
- **Output extension changes**: since `avatar`/`campana` always output WebP and `documento` always outputs JPEG regardless of the input format, the stored file's extension no longer necessarily matches what the user originally uploaded (e.g. a PNG logo is now stored as `.webp`, a PNG receipt as `.jpg`). Nothing downstream assumed a specific extension for these buckets (confirmed by reading `deposit_receipt_path`'s only extension-sensitive consumer — the dashboard's `isPdf` check in `agenda/page.tsx`, which only special-cases `.pdf` and still works). `campaign_images.mime_type`/`size_bytes` (displayed in the dashboard) now store the actual compressed values, not the original upload's.
- **`upload-staff-photo` has a one-time best-effort orphan cleanup**: since its filename is deterministic (`staff/${staffId}.${ext}`, `upsert: true`, no UUID), switching the extension to `.webp` would otherwise leave a stale `.jpg`/`.png` behind from before this change. It removes the other candidate extensions (same `["jpg","png","webp"]` list already used in `DELETE /admin/tenants/:id`'s cleanup) before uploading. `upload-business-logo` doesn't need this — its filename is already versioned with `crypto.randomUUID()`, so old logos were never cleaned up regardless of extension (pre-existing gap, unrelated to this change).
- **Filenames unchanged otherwise**: none of the `crypto.randomUUID()`-based naming or the membership/ownership validation in any of the 5 endpoints was touched — only the buffer, `contentType`, and (where the format changed) the extension.

## Billing Access, Flow Webhook and Plan Changes (audit round 3, 2026-09-30)

Report: `ORBYX_AUDIT_SESION3_DINERO_PLAN_ADMIN.md` (untracked, repo root).

- **Single source of truth for blocking**: `computeBillingAccessState` in `server.js` (used by `GET /billing/account-status`, `getPublicBookingStatus`, `deriveTenantBucket`). `orbyx-web/middleware.ts` copies the same formula by hand — keep them in sync.
  - `trialing` in Flow no longer counts as `trial_active`.
  - Trial end only blocks tenants that never paid. `tenants.is_trial === false` now means "has paid at least once": the webhook sets it on the first payment, `POST /billing/flow/subscribe` sets it on an immediate charge, and paid signups are born with it false. A tenant who paid and then cancels keeps access until `billing_cycle_end`.
  - A declined charge (`subscriptions.status='error'`) gets `PAYMENT_FAILED_GRACE_DAYS = 3` before blocking. The owner gets `sendPaymentFailedEmail` once, when the status first becomes `error`.
- **Flow webhook (`POST /billing/flow/webhook`)**: Flow's PaymentStatus has NO `customerId`/`subscriptionId` (verified in sandbox).
  - The subscription is identified from `commerceOrder` = `sus_<flow_subscription_id>_<invoice>_<date>`. Fallback: `subscription/get` → `customerId` → lookup by `flow_customer_id`.
  - A payment of a signup still in progress → 503 (retry).
  - A charge of a *different* subscription of the same customer → ignored and logged.
  - Responses: DB failure → 500. Flow status 1 (pending) → no change. Status 3/4 → `error`.
  - The cycle is only extended if `billing_cycle_end` is ≤ 7 days away (avoids a double month on retries/duplicates).
- **Plan targets**: only `starter`/`business`/`premium` (`isSellablePlanSlug`). Legacy `plan_config` rows are read-only for caps.
  - `POST /billing/flow/subscribe` computes `monto` server-side (`computePlanNetAmount`).
  - It also cancels any still-live previous Flow subscription before creating a new one.
- **Card change**: `register-card-callback` never touches an `active`/`trialing` subscription (the card lives on the Flow customer).
- **Card charges**: all `/customer/charge` calls go through `chargeFlowCustomer`, which fails unless Flow `status === 2`.
- **Cancel plan / admin pause**: `stopTenantAddonCharges` moves `automatico` add-ons to `pago_unico`.
  - Capacity add-ons expire at `last_charged_at + 30d`; message packs keep their balance with no expiry.
  - It also turns off low-balance recharge.
  - `chargeRecurringAddons` additionally skips canceled, paused or inactive tenants.
- **Admin delete tenant**: `cancelTenantFlowBilling` runs first (cancels live Flow subs, unregisters cards). On Flow failure nothing is deleted unless `force_without_flow_cancel: true`.
  - Migration `2026-09-30-tenant-deletion-keep-legal-records.sql` keeps `legal_acceptances`/`addon_auto_charge_consents` and adds the review tables to `delete_tenant_cascade`.
  - **Before running it**, compare with the live `pg_get_functiondef('delete_tenant_cascade'::regproc)`.
- **Plan changes**:
  - Choosing the current plan while a downgrade is scheduled cancels it (`change_type: "cancel_scheduled"`).
  - An upgrade during a never-paid trial is free until trial end; a `trialing` Flow sub is replaced by one on the new plan with the remaining trial days.
- **Limits (I11)**: reactivating staff is checked against the active limit. Editing a group service keeps an over-limit capacity but can't raise it.
- **Other**:
  - Terms of Service are now v1.1 (`LEGAL_TERMS_VERSION`, `app/terminos`, `email.js`): net prices + IVA, 3 current plans, accumulating packs / one-time payment.
  - Trial reminder emails stop 14 days after expiry.
  - `/admin/planes` warns that plan price edits don't affect charges.

## Middleware (orbyx-web, 2026-10-02)

Motivo: el 2026-10-02 `/login` cayó con 504 `MIDDLEWARE_INVOCATION_TIMEOUT` porque el middleware esperaba a Supabase sin timeout. El inicio de sesión no puede depender de que Supabase responda rápido.

- `orbyx-web/middleware.ts` **no hace queries a tablas**. Solo `auth.getClaims()` (verifica la firma del JWT localmente con JWKS cacheado, sin red salvo refresh/primera descarga de JWKS) + timeout de 3s en todo fetch (`AbortSignal.timeout`) y un `Promise.race` de respaldo. Responde únicamente "¿hay sesión válida?".
- Matcher: solo `/dashboard/:path*` y `/admin/:path*`. `/login` quedó **fuera** (el form ya resuelve la sesión activa en `resolveTenantDestination`).
- Sin sesión → `/login?redirectTo=...` (o `/admin/login`). Si falló por timeout/red → además `reason=timeout` (el login muestra aviso).
- El middleware inyecta el header interno `x-orbyx-pathname` para que el template sepa la ruta.
- **La lógica de tenant/billing vive en `app/dashboard/[slug]/template.tsx`** (server component) + `lib/dashboard-access.ts`: tenant por slug, pertenencia en `tenant_users`, bloqueo trial/pago/pausa (redirige a `/billing`, que está exento). Mismos redirects que antes (`/login?error=no_access`, `/dashboard/{slug}/billing`). Es `template` y no `layout` porque se re-ejecuta en cada navegación (el layout es client component de 2600 líneas y no re-chequea). Si las queries fallan o tardan >5s → `components/AccessCheckError.tsx` (pantalla con "Reintentar" = `router.refresh()`), nunca 500 ni loop de redirects.
- La fórmula de bloqueo existe en `computeBillingAccessState` (server.js) y en `lib/dashboard-access.ts` — mantener iguales.
- `/admin`: el middleware solo chequeaba sesión (la autorización admin/MFA la hace el backend desde `app/admin/layout.tsx`), no había queries que mover.
- Requisito de Supabase: getClaims verifica localmente solo con JWT Signing Keys asimétricas; con secret HS256 legacy cae a `getUser()` (red).

## Customer Categories (2026-10-12)

One model, one function, used by the customer list/profile, Campaigns and Indicadores. Never re-implement it in an endpoint or in the frontend.

- **Source of truth**: `getCustomerCategoryMap({ tenantId, customerIds, branchId, now, tenant })` in `server.js` (next to `recalculateCustomerStats`), built on the pure `classifyCustomerFromAppointments`. Thresholds live only in `CUSTOMER_CATEGORY_DEFAULT_THRESHOLDS` (`recent_days: 60`, `at_risk_days: 120`) behind `getCustomerCategoryThresholds(tenant)` — the future per-tenant config goes there, nothing else changes.
- **Attended visit** = `completed`, or `booked` whose `start_at` already passed (not marked canceled/no_show) and without a pending deposit. `canceled`, `no_show`, `rescheduled` and future appointments never count. Computed from `appointments`, **not** from the cached `customers.total_visits`/`last_visit_at` (those count any non-canceled appointment and are no longer read for categorization; `recalculateCustomerStats` still writes them).
- **Categories** (exclusive, in order): `prospect` (0 attended visits) → `new` (1 visit, last <= 60d) → `active` (2+ visits, last <= 60d) → `at_risk` (last 61–120d) → `inactive` (last > 120d). Days are Santiago calendar days. No-shows are a separate field (`no_show_count`), not a category.
- **Per-customer fields** returned by `GET /customers/:slug`: `category`, `category_label`, `category_reason` (plain-Spanish "motivo"), `attended_visits`, `last_visit_at` (last *attended*), `days_since_last_visit`, `no_show_count`, `next_appointment_at`, `completed_count` is internal (drives `has_completed_visit`). Legacy keys `segment`, `total_visits`, `last_visit_at`, `is_inactive` are kept with the new values. Response also has `thresholds`, `summary` (`prospectos/nuevos/activos/en_riesgo/inactivos`), `total` (real filtered count) and `truncated` (rows capped by `limit`, default 300, max 2000).
- **Filters** (same helper `matchesCustomerAudienceFilter` everywhere): `segment` = category, `days_without_visit` = at least N days since last attended visit (prospects never match). They combine. The old `inactive_days` param is ignored by `/customers/:slug`; `/stats/:slug` keeps `inactive_days` as the "days without visiting" cut-off for its list. Optional `sort` (`oldest|recent|most_visits|least_visits`) — before this, Campaigns' "Prioridad de envío" had no effect on the curated audience.
- **Campaigns**: `POST /campaigns/send-email` and `/send-whatsapp` accept the 5 category keys (`recurrent`/`frequent` are mapped to `active` for stale clients); new optional body field `days_without_visit`. `campaign_history.segment` now stores the new keys (old rows keep `recurrent`/`frequent`; the UI labels both). The wizard shows "Con este filtro calzan N clientes" before sending.
- **Indicadores**: `GET /stats/:slug` adds `basic.customer_categories` (counts) and `basic.customer_category_thresholds`; the ranking lists use the same map (and are branch-aware when `branch_id` is sent: only customers with appointments in that branch).
- **Frontend**: `orbyx-web/lib/customer-categories.ts` holds presentation only (labels, descriptions, days options). It does not classify anything.
- **Category filter buttons + tooltips**: Clientes and Campañas use the same `components/customers/CategoryFilterButtons.tsx` (hover/focus/active styles; colors come from each page's CSS vars) built on the reusable `components/ui/InfoTooltip.tsx` (portal, fixed position, clamped to the viewport; hover/keyboard focus on desktop, a small "i" button on touch screens via `@media (hover: none)`). Descriptions come from `describeCustomerCategory(category, thresholds)`: the 60/120 are the `thresholds` already returned by `GET /customers/:slug` — never hardcode them in the UI. Same tooltip on the "Días sin venir" selects (`DAYS_WITHOUT_VISIT_HELP`).
- **Known caveat**: `campaign_history.segment` was never constrained in any repo migration, but the original table DDL isn't in the repo — if prod has a CHECK on it, new keys would fail the history insert (see the report for the verification query).

## Customer Import (Excel / CSV) — 2026-10-12

Lets an owner/admin move their customer base from another booking system. Button "Importar clientes" in the Clientes page (`orbyx-web/components/customers/ImportCustomersModal.tsx`).

- **Backend**: pure parsing/validation/plan in root `customerImport.js` (precedent: `imageCompression.js`); auth + execution in `server.js` ("Importador de clientes" block before `PATCH /customers/:id`). Endpoints (slug in the URL so auth runs before multer parses the body): `POST /customers/import/:slug/preview`, `POST /customers/import/:slug/commit`, `GET /customers/import/:slug/history`, `POST /customers/import/:slug/:importId/undo`. Owner/admin only (`requireOwnerOrAdminRole`), `tenant_id` always from the slug/membership, never from the file.
- **Stateless**: the frontend sends the same file to `preview` and `commit`; `commit` re-reads and re-validates everything. Nothing is stored between steps.
- **Libraries**: `read-excel-file` (xlsx, first sheet, values only) + `csv-parse`. Do NOT use npm `xlsx` (known vulns) or `exceljs` (advisory via `uuid`). Before parsing, `assertSafeXlsx` validates the zip (central directory, entry count/size caps, per-entry `inflateRawSync` with `maxOutputLength` = declared size → zip bombs, rejects `vbaProject.bin`/macrosheets, needs `[Content_Types].xml` + `xl/workbook.xml`). CSV: UTF-8/UTF-16/Windows-1252, delimiter `, ; \t |` auto-detected, binary content rejected. Limits: 5 MB, 5.000 rows, 60 columns. Only `.xlsx`/`.csv` (extension AND content).
- **Rules**: required = name (or name+last name) + (phone or email). Phones normalized with `normalizeChileanPhone` (`+569XXXXXXXX`; landlines are an error), emails lowercased. Duplicate = same normalized phone or same email, inside the file (first wins) or against existing customers (`skip` default | `fill_empty`: only fills EMPTY fields, never overwrites; phone+email matching two different customers → always skipped). Text starting with `= + - @` gets a leading `'` (name, notes, RUT; not phone/email).
- **Atomic**: `import_customers_batch` (SQL, migration `2026-10-12-customer-import.sql`) creates customers + fills + the `customer_imports` log row in ONE transaction. `undo_customer_import` deletes the customers of that `import_id` that have no appointments (and no FK-blocking records); customers only "filled" are not reverted. Both functions are `service_role`-only (they take `p_tenant_id` as a parameter).
- **Imported history & categories**: `customers.imported_last_visit_at` / `imported_visit_count` are read inside `getCustomerCategoryMap` / `classifyCustomerFromAppointments` (`options.imported`): last visit = most recent of imported and real attended visits; visits are summed. A last-visit date without a count counts as 1. A count without a date can't be aged → stays Prospecto ("Importado con N visitas, sin fecha de la última"). No history → Prospecto "Importado sin historial de visitas". Imported customers stay visible in branch-filtered views (`is_imported`), since their history is business-wide. Campaigns/Indicadores need no changes: they already use that function.
- **Plan limit**: no plan defines a customer cap today (`plan_config` has no `max_customers`); `prepareCustomerImport` reads `caps.max_customers` if it ever exists.
- **Tests**: `node scripts/test-customer-import.js` (parser, mapping, plan, malicious files). Fixtures: `samples/importar-clientes-prueba.xlsx|.csv` (valid, errors, duplicates; rows 16/17 expect existing customers with phone `987650001` / email `elena.existente@correo.cl`) and the public template `orbyx-web/public/plantillas/importar-clientes-plantilla.xlsx`.
- **Not done / future**: no retention cleanup of `customer_imports`; "Deshacer" doesn't revert `fill_empty` updates; `delete_tenant_cascade` was not modified (relies on `customer_imports.tenant_id ... on delete cascade`).

## Dependency Security (2026-10-12)

- **Backend**: `npm audit` = 0 vulnerabilities. multer 2.4.0, sharp 0.35.5, and (lockfile-only, transitive) axios 1.20.0 via twilio, proxy-addr 2.0.8 via express, ip-address 10.7.4 via express-rate-limit, brace-expansion 2.1.7 via googleapis. One commit per library. No `package.json` range is pinned for the transitive ones: if the lockfile is ever regenerated, re-check `npm audit`.
- **orbyx-web**: next 16.3.8 (minimum fix inside 16.3.x — `npm audit fix` wanted 16.4.0, a minor jump, deliberately avoided), sharp 0.35.5, plus dev/build-only source-map-js, brace-expansion, @humanfs/*.
- **Still open (frontend, dev-only, no fix exists)**: `braces` ≤3.0.3 (GHSA-vfj7-8cjw-p6xm) via `eslint-config-next > @next/eslint-plugin-next > fast-glob > micromatch`. No patched `braces` release exists (3.0.3 is the latest) and the only "fix" npm offers is downgrading `eslint-config-next` to 14.x, which breaks the lint setup for Next 16. It only runs when linting, never in production. Re-check when `eslint-config-next`/`fast-glob` publish a release.
- **Never** run `npm audit fix --force`. Use `npm update <pkg>` (or `npm install pkg@x.y.z`) one library at a time and re-run the smoke tests below.
- **Smoke tests for dependency bumps** (take a `baseline` snapshot BEFORE updating, then compare): `node scripts/smoke-dependencies.js baseline` / `after-<lib>` boots the real `server.js` with a fake Supabase from an empty cwd and fake credentials (nothing touches prod) and checks multer uploads and limits, sharp profiles, outgoing Twilio calls (axios) against a local mock, `trust proxy`/`req.ip` and rate limiting (IPv4 and IPv6 /56). Frontend: build with dummy `NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_ANON_KEY`, then `node orbyx-web/scripts/smoke-web.js baseline-web` / `after-<lib>` (next start + routes + middleware redirects + sharp). Compare `npm run lint` counts too (434 existing problems).
- Render has no `engines` in `package.json` (sharp 0.35.x needs Node >= 20.9); the Node version comes from Render's own config. Do not add `engines` without checking what version Render would then pick.

## Select component and color-scheme (2026-10-13)

- **Never use a native `<select>` again.** Use `orbyx-web/components/ui/Select.tsx` (`import Select from "@/components/ui/Select"`): same API (`value`, `onChange(e)` with `e.target.value`, `disabled`, `className`, `style`, `<option>`/`<optgroup>` children, `required`/`name`). All 70 former `<select>` in the app were replaced 1:1.
- It renders a `button.orbyx-select-trigger` (receives the same `className`/`style` as the old select) and a portal'd `listbox` (`position: fixed`, so panels/modals with `overflow` never clip it; bottom sheet under 640px). Keyboard: arrows, Home/End, Enter/Space, Escape, Tab, type-ahead. `required`/`name` keep working through a hidden native `<select>`. The arrow is hidden automatically with `appearance-none`, or with `hideChevron` when the container draws its own.
- **Colors**: the trigger is added to the same `select` rules in `globals.css` (and the agenda's scoped rules), so it looks exactly like the old select in both themes. The menu uses `--bg-card/--border-color/--text-main/--bg-soft/--accent-solid` of `<html data-theme>`; if the control sits on a background of the other tone (e.g. admin is always dark) it is forced to a fixed dark/light palette (`data-force`). Tone is read from the trigger's real background with transitions disabled (the global `* { transition }` made computed colors lag).
- **Click-outside handlers**: the menu lives under `<body>`, so a `document` mousedown handler that does `ref.contains(target)` will treat an option click as "outside". Ignore targets inside `[data-orbyx-select-menu]` (done in the agenda filters panel).
- **`color-scheme`** is set per theme in `globals.css`: `:root` light, `:root[data-theme="nocturno"]` dark, `.orbyx-public[data-public-theme]`, and the admin layout root is `dark`. Native date pickers/scrollbars/checkboxes follow it.
- Agenda "Filtros" button next to "Calendario semanal": icon + "Filtros (N)", `orbyx-header-btn orbyx-filter-btn`, same count as the mobile button (`mobileActiveFilterCount`: search + professional + service + status != "active").

## Public Booking Abuse Protection + Email Reminder (2026-10-18)

Applies only to public bookings (`POST /appointments/slot` without `booking_origin: dashboard`). Bookings made from the Agenda skip every item below.

- **Real client IP**: Next `/api/*` routes (Vercel) forward the visitor IP in `x-orbyx-client-ip` plus `x-orbyx-proxy-secret` (helper `orbyx-web/lib/backend-proxy-headers.ts`, IP from Vercel's `x-real-ip`/`x-forwarded-for`). Backend `getClientIp(req)` (`server.js`, next to `publicLimiter`) trusts that header only if the secret equals `ORBYX_PROXY_SECRET` (constant-time compare); otherwise `req.ip`. Env var `ORBYX_PROXY_SECRET` must be set to the SAME value in Vercel and Render; if missing everything works as before (one warning in logs). `publicLimiter` is keyed by `ipKeyGenerator(getClientIp(req))` (150/min). (The temporary `[IP-DEBUG]` logging was removed 2026-10-23.)
- **Booking limiters** (constants `PUBLIC_BOOKING_*` at the top of that block): 5 per 10 min and 20 per day per IP (`skipFailedRequests`, so only created bookings count); 5 public bookings per 24 h per phone or email across ALL tenants and 30 per tenant per hour (`checkPublicBookingAbuse`, counts `appointments` with `source = 'public_page'`).
- **Turnstile on the final booking step**: widget in `app/[slug]/page.tsx`, token sent as `captcha_token` through `/api/appointments/slot`, verified by `verifyTurnstileToken` with the real IP as `remoteip`. `verifyTurnstileToken` now FAILS CLOSED in production (`RENDER` or `NODE_ENV=production`) when `TURNSTILE_SECRET_KEY` is missing (also affects `/auth/password-reset`).
- **"Max 2 future bookings per email/phone per tenant"** check now uses two filtered queries (by email, by phone) instead of loading every future appointment of the tenant (it silently broke past 1000 rows).
- **Blocked contacts**: table `blocked_contacts` (migration `2026-10-18-booking-abuse-protection.sql`, RLS closed, service role only). Endpoints `GET/POST /blocked-contacts/:slug`, `DELETE /blocked-contacts/:slug/:id` (owner/admin only; POST takes `customer_id`, `appointment_id` or raw `phone`/`email`). A blocked contact trying to book publicly gets a generic 403 ("No es posible completar la reserva. Contacta directamente al negocio."). UI: "Bloquear" in Clientes (list) and the Agenda appointment detail, plus "Contactos bloqueados" modal in Clientes to unblock.
- **Email reminder ~24 h before**: `sendEmailReminders()` (`server.js`, next to the WhatsApp reminder), internal cron every 15 min (`scheduleInternalCron`, respects `DISABLE_INTERNAL_CRONS`); `GET /jobs/send-reminders` (maintenance secret) triggers the same function. Column `appointments.email_recordatorio_enviado` is claimed with a conditional update BEFORE sending and released if the send fails. Skips: not `booked`, no email, `deposit_status = 'pending'`, booked with less than ~23 h notice, paused/inactive tenant. There is NO per-tenant toggle: it is on for every tenant. Independent from the WhatsApp reminder. `sendBookingEmail({ reminder: true })` changes subject/title; it now returns `{ ok }`.

## Pre-launch Round 3 (2026-10-23)

- **DB backup**: `.github/workflows/db-backup.yml` (daily 07:30 UTC + manual). `pg_dump` 17 via the Supabase Session pooler: `public` (schema+data) and `auth` (data only, no sessions/tokens), tar.gz + gpg AES256, artifact kept 30 days. Secrets: `SUPABASE_DB_URL`, `BACKUP_PASSPHRASE`. Restore steps: `docs/RESTORE.md`. Storage buckets (`business-logos`, `staff-photos`, `campaign-images`, `ticket-attachments`, `deposit-receipts`) are NOT backed up yet.
- **Public page "modo caído"**: `orbyx-web/app/[slug]/page.tsx` shows a friendly notice when `/api/public-services/:slug` fails (network or 5xx). Contact data (name/phone/WhatsApp) comes from `app/api/public-business-fallback/[slug]/route.ts`, which reads Supabase directly (service role) and does not depend on the Render backend.
- **Security headers** (`orbyx-web/next.config.ts`): CSP is **Report-Only**. `/{slug}` booking pages are embeddable; everything else gets `X-Frame-Options: DENY` + `frame-ancestors 'none'`. Fixed top-level routes are read from `app/` folders at build time so new pages are protected by default.
- CORS no longer accepts arbitrary `orbyx*.vercel.app`: only `ALLOWED_ORIGINS` in `server.js`. `keep-alive.yml` removed (Render is on a paid plan).
- `app/not-found.tsx`, `app/robots.ts`, `app/sitemap.ts` added. Deposit-pending appointments have their own amber status color (`deposit_pending` in `lib/appointment-status-colors.ts`).

## Demo Tenants (2026-10-24)

4 tenants with fictitious data for videos and in-person demos, created by `scripts/seed-demo.js` (`npm run seed:demo`, `npm run seed:demo:reset`). Inserts directly into Supabase with the service role key from `.env` (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DEMO_PASSWORD`).

- **Flag**: `tenants.is_demo` (migration `2026-10-24-demo-tenants.sql`). Slugs `demo-*`, logins `demo-<rubro>@demo.orbyx.cl`, all customer emails `@demo.orbyx.cl`, all phones `+56900000xxx`.
- **Reset** deletes only tenants with `is_demo = true` AND slug `demo-*` (plus everything under them, same table order as `delete_tenant_cascade`) and regenerates them; auth users are kept and get `DEMO_PASSWORD` again. Without `--reset` an existing demo tenant is left as is; a non-demo tenant with the same slug aborts the run.
- **Never sends anything**: `email.js` wraps `resend.emails.send` and drops `@demo.orbyx.cl` recipients; `whatsapp.js` skips `+56900000…`; `server.js` `isDemoTenant()` (60 s cached list, tolerates the column not existing yet) skips `sendBookingConfirmations`, reminders (email and WA), campaign email/WA sends, deposit/add-on/payment-failed notices.
- **No usage counters / billing**: `incrementMonthlyUsage`, `consumeResourceUsage`, `trackWhatsAppMessage` no-op for demo tenants; `app.use("/billing")` returns 403 on POST/PATCH/PUT for a demo `tenant_id`; `GET /billing/account-status` reports them as `active`. Data side: `plan_slug = premium`, `is_trial = false`, `trial_ends_at = null`, `billing_cycle_end = 2099-12-31` (never blocked by `computeBillingAccessState` / `lib/dashboard-access.ts`).
- **Data shape**: dates relative to today (Santiago): 3 weeks of history (completed / canceled / no_show) and 3 weeks of future agenda (~75-85% occupancy Mon-Fri) inside each staff member's `staff_hours`, no overlaps. Vet: pets + `clinical_notes` (pet_id). Clinic (`clinica` / `salud_general`): patients are `customers` (pet_id null) with RUT/previsión and `clinical_notes` with `extra_fields` peso/talla/IMC. ~15% of customers carry `imported_last_visit_at` so the En riesgo / Inactivo categories show up.
- Known: admin stats/directory still list demo tenants (not filtered by `is_demo`).
- **From the phone**: GitHub Actions workflow `.github/workflows/seed-demo.yml` (manual only, input `modo`: `crear` | `resetear`) runs the same script with repo secrets `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DEMO_PASSWORD`.

## Service Extras (2026-10-25, round 1 of 3)

Optional add-ons a customer adds to a service when booking (e.g. "Lavado +$2.000 +15 min"). Migration `2026-10-25-service-extras.sql`.

- **Model**: `service_extras` = catalog **per branch** (name, price, `duration_minutes` 0-240, `active`, soft delete `deleted_at`). `service_extra_links` (PK `service_id, extra_id`) = which extras each service offers; one extra can be in many services. Both tables are service-role only (RLS on, no grants). Group services never have extras.
- **Snapshot on the appointment**: `appointments.extras` (jsonb `[{id,name,price,duration_minutes}]`), `extras_minutes`, `extras_price`, `price_snapshot` (service price + extras). `duration_minutes_snapshot` stays the service's own duration. Written only when `hasAppointmentExtrasColumns()` (cached probe) is true, so the insert is unchanged before the migration.
- **Single source of truth**: `resolveBookingExtras()` (server.js, "Extras de servicios" block): validates ids (active, same tenant+branch, linked to that service, max 10) and returns minutes/price from the catalog. Never trust client prices/minutes.
- **Availability**: extras minutes are added to the service total in exactly 2 places that must stay in sync: `GET /public/slots/:slug/:service_id` (`?extra_ids=a,b`) and `POST /appointments/slot` (`extra_ids` in body; also extends `end_at`, overlap checks and the booking guard). The legacy `GET /slots` is unused by the frontend and does not know extras.
- **Endpoints** (`/service` write rule → module `servicios`): `GET /service-extras?tenant_id&branch_id` → `{ available, extras, links }` (`available:false` if the migration is missing), `POST /service-extras`, `PATCH /service-extras/:id`, `DELETE /service-extras/:id` (soft, removes links), `PUT /service-extras/links` `{ service_id, extra_ids }` (replaces the extras of one service), `PUT /service-extras/:id/services` `{ service_ids }` (replaces the services of one extra; used by the extra's own form). `GET /public/services/:slug` adds `services[].extras` (active, linked).
- **Panel Servicios** (`orbyx-web`): form "Crear servicio" now opens with a button (closed by default, closes after saving / on branch change). Catalog card `components/services/ServiceExtrasManager.tsx`; checkboxes `ServiceExtrasPicker` in create/edit forms; row badge "N extras". Everything hides when `available` is false.
- **Public booking (round 2, done 2026-10-25)**: `app/[Slug]/page.tsx` shows `ServiceExtrasChooser` under the selected service in the catalog (chips + total); `selectedExtraIds` resets on service/branch change; slots are requested with `extra_ids` (`extraIdsKey` is in the slots effect deps) and the booking body sends `extra_ids`; summary, side panel and success screen show "service + extras" and the total. Both Next proxies forward `extra_ids`.
- **Pending**: Agenda manual booking (`agenda/page.tsx`) does not send `extra_ids` yet; (3) show extras in appointment detail, confirmation email, and use `price_snapshot` in Indicadores. WhatsApp template can't show extras without a new Meta-approved template.

## Public Booking UI: staff carousel (2026-10-25)

`orbyx-web/app/[Slug]/page.tsx`, UI only except one additive backend field.

- **Description**: `BusinessDescription` = `text-sm md:text-base`, compact leading, `text-slate-500`, `line-clamp-3`; "Ver más/Ver menos" only when the paragraph is really truncated (scrollHeight vs clientHeight + ResizeObserver).
- **Staff picker**: `StaffCarousel` (stories style: round avatar/photo or initial, name + role, first item "Cualquiera" selected by default, `ring-indigo-600` when selected; `role="radiogroup"`), rendered right above the days row (below week selector + service chip). The old vertical list in the side column and every "Especialista en …" text were removed. The public page has no per-tenant color: indigo is the brand color everywhere.
- **Staff by service**: `GET /public/services/:slug` now also returns `staff` (active staff of the branch: id, name, role, color, photo_url) and `services[].staff_ids` (active staff linked via `staff_services`). Without a service the catalog panel shows all staff ("Nuestro equipo"); with a service, `staffOptions` (from `/public/staff/:slug/:service_id`). `selectCatalogService` keeps the chosen professional only if `service.staff_ids` includes it, otherwise back to "Cualquiera" (old backends without `staff_ids` → always "Cualquiera").
- Slots were already filtered by professional (`staff_id` → `/public/slots`), unchanged.
- Staff photos on the public page are square with `rounded-lg` corners (carousel, catalog team strip, side panel) — not circles.
- Catalog on mobile: compact category tabs (`text-xs`, `py-1.5`) and a horizontal "Nuestro equipo" strip inside `CatalogSidebar` (`lg:hidden`); the side `ProfessionalsPanel` is desktop-only (`hidden lg:block`). `CatalogSidebar` root needs `min-w-0` (grid item) or the strip widens the page.
- Verified headless at 380px (Chromium from npm `@sparticuz/chromium` + `puppeteer-core`, mock backend): no page horizontal scroll, carousel scrolls inside.

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
- **Image Compression Pipeline (added 2026-09-06) — pushed to both repos (`Orbyx-backend` `main` @ `7f04c55`, `orbyx-web` `main` @ `0ab1080`), Render/Vercel deploy not yet confirmed live as of session end.** No Render deploy hook or API token is available in this environment to check deploy status directly, and `server.js` has no version/health endpoint exposed over HTTP — only confirmed the Render service responds at all (404 on `/`, expected, no root route). Needs a real check: re-upload a staff photo/logo/campaign image/deposit receipt/ticket attachment and confirm the stored file is actually resized+compressed (not just that the old code still works). See "Image Compression Pipeline" section above for what changed.
- Any new dashboard write endpoint guarded only by `[dashboardLimiter, requireTenantAuth, requireWriteAccess]` (not via the `tenantAuthWrite`/`tenantAuthSlugWrite`/`tenantAuthParamWrite` composites) will NOT have `role`/`tenant_id`/`permissions` populated, since only the composites call `resolveTenantMembership`. Use `requireTenantWriteAccessForResource(req, res, resourceTenantId, moduleKey)` (defined next to `resolveTenantMembership`) after fetching the resource, before mutating it.
- **Terms of Service + checkbox gap — CLOSED (2026-08-16)**: `checkout-premium` now shows a mandatory, not-pre-checked `TermsAcceptanceCheckbox` (`orbyx-web/components/auth/TermsAcceptanceCheckbox.tsx`, shared with `/signup`) before the Flow card-registration redirect, linking to the new `/terminos` page (includes Anexo A/DPA) and `/privacidad`. `POST /tenants/provision` (Pro flow) and `POST /signup/claim-account` (Premium/VIP/Platinum flow) — the two points where a registration actually completes and `tenant_id`+`user_id` both exist — insert the 2 `legal_acceptances` rows (terms + privacy, with ip from `x-forwarded-for` and user-agent) and send the full contract text by email via `sendLegalAcceptanceConfirmationEmail` (`email.js`). See "Terms of Service (Legal Acceptances)" section below for full detail.
- Still PENDING before public launch, separate from the above: the `dashboard/[slug]/billing` "Suscribirme" button (plan upgrades from inside the dashboard, not new signups) still has no consent UI of its own before redirecting to Flow's card form, and `texto_autorizacion_version` is still hardcoded to `"v1"` in `POST /billing/flow/create-customer` calls. Not touched this session — only the two registration-completion points above got the checkbox. Needs a real consent UI before relying on `consentimiento` for anything legally meaningful in that specific flow.
- **`appointments` RLS — checked and cleared (2026-08-02)**: repo-grep found no matching `.sql` migration file, which raised a suspicion that RLS might be off. Camilo verified directly against prod (`SELECT relrowsecurity FROM pg_class WHERE relname = 'appointments'` → `true`) — RLS is enabled live, even though the repo has no corresponding migration file for it (applied some other way, e.g. directly via Supabase Dashboard). No action needed. **Lesson reinforced**: this repo's `.sql` files are not a reliable inventory of what's actually applied in prod — always verify live for anything security-relevant, in either direction (don't assume broken *or* assume fine, from the file list alone). See [[project_schema_drift_tenant_invitations]].
- **Deposit Required feature (added 2026-08-02) — not yet live, Camilo action items pending**: (1) run `2026-08-02-deposit-required.sql`; (2) add `POST /appointments/maintenance/release-expired-deposits` as a 4th job on cron-job.org, same cadence as the WhatsApp reminder cron — without it, expired 10-min holds never get released automatically (since 2026-10 the internal node-cron job `release-expired-deposits` runs every 5 min, so a hold is released between 10 and ~15 min after booking and the external job is no longer needed); (3) no automated cleanup of old files in the `deposit-receipts` Storage bucket — flagged as future work; (4) rejecting a deposit sends no automated notice to the customer (no approved WhatsApp template for it) — tenant must contact them manually, also flagged as future work, not an oversight.
- **Terms of Service feature (added 2026-08-16) — pushed to main, not yet verified in prod, Render Manual Deploy still pending as of session end**: once deployed, needs a real end-to-end check: `https://www.orbyx.cl/terminos` loads and reads well at 375px, print button works; footer shows both legal links; a real signup through `/signup` (Pro) and one through `/checkout-premium` (paid) both show the submit button disabled without the checkbox; both produce their 2 `legal_acceptances` rows with `ip_address`/`user_agent` populated; the confirmation email with the full contract text actually arrives. The `legal_acceptances` table + RLS policy were created directly in Supabase by Camilo this session, with no corresponding `.sql` file added to the repo (same pattern as `appointments`' RLS, see the lesson above: don't trust the repo's `.sql` file list as a live inventory) — if the exact column set (`tenant_id`, `user_id`, `document_type`, `document_version`, `document_url`, `accepted_at`, `ip_address`, `user_agent`, `confirmation_email_sent_at`) ever needs re-deriving, check prod directly rather than assuming from this file.

