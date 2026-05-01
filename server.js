console.log("BACKEND VERSION 26-03-EMAIL-CANCEL");

// server.js
require("dotenv").config();
const express = require("express");
const multer = require("multer");
const { createClient } = require("@supabase/supabase-js");
const cors = require("cors");
const { google } = require("googleapis");
const crypto = require("crypto");
const PDFDocument = require("pdfkit");
const { sendBookingEmail } = require("./email");

const app = express();

// =======================
// SUPABASE
// =======================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const BUCKET = process.env.SUPABASE_CAMPAIGN_IMAGES_BUCKET || "campaign-images";

// =======================
// MULTER
// =======================
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 2 * 1024 * 1024, // 2MB
  },
});

// =======================
// HELPERS
// =======================
const PLAN_LIMITS = {
  pro: 7,
  premium: 15,
  vip: 30,
  platinum: 100,
};

function normalizePlan(plan) {
  if (!plan) return "pro";
  const p = plan.toLowerCase();
  if (p === "premium") return "premium";
  if (p === "vip") return "vip";
  if (p === "platinum") return "platinum";
  return "pro";
}

function isValidMime(mime) {
  return ["image/jpeg", "image/png", "image/webp"].includes(mime);
}

function getPlanCapabilities(plan) {
  const normalizedPlan = String(plan || "pro").toLowerCase();

  const plans = {
    pro: {
      max_staff: 2,
      max_services: 10,
      max_branches: 1,
      max_campaign_emails_per_send: 50,
    },
    premium: {
      max_staff: 5,
      max_services: 25,
      max_branches: 2,
      max_campaign_emails_per_send: 150,
    },
    vip: {
      max_staff: 10,
      max_services: 50,
      max_branches: 3,
      max_campaign_emails_per_send: 400,
    },
    platinum: {
      max_staff: 20,
      max_services: 100,
      max_branches: 10,
      max_campaign_emails_per_send: 1000,
    },
  };

  if (normalizedPlan === "starter") {
    return plans.pro;
  }

  return plans[normalizedPlan] || plans.pro;
}

const PLAN_PRICES = {
  pro: 24990,
  premium: 44990,
  vip: 79990,
  platinum: 229990,
};

const PLAN_ORDER = {
  pro: 1,
  premium: 2,
  vip: 3,
  platinum: 4,
};

const BILLING_CYCLE_DAYS = 30;

function normalizePlanSlug(plan) {
  const normalized = String(plan || "pro").toLowerCase();
  if (normalized === "starter") return "pro";
  if (PLAN_ORDER[normalized]) return normalized;
  return "pro";
}

function getPlanPrice(plan) {
  return PLAN_PRICES[normalizePlanSlug(plan)] || PLAN_PRICES.pro;
}

function getPlanLevel(plan) {
  return PLAN_ORDER[normalizePlanSlug(plan)] || PLAN_ORDER.pro;
}

function isUpgradePlanChange(currentPlan, newPlan) {
  return getPlanLevel(newPlan) > getPlanLevel(currentPlan);
}

function isDowngradePlanChange(currentPlan, newPlan) {
  return getPlanLevel(newPlan) < getPlanLevel(currentPlan);
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function addOneMonth(date) {
  const d = new Date(date);
  const day = d.getDate();

  d.setMonth(d.getMonth() + 1);

  // Si el mes siguiente no tiene ese día (ej: 31 → febrero)
  if (d.getDate() < day) {
    d.setDate(0); // último día del mes anterior
  }

  return d;
}

function ensureBillingDates(row) {
  const now = new Date();

  const billingStart = row?.billing_cycle_start
    ? new Date(row.billing_cycle_start)
    : now;

const billingEnd = row?.billing_cycle_end
  ? new Date(row.billing_cycle_end)
  : addOneMonth(billingStart);

  return {
    billingStart,
    billingEnd,
  };
}

function calculateProration({
  currentPlan,
  newPlan,
  billingEnd,
  now = new Date(),
}) {
  const currentPrice = getPlanPrice(currentPlan);
  const newPrice = getPlanPrice(newPlan);

  const msRemaining = Math.max(0, billingEnd.getTime() - now.getTime());
  const daysRemainingExact = msRemaining / (1000 * 60 * 60 * 24);

  const currentDaily = currentPrice / BILLING_CYCLE_DAYS;
  const newDaily = newPrice / BILLING_CYCLE_DAYS;

  const credit = Math.round(currentDaily * daysRemainingExact);
  const charge = Math.round(newDaily * daysRemainingExact);
  const amountToday = Math.max(0, charge - credit);

  return {
    days_remaining: Number(daysRemainingExact.toFixed(2)),
    current_price: currentPrice,
    new_price: newPrice,
    credit,
    charge,
    amount_today: amountToday,
  };
}

async function getTenantSubscriptionRow(tenant_id) {
  const { data, error } = await supabase
    .from("tenants")
    .select(`
      id,
      plan_slug,
      plan,
      billing_cycle_start,
      billing_cycle_end,
      scheduled_plan_slug,
      scheduled_change_at,
      pending_change_type,
      proration_credit,
      proration_charge
    `)
    .eq("id", tenant_id)
    .single();

  if (error) throw error;

  const currentPlan = normalizePlanSlug(data?.plan_slug || data?.plan || "pro");
  const { billingStart, billingEnd } = ensureBillingDates(data);

  return {
    ...data,
    currentPlan,
    billingStart,
    billingEnd,
  };
}

async function getStaffCount(tenant_id) {
  const { count, error } = await supabase
    .from("staff")
    .select("*", { count: "exact", head: true })
    .eq("tenant_id", tenant_id);

  if (error) throw error;

  return count || 0;
}

async function getPlan(tenant_id) {
  const { data, error } = await supabase
    .from("tenants")
    .select("plan_slug, plan")
    .eq("id", tenant_id)
    .single();

  if (error) throw error;

  return normalizePlanSlug(data?.plan_slug || data?.plan || "pro");
}

async function getServicesCount(tenant_id) {
  const { count, error } = await supabase
    .from("services")
    .select("*", { count: "exact", head: true })
    .eq("tenant_id", tenant_id);

  if (error) throw error;

  return count || 0;
}

async function getBranchesCount(tenant_id) {
  const { count, error } = await supabase
    .from("branches")
    .select("*", { count: "exact", head: true })
    .eq("tenant_id", tenant_id)
    .eq("is_active", true);

  if (error) throw error;

  return count || 0;
}

/* ======================================================
   ✅ CORS (ROBUSTO)
====================================================== */
const ALLOWED_ORIGINS = new Set([
  "https://app.orbyx.cl",
  "https://orbyx-dashboard.vercel.app",
  "https://www.orbyx.cl",
  "https://orbyx.cl",
  "https://orbyx-web.vercel.app",
]);

const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);

    if (ALLOWED_ORIGINS.has(origin)) return cb(null, true);

    if (/^https:\/\/.*\.vercel\.app$/.test(origin)) return cb(null, true);

    return cb(new Error("Not allowed by CORS: " + origin));
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: false,
};

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));
app.use(express.json());

const PORT = process.env.PORT || 3000;

// 🔐 Credenciales OAuth
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;

const SCOPES = ["https://www.googleapis.com/auth/calendar.events"];

// ✅ Compatibilidad
const CLIENTE_FIJO = "cliente_demo";
const CAL_FIJO = "principal";

const oAuth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI
);

async function getMainBranchByTenantId(tenant_id) {
  const { data, error } = await supabase
    .from("branches")
    .select("id, tenant_id, name, slug, is_active, created_at")
    .eq("tenant_id", tenant_id)
    .eq("is_active", true)
    .order("created_at", { ascending: true })
    .limit(1)
    .single();

  if (error || !data) {
    throw new Error(`No se encontró sucursal activa para tenant_id=${tenant_id}`);
  }

  return data;
}

async function getBranchById(branch_id) {
  const { data, error } = await supabase
    .from("branches")
    .select("id, tenant_id, name, slug, address, phone, is_active, created_at")
    .eq("id", branch_id)
    .single();

  if (error || !data) {
    throw new Error(`Sucursal no encontrada para branch_id=${branch_id}`);
  }

  return data;
}

async function resolveBranchId({ tenant_id, branch_id }) {
  if (branch_id) {
    const branch = await getBranchById(branch_id);

    if (branch.tenant_id !== tenant_id) {
      throw new Error("La sucursal no pertenece al tenant enviado");
    }

    if (!branch.is_active) {
      throw new Error("La sucursal está inactiva");
    }

    return branch.id;
  }

  const mainBranch = await getMainBranchByTenantId(tenant_id);
  return mainBranch.id;
}

console.log("✅ Iniciado sin token.json. Tokens se leerán desde Supabase.");
console.log("🔥 VERSION: SAAS_TOKEN_BY_CALENDAR_ID + OAUTH REDIRECT TO FRONTEND");

/* ======================================================
   ✅ HELPERS GENERALES
====================================================== */
function parseDateToWeekday(dateStr) {
  const [year, month, day] = String(dateStr).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0)).getUTCDay();
}

function timeToMinutes(value) {
  if (!value) return null;
  const [h, m] = String(value).slice(0, 5).split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

function isoToMinutesInDate(iso, dateStr) {
  if (!iso || !dateStr) return null;

  const d = new Date(iso);

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Santiago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);

  const map = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );

  const localDate = `${map.year}-${map.month}-${map.day}`;

  if (localDate !== dateStr) return null;

  return Number(map.hour) * 60 + Number(map.minute);
}
function subtractRange(windows, blockStart, blockEnd) {
  const result = [];

  for (const window of windows) {
    const start = window.start;
    const end = window.end;

    if (blockEnd <= start || blockStart >= end) {
      result.push(window);
      continue;
    }

    if (blockStart > start) {
      result.push({ start, end: blockStart });
    }

    if (blockEnd < end) {
      result.push({ start: blockEnd, end });
    }
  }

  return result.filter((w) => w.end > w.start);
}

function intersectWindows(a, b) {
  const result = [];

  for (const wa of a || []) {
    for (const wb of b || []) {
      const start = Math.max(wa.start, wb.start);
      const end = Math.min(wa.end, wb.end);

      if (end > start) {
        result.push({ start, end });
      }
    }
  }

  return result.sort((x, y) => x.start - y.start);
}



function santiagoLocalToUtcIso(date, hour, minute) {
  const [year, month, day] = String(date).split("-").map(Number);

  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Santiago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(utcGuess);

  const map = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );

  const zonedAsUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second)
  );

  const desiredAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offset = zonedAsUtc - utcGuess.getTime();

  return new Date(desiredAsUtc - offset).toISOString();
}


function buildSlotsFromWindows(windows, date, slotMinutes) {
  const slots = [];

  for (const window of windows || []) {
    let cursor = window.start;

    while (cursor + slotMinutes <= window.end) {
      const startHour = String(Math.floor(cursor / 60)).padStart(2, "0");
      const startMinute = String(cursor % 60).padStart(2, "0");

      const endCursor = cursor + slotMinutes;
      const endHour = String(Math.floor(endCursor / 60)).padStart(2, "0");
      const endMinute = String(endCursor % 60).padStart(2, "0");

slots.push({
  slot_start: santiagoLocalToUtcIso(
    date,
    Number(startHour),
    Number(startMinute)
  ),
  slot_end: santiagoLocalToUtcIso(
    date,
    Number(endHour),
    Number(endMinute)
  ),
});

      cursor += slotMinutes;
    }
  }

  return slots;
}

async function getStaffAvailabilityWindows({
  tenant_id,
  branch_id,
  staff_id,
  date,
}) {
  const weekday = parseDateToWeekday(date);

  const { data: staffRow, error: staffError } = await supabase
    .from("staff")
    .select("id, tenant_id, branch_id, use_business_hours, is_active")
    .eq("tenant_id", tenant_id)
    .eq("branch_id", branch_id)
    .eq("id", staff_id)
    .single();

  if (staffError) throw staffError;

  if (!staffRow || !staffRow.is_active) {
    return [];
  }

  let windows = [];

  if (staffRow.use_business_hours) {
    const businessWindows = await getBusinessAvailabilityWindows({
      tenant_id,
      branch_id,
      date,
    });

    windows = businessWindows;
  } else {
    const { data: weeklyRows, error: weeklyError } = await supabase
      .from("staff_hours")
      .select("*")
      .eq("tenant_id", tenant_id)
      .eq("branch_id", branch_id)
      .eq("staff_id", staff_id)
      .eq("day_of_week", weekday);

    if (weeklyError) throw weeklyError;

    const validRows = (weeklyRows || []).filter(
  (row) => row.enabled && row.start_time && row.end_time
);

windows = validRows
  .map((row) => {
    const start = timeToMinutes(row.start_time);
    const end = timeToMinutes(row.end_time);

    if (start !== null && end !== null && end > start) {
      return { start, end };
    }

    return null;
  })
  .filter(Boolean);
  }

  const { data: specialRows, error: specialError } = await supabase
    .from("staff_special_dates")
    .select("*")
    .eq("tenant_id", tenant_id)
    .eq("branch_id", branch_id)
    .eq("staff_id", staff_id)
    .eq("date", date)
    .order("created_at", { ascending: true });

  if (specialError) throw specialError;

  const specialDates = specialRows || [];

  const fullDayClosed = specialDates.some(
    (row) => row.is_closed && !row.start_time && !row.end_time
  );

  if (fullDayClosed) {
    return [];
  }

  const openWindows = specialDates
    .filter((row) => !row.is_closed && row.start_time && row.end_time)
    .map((row) => ({
      start: timeToMinutes(row.start_time),
      end: timeToMinutes(row.end_time),
    }))
    .filter(
      (row) => row.start !== null && row.end !== null && row.end > row.start
    );

  if (openWindows.length > 0) {
    windows = openWindows;
  }

  const partialClosedWindows = specialDates
    .filter((row) => row.is_closed && row.start_time && row.end_time)
    .map((row) => ({
      start: timeToMinutes(row.start_time),
      end: timeToMinutes(row.end_time),
    }))
    .filter(
      (row) => row.start !== null && row.end !== null && row.end > row.start
    );

  for (const blocked of partialClosedWindows) {
    windows = subtractRange(windows, blocked.start, blocked.end);
  }

  return windows.sort((a, b) => a.start - b.start);
}

async function subtractAppointmentsFromWindows({
  tenant_id,
  branch_id,
  staff_id,
  date,
  windows,
}) {
  const start = `${date}T00:00:00`;
  const end = `${date}T23:59:59`;

  let query = supabase
    .from("appointments")
    .select("id, start_at, end_at, staff_id, status")
    .eq("tenant_id", tenant_id)
    .eq("branch_id", branch_id)
    .eq("status", "booked")
    .gte("start_at", start)
    .lte("start_at", end)
    .order("start_at", { ascending: true });

  if (staff_id) {
    query = query.eq("staff_id", staff_id);
  }

  const { data: appointments, error } = await query;

  if (error) throw error;

  let result = [...(windows || [])];

  for (const appt of appointments || []) {
    const apptStart = isoToMinutesInDate(appt.start_at, date);
    const apptEnd = isoToMinutesInDate(appt.end_at, date);

    if (apptStart === null || apptEnd === null) continue;

    result = subtractRange(result, apptStart, apptEnd);
  }

  return result;
}

async function getServiceStaffIds({ tenant_id, branch_id, service_id }) {
  const { data, error } = await supabase
    .from("staff_services")
    .select("staff_id")
    .eq("tenant_id", tenant_id)
    .eq("branch_id", branch_id)
    .eq("service_id", service_id);

  if (error) throw error;

  return [...new Set((data || []).map((row) => row.staff_id).filter(Boolean))];
}

async function getBusinessAvailabilityWindows({ tenant_id, branch_id, date }) {
  const weekday = parseDateToWeekday(date);

  const { data: weeklyRows, error: weeklyError } = await supabase
    .from("business_hours")
    .select("*")
    .eq("tenant_id", tenant_id)
    .eq("branch_id", branch_id)
    .eq("day_of_week", weekday);

  if (weeklyError) throw weeklyError;

  const weekly = weeklyRows?.[0] || null;

  let windows = [];

  if (weekly?.enabled && weekly.start_time && weekly.end_time) {
    const weeklyStart = timeToMinutes(weekly.start_time);
    const weeklyEnd = timeToMinutes(weekly.end_time);

    if (
      weeklyStart !== null &&
      weeklyEnd !== null &&
      weeklyEnd > weeklyStart
    ) {
      windows = [{ start: weeklyStart, end: weeklyEnd }];
    }
  }

  const { data: specialRows, error: specialError } = await supabase
    .from("business_special_dates")
    .select("*")
    .eq("tenant_id", tenant_id)
    .eq("branch_id", branch_id)
    .eq("date", date)
    .order("created_at", { ascending: true });

  if (specialError) throw specialError;

  const specialDates = specialRows || [];

  const fullDayClosed = specialDates.some(
    (row) => row.is_closed && !row.start_time && !row.end_time
  );

  if (fullDayClosed) {
    return [];
  }

  const openWindows = specialDates
    .filter((row) => !row.is_closed && row.start_time && row.end_time)
    .map((row) => ({
      start: timeToMinutes(row.start_time),
      end: timeToMinutes(row.end_time),
    }))
    .filter(
      (row) => row.start !== null && row.end !== null && row.end > row.start
    );

  if (openWindows.length > 0) {
    windows = openWindows;
  }

  const partialClosedWindows = specialDates
    .filter((row) => row.is_closed && row.start_time && row.end_time)
    .map((row) => ({
      start: timeToMinutes(row.start_time),
      end: timeToMinutes(row.end_time),
    }))
    .filter(
      (row) => row.start !== null && row.end !== null && row.end > row.start
    );

  for (const blocked of partialClosedWindows) {
    windows = subtractRange(windows, blocked.start, blocked.end);
  }

  return windows.sort((a, b) => a.start - b.start);
}

function filterSlotsByWindows(slots, windows, date) {
  if (!Array.isArray(slots) || slots.length === 0) return [];
  if (!Array.isArray(windows) || windows.length === 0) return [];

  return slots.filter((slot) => {
    const startMinutes = isoToMinutesInDate(slot.slot_start, date);
    const endMinutes = isoToMinutesInDate(slot.slot_end, date);

    if (startMinutes === null || endMinutes === null) return false;

    return windows.some(
      (window) => startMinutes >= window.start && endMinutes <= window.end
    );
  });
}

function filterSlotsForServiceDuration(slots, totalMinutes, baseSlotMinutes) {
  if (!Array.isArray(slots) || slots.length === 0) return [];
  if (!totalMinutes || totalMinutes <= 0) return slots;

  const neededBlocks = Math.ceil(totalMinutes / baseSlotMinutes);

  if (neededBlocks <= 1) return slots;

  return slots.filter((slot, index) => {
    for (let i = 1; i < neededBlocks; i++) {
      const current = slots[index + i - 1];
      const next = slots[index + i];

      if (!current || !next) return false;

      const currentEnd = new Date(current.slot_end).toISOString();
      const nextStart = new Date(next.slot_start).toISOString();

      if (currentEnd !== nextStart) return false;
    }

    return true;
  });
}


function filterPastSlots(slots, minNoticeMinutes = 0) {
  if (!Array.isArray(slots) || slots.length === 0) return [];

  const now = new Date();
  const limit = new Date(now.getTime() + minNoticeMinutes * 60 * 1000);

  return slots.filter((slot) => {
    const start = new Date(slot.slot_start);
    return start.getTime() >= limit.getTime();
  });
}




