# Orbyx Project Map

Orbyx is a SaaS booking platform similar to AgendaPro. The product supports public bookings, business dashboards, staff/service scheduling, campaigns, group booking, veterinary-specific flows, branches, and Google Calendar integration.

This document is a technical map for future sessions. It is descriptive only.

## Stack

- Frontend: Next.js App Router in `orbyx-web/`
- Backend: Node.js + Express in root `server.js`
- Database/storage: Supabase
- Calendar: Google Calendar API via OAuth tokens stored in Supabase
- Email: Resend
- Frontend UI: React client components, Tailwind classes, lucide-react icons, custom theme CSS

## Repository Layout

```txt
.
├── server.js
├── email.js
├── supabaseClient.js
├── package.json
├── token.json
└── orbyx-web/
    ├── app/
    │   ├── page.tsx
    │   ├── [slug]/page.tsx
    │   ├── api/
    │   ├── dashboard/[slug]/
    │   ├── cancel/[id]/page.tsx
    │   ├── signup/page.tsx
    │   ├── onboarding/page.tsx
    │   ├── start/page.tsx
    │   ├── planes/
    │   └── checkout/page.tsx
    ├── components/dashboard/
    ├── lib/use-theme.ts
    ├── public/
    └── package.json
```

## Backend Overview

The backend is a single Express monolith in `server.js`. It owns most business logic:

- tenant/business config
- branches
- calendars and OAuth
- services
- staff
- staff-service relations
- business/staff hours
- special dates
- public availability
- appointment creation and cancellation
- customer upsert and segmentation
- veterinary pets/followups/clinical PDF
- campaigns and campaign images
- billing plan limits and plan changes
- onboarding/provisioning

Use small, localized changes when editing `server.js`. Avoid broad restructuring.

## Frontend Overview

The frontend lives in `orbyx-web/` and uses Next.js App Router.

Most pages are client components using:

- `useState`
- `useEffect`
- `useMemo`
- direct `fetch` calls to `https://orbyx-backend.onrender.com`
- selected internal Next API route proxies for public booking

There is no formal global state library. Cross-page dashboard state is mostly handled through `localStorage` and browser events.

## Important Frontend Files

- `orbyx-web/app/[slug]/page.tsx`
  - Public booking page.
  - Loads business, branches, services, staff, slots.
  - Creates public bookings through `/api/appointments/slot`.
  - Handles veterinary pet fields and group booking slot capacity display.

- `orbyx-web/app/dashboard/[slug]/layout.tsx`
  - Dashboard shell and navigation.
  - Handles selected branch.
  - Persists active branch in `localStorage` as `orbyx_active_branch_${slug}`.
  - Dispatches `orbyx-branch-changed`.

- `orbyx-web/app/dashboard/[slug]/page.tsx`
  - Dashboard metrics/home.

- `orbyx-web/app/dashboard/[slug]/agenda/page.tsx`
  - Weekly agenda.
  - Loads appointments by range.
  - Filters by branch and staff.
  - Handles status changes, pending close appointments, reservation edit, search.
  - Contains veterinary close flow for completed appointments/followups.

- `orbyx-web/app/dashboard/[slug]/staff/page.tsx`
  - Staff CRUD.
  - Staff image upload.
  - Staff hours and staff special dates.
  - Staff-service assignments.
  - Plan limit enforcement UI.

- `orbyx-web/app/dashboard/[slug]/services/page.tsx`
  - Services CRUD.
  - Staff-service relation editing.
  - Plan limit enforcement UI.
  - Group booking service controls when `business_category === "group_booking"`.

- `orbyx-web/app/dashboard/[slug]/business/page.tsx`
  - Business profile.
  - Booking rules.
  - Public URL.
  - Business hours.
  - Business special dates.
  - Booking fields configuration.
  - Calendar slot interval.

- `orbyx-web/app/dashboard/[slug]/campaigns/page.tsx`
  - Campaign builder.
  - Audience selection.
  - Email/WhatsApp campaign flows.
  - Campaign image uploads.
  - Campaign history/log loading.

