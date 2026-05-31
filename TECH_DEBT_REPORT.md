# Orbyx Technical Debt Report

Prioritized technical debt report for Orbyx.

Scope: backend `server.js`, frontend `orbyx-web/`, Next API proxy routes, visible SQL files, and existing project documentation. This report is diagnostic only.

## Priority Legend

| Priority | Meaning |
|---|---|
| P0 | Can break production booking, data isolation, or critical user flows |
| P1 | High risk; likely to create bugs, inconsistent behavior, or security exposure |
| P2 | Medium risk; maintainability, performance, or UX reliability concern |
| P3 | Low risk; cleanup or improvement with limited immediate impact |

## Executive Summary

Highest-risk areas:

1. `server.js` is a large monolith that centralizes nearly all business rules.
2. Booking and availability are duplicated across old/new helper paths.
3. Multi-branch behavior depends on every caller sending `branch_id` correctly.
4. Several public/backend endpoints rely on IDs/slugs without clear auth boundaries.
5. Campaigns/customers can become tenant-wide when branch context is expected.
6. Timezone handling mixes `America/Santiago` with fixed offsets.

Recommended strategy: fix P0/P1 correctness and isolation issues first, then reduce duplication around availability and branch-aware data loading.

## P0 - Critical Risks

### 1. `POST /staff` References Undefined `address`

Category: Bugs potentiales  
Area: Backend staff creation  
File: `server.js`

The staff creation endpoint checks `address`, but `address` is not destructured from `req.body`. This can throw a `ReferenceError` and break staff creation.

Impact:

- New staff creation may fail.
- Staff-service setup and booking availability can be blocked for new branches/businesses.

Recommended fix:

- Remove the unrelated `address` validation from `POST /staff`, or explicitly add the field only if staff truly requires it.
- Add a minimal endpoint-level smoke test for creating staff.

### 2. `POST /billing/change-plan` References Undefined `logo_url`

Category: Bugs potentiales  
Area: Billing downgrade path  
File: `server.js`

The plan change endpoint contains a `console.log` that references `logo_url` outside its scope. If the downgrade branch executes, it can throw.

Impact:

- Plan downgrades may fail.
- Billing state can become inconsistent if frontend expects scheduled downgrade.

Recommended fix:

- Remove the unrelated log.
- Verify upgrade and downgrade paths separately.

### 3. Booking Creation Does Not Clearly Revalidate Staff-Service Relation When `staff_id` Is Submitted Directly

Category: Bugs potentiales, Riesgos de seguridad  
Area: Booking creation  
File: `server.js`

Public slot generation validates that a selected staff performs the selected service. The final `/appointments/slot` endpoint recalculates availability for submitted `staff_id`, but does not clearly enforce that `staff_id` belongs to `staff_services` for `service_id`.

Impact:

- A manipulated request may book a staff member for a service they do not perform.
- Agenda/service reporting can become inconsistent.

Recommended fix:

- In `/appointments/slot`, when both `service_id` and `staff_id` exist, check `staff_services` for tenant, branch, service, and staff.
- Keep response shape unchanged.

### 4. Multi-Branch Fallback Can Hide Missing `branch_id`

Category: Riesgos multi-sucursal  
Area: Backend branch resolution  
File: `server.js`

`resolveBranchId` falls back to the first active branch when `branch_id` is missing.

Impact:

- A page or endpoint that accidentally omits `branch_id` may read/write data in the wrong branch.
- Bugs can remain hidden until a tenant has multiple active branches.

Recommended fix:

- Keep fallback for public/default flows where intentional.
- For dashboard mutation endpoints, require explicit `branch_id` where branch scope is mandatory.
- Add endpoint-level comments/tests around intentional fallback.

## P1 - High Priority

### 5. Availability Logic Exists In Multiple Paths

Category: Código duplicado, Bugs potenciales  
Area: Availability  
File: `server.js`

