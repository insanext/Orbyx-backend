console.log("BACKEND VERSION 26-06-SECURITY-AUTH");

// server.js
require("dotenv").config();
const express = require("express");
const multer = require("multer");
const { createClient } = require("@supabase/supabase-js");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { google } = require("googleapis");
const crypto = require("crypto");
const PDFDocument = require("pdfkit");
const {
  sendBookingEmail,
  sendInvitationEmail,
  sendEmailChangeConfirmationToOldEmail,
  sendEmailChangeVerificationToNewEmail,
} = require("./email");

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

const uploadTicket = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1 * 1024 * 1024 },
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

function normalizeNullableUrl(value) {
  return value ? String(value).trim() : null;
}

function normalizeNullableNumber(value) {
  if (value === "" || value === null || value === undefined) return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function getPlanCapabilities(plan, opts = {}) {
  const normalizedPlan = String(plan || "pro").toLowerCase();

  // max_services = 999999: los servicios son ilimitados en todos los planes
  const plans = {
    pro: {
      max_staff: 2,
      max_services: 999999,
      max_branches: 1,
      max_campaign_emails_per_send: 200,
      max_wa_reminders_per_month: 0,
      max_ai_wa_conversations_per_month: 0,
      max_group_capacity: 10,
      max_wa_confirmacion: 100,
      max_campanas_wa: 0,
      max_ia_wa: 0,
    },
    premium: {
      max_staff: 5,
      max_services: 999999,
      max_branches: 2,
      max_campaign_emails_per_send: 1000,
      max_wa_reminders_per_month: 100,
      max_ai_wa_conversations_per_month: 0,
      max_group_capacity: 25,
      max_wa_confirmacion: 200,
      max_campanas_wa: 0,
      max_ia_wa: 0,
    },
    vip: {
      max_staff: 10,
      max_services: 999999,
      max_branches: 3,
      max_campaign_emails_per_send: 2000,
      max_wa_reminders_per_month: 200,
      max_ai_wa_conversations_per_month: 500,
      max_group_capacity: 50,
      max_wa_confirmacion: 300,
      max_campanas_wa: 0,
      max_ia_wa: 500,
    },
    platinum: {
      max_staff: 25,
      max_services: 999999,
      max_branches: 10,
      max_campaign_emails_per_send: 5000,
      max_wa_reminders_per_month: 400,
      max_ai_wa_conversations_per_month: 1500,
      max_group_capacity: 100,
      max_wa_confirmacion: 500,
      max_campanas_wa: 0,
      max_ia_wa: 1500,
    },
  };

  if (normalizedPlan === "starter") {
    return plans.pro;
  }

  const caps = plans[normalizedPlan] || plans.pro;

  // Durante versión de prueba Pro: wa_confirmacion no incluido
  if (opts.is_trial && normalizedPlan === "pro") {
    return { ...caps, max_wa_confirmacion: 0 };
  }

  return caps;
}

const PLAN_PRICES = {
  pro: 12990,
  premium: 29990,
  vip: 54990,
  platinum: 149990,
};

const PLAN_ORDER = {
  pro: 1,
  premium: 2,
  vip: 3,
  platinum: 4,
};

const BILLING_CYCLE_DAYS = 30;

// Ciclos de facturación. mensual se preserva tal cual; semestral y anual
// aplican descuento sobre precio mensual × meses.
const BILLING_CYCLES = {
  mensual: { months: 1, discount: 1 },
  semestral: { months: 6, discount: 0.9 },
  anual: { months: 12, discount: 0.85 },
};

const BILLING_CYCLE_ALIASES = {
  monthly: "mensual",
  "1month": "mensual",
  "6months": "semestral",
  semiannual: "semestral",
  "12months": "anual",
  annual: "anual",
  yearly: "anual",
};

function normalizeBillingCycle(cycle) {
  const normalized = String(cycle || "mensual").toLowerCase();
  if (BILLING_CYCLES[normalized]) return normalized;
  return BILLING_CYCLE_ALIASES[normalized] || "mensual";
}

// El ciclo no se persiste en una columna propia: se infiere de la duración
// entre billing_cycle_start y billing_cycle_end (mensual ~30d, semestral ~180d, anual ~360d).
function inferBillingCycle(billingStart, billingEnd) {
  const ms = new Date(billingEnd).getTime() - new Date(billingStart).getTime();
  const days = ms / (1000 * 60 * 60 * 24);

  if (days >= 300) return "anual";
  if (days >= 150) return "semestral";
  return "mensual";
}

function getPriorityByPlan(plan) {
  const map = { pro: "normal", premium: "media", vip: "alta", platinum: "maxima" };
  return map[String(plan || "pro").toLowerCase()] ?? "normal";
}

function normalizePlanSlug(plan) {
  const normalized = String(plan || "pro").toLowerCase();
  if (normalized === "starter") return "pro";
  if (PLAN_ORDER[normalized]) return normalized;
  return "pro";
}

function getPlanPrice(plan) {
  return PLAN_PRICES[normalizePlanSlug(plan)] || PLAN_PRICES.pro;
}

// Total del ciclo: mensual = precio; semestral = precio × 6 × 0.90; anual = precio × 12 × 0.85
function getPlanCyclePrice(plan, cycle) {
  const config = BILLING_CYCLES[normalizeBillingCycle(cycle)];
  return Math.round(getPlanPrice(plan) * config.months * config.discount);
}

/* ======================================================
   Catálogo de add-ons. Precios escalonados: pack1 = precio normal,
   pack2 (−10%), pack3+ (−15%). resets_monthly = true indica que el
   uso se resetea mensualmente (last_reset_at). Pro puede contratar
   wa_confirmacion y emails_campana; los demás requieren premium+.
====================================================== */
const ADDON_CATALOG = {
  wa_confirmacion: {
    key: "wa_confirmacion",
    name: "WA confirmación+recordatorio",
    description: "50 msgs WA adicionales/mes",
    price: 2990,
    price_pack2: 2691,
    price_pack3: 2542,
    pack_size: 50,
    grants: { wa_confirmacion: 50 },
    min_plan: "pro",
    available_for: ["pro", "premium", "vip", "platinum"],
    resets_monthly: true,
    accumulates: false,
  },
  campanas_wa: {
    key: "campanas_wa",
    name: "Campañas WhatsApp",
    description: "50 msgs campaña marketing adicionales/mes",
    price: 6990,
    price_pack2: 6291,
    price_pack3: 5942,
    pack_size: 50,
    grants: { campanas_wa: 50 },
    min_plan: "vip",
    available_for: ["vip", "platinum"],
    resets_monthly: true,
    accumulates: false,
  },
  ia_wa: {
    key: "ia_wa",
    name: "IA WhatsApp",
    description: "500 conversaciones IA adicionales/mes",
    price: 14990,
    price_pack2: 13491,
    price_pack3: 12742,
    pack_size: 500,
    grants: { ia_wa: 500 },
    min_plan: "vip",
    available_for: ["vip", "platinum"],
    resets_monthly: true,
    accumulates: false,
  },
  emails_campana: {
    key: "emails_campana",
    name: "Pack emails campaña",
    description: "2.000 correos campaña adicionales/mes",
    price: 1990,
    price_pack2: 1990,
    price_pack3: 1990,
    pack_size: 2000,
    grants: { emails_campana: 2000 },
    min_plan: "pro",
    available_for: ["pro", "premium", "vip", "platinum"],
    resets_monthly: true,
    accumulates: false,
  },
  staff: {
    key: "staff",
    name: "+ 1 Profesional",
    description: "1 staff adicional sobre límite del plan",
    price: 5990,
    price_pack2: 5990,
    price_pack3: 5990,
    pack_size: 1,
    grants: { staff: 1 },
    min_plan: "premium",
    available_for: ["premium", "vip", "platinum"],
    resets_monthly: false,
    accumulates: false,
  },
  sucursal: {
    key: "sucursal",
    name: "+ 1 Sucursal",
    description: "1 sucursal adicional sobre límite del plan",
    price: 9990,
    price_pack2: 9990,
    price_pack3: 9990,
    pack_size: 1,
    grants: { sucursal: 1 },
    min_plan: "premium",
    available_for: ["premium", "vip", "platinum"],
    resets_monthly: false,
    accumulates: false,
  },
  group_capacity: {
    key: "group_capacity",
    name: "+ Cupos grupales",
    description: "25 cupos adicionales por slot grupal",
    price: 4900,
    price_pack2: 4900,
    price_pack3: 4900,
    pack_size: 25,
    grants: { group_capacity: 25 },
    min_plan: "premium",
    available_for: ["premium", "vip", "platinum"],
    resets_monthly: false,
    accumulates: false,
  },
};

function isAddonAvailableForPlan(addonKey, plan) {
  const addon = ADDON_CATALOG[addonKey];
  if (!addon) return false;
  return getPlanLevel(plan) >= getPlanLevel(addon.min_plan);
}

function getAddonsForPlan(plan) {
  return Object.values(ADDON_CATALOG).filter((addon) =>
    isAddonAvailableForPlan(addon.key, plan)
  );
}

// Add-ons activos contratados por un tenant (tabla tenant_addons)
async function getActiveAddons(tenant_id) {
  const { data, error } = await supabase
    .from("tenant_addons")
    .select("id, addon_key, quantity, billing_cycle, status, activated_at, unit_price, last_reset_at")
    .eq("tenant_id", tenant_id)
    .eq("status", "active");

  if (error) throw error;

  return data || [];
}

// Capacidad grupal efectiva = base del plan + (packs activos × 25).
// Tolerante a la ausencia de tenant_addons: retorna la base del plan.
async function getEffectiveGroupCapacity(tenant_id) {
  const plan = await getPlan(tenant_id);
  const baseCapacity = getPlanCapabilities(plan).max_group_capacity || 10;

  try {
    const { data, error } = await supabase
      .from("tenant_addons")
      .select("quantity")
      .eq("tenant_id", tenant_id)
      .eq("addon_key", "group_capacity")
      .eq("status", "active")
      .maybeSingle();

    if (error) throw error;

    const packs = Number(data?.quantity) || 0;
    return baseCapacity + packs * ADDON_CATALOG.group_capacity.pack_size;
  } catch (err) {
    console.warn(
      "getEffectiveGroupCapacity: usando capacidad base del plan:",
      err.message
    );
    return baseCapacity;
  }
}

// Errores de PostgREST cuando la tabla tenant_addons todavía no fue migrada
function isMissingAddonsTableError(err) {
  return Boolean(
    err &&
      (err.code === "PGRST205" ||
        String(err.message || "").includes("tenant_addons"))
  );
}

// Cancela los add-ons activos que el plan destino no soporta.
// Tolerante a que la tabla tenant_addons aún no exista: en ese caso
// solo deja un warning y no interrumpe el cambio de plan.
async function cancelUnsupportedAddons(tenant_id, newPlan) {
  try {
    const { data, error } = await supabase
      .from("tenant_addons")
      .select("id, addon_key")
      .eq("tenant_id", tenant_id)
      .eq("status", "active");

    if (error) throw error;

    const toCancel = (data || []).filter(
      (row) => !isAddonAvailableForPlan(row.addon_key, newPlan)
    );

    if (toCancel.length === 0) return [];

    const { error: updateError } = await supabase
      .from("tenant_addons")
      .update({
        status: "canceled",
        canceled_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .in(
        "id",
        toCancel.map((row) => row.id)
      );

    if (updateError) throw updateError;

    return toCancel.map((row) => row.addon_key);
  } catch (err) {
    console.warn(
      "cancelUnsupportedAddons: no se pudieron cancelar add-ons (¿tabla tenant_addons no existe?):",
      err.message
    );
    return [];
  }
}

// Resetea add-ons con resets_monthly:true cuando han pasado ≥30 días desde el último reset.
// No cancela el add-on — solo actualiza last_reset_at para que el contador de uso vuelva a cero.
async function resetMonthlyAddons(tenant_id) {
  try {
    const { data, error } = await supabase
      .from("tenant_addons")
      .select("id, addon_key, activated_at, last_reset_at")
      .eq("tenant_id", tenant_id)
      .eq("status", "active");

    if (error) throw error;
    if (!data || data.length === 0) return;

    const now = new Date();
    const toReset = data.filter((row) => {
      const addon = ADDON_CATALOG[row.addon_key];
      if (!addon?.resets_monthly) return false;
      const ref = row.last_reset_at || row.activated_at;
      if (!ref) return false;
      const daysSince = (now - new Date(ref)) / (1000 * 60 * 60 * 24);
      return daysSince >= 30;
    });

    if (toReset.length === 0) return;

    const { error: updateError } = await supabase
      .from("tenant_addons")
      .update({ last_reset_at: now.toISOString() })
      .in("id", toReset.map((r) => r.id));

    if (updateError) throw updateError;

    console.log(
      `resetMonthlyAddons tenant ${tenant_id}: ${toReset.length} add-on(s) reseteados → ${toReset.map((r) => r.addon_key).join(", ")}`
    );
  } catch (err) {
    console.warn("resetMonthlyAddons error:", err.message);
  }
}

// Mapa resource → clave en getPlanCapabilities
const MONTHLY_RESOURCE_CAP_KEY = {
  wa_confirmacion: "max_wa_confirmacion",
  campanas_wa: "max_campanas_wa",
  ia_wa: "max_ia_wa",
  emails_campana: "max_campaign_emails_per_send",
};

async function checkMonthlyUsage(tenant_id, resource) {
  const plan = await getPlan(tenant_id);
  const caps = getPlanCapabilities(plan);
  const capKey = MONTHLY_RESOURCE_CAP_KEY[resource];
  if (!capKey) return { allowed: false, limit: 0, base: 0, addon: 0, used: 0, remaining: 0 };

  const baseCap = caps[capKey] || 0;

  // Capacidad de add-ons activos para este recurso
  let addonCap = 0;
  const addonDef = ADDON_CATALOG[resource];
  if (addonDef) {
    try {
      const { data: addonRow } = await supabase
        .from("tenant_addons")
        .select("quantity")
        .eq("tenant_id", tenant_id)
        .eq("addon_key", resource)
        .eq("status", "active")
        .maybeSingle();
      const qty = Number(addonRow?.quantity) || 0;
      addonCap = qty * (addonDef.grants[resource] || 0);
    } catch (_) {}
  }

  const total = baseCap + addonCap;
  const period = new Date().toISOString().slice(0, 7);

  let used = 0;
  try {
    const { data: usageRow } = await supabase
      .from("tenant_monthly_usage")
      .select("used")
      .eq("tenant_id", tenant_id)
      .eq("resource", resource)
      .eq("period", period)
      .maybeSingle();
    used = Number(usageRow?.used) || 0;
  } catch (_) {}

  const remaining = Math.max(0, total - used);
  return { allowed: total > 0 && used < total, limit: total, base: baseCap, addon: addonCap, used, remaining };
}

async function incrementMonthlyUsage(tenant_id, resource, amount = 1) {
  const period = new Date().toISOString().slice(0, 7);
  try {
    const { data: existing } = await supabase
      .from("tenant_monthly_usage")
      .select("id, used")
      .eq("tenant_id", tenant_id)
      .eq("resource", resource)
      .eq("period", period)
      .maybeSingle();

    if (existing) {
      await supabase
        .from("tenant_monthly_usage")
        .update({ used: existing.used + amount, updated_at: new Date().toISOString() })
        .eq("id", existing.id);
    } else {
      await supabase
        .from("tenant_monthly_usage")
        .insert({ tenant_id, resource, period, used: amount });
    }
  } catch (err) {
    console.warn("incrementMonthlyUsage error:", err.message);
  }
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

// Generalización de addOneMonth para ciclos semestral/anual (mismo clamp de día)
function addMonths(date, months) {
  const d = new Date(date);
  const day = d.getDate();

  d.setMonth(d.getMonth() + months);

  if (d.getDate() < day) {
    d.setDate(0);
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
  billingCycle = "mensual",
  now = new Date(),
}) {
  // Para ciclo mensual el cálculo es idéntico al original (precio mensual / 30).
  const cycle = normalizeBillingCycle(billingCycle);
  const cycleDays = BILLING_CYCLE_DAYS * BILLING_CYCLES[cycle].months;

  const currentPrice = getPlanCyclePrice(currentPlan, cycle);
  const newPrice = getPlanCyclePrice(newPlan, cycle);

  const msRemaining = Math.max(0, billingEnd.getTime() - now.getTime());
  const daysRemainingExact = msRemaining / (1000 * 60 * 60 * 24);

  const currentDaily = currentPrice / cycleDays;
  const newDaily = newPrice / cycleDays;

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

    if (/^https:\/\/orbyx[\w-]*\.vercel\.app$/.test(origin)) return cb(null, true);

    return cb(new Error("Not allowed by CORS: " + origin));
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: false,
};

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));
app.use(express.json());

const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Demasiadas solicitudes. Intenta de nuevo en un momento." },
});

const dashboardLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Demasiadas solicitudes. Intenta de nuevo en un momento." },
});

// =======================
// AUTH MIDDLEWARE — TENANT DASHBOARD
// =======================
async function requireTenantAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Token requerido" });
    }
    const token = authHeader.split(" ")[1];
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return res.status(401).json({ error: "Token inválido o sesión expirada" });
    }
    req.authenticatedUser = { user_id: user.id };
    next();
  } catch (err) {
    console.error("requireTenantAuth error:", err);
    return res.status(500).json({ error: "Error de autenticación" });
  }
}

async function resolveTenantMembership(req, res, tenantId) {
  const userId = req.authenticatedUser.user_id;
  const { data: membership, error: membershipError } = await supabase
    .from("tenant_users")
    .select("id, tenant_id, role, is_active")
    .eq("user_id", userId)
    .eq("tenant_id", tenantId)
    .eq("is_active", true)
    .single();
  if (membershipError || !membership) {
    return null;
  }
  const { data: branchRows } = await supabase
    .from("branch_access")
    .select("branch_id")
    .eq("user_id", userId)
    .eq("tenant_id", tenantId)
    .eq("is_active", true);
  req.authenticatedUser = {
    user_id: userId,
    tenant_id: tenantId,
    role: membership.role,
    branch_ids: (branchRows || []).map((r) => r.branch_id),
  };
  return membership;
}

function requireWriteAccess(req, res, next) {
  if (req.authenticatedUser && req.authenticatedUser.role === "readonly") {
    return res.status(403).json({ error: "Tu rol es solo lectura. No puedes realizar esta acción." });
  }
  next();
}

async function enforceTenantId(req, res, next) {
  const requestedTid = (req.body && req.body.tenant_id) || (req.query && req.query.tenant_id);
  if (!requestedTid) {
    return res.status(400).json({ error: "tenant_id es obligatorio" });
  }
  const membership = await resolveTenantMembership(req, res, requestedTid);
  if (!membership) {
    return res.status(403).json({ error: "No tienes acceso a este negocio" });
  }
  next();
}

async function enforceSlugOwnership(req, res, next) {
  const slug = req.params.slug || req.body?.slug || req.query?.slug;
  if (!slug) return next();
  const { data: tenant } = await supabase
    .from("tenants")
    .select("id")
    .eq("slug", slug)
    .eq("is_active", true)
    .single();
  if (!tenant) {
    return res.status(404).json({ error: "Negocio no encontrado" });
  }
  const membership = await resolveTenantMembership(req, res, tenant.id);
  if (!membership) {
    return res.status(403).json({ error: "No tienes acceso a este negocio" });
  }
  next();
}

const tenantAuth = [dashboardLimiter, requireTenantAuth, enforceTenantId];
const tenantAuthWrite = [dashboardLimiter, requireTenantAuth, enforceTenantId, requireWriteAccess];
const tenantAuthSlug = [dashboardLimiter, requireTenantAuth, enforceSlugOwnership];
const tenantAuthSlugWrite = [dashboardLimiter, requireTenantAuth, enforceSlugOwnership, requireWriteAccess];

const PORT = process.env.PORT || 3000;

// 🔐 Credenciales OAuth
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;
const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID;
const MICROSOFT_CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET;
const MICROSOFT_REDIRECT_URI = process.env.MICROSOFT_REDIRECT_URI;

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/userinfo.email",
];

const MICROSOFT_SCOPES = [
  "offline_access",
  "User.Read",
  "Calendars.ReadWrite",
];

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
    .select("id, tenant_id, name, slug, address, phone, whatsapp, email, description, city, commune, map_url, latitude, longitude, instagram_url, facebook_url, tiktok_url, website_url, use_global_socials, use_global_contact, use_global_hours, use_global_special_dates, is_active, created_at")
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

let windows = [];

const validWeeklyRows = (weeklyRows || []).filter(
  (row) => row.enabled && row.start_time && row.end_time
);

windows = validWeeklyRows
  .map((row) => {
    const start = timeToMinutes(row.start_time);
    const end = timeToMinutes(row.end_time);

    if (start !== null && end !== null && end > start) {
      return { start, end };
    }

    return null;
  })
  .filter(Boolean);

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