- `orbyx-web/app/dashboard/[slug]/campaigns/history/page.tsx`
  - Campaign history list.

- `orbyx-web/app/dashboard/[slug]/customers/page.tsx`
  - Customer list and segmentation.
  - Veterinary-specific customer/pet signals.

- `orbyx-web/app/dashboard/[slug]/customers/[id]/page.tsx`
  - Customer detail.
  - Veterinary pet creation and clinical history.
  - Clinical PDF link.

- `orbyx-web/app/dashboard/[slug]/branches/page.tsx`
  - Branch management.

- `orbyx-web/app/dashboard/[slug]/billing/page.tsx`
  - Plan/billing flows.

- `orbyx-web/app/dashboard/[slug]/connect-calendar/page.tsx`
  - Redirects to backend Google OAuth.

- `orbyx-web/lib/use-theme.ts`
  - Dashboard theme state.
  - Supports `clasico` and `nocturno`.

## Next API Routes

These proxy selected public booking calls to the backend:

- `orbyx-web/app/api/public-services/[slug]/route.ts`
  - Calls backend `/public/services/:slug`.
  - Also loads `/branches?tenant_id=...`.

- `orbyx-web/app/api/public-staff/[slug]/[service_id]/route.ts`
  - Calls backend `/public/staff/:slug/:service_id`.

- `orbyx-web/app/api/public-slots/[slug]/[serviceId]/route.ts`
  - Calls backend `/public/slots/:slug/:service_id`.

- `orbyx-web/app/api/appointments/slot/route.ts`
  - Normalizes UUID-like values.
  - Calls backend `/appointments/slot`.

- `orbyx-web/app/api/upload-staff-photo/route.ts`
  - Uploads staff photos to Supabase storage bucket `staff-photos`.

## Main Backend Endpoint Areas

### Google Calendar OAuth

- `GET /auth?calendar_id=...`
- `GET /oauth2callback`
- `GET /test-event`

Tokens are saved in `calendar_tokens`, keyed by `calendar_id` for SaaS mode. Appointment creation uses `getGoogleCalendarClientByCalendarId(calendar_id)`.

### Business Hours and Special Dates

- `GET /business-hours`
- `PUT /business-hours`
- `GET /business-special-dates`
- `POST /business-special-dates`
- `PUT /business-special-dates/:id`
- `DELETE /business-special-dates/:id`

Availability uses weekly hours plus special date overrides. Business and staff windows are intersected for staff-specific booking.

### Staff

- `GET /staff`
- `POST /staff`
- `PUT /staff/:id`
- `DELETE /staff/:id`
- `GET /staff-services`
- `PUT /staff-services`
- `DELETE /staff-services/:id`
- `GET /staff-hours`
- `PUT /staff-hours`
- `GET /staff-special-dates`
- `POST /staff-special-dates`
- `PUT /staff-special-dates/:id`
- `DELETE /staff-special-dates/:id`

Staff belongs to tenant and branch. Staff can use business hours or have custom hours. Services are assigned through `staff_services`.

### Public Booking

- `GET /public/services/:slug`
- `GET /public/business/:slug`
- `GET /public/staff/:slug/:service_id`
- `GET /public/slots/:slug/:service_id`
- `POST /appointments/slot`

The public booking page depends heavily on these endpoints.

### Appointments and Agenda

- `GET /appointments`
- `GET /appointments/:id`
- `PATCH /appointments/:id`
- `DELETE /appointments/:id`
- `GET /appointments/by-day/:slug/:date`
- `GET /appointments/by-range/:slug`
- `GET /appointments/pending-close/:slug`
- `GET /appointments/search/:slug`
- `PATCH /appointments/:id/status`
- `POST /appointments/:id/close`
- `PATCH /appointments/:id/clinical`

Appointment creation inserts into Supabase, upserts customers, optionally resolves/creates pets, creates a Google Calendar event, stores `event_id`, and sends confirmation email.