async function recalculateCustomerStats(customerId) {
  if (!customerId) return null;

  const { data: customer, error: customerError } = await supabase
    .from("customers")
    .select("id, tenant_id")
    .eq("id", customerId)
    .single();

  if (customerError || !customer) return null;

  const { data: appointments, error: appointmentsError } = await supabase
    .from("appointments")
    .select("id, start_at, status")
    .eq("tenant_id", customer.tenant_id)
    .eq("customer_id", customer.id)
    .order("start_at", { ascending: false });

  if (appointmentsError) throw appointmentsError;

  const validAppointments = (appointments || []).filter((appt) => {
    const status = String(appt.status || "").toLowerCase();
    return status !== "canceled" && status !== "cancelled";
  });

  const lastValidAppointment = validAppointments[0] || null;

  const { data: updatedCustomer, error: updateError } = await supabase
    .from("customers")
    .update({
      total_visits: validAppointments.length,
      last_visit_at: lastValidAppointment?.start_at || null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", customer.id)
    .select("*")
    .single();

  if (updateError) throw updateError;

  return updatedCustomer;
}

async function upsertCustomerFromAppointment({
  tenant_id,
  customer_name,
  customer_email,
  customer_phone,
  start_at,
}) {
  const normalizedName = String(customer_name || "").trim();
  const normalizedNameKey = normalizedName.toLowerCase();

  const normalizedEmail = customer_email
    ? String(customer_email).trim().toLowerCase()
    : null;

  const normalizedPhone = customer_phone
    ? String(customer_phone).trim()
    : null;

  const { data: candidateCustomers, error: candidateError } = await supabase
    .from("customers")
    .select("*")
    .eq("tenant_id", tenant_id);

  if (candidateError) throw candidateError;

  const customers = candidateCustomers || [];

  const existingByEmail =
    normalizedEmail
      ? customers.find(
          (customer) =>
            customer.email &&
            String(customer.email).trim().toLowerCase() === normalizedEmail
        ) || null
      : null;

  const existingByPhone =
    !existingByEmail && normalizedPhone
      ? customers.find(
          (customer) =>
            customer.phone &&
            String(customer.phone).trim() === normalizedPhone
        ) || null
      : null;

  const existingByName =
    !existingByEmail && !existingByPhone && normalizedNameKey
      ? customers.find((customer) => {
          const customerNameKey = String(customer.name || "")
            .trim()
            .toLowerCase();

          return customerNameKey === normalizedNameKey;
        }) || null
      : null;

  const existingCustomer =
    existingByEmail || existingByPhone || existingByName || null;

  if (existingCustomer) {
    const { data: updatedCustomer, error: updateError } = await supabase
      .from("customers")
      .update({
        name: normalizedName || existingCustomer.name || "",
        email: normalizedEmail || existingCustomer.email || null,
        phone: normalizedPhone || existingCustomer.phone || null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existingCustomer.id)
      .select("*")
      .single();

    if (updateError) throw updateError;

    return updatedCustomer;
  }

  const { data: createdCustomer, error: insertError } = await supabase
    .from("customers")
    .insert({
      tenant_id,
      name: normalizedName,
      email: normalizedEmail,
      phone: normalizedPhone,
      last_visit_at: start_at ? new Date(start_at).toISOString() : null,
      total_visits: 0,
    })
    .select("*")
    .single();

  if (insertError) throw insertError;

  return createdCustomer;
}




async function resolvePetFromAppointment({
  tenant_id,
  customer_id,
  customer_data,
}) {
  const petId = String(customer_data?.pet_id || "").trim();
  const petName = String(customer_data?.pet_name || "").trim();
  const petSpeciesRaw = String(customer_data?.pet_species || "").trim().toLowerCase();

  if (!customer_id) return null;

  if (petId) {
    const { data: existingPet, error: petError } = await supabase
      .from("pets")
      .select("*")
      .eq("id", petId)
      .eq("tenant_id", tenant_id)
      .eq("customer_id", customer_id)
      .single();

    if (petError || !existingPet) {
      throw new Error("La mascota seleccionada no pertenece a este cliente.");
    }

    return existingPet;
  }

  if (!petName) {
    return null;
  }

  let normalizedSpeciesBase = "otro";
  let speciesCustom = null;

  if (petSpeciesRaw === "perro" || petSpeciesRaw === "gato") {
    normalizedSpeciesBase = petSpeciesRaw;
  } else if (petSpeciesRaw) {
    normalizedSpeciesBase = "otro";
    speciesCustom = petSpeciesRaw;
  }

  const { data: createdPet, error: createPetError } = await supabase
    .from("pets")
    .insert({
      tenant_id,
      customer_id,
      name: petName,
      species_base: normalizedSpeciesBase,
      species_custom: speciesCustom,
      updated_at: new Date().toISOString(),
    })
    .select("*")
    .single();

  if (createPetError) {
    throw createPetError;
  }

  return createdPet;
}

async function sendCampaignEmail({
  to,
  subject,
  html,
  text,
}) {
  const resendApiKey = process.env.RESEND_API_KEY;
  const fromEmail =
    process.env.RESEND_FROM_EMAIL ||
    process.env.FROM_EMAIL ||
    "Orbyx <onboarding@resend.dev>";

  if (!resendApiKey) {
    throw new Error("Falta RESEND_API_KEY en variables de entorno");
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: fromEmail,
      to: [to],
      subject,
      html,
      text,
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data?.message || "Error enviando email de campaña");
  }

  return data;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sanitizeRichHtml(value) {
  let html = String(value || "");

  html = html.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "");
  html = html.replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, "");
  html = html.replace(/\son\w+="[^"]*"/gi, "");
  html = html.replace(/\son\w+='[^']*'/gi, "");
  html = html.replace(/javascript:/gi, "");

  return html.trim();
}

function htmlToPlainText(value) {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<li>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildCampaignEmailTemplate({
  businessName,
  subject,
  message,
  messageHtml = "",
  brandColor = "#0f766e",
  heroImageUrl = "",
  heroImageHeight = 260,
  heroImagePositionY = 50,
  heroImageFit = "cover",
  ctaText = "Agendar visita",
  ctaUrl = "",
  showCta = true,
  footerNote = "",
  footerNoteHtml = "",
}) {

  const safeBusinessName = escapeHtml(businessName || "Orbyx");
  const safeSubject = escapeHtml(subject || "Campaña");
  const safeMessage = escapeHtml(message || "").replace(/\n/g, "<br />");
  const safeBrandColor = String(brandColor || "#0f766e").trim();
  const safeHeroImageUrl = String(heroImageUrl || "").trim();
  const safeCtaText = escapeHtml(ctaText || "Agendar visita");
  const safeCtaUrl = String(ctaUrl || "").trim();
  const safeFooterNote = escapeHtml(
    footerNote || `Este correo fue enviado por ${businessName || "Orbyx"} a través de Orbyx.`
  ).replace(/\n/g, "<br />");

  const heroBlock = safeHeroImageUrl
    ? `
      <tr>
        <td style="background:#e2e8f0;">
          <img
            src="${safeHeroImageUrl}"
            alt="Banner campaña"
            style="display:block;width:100%;height:auto;max-height:260px;object-fit:cover;border:0;"
          />
        </td>
      </tr>
    `
    : "";

  const ctaBlock =
    showCta && safeCtaUrl
      ? `
        <div style="margin-top:28px;">
          <a
            href="${safeCtaUrl}"
            target="_blank"
            rel="noreferrer"
            style="
              display:inline-block;
              padding:14px 22px;
              border-radius:16px;
              background:${safeBrandColor};
              color:#ffffff;
              font-size:14px;
              font-weight:700;
              text-decoration:none;
            "
          >
            ${safeCtaText}
          </a>
        </div>
      `
      : "";

  const html = `
  <div style="margin:0;padding:0;background:#f8fafc;font-family:Arial,Helvetica,sans-serif;color:#0f172a;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f8fafc;padding:32px 16px;">
      <tr>
        <td align="center">
          <table
            role="presentation"
            width="100%"
            cellspacing="0"
            cellpadding="0"
            style="
              max-width:680px;
              background:#ffffff;
              border:1px solid #e2e8f0;
              border-radius:28px;
              overflow:hidden;
            "
          >
            <tr>
              <td
                style="
                  padding:32px 32px 24px 32px;
                  background:${safeBrandColor};
                  color:#ffffff;
                "
              >
                <div style="font-size:11px;letter-spacing:0.22em;text-transform:uppercase;opacity:0.78;font-weight:700;">
                  ${safeBusinessName}
                </div>

                <h1 style="margin:12px 0 0 0;font-size:28px;line-height:1.2;font-weight:700;">
                  ${safeSubject}
                </h1>
              </td>
            </tr>

            ${heroBlock}

            <tr>
              <td style="padding:32px;">
                <div
                  style="
                    border:1px solid #e2e8f0;
                    border-radius:20px;
                    background:#f8fafc;
                    padding:24px;
                    font-size:16px;
                    line-height:1.8;
                    color:#334155;
                  "
                >
                  <div style="font-weight:700;color:#0f172a;">
                    Hola {{nombre}},
                  </div>

                  <div style="margin-top:14px;">
                    ${safeMessage}
                  </div>

                  ${ctaBlock}
                </div>

                <div
                  style="
                    margin-top:24px;
                    padding-top:20px;
                    border-top:1px solid #e2e8f0;
                    font-size:13px;
                    line-height:1.7;
                    color:#64748b;
                  "
                >
                  ${safeFooterNote}
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </div>
  `;

  const textParts = [
    businessName || "Orbyx",
    "",
    subject || "Campaña",
    "",
    String(message || ""),
    "",
    showCta && safeCtaUrl ? `${ctaText || "Agendar visita"}: ${safeCtaUrl}` : "",
    "",
    footerNote || `Este correo fue enviado por ${businessName || "Orbyx"} a través de Orbyx.`,
  ].filter(Boolean);

  return {
    html,
    text: textParts.join("\n"),
  };
}

/* ======================================================
   ✅ Helper: obtener Google Calendar desde calendar_tokens usando calendar_id
====================================================== */
async function getGoogleCalendarClientByCalendarId(calendar_id) {
  const { data: tokenRow, error: tokErr } = await supabase
    .from("calendar_tokens")
    .select("refresh_token, google_calendar_id")
    .eq("calendar_id", calendar_id)
    .maybeSingle();

if (!tokenRow) {
  throw new Error("Este negocio no tiene Google Calendar conectado.");
}

  if (tokErr) throw tokErr;

  if (!tokenRow?.refresh_token) {
    throw new Error(
      "⚠️ Este calendar_id no tiene token Google. Debes autorizarlo primero en /auth?calendar_id=..."
    );
  }

  oAuth2Client.setCredentials({ refresh_token: tokenRow.refresh_token });

  const calendar = google.calendar({ version: "v3", auth: oAuth2Client });
  const googleCalendarId = tokenRow.google_calendar_id || "primary";

  return { calendar, googleCalendarId };
}

/* ======================================================
   ✅ Helper (fallback): buscar token por CLIENTE_FIJO/CAL_FIJO
====================================================== */
async function getGoogleCalendarClientFixed() {
  const { data: tokenRow, error: tokErr } = await supabase
    .from("calendar_tokens")
    .select("*")
    .eq("client_id", CLIENTE_FIJO)
    .eq("calendar_name", CAL_FIJO)
    .single();

  if (tokErr) throw tokErr;

  if (!tokenRow?.refresh_token) {
    throw new Error("⚠️ No hay refresh_token en Supabase. Entra a /auth primero.");
  }

  oAuth2Client.setCredentials({ refresh_token: tokenRow.refresh_token });

  const calendar = google.calendar({ version: "v3", auth: oAuth2Client });
  const googleCalendarId = tokenRow.google_calendar_id || "primary";

  return { calendar, googleCalendarId };
}

/* ======================================================
   🔹 ENDPOINT: /auth
====================================================== */
app.get("/auth", async (req, res) => {
  try {
    const { calendar_id } = req.query;

    const stateObj = calendar_id
      ? { calendar_id: String(calendar_id) }
      : { calendar_id: null, fixed: true };

    const state = Buffer.from(JSON.stringify(stateObj)).toString("base64url");

    const url = oAuth2Client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: SCOPES,
      state,
    });

    res.send(`
<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>Conectar Google Calendar - Orbyx</title>

<style>
body{
  margin:0;
  font-family: system-ui, -apple-system, Segoe UI, Roboto;
  background:#f1f5f9;
  display:flex;
  align-items:center;
  justify-content:center;
  height:100vh;
}

.card{
  background:white;
  padding:40px;
  border-radius:16px;
  box-shadow:0 10px 30px rgba(0,0,0,0.1);
  width:420px;
  text-align:center;
}

h1{
  margin-bottom:10px;
  font-size:22px;
}

p{
  color:#64748b;
  font-size:14px;
  margin-bottom:25px;
}

.btn{
  display:inline-block;
  background:#111827;
  color:white;
  padding:12px 18px;
  border-radius:10px;
  text-decoration:none;
  font-weight:500;
}

.btn:hover{
  background:#374151;
}

.small{
  margin-top:20px;
  font-size:12px;
  color:#94a3b8;
}
</style>
</head>

<body>

<div class="card">

<h1>Conectar Google Calendar</h1>

<p>
Orbyx necesita acceso a tu Google Calendar para crear automáticamente
las reservas cuando un cliente agenda una cita.
</p>

<a class="btn" href="${url}">
Autorizar con Google
</a>

<div class="small">
Modo: ${calendar_id ? "SaaS" : "Compatibilidad"}
</div>

</div>

</body>
</html>
`);
  } catch (e) {
    res.status(500).send("Error en /auth: " + e.message);
  }
});

/* ======================================================
   🔹 ENDPOINT: /oauth2callback
====================================================== */
app.get("/oauth2callback", async (req, res) => {
  try {
    const code = req.query.code;
    const stateRaw = req.query.state;

    let state = {};
    try {
      if (stateRaw) {
        state = JSON.parse(
          Buffer.from(String(stateRaw), "base64url").toString("utf8")
        );
      }
    } catch (_) {
      state = {};
    }

    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);

    if (!tokens.refresh_token) {
      return res
        .status(400)
        .send(
          "⚠️ No vino refresh_token. Revoca acceso a la app en tu cuenta Google y reautoriza en /auth."
        );
    }

    // ✅ SaaS: guardar por calendar_id
    if (state?.calendar_id) {
      const calendar_id = state.calendar_id;

const { data: cal, error: calErr } = await supabase
  .from("calendars")
  .select("tenant_id")
  .eq("id", calendar_id)
  .single();

      if (calErr || !cal) {
        return res
          .status(404)
          .send("Calendario no encontrado en tu tabla calendars para calendar_id=" + calendar_id);
      }

      const { error } = await supabase.from("calendar_tokens").upsert(
        {
          tenant_id: cal.tenant_id,
          calendar_id,
          google_calendar_id: "primary",
          refresh_token: tokens.refresh_token,
          access_token: tokens.access_token ?? null,
          token_type: tokens.token_type ?? null,
          scope: tokens.scope ?? null,
          expiry_date: tokens.expiry_date ?? null,
        },
        { onConflict: "calendar_id" }
      );

      if (error) throw error;

      const { data: tenantData, error: tenantErr } = await supabase
        .from("tenants")
        .select("slug")
        .eq("id", cal.tenant_id)
        .single();

      if (tenantErr || !tenantData?.slug) {
        return res
          .status(500)
          .send("No se pudo obtener el slug del negocio después de conectar Google Calendar.");
      }

      const frontendUrl = "https://www.orbyx.cl";
      return res.redirect(
        `${frontendUrl}/dashboard/${tenantData.slug}?google_connected=1`
      );
    }

    // ✅ Compatibilidad: modo fijo
    const { error } = await supabase.from("calendar_tokens").upsert(
      {
        client_id: CLIENTE_FIJO,
        calendar_name: CAL_FIJO,
        google_calendar_id: "primary",
        refresh_token: tokens.refresh_token,
        access_token: tokens.access_token ?? null,
        token_type: tokens.token_type ?? null,
        scope: tokens.scope ?? null,
        expiry_date: tokens.expiry_date ?? null,
      },
      { onConflict: "client_id,calendar_name" }
    );

    if (error) throw error;

    res.send("✅ Autorizado y guardado en Supabase (modo fijo). Ahora entra a /test-event");
  } catch (error) {
    console.error(error);
    res.status(500).send("Error en OAuth callback: " + error.message);
  }
});

/* ======================================================
   🔹 ENDPOINT: /test-event
====================================================== */
app.get("/test-event", async (req, res) => {
  try {
    const { calendar_id } = req.query;

    const { calendar, googleCalendarId } = calendar_id
      ? await getGoogleCalendarClientByCalendarId(calendar_id)
      : await getGoogleCalendarClientFixed();

    const start = new Date(Date.now() + 5 * 60 * 1000);
    const end = new Date(start.getTime() + 30 * 60 * 1000);

    const event = {
      summary: "Prueba Proyecto Independizar (Supabase)",
      description: calendar_id
        ? `Evento de prueba (SaaS) calendar_id=${calendar_id}`
        : "Evento de prueba (modo fijo)",
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() },
    };

    const response = await calendar.events.insert({
      calendarId: googleCalendarId,
      requestBody: event,
    });

    res.send(`✅ Evento creado: <a href="${response.data.htmlLink}" target="_blank">Ver evento</a>`);
  } catch (error) {
    console.error(error);
    res.status(500).send("Error creando evento: " + error.message);
  }
});

/* ======================================================
   ✅ GET /business-hours
====================================================== */
app.get("/business-hours", async (req, res) => {
  try {
    const { tenant_id, branch_id } = req.query;

    if (!tenant_id) {
      return res.status(400).json({ error: "tenant_id es obligatorio" });
    }

    if (!branch_id) {
      return res.status(400).json({ error: "branch_id es obligatorio" });
    }

    const { data, error } = await supabase
      .from("business_hours")
      .select("*")
      .eq("tenant_id", tenant_id)
      .eq("branch_id", branch_id)
      .order("day_of_week", { ascending: true });

    if (error) throw error;

    return res.json({ hours: data || [] });
  } catch (err) {
    console.error("GET /business-hours error:", err.message);
    return res.status(500).json({ error: "Error obteniendo horarios" });
  }
});

/* ======================================================
   ✅ PUT /business-hours
====================================================== */
app.put("/business-hours", async (req, res) => {
  try {
    const { tenant_id, branch_id, hours } = req.body;

    if (!tenant_id) {
      return res.status(400).json({ error: "tenant_id es obligatorio" });
    }

    if (!branch_id) {
      return res.status(400).json({ error: "branch_id es obligatorio" });
    }

    if (!Array.isArray(hours)) {
      return res.status(400).json({ error: "hours debe ser un arreglo" });
    }

    const payload = hours.map((item) => ({
      tenant_id,
      branch_id,
      day_of_week: Number(item.day_of_week),
      enabled: Boolean(item.enabled),
      start_time: item.start_time || "09:00:00",
      end_time: item.end_time || "18:00:00",
      updated_at: new Date().toISOString(),
    }));

    const { data, error } = await supabase
      .from("business_hours")
      .upsert(payload, { onConflict: "tenant_id,branch_id,day_of_week" })
      .select("*");

    if (error) throw error;

    return res.json({
      ok: true,
      message: "Horarios guardados correctamente",
      hours: data || [],
    });
  } catch (err) {
    console.error("PUT /business-hours error:", err.message);
    return res.status(500).json({
      error: err.message || "Error guardando horarios",
    });
  }
});

/* ======================================================
   ✅ GET /business-special-dates
====================================================== */
app.get("/business-special-dates", async (req, res) => {
  try {
    const { tenant_id, branch_id } = req.query;

    if (!tenant_id) {
      return res.status(400).json({ error: "tenant_id es obligatorio" });
    }

    if (!branch_id) {
      return res.status(400).json({ error: "branch_id es obligatorio" });
    }

    const { data, error } = await supabase
      .from("business_special_dates")
      .select("*")
      .eq("tenant_id", tenant_id)
      .eq("branch_id", branch_id)
      .order("date", { ascending: true })
      .order("created_at", { ascending: true });

    if (error) throw error;

    return res.json({ special_dates: data || [] });
  } catch (err) {
    console.error("GET /business-special-dates error:", err.message);
    return res.status(500).json({ error: "Error obteniendo fechas especiales" });
  }
});

/* ======================================================
   ✅ POST /business-special-dates
====================================================== */
app.post("/business-special-dates", async (req, res) => {
  try {
    const {
      tenant_id,
      branch_id,
      date,
      label,
      is_closed,
      start_time,
      end_time,
    } = req.body;

    if (!tenant_id) {
      return res.status(400).json({ error: "tenant_id es obligatorio" });
    }

    if (!branch_id) {
      return res.status(400).json({ error: "branch_id es obligatorio" });
    }

    if (!date) {
      return res.status(400).json({ error: "date es obligatorio" });
    }

    const payload = {
      tenant_id,
      branch_id,
      date,
      label: label || null,
      is_closed: !!is_closed,
      start_time: start_time || null,
      end_time: end_time || null,
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from("business_special_dates")
      .insert(payload)
      .select("*")
      .single();

    if (error) throw error;

    return res.json({
      ok: true,
      message: "Fecha especial creada correctamente",
      item: data,
    });
  } catch (err) {
    console.error("POST /business-special-dates error:", err.message);
    return res.status(500).json({
      error: err.message || "Error creando fecha especial",
    });
  }
});
/* ======================================================
   ✅ PUT /business-special-dates/:id
====================================================== */
app.put("/business-special-dates/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const {
      tenant_id,
      branch_id,
      label,
      date,
      is_closed,
      start_time,
      end_time,
    } = req.body;

    if (!id) {
      return res.status(400).json({ error: "id es obligatorio" });
    }

    const payload = {
      updated_at: new Date().toISOString(),
    };

    if (tenant_id !== undefined) payload.tenant_id = tenant_id;
    if (branch_id !== undefined) payload.branch_id = branch_id;
    if (label !== undefined) payload.label = label || null;
    if (date !== undefined) payload.date = date;
    if (is_closed !== undefined) payload.is_closed = !!is_closed;
    if (start_time !== undefined) payload.start_time = start_time || null;
    if (end_time !== undefined) payload.end_time = end_time || null;

    const { data, error } = await supabase
      .from("business_special_dates")
      .update(payload)
      .eq("id", id)
      .select("*")
      .single();

    if (error) throw error;

    return res.json({
      ok: true,
      message: "Fecha especial actualizada correctamente",
      item: data,
    });
  } catch (err) {
    console.error("PUT /business-special-dates/:id error:", err.message);
    return res.status(500).json({
      error: err.message || "Error actualizando fecha especial",
    });
  }
});

/* ======================================================
   ✅ DELETE /business-special-dates/:id
====================================================== */
app.delete("/business-special-dates/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from("business_special_dates")
      .delete()
      .eq("id", id);

    if (error) throw error;

    return res.json({
      ok: true,
      message: "Fecha especial eliminada correctamente",
    });
  } catch (err) {
    console.error("DELETE /business-special-dates/:id error:", err.message);
    return res.status(500).json({ error: "Error eliminando fecha especial" });
  }
});


/* ======================================================
   ✅ HELPERS STAFF
====================================================== */
function isValidDayOfWeek(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 6;
}

function normalizeNullableText(value) {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

function normalizeColor(value) {
  const color = String(value || "").trim();
  if (!color) return "#0f172a";
  return color;
}

function normalizeNullablePetText(value) {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

function addMonths(date, months) {
  const next = new Date(date);
  const originalDay = next.getDate();

  next.setMonth(next.getMonth() + months);

  if (next.getDate() < originalDay) {
    next.setDate(0);
  }

  return next;
}

function addYears(date, years) {
  const next = new Date(date);
  next.setFullYear(next.getFullYear() + years);
  return next;
}

function resolveNextControlDate({
  baseDate,
  next_control_mode,
  next_control_exact_date,
  next_control_custom_value,
  next_control_custom_unit,
}) {
  const base = new Date(baseDate);

  if (Number.isNaN(base.getTime())) {
    throw new Error("Fecha base inválida para calcular próximo control");
  }

  const mode = String(next_control_mode || "none").trim().toLowerCase();

  if (!mode || mode === "none") {
    return {
      next_control_at: null,
      next_control_label: null,
    };
  }

  if (mode === "7_days") {
    return {
      next_control_at: addDays(base, 7).toISOString(),
      next_control_label: "7 días",
    };
  }

  if (mode === "15_days") {
    return {
      next_control_at: addDays(base, 15).toISOString(),
      next_control_label: "15 días",
    };
  }

  if (mode === "30_days") {
    return {
      next_control_at: addDays(base, 30).toISOString(),
      next_control_label: "30 días",
    };
  }

  if (mode === "2_months") {
    return {
      next_control_at: addMonths(base, 2).toISOString(),
      next_control_label: "2 meses",
    };
  }

  if (mode === "3_months") {
    return {
      next_control_at: addMonths(base, 3).toISOString(),
      next_control_label: "3 meses",
    };
  }

  if (mode === "6_months") {
    return {
      next_control_at: addMonths(base, 6).toISOString(),
      next_control_label: "6 meses",
    };
  }

  if (mode === "1_year") {
    return {
      next_control_at: addYears(base, 1).toISOString(),
      next_control_label: "1 año",
    };
  }

if (mode === "exact_date") {
  if (!next_control_exact_date) {
    throw new Error("Debes seleccionar una fecha para el próximo control");
  }

  const exactDate = new Date(`${next_control_exact_date}T12:00:00`);

  if (Number.isNaN(exactDate.getTime())) {
    throw new Error("Fecha exacta inválida para próximo control");
  }

  return {
    next_control_at: exactDate.toISOString(),
    next_control_label: "Fecha exacta",
  };
}


  if (mode === "custom") {
    const rawValue = Number(next_control_custom_value);
    const unit = String(next_control_custom_unit || "")
      .trim()
      .toLowerCase();

    if (!rawValue || Number.isNaN(rawValue) || rawValue < 1) {
      throw new Error("Debes indicar una cantidad válida para el próximo control personalizado");
    }

    if (!["days", "months", "years"].includes(unit)) {
      throw new Error("Unidad inválida para próximo control personalizado");
    }

    if (unit === "days") {
      return {
        next_control_at: addDays(base, rawValue).toISOString(),
        next_control_label: `${rawValue} día${rawValue === 1 ? "" : "s"}`,
      };
    }

    if (unit === "months") {
      return {
        next_control_at: addMonths(base, rawValue).toISOString(),
        next_control_label: `${rawValue} mes${rawValue === 1 ? "" : "es"}`,
      };
    }

    return {
      next_control_at: addYears(base, rawValue).toISOString(),
      next_control_label: `${rawValue} año${rawValue === 1 ? "" : "s"}`,
    };
  }

  throw new Error("next_control_mode inválido");
}

/* ======================================================
   ✅ GET /staff
====================================================== */
app.get("/staff", async (req, res) => {
  try {
    const { tenant_id, branch_id, active } = req.query;

    if (!tenant_id) {
      return res.status(400).json({ error: "tenant_id es obligatorio" });
    }

    const resolvedBranchId = await resolveBranchId({
      tenant_id,
      branch_id: branch_id || null,
    });

    let query = supabase
      .from("staff")
      .select("*")
      .eq("tenant_id", tenant_id)
      .eq("branch_id", resolvedBranchId)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });

    if (active === "true") query = query.eq("is_active", true);
    if (active === "false") query = query.eq("is_active", false);

    const { data, error } = await query;

    if (error) throw error;

    return res.json({
      total: data?.length || 0,
      branch_id: resolvedBranchId,
      staff: data || [],
    });
  } catch (err) {
    console.error("GET /staff error:", err.message);
    return res.status(500).json({ error: err.message || "Error obteniendo staff" });
  }
});