function rowsToAvailabilityWindows(rows) {
  return (rows || [])
    .filter((row) => row.enabled && row.start_time && row.end_time)
    .map((row) => {
      const start = timeToMinutes(row.start_time);
      const end = timeToMinutes(row.end_time);

      if (start !== null && end !== null && end > start) {
        return { start, end };
      }

      return null;
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);
}

function applySpecialDatesToWindows(windows, specialDates) {
  const dates = specialDates || [];
  const fullDayClosed = dates.some(
    (row) => row.is_closed && !row.start_time && !row.end_time
  );

  if (fullDayClosed) {
    return { windows: [], isClosed: true };
  }

  let nextWindows = [...(windows || [])];

  const openWindows = dates
    .filter((row) => !row.is_closed && row.start_time && row.end_time)
    .map((row) => ({
      start: timeToMinutes(row.start_time),
      end: timeToMinutes(row.end_time),
    }))
    .filter(
      (row) => row.start !== null && row.end !== null && row.end > row.start
    );

  if (openWindows.length > 0) {
    nextWindows = openWindows;
  }

  const partialClosedWindows = dates
    .filter((row) => row.is_closed && row.start_time && row.end_time)
    .map((row) => ({
      start: timeToMinutes(row.start_time),
      end: timeToMinutes(row.end_time),
    }))
    .filter(
      (row) => row.start !== null && row.end !== null && row.end > row.start
    );

  for (const blocked of partialClosedWindows) {
    nextWindows = subtractRange(nextWindows, blocked.start, blocked.end);
  }

  return {
    windows: nextWindows.sort((a, b) => a.start - b.start),
    isClosed: nextWindows.length === 0,
  };
}

async function getBusinessHoursRows({ tenant_id, branch_id, date }) {
  const weekday = parseDateToWeekday(date);

  let query = supabase
    .from("business_hours")
    .select("*")
    .eq("tenant_id", tenant_id)
    .eq("day_of_week", weekday)
    .order("day_of_week", { ascending: true });

  query = branch_id ? query.eq("branch_id", branch_id) : query.is("branch_id", null);

  const { data, error } = await query;
  if (error) throw error;

  return data || [];
}

async function getBusinessSpecialDateRows({ tenant_id, branch_id, date }) {
  let query = supabase
    .from("business_special_dates")
    .select("*")
    .eq("tenant_id", tenant_id)
    .eq("date", date)
    .order("created_at", { ascending: true });

  query = branch_id ? query.eq("branch_id", branch_id) : query.is("branch_id", null);

  const { data, error } = await query;
  if (error) throw error;

  return data || [];
}

async function getEffectiveBusinessAvailability({ tenant_id, branch_id, date }) {
  const branch = branch_id ? await getBranchById(branch_id) : null;

  if (branch && branch.tenant_id !== tenant_id) {
    throw new Error("La sucursal no pertenece al tenant enviado");
  }

  const useGlobalHours = branch ? branch.use_global_hours !== false : true;
  const useGlobalSpecialDates = branch
    ? branch.use_global_special_dates !== false
    : true;

  const globalHoursRows = await getBusinessHoursRows({
    tenant_id,
    branch_id: null,
    date,
  });

  const branchHoursRows = branch
    ? await getBusinessHoursRows({ tenant_id, branch_id: branch.id, date })
    : [];

  let baseHoursRows = [];
  let source = "none";

  if (branch) {
    if (useGlobalHours) {
      if (globalHoursRows.length > 0) {
        baseHoursRows = globalHoursRows;
        source = "global";
      } else if (branchHoursRows.length > 0) {
        baseHoursRows = branchHoursRows;
        source = "fallback_branch";
      }
    } else if (branchHoursRows.length > 0) {
      baseHoursRows = branchHoursRows;
      source = "branch";
    } else if (globalHoursRows.length > 0) {
      baseHoursRows = globalHoursRows;
      source = "fallback_global";
    }
  } else if (globalHoursRows.length > 0) {
    baseHoursRows = globalHoursRows;
    source = "global";
  }

  let windows = rowsToAvailabilityWindows(baseHoursRows);

  const globalSpecialDates = await getBusinessSpecialDateRows({
    tenant_id,
    branch_id: null,
    date,
  });

  const branchSpecialDates =
    branch && !useGlobalSpecialDates
      ? await getBusinessSpecialDateRows({
          tenant_id,
          branch_id: branch.id,
          date,
        })
      : [];

  const appliedSpecialDates = [
    ...globalSpecialDates.map((row) => ({ ...row, scope: "global" })),
    ...branchSpecialDates.map((row) => ({ ...row, scope: "branch" })),
  ];

  const specialResult = applySpecialDatesToWindows(windows, appliedSpecialDates);

  return {
    windows: specialResult.windows,
    isClosed: specialResult.isClosed,
    source,
    appliedSpecialDates,
    debug: {
      tenant_id,
      branch_id: branch?.id || null,
      use_global_hours: useGlobalHours,
      use_global_special_dates: useGlobalSpecialDates,
      global_hours_count: globalHoursRows.length,
      branch_hours_count: branchHoursRows.length,
      global_special_dates_count: globalSpecialDates.length,
      branch_special_dates_count: branchSpecialDates.length,
      fell_back_to_branch_hours: source === "fallback_branch",
      fell_back_to_global_hours: source === "fallback_global",
    },
  };
}

async function getStaffHoursRows({ tenant_id, branch_id, staff_id, date }) {
  const weekday = parseDateToWeekday(date);

  const { data, error } = await supabase
    .from("staff_hours")
    .select("*")
    .eq("tenant_id", tenant_id)
    .eq("branch_id", branch_id)
    .eq("staff_id", staff_id)
    .eq("day_of_week", weekday);

  if (error) throw error;

  return data || [];
}

async function getStaffSpecialDateRows({ tenant_id, branch_id, staff_id, date }) {
  const { data, error } = await supabase
    .from("staff_special_dates")
    .select("*")
    .eq("tenant_id", tenant_id)
    .eq("branch_id", branch_id)
    .eq("staff_id", staff_id)
    .eq("date", date)
    .order("created_at", { ascending: true });

  if (error) throw error;

  return data || [];
}

async function getEffectiveStaffAvailability({
  tenant_id,
  branch_id,
  staff_id,
  date,
}) {
  const { data: staffRow, error: staffError } = await supabase
    .from("staff")
    .select("id, tenant_id, branch_id, use_business_hours, is_active")
    .eq("tenant_id", tenant_id)
    .eq("branch_id", branch_id)
    .eq("id", staff_id)
    .single();

  if (staffError) throw staffError;

  if (!staffRow || !staffRow.is_active) {
    return {
      windows: [],
      isClosed: true,
      source: "staff_inactive",
      appliedSpecialDates: [],
      debug: { tenant_id, branch_id, staff_id, staff_active: false },
    };
  }

  const businessAvailability = await getEffectiveBusinessAvailability({
    tenant_id,
    branch_id,
    date,
  });

  let windows = businessAvailability.windows;
  let source = "effective_business";
  let staffHoursRows = [];

  if (!staffRow.use_business_hours) {
    staffHoursRows = await getStaffHoursRows({
      tenant_id,
      branch_id,
      staff_id,
      date,
    });

    const staffWindows = rowsToAvailabilityWindows(staffHoursRows);
    windows = intersectWindows(businessAvailability.windows, staffWindows);
    source = "staff";
  }

  const staffSpecialDates = await getStaffSpecialDateRows({
    tenant_id,
    branch_id,
    staff_id,
    date,
  });

  const staffSpecialResult = applySpecialDatesToWindows(
    windows,
    staffSpecialDates
  );

  return {
    windows: staffSpecialResult.windows,
    isClosed: staffSpecialResult.isClosed,
    source,
    appliedSpecialDates: [
      ...businessAvailability.appliedSpecialDates,
      ...staffSpecialDates.map((row) => ({ ...row, scope: "staff" })),
    ],
    debug: {
      tenant_id,
      branch_id,
      staff_id,
      use_business_hours: Boolean(staffRow.use_business_hours),
      staff_hours_count: staffHoursRows.length,
      business_source: businessAvailability.source,
      business: businessAvailability.debug,
      staff_special_dates_count: staffSpecialDates.length,
    },
  };
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

function filterSlotsByVisibleStep(slots, stepMinutes) {
  if (!Array.isArray(slots) || slots.length === 0) return [];
  if (!stepMinutes || stepMinutes <= 0) return slots;

  const sortedSlots = [...slots].sort(
    (a, b) => new Date(a.slot_start).getTime() - new Date(b.slot_start).getTime()
  );
  const visibleSlots = [];
  let nextAllowedStart = null;

  for (const slot of sortedSlots) {
    const startMs = new Date(slot.slot_start).getTime();

    if (Number.isNaN(startMs)) continue;

    if (nextAllowedStart === null || startMs >= nextAllowedStart) {
      visibleSlots.push(slot);
      nextAllowedStart = startMs + stepMinutes * 60 * 1000;
    }
  }

  return visibleSlots;
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

  let existingByPhone = null;

  if (normalizedPhone) {
    const { data, error } = await supabase
      .from("customers")
      .select("*")
      .eq("tenant_id", tenant_id)
      .eq("phone", normalizedPhone)
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    existingByPhone = data || null;
  }

  let existingByEmail = null;

  if (normalizedEmail) {
    const { data, error } = await supabase
      .from("customers")
      .select("*")
      .eq("tenant_id", tenant_id)
      .eq("email", normalizedEmail)
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    existingByEmail = data || null;
  }

  let existingByName = null;

  if (!existingByPhone && !existingByEmail && !normalizedPhone && !normalizedEmail && normalizedNameKey) {
    const { data: candidateCustomers, error: candidateError } = await supabase
      .from("customers")
      .select("*")
      .eq("tenant_id", tenant_id);

    if (candidateError) throw candidateError;

    existingByName =
      (candidateCustomers || []).find((customer) => {
          const customerNameKey = String(customer.name || "")
            .trim()
            .toLowerCase();

          return customerNameKey === normalizedNameKey;
        }) || null;
  }

  const existingCustomer =
    existingByPhone || existingByEmail || existingByName || null;

  if (existingCustomer) {
    const updatePayload = {
      name: normalizedName || existingCustomer.name || "",
      updated_at: new Date().toISOString(),
    };

    if (
      normalizedEmail &&
      (!existingByEmail || existingByEmail.id === existingCustomer.id)
    ) {
      updatePayload.email = normalizedEmail;
    } else if (!normalizedEmail && existingCustomer.email) {
      updatePayload.email = existingCustomer.email;
    }

    if (
      normalizedPhone &&
      (!existingByPhone || existingByPhone.id === existingCustomer.id)
    ) {
      updatePayload.phone = normalizedPhone;
    } else if (!normalizedPhone && existingCustomer.phone) {
      updatePayload.phone = existingCustomer.phone;
    }

    const { data: updatedCustomer, error: updateError } = await supabase
      .from("customers")
      .update(updatePayload)
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
async function findActiveCalendarConnection({ tenant_id, branch_id, staff_id }) {
  if (!tenant_id) return { provider: null, connection: null, source: "none" };

  const baseSelect =
    "id, tenant_id, branch_id, staff_id, provider, provider_calendar_id, account_email, access_token, refresh_token, expires_at, scope, token_type, is_active, created_at, updated_at";

  async function maybeConnection(query, source) {
    const { data, error } = await query
      .eq("tenant_id", tenant_id)
      .eq("is_active", true)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.warn(`No se pudo leer calendar_connections (${source}):`, error.message);
      return null;
    }

    if (!data) return null;
    return {
      provider: data.provider,
      connection: data,
      source,
    };
  }

  if (staff_id) {
    const staffConnection = await maybeConnection(
      supabase.from("calendar_connections").select(baseSelect).eq("staff_id", staff_id),
      "staff"
    );

    if (staffConnection) return staffConnection;
  }

  if (branch_id) {
    const branchConnection = await maybeConnection(
      supabase
        .from("calendar_connections")
        .select(baseSelect)
        .eq("branch_id", branch_id)
        .is("staff_id", null),
      "branch"
    );

    if (branchConnection) return branchConnection;
  }

  const businessConnection = await maybeConnection(
    supabase
      .from("calendar_connections")
      .select(baseSelect)
      .is("branch_id", null)
      .is("staff_id", null),
    "business"
  );

  return businessConnection || { provider: null, connection: null, source: "none" };
}

async function findLegacyCalendarTokenConnection(calendar_id) {
  if (!calendar_id) {
    return { provider: null, connection: null, source: "none" };
  }

  try {
    const { data: tokenRow, error } = await supabase
      .from("calendar_tokens")
      .select(
        "tenant_id, calendar_id, google_calendar_id, access_token, refresh_token, expiry_date, scope, token_type"
      )
      .eq("calendar_id", calendar_id)
      .maybeSingle();

    if (error) {
      console.warn("No se pudo leer calendar_tokens legacy:", error.message);
      return { provider: null, connection: null, source: "none" };
    }

    if (!tokenRow?.refresh_token) {
      return { provider: null, connection: null, source: "none" };
    }

    return {
      provider: "google",
      source: "legacy",
      connection: {
        id: null,
        tenant_id: tokenRow.tenant_id || null,
        branch_id: null,
        staff_id: null,
        provider: "google",
        provider_calendar_id: tokenRow.google_calendar_id || "primary",
        account_email: null,
        access_token: tokenRow.access_token || null,
        refresh_token: tokenRow.refresh_token,
        expires_at: tokenRow.expiry_date
          ? new Date(Number(tokenRow.expiry_date)).toISOString()
          : null,
        scope: tokenRow.scope || null,
        token_type: tokenRow.token_type || null,
        is_active: true,
        legacy_calendar_id: tokenRow.calendar_id || calendar_id,
      },
    };
  } catch (err) {
    console.warn("Error resolviendo calendar_tokens legacy:", err.message);
    return { provider: null, connection: null, source: "none" };
  }
}

async function resolveCalendarConnection({
  tenant_id,
  branch_id = null,
  staff_id = null,
  calendar_id = null,
}) {
  try {
    const connectionResult = await findActiveCalendarConnection({
      tenant_id,
      branch_id,
      staff_id,
    });

    if (connectionResult?.connection) return connectionResult;

    const legacyResult = await findLegacyCalendarTokenConnection(calendar_id);
    if (legacyResult?.connection) return legacyResult;
  } catch (err) {
    console.warn("Error resolviendo calendar connection:", err.message);
  }

  return { provider: null, connection: null, source: "none" };
}

function getGoogleCalendarClientFromConnection(connection) {
  if (!connection?.refresh_token) {
    throw new Error("La conexión Google no tiene refresh_token.");
  }

  const connectionOAuthClient = new google.auth.OAuth2(
    CLIENT_ID,
    CLIENT_SECRET,
    REDIRECT_URI
  );

  connectionOAuthClient.setCredentials({
    refresh_token: connection.refresh_token,
  });

  const calendar = google.calendar({
    version: "v3",
    auth: connectionOAuthClient,
  });
  const googleCalendarId = connection.provider_calendar_id || "primary";

  return { calendar, googleCalendarId };
}

async function deleteCalendarEventForAppointment(appt) {
  const externalEventId = appt?.provider_event_id || appt?.event_id;

  if (!externalEventId) return;

  try {
    const provider = appt.calendar_provider || (appt.event_id ? "google" : null);

    if (provider && provider !== "google") {
      console.warn(
        `Provider de calendario no soportado para borrar evento: ${provider}`
      );
      return;
    }

    if (appt.calendar_provider === "google" && appt.calendar_connection_id) {
      const { data: connection, error } = await supabase
        .from("calendar_connections")
        .select("*")
        .eq("id", appt.calendar_connection_id)
        .maybeSingle();

      if (error || !connection) {
        throw new Error(
          error?.message || "No se encontró calendar_connection para borrar evento"
        );
      }

      const { calendar, googleCalendarId } =
        getGoogleCalendarClientFromConnection(connection);

      await calendar.events.delete({
        calendarId: googleCalendarId,
        eventId: externalEventId,
      });

      return;
    }

    if (
      appt.calendar_connection_source === "legacy" ||
      (!appt.calendar_provider && appt.event_id) ||
      (appt.calendar_provider === "google" && !appt.calendar_connection_id)
    ) {
      const { calendar, googleCalendarId } =
        await getGoogleCalendarClientByCalendarId(appt.calendar_id);

      await calendar.events.delete({
        calendarId: googleCalendarId,
        eventId: externalEventId,
      });
    }
  } catch (e) {
    console.error("Error borrando evento externo de calendario:", e.message);
  }
}

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
    const { calendar_id, tenant_id, branch_id, staff_id, scope_level } = req.query;

    const stateObj =
      scope_level === "staff"
        ? {
            provider: "google",
            calendar_id: calendar_id ? String(calendar_id) : null,
            tenant_id: tenant_id ? String(tenant_id) : null,
            branch_id: branch_id ? String(branch_id) : null,
            staff_id: staff_id ? String(staff_id) : null,
            scope_level: "staff",
          }
        : calendar_id
        ? { calendar_id: String(calendar_id) }
        : { calendar_id: null, fixed: true };

    const state = Buffer.from(JSON.stringify(stateObj)).toString("base64url");

    const url = oAuth2Client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: SCOPES,
      state,
    });
return res.redirect(url);
   
  } catch (e) {
    res.status(500).send("Error en /auth: " + e.message);
  }
});

async function getMicrosoftAccessTokenFromCode(code) {
  const tokenParams = new URLSearchParams({
    client_id: MICROSOFT_CLIENT_ID,
    client_secret: MICROSOFT_CLIENT_SECRET,
    code: String(code || ""),
    redirect_uri: MICROSOFT_REDIRECT_URI,
    grant_type: "authorization_code",
    scope: MICROSOFT_SCOPES.join(" "),
  });

  const response = await fetch(
    "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenParams,
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data?.error_description || data?.error || "No se pudo obtener token Microsoft"
    );
  }

  return {
    ...data,
    expires_at: data.expires_in
      ? new Date(Date.now() + Number(data.expires_in) * 1000).toISOString()
      : null,
  };
}

async function getMicrosoftUserProfile(accessToken) {
  const response = await fetch(
    "https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName",
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data?.error?.message || "No se pudo obtener perfil Microsoft"
    );
  }

  return data;
}

app.get("/auth/microsoft", async (req, res) => {
  try {
    if (!MICROSOFT_CLIENT_ID || !MICROSOFT_CLIENT_SECRET || !MICROSOFT_REDIRECT_URI) {
      return res.status(500).send("Faltan variables ENV Microsoft OAuth.");
    }

    const { calendar_id, tenant_id, branch_id, staff_id, scope_level } = req.query;

    const stateObj = {
      provider: "microsoft",
      calendar_id: calendar_id ? String(calendar_id) : null,
      tenant_id: tenant_id ? String(tenant_id) : null,
      branch_id: branch_id ? String(branch_id) : null,
      staff_id: staff_id ? String(staff_id) : null,
      scope_level: scope_level ? String(scope_level) : null,
    };

    const state = Buffer.from(JSON.stringify(stateObj)).toString("base64url");
    const authParams = new URLSearchParams({
      client_id: MICROSOFT_CLIENT_ID,
      response_type: "code",
      redirect_uri: MICROSOFT_REDIRECT_URI,
      response_mode: "query",
      scope: MICROSOFT_SCOPES.join(" "),
      state,
      prompt: "consent",
    });

    return res.redirect(
      `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${authParams.toString()}`
    );
  } catch (e) {
    res.status(500).send("Error en /auth/microsoft: " + e.message);
  }
});