There are older helpers such as `getBusinessAvailabilityWindows` / `getStaffAvailabilityWindows` and newer effective helpers such as `getEffectiveBusinessAvailability` / `getEffectiveStaffAvailability`.

Impact:

- Public slots and appointment creation can behave differently from internal `/slots`.
- Future fixes may patch one path and miss another.

Recommended refactor:

- Make the effective helpers the single source of truth.
- Convert `/slots` to use the same path as `/public/slots`.
- Avoid broad refactor until tests or manual comparison cases exist.

### 6. Timezone Handling Mixes Named Timezone And Fixed Offsets

Category: Bugs potenciales  
Area: Availability, agenda, metrics  
Files: `server.js`, agenda frontend

The code uses `America/Santiago`, but some date ranges use fixed `-03:00` or `-04:00` offsets.

Impact:

- Day/range boundaries can be wrong around daylight saving changes.
- Slots or agenda appointments can appear on the wrong day.

Recommended fix:

- Centralize Santiago date boundary helpers.
- Avoid fixed offsets for business logic.
- Add DST boundary test cases.

### 7. Branch Special Date Semantics Are Easy To Misread

Category: Bugs potenciales, Riesgos multi-sucursal  
Area: Availability  
File: `server.js`

Global business special dates are applied always. Branch special dates are added when `use_global_special_dates === false`; they do not replace or ignore global dates.

Impact:

- A globally closed day can still close a branch even if the branch is configured with local special dates.
- Business users may expect local branch dates to override global dates.

Recommended fix:

- Confirm desired product behavior.
- Rename/copy in UI or backend to clarify "also apply local" vs "use global".
- If override behavior is desired, change effective availability carefully.

### 8. Campaigns And Customers Can Be Tenant-Wide Instead Of Branch-Scoped

Category: Riesgos multi-sucursal  
Area: Customers, campaigns  
Files: `server.js`, `orbyx-web/app/dashboard/[slug]/campaigns/page.tsx`, `customers/page.tsx`

Customers are tenant-scoped; branch filtering is derived from appointments. Campaign send can use global customer lists unless audience is branch-filtered/curated.

Impact:

- Campaigns may target customers from other branches.
- Dashboard counts can differ from branch-specific expectations.

Recommended fix:

- Add explicit branch context to campaign audience generation.
- Store `branch_id` on campaign history when branch-scoped.
- Keep tenant-wide campaign mode explicit.

### 9. Public And Dashboard Endpoints Lack Clear Auth Boundary In Code

Category: Riesgos de seguridad  
Area: Backend API  
File: `server.js`

Many endpoints use tenant IDs, slugs, or resource IDs directly. The code does not show a consistent auth/authorization middleware layer for dashboard mutations.

Impact:

- If backend is publicly reachable, mutation endpoints may be callable without dashboard auth unless protected externally.
- Service role Supabase access makes backend authorization especially important.

Recommended fix:

- Document current deployment/auth boundary.
- Add middleware for dashboard-only endpoints.
- Validate tenant ownership for all resource IDs before mutation.

### 10. Upload Routes Use Service Role And Need Stronger Validation

Category: Riesgos de seguridad  
Area: Next API routes  
Files: `upload-business-logo/route.ts`, `upload-staff-photo/route.ts`

Upload routes use Supabase service role server-side. Staff photo upload does not clearly validate MIME/type as strongly as business logo upload, and ownership checks are not obvious.

Impact:

- Unauthorized uploads or overwrites may be possible if route is exposed.
- Storage buckets can collect untrusted content.

Recommended fix:

- Validate MIME, extension, size, and ownership.
- Require authenticated dashboard context for uploads.
- Avoid predictable overwrite paths where possible.

## P2 - Medium Priority

### 11. `server.js` Monolith Has High Blast Radius

Category: Riesgos de escalabilidad, Archivos peligrosos  
Area: Backend maintainability  
File: `server.js`

`server.js` contains plans, billing, OAuth, booking, availability, campaigns, PDF generation, pets, customers, branches, services, and staff.

Impact:

