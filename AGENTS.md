# Orbyx Agent Instructions

These rules apply when working on this repository.

## Project Identity

Orbyx is a SaaS booking platform similar to AgendaPro.

Stack:

- Frontend: Next.js App Router in `orbyx-web/`
- Backend: Node.js + Express
- Database/storage: Supabase
- Backend entrypoint: root `server.js`

## Working Rules

- Do not perform massive refactors.
- Make minimal, safe changes.
- Preserve existing logic and local patterns.
- Before editing, explain which files will be touched and why.
- Do not change functional behavior when the task is documentation-only.
- Keep changes scoped to the specific requested behavior.
- If build errors appear, fix only what is necessary for the requested change.
- Do not reformat large files unless explicitly asked.
- Do not rename or reorganize routes/modules unless explicitly asked.

## Backend Rules

- The backend is an Express monolith in `server.js`.
- Touch only the exact endpoint/helper block needed.
- Avoid moving backend code into new modules unless explicitly asked.
- Preserve Supabase table contracts and response shapes.
- Preserve Google Calendar OAuth and appointment event creation flow.
- Preserve Resend email behavior unless the task is specifically about email.
- Preserve plan limit checks for staff, services, branches, and campaigns.
- Preserve Chile/Santiago timezone behavior unless the task is specifically about timezone.

## Frontend Rules

- The frontend uses Next.js App Router.
- Most dashboard/public pages are client components with local state and `fetch`.
- Follow existing page-local state patterns.
- Do not introduce global state libraries unless explicitly asked.
- Do not break the dashboard layout or navigation.
- Do not break classic/nocturnal theme behavior.
- Preserve `orbyx-web/lib/use-theme.ts` behavior:
  - `clasico`
  - `nocturno`
  - `orbyx-dashboard-theme`
  - `data-theme`

## Branch Rules

- Preserve branch-aware behavior.
- Dashboard active branch is stored in localStorage as `orbyx_active_branch_${slug}`.
- Dashboard pages listen for `orbyx-branch-changed`.
- Staff, services, hours, appointments, slots, and public booking depend on `branch_id`.
- Do not bypass `branch_id` or `resolveBranchId`.

## business_category Rules

Always validate and preserve `business_category` behavior.

Known categories:

- `veterinaria`
- `vet`
- `fitness`
- `clases`
- `talleres`
- `eventos`
- `group_booking`

Compatibility requirements:

- Preserve veterinary mode.
- Preserve generic booking mode.
- Preserve group booking mode.

Veterinary mode:

- `veterinaria` and `vet` enable pet fields, pets, followups, clinical close flow, and clinical PDF.

Group booking mode:

- `group_booking` enables service group controls in dashboard services.
- Public booking also treats `fitness`, `clases`, `talleres`, `eventos`, and `group_booking` as group-booking-like for slot/capacity display.

Generic mode:

- Must continue to work without pet fields or group capacity controls.

## Public Booking Rules

Preserve the flow:

1. `/{slug}` loads public services/business/branches.
2. Service selection loads staff.
3. Date/staff selection loads slots.
4. Submit calls `/api/appointments/slot`.
5. Next API route forwards to backend `/appointments/slot`.
6. Backend validates, inserts appointment, creates Google Calendar event, updates `event_id`, upserts customer/pet data, and sends email.

Do not break:

- booking field config
- branch selection
- staff-service filtering
- slot availability
- min booking notice
- max days ahead
- duplicate appointment checks
- group capacity
- veterinary pet validation

## Campaign Rules

- Preserve campaign history and delivery logs.
- Email campaigns send through Resend.
- WhatsApp campaigns are saved/logged but not sent as a real backend WhatsApp integration.
- Preserve plan send limits and customer segmentation.

## Deployment Command Guidance

Always provide deploy commands according to what changed.

If frontend changed:

```bash
cd orbyx-web
npm run build
```

Then deploy using the configured frontend host, normally Vercel.

If backend changed:

```bash
npm start
```

Then deploy/restart the backend service, normally Render.

If both changed, provide both frontend and backend commands.

If only documentation changed, say no build/deploy is required.

## Verification Guidance

- For frontend changes, run the relevant build/lint command when feasible.
- For backend changes, run the smallest practical verification command.
- If build/test errors are unrelated to the requested change, report them and avoid broad fixes.
- If build/test errors are caused by the change, fix only the necessary lines.

## Communication Rules

- Before code edits, state the intended files and reason.
- After edits, summarize what changed.
- Include commands run and their results.
- Include deploy commands according to changed surface.
- Keep explanations concise and technical.

