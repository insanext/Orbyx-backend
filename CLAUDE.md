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
| `orbyx-web/app/[slug]/page.tsx` | Public booking |
| `orbyx-web/app/dashboard/[slug]/agenda/page.tsx` | Agenda, statuses, group/vet/manual booking |
| `orbyx-web/app/dashboard/[slug]/layout.tsx` | Active branch and dashboard shell |
| `orbyx-web/app/dashboard/[slug]/services/page.tsx` | Services, buffers, group settings, staff relations |
| `orbyx-web/app/dashboard/[slug]/staff/page.tsx` | Staff, staff hours, special dates |
| `orbyx-web/app/dashboard/[slug]/business/page.tsx` | Business settings, hours, booking fields |
| `orbyx-web/lib/use-theme.ts` | Dashboard theme: `clasico`, `nocturno`, `orbyx-dashboard-theme`, `data-theme` |
| `email.js` | Booking confirmation email |
| `whatsapp.js` | WhatsApp confirmation/reminder send (Twilio) |

## Security Rules

- Never expose service role keys, OAuth tokens, API keys, or secrets to client code or logs.
- Validate tenant ownership before mutating branches, staff, services, appointments, customers, or pets.
- Preserve cancel token checks for public cancellation.
- Keep uploads server-side and validate file type, size, and ownership when modifying upload behavior.

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
- PENDING before public launch: no screen in the product (checkout-premium, or the "Suscribirme" button in `dashboard/[slug]/billing`) shows a real recurring-charge consent checkbox/legal text before redirecting to Flow's card form. `texto_autorizacion_version` is hardcoded to `"v1"` in `POST /billing/flow/create-customer` calls — pre-existing gap, not introduced by the Suscribirme button, just not made worse by it. Needs a real consent UI before relying on `consentimiento` for anything legally meaningful.