- Small changes can affect unrelated code.
- Merge conflicts and accidental regressions are likely.
- Hard to test isolated behavior.

Recommended refactor:

- Do not perform a massive refactor immediately.
- First add characterization tests or endpoint smoke tests around booking/availability.
- Later extract low-risk helpers only: plan helpers, date/time helpers, email/campaign templates.

### 12. Hardcoded Production Backend URL In Frontend

Category: Código duplicado, Riesgos de escalabilidad  
Area: Frontend config  
Files: multiple under `orbyx-web/app`

Many frontend files hardcode `https://orbyx-backend.onrender.com`.

Impact:

- Local/staging/prod environments are harder to switch.
- Tests and previews can accidentally hit production.

Recommended fix:

- Centralize backend URL in one config helper.
- Use environment variables with safe defaults.
- Migrate incrementally, one route/page at a time.

### 13. Frontend Pages Are Very Large Client Components

Category: Riesgos de performance, escalabilidad, mantenibilidad  
Area: Dashboard and public booking  
Files: booking page, agenda page, campaigns page, services page, staff page

Large pages combine state, API calls, UI rendering, validation, and business-specific logic.

Impact:

- Hard to reason about.
- Higher risk of stale state bugs.
- Difficult to test or reuse.

Recommended refactor:

- Extract pure helper functions first.
- Extract small UI components only when behavior is stable.
- Avoid changing data flow during visual refactors.

### 14. Agenda Has Local Availability Display Logic That Can Diverge From Backend

Category: Bugs potenciales, Código duplicado  
Area: Agenda  
File: `orbyx-web/app/dashboard/[slug]/agenda/page.tsx`

Agenda computes visual open/closed windows from loaded hours/special dates, while backend computes authoritative slot availability separately.

Impact:

- Agenda may show closed/open slots differently than public booking.
- Manual booking actions can feel inconsistent.

Recommended fix:

- Expose backend availability debug/effective windows endpoint, or reuse public slots per staff/date for agenda visuals.
- Keep backend as source of truth for actual booking.

### 15. Plan Limits Are Duplicated Between Backend And Frontend

Category: Código duplicado  
Area: Plans/billing/services/campaigns  
Files: `server.js`, services/campaigns frontend pages

Plan caps exist in backend and some frontend constants.

Impact:

- UI may show one limit while backend enforces another.
- Product changes require multiple edits.

Recommended fix:

- Add a read-only backend endpoint for plan capabilities.
- Let frontend render limits from backend response.

### 16. Group Booking Concurrency Needs Strong DB-Level Guarantees

Category: Bugs potenciales, Riesgos de escalabilidad  
Area: Booking  
File: `server.js`, database constraints not fully confirmed

The backend counts existing group appointments before insert. Under concurrent requests, two clients can pass the count before either insert commits.

Impact:

- Group slots can exceed capacity.

Recommended fix:

- Add database constraint or transactional/RPC booking operation for group capacity.
- Keep API response shape unchanged.

### 17. Calendar Connection State Is Not Reflected Clearly In Public Business Response

Category: Bugs potenciales  
Area: Calendar UX  
File: `server.js`

`/public/business/:slug` returns `google_connected: false` regardless of actual connection state.

Impact:

- UI may show incorrect calendar connection status.
- Operators may not know whether sync is configured.

Recommended fix:

- Return computed connection state from `calendar_connections`/legacy tokens.
- Keep public exposure minimal.

## P3 - Lower Priority

### 18. Encoding/Mojibake In Existing Text

Category: Código difícil de mantener  
Area: Comments/UI strings/logs  
Files: multiple

Some existing files contain mojibake characters in comments or strings.

Impact:

- Reduces readability.
- Can leak poor text into UI/emails/PDFs.

Recommended fix:

- Clean only user-visible strings when touched for a related task.
- Avoid broad reformatting or mass encoding churn.

### 19. Logging Noise In Production Paths

Category: Performance, maintainability  
Area: Backend logs  
File: `server.js`

Some endpoints log payload/update/debug information.

Impact:

- Logs can become noisy.
- Potential accidental exposure of business/customer data.

Recommended fix:

- Gate debug logs behind environment flags.
- Remove logs that reference request payloads unless needed.

### 20. Next API Proxy And Direct Backend Calls Are Mixed

Category: Código duplicado  
Area: Frontend architecture  
Files: `orbyx-web/app`, `orbyx-web/app/api`

Some flows call backend directly; others go through Next API routes.

Impact:

- Error handling differs across pages.
- Environment switching and auth strategy become inconsistent.

Recommended fix:

- Decide which flows require proxy routes.
- Centralize fetch helpers and error normalization.

## Dangerous Files To Modify

| Priority | File | Why Dangerous |
|---|---|---|
| P0 | `server.js` | Centralizes booking, availability, auth-adjacent behavior, calendar, campaigns, plans |
| P0 | `orbyx-web/app/[slug]/page.tsx` | Public booking path for generic, veterinary, and group booking |
| P0 | `orbyx-web/app/dashboard/[slug]/agenda/page.tsx` | Large stateful agenda with status, group, manual booking, vet close logic |
| P1 | `orbyx-web/app/dashboard/[slug]/layout.tsx` | Active branch state and dashboard navigation |
| P1 | `orbyx-web/app/dashboard/[slug]/services/page.tsx` | Service CRUD, buffers, group settings, staff-service relations |
| P1 | `orbyx-web/app/dashboard/[slug]/staff/page.tsx` | Staff CRUD, staff hours, special dates |
| P1 | `orbyx-web/app/dashboard/[slug]/business/page.tsx` | Business settings, booking fields, hours, special dates |
| P1 | `orbyx-web/app/dashboard/[slug]/campaigns/page.tsx` | Campaign audience and send behavior |
| P2 | `email.js` | Confirmation email behavior |
| P2 | `orbyx-web/lib/use-theme.ts` | Global dashboard theme behavior |

## Recommended Refactor Roadmap

### Phase 1 - Correctness Fixes

Priority: P0/P1

1. Fix undefined variables in `POST /staff` and billing downgrade path.
2. Add final staff-service validation inside `/appointments/slot`.
3. Identify endpoints where dashboard mutations must require explicit `branch_id`.
4. Clarify/confirm branch special date semantics.

### Phase 2 - Booking And Availability Stabilization

Priority: P1/P2

1. Create a small set of booking/availability regression scenarios.
2. Make effective availability helpers the only backend source for slot generation.
3. Centralize Santiago date boundary handling.
4. Add group capacity protection at DB/transaction level.

### Phase 3 - Security Boundary

Priority: P1

1. Document current auth model.
2. Add or confirm middleware for dashboard-only mutation endpoints.
3. Strengthen upload ownership and file validation.
4. Review public endpoints for overexposure.

### Phase 4 - Multi-Branch Hardening

Priority: P1/P2

1. Make branch scope explicit in campaigns.
2. Add branch-aware campaign history if required by product.
3. Audit all tenant-wide reads in dashboard pages.
4. Reduce silent branch fallback in dashboard writes.

### Phase 5 - Maintainability

Priority: P2/P3

1. Centralize backend URL config in frontend.
2. Extract pure date/time/plan helper functions after tests exist.
3. Split large client pages into smaller components only when behavior is stable.
4. Reduce logging noise and clean user-visible encoding issues opportunistically.

## Verification Recommendations

For future changes, verify the smallest relevant surface:

| Change Type | Suggested Check |
|---|---|
| Frontend | `cd orbyx-web && npm run build` |
| Backend syntax/basic runtime | `npm start` |
| Public booking | Manual flow for generic, veterinary, and group booking categories |
| Availability | Compare slots before/after for global hours, branch hours, staff hours, special dates |
| Multi-branch | Repeat test with at least two active branches |
| Calendar | Booking with connected and disconnected calendar |
| Campaigns | Branch-filtered audience and tenant-wide audience |

Documentation-only changes require no build or deploy.