app.get("/oauth2callback/microsoft", async (req, res) => {
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

    if (state?.provider !== "microsoft") {
      return res.status(400).send("State Microsoft inválido.");
    }

    const tenant_id = state.tenant_id ? String(state.tenant_id) : "";
    const branch_id = state.branch_id ? String(state.branch_id) : null;
    const staff_id = state.staff_id ? String(state.staff_id) : "";

    if (!tenant_id || !staff_id) {
      return res.status(400).send("Faltan tenant_id o staff_id para conectar calendario Microsoft.");
    }

    const tokens = await getMicrosoftAccessTokenFromCode(code);

    if (!tokens.refresh_token) {
      return res
        .status(400)
        .send("Microsoft no devolvió refresh_token. Reautoriza la conexión.");
    }

    const { data: tenantData, error: tenantErr } = await supabase
      .from("tenants")
      .select("id, slug")
      .eq("id", tenant_id)
      .single();

    if (tenantErr || !tenantData) {
      return res.status(404).send("Negocio no encontrado para conectar calendario Microsoft.");
    }

    const { data: staffData, error: staffErr } = await supabase
      .from("staff")
      .select("id, tenant_id, branch_id")
      .eq("id", staff_id)
      .eq("tenant_id", tenant_id)
      .single();

    if (staffErr || !staffData) {
      return res.status(404).send("Staff no encontrado para conectar calendario Microsoft.");
    }

    if (branch_id && String(staffData.branch_id || "") !== branch_id) {
      return res.status(400).send("El staff no pertenece a la sucursal indicada.");
    }

    const profile = await getMicrosoftUserProfile(tokens.access_token);
    const accountEmail = profile?.mail || profile?.userPrincipalName || null;
    const nowIso = new Date().toISOString();

    const { error: deactivateErr } = await supabase
      .from("calendar_connections")
      .update({ is_active: false, updated_at: nowIso })
      .eq("tenant_id", tenant_id)
      .eq("staff_id", staff_id)
      .eq("provider", "microsoft")
      .eq("is_active", true);

    if (deactivateErr) throw deactivateErr;

    const { error: insertConnectionErr } = await supabase
      .from("calendar_connections")
      .insert({
        tenant_id,
        branch_id: branch_id || null,
        staff_id,
        provider: "microsoft",
        provider_calendar_id: "primary",
        account_email: accountEmail,
        refresh_token: tokens.refresh_token,
        access_token: tokens.access_token ?? null,
        token_type: tokens.token_type ?? null,
        scope: tokens.scope ?? MICROSOFT_SCOPES.join(" "),
        expires_at: tokens.expires_at,
        is_active: true,
        updated_at: nowIso,
      });

    if (insertConnectionErr) throw insertConnectionErr;

    const frontendUrl = "https://www.orbyx.cl";
    if (tenantData.slug) {
      return res.redirect(
        `${frontendUrl}/dashboard/${tenantData.slug}/staff?calendar_connected=1`
      );
    }

    return res.send("Calendario Microsoft conectado correctamente para el staff.");
  } catch (error) {
    console.error("Error en OAuth callback Microsoft:", error);
    res.status(500).send("Error en OAuth callback Microsoft: " + error.message);
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

    if (state?.provider === "google" && state?.scope_level === "staff") {
      const tenant_id = state.tenant_id ? String(state.tenant_id) : "";
      const branch_id = state.branch_id ? String(state.branch_id) : null;
      const staff_id = state.staff_id ? String(state.staff_id) : "";

      if (!tenant_id || !staff_id) {
        return res.status(400).send("Faltan tenant_id o staff_id para conectar calendario staff.");
      }

      const { data: tenantData, error: tenantErr } = await supabase
        .from("tenants")
        .select("id, slug")
        .eq("id", tenant_id)
        .single();

      if (tenantErr || !tenantData) {
        return res.status(404).send("Negocio no encontrado para conectar calendario staff.");
      }

      const { data: staffData, error: staffErr } = await supabase
        .from("staff")
        .select("id, tenant_id, branch_id")
        .eq("id", staff_id)
        .eq("tenant_id", tenant_id)
        .single();

      if (staffErr || !staffData) {
        return res.status(404).send("Staff no encontrado para conectar calendario.");
      }

      if (branch_id && String(staffData.branch_id || "") !== branch_id) {
        return res.status(400).send("El staff no pertenece a la sucursal indicada.");
      }

      let accountEmail = null;
      try {
        const oauth2 = google.oauth2({ version: "v2", auth: oAuth2Client });
        const { data: profile } = await oauth2.userinfo.get();
        accountEmail = profile?.email || null;
      } catch (profileErr) {
        console.warn("No se pudo obtener email de cuenta Google:", profileErr.message);
      }

      const nowIso = new Date().toISOString();

      const { error: deactivateErr } = await supabase
        .from("calendar_connections")
        .update({ is_active: false, updated_at: nowIso })
        .eq("tenant_id", tenant_id)
        .eq("staff_id", staff_id)
        .eq("provider", "google")
        .eq("is_active", true);

      if (deactivateErr) throw deactivateErr;

      const { error: insertConnectionErr } = await supabase
        .from("calendar_connections")
        .insert({
          tenant_id,
          branch_id: branch_id || null,
          staff_id,
          provider: "google",
          provider_calendar_id: "primary",
          account_email: accountEmail,
          refresh_token: tokens.refresh_token,
          access_token: tokens.access_token ?? null,
          token_type: tokens.token_type ?? null,
          scope: tokens.scope ?? null,
          expires_at: tokens.expiry_date
            ? new Date(Number(tokens.expiry_date)).toISOString()
            : null,
          is_active: true,
          updated_at: nowIso,
        });

      if (insertConnectionErr) throw insertConnectionErr;

      const frontendUrl = "https://www.orbyx.cl";
      if (tenantData.slug) {
        return res.redirect(
          `${frontendUrl}/dashboard/${tenantData.slug}/staff?calendar_connected=1`
        );
      }

      return res.send("Calendario Google conectado correctamente para el staff.");
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

app.get("/calendar-connections", tenantAuth, async (req, res) => {
  try {
    const { tenant_id, staff_id, branch_id } = req.query;

    if (!tenant_id) {
      return res.status(400).json({ error: "tenant_id es obligatorio" });
    }

    let query = supabase
      .from("calendar_connections")
      .select(
        "id, provider, account_email, staff_id, branch_id, is_active, created_at, updated_at"
      )
      .eq("tenant_id", tenant_id)
      .order("updated_at", { ascending: false });

    if (staff_id) query = query.eq("staff_id", staff_id);
    if (branch_id) query = query.eq("branch_id", branch_id);

    const { data, error } = await query;

    if (error) throw error;

    return res.json({
      total: data?.length || 0,
      connections: data || [],
    });
  } catch (err) {
    console.error("GET /calendar-connections error:", err.message);
    return res.status(500).json({ error: err.message });
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
app.get("/business-hours", tenantAuth, async (req, res) => {
  try {
    const { tenant_id, branch_id, scope } = req.query;

    if (!tenant_id) {
      return res.status(400).json({ error: "tenant_id es obligatorio" });
    }

    const isGlobalScope = scope === "global" || branch_id === "null";

    if (!isGlobalScope && !branch_id) {
      return res.status(400).json({ error: "branch_id es obligatorio" });
    }

    let query = supabase
      .from("business_hours")
      .select("*")
      .eq("tenant_id", tenant_id)
      .order("day_of_week", { ascending: true });

    query = isGlobalScope ? query.is("branch_id", null) : query.eq("branch_id", branch_id);

    const { data, error } = await query;

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

app.put("/business-hours", tenantAuthWrite, async (req, res) => {
  try {
    const { tenant_id, branch_id, scope, hours } = req.body;

    if (!tenant_id) return res.status(400).json({ error: "tenant_id es obligatorio" });
    const isGlobalScope = scope === "global" || branch_id === null || branch_id === "null";
    if (!isGlobalScope && !branch_id) return res.status(400).json({ error: "branch_id es obligatorio" });
    if (!Array.isArray(hours)) return res.status(400).json({ error: "hours debe ser un arreglo" });

    const targetBranchId = isGlobalScope ? null : branch_id;
    const rows = [];

    for (const item of hours) {
      const dayOfWeek = Number(item.day_of_week);
      const enabled = Boolean(item.enabled);

      const blocks = Array.isArray(item.blocks)
        ? item.blocks
        : [{ start_time: item.start_time, end_time: item.end_time }];

      if (!enabled) {
        rows.push({
          tenant_id,
          branch_id: targetBranchId,
          day_of_week: dayOfWeek,
          enabled: false,
          start_time: null,
          end_time: null,
          updated_at: new Date().toISOString(),
        });
        continue;
      }

      for (const block of blocks) {
        if (!block.start_time || !block.end_time) continue;

        rows.push({
          tenant_id,
          branch_id: targetBranchId,
          day_of_week: dayOfWeek,
          enabled: true,
          start_time: block.start_time,
          end_time: block.end_time,
          updated_at: new Date().toISOString(),
        });
      }
    }

    let deleteQuery = supabase
      .from("business_hours")
      .delete()
      .eq("tenant_id", tenant_id);

    deleteQuery = isGlobalScope
      ? deleteQuery.is("branch_id", null)
      : deleteQuery.eq("branch_id", targetBranchId);

    await deleteQuery;

    const { data, error } = await supabase
      .from("business_hours")
      .insert(rows)
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
app.get("/business-special-dates", tenantAuth, async (req, res) => {
  try {
    const { tenant_id, branch_id, scope } = req.query;

    if (!tenant_id) {
      return res.status(400).json({ error: "tenant_id es obligatorio" });
    }

    const isGlobalScope = scope === "global" || branch_id === "null";

    if (!isGlobalScope && !branch_id) {
      return res.status(400).json({ error: "branch_id es obligatorio" });
    }

    let query = supabase
      .from("business_special_dates")
      .select("*")
      .eq("tenant_id", tenant_id)
      .order("date", { ascending: true })
      .order("created_at", { ascending: true });

    query = isGlobalScope ? query.is("branch_id", null) : query.eq("branch_id", branch_id);

    const { data, error } = await query;

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
app.post("/business-special-dates", tenantAuthWrite, async (req, res) => {
  try {
    const {
      tenant_id,
      branch_id,
      scope,
      date,
      label,
      is_closed,
      start_time,
      end_time,
    } = req.body;

    if (!tenant_id) {
      return res.status(400).json({ error: "tenant_id es obligatorio" });
    }

    const isGlobalScope = scope === "global" || branch_id === null || branch_id === "null";

    if (!isGlobalScope && !branch_id) {
      return res.status(400).json({ error: "branch_id es obligatorio" });
    }

    if (!date) {
      return res.status(400).json({ error: "date es obligatorio" });
    }

    const payload = {
      tenant_id,
      branch_id: isGlobalScope ? null : branch_id,
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
app.put("/business-special-dates/:id", tenantAuthWrite, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      tenant_id,
      branch_id,
      scope,
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
    const isGlobalScope = scope === "global" || branch_id === null || branch_id === "null";

    if (tenant_id !== undefined) payload.tenant_id = tenant_id;
    if (branch_id !== undefined || scope !== undefined) {
      payload.branch_id = isGlobalScope ? null : branch_id;
    }
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
app.delete("/business-special-dates/:id", tenantAuthWrite, async (req, res) => {
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
app.get("/staff", tenantAuth, async (req, res) => {
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

app.post("/staff", tenantAuthWrite, async (req, res) => {
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

app.put("/staff/:id", tenantAuthWrite, async (req, res) => {
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
app.delete("/staff/:id", tenantAuthWrite, async (req, res) => {
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
app.get("/staff-services", tenantAuth, async (req, res) => {
  try {
    const { tenant_id, staff_id, branch_id } = req.query;

    if (!tenant_id) {
      return res.status(400).json({ error: "tenant_id es obligatorio" });
    }

    let resolvedBranchId = null;
    if (branch_id) {
      resolvedBranchId = await resolveBranchId({
        tenant_id,
        branch_id,
      });
    }

    let query = supabase
      .from("staff_services")
      .select("*")
      .eq("tenant_id", tenant_id)
      .order("created_at", { ascending: true });

    if (staff_id) {
      query = query.eq("staff_id", staff_id);
    }

    if (resolvedBranchId) {
      query = query.eq("branch_id", resolvedBranchId);
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
app.put("/staff-services", tenantAuthWrite, async (req, res) => {
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
app.delete("/staff-services/:id", tenantAuthWrite, async (req, res) => {
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
app.get("/staff-hours", tenantAuth, async (req, res) => {
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
   Soporta múltiples bloques por día
====================================================== */
app.put("/staff-hours", tenantAuthWrite, async (req, res) => {
  try {
    const { tenant_id, staff_id, hours } = req.body;

    if (!tenant_id) {
      return res.status(400).json({ error: "tenant_id es obligatorio" });
    }

    if (!staff_id) {
      return res.status(400).json({ error: "staff_id es obligatorio" });
    }

    if (!Array.isArray(hours)) {
      return res.status(400).json({ error: "hours debe ser un arreglo" });
    }

    const { data: staffData, error: staffError } = await supabase
      .from("staff")
      .select("branch_id")
      .eq("id", staff_id)
      .single();

    if (staffError || !staffData) {
      return res.status(400).json({ error: "No se pudo obtener branch_id del staff" });
    }

    const branch_id_real = staffData.branch_id;

    for (const item of hours) {
      if (!isValidDayOfWeek(item.day_of_week)) {
        return res.status(400).json({ error: "day_of_week inválido" });
      }

      if (item.enabled && (!item.start_time || !item.end_time)) {
        return res.status(400).json({ error: "Cada bloque activo debe tener inicio y fin" });
      }

      if (item.enabled && item.start_time >= item.end_time) {
        return res.status(400).json({ error: "La hora fin debe ser mayor a la hora inicio" });
      }
    }

    const { error: deleteError } = await supabase
      .from("staff_hours")
      .delete()
      .eq("tenant_id", tenant_id)
      .eq("branch_id", branch_id_real)
      .eq("staff_id", staff_id);

    if (deleteError) throw deleteError;

    const payload = hours
      .filter((item) => Boolean(item.enabled))
      .map((item, index) => ({
        tenant_id,
        branch_id: branch_id_real,
        staff_id,
        day_of_week: Number(item.day_of_week),
        block_order: Number(item.block_order || index + 1),
        enabled: true,
        start_time: item.start_time || "09:00:00",
        end_time: item.end_time || "18:00:00",
        updated_at: new Date().toISOString(),
      }));

    if (payload.length === 0) {
      return res.json({
        ok: true,
        hours: [],
      });
    }

    const { data, error } = await supabase
      .from("staff_hours")
      .insert(payload)
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
app.get("/staff-special-dates", tenantAuth, async (req, res) => {
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

app.post("/staff-special-dates", tenantAuthWrite, async (req, res) => {
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
      start_time: start_time || null,
      end_time: end_time || null,
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

app.put("/staff-special-dates/:id", tenantAuthWrite, async (req, res) => {
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

    if (start_time !== undefined) payload.start_time = start_time || null;
    if (end_time !== undefined) payload.end_time = end_time || null;

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
app.delete("/staff-special-dates/:id", tenantAuthWrite, async (req, res) => {
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

app.get("/slots", publicLimiter, async (req, res) => {
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

app.post("/appointments/slot", publicLimiter, async (req, res) => {
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
  .in("status", isGroup ? ["booked", "completed", "no_show", "rescheduled"] : ["booked"]);

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





    if (!isGroup) {
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
}


    const totalMinutes = duration + bufferBefore + bufferAfter;

const slotDateStr = String(date).slice(0, 10);

    let validSlots = [];

    if (staff_id) {
      const staffAvailability = await getEffectiveStaffAvailability({
        tenant_id: cal.tenant_id,
        branch_id: resolvedBranchId,
        staff_id,
        date: slotDateStr,
      });

      let finalWindows = staffAvailability.windows;

      if (!isGroup) {
        finalWindows = await subtractAppointmentsFromWindows({
          tenant_id: cal.tenant_id,
          branch_id: resolvedBranchId,
          staff_id,
          date: slotDateStr,
          windows: finalWindows,
        });
      }

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
      const serviceStaffIds = service_id
        ? await getServiceStaffIds({
            tenant_id: cal.tenant_id,
            branch_id: resolvedBranchId,
            service_id,
          })
        : [];

      let mergedSlots = [];

      for (const currentStaffId of serviceStaffIds) {
        const staffAvailability = await getEffectiveStaffAvailability({
          tenant_id: cal.tenant_id,
          branch_id: resolvedBranchId,
          staff_id: currentStaffId,
          date: slotDateStr,
        });

        let finalWindows = staffAvailability.windows;

        if (!isGroup) {
          finalWindows = await subtractAppointmentsFromWindows({
            tenant_id: cal.tenant_id,
            branch_id: resolvedBranchId,
            staff_id: currentStaffId,
            date: slotDateStr,
            windows: finalWindows,
          });
        }

        const staffSlots = filterSlotsForServiceDuration(
          buildSlotsFromWindows(
            finalWindows,
            slotDateStr,
            slotMinutes
          ),
          totalMinutes,
          slotMinutes
        ).map((slot) => ({
          ...slot,
          staff_id: currentStaffId,
        }));

        mergedSlots.push(...staffSlots);
      }

      validSlots = mergedSlots;
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

const customer = await upsertCustomerFromAppointment({
  tenant_id: cal.tenant_id,
  customer_name: String(customer_name).trim(),
  customer_email: normalizedEmail,
  customer_phone: normalizedPhone,
  start_at: start.toISOString(),
});

const { data: overlappingAppointments, error: overlapErr } = await supabase
  .from("appointments")
  .select("id")
  .eq("tenant_id", cal.tenant_id)
  .eq("customer_id", customer.id)
  .neq("status", "canceled")
  .lt("start_at", end.toISOString())
  .gt("end_at", start.toISOString())
  .limit(1);

if (overlapErr) {
  return res.status(500).json({ error: overlapErr.message });
}

if ((overlappingAppointments || []).length > 0) {
  return res.status(409).json({
    error:
      "Esta persona ya tiene una reserva activa que se cruza con este horario.",
  });
}

    const cancelToken = crypto.randomBytes(24).toString("hex");

    const { data: apptRows, error: insErr } = await supabase
      .from("appointments")
      .insert({
        tenant_id: cal.tenant_id,
        branch_id: resolvedBranchId,
        calendar_id,
        service_id,
        staff_id: staff_id || null,
        customer_id: customer.id,
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

// Consolidar campos extra del booking en customers.extra_data (campos personalizados del tenant)
if (customerData && typeof customerData === "object" && Object.keys(customerData).length > 0) {
  const extraFields = { ...customerData };
  // Excluir campos internos de mascotas que no son datos del cliente
  delete extraFields.pet_id;
  delete extraFields.pet_name;
  delete extraFields.pet_species;
  delete extraFields.pet_breed;
  if (Object.keys(extraFields).length > 0) {
    const { data: existingCustomer } = await supabase
      .from("customers")
      .select("id, extra_data")
      .eq("id", customer.id)
      .single();
    if (existingCustomer) {
      const mergedExtra = { ...(existingCustomer.extra_data ?? {}), ...extraFields };
      await supabase
        .from("customers")
        .update({ extra_data: mergedExtra })
        .eq("id", existingCustomer.id);
    }
  }
}

    let apptUpdated = appt;
    let googleCalendarId = null;
    let eventId = null;
    let googleHtmlLink = null;
    let googleSynced = false;
    let calendarSyncStatus = "pending";
    let calendarSyncError = null;
    let calendarProvider = null;
    let calendarConnectionId = null;
    let calendarConnectionSource = null;

    async function updateCalendarSyncStatus(fields, context) {
      const { data, error } = await supabase
        .from("appointments")
        .update(fields)
        .eq("id", appt.id)
        .select("*")
        .single();

      if (error) {
        console.warn(`${context}:`, error.message);
        return null;
      }

      return data || null;
    }

    await updateCalendarSyncStatus(
      {
        calendar_sync_status: "pending",
        calendar_sync_error: null,
        calendar_synced_at: null,
      },
      "Reserva creada, pero fallo marcar sync pending"
    );

    try {
      const calendarConnectionResult = await resolveCalendarConnection({
        tenant_id: cal.tenant_id,
        branch_id: resolvedBranchId,
        staff_id: staff_id || null,
        calendar_id,
      });

      calendarProvider = calendarConnectionResult?.provider || null;
      calendarConnectionId = calendarConnectionResult?.connection?.id || null;
      calendarConnectionSource = calendarConnectionResult?.source || null;

      if (!calendarConnectionResult?.connection) {
        throw new Error("Sin conexión de calendario activa");
      }

      if (calendarConnectionResult.provider !== "google") {
        throw new Error("Provider de calendario no soportado todavía");
      }

      const { calendar, googleCalendarId: connectedGoogleCalendarId } =
        getGoogleCalendarClientFromConnection(calendarConnectionResult.connection);
      googleCalendarId = connectedGoogleCalendarId;

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

    eventId = response?.data?.id || null;
    googleHtmlLink = response?.data?.htmlLink || null;

    if (!eventId) {
      throw new Error("Google Calendar no retorno event_id");
    }

    const updatedAppointment = await updateCalendarSyncStatus(
      {
        event_id: eventId,
        calendar_provider: calendarProvider,
        calendar_connection_id: calendarConnectionId,
        provider_event_id: eventId,
        calendar_connection_source: calendarConnectionSource,
        calendar_sync_status: "synced",
        calendar_sync_error: null,
        calendar_synced_at: new Date().toISOString(),
      },
      "Reserva creada, pero fallo guardar sync_status de Google"
    );

    if (!updatedAppointment) {
      const { data: fallbackAppointment, error: eventIdErr } = await supabase
        .from("appointments")
        .update({
          event_id: eventId,
          calendar_provider: calendarProvider,
          calendar_connection_id: calendarConnectionId,
          provider_event_id: eventId,
          calendar_connection_source: calendarConnectionSource,
        })
        .eq("id", appt.id)
        .select("*")
        .single();

      if (eventIdErr) {
        console.warn(
          "Reserva creada, pero fallo guardar event_id de Google:",
          eventIdErr.message
        );
      } else if (fallbackAppointment) {
        apptUpdated = fallbackAppointment;
        googleSynced = true;
        calendarSyncStatus = "synced";
      }
    } else if (updatedAppointment) {
      apptUpdated = updatedAppointment;
      googleSynced = true;
      calendarSyncStatus = "synced";
    }
    } catch (googleErr) {
      calendarSyncStatus = "error";
      calendarSyncError = String(googleErr?.message || googleErr).slice(0, 1000);

      const syncErrorAppointment = await updateCalendarSyncStatus(
        {
          calendar_provider: calendarProvider,
          calendar_connection_id: calendarConnectionId,
          provider_event_id: null,
          calendar_connection_source: calendarConnectionSource,
          calendar_sync_status: "error",
          calendar_sync_error: calendarSyncError,
          calendar_synced_at: null,
        },
        "Reserva creada, pero fallo guardar error de sincronizacion Google"
      );

      if (syncErrorAppointment) {
        apptUpdated = syncErrorAppointment;
      }

      console.warn(
        "Reserva creada sin sincronizar Google Calendar:",
        googleErr?.message || googleErr
      );
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
        htmlLink: googleHtmlLink,
        synced: googleSynced,
        sync_status: calendarSyncStatus,
        sync_error: calendarSyncError,
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

app.patch("/appointments/:id/clinical", tenantAuthSlugWrite, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      reason,
      notes,
      diagnosis,
      treatment,
      symptoms,
      medications,
      referrals,
      follow_up_notes,
      control_type,
      control_note,
      next_control_at,
      next_control_label,
      extra_fields,
    } = req.body;

    if (!id) {
      return res.status(400).json({ error: "Falta appointment id" });
    }

    const { data: appointment, error: appointmentError } = await supabase
      .from("appointments")
      .select("id, tenant_id, branch_id, customer_id, pet_id, staff_id, start_at")
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

    let clinicalNoteError = null;
    try {
      const { data: existingNote } = await supabase
        .from("clinical_notes")
        .select("id")
        .eq("appointment_id", id)
        .maybeSingle();
      if (existingNote) {
        const { error: updateErr } = await supabase
          .from("clinical_notes")
          .update({
            reason:              normalizedReason ?? null,
            diagnosis:           normalizeNullablePetText(diagnosis),
            treatment:           normalizeNullablePetText(treatment),
            symptoms:            String(symptoms || "").trim() || null,
            medications:         String(medications || "").trim() || null,
            referrals:           String(referrals || "").trim() || null,
            follow_up_notes:     String(follow_up_notes || "").trim() || null,
            observations:        normalizedNotes ?? null,
            next_control_at:     next_control_at || null,
            next_control_label:  String(next_control_label || "").trim() || null,
            control_type:        String(control_type || "").trim() || null,
            extra_fields:        extra_fields ?? null,
            updated_at:          new Date().toISOString(),
          })
          .eq("id", existingNote.id);
        if (updateErr) {
          console.error("[clinical_notes] update error:", updateErr.message);
          clinicalNoteError = updateErr.message;
        }
      } else {
        const { error: insertErr } = await supabase.from("clinical_notes").insert({
          tenant_id:           appointment.tenant_id,
          branch_id:           appointment.branch_id ?? null,
          pet_id:              appointment.pet_id || null,
          appointment_id:      id,
          staff_id:            appointment.staff_id ?? null,
          date:                appointment.start_at
                                 ? appointment.start_at.split("T")[0]
                                 : new Date().toISOString().split("T")[0],
          reason:              normalizedReason ?? null,
          diagnosis:           normalizeNullablePetText(diagnosis),
          treatment:           normalizeNullablePetText(treatment),
          symptoms:            String(symptoms || "").trim() || null,
          medications:         String(medications || "").trim() || null,
          referrals:           String(referrals || "").trim() || null,
          follow_up_notes:     String(follow_up_notes || "").trim() || null,
          observations:        normalizedNotes ?? null,
          next_control_at:     next_control_at || null,
          next_control_label:  String(next_control_label || "").trim() || null,
          control_type:        String(control_type || "").trim() || null,
          extra_fields:        extra_fields ?? null,
        });
        if (insertErr) {
          console.error("[clinical_notes] insert error:", insertErr.message);
          clinicalNoteError = insertErr.message;
        }
      }
    } catch (cnErr) {
      console.error("[clinical_notes] upsert failed on clinical patch:", cnErr.message);
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
      clinicalNoteError: clinicalNoteError ?? null,
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
app.get("/appointments/by-day/:slug/:date", tenantAuthSlug, async (req, res) => {
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
app.get("/appointments/by-range/:slug", tenantAuthSlug, async (req, res) => {
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

    const serviceIds = [
      ...new Set((appointments || []).map((appt) => appt.service_id).filter(Boolean)),
    ];
    const staffIds = [
      ...new Set((appointments || []).map((appt) => appt.staff_id).filter(Boolean)),
    ];

    let servicesById = new Map();
    let staffById = new Map();

    if (serviceIds.length > 0) {
      const { data: services, error: servicesError } = await supabase
        .from("services")
        .select("id, is_group, capacity")
        .in("id", serviceIds);

      if (servicesError) {
        return res.status(500).json({ error: servicesError.message });
      }

      servicesById = new Map((services || []).map((service) => [service.id, service]));
    }

    if (staffIds.length > 0) {
      const { data: staffRows, error: staffError } = await supabase
        .from("staff")
        .select("id, name")
        .in("id", staffIds);

      if (staffError) {
        return res.status(500).json({ error: staffError.message });
      }

      staffById = new Map((staffRows || []).map((staff) => [staff.id, staff]));
    }

    const enrichedAppointments = (appointments || []).map((appt) => {
      const service = appt.service_id ? servicesById.get(appt.service_id) : null;
      const staff = appt.staff_id ? staffById.get(appt.staff_id) : null;

      return {
        ...appt,
        service_is_group: Boolean(service?.is_group),
        service_capacity: service ? Number(service.capacity || 1) : null,
        staff_name: staff?.name || null,
      };
    });

    return res.json({
      appointments: enrichedAppointments,
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
app.get("/appointments/pending-close/:slug", tenantAuthSlug, async (req, res) => {
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
app.get("/dashboard/metrics/:slug", tenantAuthSlug, async (req, res) => {
  try {
    const { slug } = req.params;
    const { branch_id } = req.query;

    const { data: tenant, error: tenantError } = await supabase
      .from("tenants")
      .select("id, name, slug")
      .eq("slug", slug)
      .eq("is_active", true)
      .single();

    if (tenantError || !tenant) {
      return res.status(404).json({ error: "Negocio no encontrado" });
    }

    let resolvedBranchId = null;
    if (branch_id) {
      try {
        resolvedBranchId = await resolveBranchId({
          tenant_id: tenant.id,
          branch_id,
        });
      } catch (branchError) {
        return res.status(400).json({
          error: branchError.message || "branch_id inválido",
        });
      }
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

    let appointmentsQuery = supabase
      .from("appointments")
      .select("id, start_at, status")
      .eq("tenant_id", tenant.id)
      .gte("start_at", rangeStartIso)
      .lte("start_at", rangeEndIso);

    if (resolvedBranchId) {
      appointmentsQuery = appointmentsQuery.eq("branch_id", resolvedBranchId);
    }

    const { data: appointments, error: appointmentsError } =
      await appointmentsQuery;

    if (appointmentsError) {
      return res.status(500).json({ error: appointmentsError.message });
    }

    let upcomingQuery = supabase
      .from("appointments")
      .select("*", { count: "exact", head: true })
      .eq("tenant_id", tenant.id)
      .eq("status", "booked")
      .gte("start_at", nowIso);

    if (resolvedBranchId) {
      upcomingQuery = upcomingQuery.eq("branch_id", resolvedBranchId);
    }

    const { count: upcomingCount, error: upcomingError } = await upcomingQuery;

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
app.get("/appointments/customer-history/:slug", tenantAuthSlug, async (req, res) => {
  try {
    const { slug } = req.params;
    const { customer_id, branch_id } = req.query;

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

    let resolvedBranchId = null;
    if (branch_id) {
      try {
        resolvedBranchId = await resolveBranchId({
          tenant_id: tenant.id,
          branch_id,
        });
      } catch (branchError) {
        return res.status(400).json({
          error: branchError.message || "branch_id inválido",
        });
      }
    }

    let query = supabase
      .from("appointments")
      .select("*")
      .eq("tenant_id", tenant.id)
      .eq("customer_id", customer_id)
      .order("start_at", { ascending: false });

    if (resolvedBranchId) {
      query = query.eq("branch_id", resolvedBranchId);
    }

    const { data, error } = await query;

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
app.get("/pets/:id/clinical-pdf", [dashboardLimiter, requireTenantAuth], async (req, res) => {
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

    const { data: clinicalNotesRows } = await supabase
      .from("clinical_notes")
      .select("id, appointment_id, diagnosis, treatment, observations, control_type")
      .eq("tenant_id", tenant.id)
      .eq("pet_id", pet.id);

    const clinicalNotesMap = Object.fromEntries(
      (clinicalNotesRows || [])
        .filter((n) => n.appointment_id)
        .map((n) => [n.appointment_id, n])
    );

    // ── PALETA ────────────────────────────────────────────
    const TEAL_DARK  = "#0F6E56";
    const TEAL_MID   = "#1D9E75";
    const TEAL_LIGHT = "#E1F5EE";
    const SLATE_900  = "#0f172a";
    const SLATE_600  = "#475569";
    const SLATE_400  = "#94a3b8";
    const SLATE_100  = "#f1f5f9";
    const BORDER     = "#e2e8f0";

    const doc = new PDFDocument({ margin: 40, size: "A4" });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="ficha-clinica-${pet.name || "mascota"}.pdf"`
    );

    doc.pipe(res);

    const PAGE_W = doc.page.width;
    const PAGE_H = doc.page.height;
    const L  = 40;
    const R  = PAGE_W - 40;
    const CW = R - L;

    function formatLongDate(value) {
      if (!value) return "—";
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return "—";
      const s = d.toLocaleDateString("es-CL", {
        weekday: "long", day: "numeric", month: "long", year: "numeric",
      });
      return s.charAt(0).toUpperCase() + s.slice(1);
    }

    // ── HELPER: sección label + línea ─────────────────────
    function drawSectionLabel(title, y) {
      doc.font("Helvetica-Bold").fontSize(8).fillColor(SLATE_400)
        .text(title.toUpperCase(), L, y, { width: CW });
      doc.moveTo(L, y + 12).lineTo(R, y + 12)
        .strokeColor(BORDER).lineWidth(0.5).stroke();
      return y + 20;
    }

    // ── HELPER: fila de 3 columnas ─────────────────────────
    function draw3ColRow(items, y) {
      const gap  = 6;
      const colW = Math.floor((CW - gap * 2) / 3);
      items.forEach((item, i) => {
        const x = L + i * (colW + gap);
        doc.font("Helvetica").fontSize(8).fillColor(SLATE_400)
          .text(String(item.label), x, y, { width: colW });
        doc.font("Helvetica-Bold").fontSize(10).fillColor(SLATE_900)
          .text(String(item.value || "—"), x, y + 12, { width: colW });
      });
      return y + 30;
    }

    // ── HEADER BAND ───────────────────────────────────────
    doc.rect(0, 0, PAGE_W, 56).fill(TEAL_DARK);
    doc.font("Helvetica-Bold").fontSize(16).fillColor("#ffffff")
      .text("Ficha clínica veterinaria", L, 16, { width: CW });
    doc.font("Helvetica").fontSize(9).fillColor("rgba(255,255,255,0.75)")
      .text(tenant.name || "Veterinaria", L, 36, { width: CW });

    // ── METADATA ──────────────────────────────────────────
    const todayStr = new Date().toLocaleDateString("es-CL");
    doc.font("Helvetica").fontSize(8).fillColor(SLATE_400)
      .text(`Fecha de emisión: ${todayStr}`, L, 66);
    doc.font("Helvetica").fontSize(8).fillColor(SLATE_400)
      .text("Generado por Orbyx", L, 66, { width: CW, align: "right" });

    // ── SECCIÓN CLIENTE ───────────────────────────────────
    let curY = drawSectionLabel("Cliente", 82);
    curY = draw3ColRow([
      { label: "Nombre",   value: customer?.name },
      { label: "Teléfono", value: customer?.phone },
      { label: "Email",    value: customer?.email },
    ], curY);

    curY += 10;

    // ── SECCIÓN MASCOTA ───────────────────────────────────
    curY = drawSectionLabel("Mascota", curY);
    const speciesLabel =
      pet.species_base === "otro" ? (pet.species_custom || "Otro") : pet.species_base;
    curY = draw3ColRow([
      { label: "Nombre",  value: pet.name },
      { label: "Especie", value: speciesLabel },
      { label: "Raza",    value: pet.breed },
    ], curY);
    curY = draw3ColRow([
      { label: "Sexo",        value: pet.sex },
      { label: "Peso",        value: pet.weight_kg ? `${pet.weight_kg} kg` : null },
      { label: "Esterilizado", value: pet.is_sterilized ? "Sí" : "No" },
    ], curY);

    curY += 10;

    // ── HISTORIAL CLÍNICO ─────────────────────────────────
    curY = drawSectionLabel("Historial clínico", curY);

    if (!appointments || appointments.length === 0) {
      doc.roundedRect(L, curY, CW, 40, 4).fill(SLATE_100);
      doc.font("Helvetica").fontSize(10).fillColor(SLATE_400)
        .text("Sin atenciones registradas.", L + 16, curY + 14, { width: CW - 32 });
      curY += 52;
    } else {
      for (const appt of appointments) {
        if (curY > PAGE_H - 110) {
          doc.addPage();
          doc.rect(0, 0, PAGE_W, 8).fill(TEAL_DARK);
          curY = 24;
        }

        const clinNote    = clinicalNotesMap[appt.id];
        const reasonText  = appt.reason || "";
        const noteText    = clinNote?.observations || appt.notes || "";
        const diagText    = clinNote?.diagnosis || "";
        const treatText   = clinNote?.treatment  || "";
        const controlType = clinNote?.control_type || appt.service_name_snapshot || "Atención";
        const hasNextCtrl = !!(appt.next_control_at);

        const colHalf = Math.floor((CW - 28) / 2);

        // Medir alturas
        const rH  = reasonText ? doc.heightOfString(reasonText, { width: CW - 24 }) : 0;
        const nH  = noteText   ? doc.heightOfString(noteText,   { width: CW - 24 }) : 0;
        const dH  = diagText   ? doc.heightOfString(diagText,   { width: colHalf  }) : 0;
        const tH  = treatText  ? doc.heightOfString(treatText,  { width: colHalf  }) : 0;
        const dnH = (diagText || treatText) ? Math.max(dH, tH) + 26 : 0;
        const ctH = hasNextCtrl ? 20 : 0;

        const innerH = 30
          + (rH  ? rH  + 6  : 0)
          + (nH  ? nH  + 22 : 0)
          + dnH
          + ctH
          + 12;
        const cardH = Math.max(52, innerH);

        // Fondo tarjeta
        doc.roundedRect(L, curY, CW, cardH, 4).fill(SLATE_100);

        // Barra de acento izquierda
        const accentColor =
          controlType === "Vacuna"          ? SLATE_400 :
          controlType === "Desparasitación" ? "#EF9F27"  :
          TEAL_MID;
        doc.rect(L, curY, 3, cardH).fill(accentColor);

        let rowY = curY + 10;

        // ── Fila superior: fecha + badge tipo ──
        doc.font("Helvetica-Bold").fontSize(9).fillColor(SLATE_900)
          .text(formatLongDate(appt.start_at), L + 10, rowY, { width: CW - 100 });

        const badgeText = String(controlType).slice(0, 24);
        const badgeW    = Math.min(
          doc.widthOfString(badgeText, { fontSize: 8, font: "Helvetica" }) + 14,
          120
        );
        doc.roundedRect(R - badgeW - 4, rowY - 2, badgeW, 14, 3).fill(TEAL_LIGHT);
        doc.font("Helvetica").fontSize(8).fillColor(TEAL_DARK)
          .text(badgeText, R - badgeW + 3, rowY, { width: badgeW - 6 });

        rowY += 18;

        // ── Motivo ──
        if (reasonText) {
          doc.font("Helvetica-Bold").fontSize(10).fillColor(SLATE_900)
            .text(reasonText, L + 10, rowY, { width: CW - 24 });
          rowY += rH + 8;
        }

        // ── Diagnóstico + Tratamiento en 2 columnas ──
        if (diagText || treatText) {
          if (diagText) {
            doc.font("Helvetica").fontSize(7.5).fillColor(SLATE_400)
              .text("DIAGNÓSTICO", L + 10, rowY, { width: colHalf });
            doc.font("Helvetica").fontSize(9).fillColor(SLATE_600)
              .text(diagText, L + 10, rowY + 12, { width: colHalf });
          }
          if (treatText) {
            const tx = diagText ? L + 14 + colHalf : L + 10;
            doc.font("Helvetica").fontSize(7.5).fillColor(SLATE_400)
              .text("TRATAMIENTO", tx, rowY, { width: colHalf });
            doc.font("Helvetica").fontSize(9).fillColor(SLATE_600)
              .text(treatText, tx, rowY + 12, { width: colHalf });
          }
          rowY += Math.max(dH, tH) + 26;
        }

        // ── Observaciones ──
        if (noteText) {
          doc.font("Helvetica").fontSize(7.5).fillColor(SLATE_400)
            .text("OBSERVACIONES", L + 10, rowY, { width: CW - 24 });
          rowY += 12;
          doc.font("Helvetica").fontSize(9).fillColor(SLATE_600)
            .text(noteText, L + 10, rowY, { width: CW - 24 });
          rowY += nH + 8;
        }

        // ── Próximo control ──
        if (hasNextCtrl) {
          const ctrlStr = `Próximo control: ${formatLongDate(appt.next_control_at)}`;
          const ctrlW   = Math.min(
            doc.widthOfString(ctrlStr, { fontSize: 8, font: "Helvetica" }) + 16,
            CW - 20
          );
          doc.roundedRect(L + 10, rowY, ctrlW, 14, 3).fill(TEAL_LIGHT);
          doc.font("Helvetica").fontSize(8).fillColor(TEAL_DARK)
            .text(ctrlStr, L + 17, rowY + 3, { width: ctrlW - 14 });
        }

        curY += cardH + 8;
      }
    }

    // ── FOOTER ────────────────────────────────────────────
    doc.moveTo(L, PAGE_H - 28).lineTo(R, PAGE_H - 28)
      .strokeColor(BORDER).lineWidth(0.5).stroke();
    doc.font("Helvetica").fontSize(7.5).fillColor(SLATE_400)
      .text(
        `Documento generado por Orbyx · ${tenant.name || "Veterinaria"}`,
        L, PAGE_H - 22,
        { width: CW, align: "center" }
      );

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
app.get("/appointments", [dashboardLimiter, requireTenantAuth], async (req, res) => {
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
app.get("/customers/:slug", tenantAuthSlug, async (req, res) => {
  try {
    const { slug } = req.params;
    const { q, segment, inactive_days, branch_id } = req.query;

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

    let resolvedBranchId = null;
    if (branch_id) {
      try {
        resolvedBranchId = await resolveBranchId({
          tenant_id: tenant.id,
          branch_id,
        });
      } catch (branchError) {
        return res.status(400).json({
          error: branchError.message || "branch_id inválido",
        });
      }
    }

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

    let rows = Array.isArray(data) ? data : [];
    let customerIds = rows.map((customer) => customer.id).filter(Boolean);
    const activityByCustomer = new Map();

    if (customerIds.length > 0) {
      let activityQuery = supabase
        .from("appointments")
        .select("customer_id, start_at, status")
        .eq("tenant_id", tenant.id)
        .in("customer_id", customerIds);

      if (resolvedBranchId) {
        activityQuery = activityQuery.eq("branch_id", resolvedBranchId);
      }

      const { data: activityRows, error: activityError } = await activityQuery;

      if (activityError) throw activityError;

      for (const appt of activityRows || []) {
        const customerId = appt.customer_id;
        if (!customerId) continue;

        const current =
          activityByCustomer.get(customerId) || {
            total_visits: 0,
            last_visit_at: null,
          };

        const status = String(appt.status || "").toLowerCase();
        const isCanceled = ["canceled", "cancelled"].includes(status);

        if (!isCanceled) {
          current.total_visits += 1;

          if (
            appt.start_at &&
            (!current.last_visit_at ||
              new Date(appt.start_at).getTime() >
                new Date(current.last_visit_at).getTime())
          ) {
            current.last_visit_at = appt.start_at;
          }
        }

        activityByCustomer.set(customerId, current);
      }

      if (resolvedBranchId) {
        rows = rows.filter((customer) => activityByCustomer.has(customer.id));
        customerIds = rows.map((customer) => customer.id).filter(Boolean);
      }
    }

    const now = new Date();
    const inactiveCutoff = new Date(
      now.getTime() - inactiveDays * 24 * 60 * 60 * 1000
    );

    function getCustomerSegment(customer) {
      const activity = activityByCustomer.get(customer.id);
      const totalVisits = resolvedBranchId
        ? Number(activity?.total_visits || 0)
        : Number(customer.total_visits || 0);
      const lastVisitValue = resolvedBranchId
        ? activity?.last_visit_at || null
        : customer.last_visit_at;
      const lastVisitAt = lastVisitValue
        ? new Date(lastVisitValue)
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
      const activity = activityByCustomer.get(customer.id);
      const activityTotalVisits = resolvedBranchId
        ? Number(activity?.total_visits || 0)
        : Number(customer.total_visits || 0);
      const activityLastVisitAt = resolvedBranchId
        ? activity?.last_visit_at || null
        : customer.last_visit_at;
      const customerSegment = getCustomerSegment(customer);

      return {
        ...customer,
        total_visits: activityTotalVisits,
        last_visit_at: activityLastVisitAt,
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
        branch_id: resolvedBranchId,
      },
    });
  } catch (err) {
    console.error("GET /customers/:slug error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   ✅ PATCH /customers/:id
   Editar datos de un cliente existente
====================================================== */
/* ======================================================
   ✅ POST /customers
====================================================== */
app.post("/customers", tenantAuthSlugWrite, async (req, res) => {
  try {
    const {
      slug,
      name,
      phone,
      email,
      rut,
      birth_date,
      sex,
      intake_notes,
      occupation,
      health_insurance,
      emergency_contact_name,
      emergency_contact_phone,
      known_allergies,
      chronic_conditions,
      family_history,
      habits,
    } = req.body || {};

    if (!slug) return res.status(400).json({ error: "slug es obligatorio" });
    if (!name || !String(name).trim()) return res.status(400).json({ error: "name es obligatorio" });

    const { data: tenant, error: tenantError } = await supabase
      .from("tenants")
      .select("id")
      .eq("slug", slug)
      .eq("is_active", true)
      .single();

    if (tenantError || !tenant) {
      return res.status(404).json({ error: "Negocio no encontrado" });
    }

    const normalizedBirthDate =
      birth_date && String(birth_date).trim() ? String(birth_date).trim() : null;

    const payload = {
      tenant_id: tenant.id,
      name: String(name).trim(),
      phone: phone ? String(phone).trim() : null,
      email: email ? String(email).trim() : null,
      rut: rut ? String(rut).trim() : null,
      birth_date: normalizedBirthDate,
      sex: sex ? String(sex).trim() : null,
      intake_notes: intake_notes ? String(intake_notes).trim() : null,
      occupation: occupation ? String(occupation).trim() : null,
      health_insurance: health_insurance ? String(health_insurance).trim() : null,
      emergency_contact_name: emergency_contact_name ? String(emergency_contact_name).trim() : null,
      emergency_contact_phone: emergency_contact_phone ? String(emergency_contact_phone).trim() : null,
      known_allergies: known_allergies ? String(known_allergies).trim() : null,
      chronic_conditions: chronic_conditions ? String(chronic_conditions).trim() : null,
      family_history: family_history ? String(family_history).trim() : null,
      habits: habits ? String(habits).trim() : null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from("customers")
      .insert(payload)
      .select("*")
      .single();

    if (error) throw error;

    return res.status(201).json({ ok: true, customer: data });
  } catch (err) {
    console.error("POST /customers error:", err.message);
    return res.status(500).json({ error: err.message || "Error creando cliente" });
  }
});

app.patch("/customers/:id", tenantAuthSlugWrite, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      slug,
      name,
      phone,
      email,
      notes,
      rut,
      birth_date,
      sex,
      intake_notes,
      occupation,
      health_insurance,
      emergency_contact_name,
      emergency_contact_phone,
      known_allergies,
      chronic_conditions,
      family_history,
      habits,
    } = req.body;

    if (!slug) {
      return res.status(400).json({ error: "slug es obligatorio" });
    }
    if (!id) {
      return res.status(400).json({ error: "id es obligatorio" });
    }
    if (name !== undefined && !String(name).trim()) {
      return res.status(400).json({ error: "name no puede estar vacío" });
    }

    // Validar tenant por slug
    const { data: tenant, error: tenantError } = await supabase
      .from("tenants")
      .select("id")
      .eq("slug", slug)
      .eq("is_active", true)
      .single();

    if (tenantError || !tenant) {
      return res.status(404).json({ error: "Negocio no encontrado" });
    }

    // Validar ownership: el customer debe pertenecer al tenant
    const { data: existing, error: existingError } = await supabase
      .from("customers")
      .select("id, tenant_id")
      .eq("id", id)
      .eq("tenant_id", tenant.id)
      .single();

    if (existingError || !existing) {
      return res.status(404).json({ error: "Cliente no encontrado para este negocio" });
    }

    const normalizedBirthDate =
      birth_date && String(birth_date).trim() ? String(birth_date).trim() : null;

    const payload = { updated_at: new Date().toISOString() };
    if (name !== undefined) payload.name = String(name).trim();
    if (phone !== undefined) payload.phone = phone ? String(phone).trim() : null;
    if (email !== undefined) payload.email = email ? String(email).trim() : null;
    if (notes !== undefined) payload.notes = notes ? String(notes).trim() : null;
    if (rut !== undefined) payload.rut = rut ? String(rut).trim() : null;
    if (birth_date !== undefined) payload.birth_date = normalizedBirthDate;
    if (sex !== undefined) payload.sex = sex ? String(sex).trim() : null;
    if (intake_notes !== undefined) payload.intake_notes = intake_notes ? String(intake_notes).trim() : null;
    if (occupation !== undefined) payload.occupation = occupation ? String(occupation).trim() : null;
    if (health_insurance !== undefined) payload.health_insurance = health_insurance ? String(health_insurance).trim() : null;
    if (emergency_contact_name !== undefined) payload.emergency_contact_name = emergency_contact_name ? String(emergency_contact_name).trim() : null;
    if (emergency_contact_phone !== undefined) payload.emergency_contact_phone = emergency_contact_phone ? String(emergency_contact_phone).trim() : null;
    if (known_allergies !== undefined) payload.known_allergies = known_allergies ? String(known_allergies).trim() : null;
    if (chronic_conditions !== undefined) payload.chronic_conditions = chronic_conditions ? String(chronic_conditions).trim() : null;
    if (family_history !== undefined) payload.family_history = family_history ? String(family_history).trim() : null;
    if (habits !== undefined) payload.habits = habits ? String(habits).trim() : null;

    const { data, error } = await supabase
      .from("customers")
      .update(payload)
      .eq("id", id)
      .eq("tenant_id", tenant.id)
      .select("*")
      .single();

    if (error) throw error;

    return res.status(200).json({ ok: true, customer: data });
  } catch (err) {
    console.error("PATCH /customers/:id error:", err.message);
    return res.status(500).json({ error: err.message || "Error actualizando cliente" });
  }
});

/* ======================================================
   ✅ PATCH /customers/:id/extra-data
   Merge de campos personalizados (RUT, empresa, etc.) en customers.extra_data
====================================================== */
app.patch("/customers/:id/extra-data", tenantAuthSlugWrite, async (req, res) => {
  try {
    const { id } = req.params;
    const { extra_data, slug } = req.body;

    if (!slug) return res.status(400).json({ error: "slug es obligatorio" });
    if (!extra_data || typeof extra_data !== "object") return res.status(400).json({ error: "extra_data debe ser un objeto" });

    const { data: tenant, error: tenantError } = await supabase
      .from("tenants")
      .select("id")
      .eq("slug", slug)
      .single();

    if (tenantError || !tenant) return res.status(404).json({ error: "Negocio no encontrado" });

    const { data: existing, error: findErr } = await supabase
      .from("customers")
      .select("id, extra_data")
      .eq("id", id)
      .eq("tenant_id", tenant.id)
      .single();

    if (findErr || !existing) return res.status(404).json({ error: "Cliente no encontrado" });

    const merged = { ...(existing.extra_data ?? {}), ...extra_data };

    const { data, error } = await supabase
      .from("customers")
      .update({ extra_data: merged, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("tenant_id", tenant.id)
      .select()
      .single();

    if (error) throw error;

    return res.json({ ok: true, customer: data });
  } catch (err) {
    console.error("PATCH /customers/:id/extra-data error:", err.message);
    return res.status(500).json({ error: err.message || "Error guardando datos extra" });
  }
});

/* ======================================================
   ✅ GET /pets/:slug
   Listar mascotas por negocio y opcionalmente por cliente
====================================================== */
app.get("/pets/:slug", tenantAuthSlug, async (req, res) => {
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
app.get("/pet-followups/:slug", tenantAuthSlug, async (req, res) => {
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
   ✅ POST /clinical-notes/:slug
====================================================== */
app.post("/clinical-notes/:slug", tenantAuthSlugWrite, async (req, res) => {
  try {
    const { slug } = req.params;
    const {
      customer_id,
      branch_id,
      date,
      control_type,
      reason,
      symptoms,
      diagnosis,
      treatment,
      medications,
      referrals,
      observations,
      follow_up_notes,
      next_control_at,
      next_control_label,
      staff_id,
    } = req.body || {};

    if (!slug) return res.status(400).json({ error: "slug requerido" });
    if (!customer_id) return res.status(400).json({ error: "customer_id es obligatorio" });
    if (!date) return res.status(400).json({ error: "date es obligatorio" });

    const { data: tenant, error: tenantError } = await supabase
      .from("tenants")
      .select("id")
      .eq("slug", slug)
      .eq("is_active", true)
      .single();

    if (tenantError || !tenant) {
      return res.status(404).json({ error: "Negocio no encontrado" });
    }

    const { data: customer, error: customerError } = await supabase
      .from("customers")
      .select("id")
      .eq("id", customer_id)
      .eq("tenant_id", tenant.id)
      .single();

    if (customerError || !customer) {
      return res.status(404).json({ error: "Cliente no encontrado para este negocio" });
    }

    const n = (v) => String(v || "").trim() || null;

    const payload = {
      tenant_id:          tenant.id,
      branch_id:          n(branch_id),
      customer_id,
      pet_id:             null,
      appointment_id:     null,
      staff_id:           n(staff_id),
      date:               String(date).trim(),
      control_type:       n(control_type),
      reason:             n(reason),
      symptoms:           n(symptoms),
      diagnosis:          n(diagnosis),
      treatment:          n(treatment),
      medications:        n(medications),
      referrals:          n(referrals),
      observations:       n(observations),
      follow_up_notes:    n(follow_up_notes),
      next_control_at:    n(next_control_at),
      next_control_label: n(next_control_label),
      created_at:         new Date().toISOString(),
      updated_at:         new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from("clinical_notes")
      .insert(payload)
      .select("*")
      .single();

    if (error) throw error;

    return res.status(201).json({ ok: true, note: data });
  } catch (err) {
    console.error("POST /clinical-notes/:slug error:", err.message);
    return res.status(500).json({ error: err.message || "Error creando nota clínica" });
  }
});

/* ======================================================
   ✅ GET /clinical-notes/:slug
   Notas clínicas veterinarias por mascota o appointment
====================================================== */
app.get("/clinical-notes/:slug", tenantAuthSlug, async (req, res) => {
  try {
    const { slug } = req.params;
    const { pet_id, appointment_id, customer_id, appointment_ids, from, to, limit = 50 } = req.query;

    if (!slug) return res.status(400).json({ error: "slug requerido" });

    const { data: tenant, error: tenantErr } = await supabase
      .from("tenants")
      .select("id, business_category")
      .eq("slug", slug)
      .eq("is_active", true)
      .single();

    if (tenantErr || !tenant) {
      return res.status(404).json({ error: "Negocio no encontrado" });
    }

    const vetCategories = ["veterinaria", "vet", "clinica", "odontologia"];
    if (!vetCategories.includes(String(tenant.business_category || "").toLowerCase())) {
      return res.status(403).json({ error: "No disponible para este tipo de negocio" });
    }

    let query = supabase
      .from("clinical_notes")
      .select(`
        id,
        pet_id,
        appointment_id,
        staff_id,
        date,
        control_type,
        reason,
        diagnosis,
        treatment,
        symptoms,
        medications,
        referrals,
        follow_up_notes,
        observations,
        next_control_at,
        next_control_label,
        extra_fields,
        created_at,
        updated_at
      `)
      .eq("tenant_id", tenant.id)
      .order("date", { ascending: false })
      .limit(Number(limit));

    if (pet_id)         query = query.eq("pet_id", pet_id);
    if (appointment_id) query = query.eq("appointment_id", appointment_id);
    if (appointment_ids) {
      const ids = String(appointment_ids).split(",").map((s) => s.trim()).filter(Boolean);
      if (ids.length === 0) return res.json({ notes: [] });
      query = query.in("appointment_id", ids);
    } else if (customer_id) {
      const { data: customerAppts } = await supabase
        .from("appointments")
        .select("id")
        .eq("tenant_id", tenant.id)
        .eq("customer_id", customer_id);
      const apptIds = (customerAppts || []).map((a) => a.id);
      if (apptIds.length === 0) return res.json({ notes: [] });
      query = query.in("appointment_id", apptIds);
    }
    if (from)           query = query.gte("date", from);
    if (to)             query = query.lte("date", to);

    const { data: notes, error: notesErr } = await query;

    if (notesErr) {
      console.error("[clinical-notes] query error:", notesErr.message);
      return res.status(500).json({ error: "Error al obtener notas clínicas" });
    }

    return res.json({ notes: notes ?? [] });
  } catch (err) {
    console.error("[clinical-notes] unexpected error:", err.message);
    return res.status(500).json({ error: "Error interno" });
  }
});

/* ======================================================
   ✅ POST /pets
   Crear mascota para un cliente
====================================================== */
app.post("/pets", tenantAuthSlugWrite, async (req, res) => {
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
   ✅ PATCH /pets/:id
   Editar datos de una mascota existente
====================================================== */
app.patch("/pets/:id", tenantAuthSlugWrite, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      slug,
      name,
      species_base,
      species_custom,
      breed,
      sex,
      weight_kg,
      is_sterilized,
      notes,
    } = req.body;

    if (!slug) {
      return res.status(400).json({ error: "slug es obligatorio" });
    }

    if (!id) {
      return res.status(400).json({ error: "id es obligatorio" });
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

    // Validar tenant por slug
    const { data: tenant, error: tenantError } = await supabase
      .from("tenants")
      .select("id")
      .eq("slug", slug)
      .eq("is_active", true)
      .single();

    if (tenantError || !tenant) {
      return res.status(404).json({ error: "Negocio no encontrado" });
    }

    // Validar que la mascota pertenece al tenant
    const { data: existing, error: existingError } = await supabase
      .from("pets")
      .select("id, tenant_id")
      .eq("id", id)
      .eq("tenant_id", tenant.id)
      .single();

    if (existingError || !existing) {
      return res.status(404).json({ error: "Mascota no encontrada para este negocio" });
    }

    let normalizedWeight = null;
    if (weight_kg !== undefined && weight_kg !== null && String(weight_kg).trim() !== "") {
      normalizedWeight = Number(weight_kg);
      if (Number.isNaN(normalizedWeight) || normalizedWeight < 0) {
        return res.status(400).json({ error: "weight_kg debe ser un número válido" });
      }
    }

    const payload = {
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
      .update(payload)
      .eq("id", id)
      .eq("tenant_id", tenant.id)
      .select("*")
      .single();

    if (error) throw error;

    return res.status(200).json({ ok: true, pet: data });
  } catch (err) {
    console.error("PATCH /pets/:id error:", err.message);
    return res.status(500).json({ error: err.message || "Error actualizando mascota" });
  }
});

/* ======================================================
   ✅ POST /campaigns/send-email
   Envío real por email usando audiencia curada desde frontend
====================================================== */
app.post("/campaigns/send-email", tenantAuthSlugWrite, async (req, res) => {
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

    // Registrar uso mensual de emails_campana
    if (sent > 0) {
      await incrementMonthlyUsage(tenant.id, "emails_campana", sent);
    }

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
app.post("/campaigns/save-whatsapp", tenantAuthSlugWrite, async (req, res) => {
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
app.get("/campaigns/history/:slug", tenantAuthSlug, async (req, res) => {
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

app.get("/campaigns/logs/:campaignId", [dashboardLimiter, requireTenantAuth], async (req, res) => {
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
app.post("/appointments/:id/close", [dashboardLimiter, requireTenantAuth, requireWriteAccess], async (req, res) => {
  try {
    const { id } = req.params;

    const {
      control_type,
      control_note,
      diagnosis,
      treatment,
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
        branch_id,
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

    if (!["veterinaria", "vet", "clinica", "odontologia"].includes(businessCategory)) {
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
    clinical_note_pending: false,
  })
      .eq("id", appointment.id)
      .select("*")
      .single();

    if (updateAppointmentError) {
      throw updateAppointmentError;
    }

    try {
      await supabase.from("clinical_notes").insert({
        tenant_id:          appointment.tenant_id,
        branch_id:          appointment.branch_id ?? null,
        pet_id:             appointment.pet_id,
        appointment_id:     appointment.id,
        staff_id:           appointment.staff_id ?? null,
        date:               appointment.start_at.split("T")[0],
        control_type:       normalizedControlType,
        reason:             normalizedControlType,
        diagnosis:          normalizeNullablePetText(diagnosis),
        treatment:          normalizeNullablePetText(treatment),
        observations:       normalizeNullablePetText(control_note),
        next_control_at:    nextControl.next_control_at ?? null,
        next_control_label: nextControl.next_control_label ?? null,
      });
    } catch (cnErr) {
      console.error("[clinical_notes] insert failed on close:", cnErr.message);
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
   ✅ GET /appointments/clinical-pending/:slug
====================================================== */
app.get("/appointments/clinical-pending/:slug", tenantAuthSlug, async (req, res) => {
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
      .eq("status", "completed")
      .eq("clinical_note_pending", true)
      .order("start_at", { ascending: false });

    if (branch_id) query = query.eq("branch_id", branch_id);
    if (staff_id) query = query.eq("staff_id", staff_id);

    const { data, error } = await query;

    if (error) return res.status(500).json({ error: error.message });

    return res.json({ total: data?.length || 0, appointments: data || [] });
  } catch (error) {
    console.error("Error en /appointments/clinical-pending/:slug", error);
    return res.status(500).json({ error: "Error obteniendo fichas pendientes" });
  }
});

/* ======================================================
   ✅ PATCH /appointments/:id/clinical-pending
====================================================== */
app.patch("/appointments/:id/clinical-pending", tenantAuthSlugWrite, async (req, res) => {
  try {
    const { id } = req.params;
    const { pending, slug } = req.body || {};

    if (!id || typeof pending !== "boolean" || !slug) {
      return res.status(400).json({ error: "id, pending y slug son obligatorios" });
    }

    const { data: tenant, error: tenantError } = await supabase
      .from("tenants")
      .select("id")
      .eq("slug", slug)
      .single();

    if (tenantError || !tenant) {
      return res.status(404).json({ error: "Negocio no encontrado" });
    }

    const { data: appointment, error: appointmentError } = await supabase
      .from("appointments")
      .select("id, tenant_id")
      .eq("id", id)
      .eq("tenant_id", tenant.id)
      .single();

    if (appointmentError || !appointment) {
      return res.status(404).json({ error: "Reserva no encontrada" });
    }

    const { error: updateError } = await supabase
      .from("appointments")
      .update({ clinical_note_pending: pending })
      .eq("id", id);

    if (updateError) throw updateError;

    return res.json({ ok: true });
  } catch (err) {
    console.error("PATCH /appointments/:id/clinical-pending error:", err.message);
    return res.status(500).json({ error: err.message || "Error actualizando ficha pendiente" });
  }
});

/* ======================================================
   ✅ PATCH /appointments/:id/status
====================================================== */
app.patch("/appointments/:id/status", [dashboardLimiter, requireTenantAuth, requireWriteAccess], async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes } = req.body;

    const allowed = ["booked", "completed", "no_show", "rescheduled", "canceled"];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: "Estado inválido" });
    }

    if (status === "canceled") {
      const { data: appt, error: apptErr } = await supabase
        .from("appointments")
        .select("*")
        .eq("id", id)
        .single();

      if (apptErr || !appt) {
        return res.status(404).json({ error: "Appointment no encontrado" });
      }

      await deleteCalendarEventForAppointment(appt);
    }

    const updatePayload = {
      status,
      ...(status === "canceled" ? { canceled_at: new Date().toISOString() } : {}),
    };
    if (notes !== undefined) updatePayload.notes = String(notes).trim() || null;

    const { data, error } = await supabase
  .from("appointments")
  .update(updatePayload)
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

  await deleteCalendarEventForAppointment(appt);

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

app.post("/appointments/:id", publicLimiter, async (req, res) => {
  try {
    return await cancelById(req.params.id, req.query.token, res);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.delete("/appointments/:id", publicLimiter, async (req, res) => {
  try {
    return await cancelById(req.params.id, req.query.token, res);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   🔎 GET /appointments/:id (info pública para cancelación)
====================================================== */
app.get("/appointments/:id", publicLimiter, async (req, res) => {
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

app.get("/appointments/search/:slug", tenantAuthSlug, async (req, res) => {
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
app.patch("/appointments/:id", [dashboardLimiter, requireTenantAuth, requireWriteAccess], async (req, res) => {
  try {
    const { id } = req.params;

    const {
      customer_name,
      customer_email,
      customer_phone,
      notes,
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

    if (notes !== undefined) {
      updateData.notes = String(notes || "").trim() || null;
    }

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: "No hay cambios para actualizar" });
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
   ✅ PATCH /appointments/:id/session-notes
   Guarda nota de sesión en appointments.notes (negocios genéricos)
====================================================== */
app.patch("/appointments/:id/session-notes", tenantAuthSlugWrite, async (req, res) => {
  try {
    const { id } = req.params;
    const { notes, slug } = req.body;

    if (!slug) return res.status(400).json({ error: "slug es obligatorio" });

    const { data: tenant, error: tenantError } = await supabase
      .from("tenants")
      .select("id")
      .eq("slug", slug)
      .single();

    if (tenantError || !tenant) return res.status(404).json({ error: "Negocio no encontrado" });

    const { data, error } = await supabase
      .from("appointments")
      .update({ notes: notes ?? null, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("tenant_id", tenant.id)
      .select("id, notes")
      .single();

    if (error) throw error;

    return res.json({ ok: true, appointment: data });
  } catch (err) {
    console.error("PATCH /appointments/:id/session-notes error:", err.message);
    return res.status(500).json({ error: err.message || "Error guardando nota" });
  }
});

/* ======================================================
   ✅ PATCH /calendars/:id/slot-minutes
====================================================== */
app.patch("/calendars/:id/slot-minutes", [dashboardLimiter, requireTenantAuth, requireWriteAccess], async (req, res) => {
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
    const { user_id, email, plan = "pro", billing_cycle } = req.body;

    if (!user_id || !email) {
      return res.status(400).json({ error: "Faltan campos: user_id, email" });
    }

    // billing_cycle opcional: mensual (default), semestral o anual
    const provisionCycle = normalizeBillingCycle(billing_cycle);

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
const billing_cycle_end = addMonths(
  new Date(),
  BILLING_CYCLES[provisionCycle].months
).toISOString();

const normalizedProvisionPlan = normalizePlanSlug(plan);
const { data: tenant, error: tenantError } = await supabase
  .from("tenants")
  .insert({
    name: email,
    slug,
    plan_slug: normalizedProvisionPlan,
    is_trial: normalizedProvisionPlan === "pro",
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

    const { data: branch, error: branchError } = await supabase
      .from("branches")
      .insert({
        tenant_id: tenant.id,
        name: "Principal",
        is_active: true,
        use_global_hours: true,
        use_global_special_dates: true,
        use_global_socials: true,
        use_global_contact: true,
      })
      .select()
      .single();

    if (branchError) throw branchError;

    return res.json({
      ok: true,
      tenant_id: tenant.id,
      calendar_id: calendar.id,
      branch_id: branch.id,
    });
  } catch (err) {
    console.error("Provision failed:", err);
    return res.status(500).json({ error: "Provision failed", detail: err.message });
  }
});

/* ======================================================
   ✅ GET /billing/preview-change
====================================================== */
app.get("/billing/preview-change", tenantAuth, async (req, res) => {
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
    const tenantCycle = inferBillingCycle(
      subscription.billingStart,
      subscription.billingEnd
    );

    if (subscription.currentPlan === targetPlan) {
      return res.json({
        ok: true,
        change_type: "same_plan",
        current_plan: subscription.currentPlan,
        new_plan: targetPlan,
        billing_cycle: tenantCycle,
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
        billingCycle: tenantCycle,
      });

      return res.json({
        ok: true,
        change_type: "upgrade",
        current_plan: subscription.currentPlan,
        new_plan: targetPlan,
        billing_cycle: tenantCycle,
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
      billing_cycle: tenantCycle,
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
app.post("/billing/change-plan", tenantAuthWrite, async (req, res) => {
  try {
    const { tenant_id, new_plan, billing_cycle } = req.body;

    if (!tenant_id) {
      return res.status(400).json({ error: "tenant_id es obligatorio" });
    }

    if (!new_plan) {
      return res.status(400).json({ error: "new_plan es obligatorio" });
    }

    const subscription = await getTenantSubscriptionRow(tenant_id);
    const targetPlan = normalizePlanSlug(new_plan);
    const tenantCycle = inferBillingCycle(
      subscription.billingStart,
      subscription.billingEnd
    );
    // billing_cycle opcional: solo en upgrades permite cambiar de ciclo.
    // Sin el parámetro, el comportamiento es idéntico al original.
    const requestedCycle = billing_cycle
      ? normalizeBillingCycle(billing_cycle)
      : null;

    if (subscription.currentPlan === targetPlan) {
      return res.status(400).json({
        error: "El negocio ya está en ese plan",
      });
    }

    if (isUpgradePlanChange(subscription.currentPlan, targetPlan)) {
      const isCycleSwitch = Boolean(
        requestedCycle && requestedCycle !== tenantCycle
      );

      const proration = calculateProration({
        currentPlan: subscription.currentPlan,
        newPlan: targetPlan,
        billingEnd: subscription.billingEnd,
        billingCycle: tenantCycle,
      });

      // Con cambio de ciclo: se acredita lo no usado del ciclo vigente y se
      // cobra el ciclo nuevo completo, que parte hoy.
      const newCycleCharge = isCycleSwitch
        ? getPlanCyclePrice(targetPlan, requestedCycle)
        : proration.charge;
      const amountToday = isCycleSwitch
        ? Math.max(0, newCycleCharge - proration.credit)
        : proration.amount_today;

      const updatePayload = {
        plan_slug: targetPlan,
        scheduled_plan_slug: null,
        scheduled_change_at: null,
        pending_change_type: null,
        proration_credit: proration.credit,
        proration_charge: newCycleCharge,
      };

      if (isCycleSwitch) {
        const newStart = new Date();
        updatePayload.billing_cycle_start = newStart.toISOString();
        updatePayload.billing_cycle_end = addMonths(
          newStart,
          BILLING_CYCLES[requestedCycle].months
        ).toISOString();
      }

      const { data, error } = await supabase
        .from("tenants")
        .update(updatePayload)
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
        billing_cycle: isCycleSwitch ? requestedCycle : tenantCycle,
        amount_today: amountToday,
        credit: proration.credit,
        charge: newCycleCharge,
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
   ✅ GET /billing/addons
   Catálogo de add-ons. Con ?plan= incluye flag de disponibilidad.
   Con ?tenant_id= incluye además los add-ons activos del tenant
   (campos aditivos; el shape original se preserva).
====================================================== */
app.get("/billing/addons", tenantAuth, async (req, res) => {
  try {
    const { plan, tenant_id } = req.query;

    let normalizedPlan = plan ? normalizePlanSlug(plan) : null;

    let active = null;
    if (tenant_id) {
      // El plan real del tenant manda sobre el query param
      normalizedPlan = await getPlan(tenant_id);

      // Verificar resets pendientes antes de retornar
      await resetMonthlyAddons(tenant_id);

      try {
        active = await getActiveAddons(tenant_id);
      } catch (err) {
        if (!isMissingAddonsTableError(err)) throw err;
        active = [];
      }
    }

    const addons = Object.values(ADDON_CATALOG).map((addon) => ({
      ...addon,
      ...(normalizedPlan
        ? { available: isAddonAvailableForPlan(addon.key, normalizedPlan) }
        : {}),
    }));

    // Construir limits cuando hay tenant_id
    let limits = null;
    if (tenant_id && normalizedPlan) {
      try {
        const caps = getPlanCapabilities(normalizedPlan);
        const period = new Date().toISOString().slice(0, 7);

        // Cantidades de add-ons activos (una sola query)
        const { data: addonRows } = await supabase
          .from("tenant_addons")
          .select("addon_key, quantity")
          .eq("tenant_id", tenant_id)
          .eq("status", "active");
        const addonQty = {};
        for (const row of addonRows || []) {
          addonQty[row.addon_key] = Number(row.quantity) || 0;
        }

        // Uso mensual actual (una sola query)
        const { data: usageRows } = await supabase
          .from("tenant_monthly_usage")
          .select("resource, used")
          .eq("tenant_id", tenant_id)
          .eq("period", period);
        const usageMap = {};
        for (const row of usageRows || []) {
          usageMap[row.resource] = Number(row.used) || 0;
        }

        const addonTotal = (key) =>
          (addonQty[key] || 0) * (ADDON_CATALOG[key]?.grants?.[key] || 0);
        const usageEntry = (base, addonKey) => {
          const addon = addonTotal(addonKey);
          const total = base + addon;
          const used = usageMap[addonKey] || 0;
          return { base, addon, total, used, remaining: Math.max(0, total - used) };
        };

        limits = {
          staff: {
            base: caps.max_staff,
            addon: addonQty.staff || 0,
            total: caps.max_staff + (addonQty.staff || 0),
          },
          sucursales: {
            base: caps.max_branches,
            addon: addonQty.sucursal || 0,
            total: caps.max_branches + (addonQty.sucursal || 0),
          },
          wa_confirmacion: usageEntry(caps.max_wa_confirmacion, "wa_confirmacion"),
          campanas_wa: usageEntry(caps.max_campanas_wa || 0, "campanas_wa"),
          ia_wa: usageEntry(caps.max_ia_wa, "ia_wa"),
          emails_campana: usageEntry(caps.max_campaign_emails_per_send, "emails_campana"),
          group_capacity: {
            base: caps.max_group_capacity,
            addon: addonTotal("group_capacity"),
            total: caps.max_group_capacity + addonTotal("group_capacity"),
          },
        };
      } catch (limitsErr) {
        console.warn("GET /billing/addons limits error:", limitsErr.message);
      }
    }

    return res.json({
      ok: true,
      ...(normalizedPlan ? { plan: normalizedPlan } : {}),
      ...(limits ? { limits } : {}),
      addons,
      ...(active !== null ? { active_addons: active } : {}),
    });
  } catch (err) {
    console.error("GET /billing/addons error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   ✅ POST /billing/addons/activate
   body: { tenant_id, addon_key, quantity?, billing_cycle? }
   Valida tenant, catálogo y disponibilidad por plan.
   Acumulable: si ya hay un addon activo, suma quantity.
====================================================== */
app.post("/billing/addons/activate", tenantAuthWrite, async (req, res) => {
  try {
    const { tenant_id, addon_key, quantity, billing_cycle } = req.body;

    if (!tenant_id) {
      return res.status(400).json({ error: "tenant_id es obligatorio" });
    }

    if (!addon_key || !ADDON_CATALOG[addon_key]) {
      return res.status(400).json({
        error: `addon_key inválido. Válidos: ${Object.keys(ADDON_CATALOG).join(", ")}`,
      });
    }

    const qty = Math.max(1, parseInt(quantity, 10) || 1);
    const cycle = normalizeBillingCycle(billing_cycle);

    // Ownership: el tenant debe existir (getPlan lanza error si no);
    // el service role solo opera sobre filas de ese tenant_id.
    let tenantPlan;
    try {
      tenantPlan = await getPlan(tenant_id);
    } catch {
      return res.status(404).json({ error: "Tenant no encontrado" });
    }

    if (!isAddonAvailableForPlan(addon_key, tenantPlan)) {
      return res.status(403).json({
        error: `El plan ${tenantPlan} no permite contratar este add-on`,
        upgrade_required: true,
      });
    }

    const { data: existing, error: existingError } = await supabase
      .from("tenant_addons")
      .select("id, quantity")
      .eq("tenant_id", tenant_id)
      .eq("addon_key", addon_key)
      .eq("status", "active")
      .maybeSingle();

    if (existingError) throw existingError;

    // Precio escalonado según cantidad actual antes de agregar
    const currentQty = existing ? Number(existing.quantity) : 0;
    let unitPrice = addon.price;
    if (currentQty >= 2) unitPrice = addon.price_pack3 ?? addon.price;
    else if (currentQty >= 1) unitPrice = addon.price_pack2 ?? addon.price;

    let row;

    if (existing) {
      const { data, error } = await supabase
        .from("tenant_addons")
        .update({
          quantity: existing.quantity + qty,
          billing_cycle: cycle,
          unit_price: unitPrice,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id)
        .select()
        .single();

      if (error) throw error;
      row = data;
    } else {
      const { data, error } = await supabase
        .from("tenant_addons")
        .insert({
          tenant_id,
          addon_key,
          quantity: qty,
          billing_cycle: cycle,
          unit_price: unitPrice,
          status: "active",
        })
        .select()
        .single();

      if (error) throw error;
      row = data;
    }

    return res.json({
      ok: true,
      addon: row,
      unit_price: unitPrice,
    });
  } catch (err) {
    console.error("POST /billing/addons/activate error:", err.message);

    if (isMissingAddonsTableError(err)) {
      return res.status(503).json({
        error:
          "La tabla tenant_addons no existe aún. Ejecuta tenant_addons.sql en el SQL editor de Supabase.",
      });
    }

    return res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   ✅ PATCH /billing/addons/quantity
   body: { tenant_id, addon_key, quantity }
   quantity > 0 → actualiza cantidad; quantity = 0 → cancela.
====================================================== */
app.patch("/billing/addons/quantity", tenantAuthWrite, async (req, res) => {
  try {
    const { tenant_id, addon_key, quantity } = req.body;

    if (!tenant_id) {
      return res.status(400).json({ error: "tenant_id es obligatorio" });
    }

    if (!addon_key || !ADDON_CATALOG[addon_key]) {
      return res.status(400).json({
        error: `addon_key inválido. Válidos: ${Object.keys(ADDON_CATALOG).join(", ")}`,
      });
    }

    const qty = Number(quantity);

    if (!Number.isInteger(qty) || qty < 0) {
      return res.status(400).json({
        error: "quantity debe ser un número entero mayor o igual a 0",
      });
    }

    // Ownership: el tenant debe existir; la mutación filtra por tenant_id.
    try {
      await getPlan(tenant_id);
    } catch {
      return res.status(404).json({ error: "Tenant no encontrado" });
    }

    const { data: existing, error: existingError } = await supabase
      .from("tenant_addons")
      .select("id, quantity")
      .eq("tenant_id", tenant_id)
      .eq("addon_key", addon_key)
      .eq("status", "active")
      .maybeSingle();

    if (existingError) throw existingError;

    if (!existing) {
      return res.status(404).json({
        error: "El tenant no tiene ese add-on activo",
      });
    }

    const now = new Date().toISOString();

    if (qty === 0) {
      const { data, error } = await supabase
        .from("tenant_addons")
        .update({
          status: "canceled",
          canceled_at: now,
          updated_at: now,
        })
        .eq("id", existing.id)
        .select()
        .single();

      if (error) throw error;

      return res.json({
        ok: true,
        addon_key,
        quantity: 0,
        status: data.status,
        canceled_at: data.canceled_at,
        addon: data,
      });
    }

    const { data, error } = await supabase
      .from("tenant_addons")
      .update({
        quantity: qty,
        updated_at: now,
      })
      .eq("id", existing.id)
      .select()
      .single();

    if (error) throw error;

    return res.json({
      ok: true,
      addon_key,
      quantity: data.quantity,
      status: data.status,
      updated_at: data.updated_at,
      addon: data,
    });
  } catch (err) {
    console.error("PATCH /billing/addons/quantity error:", err.message);

    if (isMissingAddonsTableError(err)) {
      return res.status(503).json({
        error:
          "La tabla tenant_addons no existe aún. Ejecuta tenant_addons.sql en el SQL editor de Supabase.",
      });
    }

    return res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   ✅ POST /billing/addons/cancel
   body: { tenant_id, addon_key }
====================================================== */
app.post("/billing/addons/cancel", tenantAuthWrite, async (req, res) => {
  try {
    const { tenant_id, addon_key } = req.body;

    if (!tenant_id) {
      return res.status(400).json({ error: "tenant_id es obligatorio" });
    }

    if (!addon_key || !ADDON_CATALOG[addon_key]) {
      return res.status(400).json({
        error: `addon_key inválido. Válidos: ${Object.keys(ADDON_CATALOG).join(", ")}`,
      });
    }

    // Ownership: el tenant debe existir; la mutación filtra por tenant_id.
    try {
      await getPlan(tenant_id);
    } catch {
      return res.status(404).json({ error: "Tenant no encontrado" });
    }

    const now = new Date().toISOString();

    const { data, error } = await supabase
      .from("tenant_addons")
      .update({
        status: "canceled",
        canceled_at: now,
        updated_at: now,
      })
      .eq("tenant_id", tenant_id)
      .eq("addon_key", addon_key)
      .eq("status", "active")
      .select();

    if (error) throw error;

    if (!data || data.length === 0) {
      return res.status(404).json({
        error: "El tenant no tiene ese add-on activo",
      });
    }

    return res.json({
      ok: true,
      addon: data[0],
    });
  } catch (err) {
    console.error("POST /billing/addons/cancel error:", err.message);

    if (isMissingAddonsTableError(err)) {
      return res.status(503).json({
        error:
          "La tabla tenant_addons no existe aún. Ejecuta tenant_addons.sql en el SQL editor de Supabase.",
      });
    }

    return res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   ✅ POST /billing/apply-scheduled-changes
   Lo puedes disparar manualmente o desde cron
====================================================== */
app.post("/billing/apply-scheduled-changes", tenantAuthWrite, async (req, res) => {
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
      const newPlan = normalizePlanSlug(tenant.scheduled_plan_slug);

      // El nuevo ciclo conserva la duración del ciclo anterior del tenant
      // (mensual renueva igual que antes con addOneMonth-equivalente).
      const tenantCycle = inferBillingCycle(
        tenant.billing_cycle_start,
        tenant.billing_cycle_end
      );
      const newStart = new Date();
      const newEnd = addMonths(newStart, BILLING_CYCLES[tenantCycle].months);

      const { error: updateError } = await supabase
        .from("tenants")
        .update({
          plan_slug: newPlan,
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

      // Downgrade efectivo: cancelar add-ons que el plan nuevo no soporta
      const canceledAddons = await cancelUnsupportedAddons(tenant.id, newPlan);

      // Resetear add-ons mensuales con facturación vencida
      await resetMonthlyAddons(tenant.id);

      if (canceledAddons.length > 0) {
        console.log(
          `Downgrade tenant ${tenant.id} a ${newPlan}: add-ons cancelados → ${canceledAddons.join(", ")}`
        );
      }

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

app.patch("/tenants/:id", tenantAuthWrite, async (req, res) => {
  try {
    const { id } = req.params;

    const {
      name,
      business_name,
      phone,
      address,
      email,
      whatsapp,
      logo_url,
      instagram_url,
      facebook_url,
      description,
      business_subtype,
      business_subtype_config,
      min_booking_notice_minutes,
      max_booking_days_ahead,
      business_category,
      business_subcategory,
    } = req.body;

    if (!id) {
      return res.status(400).json({ error: "id es obligatorio" });
    }

    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: "name es obligatorio" });
    }

    // Generar slug desde business_name si se recibe
    let newSlug = null;
    if (business_name && String(business_name).trim()) {
      const baseSlug = String(business_name)
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 30) || "negocio";

      const { data: existing } = await supabase
        .from("tenants")
        .select("id")
        .eq("slug", baseSlug)
        .neq("id", id)
        .maybeSingle();

      const suffix = Math.random().toString(16).slice(2, 6);
      newSlug = existing ? `${baseSlug}-${suffix}` : baseSlug;
    }

    const normalizedMinBookingNoticeMinutes = Math.max(
      0,
      Number(min_booking_notice_minutes || 0)
    );

    const normalizedMaxBookingDaysAhead = Math.max(
      1,
      Number(max_booking_days_ahead || 60)
    );

    const allowedBusinessSubtypes = [
      "belleza_estetica",
      "salud_bienestar",
      "taller_automotriz",
      "servicios_tecnicos",
      "profesionales_cita",
      "educacion_individual",
      "servicios_creativos",
    ];

    const { data: currentTenant, error: currentTenantError } = await supabase
      .from("tenants")
      .select("business_category")
      .eq("id", id)
      .single();

    if (currentTenantError || !currentTenant) {
      return res.status(404).json({ error: "Tenant no encontrado" });
    }

    const currentCategory = String(currentTenant.business_category || "")
      .trim()
      .toLowerCase();
    const normalizedBusinessSubtype =
      business_subtype && allowedBusinessSubtypes.includes(String(business_subtype).trim())
        ? String(business_subtype).trim()
        : null;

    const subtypeBookingFieldDefaults = [
      {
        key: "unit_type",
        label: "Tipo de unidad/equipo",
        type: "select",
        required: true,
        options: ["Auto", "Moto", "Camion", "Maquinaria", "Bus"],
      },
      { key: "brand", label: "Marca", type: "text", required: false, options: [] },
      { key: "model", label: "Modelo", type: "text", required: false, options: [] },
      { key: "year", label: "Anio", type: "text", required: false, options: [] },
      {
        key: "unit_identifier",
        label: "Patente / Identificador",
        type: "text",
        required: false,
        options: [],
      },
      {
        key: "usage_value",
        label: "Kilometraje / Horas de uso",
        type: "text",
        required: false,
        options: [],
      },
      {
        key: "visit_reason",
        label: "Motivo de la visita",
        type: "textarea",
        required: false,
        options: [],
      },
      {
        key: "observations",
        label: "Observaciones",
        type: "textarea",
        required: false,
        options: [],
      },
    ];
    const rawSubtypeBookingFields =
      business_subtype_config &&
      Array.isArray(business_subtype_config.booking_fields)
        ? business_subtype_config.booking_fields
        : [];
    const normalizedBusinessSubtypeConfig =
      currentCategory === "generic" && normalizedBusinessSubtype === "taller_automotriz"
        ? {
            booking_fields: subtypeBookingFieldDefaults.map((baseField) => {
              const savedField = rawSubtypeBookingFields.find(
                (item) => item && item.key === baseField.key
              );
              const savedType =
                savedField &&
                ["text", "textarea", "select"].includes(String(savedField.type || ""))
                  ? String(savedField.type)
                  : baseField.type;
              const savedOptions =
                savedField && Array.isArray(savedField.options)
                  ? Array.from(
                      new Set(
                        savedField.options
                          .map((option) => String(option || "").trim())
                          .filter(Boolean)
                      )
                    )
                  : baseField.options;

              return {
                key: baseField.key,
                label:
                  savedField &&
                  typeof savedField.label === "string" &&
                  savedField.label.trim()
                    ? savedField.label.trim()
                    : baseField.label,
                enabled:
                  savedField && typeof savedField.enabled === "boolean"
                    ? savedField.enabled
                    : true,
                required:
                  savedField && typeof savedField.required === "boolean"
                    ? savedField.required
                    : baseField.required,
                type: savedType,
                options: savedType === "select" ? savedOptions : [],
              };
            }),
          }
        : {};

    if (
      business_subtype &&
      !allowedBusinessSubtypes.includes(String(business_subtype).trim())
    ) {
      return res.status(400).json({ error: "business_subtype inválido" });
    }

    const { data, error } = await supabase
      .from("tenants")
      .update({
        name: String(name).trim(),
        phone: phone ? String(phone).trim() : null,
        address: address ? String(address).trim() : null,
        email: email ? String(email).trim() : null,
        whatsapp: whatsapp ? String(whatsapp).trim() : null,
        logo_url: normalizeNullableUrl(logo_url),
        instagram_url: instagram_url ? String(instagram_url).trim() : null,
        facebook_url: facebook_url ? String(facebook_url).trim() : null,
        description: description ? String(description).trim() : null,
        business_subtype:
          currentCategory === "generic" ? normalizedBusinessSubtype : null,
        business_subtype_config: normalizedBusinessSubtypeConfig,
        min_booking_notice_minutes: normalizedMinBookingNoticeMinutes,
        max_booking_days_ahead: normalizedMaxBookingDaysAhead,
        ...(business_category !== undefined && {
          business_category: business_category ? String(business_category).trim().toLowerCase() : null,
        }),
        ...(business_subcategory !== undefined && {
          business_subcategory: business_subcategory ? String(business_subcategory).trim().toLowerCase() : null,
        }),
        ...(newSlug ? { slug: newSlug } : {}),
      })
      .eq("id", id)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    console.log("PATCH /tenants/:id logo_url saved:", data?.logo_url || null);

    return res.json({
      ok: true,
      tenant: data,
      ...(newSlug ? { slug: newSlug } : {}),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   ✅ GET /branches
====================================================== */
app.get("/branches", tenantAuth, async (req, res) => {
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

app.post("/branches", tenantAuthWrite, async (req, res) => {
  try {
    const {
      tenant_id,
      name,
      address,
      phone,
      whatsapp,
      email,
      description,
      city,
      commune,
      map_url,
      latitude,
      longitude,
      instagram_url,
      facebook_url,
      tiktok_url,
      website_url,
      use_global_socials = true,
      use_global_contact = true,
    } = req.body;

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
        address: normalizeNullableText(address),
        phone: normalizeNullableText(phone),
        whatsapp: normalizeNullableText(whatsapp),
        email: normalizeNullableText(email),
        description: normalizeNullableText(description),
        city: normalizeNullableText(city),
        commune: normalizeNullableText(commune),
        map_url: normalizeNullableUrl(map_url),
        latitude: normalizeNullableNumber(latitude),
        longitude: normalizeNullableNumber(longitude),
        instagram_url: normalizeNullableUrl(instagram_url),
        facebook_url: normalizeNullableUrl(facebook_url),
        tiktok_url: normalizeNullableUrl(tiktok_url),
        website_url: normalizeNullableUrl(website_url),
        use_global_socials: Boolean(use_global_socials),
        use_global_contact: Boolean(use_global_contact),
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
app.patch("/branches/:id", tenantAuthWrite, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      tenant_id,
      name,
      slug,
      is_active,
      address,
      phone,
      whatsapp,
      email,
      description,
      city,
      commune,
      map_url,
      latitude,
      longitude,
      instagram_url,
      facebook_url,
      tiktok_url,
      website_url,
      use_global_socials,
      use_global_contact,
      use_global_hours,
      use_global_special_dates,
    } = req.body;

    if (!id) {
      return res.status(400).json({ error: "id es obligatorio" });
    }

    const { data: existingBranch, error: existingError } = await supabase
      .from("branches")
      .select("id, tenant_id, name, slug, is_active")
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

    if (slug !== undefined) {
      const normalizedSlug = String(slug || "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9-]/g, "")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");

      if (!normalizedSlug) {
        return res.status(400).json({ error: "slug no puede estar vacio" });
      }

      const { data: duplicateBranch, error: duplicateError } = await supabase
        .from("branches")
        .select("id")
        .eq("tenant_id", effectiveTenantId)
        .eq("slug", normalizedSlug)
        .neq("id", id)
        .maybeSingle();

      if (duplicateError) throw duplicateError;

      if (duplicateBranch) {
        return res.status(409).json({ error: "Ya existe una sucursal con ese slug" });
      }

      updateData.slug = normalizedSlug;
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

    if (address !== undefined) updateData.address = normalizeNullableText(address);
    if (phone !== undefined) updateData.phone = normalizeNullableText(phone);
    if (whatsapp !== undefined) updateData.whatsapp = normalizeNullableText(whatsapp);
    if (email !== undefined) updateData.email = normalizeNullableText(email);
    if (description !== undefined) updateData.description = normalizeNullableText(description);
    if (city !== undefined) updateData.city = normalizeNullableText(city);
    if (commune !== undefined) updateData.commune = normalizeNullableText(commune);
    if (map_url !== undefined) updateData.map_url = normalizeNullableUrl(map_url);
    if (latitude !== undefined) updateData.latitude = normalizeNullableNumber(latitude);
    if (longitude !== undefined) updateData.longitude = normalizeNullableNumber(longitude);
    if (instagram_url !== undefined) updateData.instagram_url = normalizeNullableUrl(instagram_url);
    if (facebook_url !== undefined) updateData.facebook_url = normalizeNullableUrl(facebook_url);
    if (tiktok_url !== undefined) updateData.tiktok_url = normalizeNullableUrl(tiktok_url);
    if (website_url !== undefined) updateData.website_url = normalizeNullableUrl(website_url);
    if (use_global_socials !== undefined) {
      updateData.use_global_socials = Boolean(use_global_socials);
    }
    if (use_global_contact !== undefined) {
      updateData.use_global_contact = Boolean(use_global_contact);
    }
    if (use_global_hours !== undefined) {
      updateData.use_global_hours = Boolean(use_global_hours);
    }
    if (use_global_special_dates !== undefined) {
      updateData.use_global_special_dates = Boolean(use_global_special_dates);
    }

    if (updateData.use_global_contact === false && !normalizeNullableText(address)) {
      return res.status(400).json({
        error: "address es obligatorio cuando la sucursal usa contacto propio",
      });
    }

    const { data, error } = await supabase
      .from("branches")
      .update(updateData)
      .eq("id", id)
      .select("*")
      .single();

    if (error) throw error;

    // Al activar herencia de horario global, limpiar rows propios de la sucursal
    // para que no interfieran si se vuelve a usar horario propio en el futuro
    if (updateData.use_global_hours === true) {
      await supabase
        .from("business_hours")
        .delete()
        .eq("tenant_id", effectiveTenantId)
        .eq("branch_id", id);
    }

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

app.get("/services", tenantAuth, async (req, res) => {
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
      .order("sort_order", { ascending: true });

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
   ✅ Service Groups endpoints
====================================================== */

app.get('/service-groups', tenantAuth, async (req, res) => {
  try {
    const { tenant_id, branch_id } = req.query
    if (!tenant_id || !branch_id) return res.status(400).json({ error: 'tenant_id y branch_id requeridos' })
    const { data, error } = await supabase
      .from('service_groups')
      .select('*')
      .eq('tenant_id', tenant_id)
      .eq('branch_id', branch_id)
      .order('sort_order', { ascending: true })
    if (error) throw error
    res.json(data ?? [])
  } catch (err) {
    console.error('GET /service-groups error:', err)
    res.status(500).json({ error: 'Error obteniendo grupos' })
  }
})

app.post('/service-groups', tenantAuthWrite, async (req, res) => {
  try {
    const { tenant_id, branch_id, name } = req.body
    if (!tenant_id || !branch_id || !name?.trim()) {
      return res.status(400).json({ error: 'tenant_id, branch_id y name requeridos' })
    }
    const { data: existing } = await supabase
      .from('service_groups')
      .select('sort_order')
      .eq('tenant_id', tenant_id)
      .eq('branch_id', branch_id)
      .order('sort_order', { ascending: false })
      .limit(1)
    const nextOrder = existing?.[0] ? existing[0].sort_order + 1 : 0
    const { data, error } = await supabase
      .from('service_groups')
      .insert({ tenant_id, branch_id, name: name.trim(), sort_order: nextOrder })
      .select()
      .single()
    if (error) throw error
    res.json(data)
  } catch (err) {
    console.error('POST /service-groups error:', err)
    res.status(500).json({ error: 'Error creando grupo' })
  }
})

app.patch('/service-groups/reorder', tenantAuthWrite, async (req, res) => {
  try {
    const { tenant_id, order } = req.body
    if (!tenant_id || !Array.isArray(order)) return res.status(400).json({ error: 'tenant_id y order requeridos' })
    const updates = order.map(({ id, sort_order }) =>
      supabase.from('service_groups').update({ sort_order }).eq('id', id).eq('tenant_id', tenant_id)
    )
    await Promise.all(updates)
    res.json({ success: true })
  } catch (err) {
    console.error('PATCH /service-groups/reorder error:', err)
    res.status(500).json({ error: 'Error reordenando grupos' })
  }
})

app.patch('/service-groups/:id', tenantAuthWrite, async (req, res) => {
  try {
    const { id } = req.params
    const { name, tenant_id } = req.body
    if (!tenant_id || !name?.trim()) return res.status(400).json({ error: 'tenant_id y name requeridos' })
    const { data, error } = await supabase
      .from('service_groups')
      .update({ name: name.trim(), updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('tenant_id', tenant_id)
      .select()
      .single()
    if (error) throw error
    res.json(data)
  } catch (err) {
    console.error('PATCH /service-groups/:id error:', err)
    res.status(500).json({ error: 'Error actualizando grupo' })
  }
})

app.delete('/service-groups/:id', tenantAuthWrite, async (req, res) => {
  try {
    const { id } = req.params
    const { tenant_id } = req.query
    if (!tenant_id) return res.status(400).json({ error: 'tenant_id requerido' })
    const { data: existing } = await supabase
      .from('service_groups')
      .select('id')
      .eq('id', id)
      .eq('tenant_id', tenant_id)
      .single()
    if (!existing) return res.status(404).json({ error: 'Grupo no encontrado' })
    await supabase
      .from('services')
      .update({ group_id: null })
      .eq('group_id', id)
      .eq('tenant_id', tenant_id)
    const { error } = await supabase
      .from('service_groups')
      .delete()
      .eq('id', id)
      .eq('tenant_id', tenant_id)
    if (error) throw error
    res.json({ success: true })
  } catch (err) {
    console.error('DELETE /service-groups/:id error:', err)
    res.status(500).json({ error: 'Error eliminando grupo' })
  }
})

app.patch('/services/reorder', tenantAuthWrite, async (req, res) => {
  try {
    const { tenant_id, order } = req.body
    if (!tenant_id || !Array.isArray(order)) return res.status(400).json({ error: 'tenant_id y order requeridos' })
    const updates = order.map(({ id, group_id, sort_order }) =>
      supabase
        .from('services')
        .update({ group_id: group_id ?? null, sort_order })
        .eq('id', id)
        .eq('tenant_id', tenant_id)
    )
    await Promise.all(updates)
    res.json({ success: true })
  } catch (err) {
    console.error('PATCH /services/reorder error:', err)
    res.status(500).json({ error: 'Error reordenando servicios' })
  }
})

/* ======================================================
   ✅ POST /services
====================================================== */

app.post("/services", tenantAuthWrite, async (req, res) => {
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

    // Capacidad grupal: aplica solo al configurar el servicio, nunca al reservar
    if (Boolean(is_group)) {
      const maxGroupCapacity = await getEffectiveGroupCapacity(tenant_id);

      if (Number(capacity || 1) > maxGroupCapacity) {
        return res.status(400).json({
          error: `La capacidad del servicio excede el límite de tu plan (máx ${maxGroupCapacity} personas)`,
          upgrade_required: true,
        });
      }
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

app.patch("/services/:id", tenantAuthWrite, async (req, res) => {
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
  is_group,
  capacity,
} = req.body;

    if (!id) {
      return res.status(400).json({ error: "id es obligatorio" });
    }

    const { data: existingService, error: existingError } = await supabase
      .from("services")
      .select("id, tenant_id, branch_id, is_group, capacity")
      .eq("id", id)
      .single();

    if (existingError || !existingService) {
      return res.status(404).json({ error: "Servicio no encontrado" });
    }

    const effectiveTenantId = tenant_id || existingService.tenant_id;

    // Capacidad grupal: solo se valida cuando la edición toca is_group o
    // capacity. Servicios legados sobre el límite no bloquean otras ediciones
    // ni el booking (la validación nunca corre al reservar).
    if (is_group !== undefined || capacity !== undefined) {
      const effectiveIsGroup =
        is_group !== undefined
          ? Boolean(is_group)
          : Boolean(existingService.is_group);
      const effectiveCapacity =
        capacity !== undefined
          ? Number(capacity)
          : Number(existingService.capacity || 1);

      if (effectiveIsGroup) {
        const maxGroupCapacity =
          await getEffectiveGroupCapacity(effectiveTenantId);

        if (effectiveCapacity > maxGroupCapacity) {
          return res.status(400).json({
            error: `La capacidad del servicio excede el límite de tu plan (máx ${maxGroupCapacity} personas)`,
            upgrade_required: true,
          });
        }
      }
    }

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
if (is_group !== undefined) updateData.is_group = Boolean(is_group);
if (capacity !== undefined) updateData.capacity = Number(capacity);


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
app.delete("/services/:id", tenantAuthWrite, async (req, res) => {
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

app.get("/public/services/:slug", publicLimiter, async (req, res) => {
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
      .select("id, tenant_id, name, slug, address, phone, whatsapp, email, description, city, commune, map_url, latitude, longitude, instagram_url, facebook_url, tiktok_url, website_url, use_global_socials, use_global_contact, is_active")
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

// 🔽 obtener relaciones staff-servicio
const { data: staffRelations, error: staffRelError } = await supabase
  .from("staff_services")
  .select("service_id")
  .eq("tenant_id", tenant.id)
  .eq("branch_id", resolvedBranchId);

if (staffRelError) {
  return res.status(500).json({ error: staffRelError.message });
}

// 🔽 servicios que tienen al menos 1 staff
const serviceIdsWithStaff = new Set(
  (staffRelations || []).map((r) => r.service_id)
);

// 🔽 filtrar servicios
const filteredServices = (services || []).filter((s) =>
  serviceIdsWithStaff.has(s.id)
);

    if (servicesError) {
      return res.status(500).json({ error: servicesError.message });
    }

    return res.json({
      business: tenant,
      branch,
      calendar_id: calendar.id,
      services: filteredServices,
    });
  } catch (error) {
    console.error("Error en /public/services/:slug", error);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

/* ======================================================
   🌐 PUBLIC: negocio por slug
====================================================== */

app.get("/public/business/:slug", publicLimiter, async (req, res) => {
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
  logo_url,
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
  business_category,
  business_subtype,
  business_subtype_config
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

app.get("/public/staff/:slug/:service_id", publicLimiter, async (req, res) => {
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
      .select("id, tenant_id, name, slug, address, phone, whatsapp, email, description, city, commune, map_url, latitude, longitude, instagram_url, facebook_url, tiktok_url, website_url, use_global_socials, use_global_contact, is_active")
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

app.get("/public/slots/:slug/:service_id", publicLimiter, async (req, res) => {
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
      .select("id, tenant_id, name, slug, address, phone, whatsapp, email, description, city, commune, map_url, latitude, longitude, instagram_url, facebook_url, tiktok_url, website_url, use_global_socials, use_global_contact, is_active")
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
    .in("status", ["booked", "completed", "no_show", "rescheduled"])
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

if (!candidateStaffIds.length) {
  return res.json({
    business: {
      name: tenant.name,
      slug: tenant.slug,
    },
    branch,
    calendar_id: calendar.id,
    service,
    date,
    total: 0,
    slots: [],
  });
}


    let mergedSlots = [];

    for (const currentStaffId of candidateStaffIds) {
      const staffAvailability = await getEffectiveStaffAvailability({
        tenant_id: tenant.id,
        branch_id: resolvedBranchId,
        staff_id: currentStaffId,
        date,
      });

      let finalWindows = staffAvailability.windows;

      if (!isGroup) {
  finalWindows = await subtractAppointmentsFromWindows({
    tenant_id: tenant.id,
    branch_id: resolvedBranchId,
    staff_id: currentStaffId,
    date,
    windows: finalWindows,
  });
}

      const baseSlotMinutes = calendar.slot_minutes || 30;
      const totalMinutes =
        (service.duration_minutes || 0) +
        (service.buffer_before_minutes || 0) +
        (service.buffer_after_minutes || 0);
      const visibleStepMinutes = Math.max(
        baseSlotMinutes,
        totalMinutes || baseSlotMinutes
      );

      let staffSlots = buildSlotsFromWindows(
        finalWindows,
        date,
        baseSlotMinutes
      );

staffSlots = filterSlotsByWindows(
  staffSlots,
  finalWindows,
  date
);

staffSlots = filterSlotsForServiceDuration(
  staffSlots,
  totalMinutes,
  baseSlotMinutes
);

staffSlots = filterSlotsByVisibleStep(
  staffSlots,
  visibleStepMinutes
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
app.get("/booking-fields/:slug", tenantAuthSlug, async (req, res) => {
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
app.put("/booking-fields/:slug", tenantAuthSlugWrite, async (req, res) => {
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
app.post("/upload/campaign-image", [dashboardLimiter, requireTenantAuth, requireWriteAccess], upload.single("file"), async (req, res) => {
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
app.get("/campaign-images/:slug", tenantAuthSlug, async (req, res) => {
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
app.delete("/campaign-images/:id", [dashboardLimiter, requireTenantAuth, requireWriteAccess], async (req, res) => {
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
// =======================
// SOPORTE — TICKETS
// =======================

app.post("/upload/ticket-attachment", [dashboardLimiter, requireTenantAuth], uploadTicket.single("file"), async (req, res) => {
  try {
    const { tenant_id } = req.body;
    if (!tenant_id || !req.file)
      return res.status(400).json({ error: "tenant_id y archivo requeridos" });
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (!allowed.includes(req.file.mimetype))
      return res.status(400).json({ error: "Solo se permiten imágenes JPG, PNG o WebP" });
    if (req.file.size > 1 * 1024 * 1024)
      return res.status(400).json({ error: "La imagen no debe superar 1MB" });
    const fileName = `${tenant_id}/${Date.now()}-${req.file.originalname}`;
    const { error } = await supabase.storage
      .from("ticket-attachments")
      .upload(fileName, req.file.buffer, { contentType: req.file.mimetype });
    if (error) throw error;
    const { data: urlData } = supabase.storage.from("ticket-attachments").getPublicUrl(fileName);
    res.json({ url: urlData.publicUrl });
  } catch (err) {
    console.error("POST /upload/ticket-attachment error:", err);
    res.status(500).json({ error: "Error subiendo imagen" });
  }
});

app.post("/support/tickets", tenantAuthWrite, async (req, res) => {
  try {
    const { tenant_id, created_by, subject, category, description, attachments } = req.body;
    console.log("[DEBUG support/tickets] body:", JSON.stringify({ tenant_id, created_by, subject, category, description: description?.slice(0, 30) }));
    if (!tenant_id || !created_by || !subject?.trim() || !description?.trim())
      return res.status(400).json({ error: "Faltan datos requeridos" });
    if (Array.isArray(attachments) && attachments.length > 1)
      return res.status(400).json({ error: "Máximo 1 imagen por ticket" });
    const validCategories = [
      "agenda_reservas", "pagina_publica", "disponibilidad_horarios",
      "staff", "servicios", "sucursales", "clientes", "campanas",
      "facturacion_planes", "mi_cuenta", "equipo_permisos", "calendario_google",
      "error_tecnico", "sugerencia", "otro",
    ];
    if (!validCategories.includes(category))
      return res.status(400).json({ error: "Categoría no válida" });
    const { data: tenant } = await supabase
      .from("tenants")
      .select("plan")
      .eq("id", tenant_id)
      .single();
    const plan = tenant?.plan ?? "pro";
    const priority = getPriorityByPlan(plan);
    const { data, error } = await supabase
      .from("support_tickets")
      .insert({
        tenant_id,
        created_by,
        subject: subject.trim(),
        category,
        description: description.trim(),
        attachments: attachments ?? [],
        plan_at_creation: plan,
        priority,
      })
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error("POST /support/tickets error:", err);
    res.status(500).json({ error: "Error creando ticket" });
  }
});

app.get("/support/tickets", tenantAuth, async (req, res) => {
  try {
    const { tenant_id } = req.query;
    if (!tenant_id) return res.status(400).json({ error: "tenant_id requerido" });
    const { data, error } = await supabase
      .from("support_tickets")
      .select("*")
      .eq("tenant_id", tenant_id)
      .order("created_at", { ascending: false });
    if (error) throw error;
    res.json(data ?? []);
  } catch (err) {
    console.error("GET /support/tickets error:", err);
    res.status(500).json({ error: "Error obteniendo tickets" });
  }
});

app.get("/support/tickets/:id/messages", [dashboardLimiter, requireTenantAuth], async (req, res) => {
  try {
    const { id } = req.params;
    const { tenant_id } = req.query;
    if (!tenant_id) return res.status(400).json({ error: "tenant_id requerido" });
    const { data: ticket } = await supabase
      .from("support_tickets")
      .select("id")
      .eq("id", id)
      .eq("tenant_id", tenant_id)
      .single();
    if (!ticket) return res.status(404).json({ error: "Ticket no encontrado" });
    const { data, error } = await supabase
      .from("support_ticket_messages")
      .select("*")
      .eq("ticket_id", id)
      .order("created_at", { ascending: true });
    if (error) throw error;
    res.json(data ?? []);
  } catch (err) {
    console.error("GET /support/tickets/:id/messages error:", err);
    res.status(500).json({ error: "Error obteniendo mensajes" });
  }
});

app.post("/support/tickets/:id/messages", [dashboardLimiter, requireTenantAuth, requireWriteAccess], async (req, res) => {
  try {
    const { id } = req.params;
    const { tenant_id, sender_id, message, attachments, sender_type: rawSenderType } = req.body;
    if (!tenant_id || !sender_id || !message?.trim())
      return res.status(400).json({ error: "Faltan datos requeridos" });
    const validSenderTypes = ["customer", "support"];
    const sender_type = validSenderTypes.includes(rawSenderType) ? rawSenderType : "customer";
    if (Array.isArray(attachments) && attachments.length > 1)
      return res.status(400).json({ error: "Máximo 1 imagen por mensaje" });
    const { data: ticket } = await supabase
      .from("support_tickets")
      .select("id, status")
      .eq("id", id)
      .eq("tenant_id", tenant_id)
      .single();
    if (!ticket) return res.status(404).json({ error: "Ticket no encontrado" });
    const { data, error } = await supabase
      .from("support_ticket_messages")
      .insert({
        ticket_id: id,
        sender_type,
        sender_id,
        message: message.trim(),
        attachments: attachments ?? [],
      })
      .select()
      .single();
    if (error) throw error;
    if (sender_type === "support") {
      await supabase
        .from("support_tickets")
        .update({ has_unread_for_customer: true, status: "answered", updated_at: new Date().toISOString() })
        .eq("id", id);
    } else if (["closed", "waiting_confirmation"].includes(ticket.status)) {
      await supabase
        .from("support_tickets")
        .update({ status: "reopened", updated_at: new Date().toISOString() })
        .eq("id", id);
    }
    res.json(data);
  } catch (err) {
    console.error("POST /support/tickets/:id/messages error:", err);
    res.status(500).json({ error: "Error enviando mensaje" });
  }
});

app.patch("/support/tickets/:id/mark-read", [dashboardLimiter, requireTenantAuth], async (req, res) => {
  try {
    const { id } = req.params;
    const { tenant_id } = req.body;
    if (!tenant_id) return res.status(400).json({ error: "tenant_id requerido" });
    const { error } = await supabase
      .from("support_tickets")
      .update({ has_unread_for_customer: false })
      .eq("id", id)
      .eq("tenant_id", tenant_id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error("PATCH /support/tickets/:id/mark-read error:", err);
    res.status(500).json({ error: "Error marcando como leído" });
  }
});

app.get("/support/tickets/unread-count", tenantAuth, async (req, res) => {
  try {
    const { tenant_id } = req.query;
    if (!tenant_id) return res.status(400).json({ error: "tenant_id requerido" });
    const { count, error } = await supabase
      .from("support_tickets")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenant_id)
      .eq("has_unread_for_customer", true);
    if (error) throw error;
    res.json({ count: count ?? 0 });
  } catch (err) {
    console.error("GET /support/tickets/unread-count error:", err);
    res.status(500).json({ error: "Error obteniendo contador" });
  }
});

app.patch("/support/tickets/:id/resolve", [dashboardLimiter, requireTenantAuth], async (req, res) => {
  try {
    const { id } = req.params;
    const { tenant_id } = req.body;
    if (!tenant_id) return res.status(400).json({ error: "tenant_id requerido" });
    const { error } = await supabase
      .from("support_tickets")
      .update({
        status: "waiting_confirmation",
        resolution_requested_at: new Date().toISOString(),
        has_unread_for_customer: true,
      })
      .eq("id", id)
      .eq("tenant_id", tenant_id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error("PATCH /support/tickets/:id/resolve error:", err);
    res.status(500).json({ error: "Error marcando como resuelto" });
  }
});

app.patch("/support/tickets/:id/confirm-resolution", [dashboardLimiter, requireTenantAuth], async (req, res) => {
  try {
    const { id } = req.params;
    const { tenant_id, confirmed } = req.body;
    if (!tenant_id || typeof confirmed !== "boolean")
      return res.status(400).json({ error: "tenant_id y confirmed (boolean) requeridos" });
    const newStatus = confirmed ? "closed" : "reopened";
    const { error } = await supabase
      .from("support_tickets")
      .update({ status: newStatus, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("tenant_id", tenant_id);
    if (error) throw error;
    res.json({ success: true, status: newStatus });
  } catch (err) {
    console.error("PATCH /support/tickets/:id/confirm-resolution error:", err);
    res.status(500).json({ error: "Error confirmando resolución" });
  }
});

// =======================
// ADMIN PANEL ROUTES
// =======================

async function requireAdminAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Token requerido" });
    }
    const token = authHeader.split(" ")[1];
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return res.status(401).json({ error: "Token inválido" });
    }
    const { data: adminRow } = await supabase
      .from("admin_users")
      .select("user_id, email, is_active")
      .eq("user_id", user.id)
      .single();
    if (!adminRow || !adminRow.is_active) {
      return res.status(403).json({ error: "Acceso denegado" });
    }
    const jwtPayload = JSON.parse(Buffer.from(token.split(".")[1], "base64").toString());
    if (jwtPayload.aal !== "aal2") {
      return res.status(403).json({ error: "mfa_required" });
    }
    req.adminUser = { user_id: user.id, email: adminRow.email };
    next();
  } catch (err) {
    console.error("requireAdminAuth error:", err);
    return res.status(500).json({ error: "Error de autenticación" });
  }
}

const PRIORITY_ORDER = { maxima: 0, alta: 1, media: 2, normal: 3 };

app.get("/admin/tickets", requireAdminAuth, async (req, res) => {
  try {
    const { status } = req.query;
    let query = supabase
      .from("support_tickets")
      .select("*, tenants!inner(name, slug, plan, plan_slug)")
      .order("created_at", { ascending: false });
    if (status) query = query.eq("status", status);
    const { data, error } = await query;
    if (error) throw error;
    const tickets = (data ?? [])
      .map(t => ({
        ...t,
        tenant_name: t.tenants?.name,
        tenant_slug: t.tenants?.slug,
        tenant_plan: t.tenants?.plan_slug || t.tenants?.plan || t.plan_at_creation,
      }))
      .sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 3) - (PRIORITY_ORDER[b.priority] ?? 3));
    tickets.forEach(t => delete t.tenants);
    res.json(tickets);
  } catch (err) {
    console.error("GET /admin/tickets error:", err);
    res.status(500).json({ error: "Error obteniendo tickets" });
  }
});

app.get("/admin/tickets/:id/messages", requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { data: ticket } = await supabase
      .from("support_tickets")
      .select("id")
      .eq("id", id)
      .single();
    if (!ticket) return res.status(404).json({ error: "Ticket no encontrado" });
    const { data, error } = await supabase
      .from("support_ticket_messages")
      .select("*")
      .eq("ticket_id", id)
      .order("created_at", { ascending: true });
    if (error) throw error;
    res.json(data ?? []);
  } catch (err) {
    console.error("GET /admin/tickets/:id/messages error:", err);
    res.status(500).json({ error: "Error obteniendo mensajes" });
  }
});

app.post("/admin/tickets/:id/messages", requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { message, attachments } = req.body;
    if (!message?.trim())
      return res.status(400).json({ error: "Mensaje requerido" });
    if (Array.isArray(attachments) && attachments.length > 1)
      return res.status(400).json({ error: "Máximo 1 imagen por mensaje" });
    const { data: ticket } = await supabase
      .from("support_tickets")
      .select("id, tenant_id, status")
      .eq("id", id)
      .single();
    if (!ticket) return res.status(404).json({ error: "Ticket no encontrado" });
    const { data, error } = await supabase
      .from("support_ticket_messages")
      .insert({
        ticket_id: id,
        sender_type: "support",
        sender_id: req.adminUser.user_id,
        message: message.trim(),
        attachments: attachments ?? [],
      })
      .select()
      .single();
    if (error) throw error;
    await supabase
      .from("support_tickets")
      .update({ has_unread_for_customer: true, status: "answered", updated_at: new Date().toISOString() })
      .eq("id", id);
    res.json(data);
  } catch (err) {
    console.error("POST /admin/tickets/:id/messages error:", err);
    res.status(500).json({ error: "Error enviando mensaje" });
  }
});

app.patch("/admin/tickets/:id/resolve", requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { data: ticket } = await supabase
      .from("support_tickets")
      .select("id, tenant_id")
      .eq("id", id)
      .single();
    if (!ticket) return res.status(404).json({ error: "Ticket no encontrado" });
    const { error } = await supabase
      .from("support_tickets")
      .update({
        status: "waiting_confirmation",
        resolution_requested_at: new Date().toISOString(),
        has_unread_for_customer: true,
      })
      .eq("id", id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error("PATCH /admin/tickets/:id/resolve error:", err);
    res.status(500).json({ error: "Error marcando como resuelto" });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor listo en http://localhost:${PORT}`);
});

app.get("/api/pets/:slug", tenantAuthSlug, async (req, res) => {
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

/* ======================================================
   ✅ INVITACIONES — POST /invitations
   Crea una invitación pendiente y envía email al invitado.
   Body: { tenant_id, email, role, branch_id?, invited_by? }
====================================================== */
app.post("/invitations", tenantAuthWrite, async (req, res) => {
  try {
    const { tenant_id, email, role, branch_id, invited_by, permissions } = req.body;

    if (!tenant_id || !email || !role) {
      return res.status(400).json({ error: "Faltan campos: tenant_id, email, role" });
    }

    const validRoles = ["admin", "branch", "readonly", "custom"];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: "role inválido. Valores permitidos: admin, branch, readonly" });
    }

    if (role === "branch" && !branch_id) {
      return res.status(400).json({ error: "branch_id es obligatorio para el rol branch" });
    }

    // Validar que el tenant existe y está activo
    const { data: tenant, error: tenantError } = await supabase
      .from("tenants")
      .select("id, name, slug")
      .eq("id", tenant_id)
      .single();

    if (tenantError || !tenant) {
      return res.status(404).json({ error: "Tenant no encontrado" });
    }

    // Validar branch_id pertenece al tenant
    if (role === "branch") {
      const { data: branch, error: branchError } = await supabase
        .from("branches")
        .select("id")
        .eq("id", branch_id)
        .eq("tenant_id", tenant_id)
        .single();

      if (branchError || !branch) {
        return res.status(404).json({ error: "Sucursal no encontrada en este tenant" });
      }
    }

    const normalizedEmail = String(email).trim().toLowerCase();

    // Verificar que no existe invitación pending para este email en este tenant
    const { data: existingInvitation } = await supabase
      .from("tenant_invitations")
      .select("id")
      .eq("tenant_id", tenant_id)
      .eq("email", normalizedEmail)
      .eq("status", "pending")
      .maybeSingle();

    if (existingInvitation) {
      return res.status(409).json({ error: "Ya existe una invitación pendiente para este email en este tenant" });
    }

    // Verificar que el email no es ya miembro activo
    // Buscar el user_id correspondiente al email en auth.users
    const { data: authList } = await supabase.auth.admin.listUsers({ perPage: 1000 });
    const matchingAuthUser = authList?.users?.find(
      (u) => String(u.email || "").toLowerCase() === normalizedEmail
    );

    if (matchingAuthUser) {
      const { data: existingMember } = await supabase
        .from("tenant_users")
        .select("id")
        .eq("tenant_id", tenant_id)
        .eq("user_id", matchingAuthUser.id)
        .eq("is_active", true)
        .maybeSingle();

      if (existingMember) {
        return res.status(409).json({ error: "Este email ya es miembro activo del tenant" });
      }
    }

    // Generar token único
    const token = crypto.randomBytes(32).toString("hex");

    // expires_at = ahora + 7 días
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const insertPayload = {
      tenant_id,
      email: normalizedEmail,
      role,
      token,
      status: "pending",
      expires_at: expiresAt,
    };

    if (branch_id) insertPayload.branch_id = branch_id;
    if (invited_by) insertPayload.invited_by = invited_by;
    if (permissions) insertPayload.permissions = permissions;
    if (req.body.branch_ids) insertPayload.branch_ids = req.body.branch_ids;

    const { data: invitation, error: insertError } = await supabase
      .from("tenant_invitations")
      .insert(insertPayload)
      .select()
      .single();

    if (insertError) throw insertError;

    // Enviar email de invitación (no bloquea respuesta si falla)
    sendInvitationEmail({
      email: normalizedEmail,
      businessName: tenant.name,
      role,
      token,
    }).catch((err) => console.error("sendInvitationEmail error:", err));

    return res.status(201).json({ ok: true, invitation });
  } catch (err) {
    console.error("POST /invitations error:", err.message);
    return res.status(500).json({ error: "Error creando invitación", detail: err.message });
  }
});

/* ======================================================
   ✅ INVITACIONES — GET /invitations
   Lista todas las invitaciones del tenant.
   Query: { tenant_id }
====================================================== */
app.get("/invitations", tenantAuth, async (req, res) => {
  try {
    const { tenant_id } = req.query;

    if (!tenant_id) {
      return res.status(400).json({ error: "tenant_id es obligatorio" });
    }

    const { data: invitations, error } = await supabase
      .from("tenant_invitations")
      .select("id, email, role, branch_id, status, invited_by, expires_at, accepted_at, created_at")
      .eq("tenant_id", tenant_id)
      .order("created_at", { ascending: false });

    if (error) throw error;

    return res.json({ ok: true, invitations: invitations || [] });
  } catch (err) {
    console.error("GET /invitations error:", err.message);
    return res.status(500).json({ error: "Error obteniendo invitaciones", detail: err.message });
  }
});

/* ======================================================
   ✅ INVITACIONES — DELETE /invitations/:id
   Cancela una invitación (cambia status a canceled, no elimina).
   Body: { tenant_id }
====================================================== */
app.delete("/invitations/:id", tenantAuthWrite, async (req, res) => {
  try {
    const { id } = req.params;
    const { tenant_id } = req.body;

    if (!id || !tenant_id) {
      return res.status(400).json({ error: "Faltan campos: id (param), tenant_id (body)" });
    }

    // Validar que la invitación pertenece al tenant
    const { data: invitation, error: fetchError } = await supabase
      .from("tenant_invitations")
      .select("id, status")
      .eq("id", id)
      .eq("tenant_id", tenant_id)
      .single();

    if (fetchError || !invitation) {
      return res.status(404).json({ error: "Invitación no encontrada en este tenant" });
    }

    if (invitation.status !== "pending") {
      return res.status(400).json({ error: `No se puede cancelar una invitación con status: ${invitation.status}` });
    }

    const { error: updateError } = await supabase
      .from("tenant_invitations")
      .update({ status: "canceled" })
      .eq("id", id);

    if (updateError) throw updateError;

    return res.json({ ok: true, message: "Invitación cancelada correctamente" });
  } catch (err) {
    console.error("DELETE /invitations/:id error:", err.message);
    return res.status(500).json({ error: "Error cancelando invitación", detail: err.message });
  }
});

/* ======================================================
   ✅ INVITACIONES — POST /invitations/accept/:token
   Acepta una invitación: crea el miembro en tenant_users
   y opcionalmente en branch_access si role === 'branch'.
====================================================== */
app.post("/invitations/accept/:token", async (req, res) => {
  try {
    const { token } = req.params;

    if (!token) {
      return res.status(400).json({ error: "token es obligatorio" });
    }

    // Buscar invitación por token
    const { data: invitation, error: fetchError } = await supabase
      .from("tenant_invitations")
      .select("id, tenant_id, branch_id, email, role, permissions, status, expires_at")
      .eq("token", token)
      .single();

    if (fetchError || !invitation) {
      return res.status(404).json({ error: "Token de invitación no válido" });
    }

    // Validar status
    if (invitation.status !== "pending") {
      return res.status(400).json({
        error: `Esta invitación ya fue ${invitation.status === "accepted" ? "aceptada" : invitation.status}`,
      });
    }

    // Validar expiración
    const now = new Date();
    const expiresAt = new Date(invitation.expires_at);
    if (now > expiresAt) {
      // Marcar como expirada
      await supabase
        .from("tenant_invitations")
        .update({ status: "expired" })
        .eq("id", invitation.id);

      return res.status(410).json({ error: "Esta invitación ha expirado. Solicita una nueva al administrador." });
    }

    // Buscar usuario en auth.users por email
    const normalizedEmail = String(invitation.email).toLowerCase();
    const { data: authList } = await supabase.auth.admin.listUsers({ perPage: 1000 });
    const authUser = authList?.users?.find(
      (u) => String(u.email || "").toLowerCase() === normalizedEmail
    );

    if (!authUser) {
      return res.status(404).json({
        error: "No existe una cuenta de Orbyx con este email. Crea tu cuenta primero y luego acepta la invitación.",
        email: invitation.email,
      });
    }

    // Verificar que no sea ya miembro activo
    const { data: existingMember } = await supabase
      .from("tenant_users")
      .select("id")
      .eq("tenant_id", invitation.tenant_id)
      .eq("user_id", authUser.id)
      .eq("is_active", true)
      .maybeSingle();

    if (existingMember) {
      // Si ya es miembro, marcar invitación como aceptada igual y retornar ok
      await supabase
        .from("tenant_invitations")
        .update({ status: "accepted", accepted_at: new Date().toISOString() })
        .eq("id", invitation.id);

      const { data: tenantData } = await supabase
        .from("tenants")
        .select("slug")
        .eq("id", invitation.tenant_id)
        .single();

      return res.json({ ok: true, tenant_slug: tenantData?.slug, role: invitation.role });
    }

    // Insertar en tenant_users
    const { error: memberError } = await supabase
      .from("tenant_users")
      .insert({
        user_id: authUser.id,
        tenant_id: invitation.tenant_id,
        role: invitation.role,
        permissions: invitation.permissions ?? {},
        branch_ids: invitation.branch_ids ?? [],
        is_active: true,
      });

    if (memberError) throw memberError;

    // Si rol es branch, insertar en branch_access
    if (invitation.role === "branch" && invitation.branch_id) {
      const { error: branchAccessError } = await supabase
        .from("branch_access")
        .insert({
          user_id: authUser.id,
          tenant_id: invitation.tenant_id,
          branch_id: invitation.branch_id,
          role: "operator",
          is_active: true,
        });

      if (branchAccessError) {
        console.error("branch_access insert error:", branchAccessError.message);
        // No lanzamos — el miembro ya fue creado, esto es secundario
      }
    }

    // Marcar invitación como aceptada
    await supabase
      .from("tenant_invitations")
      .update({ status: "accepted", accepted_at: new Date().toISOString() })
      .eq("id", invitation.id);

    // Obtener slug del tenant para redirección
    const { data: tenantData } = await supabase
      .from("tenants")
      .select("slug")
      .eq("id", invitation.tenant_id)
      .single();

    return res.json({ ok: true, tenant_slug: tenantData?.slug, role: invitation.role });
  } catch (err) {
    console.error("POST /invitations/accept/:token error:", err.message);
    return res.status(500).json({ error: "Error aceptando invitación", detail: err.message });
  }
});

/* ======================================================
   ✅ INVITACIONES — GET /invitations/token/:token
   Endpoint público para leer una invitación pendiente por token.
====================================================== */
app.get("/invitations/token/:token", async (req, res) => {
  try {
    const { token } = req.params;
    const { data, error } = await supabase
      .from("tenant_invitations")
      .select("id, email, role, permissions, status, expires_at, tenant_id")
      .eq("token", token)
      .eq("status", "pending")
      .single();

    if (error || !data) {
      return res.status(404).json({ error: "Invitación no válida o ya fue usada." });
    }

    if (data.expires_at && new Date(data.expires_at) < new Date()) {
      return res.status(410).json({ error: "Esta invitación ha expirado." });
    }

    const { data: tenant } = await supabase
      .from("tenants")
      .select("name, slug")
      .eq("id", data.tenant_id)
      .single();

    return res.json({
      ...data,
      tenant_name: tenant?.name ?? "el negocio",
      tenant_slug: tenant?.slug ?? null,
    });
  } catch (err) {
    console.error("GET /invitations/token/:token error:", err.message);
    return res.status(500).json({ error: "Error verificando invitación" });
  }
});

/* ======================================================
   ✅ MIEMBROS — GET /members
   Lista miembros activos del tenant con email y sucursal.
   Query: { tenant_id }
====================================================== */
app.get("/members", tenantAuth, async (req, res) => {
  try {
    const { tenant_id } = req.query;

    if (!tenant_id) {
      return res.status(400).json({ error: "tenant_id es obligatorio" });
    }

    const { data: members, error: membersError } = await supabase
      .from("tenant_users")
      .select("id, user_id, tenant_id, role, is_active, created_at")
      .eq("tenant_id", tenant_id)
      .eq("is_active", true)
      .order("created_at", { ascending: true });

    if (membersError) throw membersError;

    if (!members || members.length === 0) {
      return res.json({ ok: true, members: [] });
    }

    // Obtener emails desde auth.users
    const { data: authList } = await supabase.auth.admin.listUsers({ perPage: 1000 });
    const authUsersMap = {};
    if (authList?.users) {
      for (const u of authList.users) {
        authUsersMap[u.id] = u.email || null;
      }
    }

    // Obtener branch_access para miembros con rol branch
    const branchMemberIds = members
      .filter((m) => m.role === "branch")
      .map((m) => m.user_id);

    let branchAccessMap = {};
    if (branchMemberIds.length > 0) {
      const { data: branchAccesses } = await supabase
        .from("branch_access")
        .select("user_id, branch_id, role, branches(id, name)")
        .eq("tenant_id", tenant_id)
        .eq("is_active", true)
        .in("user_id", branchMemberIds);

      if (branchAccesses) {
        for (const ba of branchAccesses) {
          branchAccessMap[ba.user_id] = {
            branch_id: ba.branch_id,
            branch_role: ba.role,
            branch_name: ba.branches?.name || null,
          };
        }
      }
    }

    // Enriquecer cada miembro
    const enrichedMembers = members.map((m) => ({
      ...m,
      email: authUsersMap[m.user_id] || null,
      branch_access: m.role === "branch" ? (branchAccessMap[m.user_id] || null) : null,
    }));

    return res.json({ ok: true, members: enrichedMembers });
  } catch (err) {
    console.error("GET /members error:", err.message);
    return res.status(500).json({ error: "Error obteniendo miembros", detail: err.message });
  }
});

/* ======================================================
   ✅ MIEMBROS — PATCH /members/:id
   Actualiza rol, branch_id o is_active de un miembro.
   No permite modificar al owner.
   Body: { tenant_id, role?, branch_id?, is_active? }
====================================================== */
app.patch("/members/:id", tenantAuthWrite, async (req, res) => {
  try {
    const { id } = req.params;
    const { tenant_id, role, branch_id, is_active, permissions, branch_ids } = req.body;

    if (!id || !tenant_id) {
      return res.status(400).json({ error: "Faltan campos: id (param), tenant_id (body)" });
    }

    // Buscar el miembro
    const { data: member, error: fetchError } = await supabase
      .from("tenant_users")
      .select("id, user_id, tenant_id, role, is_active")
      .eq("id", id)
      .eq("tenant_id", tenant_id)
      .single();

    if (fetchError || !member) {
      return res.status(404).json({ error: "Miembro no encontrado en este tenant" });
    }

    // No permitir modificar al owner
    if (member.role === "owner") {
      return res.status(403).json({ error: "No se puede modificar al owner del tenant" });
    }

    const validRoles = ["admin", "branch", "readonly"];

    if (role !== undefined && !validRoles.includes(role)) {
      return res.status(400).json({ error: "role inválido. Valores permitidos: admin, branch, readonly" });
    }

    const newRole = role !== undefined ? role : member.role;

    // Si el nuevo rol es branch, requerir branch_id
    if (newRole === "branch" && !branch_id) {
      return res.status(400).json({ error: "branch_id es obligatorio para el rol branch" });
    }

    // Validar branch_id pertenece al tenant si se proveyó
    if (newRole === "branch" && branch_id) {
      const { data: branch, error: branchError } = await supabase
        .from("branches")
        .select("id")
        .eq("id", branch_id)
        .eq("tenant_id", tenant_id)
        .single();

      if (branchError || !branch) {
        return res.status(404).json({ error: "Sucursal no encontrada en este tenant" });
      }
    }

    // Construir payload de actualización
    const updatePayload = {};
    if (role !== undefined) updatePayload.role = role;
    if (is_active !== undefined) updatePayload.is_active = Boolean(is_active);
    if (permissions !== undefined) updatePayload.permissions = permissions;
    if (branch_ids !== undefined) updatePayload.branch_ids = branch_ids;

    const { data: updated, error: updateError } = await supabase
      .from("tenant_users")
      .update(updatePayload)
      .eq("id", id)
      .select()
      .single();

    if (updateError) throw updateError;

    // Gestionar branch_access si el rol es branch
    if (newRole === "branch" && branch_id) {
      const { data: existingAccess } = await supabase
        .from("branch_access")
        .select("id")
        .eq("user_id", member.user_id)
        .eq("tenant_id", tenant_id)
        .maybeSingle();

      if (existingAccess) {
        await supabase
          .from("branch_access")
          .update({ branch_id, is_active: updatePayload.is_active ?? true })
          .eq("id", existingAccess.id);
      } else {
        await supabase
          .from("branch_access")
          .insert({
            user_id: member.user_id,
            tenant_id,
            branch_id,
            role: "operator",
            is_active: true,
          });
      }
    }

    // Si se desactiva el miembro, desactivar también su branch_access
    if (updatePayload.is_active === false) {
      await supabase
        .from("branch_access")
        .update({ is_active: false })
        .eq("user_id", member.user_id)
        .eq("tenant_id", tenant_id);
    }

    return res.json({ ok: true, member: updated });
  } catch (err) {
    console.error("PATCH /members/:id error:", err.message);
    return res.status(500).json({ error: "Error actualizando miembro", detail: err.message });
  }
});


/* ======================================================
   ACCOUNT — EMAIL CHANGE (dual-confirmation)
====================================================== */

async function logSecurityAudit(user_id, tenant_id, action, metadata, ip_address) {
  try {
    await supabase.from("security_audit_log").insert({
      user_id,
      tenant_id: tenant_id || null,
      action,
      metadata: metadata || {},
      ip_address: ip_address || null,
    });
  } catch (err) {
    console.error("logSecurityAudit error:", err.message);
  }
}

async function verifyCurrentPassword(email, password) {
  try {
    const r = await fetch(
      process.env.SUPABASE_URL + "/auth/v1/token?grant_type=password",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        },
        body: JSON.stringify({ email, password }),
      }
    );
    return r.ok;
  } catch (_) {
    return false;
  }
}

async function maybeApplyEmailChange(requestId, record) {
  if (!record.old_confirmed_at || !record.new_confirmed_at) return;
  if (record.status !== "pending") return;

  const { error: updateErr } = await supabase
    .from("email_change_requests")
    .update({ status: "applied" })
    .eq("id", requestId);

  if (updateErr) {
    console.error("maybeApplyEmailChange update status error:", updateErr.message);
    return;
  }

  const { error: authErr } = await supabase.auth.admin.updateUserById(record.user_id, {
    email: record.new_email,
  });

  if (authErr) {
    console.error("maybeApplyEmailChange auth.admin.updateUserById error:", authErr.message);
    await supabase.from("email_change_requests").update({ status: "pending" }).eq("id", requestId);
  } else {
    await logSecurityAudit(record.user_id, record.tenant_id, "email_changed", {
      old_email: record.current_email,
      new_email: record.new_email,
    }, null);
  }
}

app.post("/account/email-change/request", [dashboardLimiter, requireTenantAuth], async (req, res) => {
  try {
    const { user_id, current_email, new_email, password, tenant_id } = req.body;
    if (!user_id || !current_email || !new_email || !password) {
      return res.status(400).json({ error: "user_id, current_email, new_email y password son obligatorios" });
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(new_email)) {
      return res.status(400).json({ error: "El nuevo correo no es valido" });
    }
    if (current_email.toLowerCase() === new_email.toLowerCase()) {
      return res.status(400).json({ error: "El nuevo correo es igual al actual" });
    }
    const pwOk = await verifyCurrentPassword(current_email, password);
    if (!pwOk) {
      return res.status(401).json({ error: "Contrasena incorrecta" });
    }
    await supabase
      .from("email_change_requests")
      .update({ status: "cancelled" })
      .eq("user_id", user_id)
      .eq("status", "pending");

    const tokenOld = crypto.randomBytes(32).toString("hex");
    const tokenNew = crypto.randomBytes(32).toString("hex");

    const { error: insertErr } = await supabase.from("email_change_requests").insert({
      user_id,
      tenant_id: tenant_id || null,
      current_email,
      new_email,
      token_confirm_old_email: tokenOld,
      token_confirm_new_email: tokenNew,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
    if (insertErr) throw insertErr;

    await sendEmailChangeConfirmationToOldEmail({ to: current_email, newEmail: new_email, token: tokenOld });
    await logSecurityAudit(user_id, tenant_id || null, "email_change_requested", { current_email, new_email }, req.ip);

    return res.json({ ok: true, message: "Solicitud iniciada. Revisa tu correo actual para confirmar." });
  } catch (err) {
    console.error("POST /account/email-change/request error:", err.message);
    return res.status(500).json({ error: "Error interno", detail: err.message });
  }
});

app.get("/account/email-change/confirm-old/:token", async (req, res) => {
  try {
    const { token } = req.params;
    const { data, error } = await supabase
      .from("email_change_requests")
      .select("*")
      .eq("token_confirm_old_email", token)
      .eq("status", "pending")
      .single();

    if (error || !data) return res.status(404).json({ error: "Token invalido o ya fue usado." });
    if (new Date(data.expires_at) < new Date()) {
      return res.status(410).json({ error: "Este enlace expiro. Solicita un nuevo cambio de correo." });
    }
    if (data.old_confirmed_at) {
      return res.json({ ok: true, already: true, message: "Este correo ya fue confirmado anteriormente." });
    }

    const { error: updateErr } = await supabase
      .from("email_change_requests")
      .update({ old_confirmed_at: new Date().toISOString() })
      .eq("id", data.id);
    if (updateErr) throw updateErr;

    await sendEmailChangeVerificationToNewEmail({ to: data.new_email, token: data.token_confirm_new_email });

    const fresh = { ...data, old_confirmed_at: new Date().toISOString() };
    await maybeApplyEmailChange(data.id, fresh);

    return res.json({ ok: true, message: "Correo actual confirmado. Revisa tu nuevo correo para completar el cambio." });
  } catch (err) {
    console.error("GET /account/email-change/confirm-old error:", err.message);
    return res.status(500).json({ error: "Error interno", detail: err.message });
  }
});

app.get("/account/email-change/confirm-new/:token", async (req, res) => {
  try {
    const { token } = req.params;
    const { data, error } = await supabase
      .from("email_change_requests")
      .select("*")
      .eq("token_confirm_new_email", token)
      .eq("status", "pending")
      .single();

    if (error || !data) return res.status(404).json({ error: "Token invalido o ya fue usado." });
    if (new Date(data.expires_at) < new Date()) {
      return res.status(410).json({ error: "Este enlace expiro. Solicita un nuevo cambio de correo." });
    }
    if (!data.old_confirmed_at) {
      return res.status(400).json({ error: "Primero debes confirmar desde tu correo actual." });
    }
    if (data.new_confirmed_at) {
      return res.json({ ok: true, already: true, message: "El cambio ya fue aplicado anteriormente." });
    }

    const { error: updateErr } = await supabase
      .from("email_change_requests")
      .update({ new_confirmed_at: new Date().toISOString() })
      .eq("id", data.id);
    if (updateErr) throw updateErr;

    await maybeApplyEmailChange(data.id, { ...data, new_confirmed_at: new Date().toISOString() });

    return res.json({ ok: true, message: "Listo. Tu correo fue actualizado correctamente." });
  } catch (err) {
    console.error("GET /account/email-change/confirm-new error:", err.message);
    return res.status(500).json({ error: "Error interno", detail: err.message });
  }
});

app.get("/account/email-change/status", [dashboardLimiter, requireTenantAuth], async (req, res) => {
  try {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: "user_id es obligatorio" });

    const { data, error } = await supabase
      .from("email_change_requests")
      .select("id, new_email, old_confirmed_at, new_confirmed_at, status, expires_at, created_at")
      .eq("user_id", user_id)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.json({ ok: true, pending: false });

    if (new Date(data.expires_at) < new Date()) {
      await supabase.from("email_change_requests").update({ status: "expired" }).eq("id", data.id);
      return res.json({ ok: true, pending: false });
    }

    return res.json({
      ok: true,
      pending: true,
      new_email: data.new_email,
      old_confirmed: Boolean(data.old_confirmed_at),
      new_confirmed: Boolean(data.new_confirmed_at),
      expires_at: data.expires_at,
    });
  } catch (err) {
    console.error("GET /account/email-change/status error:", err.message);
    return res.status(500).json({ error: "Error interno", detail: err.message });
  }
});