### Customers, Pets, Veterinary

- `GET /customers/:slug`
- `GET /pets/:slug`
- `POST /pets`
- `GET /pet-followups/:slug`
- `GET /pets/:id/clinical-pdf`
- `PATCH /appointments/:id/clinical`
- `POST /appointments/:id/close`

Veterinary mode depends on `tenants.business_category` being `veterinaria` or `vet`.

### Campaigns

- `POST /campaigns/send-email`
- `POST /campaigns/save-whatsapp`
- `GET /campaigns/history/:slug`
- `GET /campaigns/logs/:campaignId`
- `POST /upload/campaign-image`
- `GET /campaign-images/:slug`
- `DELETE /campaign-images/:id`

Campaigns use customer segmentation based on visit count and inactivity. Email send uses Resend. WhatsApp is saved to history/logs but real backend WhatsApp sending is not enabled.

### Billing and Plans

- `GET /billing/preview-change`
- `POST /billing/change-plan`
- `POST /billing/apply-scheduled-changes`

Plan capabilities affect max staff, services, branches, and campaign email send limits.

### Tenant, Branches, Services, Onboarding

- `POST /tenants/provision`
- `PATCH /tenants/:id`
- `GET /branches`
- `POST /branches`
- `PATCH /branches/:id`
- `GET /services`
- `POST /services`
- `PATCH /services/:id`
- `DELETE /services/:id`
- `POST /onboarding/setup`
- `GET /booking-fields/:slug`
- `PUT /booking-fields/:slug`
- `PATCH /calendars/:id/slot-minutes`

## Core Data Model Concepts

Likely key Supabase tables:

- `tenants`
- `tenant_users`
- `branches`
- `calendars`
- `calendar_tokens`
- `services`
- `staff`
- `staff_services`
- `business_hours`
- `business_special_dates`
- `staff_hours`
- `staff_special_dates`
- `appointments`
- `customers`
- `pets`
- `pet_followups`
- `campaign_history`
- `campaign_delivery_logs`
- `campaign_images`

## Public Booking Flow

1. User opens `/{slug}`.
2. Frontend calls `/api/public-services/${slug}`.
3. Next API route calls backend `/public/services/:slug`, then `/branches`.
4. Frontend stores `business`, `calendarId`, `branches`, `selectedBranchId`, `services`, `bookingFields`.
5. On branch change, services reload.
6. On service selection, staff reloads via `/api/public-staff`.
7. On date/week/staff change, slots reload via `/api/public-slots`.
8. On submit, frontend validates required fields, veterinary pet fields if needed, and sends to `/api/appointments/slot`.
9. Backend validates:
   - required fields
   - Chilean mobile phone
   - email
   - calendar active
   - tenant booking limits
   - branch
   - service
   - slot availability
   - group capacity or non-group uniqueness
   - duplicate future active appointments
10. Backend inserts appointment.
11. Backend upserts customer and pet info.
12. Backend creates Google Calendar event.
13. Backend updates appointment with `event_id`.
14. Backend sends confirmation email with cancel URL.
15. Frontend shows success state and Google Calendar save link for customer.

## Availability Logic

Important helpers in `server.js`:

- `resolveBranchId`
- `parseDateToWeekday`
- `timeToMinutes`
- `isoToMinutesInDate`
- `santiagoLocalToUtcIso`
- `buildSlotsFromWindows`
- `getBusinessAvailabilityWindows`
- `getStaffAvailabilityWindows`
- `intersectWindows`
- `subtractAppointmentsFromWindows`
- `filterSlotsByWindows`
- `filterSlotsForServiceDuration`
- `filterPastSlots`
- `getServiceStaffIds`

Availability combines:

- tenant/calendar
- branch
- business weekly hours
- business special dates
- staff weekly hours
- staff special dates
- service duration
- buffers
- existing booked appointments
- min booking notice
- max days ahead
- group capacity

This area is sensitive. Change only with focused tests/manual verification.

## Branch Logic