/* ======================================================
   ✅ POST /staff
====================================================== */

app.post("/staff", async (req, res) => {
  try {
    const {
  tenant_id,
  branch_id,
  name,
  role,
  email,
  phone,
  color = "#0f172a",
  is_active = true,
  sort_order = 0,
  use_business_hours = true,
  photo_url = null,
} = req.body;

    if (!tenant_id) {
      return res.status(400).json({ error: "tenant_id es obligatorio" });
    }

    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: "name es obligatorio" });
    }

    const resolvedBranchId = await resolveBranchId({
      tenant_id,
      branch_id: branch_id || null,
    });

    const plan = await getPlan(tenant_id);
    const caps = getPlanCapabilities(plan);
    const staffCount = await getStaffCount(tenant_id);

    if (staffCount >= caps.max_staff) {
      return res.status(403).json({
        error: "Límite de staff alcanzado",
        upgrade_required: true,
      });
    }

    const payload = {
      tenant_id,
      branch_id: resolvedBranchId,
      name: String(name).trim(),
      role: normalizeNullableText(role),
      email: normalizeNullableText(email),
      phone: normalizeNullableText(phone),
      color: normalizeColor(color),
      is_active: Boolean(is_active),
      sort_order: Number(sort_order || 0),
      use_business_hours: Boolean(use_business_hours),
photo_url: photo_url || null,
    };

    const { data, error } = await supabase
      .from("staff")
      .insert(payload)
      .select("*")
      .single();

    if (error) throw error;

    return res.status(201).json({
      ok: true,
      staff: data,
    });
  } catch (err) {
    console.error("POST /staff error:", err.message);
    return res.status(500).json({ error: err.message || "Error creando staff" });
  }
});

/* ======================================================
   ✅ PUT /staff/:id
====================================================== */

app.put("/staff/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const {
      tenant_id,
      branch_id,
      name,
      role,
      email,
      phone,
      color,
      is_active,
      sort_order,
      use_business_hours,
    } = req.body;

    if (!id) {
      return res.status(400).json({ error: "id es obligatorio" });
    }

    const { data: existingStaff, error: existingError } = await supabase
      .from("staff")
      .select("id, tenant_id, branch_id")
      .eq("id", id)
      .single();

    if (existingError || !existingStaff) {
      return res.status(404).json({ error: "Staff no encontrado" });
    }

    const effectiveTenantId = tenant_id || existingStaff.tenant_id;

    const updateData = {};
console.log("PUT /staff/:id body:", req.body);

    if (branch_id !== undefined) {
      const resolvedBranchId = await resolveBranchId({
        tenant_id: effectiveTenantId,
        branch_id: branch_id || null,
      });

      updateData.branch_id = resolvedBranchId;
    }

    if (name !== undefined) {
      if (!String(name).trim()) {
        return res.status(400).json({ error: "name no puede estar vacío" });
      }
      updateData.name = String(name).trim();
    }

    if (role !== undefined) updateData.role = normalizeNullableText(role);
    if (email !== undefined) updateData.email = normalizeNullableText(email);
    if (phone !== undefined) updateData.phone = normalizeNullableText(phone);
    if (color !== undefined) updateData.color = normalizeColor(color);
    if (is_active !== undefined) updateData.is_active = Boolean(is_active);
    if (sort_order !== undefined) updateData.sort_order = Number(sort_order || 0);
    if (use_business_hours !== undefined) {
      updateData.use_business_hours = Boolean(use_business_hours);
    }

if (req.body.photo_url !== undefined) {
  updateData.photo_url = req.body.photo_url || null;
}

console.log("PUT /staff/:id updateData:", updateData);

    const { data, error } = await supabase
      .from("staff")
      .update(updateData)
      .eq("id", id)
      .select("*")
      .single();

    if (error) throw error;

    return res.json({
      ok: true,
      staff: data,
    });
  } catch (err) {
    console.error("PUT /staff/:id error:", err.message);
    return res.status(500).json({ error: err.message || "Error actualizando staff" });
  }
});

/* ======================================================
   ✅ DELETE /staff/:id
====================================================== */
app.delete("/staff/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from("staff")
      .delete()
      .eq("id", id);

    if (error) throw error;

    return res.json({
      ok: true,
      message: "Staff eliminado correctamente",
    });
  } catch (err) {
    console.error("DELETE /staff/:id error:", err.message);
    return res.status(500).json({ error: "Error eliminando staff" });
  }
});

/* ======================================================
   ✅ GET /staff-services
====================================================== */
app.get("/staff-services", async (req, res) => {
  try {
    const { tenant_id, staff_id } = req.query;

    if (!tenant_id) {
      return res.status(400).json({ error: "tenant_id es obligatorio" });
    }

    let query = supabase
      .from("staff_services")
      .select("*")
      .eq("tenant_id", tenant_id)
      .order("created_at", { ascending: true });

    if (staff_id) {
      query = query.eq("staff_id", staff_id);
    }

    const { data, error } = await query;

    if (error) throw error;

    return res.json({
      total: data?.length || 0,
      staff_services: data || [],
    });
  } catch (err) {
    console.error("GET /staff-services error:", err.message);
    return res.status(500).json({ error: "Error obteniendo staff_services" });
  }
});

/* ======================================================
   ✅ PUT /staff-services
   Reemplaza todas las relaciones de un staff
====================================================== */
app.put("/staff-services", async (req, res) => {
  try {
    const { tenant_id, branch_id, staff_id, service_ids } = req.body;

    if (!tenant_id) {
      return res.status(400).json({ error: "tenant_id es obligatorio" });
    }

    if (!staff_id) {
      return res.status(400).json({ error: "staff_id es obligatorio" });
    }

    if (!Array.isArray(service_ids)) {
      return res.status(400).json({ error: "service_ids debe ser un arreglo" });
    }

    const resolvedBranchId = await resolveBranchId({
      tenant_id,
      branch_id: branch_id || null,
    });

    const uniqueServiceIds = [...new Set(service_ids.filter(Boolean))];

    const { error: deleteError } = await supabase
      .from("staff_services")
      .delete()
      .eq("tenant_id", tenant_id)
      .eq("branch_id", resolvedBranchId)
      .eq("staff_id", staff_id);

    if (deleteError) throw deleteError;

    if (uniqueServiceIds.length === 0) {
      return res.json({
        ok: true,
        staff_services: [],
      });
    }

    const payload = uniqueServiceIds.map((service_id) => ({
      tenant_id,
      branch_id: resolvedBranchId,
      staff_id,
      service_id,
    }));

    const { data, error } = await supabase
      .from("staff_services")
      .insert(payload)
      .select("*");

    if (error) throw error;

    return res.json({
      ok: true,
      staff_services: data || [],
    });
  } catch (err) {
    console.error("PUT /staff-services error:", err.message);
    return res.status(500).json({ error: err.message || "Error guardando staff_services" });
  }
});

/* ======================================================
   ✅ DELETE /staff-services/:id
====================================================== */
app.delete("/staff-services/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from("staff_services")
      .delete()
      .eq("id", id);

    if (error) throw error;

    return res.json({
      ok: true,
      message: "Relación staff-servicio eliminada correctamente",
    });
  } catch (err) {
    console.error("DELETE /staff-services/:id error:", err.message);
    return res.status(500).json({ error: "Error eliminando relación staff-servicio" });
  }
});

/* ======================================================
   ✅ GET /staff-hours
====================================================== */
app.get("/staff-hours", async (req, res) => {
  try {
    const { tenant_id, staff_id } = req.query;

    if (!tenant_id) {
      return res.status(400).json({ error: "tenant_id es obligatorio" });
    }

    let query = supabase
      .from("staff_hours")
      .select("*")
      .eq("tenant_id", tenant_id)
      .order("staff_id", { ascending: true })
      .order("day_of_week", { ascending: true });

    if (staff_id) {
      query = query.eq("staff_id", staff_id);
    }

    const { data, error } = await query;

    if (error) throw error;

    return res.json({
      total: data?.length || 0,
      hours: data || [],
    });
  } catch (err) {
    console.error("GET /staff-hours error:", err.message);
    return res.status(500).json({ error: "Error obteniendo staff_hours" });
  }
});

/* ======================================================
   ✅ PUT /staff-hours
   Reemplaza horarios semanales de un staff
====================================================== */

app.put("/staff-hours", async (req, res) => {
  try {
    const { tenant_id, staff_id, hours } = req.body;

    const { data: staffData, error: staffError } = await supabase
      .from("staff")
      .select("branch_id")
      .eq("id", staff_id)
      .single();

    if (staffError || !staffData) {
      return res.status(400).json({ error: "No se pudo obtener branch_id del staff" });
    }

    const branch_id_real = staffData.branch_id;

    if (!tenant_id) {
      return res.status(400).json({ error: "tenant_id es obligatorio" });
    }

    if (!staff_id) {
      return res.status(400).json({ error: "staff_id es obligatorio" });
    }

    if (!Array.isArray(hours)) {
      return res.status(400).json({ error: "hours debe ser un arreglo" });
    }

    for (const item of hours) {
      if (!isValidDayOfWeek(item.day_of_week)) {
        return res.status(400).json({ error: "day_of_week inválido" });
      }
    }

    const payload = hours.map((item) => ({
      tenant_id,
      branch_id: branch_id_real,
      staff_id,
      day_of_week: Number(item.day_of_week),
      enabled: Boolean(item.enabled),
      start_time: item.start_time || "09:00:00",
      end_time: item.end_time || "18:00:00",
      updated_at: new Date().toISOString(),
    }));

    console.log("STAFF HOURS PAYLOAD =>", JSON.stringify(payload, null, 2));

    const { data, error } = await supabase
      .from("staff_hours")
      .upsert(payload, { onConflict: "tenant_id,branch_id,staff_id,day_of_week" })
      .select("*");

    if (error) throw error;

    return res.json({
      ok: true,
      hours: data || [],
    });
  } catch (err) {
    console.error("PUT /staff-hours error:", err.message);
    return res.status(500).json({ error: err.message || "Error guardando staff_hours" });
  }
});

/* ======================================================
   ✅ GET /staff-special-dates
====================================================== */
app.get("/staff-special-dates", async (req, res) => {
  try {
    const { tenant_id, branch_id, staff_id } = req.query;

    if (!tenant_id) {
      return res.status(400).json({ error: "tenant_id es obligatorio" });
    }

    let query = supabase
      .from("staff_special_dates")
      .select("*")
      .eq("tenant_id", tenant_id)
      .order("date", { ascending: true })
      .order("created_at", { ascending: true });

    if (branch_id) {
      query = query.eq("branch_id", branch_id);
    }

    if (staff_id) {
      query = query.eq("staff_id", staff_id);
    }

    const { data, error } = await query;

    if (error) throw error;

    return res.json({
      total: data?.length || 0,
      special_dates: data || [],
    });
  } catch (err) {
    console.error("GET /staff-special-dates error:", err.message);
    return res.status(500).json({ error: "Error obteniendo staff_special_dates" });
  }
});

/* ======================================================
   ✅ POST /staff-special-dates
====================================================== */

app.post("/staff-special-dates", async (req, res) => {
  try {
    const {
      tenant_id,
      branch_id,
      staff_id,
      date,
      label,
      is_closed,
      start_time,
      end_time,
    } = req.body;

    if (!tenant_id) {
      return res.status(400).json({ error: "tenant_id es obligatorio" });
    }


    if (!staff_id) {
      return res.status(400).json({ error: "staff_id es obligatorio" });
    }

    if (!date) {
      return res.status(400).json({ error: "date es obligatorio" });
    }

    const { data: existingStaff, error: staffError } = await supabase
      .from("staff")
      .select("id, tenant_id, branch_id")
      .eq("id", staff_id)
      .eq("tenant_id", tenant_id)
      .eq("branch_id", branch_id)
      .single();

    if (staffError || !existingStaff) {
      return res.status(404).json({
        error: "El staff no existe o no pertenece a la sucursal seleccionada",
      });
    }

    const payload = {
      tenant_id,
      branch_id,
      staff_id,
      date,
      label: normalizeNullableText(label),
      is_closed: Boolean(is_closed),
      start_time: is_closed ? null : start_time || null,
      end_time: is_closed ? null : end_time || null,
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from("staff_special_dates")
      .insert(payload)
      .select("*")
      .single();

    if (error) throw error;

    return res.status(201).json({
      ok: true,
      item: data,
    });
  } catch (err) {
    console.error("POST /staff-special-dates error:", err.message);
    return res.status(500).json({ error: err.message || "Error creando staff_special_date" });
  }
});

/* ======================================================
   ✅ PUT /staff-special-dates/:id
====================================================== */

app.put("/staff-special-dates/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const {
      tenant_id,
      branch_id,
      staff_id,
      date,
      label,
      is_closed,
      start_time,
      end_time,
    } = req.body;

    const { data: existingRow, error: existingRowError } = await supabase
      .from("staff_special_dates")
      .select("id, tenant_id, branch_id, staff_id")
      .eq("id", id)
      .single();

    if (existingRowError || !existingRow) {
      return res.status(404).json({ error: "Excepción no encontrada" });
    }

    const effectiveTenantId = tenant_id || existingRow.tenant_id;
    const effectiveBranchId = branch_id || existingRow.branch_id;
    const effectiveStaffId = staff_id || existingRow.staff_id;

    const { data: existingStaff, error: staffError } = await supabase
      .from("staff")
      .select("id, tenant_id, branch_id")
      .eq("id", effectiveStaffId)
      .eq("tenant_id", effectiveTenantId)
      .eq("branch_id", effectiveBranchId)
      .single();

    if (staffError || !existingStaff) {
      return res.status(404).json({
        error: "El staff no existe o no pertenece a la sucursal seleccionada",
      });
    }

    const payload = {
      updated_at: new Date().toISOString(),
    };

    if (tenant_id !== undefined) payload.tenant_id = tenant_id;
    if (branch_id !== undefined) payload.branch_id = branch_id;
    if (staff_id !== undefined) payload.staff_id = staff_id;
    if (date !== undefined) payload.date = date;
    if (label !== undefined) payload.label = normalizeNullableText(label);
    if (is_closed !== undefined) payload.is_closed = Boolean(is_closed);

    if (is_closed !== undefined) {
      payload.start_time = Boolean(is_closed) ? null : start_time || null;
      payload.end_time = Boolean(is_closed) ? null : end_time || null;
    } else {
      if (start_time !== undefined) payload.start_time = start_time || null;
      if (end_time !== undefined) payload.end_time = end_time || null;
    }

    const { data, error } = await supabase
      .from("staff_special_dates")
      .update(payload)
      .eq("id", id)
      .select("*")
      .single();

    if (error) throw error;

    return res.json({
      ok: true,
      item: data,
    });
  } catch (err) {
    console.error("PUT /staff-special-dates/:id error:", err.message);
    return res.status(500).json({ error: err.message || "Error actualizando staff_special_date" });
  }
});

/* ======================================================
   ✅ DELETE /staff-special-dates/:id
====================================================== */
app.delete("/staff-special-dates/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from("staff_special_dates")
      .delete()
      .eq("id", id);

    if (error) throw error;

    return res.json({
      ok: true,
      message: "Fecha especial de staff eliminada correctamente",
    });
  } catch (err) {
    console.error("DELETE /staff-special-dates/:id error:", err.message);
    return res.status(500).json({ error: "Error eliminando staff_special_date" });
  }
});

/* ======================================================
   🔹 ENDPOINT: /slots
====================================================== */

