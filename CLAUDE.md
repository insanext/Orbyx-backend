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
- Twilio client uses API Key auth (`twilio(TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, { accountSid: TWILIO_ACCOUNT_SID })`), not the classic auth token. Sends directly from `TWILIO_WHATSAPP_NUMBER` (assumed to already include `+`) — no Messaging Service SID is used or required.
- Env vars (already set in Render, redeployed 2026-08-01): `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, `TWILIO_WHATSAPP_NUMBER`, `TEMPLATE_CONFIRMACION_SID`, `TEMPLATE_RECORDATORIO_SID`.
- Two independent per-tenant toggles, plain columns on `tenants` (no JSON settings bag — matches the table's existing convention): `wa_confirmation_enabled` (bool, default false), `wa_reminder_enabled` (bool, default false), `wa_reminder_hours_before` (smallint, 1 or 2, default 1). All default OFF for every tenant — nothing sends until explicitly enabled. Exposed through `PATCH /tenants/:id` (same conditional-spread pattern as `business_category`/`business_subcategory`) but **there is no dashboard UI yet** to flip them — activate per tenant via direct SQL until a settings screen is built.
- Confirmation (event-driven): hooked into `POST /appointments/slot` right after the existing Resend email call. Checks `tenants.wa_confirmation_enabled`, then `checkMonthlyUsage(tenant_id, "wa_confirmacion")` before sending; increments via `incrementMonthlyUsage` only on a successful send. Template vars in order: `{{1}}` customer name, `{{2}}` business name, `{{3}}` date (`formatDateCL`), `{{4}}` time (`formatTimeCL`), `{{5}}` address or service name as fallback.
- Reminder (time-driven cron): `POST /whatsapp/maintenance/send-reminders`, guarded by the existing `requireSignupMaintenanceSecret` + `publicLimiter` (same pattern/secret as `/signup/maintenance/sweep` and `/billing/addons/maintenance/charge-recurring` — header `x-maintenance-secret`, env var `SIGNUP_MAINTENANCE_SECRET`). Meant to be hit by an external cron (cron-job.org) every 15-30 min. Pulls `booked` appointments with `wa_recordatorio_enviado = false` inside a wide window (`now+1h` to `now+2h+30min`), then per-row resolves the tenant's actual `wa_reminder_hours_before` and only sends if `now` falls inside that specific target-time ± 30min margin. Sets `appointments.wa_recordatorio_enviado = true` right after a successful send to prevent duplicate sends across cron runs. Template vars in order: `{{1}}` customer name, `{{2}}` business name, `{{3}}` time, `{{4}}` address.
- **Confirmation and reminder share one monthly counter**: both call `checkMonthlyUsage`/`incrementMonthlyUsage` with resource `"wa_confirmacion"` — this matches the existing `addon_config` addon definition (`"WA confirmación+recordatorio"`, `grants: { wa_confirmacion: 50 }`) which was already designed for a shared pool, not two separate counters. `plan_config.max_wa_confirmacion` is the per-plan base cap; `GET /billing/account-status` and `GET /billing/addons` already read/display this counter and needed no changes.
- Both send paths are best-effort and never block/break their caller: a missing toggle, an exhausted cupo, or a Twilio failure all just `console.warn` and continue — appointment creation and the reminder loop are unaffected.
- Migration: `2026-08-01-whatsapp-twilio-toggles.sql` (repo root) — adds the 3 `tenants` columns, `appointments.wa_recordatorio_enviado`, and a partial index for the reminder cron's query.
- **Known gap**: `GET /jobs/send-reminders` (the pre-existing 24h *email* reminder job, unrelated to this WhatsApp reminder) has no auth check at all — flagged but intentionally not touched this session, since it's a separate pre-existing concern.
- **Not built this session (explicitly out of scope)**: no dashboard UI for the 2 toggles; WhatsApp AI conversational (`max_ia_wa`) sending — that's Piece 2, future session.

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

