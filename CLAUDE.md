# CLAUDE.md

Compact context for Claude Code when working on Orbyx.

## Stack And Architecture

Orbyx is a multi-tenant SaaS booking platform.

- Frontend: Next.js App Router in `orbyx-web/`.
- Backend: Node.js + Express monolith in root `server.js`.
- Database/storage: Supabase.
- Email: Resend through `email.js`.
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