app.get("/slots", async (req, res) => {
  try {
    const { calendar_id, branch_id, service_id, date } = req.query;

    if (!calendar_id || !date) {
      return res.status(400).json({
        error: "Faltan parámetros: calendar_id y date (YYYY-MM-DD)",
      });
    }

    const { data: cal, error: calErr } = await supabase
      .from("calendars")
      .select("id, tenant_id, slot_minutes, is_active")
      .eq("id", calendar_id)
      .single();

    if (calErr || !cal) {
      return res.status(404).json({ error: "Calendario no encontrado" });
    }

    if (!cal.is_active) {
      return res.status(400).json({ error: "Calendario inactivo" });
    }

    const resolvedBranchId = await resolveBranchId({
      tenant_id: cal.tenant_id,
      branch_id: branch_id || null,
    });

    let service = null;

    if (service_id) {
      const { data: serviceData, error: serviceError } = await supabase
        .from("services")
        .select("*")
        .eq("id", service_id)
        .eq("tenant_id", cal.tenant_id)
        .eq("branch_id", resolvedBranchId)
        .is("deleted_at", null)
        .single();

      if (serviceError || !serviceData) {
        return res.status(404).json({ error: "Servicio no encontrado" });
      }

      service = serviceData;
    }

    const { data, error } = await supabase.rpc("get_available_slots", {
      _calendar_id: calendar_id,
      _day: date,
    });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    const windows = await getBusinessAvailabilityWindows({
      tenant_id: cal.tenant_id,
      branch_id: resolvedBranchId,
      date,
    });

    let slots = filterSlotsByWindows(data || [], windows, date);

    const windowsWithoutAppointments = await subtractAppointmentsFromWindows({
      tenant_id: cal.tenant_id,
      branch_id: resolvedBranchId,
      staff_id: null,
      date,
      windows: windows,
    });

    slots = buildSlotsFromWindows(
      windowsWithoutAppointments,
      date,
      cal.slot_minutes || 30
    );

    if (service && slots.length > 0) {
      const totalMinutes =
        (service.duration_minutes || 0) +
        (service.buffer_before_minutes || 0) +
        (service.buffer_after_minutes || 0);

      const baseSlotMinutes = cal.slot_minutes || 30;

      slots = filterSlotsForServiceDuration(
        slots,
        totalMinutes,
        baseSlotMinutes
      );
    }

    return res.json({
      calendar_id,
      branch_id: resolvedBranchId,
      service_id: service_id || null,
      service,
      date,
      total: slots.length,
      slots,
    });
  } catch (err) {
    console.error("GET /slots error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   ✅ POST /appointments/slot
====================================================== */

app.post("/appointments/slot", async (req, res) => {
  let apptCreated = null;

  try {
const {
  calendar_id,
  branch_id,
  service_id,
  staff_id,
  date,
  slot_start,
  customer_name,
  customer_phone,
  customer_email,
  source = "whatsapp",

  reason,
  notes,
  next_control_at,

} = req.body;

    function normalizeChileanPhone(rawPhone) {
      if (!rawPhone) return null;

      let digits = String(rawPhone).replace(/\D/g, "");

      if (digits.startsWith("56")) {
        digits = digits.slice(2);
      }

      if (digits.length !== 9) return null;
      if (!digits.startsWith("9")) return null;

      return `+56${digits}`;
    }

    function isValidEmail(email) {
      if (!email) return false;

      const normalized = String(email).trim().toLowerCase();
      const emailRegex = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

      if (!emailRegex.test(normalized)) return false;

      const domain = normalized.split("@")[1];
      if (!domain) return false;
      if (domain.startsWith(".")) return false;
      if (domain.endsWith(".")) return false;
      if (domain.includes("..")) return false;

      return true;
    }

    const normalizedEmail = String(customer_email || "").trim().toLowerCase();
    const normalizedPhone = normalizeChileanPhone(customer_phone);

    if (
      !calendar_id ||
      !date ||
      !slot_start ||
      !customer_name ||
      !customer_phone ||
      !customer_email
    ) {
      return res.status(400).json({
        error:
          "Faltan campos: calendar_id, date (YYYY-MM-DD), slot_start (ISO), customer_name, customer_phone, customer_email",
      });
    }

    if (!isValidEmail(normalizedEmail)) {
      return res.status(400).json({
        error: "El email ingresado no es válido.",
      });
    }

    if (!normalizedPhone) {
      return res.status(400).json({
        error:
          "El teléfono debe ser un número móvil chileno válido de 9 dígitos. Ejemplo: 912345678",
      });
    }

    const { data: cal, error: calErr } = await supabase
      .from("calendars")
      .select("tenant_id, slot_minutes, buffer_minutes, timezone, is_active")
      .eq("id", calendar_id)
      .single();

    if (calErr || !cal) {
      return res.status(404).json({ error: "Calendario no encontrado" });
    }

    if (!cal.is_active) {
      return res.status(400).json({ error: "Calendario inactivo" });
    }

    const resolvedBranchId = await resolveBranchId({
      tenant_id: cal.tenant_id,
      branch_id: branch_id || null,
    });

    const { data: tenantConfig, error: tenantConfigError } = await supabase
      .from("tenants")
      .select("min_booking_notice_minutes, max_booking_days_ahead")
      .eq("id", cal.tenant_id)
      .single();

    if (tenantConfigError || !tenantConfig) {
      return res.status(404).json({ error: "Negocio no encontrado" });
    }

    const minBookingNoticeMinutes = Number(
      tenantConfig.min_booking_notice_minutes || 0
    );

    const maxBookingDaysAhead = Number(
      tenantConfig.max_booking_days_ahead || 60
    );

    const start = new Date(slot_start);

    const minAllowedStart = new Date(
      Date.now() + minBookingNoticeMinutes * 60 * 1000
    );

    if (start.getTime() < minAllowedStart.getTime()) {
      return res.status(409).json({
        error: `Este negocio permite reservas con al menos ${minBookingNoticeMinutes} minutos de anticipación.`,
      });
    }

    const maxAllowedBookingStart = new Date();
    maxAllowedBookingStart.setHours(23, 59, 59, 999);
    maxAllowedBookingStart.setDate(
      maxAllowedBookingStart.getDate() + maxBookingDaysAhead
    );

    if (start.getTime() > maxAllowedBookingStart.getTime()) {
      return res.status(409).json({
        error: `Este negocio permite reservas con hasta ${maxBookingDaysAhead} días de anticipación.`,
      });
    }

    const startIso = start.toISOString();

const slotMinutes = cal.slot_minutes ?? 30;
const timeZone = cal.timezone || "America/Santiago";

let duration = slotMinutes;
let bufferBefore = 0;
let bufferAfter = 0;
let serviceName = null;
let isGroup = false;
let capacity = 1;

if (service_id) {
  const { data: service, error: serviceErr } = await supabase
    .from("services")
    .select("*")
    .eq("id", service_id)
    .eq("tenant_id", cal.tenant_id)
    .eq("branch_id", resolvedBranchId)
    .is("deleted_at", null)
    .limit(1)
    .maybeSingle();

  if (serviceErr || !service) {
    return res.status(404).json({ error: "Servicio no encontrado" });
  }

  duration = service.duration_minutes;
  bufferBefore = service.buffer_before_minutes || 0;
  bufferAfter = service.buffer_after_minutes || 0;
  serviceName = service.name;
  isGroup = Boolean(service.is_group);
  capacity = Number(service.capacity || 1);
}

    let bookingQuery = supabase
  .from("appointments")
  .select("id", { count: "exact" })
  .eq("tenant_id", cal.tenant_id)
  .eq("branch_id", resolvedBranchId)
  .eq("start_at", startIso)
  .eq("status", "booked");

if (staff_id) {
  bookingQuery = bookingQuery.eq("staff_id", staff_id);
}

const { count: existingCount, error: countErr } = await bookingQuery;

if (countErr) {
  return res.status(500).json({ error: countErr.message });
}

// 🧠 Lógica híbrida
if (!isGroup) {
  if (existingCount > 0) {
    return res.status(409).json({
      error: "Este horario acaba de ser reservado por otro cliente.",
    });
  }
} else {
  if (existingCount >= capacity) {
    return res.status(409).json({
      error: "Este horario ya alcanzó su capacidad máxima.",
    });
  }
}

        const nowIso = new Date().toISOString();
    const normalizedCustomerName = String(customer_name || "")
      .trim()
      .toLowerCase();

    const { data: existingAppointments, error: existingErr } = await supabase
      .from("appointments")
      .select(
        "id, start_at, status, customer_name, customer_email, customer_phone"
      )
      .eq("tenant_id", cal.tenant_id)
      .eq("status", "booked")
      .gte("start_at", nowIso);

    if (existingErr) {
      return res.status(500).json({ error: existingErr.message });
    }

    const futureAppointments = existingAppointments || [];

    const samePersonAppointment = futureAppointments.find((appt) => {
      const apptName = String(appt.customer_name || "").trim().toLowerCase();
      const sameName =
        normalizedCustomerName && apptName === normalizedCustomerName;

      if (!sameName) return false;

      const sameEmail =
        normalizedEmail &&
        appt.customer_email &&
        String(appt.customer_email).trim().toLowerCase() === normalizedEmail;

      const samePhone =
        normalizedPhone &&
        appt.customer_phone &&
        String(appt.customer_phone).trim() === normalizedPhone;

      return sameEmail || samePhone;
    });

    if (samePersonAppointment) {
      return res.status(409).json({
        error:
          "Esta persona ya tiene una reserva futura activa. Revisa su correo o cancela la reserva actual antes de tomar otra.",
      });
    }

    if (normalizedEmail) {
      const emailActiveCount = futureAppointments.filter(
        (appt) =>
          appt.customer_email &&
          String(appt.customer_email).trim().toLowerCase() === normalizedEmail
      ).length;

      if (emailActiveCount >= 2) {
        return res.status(409).json({
          error:
            "Este correo ya alcanzó el máximo de 2 reservas futuras activas.",
        });
      }
    }

    if (normalizedPhone) {
      const phoneActiveCount = futureAppointments.filter(
        (appt) =>
          appt.customer_phone &&
          String(appt.customer_phone).trim() === normalizedPhone
      ).length;

      if (phoneActiveCount >= 2) {
        return res.status(409).json({
          error:
            "Este teléfono ya alcanzó el máximo de 2 reservas futuras activas.",
        });
      }
    }


    const totalMinutes = duration + bufferBefore + bufferAfter;

const slotDateStr = String(date).slice(0, 10);

    let validSlots = [];

    if (staff_id) {
      const businessWindows = await getBusinessAvailabilityWindows({
        tenant_id: cal.tenant_id,
        branch_id: resolvedBranchId,
        date: slotDateStr,
      });

      const staffWindows = await getStaffAvailabilityWindows({
        tenant_id: cal.tenant_id,
        branch_id: resolvedBranchId,
        staff_id,
        date: slotDateStr,
      });

      let finalWindows = intersectWindows(businessWindows, staffWindows);

      finalWindows = await subtractAppointmentsFromWindows({
        tenant_id: cal.tenant_id,
        branch_id: resolvedBranchId,
        staff_id,
        date: slotDateStr,
        windows: finalWindows,
      });

      validSlots = buildSlotsFromWindows(
        finalWindows,
        slotDateStr,
        slotMinutes
      );

      validSlots = filterSlotsForServiceDuration(
        validSlots,
        totalMinutes,
        slotMinutes
      ).map((slot) => ({
        ...slot,
        staff_id,
      }));
    } else {
      const { data: rawSlots, error: slotsErr } = await supabase.rpc(
        "get_available_slots",
        {
          _calendar_id: calendar_id,
          _day: date,
        }
      );

      if (slotsErr) {
        return res.status(500).json({ error: slotsErr.message });
      }

      const windows = await getBusinessAvailabilityWindows({
        tenant_id: cal.tenant_id,
        branch_id: resolvedBranchId,
        date,
      });

      validSlots = filterSlotsByWindows(rawSlots || [], windows, date);

      validSlots = filterSlotsForServiceDuration(
        validSlots,
        totalMinutes,
        slotMinutes
      );
    }

    const wantedStart = slot_start.slice(0, 16); // "YYYY-MM-DDTHH:mm"

const ok = validSlots.some(
  (s) => s.slot_start.slice(0, 16) === wantedStart
);

    if (!ok) {
      return res.status(409).json({
        error: "Ese horario ya no está disponible.",
      });
    }

    const end = new Date(
      start.getTime() + (duration + bufferBefore + bufferAfter) * 60 * 1000
    );
    const cancelToken = crypto.randomBytes(24).toString("hex");

    const { data: apptRows, error: insErr } = await supabase
      .from("appointments")
      .insert({
        tenant_id: cal.tenant_id,
        branch_id: resolvedBranchId,
        calendar_id,
        service_id,
        staff_id: staff_id || null,
        service_name_snapshot: serviceName,
        duration_minutes_snapshot: duration,
        customer_name: String(customer_name).trim(),
        customer_phone: normalizedPhone,
        customer_email: normalizedEmail,
        start_at: start.toISOString(),
        end_at: end.toISOString(),
        source,
        status: "booked",
reason: reason || null,
notes: notes || null,
next_control_at: next_control_at || null,
        cancel_token: cancelToken,
      })
      .select("*");

    if (insErr) {
      const normalizedInsertError = String(
        insErr.message || insErr.details || ""
      ).toLowerCase();

      if (
        insErr.code === "23505" ||
        normalizedInsertError.includes("duplicate key") ||
        normalizedInsertError.includes("unique constraint") ||
        normalizedInsertError.includes("appointments_unique_slot")
      ) {
        return res.status(409).json({
          error: "Este horario acaba de ser reservado por otro cliente.",
        });
      }

      return res.status(500).json({ error: insErr.message });
    }

const appt = apptRows?.[0] || null;

if (!appt) {
  return res.status(500).json({
    error: "No se pudo crear la reserva.",
  });
}

apptCreated = appt;

const customer = await upsertCustomerFromAppointment({
  tenant_id: cal.tenant_id,
  customer_name: String(customer_name).trim(),
  customer_email: normalizedEmail,
  customer_phone: normalizedPhone,
  start_at: start.toISOString(),
});

const customerData = req.body?.customer_data || {};

const resolvedPet = await resolvePetFromAppointment({
  tenant_id: cal.tenant_id,
  customer_id: customer.id,
  customer_data: customerData,
});

const petName =
  String(resolvedPet?.name || customerData?.pet_name || "").trim();

const petSpecies =
  String(
    resolvedPet?.species_custom ||
      resolvedPet?.species_base ||
      customerData?.pet_species ||
      ""
  ).trim();

await supabase
  .from("appointments")
  .update({
    customer_id: customer.id,
    pet_id: resolvedPet?.id || null,
    customer_data: {
      ...customerData,
      pet_name: petName || null,
      pet_species: petSpecies || null,
    },
  })
  .eq("id", apptCreated.id);
await recalculateCustomerStats(customer.id);

    const { calendar, googleCalendarId } =
      await getGoogleCalendarClientByCalendarId(calendar_id);

    const event = {
      summary: `Cita - ${String(customer_name).trim()}`,
      description: `Cliente: ${String(customer_name).trim()}\nTeléfono: ${normalizedPhone}\nEmail: ${normalizedEmail}\ncalendar_id: ${calendar_id}\nappointment_id: ${appt.id}\nstaff_id: ${staff_id || "no_asignado"}`,
      start: { dateTime: start.toISOString(), timeZone },
      end: { dateTime: end.toISOString(), timeZone },
    };

    const response = await calendar.events.insert({
      calendarId: googleCalendarId,
      requestBody: event,
    });

    const eventId = response?.data?.id || null;

    const { data: apptUpdated, error: updErr } = await supabase
      .from("appointments")
      .update({ event_id: eventId })
      .eq("id", appt.id)
      .select("*")
      .single();

    if (updErr) {
      try {
        if (eventId) {
          await calendar.events.delete({
            calendarId: googleCalendarId,
            eventId,
          });
        }
      } catch (_) {}

      await supabase
        .from("appointments")
        .update({ status: "canceled", canceled_at: new Date().toISOString() })
        .eq("id", appt.id);

      return res.status(500).json({
        error: "Se creó evento, pero falló guardar event_id en DB.",
      });
    }

    const { data: tenantData } = await supabase
      .from("tenants")
      .select("slug")
      .eq("id", cal.tenant_id)
      .single();

    const bookingUrl = tenantData?.slug
      ? `https://www.orbyx.cl/${tenantData.slug}`
      : "https://www.orbyx.cl";

    const cancelUrl =
      `https://www.orbyx.cl/cancel/${apptUpdated.id}?token=${cancelToken}` +
      `&redirect=${encodeURIComponent(bookingUrl)}`;

if (normalizedEmail) {
  const { data: tenantInfo } = await supabase
  .from("tenants")
  .select("name, address, phone, business_category")
  .eq("id", cal.tenant_id)
  .single();

const emailCustomerData = req.body?.customer_data || {};

await sendBookingEmail({
  email: normalizedEmail,
  customerName: String(customer_name).trim(),
  businessName: tenantInfo?.name || "Tu negocio",
  serviceName: serviceName || "Reserva",
  startAt: start.toISOString(),
  cancelUrl,
  address: tenantInfo?.address || null,
  phone: tenantInfo?.phone || null,
  businessCategory: tenantInfo?.business_category || null,
  petName: petName || null,
  petSpecies: petSpecies || null,
});
}

    return res.status(201).json({
      ok: true,
      appointment: apptUpdated,
      cancel_url: cancelUrl,
      google: {
        calendarId: googleCalendarId,
        event_id: eventId,
        htmlLink: response?.data?.htmlLink,
      },
    });
  } catch (err) {
    try {
      if (apptCreated?.id) {
        await supabase
          .from("appointments")
          .update({ status: "canceled", canceled_at: new Date().toISOString() })
          .eq("id", apptCreated.id);
      }
    } catch (_) {}

    return res.status(500).json({ error: err.message });
  }
});


/* ======================================================
   ✅ PATCH /appointments/:id/clinical
====================================================== */

app.patch("/appointments/:id/clinical", async (req, res) => {
  try {
    const { id } = req.params;
    const {
      reason,
      notes,
      control_type,
      control_note,
      next_control_at,
    } = req.body;

    if (!id) {
      return res.status(400).json({ error: "Falta appointment id" });
    }

    const { data: appointment, error: appointmentError } = await supabase
      .from("appointments")
      .select("id, tenant_id, customer_id, pet_id, staff_id")
      .eq("id", id)
      .single();

    if (appointmentError || !appointment) {
      return res.status(404).json({ error: "Atención no encontrada" });
    }

    const normalizedReason = String(reason || "").trim() || null;
    const normalizedNotes = String(notes || "").trim() || null;

    const { data, error } = await supabase
      .from("appointments")
      .update({
        reason: normalizedReason,
        notes: normalizedNotes,
        next_control_at: next_control_at || null,
      })
      .eq("id", id)
      .select("id, reason, notes, next_control_at, pet_id")
      .single();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    await supabase
      .from("pet_followups")
      .delete()
      .eq("appointment_id", id);

    if (appointment.pet_id && next_control_at) {
      const normalizedControlType =
        String(control_type || reason || "Control").trim() || "Control";

      const normalizedControlNote =
        String(control_note || notes || "").trim() || null;

      const labelDate = new Date(next_control_at).toLocaleDateString("es-CL");

      const { error: insertFollowupError } = await supabase
        .from("pet_followups")
        .insert({
          tenant_id: appointment.tenant_id,
          appointment_id: appointment.id,
          customer_id: appointment.customer_id || null,
          pet_id: appointment.pet_id,
          staff_id: appointment.staff_id || null,
          control_type: normalizedControlType,
          control_note: normalizedControlNote,
          next_control_at,
          next_control_label: `${normalizedControlType} · ${labelDate}`,
          updated_at: new Date().toISOString(),
        });

      if (insertFollowupError) {
        return res.status(500).json({ error: insertFollowupError.message });
      }
    }

    return res.status(200).json({
      ok: true,
      appointment: data,
    });
  } catch (err) {
    return res.status(500).json({
      error: err.message || "No se pudo guardar la ficha clínica.",
    });
  }
});

/* ======================================================
   ✅ GET /appointments/by-day/:slug/:date
====================================================== */
app.get("/appointments/by-day/:slug/:date", async (req, res) => {
  try {
    const { slug, date } = req.params;

const { data: tenant, error: tenantError } = await supabase
  .from("tenants")
  .select("id, name, slug, min_booking_notice_minutes")
  .eq("slug", slug)
  .eq("is_active", true)
  .single();

    if (tenantError || !tenant) {
      return res.status(404).json({ error: "Negocio no encontrado" });
    }

    const start = `${date}T00:00:00`;
    const end = `${date}T23:59:59`;

    const { data: appointments, error: appointmentsError } = await supabase
      .from("appointments")
      .select("*")
      .eq("tenant_id", tenant.id)
      .gte("start_at", start)
      .lte("start_at", end)
      .order("start_at", { ascending: true });

    if (appointmentsError) {
      return res.status(500).json({ error: appointmentsError.message });
    }

    return res.json({
      appointments: appointments || [],
    });
  } catch (error) {
    console.error("Error en /appointments/by-day/:slug/:date", error);
    return res.status(500).json({ error: "Error obteniendo agenda" });
  }
});

/* ======================================================
   ✅ GET /appointments/by-range/:slug
====================================================== */
app.get("/appointments/by-range/:slug", async (req, res) => {
  try {
    const { slug } = req.params;
    const { from, to, branch_id, staff_id } = req.query;

    if (!from || !to) {
      return res.status(400).json({
        error: "Se requieren los parámetros from y to en formato YYYY-MM-DD",
      });
    }

    const { data: tenant, error: tenantError } = await supabase
      .from("tenants")
      .select("id")
      .eq("slug", slug)
      .single();

    if (tenantError || !tenant) {
      return res.status(404).json({ error: "Negocio no encontrado" });
    }

const start = new Date(`${from}T00:00:00-04:00`).toISOString();
const end = new Date(`${to}T23:59:59-04:00`).toISOString();

    let query = supabase
      .from("appointments")
      .select("*")
      .eq("tenant_id", tenant.id)
      .gte("start_at", start)
      .lte("start_at", end)
      .order("start_at", { ascending: true });

    if (branch_id) {
      query = query.eq("branch_id", branch_id);
    }

    if (staff_id) {
      query = query.eq("staff_id", staff_id);
    }

    const { data: appointments, error: appointmentsError } = await query;

    if (appointmentsError) {
      return res.status(500).json({ error: appointmentsError.message });
    }

    return res.json({
      appointments: appointments || [],
    });
  } catch (error) {
    console.error("Error en /appointments/by-range/:slug", error);
    return res.status(500).json({ error: "Error obteniendo agenda semanal" });
  }
});

function formatDateForServer(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}


/* ======================================================
   ✅ GET /appointments/pending-close/:slug
   Pendientes de cierre globales
====================================================== */
app.get("/appointments/pending-close/:slug", async (req, res) => {
  try {
    const { slug } = req.params;
    const { branch_id, staff_id } = req.query;

    const { data: tenant, error: tenantError } = await supabase
      .from("tenants")
      .select("id")
      .eq("slug", slug)
      .single();

    if (tenantError || !tenant) {
      return res.status(404).json({ error: "Negocio no encontrado" });
    }

    let query = supabase
      .from("appointments")
      .select("*")
      .eq("tenant_id", tenant.id)
      .eq("status", "booked")
      .lt("start_at", new Date().toISOString())
      .order("start_at", { ascending: true });

    if (branch_id) query = query.eq("branch_id", branch_id);
    if (staff_id) query = query.eq("staff_id", staff_id);

    const { data, error } = await query;

    if (error) return res.status(500).json({ error: error.message });

    return res.json({
      total: data?.length || 0,
      appointments: data || [],
    });
  } catch (error) {
    console.error("Error en /appointments/pending-close/:slug", error);
    return res.status(500).json({ error: "Error obteniendo pendientes" });
  }
});


/* ======================================================
   ✅ GET /dashboard/metrics/:slug
====================================================== */
app.get("/dashboard/metrics/:slug", async (req, res) => {
  try {
    const { slug } = req.params;

    const { data: tenant, error: tenantError } = await supabase
      .from("tenants")
      .select("id, name, slug")
      .eq("slug", slug)
      .eq("is_active", true)
      .single();

    if (tenantError || !tenant) {
      return res.status(404).json({ error: "Negocio no encontrado" });
    }

    function getSantiagoParts(date) {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Santiago",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        weekday: "short",
      }).formatToParts(date);

      const map = Object.fromEntries(
        parts
          .filter((part) => part.type !== "literal")
          .map((part) => [part.type, part.value])
      );

      return {
        year: Number(map.year),
        month: Number(map.month),
        day: Number(map.day),
        weekday: map.weekday, // Mon, Tue, Wed...
        dateKey: `${map.year}-${map.month}-${map.day}`,
        monthKey: `${map.year}-${map.month}`,
      };
    }

    function parseDateKey(dateKey) {
      const [year, month, day] = String(dateKey).split("-").map(Number);
      return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
    }

    function toDateKey(date) {
      const y = date.getUTCFullYear();
      const m = String(date.getUTCMonth() + 1).padStart(2, "0");
      const d = String(date.getUTCDate()).padStart(2, "0");
      return `${y}-${m}-${d}`;
    }

    function addDays(dateKey, days) {
      const date = parseDateKey(dateKey);
      date.setUTCDate(date.getUTCDate() + days);
      return toDateKey(date);
    }

    function getWeekStart(dateKey) {
      const base = parseDateKey(dateKey);
      const weekday = base.getUTCDay(); // 0=Sun, 1=Mon...
      const diffToMonday = weekday === 0 ? -6 : 1 - weekday;
      base.setUTCDate(base.getUTCDate() + diffToMonday);
      return toDateKey(base);
    }

    function getWeekKeys(weekStartKey) {
      return Array.from({ length: 7 }, (_, index) => addDays(weekStartKey, index));
    }

    function getMonthStartKey(year, month) {
      return `${year}-${String(month).padStart(2, "0")}-01`;
    }

    function getMonthEndKey(year, month) {
      const nextMonth =
        month === 12
          ? new Date(Date.UTC(year + 1, 0, 1, 12, 0, 0))
          : new Date(Date.UTC(year, month, 1, 12, 0, 0));

      nextMonth.setUTCDate(nextMonth.getUTCDate() - 1);
      return toDateKey(nextMonth);
    }

    function calcComparison(current, previous) {
      const diff = current - previous;

      if (previous <= 0) {
        return {
          current,
          previous,
          diff,
          diff_pct: null,
        };
      }

      return {
        current,
        previous,
        diff,
        diff_pct: Number(((diff / previous) * 100).toFixed(1)),
      };
    }

    const now = new Date();
    const nowIso = now.toISOString();

    const todayParts = getSantiagoParts(now);
    const todayKey = todayParts.dateKey;
    const currentMonthKey = todayParts.monthKey;

    const currentWeekStartKey = getWeekStart(todayKey);
    const currentWeekEndKey = addDays(currentWeekStartKey, 6);

    const previousWeekStartKey = addDays(currentWeekStartKey, -7);
    const previousWeekEndKey = addDays(currentWeekStartKey, -1);

    const currentMonthStartKey = getMonthStartKey(
      todayParts.year,
      todayParts.month
    );
    const currentMonthEndKey = getMonthEndKey(todayParts.year, todayParts.month);

    const previousMonthYear =
      todayParts.month === 1 ? todayParts.year - 1 : todayParts.year;
    const previousMonth =
      todayParts.month === 1 ? 12 : todayParts.month - 1;

    const previousMonthKey = `${previousMonthYear}-${String(previousMonth).padStart(
      2,
      "0"
    )}`;
    const previousMonthStartKey = getMonthStartKey(
      previousMonthYear,
      previousMonth
    );
    const previousMonthEndKey = getMonthEndKey(
      previousMonthYear,
      previousMonth
    );

    const rangeStartKey =
      previousMonthStartKey < previousWeekStartKey
        ? previousMonthStartKey
        : previousWeekStartKey;

    const rangeEndKey =
      currentMonthEndKey > currentWeekEndKey
        ? currentMonthEndKey
        : currentWeekEndKey;

    const rangeStartIso = `${rangeStartKey}T00:00:00`;
    const rangeEndIso = `${rangeEndKey}T23:59:59`;

    const { data: appointments, error: appointmentsError } = await supabase
      .from("appointments")
      .select("id, start_at, status")
      .eq("tenant_id", tenant.id)
      .gte("start_at", rangeStartIso)
      .lte("start_at", rangeEndIso);

    if (appointmentsError) {
      return res.status(500).json({ error: appointmentsError.message });
    }

    const { count: upcomingCount, error: upcomingError } = await supabase
      .from("appointments")
      .select("*", { count: "exact", head: true })
      .eq("tenant_id", tenant.id)
      .eq("status", "booked")
      .gte("start_at", nowIso);

    if (upcomingError) {
      return res.status(500).json({ error: upcomingError.message });
    }

    const currentWeekKeys = new Set(getWeekKeys(currentWeekStartKey));
    const previousWeekKeys = new Set(getWeekKeys(previousWeekStartKey));

    const rows = appointments || [];

    let reservasHoy = 0;
    let reservasSemana = 0;
    let reservasSemanaPasada = 0;
    let reservasMes = 0;
    let reservasMesPasado = 0;

    let atendidasSemana = 0;
    let atendidasMes = 0;

    let canceladasSemana = 0;
    let canceladasMes = 0;

    let noShowSemana = 0;
    let noShowMes = 0;

    for (const appt of rows) {
      const apptDate = new Date(appt.start_at);
      const apptParts = getSantiagoParts(apptDate);
      const apptDateKey = apptParts.dateKey;
      const apptMonthKey = apptParts.monthKey;
      const status = String(appt.status || "").toLowerCase();

      if (apptDateKey === todayKey) {
        reservasHoy++;
      }

      if (currentWeekKeys.has(apptDateKey)) {
        reservasSemana++;

        if (status === "completed") atendidasSemana++;
        if (status === "canceled") canceladasSemana++;
        if (status === "no_show") noShowSemana++;
      }

      if (previousWeekKeys.has(apptDateKey)) {
        reservasSemanaPasada++;
      }

      if (apptMonthKey === currentMonthKey) {
        reservasMes++;

        if (status === "completed") atendidasMes++;
        if (status === "canceled") canceladasMes++;
        if (status === "no_show") noShowMes++;
      }

      if (apptMonthKey === previousMonthKey) {
        reservasMesPasado++;
      }
    }

    return res.json({
      ok: true,
      metrics: {
        reservas_hoy: reservasHoy,
        reservas_semana: reservasSemana,
        reservas_semana_pasada: reservasSemanaPasada,
        reservas_mes: reservasMes,
        reservas_mes_pasado: reservasMesPasado,
        proximas_reservas: upcomingCount || 0,

        atendidas_semana: atendidasSemana,
        atendidas_mes: atendidasMes,

        canceladas_semana: canceladasSemana,
        canceladas_mes: canceladasMes,

        no_show_semana: noShowSemana,
        no_show_mes: noShowMes,

        comparacion_semanal: calcComparison(
          reservasSemana,
          reservasSemanaPasada
        ),
        comparacion_mensual: calcComparison(
          reservasMes,
          reservasMesPasado
        ),
      },
      periods: {
        hoy: todayKey,
        semana_actual: {
          start: currentWeekStartKey,
          end: currentWeekEndKey,
        },
        semana_pasada: {
          start: previousWeekStartKey,
          end: previousWeekEndKey,
        },
        mes_actual: {
          start: currentMonthStartKey,
          end: currentMonthEndKey,
        },
        mes_pasado: {
          start: previousMonthStartKey,
          end: previousMonthEndKey,
        },
      },
    });
  } catch (err) {
    console.error("GET /dashboard/metrics/:slug error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});


/* ======================================================
   ✅ GET /appointments/customer-history/:slug
   Historial por cliente para ficha veterinaria
====================================================== */
app.get("/appointments/customer-history/:slug", async (req, res) => {
  try {
    const { slug } = req.params;
    const { customer_id } = req.query;

    if (!slug) {
      return res.status(400).json({ error: "slug es obligatorio" });
    }

    if (!customer_id) {
      return res.status(400).json({ error: "customer_id es obligatorio" });
    }

    const { data: tenant, error: tenantError } = await supabase
      .from("tenants")
      .select("id, slug")
      .eq("slug", slug)
      .eq("is_active", true)
      .single();

    if (tenantError || !tenant) {
      return res.status(404).json({ error: "Negocio no encontrado" });
    }

    const { data, error } = await supabase
      .from("appointments")
      .select("*")
      .eq("tenant_id", tenant.id)
      .eq("customer_id", customer_id)
      .order("start_at", { ascending: false });

    if (error) throw error;

    return res.json({
      total: data?.length || 0,
      appointments: data || [],
    });
  } catch (err) {
    console.error("GET /appointments/customer-history/:slug error:", err.message);
    return res.status(500).json({ error: err.message || "Error obteniendo historial" });
  }
});


/* ======================================================
   ✅ GET /pets/:id/clinical-pdf?slug=...
   PDF ficha clínica veterinaria
====================================================== */
app.get("/pets/:id/clinical-pdf", async (req, res) => {
  try {
    const { id } = req.params;
    const { slug } = req.query;

    if (!id || !slug) {
      return res.status(400).json({ error: "Falta id de mascota o slug" });
    }

    const { data: tenant, error: tenantError } = await supabase
      .from("tenants")
      .select("id, name, slug, business_category")
      .eq("slug", slug)
      .eq("is_active", true)
      .single();

    if (tenantError || !tenant) {
      return res.status(404).json({ error: "Negocio no encontrado" });
    }

    const category = String(tenant.business_category || "").toLowerCase();

    if (!["veterinaria", "vet"].includes(category)) {
      return res.status(403).json({ error: "PDF clínico solo disponible para veterinarias" });
    }

    const { data: pet, error: petError } = await supabase
      .from("pets")
      .select("*")
      .eq("id", id)
      .eq("tenant_id", tenant.id)
      .single();

    if (petError || !pet) {
      return res.status(404).json({ error: "Mascota no encontrada" });
    }

    const { data: customer } = await supabase
      .from("customers")
      .select("*")
      .eq("id", pet.customer_id)
      .eq("tenant_id", tenant.id)
      .single();

    const { data: appointments, error: appointmentsError } = await supabase
      .from("appointments")
      .select("*")
      .eq("tenant_id", tenant.id)
      .eq("pet_id", pet.id)
      .order("start_at", { ascending: false });

    if (appointmentsError) throw appointmentsError;

    const doc = new PDFDocument({ margin: 42, size: "A4" });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="ficha-clinica-${pet.name || "mascota"}.pdf"`
    );

    doc.pipe(res);

    const pageWidth = doc.page.width;
    const left = 42;
    const right = pageWidth - 42;
    const contentWidth = right - left;

    function formatLongDate(value) {
      if (!value) return "No definido";
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return "No definido";

      return date.toLocaleDateString("es-CL", {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      });
    }

    function safe(value) {
      return String(value || "").trim();
    }

    function drawSectionTitle(title) {
      doc.moveDown(1);
      doc.font("Helvetica-Bold").fontSize(13).fillColor("#0f172a").text(title);
      doc.moveDown(0.35);
      doc.moveTo(left, doc.y).lineTo(right, doc.y).strokeColor("#e2e8f0").stroke();
      doc.moveDown(0.7);
    }

    function drawInfoGrid(items) {
      const cleanItems = items.filter((item) => item.value);
      const colWidth = contentWidth / 2 - 8;
      let startY = doc.y;

      cleanItems.forEach((item, index) => {
        const col = index % 2;
        const row = Math.floor(index / 2);
        const x = left + col * (colWidth + 16);
        const y = startY + row * 42;

        doc
          .roundedRect(x, y, colWidth, 32, 8)
          .fillAndStroke("#f8fafc", "#e2e8f0");

        doc
          .font("Helvetica-Bold")
          .fontSize(7)
          .fillColor("#64748b")
          .text(item.label.toUpperCase(), x + 10, y + 7, { width: colWidth - 20 });

        doc
          .font("Helvetica-Bold")
          .fontSize(9.5)
          .fillColor("#0f172a")
          .text(item.value, x + 10, y + 18, { width: colWidth - 20 });
      });

      doc.y = startY + Math.ceil(cleanItems.length / 2) * 42;
    }

    // Header
    doc
      .roundedRect(left, 36, contentWidth, 92, 18)
      .fill("#0f172a");

    doc
      .font("Helvetica-Bold")
      .fontSize(22)
      .fillColor("#ffffff")
      .text("Ficha clínica veterinaria", left + 24, 58);

    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor("#cbd5e1")
      .text(tenant.name || "Veterinaria", left + 24, 88);

    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor("#94a3b8")
      .text(`Fecha de emisión: ${new Date().toLocaleDateString("es-CL")}`, left + 24, 106);

    doc.y = 155;

    drawSectionTitle("Cliente");
    drawInfoGrid([
      { label: "Nombre", value: customer?.name },
      { label: "Teléfono", value: customer?.phone },
      { label: "Email", value: customer?.email },
    ]);

    drawSectionTitle("Mascota");
    drawInfoGrid([
      { label: "Nombre", value: pet.name },
      {
        label: "Especie",
        value:
          pet.species_base === "otro"
            ? pet.species_custom || "Otro"
            : pet.species_base,
      },
      { label: "Raza", value: pet.breed },
      { label: "Sexo", value: pet.sex },
      { label: "Peso", value: pet.weight_kg ? `${pet.weight_kg} kg` : "" },
      { label: "Esterilizado", value: pet.is_sterilized ? "Sí" : "No" },
    ]);

    drawSectionTitle("Historial clínico");

    if (!appointments || appointments.length === 0) {
      doc
        .roundedRect(left, doc.y, contentWidth, 52, 12)
        .fillAndStroke("#f8fafc", "#e2e8f0");

      doc
        .font("Helvetica")
        .fontSize(10)
        .fillColor("#64748b")
        .text("Sin atenciones registradas.", left + 16, doc.y + 18);
    } else {
      for (const appt of appointments) {
        if (doc.y > 680) {
          doc.addPage();
          doc.y = 42;
        }

        const cardY = doc.y;
        const noteText = appt.notes || "Sin notas clínicas.";
        const noteHeight = doc.heightOfString(noteText, { width: contentWidth - 32 });
        const cardHeight = Math.max(118, 96 + noteHeight);

        doc
          .roundedRect(left, cardY, contentWidth, cardHeight, 14)
          .fillAndStroke("#ffffff", "#e2e8f0");

        doc
          .font("Helvetica-Bold")
          .fontSize(10.5)
          .fillColor("#0f172a")
          .text(formatLongDate(appt.start_at), left + 16, cardY + 16, {
            width: contentWidth - 32,
          });

        doc
          .font("Helvetica")
          .fontSize(9)
          .fillColor("#64748b")
          .text(appt.service_name_snapshot || "Atención", left + 16, cardY + 33, {
            width: contentWidth - 32,
          });

        doc
          .font("Helvetica-Bold")
          .fontSize(11)
          .fillColor("#2563eb")
          .text(appt.reason || "Sin motivo registrado", left + 16, cardY + 54, {
            width: contentWidth - 32,
          });

        // NOTAS CLÍNICAS
	doc
 	 .font("Helvetica-Bold")
  	.fontSize(8)
 	 .fillColor("#64748b")
  	.text("NOTAS CLÍNICAS", left + 16, cardY + 75);

	doc
  	.moveDown(0.3);

	doc
  	.font("Helvetica")
  	.fontSize(9.5)
  	.fillColor("#334155")
  	.text(noteText, left + 16, doc.y, {
   	 width: contentWidth - 32,
  	});

// ESPACIO
doc.moveDown(0.6);

// PRÓXIMO CONTROL (más discreto)
doc
  .font("Helvetica")
  .fontSize(8.5)
  .fillColor("#64748b")
  .text(
    `Próximo control: ${
      appt.next_control_at
        ? formatLongDate(appt.next_control_at)
        : "No definido"
    }`,
    left + 16,
    doc.y,
    { width: contentWidth - 32 }
    );

        doc.y = cardY + cardHeight + 14;
      }
    }

    doc.end();
  } catch (err) {
    console.error("GET /pets/:id/clinical-pdf error:", err.message);
    return res.status(500).json({
      error: err.message || "Error generando PDF clínico",
    });
  }
});


/* ======================================================
   ✅ GET /appointments
====================================================== */
app.get("/appointments", async (req, res) => {
  try {
    const { calendar_id, from, to, status } = req.query;

    if (!calendar_id) {
      return res.status(400).json({ error: "calendar_id es obligatorio" });
    }

    let query = supabase
      .from("appointments")
      .select("*")
      .eq("calendar_id", calendar_id)
      .order("start_at", { ascending: true });

    if (status) query = query.eq("status", status);
    if (from) query = query.gte("start_at", from);
    if (to) query = query.lte("start_at", to);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    return res.json({ total: data?.length || 0, appointments: data || [] });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

async function insertCampaignDeliveryLog({
  tenantId,
  campaignHistoryId,
  channel,
  customerName = null,
  customerEmail = null,
  customerPhone = null,
  status,
  errorMessage = null,
}) {
  const payload = {
    tenant_id: tenantId,
    campaign_history_id: campaignHistoryId,
    channel,
    customer_name: customerName,
    customer_email: customerEmail,
    customer_phone: customerPhone,
    status,
    error_message: errorMessage,
    sent_at: status === "sent" ? new Date().toISOString() : null,
  };

  const { error } = await supabase
    .from("campaign_delivery_logs")
    .insert(payload);

  if (error) {
    console.error("❌ Error guardando campaign_delivery_log:", error.message);
  }
}

function normalizeCampaignError(error) {
  if (!error) return "Unknown error";
  if (typeof error === "string") return error;
  if (error.message) return error.message;

  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown error";
  }
}

/* ======================================================
   ✅ GET /customers/:slug
   Soporta búsqueda + segmentación + inactivos
====================================================== */
app.get("/customers/:slug", async (req, res) => {
  try {
    const { slug } = req.params;
    const { q, segment, inactive_days } = req.query;

    if (!slug) {
      return res.status(400).json({ error: "slug es obligatorio" });
    }

    const { data: tenant, error: tenantError } = await supabase
      .from("tenants")
      .select("id, slug")
      .eq("slug", slug)
      .eq("is_active", true)
      .single();

    if (tenantError || !tenant) {
      return res.status(404).json({ error: "Negocio no encontrado" });
    }

    const normalizedSegment = String(segment || "").trim().toLowerCase();
    const inactiveDays = Math.max(1, Number(inactive_days || 60));

    let query = supabase
      .from("customers")
      .select("*")
      .eq("tenant_id", tenant.id)
      .order("updated_at", { ascending: false })
      .limit(300);

    if (q && String(q).trim().length >= 2) {
      const search = String(q).trim().replace(/[%(),]/g, "");

      query = query.or(
        `name.ilike.%${search}%,email.ilike.%${search}%,phone.ilike.%${search}%`
      );
    }

    const { data, error } = await query;

    if (error) throw error;

    const rows = Array.isArray(data) ? data : [];
    const now = new Date();
    const inactiveCutoff = new Date(
      now.getTime() - inactiveDays * 24 * 60 * 60 * 1000
    );

    function getCustomerSegment(customer) {
      const totalVisits = Number(customer.total_visits || 0);
      const lastVisitAt = customer.last_visit_at
        ? new Date(customer.last_visit_at)
        : null;

const isInactive =
  !lastVisitAt || Number.isNaN(lastVisitAt.getTime())
    ? true
    : lastVisitAt.getTime() <= inactiveCutoff.getTime();

      if (isInactive) return "inactive";
      if (totalVisits >= 5) return "frequent";
      if (totalVisits >= 2) return "recurrent";
      return "new";
    }

    const enrichedCustomers = rows.map((customer) => {
      const customerSegment = getCustomerSegment(customer);

      return {
        ...customer,
        segment: customerSegment,
        is_inactive: customerSegment === "inactive",
      };
    });

    const filteredCustomers =
      normalizedSegment && ["new", "recurrent", "frequent", "inactive"].includes(normalizedSegment)
        ? enrichedCustomers.filter(
            (customer) => customer.segment === normalizedSegment
          )
        : enrichedCustomers;

    const summary = {
      total: enrichedCustomers.length,
      nuevos: enrichedCustomers.filter((c) => c.segment === "new").length,
      recurrentes: enrichedCustomers.filter((c) => c.segment === "recurrent").length,
      frecuentes: enrichedCustomers.filter((c) => c.segment === "frequent").length,
      inactivos: enrichedCustomers.filter((c) => c.segment === "inactive").length,
    };

    return res.json({
      total: filteredCustomers.length,
      customers: filteredCustomers,
      summary,
      filters: {
        q: q ? String(q) : "",
        segment: normalizedSegment || null,
        inactive_days: inactiveDays,
      },
    });
  } catch (err) {
    console.error("GET /customers/:slug error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});


/* ======================================================
   ✅ GET /pets/:slug
   Listar mascotas por negocio y opcionalmente por cliente
====================================================== */
app.get("/pets/:slug", async (req, res) => {
  try {
    const { slug } = req.params;
    const { customer_id, phone, email } = req.query;

    if (!slug) {
      return res.status(400).json({ error: "slug es obligatorio" });
    }

    const normalizedEmail = String(email || "").trim().toLowerCase();
    const normalizedPhoneDigits = String(phone || "").replace(/\D/g, "");

    const { data: tenant, error: tenantError } = await supabase
      .from("tenants")
      .select("id, slug")
      .eq("slug", slug)
      .eq("is_active", true)
      .single();

    if (tenantError || !tenant) {
      return res.status(404).json({ error: "Negocio no encontrado" });
    }

    let resolvedCustomerId = customer_id || null;

    if (!resolvedCustomerId && normalizedEmail) {
      const { data: customerByEmail } = await supabase
        .from("customers")
        .select("id")
        .eq("tenant_id", tenant.id)
        .eq("email", normalizedEmail)
        .limit(1)
        .maybeSingle();

      resolvedCustomerId = customerByEmail?.id || null;
    }

    if (!resolvedCustomerId && normalizedPhoneDigits) {
      const { data: customerByPhone } = await supabase
        .from("customers")
        .select("id")
        .eq("tenant_id", tenant.id)
        .ilike("phone", `%${normalizedPhoneDigits}%`)
        .limit(1)
        .maybeSingle();

      resolvedCustomerId = customerByPhone?.id || null;
    }

    if (!resolvedCustomerId) {
      return res.json({
        total: 0,
        pets: [],
        customer_found: false,
        resolved_customer_id: null,
      });
    }

    const { data, error } = await supabase
      .from("pets")
      .select("*")
      .eq("tenant_id", tenant.id)
      .eq("customer_id", resolvedCustomerId)
      .order("created_at", { ascending: false });

    if (error) throw error;

    return res.json({
      total: data?.length || 0,
      pets: data || [],
      customer_found: true,
      resolved_customer_id: resolvedCustomerId,
    });
  } catch (err) {
    console.error("GET /pets/:slug error:", err.message);
    return res.status(500).json({
      error: err.message || "Error obteniendo mascotas",
    });
  }
});


/* ======================================================
   🐾 GET /pet-followups/:slug
   Lista de próximos controles por cliente o mascota
====================================================== */
app.get("/pet-followups/:slug", async (req, res) => {
  try {
    const { slug } = req.params;
    const { customer_id, pet_id } = req.query;

    const { data: business, error: businessError } = await supabase
      .from("tenants")
      .select("id, business_category")
      .eq("slug", slug)
      .single();

    if (businessError || !business) {
      return res.status(404).json({ error: "Negocio no encontrado" });
    }

    const tenantId = business.id;

    let query = supabase
      .from("pet_followups")
      .select(`
        *,
        pets (
          id,
          name,
          species_base,
          species_custom
        )
      `)
      .eq("tenant_id", tenantId)
      .order("next_control_at", { ascending: true, nullsFirst: false });

    if (customer_id) {
      query = query.eq("customer_id", customer_id);
    }

    if (pet_id) {
      query = query.eq("pet_id", pet_id);
    }

    const { data, error } = await query;

    if (error) {
      throw error;
    }

    return res.json({
      total: data?.length || 0,
      followups: data || [],
    });
  } catch (err) {
    console.error("GET /pet-followups/:slug error:", err.message);
    return res.status(500).json({
      error: err.message || "Error obteniendo seguimientos",
    });
  }
});

/* ======================================================
   ✅ POST /pets
   Crear mascota para un cliente
====================================================== */
app.post("/pets", async (req, res) => {
  try {
    const {
      slug,
      customer_id,
      name,
      species_base,
      species_custom,
      breed,
      sex,
      weight_kg,
      is_sterilized = false,
      notes,
    } = req.body;

    if (!slug) {
      return res.status(400).json({ error: "slug es obligatorio" });
    }

    if (!customer_id) {
      return res.status(400).json({ error: "customer_id es obligatorio" });
    }

    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: "name es obligatorio" });
    }

    const normalizedSpeciesBase = String(species_base || "").trim().toLowerCase();

    if (!["perro", "gato", "otro"].includes(normalizedSpeciesBase)) {
      return res.status(400).json({
        error: "species_base inválido. Usa: perro, gato u otro",
      });
    }

    if (
      normalizedSpeciesBase === "otro" &&
      !String(species_custom || "").trim()
    ) {
      return res.status(400).json({
        error: "species_custom es obligatorio cuando species_base es 'otro'",
      });
    }

    const { data: tenant, error: tenantError } = await supabase
      .from("tenants")
      .select("id, slug")
      .eq("slug", slug)
      .eq("is_active", true)
      .single();

    if (tenantError || !tenant) {
      return res.status(404).json({ error: "Negocio no encontrado" });
    }

    const { data: customer, error: customerError } = await supabase
      .from("customers")
      .select("id, tenant_id")
      .eq("id", customer_id)
      .eq("tenant_id", tenant.id)
      .single();

    if (customerError || !customer) {
      return res.status(404).json({ error: "Cliente no encontrado para este negocio" });
    }

    let normalizedWeight = null;

    if (weight_kg !== undefined && weight_kg !== null && String(weight_kg).trim() !== "") {
      normalizedWeight = Number(weight_kg);

      if (Number.isNaN(normalizedWeight) || normalizedWeight < 0) {
        return res.status(400).json({ error: "weight_kg debe ser un número válido" });
      }
    }

    const payload = {
      tenant_id: tenant.id,
      customer_id,
      name: String(name).trim(),
      species_base: normalizedSpeciesBase,
      species_custom:
        normalizedSpeciesBase === "otro"
          ? normalizeNullablePetText(species_custom)
          : null,
      breed: normalizeNullablePetText(breed),
      sex: normalizeNullablePetText(sex),
      weight_kg: normalizedWeight,
      is_sterilized: Boolean(is_sterilized),
      notes: normalizeNullablePetText(notes),
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from("pets")
      .insert(payload)
      .select("*")
      .single();

    if (error) throw error;

    return res.status(201).json({
      ok: true,
      pet: data,
    });
  } catch (err) {
    console.error("POST /pets error:", err.message);
    return res.status(500).json({ error: err.message || "Error creando mascota" });
  }
});

/* ======================================================
   ✅ POST /campaigns/send-email
   Envío real por email usando audiencia curada desde frontend
====================================================== */
app.post("/campaigns/send-email", async (req, res) => {
  try {
    const {
      slug,
      channel = "email",
      segment,
      inactive_days = 60,
      subject,
      message,
      message_html = "",
      campaign_name,
      limit = 50,
      sort = "oldest",

      // visuales
      brand_color = "#0f766e",
      hero_image_url = "",
      hero_image_height = 260,
      hero_image_position_y = 50,
      hero_image_fit = "cover",
      cta_text = "Agendar visita",
      cta_url = "",
      show_cta = true,
      footer_note = "",
      footer_note_html = "",

      // audiencia curada
      final_recipients = [],
      excluded_recipient_ids = [],
      manual_recipients = [],
    } = req.body;

    if (!slug) {
      return res.status(400).json({ error: "slug es obligatorio" });
    }

    if (!channel) {
      return res.status(400).json({ error: "channel es obligatorio" });
    }

    if (!segment) {
      return res.status(400).json({ error: "segment es obligatorio" });
    }

    if (!subject || !String(subject).trim()) {
      return res.status(400).json({ error: "subject es obligatorio" });
    }

    if (
      (!message || !String(message).trim()) &&
      (!message_html || !String(message_html).trim())
    ) {
      return res.status(400).json({ error: "message es obligatorio" });
    }

    const normalizedChannel = String(channel).trim().toLowerCase();
    const normalizedSegment = String(segment).trim().toLowerCase();
    const inactiveDays = Math.max(1, Number(inactive_days || 60));
    const requestedLimit = Math.max(1, Number(limit || 50));
    const normalizedSort = String(sort || "oldest").trim().toLowerCase();

    if (!["email", "whatsapp"].includes(normalizedChannel)) {
      return res.status(400).json({
        error: "channel inválido. Usa: email o whatsapp",
      });
    }

    if (!["new", "recurrent", "frequent", "inactive"].includes(normalizedSegment)) {
      return res.status(400).json({
        error: "segment inválido. Usa: new, recurrent, frequent o inactive",
      });
    }

    if (
      !["oldest", "recent", "most_visits", "least_visits"].includes(normalizedSort)
    ) {
      return res.status(400).json({
        error: "sort inválido. Usa: oldest, recent, most_visits o least_visits",
      });
    }

    if (normalizedChannel !== "email") {
      return res.status(400).json({
        error: "WhatsApp aún no está habilitado para envío real desde backend",
      });
    }

    const { data: tenant, error: tenantError } = await supabase
      .from("tenants")
      .select("id, name, slug, is_active, plan_slug, plan")
      .eq("slug", slug)
      .eq("is_active", true)
      .single();

    if (tenantError || !tenant) {
      return res.status(404).json({ error: "Negocio no encontrado" });
    }

    const currentPlan = normalizePlanSlug(tenant.plan_slug || tenant.plan || "pro");
    const caps = getPlanCapabilities(currentPlan);
    const planLimit = Number(caps.max_campaign_emails_per_send || 50);

    function normalizeEmail(value) {
      return String(value || "").trim().toLowerCase();
    }

    function isValidEmail(value) {
      const email = normalizeEmail(value);
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    }

    function getCustomerSegment(customer) {
      const totalVisits = Number(customer.total_visits || 0);
      const lastVisitAt = customer.last_visit_at
        ? new Date(customer.last_visit_at)
        : null;

      const inactiveCutoff = new Date(
        Date.now() - inactiveDays * 24 * 60 * 60 * 1000
      );

      const isInactive =
        !lastVisitAt || Number.isNaN(lastVisitAt.getTime())
          ? true
          : lastVisitAt.getTime() <= inactiveCutoff.getTime();

      if (isInactive) return "inactive";
      if (totalVisits >= 5) return "frequent";
      if (totalVisits >= 2) return "recurrent";
      return "new";
    }

    function sortCustomers(list) {
      if (normalizedSort === "oldest") {
        return list.sort((a, b) => {
          const aDate = new Date(a.last_visit_at || 0).getTime();
          const bDate = new Date(b.last_visit_at || 0).getTime();
          return aDate - bDate;
        });
      }

      if (normalizedSort === "recent") {
        return list.sort((a, b) => {
          const aDate = new Date(a.last_visit_at || 0).getTime();
          const bDate = new Date(b.last_visit_at || 0).getTime();
          return bDate - aDate;
        });
      }

      if (normalizedSort === "most_visits") {
        return list.sort(
          (a, b) => Number(b.total_visits || 0) - Number(a.total_visits || 0)
        );
      }

      if (normalizedSort === "least_visits") {
        return list.sort(
          (a, b) => Number(a.total_visits || 0) - Number(b.total_visits || 0)
        );
      }

      return list;
    }

    const hasCuratedAudience =
      Array.isArray(final_recipients) && final_recipients.length > 0;

    let audienceTotal = 0;
    let emailAudience = [];
    let sent = 0;
    const errors = [];

    if (hasCuratedAudience) {
      const excludedIds = new Set(
        Array.isArray(excluded_recipient_ids)
          ? excluded_recipient_ids.map((id) => String(id))
          : []
      );

      const dedupeMap = new Map();

      for (const recipient of final_recipients) {
        const recipientId = String(recipient?.id || "");
        const email = normalizeEmail(recipient?.email || "");

        if (!email || !isValidEmail(email)) continue;
        if (recipientId && excludedIds.has(recipientId)) continue;

        if (!dedupeMap.has(email)) {
          dedupeMap.set(email, {
            id: recipientId || null,
            customer_id:
              recipient?.source === "segment" && recipientId.startsWith("segment:")
                ? recipientId.replace("segment:", "")
                : null,
            source: recipient?.source || "segment",
            name: String(recipient?.name || "cliente").trim(),
            email,
            phone: recipient?.phone ? String(recipient.phone).trim() : null,
          });
        }
      }

      audienceTotal = Array.isArray(final_recipients) ? final_recipients.length : 0;

      const appliedLimit = Math.min(requestedLimit, planLimit);
      emailAudience = Array.from(dedupeMap.values()).slice(0, appliedLimit);

      if (emailAudience.length === 0) {
        return res.status(400).json({
          error: "No hay destinatarios con email válido en la audiencia curada",
        });
      }

      const { data: historyRow, error: historyError } = await supabase
        .from("campaign_history")
        .insert({
          tenant_id: tenant.id,
          campaign_name: campaign_name ? String(campaign_name).trim() : null,
          channel: "email",
          segment: normalizedSegment,
          inactive_days: inactiveDays,
          subject: String(subject).trim(),
          message: String(message || "").trim(),
          sort: normalizedSort,
          plan_slug: currentPlan,
          plan_limit: planLimit,
          requested_limit: requestedLimit,
          applied_limit: emailAudience.length,
          audience_total: audienceTotal,
          recipients_with_contact: emailAudience.length,
          sent_count: 0,
          failed_count: 0,
        })
        .select("id")
        .single();

      if (historyError || !historyRow) {
        console.error("❌ Error creando campaign_history:", historyError?.message);
        return res.status(500).json({ error: "No se pudo crear el historial de campaña" });
      }

      const campaignHistoryId = historyRow.id;

      for (const customer of emailAudience) {
        try {
          const customerName = customer.name || "cliente";

          const personalizedMessage = String(message || "")
            .replace(/\{\{\s*nombre\s*\}\}/gi, customerName);

          const personalizedMessageHtml = String(message_html || "")
            .replace(/\{\{\s*nombre\s*\}\}/gi, customerName);

          const personalizedFooter = String(
            footer_note ||
              `Este correo fue enviado por ${tenant.name || "Orbyx"} a través de Orbyx.`
          ).replace(/\{\{\s*nombre\s*\}\}/gi, customerName);

          const personalizedFooterHtml = String(footer_note_html || "")
            .replace(/\{\{\s*nombre\s*\}\}/gi, customerName);

          const template = buildCampaignEmailTemplate({
            businessName: tenant.name || "Orbyx",
            subject: String(subject).trim(),
            message: personalizedMessage,
            messageHtml: personalizedMessageHtml,
            brandColor: String(brand_color || "#0f766e").trim(),
            heroImageUrl: String(hero_image_url || "").trim(),
            heroImageHeight: Number(hero_image_height || 260),
            heroImagePositionY: Number(hero_image_position_y || 50),
            heroImageFit: String(hero_image_fit || "cover").trim(),
            ctaText: String(cta_text || "Agendar visita").trim(),
            ctaUrl: String(cta_url || "").trim(),
            showCta: Boolean(show_cta),
            footerNote: personalizedFooter,
            footerNoteHtml: personalizedFooterHtml,
          });

          await sendCampaignEmail({
            to: customer.email,
            subject: String(subject).trim(),
            html: template.html,
            text: template.text,
          });

          sent++;

          await insertCampaignDeliveryLog({
            tenantId: tenant.id,
            campaignHistoryId,
            channel: "email",
            customerName,
            customerEmail: customer.email,
            customerPhone: customer.phone || null,
            status: "sent",
          });
        } catch (error) {
          const normalizedError = normalizeCampaignError(error);

          errors.push({
            customer_id: customer.customer_id,
            email: customer.email,
            error: normalizedError,
          });

          await insertCampaignDeliveryLog({
            tenantId: tenant.id,
            campaignHistoryId,
            channel: "email",
            customerName: customer.name || "cliente",
            customerEmail: customer.email,
            customerPhone: customer.phone || null,
            status: "failed",
            errorMessage: normalizedError,
          });
        }
      }

      await supabase
        .from("campaign_history")
        .update({
          sent_count: sent,
          failed_count: errors.length,
        })
        .eq("id", campaignHistoryId);

      return res.json({
        ok: true,
        campaign_history_id: campaignHistoryId,
        campaign_name: campaign_name ? String(campaign_name).trim() : null,
        channel: "email",
        slug,
        plan: currentPlan,
        plan_limit: planLimit,
        requested_limit: requestedLimit,
        applied_limit: emailAudience.length,
        sort: normalizedSort,
        segment: normalizedSegment,
        inactive_days: inactiveDays,
        audience_total: audienceTotal,
        recipients_with_email: emailAudience.length,
        sent,
        failed: errors.length,
        errors,
        used_curated_audience: true,
      });
    }

    const appliedLimit = Math.min(requestedLimit, planLimit);

    const { data: customers, error: customersError } = await supabase
      .from("customers")
      .select("*")
      .eq("tenant_id", tenant.id)
      .order("updated_at", { ascending: false })
      .limit(1000);

    if (customersError) {
      throw customersError;
    }

    const rows = Array.isArray(customers) ? customers : [];

    const audience = rows.filter((customer) => {
      const customerSegment = getCustomerSegment(customer);
      return customerSegment === normalizedSegment;
    });

    const sortedAudience = sortCustomers([...audience]);
    const limitedAudience = sortedAudience.slice(0, appliedLimit);

    emailAudience = limitedAudience.filter(
      (customer) => customer.email && isValidEmail(customer.email)
    );

    if (emailAudience.length === 0) {
      return res.status(400).json({
        error: "No hay clientes con email disponible para este segmento",
      });
    }

    const { data: historyRow, error: historyError } = await supabase
      .from("campaign_history")
      .insert({
        tenant_id: tenant.id,
        campaign_name: campaign_name ? String(campaign_name).trim() : null,
        channel: "email",
        segment: normalizedSegment,
        inactive_days: inactiveDays,
        subject: String(subject).trim(),
        message: String(message || "").trim(),
        sort: normalizedSort,
        plan_slug: currentPlan,
        plan_limit: planLimit,
        requested_limit: requestedLimit,
        applied_limit: appliedLimit,
        audience_total: audience.length,
        recipients_with_contact: emailAudience.length,
        sent_count: 0,
        failed_count: 0,
      })
      .select("id")
      .single();

    if (historyError || !historyRow) {
      console.error("❌ Error creando campaign_history:", historyError?.message);
      return res.status(500).json({ error: "No se pudo crear el historial de campaña" });
    }

    const campaignHistoryId = historyRow.id;

    for (const customer of emailAudience) {
      try {
        const customerName = customer.name || "cliente";

        const personalizedMessage = String(message || "")
          .replace(/\{\{\s*nombre\s*\}\}/gi, customerName);

        const personalizedMessageHtml = String(message_html || "")
          .replace(/\{\{\s*nombre\s*\}\}/gi, customerName);

        const personalizedFooter = String(
          footer_note ||
            `Este correo fue enviado por ${tenant.name || "Orbyx"} a través de Orbyx.`
        ).replace(/\{\{\s*nombre\s*\}\}/gi, customerName);

        const personalizedFooterHtml = String(footer_note_html || "")
          .replace(/\{\{\s*nombre\s*\}\}/gi, customerName);

        const template = buildCampaignEmailTemplate({
          businessName: tenant.name || "Orbyx",
          subject: String(subject).trim(),
          message: personalizedMessage,
          messageHtml: personalizedMessageHtml,
          brandColor: String(brand_color || "#0f766e").trim(),
          heroImageUrl: String(hero_image_url || "").trim(),
          heroImageHeight: Number(hero_image_height || 260),
          heroImagePositionY: Number(hero_image_position_y || 50),
          heroImageFit: String(hero_image_fit || "cover").trim(),
          ctaText: String(cta_text || "Agendar visita").trim(),
          ctaUrl: String(cta_url || "").trim(),
          showCta: Boolean(show_cta),
          footerNote: personalizedFooter,
          footerNoteHtml: personalizedFooterHtml,
        });

        await sendCampaignEmail({
          to: String(customer.email).trim().toLowerCase(),
          subject: String(subject).trim(),
          html: template.html,
          text: template.text,
        });

        sent++;

        await insertCampaignDeliveryLog({
          tenantId: tenant.id,
          campaignHistoryId,
          channel: "email",
          customerName,
          customerEmail: String(customer.email).trim().toLowerCase(),
          customerPhone: customer.phone ? String(customer.phone).trim() : null,
          status: "sent",
        });
      } catch (error) {
        const normalizedError = normalizeCampaignError(error);

        errors.push({
          customer_id: customer.id,
          email: customer.email,
          error: normalizedError,
        });

        await insertCampaignDeliveryLog({
          tenantId: tenant.id,
          campaignHistoryId,
          channel: "email",
          customerName: customer.name || "cliente",
          customerEmail: customer.email ? String(customer.email).trim().toLowerCase() : null,
          customerPhone: customer.phone ? String(customer.phone).trim() : null,
          status: "failed",
          errorMessage: normalizedError,
        });
      }
    }

    await supabase
      .from("campaign_history")
      .update({
        sent_count: sent,
        failed_count: errors.length,
      })
      .eq("id", campaignHistoryId);

    return res.json({
      ok: true,
      campaign_history_id: campaignHistoryId,
      campaign_name: campaign_name ? String(campaign_name).trim() : null,
      channel: "email",
      slug,
      plan: currentPlan,
      plan_limit: planLimit,
      requested_limit: requestedLimit,
      applied_limit: appliedLimit,
      sort: normalizedSort,
      segment: normalizedSegment,
      inactive_days: inactiveDays,
      audience_total: audience.length,
      recipients_with_email: emailAudience.length,
      sent,
      failed: errors.length,
      errors,
      used_curated_audience: false,
    });
  } catch (err) {
    console.error("POST /campaigns/send-email error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   ✅ POST /campaigns/save-whatsapp
   Guarda campaña WhatsApp mock en historial
====================================================== */
app.post("/campaigns/save-whatsapp", async (req, res) => {
  try {
    const {
      slug,
      channel = "whatsapp",
      campaign_name,
      segment,
      inactive_days = 60,
      subject = null,
      message,
      sort = "oldest",
      plan,
      plan_limit,
      requested_limit,
      applied_limit,
      audience_total,
      recipients_with_contact,
      sent_count = 0,
      failed_count = 0,
      final_recipients = [],
    } = req.body;

    if (!slug) {
      return res.status(400).json({ error: "slug es obligatorio" });
    }

    if (!segment) {
      return res.status(400).json({ error: "segment es obligatorio" });
    }

    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: "message es obligatorio" });
    }

    const normalizedChannel = String(channel || "whatsapp").trim().toLowerCase();
    const normalizedSegment = String(segment).trim().toLowerCase();
    const normalizedSort = String(sort || "oldest").trim().toLowerCase();
    const normalizedPlan = normalizePlanSlug(plan || "pro");

    if (normalizedChannel !== "whatsapp") {
      return res.status(400).json({
        error: "Este endpoint solo permite guardar campañas de WhatsApp",
      });
    }

    if (!["new", "recurrent", "frequent", "inactive"].includes(normalizedSegment)) {
      return res.status(400).json({
        error: "segment inválido. Usa: new, recurrent, frequent o inactive",
      });
    }

    if (
      !["oldest", "recent", "most_visits", "least_visits"].includes(normalizedSort)
    ) {
      return res.status(400).json({
        error: "sort inválido. Usa: oldest, recent, most_visits o least_visits",
      });
    }

    const { data: tenant, error: tenantError } = await supabase
      .from("tenants")
      .select("id, name, slug, is_active, plan_slug, plan")
      .eq("slug", slug)
      .eq("is_active", true)
      .single();

    if (tenantError || !tenant) {
      return res.status(404).json({ error: "Negocio no encontrado" });
    }

    const currentPlan = normalizePlanSlug(tenant.plan_slug || tenant.plan || normalizedPlan);

    const { data: historyRow, error: historyError } = await supabase
      .from("campaign_history")
      .insert({
        tenant_id: tenant.id,
        campaign_name: campaign_name ? String(campaign_name).trim() : null,
        channel: "whatsapp",
        segment: normalizedSegment,
        inactive_days: Math.max(1, Number(inactive_days || 60)),
        subject: null,
        message: String(message).trim(),
        sort: normalizedSort,
        plan_slug: currentPlan,
        plan_limit: Number(plan_limit || 0),
        requested_limit: Number(requested_limit || 0),
        applied_limit: Number(applied_limit || 0),
        audience_total: Number(audience_total || 0),
        recipients_with_contact: Number(recipients_with_contact || 0),
        sent_count: Number(sent_count || 0),
        failed_count: Number(failed_count || 0),
      })
      .select("id")
      .single();

    if (historyError || !historyRow) {
      console.error("❌ Error creando campaign_history whatsapp:", historyError?.message);
      return res.status(500).json({
        error: "No se pudo guardar el historial de campaña WhatsApp",
      });
    }

    const campaignHistoryId = historyRow.id;

    if (Array.isArray(final_recipients) && final_recipients.length > 0) {
      for (const recipient of final_recipients) {
const phone = String(
  recipient?.phone || recipient?.telefono || ""
).trim();

const email = String(
  recipient?.email || ""
).trim().toLowerCase();

const name = String(
  recipient?.name || recipient?.nombre || "Sin nombre"
).trim();

        const hasPhone = !!phone;

        await insertCampaignDeliveryLog({
          tenantId: tenant.id,
          campaignHistoryId,
          channel: "whatsapp",
          customerName: name,
          customerEmail: email || null,
          customerPhone: phone || null,
          status: hasPhone ? "sent" : "failed",
          errorMessage: hasPhone ? null : "Destinatario sin teléfono",
        });
      }
    }

    return res.json({
      ok: true,
      campaign_history_id: campaignHistoryId,
      campaign_name: campaign_name ? String(campaign_name).trim() : null,
      channel: "whatsapp",
      slug,
      plan: currentPlan,
      plan_limit: Number(plan_limit || 0),
      requested_limit: Number(requested_limit || 0),
      applied_limit: Number(applied_limit || 0),
      sort: normalizedSort,
      segment: normalizedSegment,
      inactive_days: Math.max(1, Number(inactive_days || 60)),
      audience_total: Number(audience_total || 0),
      recipients_with_contact: Number(recipients_with_contact || 0),
      sent: Number(sent_count || 0),
      failed: Number(failed_count || 0),
    });
  } catch (err) {
    console.error("POST /campaigns/save-whatsapp error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   📊 GET /campaigns/history/:slug
====================================================== */
app.get("/campaigns/history/:slug", async (req, res) => {
  try {
    const { slug } = req.params;

    if (!slug) {
      return res.status(400).json({ error: "slug es obligatorio" });
    }

    const { data: tenant, error: tenantError } = await supabase
      .from("tenants")
      .select("id")
      .eq("slug", slug)
      .single();

    if (tenantError || !tenant) {
      return res.status(404).json({ error: "Negocio no encontrado" });
    }

    const { data, error } = await supabase
      .from("campaign_history")
      .select("*")
      .eq("tenant_id", tenant.id)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) throw error;

    return res.json({
      total: data?.length || 0,
      campaigns: data || [],
    });
  } catch (err) {
    console.error("GET /campaigns/history error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.get("/campaigns/logs/:campaignId", async (req, res) => {
  try {
    const { campaignId } = req.params;

    if (!campaignId) {
      return res.status(400).json({ error: "campaignId requerido" });
    }

    const { data, error } = await supabase
      .from("campaign_delivery_logs")
      .select(`
  id,
  customer_name,
  customer_email,
  customer_phone,
  status,
  error_message,
  created_at
`)
      .eq("campaign_history_id", campaignId)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Error fetching campaign logs:", error);
      return res.status(500).json({ error: "Error obteniendo logs" });
    }

    return res.json({
      logs: data || [],
    });
  } catch (err) {
    console.error("Unexpected error logs:", err);
    return res.status(500).json({ error: "Error inesperado" });
  }
});

/* ======================================================
   ✅ POST /appointments/:id/close
   Cierre atendido con control veterinario
====================================================== */
app.post("/appointments/:id/close", async (req, res) => {
  try {
    const { id } = req.params;

    const {
      control_type,
      control_note,
next_control_mode = "none",
next_control_exact_date = null,
next_control_custom_value = null,
next_control_custom_unit = null,
    } = req.body || {};

    if (!id) {
      return res.status(400).json({ error: "id es obligatorio" });
    }

    const normalizedControlType = String(control_type || "").trim();

    if (!normalizedControlType) {
      return res.status(400).json({
        error: "control_type es obligatorio",
      });
    }

    const { data: appointment, error: appointmentError } = await supabase
      .from("appointments")
      .select(`
        id,
        tenant_id,
        customer_id,
        pet_id,
        staff_id,
        start_at,
        status
      `)
      .eq("id", id)
      .single();

    if (appointmentError || !appointment) {
      return res.status(404).json({ error: "Reserva no encontrada" });
    }

    const { data: tenant, error: tenantError } = await supabase
      .from("tenants")
      .select("id, business_category")
      .eq("id", appointment.tenant_id)
      .single();

    if (tenantError || !tenant) {
      return res.status(404).json({ error: "Negocio no encontrado" });
    }

    const businessCategory = String(tenant.business_category || "")
      .trim()
      .toLowerCase();

    if (!["veterinaria", "vet"].includes(businessCategory)) {
      return res.status(400).json({
        error: "Este cierre con control solo está disponible para negocios veterinaria",
      });
    }

    if (!appointment.pet_id) {
      return res.status(400).json({
        error: "La reserva no tiene mascota asociada",
      });
    }

    if (String(appointment.status || "").toLowerCase() === "canceled") {
      return res.status(400).json({
        error: "No puedes cerrar una reserva cancelada",
      });
    }

const nextControl = resolveNextControlDate({
  baseDate: appointment.start_at,
  next_control_mode,
  next_control_exact_date,
  next_control_custom_value,
  next_control_custom_unit,
});

    const followupPayload = {
      tenant_id: appointment.tenant_id,
      appointment_id: appointment.id,
      customer_id: appointment.customer_id || null,
      pet_id: appointment.pet_id,
      staff_id: appointment.staff_id || null,
      control_type: normalizedControlType,
      control_note: normalizeNullablePetText(control_note),
      next_control_at: nextControl.next_control_at,
      next_control_label: nextControl.next_control_label,
      updated_at: new Date().toISOString(),
    };

    const { data: followup, error: followupError } = await supabase
      .from("pet_followups")
      .insert(followupPayload)
      .select("*")
      .single();

    if (followupError) {
      throw followupError;
    }

    const { data: updatedAppointment, error: updateAppointmentError } = await supabase
  .from("appointments")
  .update({
    status: "completed",
    reason: normalizedControlType,
    notes: normalizeNullablePetText(control_note),
    next_control_at: nextControl.next_control_at,
  })
      .eq("id", appointment.id)
      .select("*")
      .single();

    if (updateAppointmentError) {
      throw updateAppointmentError;
    }

    return res.json({
      ok: true,
      appointment: updatedAppointment,
      followup,
    });
  } catch (err) {
    console.error("POST /appointments/:id/close error:", err.message);
    return res.status(500).json({ error: err.message || "Error cerrando atención" });
  }
});

/* ======================================================
   ✅ PATCH /appointments/:id/status
====================================================== */
app.patch("/appointments/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const allowed = ["booked", "completed", "no_show", "canceled"];

    if (!allowed.includes(status)) {
      return res.status(400).json({ error: "Estado inválido" });
    }

    const { data, error } = await supabase
  .from("appointments")
  .update({
    status,
  })
  .eq("id", id)
  .select()
  .single();

if (error) throw error;

if (data?.customer_id) {
  await recalculateCustomerStats(data.customer_id);
}

return res.json({
  ok: true,
  appointment: data,
});
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   ✅ CANCEL (DELETE y POST compat)
====================================================== */
async function cancelById(id, token, res) {
  const { data: appt, error: apptErr } = await supabase
    .from("appointments")
    .select("*")
    .eq("id", id)
    .single();

  if (apptErr || !appt) {
    return res.status(404).json({ error: "Appointment no encontrado" });
  }

  if (!token || !appt.cancel_token || token !== appt.cancel_token) {
    return res.status(403).json({
      error: "Token inválido para cancelar esta reserva",
    });
  }

  const st = String(appt.status).toLowerCase();

if (st === "canceled" || st === "cancelled") {
  return res.status(409).json({
    error: "Esta reserva ya fue cancelada previamente.",
    already_canceled: true,
    appointment: appt,
  });
}

  if (appt.event_id) {
    try {
      const { calendar, googleCalendarId } =
        await getGoogleCalendarClientByCalendarId(appt.calendar_id);

      await calendar.events.delete({
        calendarId: googleCalendarId,
        eventId: appt.event_id,
      });
    } catch (e) {
      console.error("⚠️ Error borrando evento en Google:", e.message);
    }
  }

const { data: updated, error: updErr } = await supabase
  .from("appointments")
  .update({
    status: "canceled",
    canceled_at: new Date().toISOString(),
  })
  .eq("id", id)
  .select("*")
  .single();

if (updErr) return res.status(500).json({ error: updErr.message });

if (updated?.customer_id) {
  await recalculateCustomerStats(updated.customer_id);
}

return res.json({ ok: true, canceled: true, appointment: updated });
}

app.post("/appointments/:id", async (req, res) => {
  try {
    return await cancelById(req.params.id, req.query.token, res);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.delete("/appointments/:id", async (req, res) => {
  try {
    return await cancelById(req.params.id, req.query.token, res);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   🔎 GET /appointments/:id (info pública para cancelación)
====================================================== */
app.get("/appointments/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { token } = req.query;

    const { data: appt, error } = await supabase
      .from("appointments")
      .select("*")
      .eq("id", id)
      .single();

    if (error || !appt) {
      return res.status(404).json({ error: "Reserva no encontrada" });
    }

    if (!token || token !== appt.cancel_token) {
      return res.status(403).json({ error: "Token inválido" });
    }

    return res.json({
      service: appt.service_name_snapshot,
      start_at: appt.start_at,
      location: appt.location_text || null,
      status: appt.status,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   🔎 SEARCH APPOINTMENTS (nuevo)
====================================================== */

app.get("/appointments/search/:slug", async (req, res) => {
  try {
    const { slug } = req.params;
    const { q, branch_id, staff_id } = req.query;

    if (!slug) {
      return res.status(400).json({ error: "slug requerido" });
    }

    if (!q || String(q).trim().length < 2) {
      return res.status(400).json({
        error: "Debes ingresar al menos 2 caracteres para buscar",
      });
    }

    const search = String(q).trim().toLowerCase();

    const { data: tenant, error: tenantError } = await supabase
      .from("tenants")
      .select("id")
      .eq("slug", slug)
      .single();

    if (tenantError || !tenant) {
      return res.status(404).json({ error: "Negocio no encontrado" });
    }

    const escapedSearch = search.replace(/[%(),]/g, "");

    let query = supabase
      .from("appointments")
      .select("*")
      .eq("tenant_id", tenant.id)
      .or(
        `customer_name.ilike.%${escapedSearch}%,customer_email.ilike.%${escapedSearch}%,customer_phone.ilike.%${escapedSearch}%`
      )
      .order("start_at", { ascending: false })
      .limit(20);

    if (branch_id) {
      query = query.eq("branch_id", branch_id);
    }

    if (staff_id) {
      query = query.eq("staff_id", staff_id);
    }

    const { data, error } = await query;

    if (error) throw error;

    return res.json({
      total: data?.length || 0,
      appointments: data || [],
    });
  } catch (err) {
    console.error("SEARCH appointments error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   ✏️ UPDATE APPOINTMENT (editar cliente)
====================================================== */
app.patch("/appointments/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const {
      customer_name,
      customer_email,
      customer_phone,
    } = req.body;

    if (!id) {
      return res.status(400).json({ error: "id es obligatorio" });
    }

    const updateData = {};

    if (customer_name !== undefined) {
      updateData.customer_name = String(customer_name).trim();
    }

    if (customer_email !== undefined) {
      updateData.customer_email = String(customer_email)
        .trim()
        .toLowerCase();
    }

    if (customer_phone !== undefined) {
      updateData.customer_phone = String(customer_phone).trim();
    }

    const { data, error } = await supabase
      .from("appointments")
      .update(updateData)
      .eq("id", id)
      .select("*")
      .single();

    if (error) throw error;

    return res.json({
      ok: true,
      appointment: data,
    });
  } catch (err) {
    console.error("UPDATE appointment error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   ✅ PATCH /calendars/:id/slot-minutes
====================================================== */
app.patch("/calendars/:id/slot-minutes", async (req, res) => {
  try {
    const { id } = req.params;
    const { slot_minutes } = req.body;

    if (!id) {
      return res.status(400).json({ error: "calendar id es obligatorio" });
    }

    const normalizedSlotMinutes = Number(slot_minutes || 30);

    if (
      !Number.isInteger(normalizedSlotMinutes) ||
      normalizedSlotMinutes < 5 ||
      normalizedSlotMinutes > 180
    ) {
      return res.status(400).json({
        error: "slot_minutes debe ser un número entre 5 y 180",
      });
    }

    const { data, error } = await supabase
      .from("calendars")
      .update({
        slot_minutes: normalizedSlotMinutes,
      })
      .eq("id", id)
      .select("id, slot_minutes")
      .single();

    if (error) throw error;

    return res.json({
      ok: true,
      calendar: data,
    });
  } catch (err) {
    console.error("PATCH /calendars/:id/slot-minutes error:", err.message);
    return res.status(500).json({
      error: err.message || "Error guardando intervalo",
    });
  }
});


/* ======================================================
   🔹 HEALTHCHECK
====================================================== */
app.get("/_ping", (req, res) => {
  res.send("pong ✅");
});

/* ======================================================
   ✅ SAAS: Provision tenant + owner user + main calendar
====================================================== */
app.post("/tenants/provision", async (req, res) => {
  try {
    const { user_id, email, plan } = req.body;

    if (!user_id || !email || !plan) {
      return res.status(400).json({ error: "Faltan campos: user_id, email, plan" });
    }

    const baseSlug = String(email).split("@")[0] || "tenant";
    const cleanBase =
      baseSlug
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 30) || "tenant";

    const suffix = Math.random().toString(16).slice(2, 8);
    const slug = `${cleanBase}-${suffix}`;

const billing_cycle_start = new Date().toISOString();
const billing_cycle_end = addOneMonth(new Date()).toISOString();

const { data: tenant, error: tenantError } = await supabase
  .from("tenants")
  .insert({
    name: email,
    slug,
    plan_slug: normalizePlanSlug(plan),
    billing_cycle_start,
    billing_cycle_end,
    scheduled_plan_slug: null,
    scheduled_change_at: null,
    pending_change_type: null,
    proration_credit: 0,
    proration_charge: 0,
  })
  .select()
  .single();

    if (tenantError) throw tenantError;

    const { error: userError } = await supabase.from("tenant_users").insert({
      user_id,
      tenant_id: tenant.id,
      role: "owner",
    });

    if (userError) throw userError;

    const { data: calendar, error: calendarError } = await supabase
      .from("calendars")
      .insert({
        tenant_id: tenant.id,
        name: "Agenda Principal",
        timezone: "America/Santiago",
        is_active: true,
        slot_minutes: 30,
        buffer_minutes: 0,
      })
      .select()
      .single();

    if (calendarError) throw calendarError;

    return res.json({
      ok: true,
      tenant_id: tenant.id,
      calendar_id: calendar.id,
    });
  } catch (err) {
    console.error("Provision failed:", err);
    return res.status(500).json({ error: "Provision failed", detail: err.message });
  }
});

/* ======================================================
   ✅ GET /billing/preview-change
====================================================== */
app.get("/billing/preview-change", async (req, res) => {
  try {
    const { tenant_id, new_plan } = req.query;

    if (!tenant_id) {
      return res.status(400).json({ error: "tenant_id es obligatorio" });
    }

    if (!new_plan) {
      return res.status(400).json({ error: "new_plan es obligatorio" });
    }

    const subscription = await getTenantSubscriptionRow(tenant_id);
    const targetPlan = normalizePlanSlug(new_plan);

    if (subscription.currentPlan === targetPlan) {
      return res.json({
        ok: true,
        change_type: "same_plan",
        current_plan: subscription.currentPlan,
        new_plan: targetPlan,
        amount_today: 0,
        message: "Ya estás en este plan",
        billing_cycle_end: subscription.billingEnd.toISOString(),
      });
    }

    if (isUpgradePlanChange(subscription.currentPlan, targetPlan)) {
      const proration = calculateProration({
        currentPlan: subscription.currentPlan,
        newPlan: targetPlan,
        billingEnd: subscription.billingEnd,
      });

      return res.json({
        ok: true,
        change_type: "upgrade",
        current_plan: subscription.currentPlan,
        new_plan: targetPlan,
        amount_today: proration.amount_today,
        credit: proration.credit,
        charge: proration.charge,
        days_remaining: proration.days_remaining,
        billing_cycle_end: subscription.billingEnd.toISOString(),
        message: "El upgrade se aplicará de inmediato con prorrateo",
      });
    }

    return res.json({
      ok: true,
      change_type: "downgrade",
      current_plan: subscription.currentPlan,
      new_plan: targetPlan,
      amount_today: 0,
      billing_cycle_end: subscription.billingEnd.toISOString(),
      scheduled_change_at: subscription.billingEnd.toISOString(),
      message: "El downgrade quedará programado para el siguiente ciclo",
    });
  } catch (err) {
    console.error("GET /billing/preview-change error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   ✅ POST /billing/change-plan
====================================================== */
app.post("/billing/change-plan", async (req, res) => {
  try {
    const { tenant_id, new_plan } = req.body;

    if (!tenant_id) {
      return res.status(400).json({ error: "tenant_id es obligatorio" });
    }

    if (!new_plan) {
      return res.status(400).json({ error: "new_plan es obligatorio" });
    }

    const subscription = await getTenantSubscriptionRow(tenant_id);
    const targetPlan = normalizePlanSlug(new_plan);

    if (subscription.currentPlan === targetPlan) {
      return res.status(400).json({
        error: "El negocio ya está en ese plan",
      });
    }

    if (isUpgradePlanChange(subscription.currentPlan, targetPlan)) {
      const proration = calculateProration({
        currentPlan: subscription.currentPlan,
        newPlan: targetPlan,
        billingEnd: subscription.billingEnd,
      });

      const { data, error } = await supabase
        .from("tenants")
        .update({
          plan_slug: targetPlan,
          scheduled_plan_slug: null,
          scheduled_change_at: null,
          pending_change_type: null,
          proration_credit: proration.credit,
          proration_charge: proration.charge,
        })
        .eq("id", tenant_id)
        .select(`
          id,
          plan_slug,
          billing_cycle_start,
          billing_cycle_end,
          scheduled_plan_slug,
          scheduled_change_at,
          pending_change_type,
          proration_credit,
          proration_charge
        `)
        .single();

      if (error) throw error;

      return res.json({
        ok: true,
        applied: true,
        change_type: "upgrade",
        amount_today: proration.amount_today,
        credit: proration.credit,
        charge: proration.charge,
        tenant: data,
        message: "Upgrade aplicado de inmediato con prorrateo",
      });
    }

    const { data, error } = await supabase
      .from("tenants")
      .update({
        scheduled_plan_slug: targetPlan,
        scheduled_change_at: subscription.billingEnd.toISOString(),
        pending_change_type: "downgrade",
      })
      .eq("id", tenant_id)
      .select(`
        id,
        plan_slug,
        billing_cycle_start,
        billing_cycle_end,
        scheduled_plan_slug,
        scheduled_change_at,
        pending_change_type
      `)
      .single();

    if (error) throw error;

    return res.json({
      ok: true,
      applied: false,
      change_type: "downgrade",
      amount_today: 0,
      tenant: data,
      message: "Downgrade programado para el siguiente ciclo",
    });
  } catch (err) {
    console.error("POST /billing/change-plan error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   ✅ POST /billing/apply-scheduled-changes
   Lo puedes disparar manualmente o desde cron
====================================================== */
app.post("/billing/apply-scheduled-changes", async (req, res) => {
  try {
    const nowIso = new Date().toISOString();

    const { data: tenantsToApply, error: fetchError } = await supabase
      .from("tenants")
      .select(`
        id,
        plan_slug,
        billing_cycle_start,
        billing_cycle_end,
        scheduled_plan_slug,
        scheduled_change_at,
        pending_change_type
      `)
      .not("scheduled_plan_slug", "is", null)
      .not("scheduled_change_at", "is", null)
      .lte("scheduled_change_at", nowIso);

    if (fetchError) throw fetchError;

    let applied = 0;

    for (const tenant of tenantsToApply || []) {
      const newStart = new Date();
      const newEnd = addOneMonth(newStart);

      const { error: updateError } = await supabase
        .from("tenants")
        .update({
          plan_slug: normalizePlanSlug(tenant.scheduled_plan_slug),
          billing_cycle_start: newStart.toISOString(),
          billing_cycle_end: newEnd.toISOString(),
          scheduled_plan_slug: null,
          scheduled_change_at: null,
          pending_change_type: null,
          proration_credit: 0,
          proration_charge: 0,
        })
        .eq("id", tenant.id);

      if (updateError) throw updateError;

      applied++;
    }

    return res.json({
      ok: true,
      applied,
    });
  } catch (err) {
    console.error("POST /billing/apply-scheduled-changes error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   ✅ PATCH /tenants/:id
====================================================== */

app.patch("/tenants/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const {
      name,
      phone,
      address,
      email,
      whatsapp,
      instagram_url,
      facebook_url,
      description,
      min_booking_notice_minutes,
      max_booking_days_ahead,
    } = req.body;

    if (!id) {
      return res.status(400).json({ error: "id es obligatorio" });
    }

    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: "name es obligatorio" });
    }

    const normalizedMinBookingNoticeMinutes = Math.max(
      0,
      Number(min_booking_notice_minutes || 0)
    );

    const normalizedMaxBookingDaysAhead = Math.max(
      1,
      Number(max_booking_days_ahead || 60)
    );

    const { data, error } = await supabase
      .from("tenants")
      .update({
        name: String(name).trim(),
        phone: phone ? String(phone).trim() : null,
        address: address ? String(address).trim() : null,
        email: email ? String(email).trim() : null,
        whatsapp: whatsapp ? String(whatsapp).trim() : null,
        instagram_url: instagram_url ? String(instagram_url).trim() : null,
        facebook_url: facebook_url ? String(facebook_url).trim() : null,
        description: description ? String(description).trim() : null,
        min_booking_notice_minutes: normalizedMinBookingNoticeMinutes,
        max_booking_days_ahead: normalizedMaxBookingDaysAhead,
      })
      .eq("id", id)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json({
      ok: true,
      tenant: data,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   ✅ GET /branches
====================================================== */
app.get("/branches", async (req, res) => {
  try {
    const { tenant_id } = req.query;

    if (!tenant_id) {
      return res.status(400).json({ error: "tenant_id es obligatorio" });
    }

    const { data, error } = await supabase
      .from("branches")
      .select("*")
      .eq("tenant_id", tenant_id)
      .order("created_at", { ascending: true });

    if (error) throw error;

    return res.json({
      total: data?.length || 0,
      branches: data || [],
    });
  } catch (err) {
    console.error("GET /branches error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   ✅ POST /branches
====================================================== */

app.post("/branches", async (req, res) => {
  try {
    const { tenant_id, name } = req.body;

    if (!tenant_id || !name) {
      return res.status(400).json({
        error: "tenant_id y name son obligatorios",
      });
    }

    // 🔥 VALIDACIÓN PLAN (AQUÍ ESTÁ LO NUEVO)
    const plan = await getPlan(tenant_id);
    const caps = getPlanCapabilities(plan);
    const branchesCount = await getBranchesCount(tenant_id);

    if (branchesCount >= caps.max_branches) {
      return res.status(403).json({
        error: "Límite de sucursales alcanzado",
        upgrade_required: true,
      });
    }

    const { data, error } = await supabase
      .from("branches")
      .insert({
        tenant_id,
        name: String(name).trim(),
        is_active: true,
      })
      .select()
      .single();

    if (error) {
      console.error("POST /branches supabase error:", error);
      return res.status(500).json({ error: error.message });
    }

    return res.status(201).json({
      ok: true,
      branch: data,
    });
  } catch (err) {
    console.error("POST /branches server error:", err);
    return res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   ✅ PATCH /branches/:id
====================================================== */
app.patch("/branches/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { tenant_id, name, is_active } = req.body;

    if (!id) {
      return res.status(400).json({ error: "id es obligatorio" });
    }

    const { data: existingBranch, error: existingError } = await supabase
      .from("branches")
      .select("id, tenant_id, name, is_active")
      .eq("id", id)
      .single();

    if (existingError || !existingBranch) {
      return res.status(404).json({ error: "Sucursal no encontrada" });
    }

    const effectiveTenantId = tenant_id || existingBranch.tenant_id;

    const updateData = {};

    if (name !== undefined) {
      if (!String(name).trim()) {
        return res.status(400).json({ error: "name no puede estar vacío" });
      }

      updateData.name = String(name).trim();
    }

    if (is_active !== undefined) {
      if (Boolean(is_active) === true && existingBranch.is_active === false) {
        const plan = await getPlan(effectiveTenantId);
        const caps = getPlanCapabilities(plan);
        const activeBranchesCount = await getBranchesCount(effectiveTenantId);

        if (activeBranchesCount >= caps.max_branches) {
          return res.status(403).json({
            error: "Límite de sucursales alcanzado",
            upgrade_required: true,
          });
        }
      }

      updateData.is_active = Boolean(is_active);
    }

    const { data, error } = await supabase
      .from("branches")
      .update(updateData)
      .eq("id", id)
      .select("*")
      .single();

    if (error) throw error;

    return res.json({
      ok: true,
      branch: data,
    });
  } catch (err) {
    console.error("PATCH /branches/:id error:", err.message);
    return res.status(500).json({
      error: err.message || "Error actualizando sucursal",
    });
  }
});

/* ======================================================
   ✅ GET /services
====================================================== */

app.get("/services", async (req, res) => {
  try {
    const { tenant_id, branch_id, active } = req.query;

    if (!tenant_id) {
      return res.status(400).json({ error: "tenant_id es obligatorio" });
    }

    const resolvedBranchId = await resolveBranchId({
      tenant_id,
      branch_id: branch_id || null,
    });

    let query = supabase
      .from("services")
      .select("*")
      .eq("tenant_id", tenant_id)
      .eq("branch_id", resolvedBranchId)
      .is("deleted_at", null)
      .order("created_at", { ascending: true });

    if (active === "true") {
      query = query.eq("active", true);
    }

    if (active === "false") {
      query = query.eq("active", false);
    }

    const { data, error } = await query;

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json({
      total: data?.length || 0,
      branch_id: resolvedBranchId,
      services: data || [],
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   ✅ POST /services
====================================================== */

app.post("/services", async (req, res) => {
  try {
const {
  tenant_id,
  branch_id,
  name,
  description,
  duration_minutes,
  buffer_before_minutes = 0,
  buffer_after_minutes = 0,
  price = 0,
  active = true,
  is_group = false,
  capacity = 1,
} = req.body;

    if (!tenant_id || !name || !duration_minutes) {
      return res.status(400).json({
        error: "Faltan campos obligatorios: tenant_id, name, duration_minutes",
      });
    }

    const resolvedBranchId = await resolveBranchId({
      tenant_id,
      branch_id: branch_id || null,
    });

    const plan = await getPlan(tenant_id);
    const caps = getPlanCapabilities(plan);
    const servicesCount = await getServicesCount(tenant_id);

    if (servicesCount >= (caps.max_services || 3)) {
      return res.status(403).json({
        error: "Límite de servicios alcanzado",
        upgrade_required: true,
      });
    }

    const { data, error } = await supabase
      .from("services")
      .insert({
        tenant_id,
        branch_id: resolvedBranchId,
        name: String(name).trim(),
        description: description ? String(description).trim() : null,
        duration_minutes: Number(duration_minutes),
        buffer_before_minutes: Number(buffer_before_minutes || 0),
        buffer_after_minutes: Number(buffer_after_minutes || 0),
        price: Number(price || 0),
        active: Boolean(active),
  is_group: Boolean(is_group),
  capacity: Number(capacity || 1),
      })
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.status(201).json({
      ok: true,
      service: data,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});


/* ======================================================
   ✏️ PATCH /services/:id
====================================================== */

app.patch("/services/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const {
      tenant_id,
      branch_id,
      name,
      description,
      duration_minutes,
      price,
      buffer_before_minutes = 0,
      buffer_after_minutes = 0,
      active,
    } = req.body;

    if (!id) {
      return res.status(400).json({ error: "id es obligatorio" });
    }

    const { data: existingService, error: existingError } = await supabase
      .from("services")
      .select("id, tenant_id, branch_id")
      .eq("id", id)
      .single();

    if (existingError || !existingService) {
      return res.status(404).json({ error: "Servicio no encontrado" });
    }

    const effectiveTenantId = tenant_id || existingService.tenant_id;

    const updateData = {};

    if (branch_id !== undefined) {
      const resolvedBranchId = await resolveBranchId({
        tenant_id: effectiveTenantId,
        branch_id: branch_id || null,
      });

      updateData.branch_id = resolvedBranchId;
    }

    if (name !== undefined) updateData.name = String(name).trim();
    if (description !== undefined)
      updateData.description =
        description === null ? null : String(description).trim();
    if (duration_minutes !== undefined)
      updateData.duration_minutes = Number(duration_minutes);
    if (price !== undefined) updateData.price = Number(price);
    if (buffer_before_minutes !== undefined)
      updateData.buffer_before_minutes = Number(buffer_before_minutes);
    if (buffer_after_minutes !== undefined)
      updateData.buffer_after_minutes = Number(buffer_after_minutes);
    if (active !== undefined) updateData.active = Boolean(active);

    const { data, error } = await supabase
      .from("services")
      .update(updateData)
      .eq("id", id)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json({
      ok: true,
      service: data,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});


/* ======================================================
   🗑️ DELETE /services/:id
====================================================== */
app.delete("/services/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({ error: "id es obligatorio" });
    }

    const { data, error } = await supabase
      .from("services")
      .update({
        deleted_at: new Date().toISOString(),
        active: false,
      })
      .eq("id", id)
      .is("deleted_at", null)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    if (!data) {
      return res.status(404).json({ error: "Servicio no encontrado" });
    }

    return res.json({
      ok: true,
      service: data,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   🌐 PUBLIC: servicios por slug
====================================================== */

app.get("/public/services/:slug", async (req, res) => {
  try {
    const { slug } = req.params;
    const { branch_id } = req.query;

    const { data: tenant, error: tenantError } = await supabase
      .from("tenants")
      .select("*")
      .eq("slug", slug)
      .single();

    if (tenantError || !tenant) {
      return res.status(404).json({ error: "Negocio no encontrado" });
    }

    const resolvedBranchId = await resolveBranchId({
      tenant_id: tenant.id,
      branch_id: branch_id || null,
    });

    const { data: branch, error: branchError } = await supabase
      .from("branches")
      .select("id, tenant_id, name, slug, address, phone, is_active")
      .eq("id", resolvedBranchId)
      .eq("tenant_id", tenant.id)
      .single();

    if (branchError || !branch || !branch.is_active) {
      return res.status(404).json({ error: "Sucursal no encontrada" });
    }

    const { data: calendar, error: calendarError } = await supabase
      .from("calendars")
      .select("id")
      .eq("tenant_id", tenant.id)
      .eq("is_active", true)
      .order("created_at", { ascending: true })
      .limit(1)
      .single();

    if (calendarError || !calendar) {
      return res.status(404).json({ error: "Calendario no encontrado" });
    }

    const { data: services, error: servicesError } = await supabase
      .from("services")
      .select("*")
      .eq("tenant_id", tenant.id)
      .eq("branch_id", resolvedBranchId)
      .eq("active", true)
      .is("deleted_at", null)
      .order("created_at", { ascending: true });

    if (servicesError) {
      return res.status(500).json({ error: servicesError.message });
    }

    return res.json({
      business: tenant,
      branch,
      calendar_id: calendar.id,
      services: services || [],
    });
  } catch (error) {
    console.error("Error en /public/services/:slug", error);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

/* ======================================================
   🌐 PUBLIC: negocio por slug
====================================================== */

app.get("/public/business/:slug", async (req, res) => {
  try {
    const { slug } = req.params;

    if (!slug) {
      return res.status(400).json({ error: "slug requerido" });
    }

    const { data: tenant, error: tenantError } = await supabase
      .from("tenants")
.select(`
  id,
  name,
  slug,
  phone,
  address,
  email,
  whatsapp,
  instagram_url,
  facebook_url,
  description,
  min_booking_notice_minutes,
  max_booking_days_ahead,
  is_active,
  plan_slug,
  billing_cycle_start,
  billing_cycle_end,
  scheduled_plan_slug,
  scheduled_change_at,
  pending_change_type,
  proration_credit,
  proration_charge,
  business_category
`)
      .eq("slug", slug)
      .eq("is_active", true)
      .maybeSingle();

    if (tenantError || !tenant) {
      return res.status(404).json({ error: "negocio no encontrado" });
    }

    const { data: calendar } = await supabase
      .from("calendars")
      .select("id, slot_minutes")
      .eq("tenant_id", tenant.id)
      .eq("is_active", true)
      .limit(1)
      .single();

    return res.json({
      business: {
        ...tenant,
        min_booking_notice_minutes: tenant.min_booking_notice_minutes || 0,
        max_booking_days_ahead: tenant.max_booking_days_ahead || 60,
      },
      calendar_id: calendar?.id,
	slot_minutes: calendar?.slot_minutes || 30,
      google_connected: false,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});



/* ======================================================
   🌐 PUBLIC: staff por slug + service_id
====================================================== */

app.get("/public/staff/:slug/:service_id", async (req, res) => {
  try {
    const { slug, service_id } = req.params;
    const { branch_id } = req.query;

    if (!slug || !service_id) {
      return res.status(400).json({
        error: "Se requiere slug y service_id",
      });
    }

    const { data: tenant, error: tenantError } = await supabase
      .from("tenants")
      .select("id, slug, name")
      .eq("slug", slug)
      .eq("is_active", true)
      .single();

    if (tenantError || !tenant) {
      return res.status(404).json({ error: "negocio no encontrado" });
    }

    const resolvedBranchId = await resolveBranchId({
      tenant_id: tenant.id,
      branch_id: branch_id || null,
    });

    const { data: branch, error: branchError } = await supabase
      .from("branches")
      .select("id, tenant_id, name, slug, is_active")
      .eq("id", resolvedBranchId)
      .eq("tenant_id", tenant.id)
      .single();

    if (branchError || !branch || !branch.is_active) {
      return res.status(404).json({ error: "sucursal no encontrada" });
    }

    const { data: service, error: serviceError } = await supabase
      .from("services")
      .select("id, tenant_id, branch_id, active, deleted_at")
      .eq("id", service_id)
      .eq("tenant_id", tenant.id)
      .eq("branch_id", resolvedBranchId)
      .eq("active", true)
      .is("deleted_at", null)
      .single();

    if (serviceError || !service) {
      return res.status(404).json({ error: "servicio no encontrado" });
    }

    const { data: relations, error: relationsError } = await supabase
      .from("staff_services")
      .select("staff_id")
      .eq("tenant_id", tenant.id)
      .eq("branch_id", resolvedBranchId)
      .eq("service_id", service_id);

    if (relationsError) {
      return res.status(500).json({ error: relationsError.message });
    }

    const staffIds = [...new Set((relations || []).map((row) => row.staff_id).filter(Boolean))];

    if (staffIds.length === 0) {
      return res.json({
        business: {
          id: tenant.id,
          name: tenant.name,
          slug: tenant.slug,
        },
        branch,
        service_id,
        total: 0,
        staff: [],
      });
    }

    const { data: staffRows, error: staffError } = await supabase
      .from("staff")
      .select("id, name, role, color, photo_url, is_active, sort_order")
      .eq("tenant_id", tenant.id)
      .eq("branch_id", resolvedBranchId)
      .eq("is_active", true)
      .in("id", staffIds)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });

    if (staffError) {
      return res.status(500).json({ error: staffError.message });
    }

    return res.json({
      business: {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
      },
      branch,
      service_id,
      total: staffRows?.length || 0,
      staff: staffRows || [],
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   🌐 PUBLIC: slots por slug + service_id + date
====================================================== */

app.get("/public/slots/:slug/:service_id", async (req, res) => {
  try {
    const { slug, service_id } = req.params;
    const { date, staff_id, branch_id } = req.query;

    if (!slug || !service_id || !date) {
      return res.status(400).json({
        error: "Se requiere slug, service_id y date (YYYY-MM-DD)",
      });
    }

    const { data: tenant, error: tenantError } = await supabase
      .from("tenants")
      .select(
        "id, name, slug, min_booking_notice_minutes, max_booking_days_ahead"
      )
      .eq("slug", slug)
      .eq("is_active", true)
      .single();

    if (tenantError || !tenant) {
      return res.status(404).json({ error: "negocio no encontrado" });
    }

    const resolvedBranchId = await resolveBranchId({
      tenant_id: tenant.id,
      branch_id: branch_id || null,
    });

    const { data: branch, error: branchError } = await supabase
      .from("branches")
      .select("id, tenant_id, name, slug, address, phone, is_active")
      .eq("id", resolvedBranchId)
      .eq("tenant_id", tenant.id)
      .single();

    if (branchError || !branch || !branch.is_active) {
      return res.status(404).json({ error: "sucursal no encontrada" });
    }

    const minBookingNoticeMinutes = Number(
      tenant.min_booking_notice_minutes || 0
    );
    const maxBookingDaysAhead = Number(tenant.max_booking_days_ahead || 60);

    const requestedDate = new Date(`${date}T00:00:00-03:00`);
    const maxAllowedDate = new Date();
    maxAllowedDate.setHours(0, 0, 0, 0);
    maxAllowedDate.setDate(maxAllowedDate.getDate() + maxBookingDaysAhead);

    if (requestedDate.getTime() > maxAllowedDate.getTime()) {
      return res.json({
        business: {
          name: tenant.name,
          slug: tenant.slug,
        },
        branch,
        calendar_id: null,
        service: null,
        date,
        total: 0,
        slots: [],
      });
    }

    const { data: service, error: serviceError } = await supabase
      .from("services")
      .select("*")
      .eq("id", service_id)
      .eq("tenant_id", tenant.id)
      .eq("branch_id", resolvedBranchId)
      .eq("active", true)
      .is("deleted_at", null)
      .single();

    if (serviceError || !service) {
      return res.status(404).json({ error: "servicio no encontrado" });
    }

const isGroup = Boolean(service.is_group);
const capacity = Number(service.capacity || 1);

async function attachCapacityToSlots(slotsToCheck) {
  if (!isGroup || !slotsToCheck.length) {
    return slotsToCheck.map((slot) => ({
      ...slot,
      is_group: isGroup,
      capacity,
      booked_count: 0,
      available_spots: capacity,
    }));
  }

  const dayStart = new Date(`${date}T00:00:00-03:00`).toISOString();
  const dayEnd = new Date(`${date}T23:59:59-03:00`).toISOString();

  let apptQuery = supabase
    .from("appointments")
    .select("id, start_at, staff_id")
    .eq("tenant_id", tenant.id)
    .eq("branch_id", resolvedBranchId)
    .eq("service_id", service_id)
    .eq("status", "booked")
    .gte("start_at", dayStart)
    .lte("start_at", dayEnd);

  if (requestedStaffId) {
    apptQuery = apptQuery.eq("staff_id", requestedStaffId);
  }

  const { data: appointmentsForDay, error: apptCountError } = await apptQuery;

  if (apptCountError) {
    throw apptCountError;
  }

  return slotsToCheck
    .map((slot) => {
      const slotKey = String(slot.slot_start || "").slice(0, 16);

      const bookedCount = (appointmentsForDay || []).filter((appt) => {
        const apptKey = String(appt.start_at || "").slice(0, 16);
        const sameTime = apptKey === slotKey;

        if (!sameTime) return false;

        if (slot.staff_id) {
          return String(appt.staff_id || "") === String(slot.staff_id);
        }

        return true;
      }).length;

      const availableSpots = Math.max(capacity - bookedCount, 0);

      return {
        ...slot,
        is_group: isGroup,
        capacity,
        booked_count: bookedCount,
        available_spots: availableSpots,
      };
    })
    .filter((slot) => slot.available_spots > 0);
}

    const { data: calendar, error: calendarError } = await supabase
      .from("calendars")
      .select("id, slot_minutes")
      .eq("tenant_id", tenant.id)
      .eq("is_active", true)
      .order("created_at", { ascending: true })
      .limit(1)
      .single();

    if (calendarError || !calendar) {
      return res.status(404).json({ error: "calendario no encontrado" });
    }

    const serviceStaffIds = await getServiceStaffIds({
      tenant_id: tenant.id,
      branch_id: resolvedBranchId,
      service_id,
    });

    const requestedStaffId = staff_id ? String(staff_id) : null;

    let candidateStaffIds = requestedStaffId
      ? serviceStaffIds.filter((id) => id === requestedStaffId)
      : serviceStaffIds;

    if (requestedStaffId && candidateStaffIds.length === 0) {
      return res.status(400).json({
        error: "El staff seleccionado no realiza este servicio",
      });
    }

    const businessWindows = await getBusinessAvailabilityWindows({
      tenant_id: tenant.id,
      branch_id: resolvedBranchId,
      date,
    });

const weekday = parseDateToWeekday(date);

const { data: businessWeeklyRows, error: businessWeeklyError } = await supabase
  .from("business_hours")
  .select("id")
  .eq("tenant_id", tenant.id)
  .eq("branch_id", resolvedBranchId)
  .eq("day_of_week", weekday)
  .limit(1);

if (businessWeeklyError) {
  throw businessWeeklyError;
}

const { data: businessSpecialRows, error: businessSpecialError } = await supabase
  .from("business_special_dates")
  .select("id")
  .eq("tenant_id", tenant.id)
  .eq("branch_id", resolvedBranchId)
  .eq("date", date)
  .limit(1);

if (businessSpecialError) {
  throw businessSpecialError;
}

const hasBusinessConfig =
  (businessWeeklyRows && businessWeeklyRows.length > 0) ||
  (businessSpecialRows && businessSpecialRows.length > 0);

    if (!candidateStaffIds.length) {
      let slots = buildSlotsFromWindows(
        businessWindows,
        date,
        calendar.slot_minutes || 30
      );

      if (!isGroup) {
  slots = await subtractAppointmentsFromWindows({
    tenant_id: tenant.id,
    branch_id: resolvedBranchId,
    staff_id: null,
    date,
    windows: businessWindows,
  });

  slots = buildSlotsFromWindows(
    slots,
    date,
    calendar.slot_minutes || 30
  );
}

      const totalMinutes =
        (service.duration_minutes || 0) +
        (service.buffer_before_minutes || 0) +
        (service.buffer_after_minutes || 0);

      slots = filterSlotsForServiceDuration(
        slots,
        totalMinutes,
        calendar.slot_minutes || 30
      );

      slots = filterPastSlots(slots, minBookingNoticeMinutes);
slots = await attachCapacityToSlots(slots);

return res.json({
        business: {
          name: tenant.name,
          slug: tenant.slug,
        },
        branch,
        calendar_id: calendar.id,
        service,
        date,
        total: slots.length,
        slots,
      });
    }

    let mergedSlots = [];

    for (const currentStaffId of candidateStaffIds) {
      const staffWindows = await getStaffAvailabilityWindows({
        tenant_id: tenant.id,
        branch_id: resolvedBranchId,
        staff_id: currentStaffId,
        date,
      });

      let finalWindows = hasBusinessConfig
  ? intersectWindows(businessWindows, staffWindows)
  : staffWindows;

      if (!isGroup) {
  finalWindows = await subtractAppointmentsFromWindows({
    tenant_id: tenant.id,
    branch_id: resolvedBranchId,
    staff_id: currentStaffId,
    date,
    windows: finalWindows,
  });
}

      let staffSlots = buildSlotsFromWindows(
        finalWindows,
        date,
        calendar.slot_minutes || 30
      );

      const totalMinutes =
        (service.duration_minutes || 0) +
        (service.buffer_before_minutes || 0) +
        (service.buffer_after_minutes || 0);

      staffSlots = filterSlotsForServiceDuration(
        staffSlots,
        totalMinutes,
        calendar.slot_minutes || 30
      ).map((slot) => ({
        ...slot,
        staff_id: currentStaffId,
      }));

      mergedSlots.push(...staffSlots);
    }

    const uniqueMap = new Map();

    for (const slot of mergedSlots) {
      const key = slot.staff_id
        ? `${slot.slot_start}_${slot.staff_id}`
        : slot.slot_start;

      if (!uniqueMap.has(key)) {
        uniqueMap.set(key, slot);
      }
    }

    let slots = Array.from(uniqueMap.values()).sort(
      (a, b) =>
        new Date(a.slot_start).getTime() - new Date(b.slot_start).getTime()
    );

slots = filterPastSlots(slots, minBookingNoticeMinutes);
slots = await attachCapacityToSlots(slots);

return res.json({
      business: {
        name: tenant.name,
        slug: tenant.slug,
      },
      branch,
      calendar_id: calendar.id,
      service,
      date,
      total: slots.length,
      slots,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   🔔 RECORDATORIOS 24H
====================================================== */
app.get("/jobs/send-reminders", async (req, res) => {
  try {
    const now = new Date();
    const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const { data: appointments, error } = await supabase
      .from("appointments")
      .select("*")
      .eq("status", "booked")
      .gte("start_at", in24h.toISOString())
      .lte("start_at", new Date(in24h.getTime() + 60 * 60 * 1000).toISOString());

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    let sent = 0;

    for (const appt of appointments) {
      if (!appt.customer_email) continue;

      const { data: tenantData } = await supabase
        .from("tenants")
        .select("slug")
        .eq("id", appt.tenant_id)
        .single();

      const bookingUrl = tenantData?.slug
        ? `https://www.orbyx.cl/${tenantData.slug}`
        : "https://www.orbyx.cl";

      const cancelUrl =
        `https://www.orbyx.cl/cancel/${appt.id}?token=${appt.cancel_token}` +
        `&redirect=${encodeURIComponent(bookingUrl)}`;

      await sendBookingEmail({
        email: appt.customer_email,
        customerName: appt.customer_name,
        serviceName: appt.service_name_snapshot || "Reserva",
        startAt: appt.start_at,
        cancelUrl,
      });

      sent++;
    }

    return res.json({
      ok: true,
      reminders_sent: sent,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   ✅ ONBOARDING SETUP
====================================================== */
app.post("/onboarding/setup", async (req, res) => {
  try {
    const {
      business,
      service,
      weekly_hours = [],
      special_dates = [],
    } = req.body;

    if (!business?.name || !business?.slug) {
      return res.status(400).json({
        error: "Faltan campos obligatorios del negocio: name y slug",
      });
    }

    const normalizedSlug = String(business.slug).trim().toLowerCase();

    const { data: existingTenantBySlug, error: slugCheckError } = await supabase
      .from("tenants")
      .select("id, slug")
      .eq("slug", normalizedSlug)
      .maybeSingle();

    if (slugCheckError) {
      return res.status(500).json({ error: slugCheckError.message });
    }

    if (existingTenantBySlug) {
      return res.status(400).json({
        error: "Este slug ya está en uso. Prueba con otro nombre de negocio.",
      });
    }

    const { data: createdTenant, error: tenantError } = await supabase
      .from("tenants")
      .insert({
        name: String(business.name).trim(),
        slug: normalizedSlug,
        phone: business.contact_phone
          ? String(business.contact_phone).trim()
          : null,
        address: business.address ? String(business.address).trim() : null,
      })
      .select()
      .single();

    if (tenantError) {
      return res.status(500).json({ error: tenantError.message });
    }

    const tenant_id = createdTenant.id;

    const { data: createdCalendar, error: calendarError } = await supabase
      .from("calendars")
      .insert({
        tenant_id,
        name: "Principal",
        timezone: "America/Santiago",
        is_active: true,
        slot_minutes: 30,
        buffer_minutes: 0,
      })
      .select()
      .single();

    if (calendarError) {
      return res.status(500).json({ error: calendarError.message });
    }

    const calendar_id = createdCalendar.id;

    let createdService = null;

    if (service?.name) {
      const { data: serviceInserted, error: serviceError } = await supabase
        .from("services")
        .insert({
          tenant_id,
          name: String(service.name).trim(),
          duration_minutes: Number(service.duration_minutes || 30),
          buffer_before_minutes: Number(service.buffer_before_minutes || 0),
          buffer_after_minutes: Number(service.buffer_after_minutes || 0),
          price: Number(service.price || 0),
          active: true,
        })
        .select()
        .single();

      if (serviceError) {
        return res.status(500).json({ error: serviceError.message });
      }

      createdService = serviceInserted;
    }

    if (Array.isArray(weekly_hours) && weekly_hours.length > 0) {
      const weeklyRows = weekly_hours.map((row) => ({
        tenant_id,
        day_of_week: Number(row.day_of_week),
        enabled: !!row.enabled,
        start_time: row.enabled ? row.start_time || null : null,
        end_time: row.enabled ? row.end_time || null : null,
      }));

      const { error: insertWeeklyError } = await supabase
        .from("business_hours")
        .upsert(weeklyRows, { onConflict: "tenant_id,day_of_week" });

      if (insertWeeklyError) {
        return res.status(500).json({ error: insertWeeklyError.message });
      }
    }

    if (Array.isArray(special_dates) && special_dates.length > 0) {
      const specialRows = special_dates.map((row) => ({
        tenant_id,
        date: row.date,
        label: row.label || "Configuración especial",
        is_closed: !!row.is_closed,
        start_time: row.start_time || null,
        end_time: row.end_time || null,
      }));

      const { error: insertSpecialError } = await supabase
        .from("business_special_dates")
        .insert(specialRows);

      if (insertSpecialError) {
        return res.status(500).json({ error: insertSpecialError.message });
      }
    }

    return res.json({
      ok: true,
      tenant_id,
      calendar_id,
      slug: createdTenant.slug,
      service: createdService,
    });
  } catch (err) {
    console.error("Onboarding setup failed:", err);
    return res.status(500).json({
      error: "Onboarding setup failed",
      detail: err.message,
    });
  }
});

/* ======================================================
   ✅ BOOKING FIELDS CONFIG (NUEVO)
====================================================== */

/* ======================================================
   🔹 GET /booking-fields/:slug
   Obtener configuración de campos dinámicos
====================================================== */
app.get("/booking-fields/:slug", async (req, res) => {
  try {
    const { slug } = req.params;

    if (!slug) {
      return res.status(400).json({ error: "slug es obligatorio" });
    }

    const { data, error } = await supabase
      .from("tenants")
      .select("id, booking_fields_config")
      .eq("slug", slug)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: "Negocio no encontrado" });
    }

    const bookingFieldsConfig =
  Array.isArray(data.booking_fields_config) &&
  data.booking_fields_config.length > 0
    ? data.booking_fields_config
    : DEFAULT_BOOKING_FIELDS_CONFIG;

return res.json({
  booking_fields_config: bookingFieldsConfig,
});
  } catch (err) {
    console.error("GET /booking-fields/:slug error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

const DEFAULT_BOOKING_FIELDS_CONFIG = [
  {
    key: "name",
    label: "Nombre",
    enabled: true,
    required: true,
  },
  {
    key: "email",
    label: "Correo",
    enabled: true,
    required: true,
  },
  {
    key: "phone",
    label: "Teléfono",
    enabled: true,
    required: true,
  },
  {
    key: "notes",
    label: "Notas o comentarios",
    enabled: true,
    required: false,
  },
];

/* ======================================================
   🔹 PUT /booking-fields/:slug
   Guardar configuración de campos dinámicos
====================================================== */
app.put("/booking-fields/:slug", async (req, res) => {
  try {
    const { slug } = req.params;
    const { booking_fields_config } = req.body;

    if (!slug) {
      return res.status(400).json({ error: "slug es obligatorio" });
    }

    if (!Array.isArray(booking_fields_config)) {
      return res.status(400).json({
        error: "booking_fields_config debe ser un arreglo",
      });
    }

    const { data: tenant, error: tenantError } = await supabase
      .from("tenants")
      .select("id")
      .eq("slug", slug)
      .single();

    if (tenantError || !tenant) {
      return res.status(404).json({ error: "Negocio no encontrado" });
    }

    const { data, error } = await supabase
      .from("tenants")
      .update({
        booking_fields_config,
      })
      .eq("id", tenant.id)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json({
      ok: true,
      booking_fields_config: data.booking_fields_config,
    });
  } catch (err) {
    console.error("PUT /booking-fields/:slug error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// =======================
// UPLOAD IMAGE
// =======================
app.post("/upload/campaign-image", upload.single("file"), async (req, res) => {
  try {
    const { slug } = req.body;

    if (!slug) return res.status(400).json({ error: "Falta slug" });
    if (!req.file) return res.status(400).json({ error: "No file" });

    if (!isValidMime(req.file.mimetype)) {
      return res.status(400).json({ error: "Formato inválido" });
    }

    // 1. Obtener tenant
    const { data: business, error: bErr } = await supabase
      .from("tenants")
      .select("id, plan_slug")
      .eq("slug", slug)
      .single();

    if (bErr || !business) {
      return res.status(404).json({ error: "Negocio no encontrado" });
    }

    const plan = normalizePlan(business.plan_slug);
    const limit = PLAN_LIMITS[plan] || 7;

    // 2. Contar imágenes actuales
    const { count } = await supabase
      .from("campaign_images")
      .select("*", { count: "exact", head: true })
      .eq("tenant_id", business.id);

    if ((count || 0) >= limit) {
      return res.status(400).json({ error: "Límite de imágenes alcanzado" });
    }

    // 3. Subir a storage
    const fileExt = req.file.mimetype.split("/")[1];
    const filePath = `${business.id}/${Date.now()}.${fileExt}`;

    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(filePath, req.file.buffer, {
        contentType: req.file.mimetype,
      });

    if (uploadError) {
      return res.status(500).json({ error: uploadError.message });
    }

    const { data: publicUrlData } = supabase.storage
      .from(BUCKET)
      .getPublicUrl(filePath);

    const publicUrl = publicUrlData.publicUrl;

    // 4. Guardar en DB
    const { data: image } = await supabase
      .from("campaign_images")
      .insert({
        tenant_id: business.id,
        file_path: filePath,
        public_url: publicUrl,
        mime_type: req.file.mimetype,
        size_bytes: req.file.size,
      })
      .select()
      .single();

    return res.json({ image });
} catch (err) {
  return res.status(500).json({ error: err.message || "Error subiendo imagen" });
}
});

// =======================
// LISTAR IMÁGENES
// =======================
app.get("/campaign-images/:slug", async (req, res) => {
  try {
    const { slug } = req.params;

    const { data: business } = await supabase
      .from("tenants")
      .select("id, plan_slug")
      .eq("slug", slug)
      .single();

    const { data } = await supabase
      .from("campaign_images")
      .select("*")
      .eq("tenant_id", business.id)
      .order("created_at", { ascending: false });

    res.json({ images: data });
  } catch {
    res.status(500).json({ error: "Error listando imágenes" });
  }
});

// =======================
// DELETE IMAGE
// =======================
app.delete("/campaign-images/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const { data: image } = await supabase
      .from("campaign_images")
      .select("*")
      .eq("id", id)
      .single();

    if (!image) {
      return res.status(404).json({ error: "Imagen no encontrada" });
    }

    await supabase.storage.from(BUCKET).remove([image.file_path]);

    await supabase.from("campaign_images").delete().eq("id", id);

    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Error eliminando" });
  }
});


/* ======================================================
   🚀 START
====================================================== */
app.listen(PORT, () => {
  console.log(`🚀 Servidor listo en http://localhost:${PORT}`);
});

app.get("/api/pets/:slug", async (req, res) => {
  try {
    const { slug } = req.params;
    const { phone, email } = req.query;

    if (!slug) {
      return res.status(400).json({ error: "Falta slug" });
    }

    const { data: tenant } = await supabase
      .from("tenants")
      .select("id")
      .eq("slug", slug)
      .single();

    if (!tenant) {
      return res.status(404).json({ error: "Negocio no encontrado" });
    }

    let query = supabase
      .from("customers")
      .select("id")
      .eq("tenant_id", tenant.id);

    if (phone) {
      query = query.eq("phone", phone);
    } else if (email) {
      query = query.eq("email", email);
    }

    const { data: customer } = await query.single();

    if (!customer) {
      return res.json({ pets: [] });
    }

    const { data: pets } = await supabase
      .from("pets")
      .select("*")
      .eq("tenant_id", tenant.id)
      .eq("customer_id", customer.id);

    res.json({ pets: pets || [] });
  } catch (error) {
    console.error("Error pets:", error);
    res.status(500).json({ error: "Error interno" });
  }
});