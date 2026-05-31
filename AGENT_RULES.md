# AGENT_RULES.md

Rules for AI agents working on Orbyx without breaking architecture.

## IA Editing Rules

- Analyze first and edit after understanding the exact flow.
- Make minimal, safe changes.
- Do not restructure the project without explicit authorization.
- Do not modify backend unless explicitly requested or required by the task.
- Do not modify global styles unless explicitly requested.
- Before editing, state which files will be modified and why.
- Keep multi-branch compatibility.
- Do not break availability logic.
- Do not break public booking flow.
- Do not delete existing code without explaining the reason.
- Do not rename critical files unnecessarily.
- Prefer reusing existing components, helpers, endpoints, and patterns.
- Keep mobile responsive behavior intact.
- Validate relationships between `appointments`, `services`, `staff`, `branches`, and `tenants`.
- Avoid massive refactors and broad formatting churn.
- Avoid unnecessary reads of very large files; use targeted search/context.
- Preserve existing response shapes, Supabase contracts, and local conventions.

## Work Protocol

Before editing:

- identify the owner file/block
- list files to touch
- state expected unchanged behavior

While editing:

- keep patches small
- touch only requested surfaces
- do not revert unrelated user changes
- do not run migrations unless explicitly requested

After editing:

- summarize changes
- list commands run and results
- include deploy commands for changed surfaces
- report any verification not run

## Architecture Boundaries

- Frontend: Next.js App Router in `orbyx-web/`.
- Backend: Express monolith in root `server.js`.
- Database/storage: Supabase.
- Email: Resend through `email.js`.
- Calendar: Google Calendar OAuth/API through backend helpers.

Backend:

- `server.js` is the backend source of truth.
- Touch only the exact endpoint/helper required.
- Do not split backend into modules unless explicitly requested.

Frontend:

- Most pages are client components with local state and direct `fetch`.
- Do not introduce global state libraries.
- Preserve dashboard layout/navigation.
- Preserve `orbyx-web/lib/use-theme.ts`: `clasico`, `nocturno`, `orbyx-dashboard-theme`, `data-theme`.

## Sensitive Files

| File | Why sensitive |
|---|---|
| `server.js` | Booking, availability, branches, calendar, campaigns, plans |
| `orbyx-web/app/[slug]/page.tsx` | Public booking |
| `orbyx-web/app/dashboard/[slug]/agenda/page.tsx` | Agenda, statuses, group/vet/manual booking |
| `orbyx-web/app/dashboard/[slug]/layout.tsx` | Active branch selection |
| `orbyx-web/app/dashboard/[slug]/services/page.tsx` | Services, buffers, group settings, staff relations |
| `orbyx-web/app/dashboard/[slug]/staff/page.tsx` | Staff, hours, special dates |
| `orbyx-web/app/dashboard/[slug]/business/page.tsx` | Business config, hours, booking fields |
| `orbyx-web/app/dashboard/[slug]/branches/page.tsx` | Branch CRUD and behavior flags |
| `orbyx-web/app/dashboard/[slug]/campaigns/page.tsx` | Campaign audience and sending/saving |
| `email.js` | Booking confirmation email |
| `orbyx-web/lib/use-theme.ts` | Global dashboard theme |

## Multi-Branch Rules

- Active dashboard branch is stored as `orbyx_active_branch_${slug}`.
- Dashboard pages listen for `orbyx-branch-changed`.
- Preserve `branch_id` in staff, services, staff-services, hours, appointments, slots, agenda, and public booking.
- Do not rely on first-active-branch fallback for dashboard writes.
- Do not remove branch filters from dashboard queries.
- Do not treat tenant-wide data as branch-specific data.

## Availability Rules

Preserve:

- timezone `America/Santiago`
- global and branch business hours
- branch flags for global/local hours and special dates
- staff `use_business_hours`
- staff hours intersecting business availability
- staff special dates after staff hours
- individual appointments subtracting booked time
- group bookings using capacity instead of removing slots
- service duration plus buffers
- min booking notice and max days ahead

Do not change availability without checking global hours, branch hours, staff hours, special dates, individual services, and group services.

## Booking Rules

Public booking flow must remain:

1. `/{slug}` loads business, branches, services.
2. Service selection loads staff.
3. Date/staff selection loads slots.
4. Submit calls `/api/appointments/slot`.
5. Backend `/appointments/slot` validates and creates appointment.
6. Backend upserts customer/pet, attempts calendar sync, sends email when configured.

Required validations:

- required fields, valid email, Chilean mobile phone
- active calendar
- tenant/branch ownership
- service belongs to tenant/branch
- staff belongs to tenant/branch
- staff performs selected service when `staff_id` is provided
- submitted slot survives backend recalculation
- individual duplicate prevention
- group capacity limit
- customer overlap prevention
- min notice and max days ahead

Calendar sync failure must not cancel or delete a valid local booking.

## Agenda Rules

- Load appointments with `branch_id`.
- Preserve statuses: `booked`, `completed`, `no_show`, `rescheduled`, `canceled`.
- Manual booking must use the same booking endpoint/validation.
- Preserve grouped appointment display for group services.
- Preserve veterinary close flow and followups.
- Do not count canceled appointments as active group capacity.
- Backend booking validation is the source of truth, not agenda visual availability.

## Business Category Rules

Preserve:

- veterinary behavior for `veterinaria` and `vet`
- group service controls for `group_booking`
- group-like public capacity display for `fitness`, `clases`, `talleres`, `eventos`, `group_booking`
- generic mode without pet fields or group controls

Any public booking change must account for generic, veterinary, and group booking modes.

## Staff, Services, Customers, Campaigns

- Staff belongs to tenant and branch.
- Services belong to tenant and branch.
- `staff_services` links staff and services inside a branch.
- Public services require at least one assigned staff member.
- Service buffers affect slot validity and appointment end time.
- Customers are tenant-scoped; branch-specific customer views are derived from appointments.
- Email campaigns send through Resend.
- WhatsApp campaigns are saved/logged only; no real backend WhatsApp send.
- Campaign audiences must be branch-aware when the UI context is branch-specific.

## Security Rules

- Never expose Supabase service role keys, OAuth tokens, Resend API key, Google client secret, or other secrets.
- Validate tenant ownership before mutating branch, staff, service, appointment, customer, or pet records.
- Preserve cancel-token validation.
- Keep uploads server-side; validate file type, size, and ownership when changing uploads.
- Do not log secrets, tokens, or unnecessary customer data.

## Validation And Deploy

Use the smallest relevant check.

Frontend changed:

```bash
cd orbyx-web
npm run build
```

Then deploy frontend to the configured host, normally Vercel.

Backend changed:

```bash
npm start
```

Then deploy or restart backend service, normally Render.

Both changed: provide both command sets.

Documentation-only changed: no build/deploy required.

## Common Errors

- Omitting `branch_id` in dashboard flows.
- Updating public slots but not `/appointments/slot` validation.
- Forgetting service buffers.
- Treating group booking like individual booking.
- Breaking veterinary fields while editing generic booking.
- Using tenant-wide customers for a branch-specific campaign.
- Changing plan limits only in frontend or backend.
- Changing endpoint response shapes.
- Editing `server.js` broadly for a narrow task.
- Modifying global styles for local UI problems.
- Running migrations without explicit request.