Branches are central:

- Many endpoints require or resolve `branch_id`.
- If no `branch_id` is provided, backend resolves the first active branch.
- Dashboard layout stores active branch in `localStorage`.
- Pages listen to `orbyx-branch-changed` and reload data.
- Services, staff, hours, slots, appointments and public booking all depend on branch consistency.

Do not remove or bypass branch handling.

## business_category and UI Behavior

`tenants.business_category` is a major feature switch.

Known values used by UI:

- `veterinaria`
- `vet`
- `fitness`
- `clases`
- `talleres`
- `eventos`
- `group_booking`

Behavior:

- Public booking page:
  - `veterinaria` / `vet` enables pet fields and existing pet lookup.
  - `fitness`, `clases`, `talleres`, `eventos`, `group_booking` enables group booking slot copy/capacity display.

- Agenda:
  - `veterinaria` / `vet` enables veterinary close workflow and pet data display.

- Customers:
  - `veterinaria` / `vet` enables pets, followups, and clinical PDF views.

- Services:
  - `group_booking` enables editing service `is_group` and `capacity`.

Always validate assumptions around `business_category` before changing UI behavior.

## Group Booking

Backend:

- Services have `is_group` and `capacity`.
- Public slots attach:
  - `is_group`
  - `capacity`
  - `booked_count`
  - `available_spots`
- Appointment creation allows multiple bookings at same slot until `existingCount >= capacity`.
- Non-group bookings reject any existing booking at same start time/staff.

Frontend:

- `services/page.tsx` exposes group controls when `businessCategory === "group_booking"`.
- Public booking page displays available spots for group slots when business is group-booking-like.

## Veterinary Mode

Veterinary behavior is active when category is `veterinaria` or `vet`.

Features:

- Pet fields on public booking.
- Existing pet lookup by customer phone/email.
- Appointment stores `pet_id` and `customer_data.pet_name/pet_species`.
- Agenda displays pet info.
- Appointment close can create `pet_followups`.
- Customer detail can create pets, edit clinical notes, show followups.
- Clinical PDF endpoint exists for pets and is restricted to veterinary businesses.
- Booking confirmation email includes pet details in veterinary mode.

Preserve this compatibility when editing generic booking flows.

## Campaigns

Campaigns segment customers into:

- `new`
- `recurrent`
- `frequent`
- `inactive`

Segmentation depends on `total_visits`, `last_visit_at`, and configured inactive days.

Email campaigns:

- real send through Resend
- saved in `campaign_history`
- per-recipient logs in `campaign_delivery_logs`
- supports curated/manual audience
- uses plan send limit

WhatsApp campaigns:

- saved as history/logs
- not sent by backend as a real external WhatsApp integration

## Theme

Dashboard theme is handled by `orbyx-web/lib/use-theme.ts`.

Values:

- `clasico`
- `nocturno`

Stored in localStorage key:

- `orbyx-dashboard-theme`

Do not break `data-theme` behavior or theme switching while changing UI.

## Known Risk Areas

- `server.js` is monolithic and very large.
- Many frontend files hardcode backend URL instead of using one centralized config.
- The public booking flow mixes Next API proxies and direct backend calls.
- Timezone logic is Santiago-specific and appears in several places.
- Google Calendar connection state may not be fully reflected by `/public/business/:slug`, which currently returns `google_connected: false`.
- Onboarding/setup looks older than current branch-aware model in some places.
- Some text has mojibake/encoding artifacts.
- Branch filtering must be preserved in staff/services/slots/appointments.
- Group booking and veterinary modes share the public booking path, so changes must preserve all category variants.

## Future Work Guidelines

For future changes:

- Identify the smallest file and block that owns the behavior.
- Prefer page-local changes in frontend when possible.
- Prefer endpoint-local changes in backend.
- Avoid broad cleanup, formatting churn, or architecture refactors.
- Before editing, state exactly which files will be touched and why.
- After changes, give deploy commands for frontend/backend as appropriate.

