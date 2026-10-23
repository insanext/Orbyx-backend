# Diagnóstico de Gating (Planes / Límites / Add-ons) — Orbyx

Fecha de este inventario: 2026-08-20. Generado como insumo de solo lectura para
una futura sesión de diseño de un sistema de gating centralizado, en el marco
de la migración de 4 planes (pro/premium/vip/platinum) a 3 planes nuevos
(Starter/Business/Premium). **Este documento no propone ninguna solución** —
solo mapea el estado actual, con cita exacta de archivo:línea.

Metodología: `Grep` extensivo sobre `server.js` (16.514 líneas) y `orbyx-web/`
para los términos indicados en el prompt de la tarea, seguido de `Read` de
cada bloque con offset/limit para confirmar números de línea exactos (no solo
snippets de grep). No se tocó ni modificó ningún archivo del repo; el único
archivo nuevo es este mismo.

---

## 1. BACKEND (`server.js`)

### 1.1 Tablas/funciones que definen límites de plan

Hay **al menos 3 fuentes distintas de límites por plan** en el backend, más
una cuarta específica de imágenes de campaña:

#### a) `PLAN_LIMITS` (server.js:62-67) — límite de imágenes de campaña

```js
const PLAN_LIMITS = {
  pro: 7,
  premium: 15,
  vip: 30,
  platinum: 100,
};
```

Único consumidor: `server.js:14896` — `const limit = PLAN_LIMITS[plan] || 7;`
(dentro de un endpoint de campañas, probablemente límite de cantidad de
imágenes adjuntas). Esta tabla **no tiene relación estructural** con
`DEFAULT_PLAN_CAPS`/`getPlanCapabilities` — es standalone, con sus propios
4 valores por plan, y no pasa por `plan_config` ni por ningún cache.

#### b) `DEFAULT_PLAN_CAPS` (server.js:97-138) — fallback de `getPlanCapabilities`

```js
const DEFAULT_PLAN_CAPS = {
  pro: {
    max_staff: 2,
    max_services: 999999,
    max_branches: 1,
    max_campaign_emails_per_send: 200,
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
    max_group_capacity: 100,
    max_wa_confirmacion: 500,
    max_campanas_wa: 0,
    max_ia_wa: 1500,
  },
};
```

Nota: `max_services` es **999999 (prácticamente ilimitado) para los 4
planes** en el backend — dato clave para la sección de Duplicaciones más
abajo, porque el frontend sí limita servicios.

#### c) `plan_config` (tabla Supabase) — fuente de verdad real en runtime

`server.js:140-168`:

```js
let PLAN_CAPS_CACHE = null; // { [plan_slug]: caps } — poblado desde plan_config

async function refreshPlanCapsCache() {
  try {
    const { data, error } = await supabase.from("plan_config").select("*");
    if (error) throw error;
    const next = {};
    for (const row of data || []) {
      next[row.plan_slug] = {
        max_staff: row.staff_limit,
        max_services: row.services_limit,
        max_branches: row.branches_limit,
        max_campaign_emails_per_send: row.email_campaign_limit,
        max_group_capacity: row.max_group_capacity,
        max_wa_confirmacion: row.max_wa_confirmacion,
        max_campanas_wa: row.max_campanas_wa,
        max_ia_wa: row.max_ia_wa,
      };
    }
    PLAN_CAPS_CACHE = next;
  } catch (err) {
    console.error("refreshPlanCapsCache error:", err.message);
  }
}
refreshPlanCapsCache();
```

Se relee al arrancar el server y en cada `PATCH /admin/plans/:slug`
(server.js:15449, `await refreshPlanCapsCache();`). Editable desde
`GET/PATCH /admin/plans` (panel admin, server.js:15398-15455).

#### d) `getPlanCapabilities(plan, opts)` — función que unifica (b) y (c)

server.js:170-186:

```js
function getPlanCapabilities(plan, opts = {}) {
  const normalizedPlan = String(plan || "pro").toLowerCase();
  const plans = PLAN_CAPS_CACHE || DEFAULT_PLAN_CAPS;

  if (normalizedPlan === "starter") {
    return plans.pro || DEFAULT_PLAN_CAPS.pro;
  }

  const caps = plans[normalizedPlan] || plans.pro || DEFAULT_PLAN_CAPS.pro;

  // Durante versión de prueba Pro: wa_confirmacion no incluido
  if (opts.is_trial && normalizedPlan === "pro") {
    return { ...caps, max_wa_confirmacion: 0 };
  }

  return caps;
}
```

Confirma que `"starter"` **ya está normalizado a `"pro"`** en esta función
(rama explícita `if (normalizedPlan === "starter") return plans.pro`). Esta
misma normalización se repite en `normalizePlanSlug` (server.js:244-249):

```js
function normalizePlanSlug(plan) {
  const normalized = String(plan || "pro").toLowerCase();
  if (normalized === "starter") return "pro";
  if (PLAN_ORDER[normalized]) return normalized;
  return "pro";
}
```

Llamadores de `getPlanCapabilities`: server.js:481, 511, 638, 10073, 10225,
13506 (detalle de cada uno en 1.2).

### 1.2 Endpoints que leen/aplican límites de plan — real vs. solo frontend

| Endpoint | Línea | Chequeo real en backend | Detalle |
|---|---|---|---|
| `POST /staff` | server.js:4023 (check en 4052-4061) | **SÍ** | `const maxStaff = await getEffectiveLimit(tenant_id, plan, "max_staff", "staff"); if (staffCount >= maxStaff) return res.status(403)...` |
| `POST /branches` | server.js:13036 aprox. (check en 13064-13074) | **SÍ** | `const maxBranches = await getEffectiveLimit(tenant_id, plan, "max_branches", "sucursal"); if (branchesCount >= maxBranches) return res.status(403)...` |
| `PATCH /branches/:id` (reactivar sucursal) | server.js:13120 (check en 13204-13221) | **SÍ** | Mismo chequeo que `POST /branches`, pero solo se dispara si `is_active` pasa de `false` a `true` |
| `POST /services` | server.js:~13470 (check en 13505-13514) | **SÍ, pero con `caps.max_services \|\| 3`** | `if (servicesCount >= (caps.max_services || 3)) return res.status(403)...` — como `max_services` real es 999999 en todos los planes, este chequeo nunca dispara en la práctica hoy |
| `POST /services` (capacidad grupal) | server.js:13516-13526 | **SÍ** | `getEffectiveGroupCapacity(tenant_id)`; si `capacity > maxGroupCapacity` → 400 |
| Envío de campañas de email | server.js:7825-7831 (uso), función en 636-697 | **SÍ** | `checkMonthlyUsage(tenant.id, "emails_campana")`; `planLimit = emailUsage.remaining` |
| Confirmación WhatsApp (`POST /appointments/slot`) | server.js:784-812 (dentro de `sendBookingConfirmations`) | **SÍ** | `checkMonthlyUsage(tenantId, "wa_confirmacion")`; si no `allowed`, se omite el envío (best-effort, no bloquea la reserva) |
| Recordatorio WhatsApp (cron) | server.js:14421 | **SÍ** | Mismo `checkMonthlyUsage(..., "wa_confirmacion")` |
| `GET /billing/addons` (con `?tenant_id=`) | server.js:10040-10144 | Informativo (no bloquea, expone `limits` para que el frontend los muestre) | Construye `limits.staff/sucursales/wa_confirmacion/campanas_wa/ia_wa/emails_campana/group_capacity` a partir de `getPlanCapabilities` + add-ons activos |
| `GET /billing/account-status` | server.js:10172 y sig. | Informativo | Devuelve `wa_confirmacion`, `ia_wa`, toggles WA, deposit config, etc. |

No se encontró ningún endpoint de creación de recursos (`staff`, `branches`,
`services`) que dependa **solo** del frontend — los 3 recursos "duros"
(staff, sucursales, servicios) tienen enforcement real en `server.js`. La
única salvedad es `max_services`, cuyo valor real (999999) hace el chequeo
inocuo hoy.

### 1.3 Add-ons

#### Catálogo — `DEFAULT_ADDON_CATALOG` (server.js:281-380)

Transcripción completa:

```js
const DEFAULT_ADDON_CATALOG = {
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
```

Igual que con los planes, hay un cache real cargado desde la tabla
`addon_config` (fuente de verdad, editable vía `GET/PATCH /admin/addons`):

```js
// server.js:382-416
let ADDON_CATALOG = { ...DEFAULT_ADDON_CATALOG };

async function refreshAddonCatalogCache() {
  try {
    const { data, error } = await supabase.from("addon_config").select("*");
    if (error) throw error;
    const next = { ...DEFAULT_ADDON_CATALOG };
    for (const row of data || []) {
      next[row.addon_key] = {
        key: row.addon_key,
        name: row.name,
        description: row.description || "",
        price: row.price,
        price_pack2: row.pack2_price ?? row.price,
        price_pack3: row.pack3_price ?? row.price,
        pack_size: row.pack_size,
        grants: { [row.addon_key]: row.pack_size },
        min_plan: row.min_plan,
        available_for: row.available_for || [],
        resets_monthly: row.resets_monthly,
        accumulates: row.accumulates,
      };
    }
    ADDON_CATALOG = next;
  } catch (err) {
    console.error("refreshAddonCatalogCache error:", err.message);
  }
}
refreshAddonCatalogCache();
```

#### Validación "qué add-on está permitido en qué plan" — SÍ existe

No es cierto que todos los add-ons estén disponibles para todos los planes.
Cada add-on trae `min_plan` y `available_for` (ambos en el catálogo, ambos
editables desde `/admin/addons`). El gate real:

```js
// server.js:452-456
function isAddonAvailableForPlan(addonKey, plan) {
  const addon = ADDON_CATALOG[addonKey];
  if (!addon) return false;
  return getPlanLevel(plan) >= getPlanLevel(addon.min_plan);
}
```

Nota: la comparación usa **solo `min_plan` + `getPlanLevel` (orden numérico
de plan)**, no el array `available_for` — `available_for` se guarda y se
expone en el catálogo pero no participa en `isAddonAvailableForPlan`. Es
redundante con `min_plan` mientras el orden de planes sea lineal
(pro<premium<vip<platinum) y `available_for` sea siempre "min_plan y todo lo
de arriba", que es el caso hoy en `DEFAULT_ADDON_CATALOG`.

Se aplica realmente al activar/ampliar un add-on:

```js
// server.js:10317-10321 (POST /billing/addons/activate)
if (!isAddonAvailableForPlan(addon_key, tenantPlan)) {
  return res.status(403).json({
    error: `El plan ${tenantPlan} no permite contratar este add-on`,
  });
}
```

Y también se usa para **cancelar automáticamente** add-ons que dejan de ser
compatibles tras un downgrade (server.js:546-586, ver 1.5).

#### One-time vs. recurrente (evidencia de la integración Flow)

- **El plan/suscripción base sí es una suscripción real y recurrente en
  Flow**: se crea con `POST /subscription/create` (server.js:11456) contra un
  `Flow Plan` (`getOrCreateFlowPlan`, server.js:2450-2495, que llama
  `/plans/create` con `interval`/`interval_count`) — es un objeto de
  suscripción nativo de Flow con cobro automático periódico gestionado por
  Flow.
- **Los add-ons, en cambio, NO usan suscripciones de Flow.** Se cobran con
  `/customer/charge` (cargo único) en 3 puntos distintos:
  - Al activar/ampliar por primera vez: server.js:10361 (`POST
    /billing/addons/activate`) y server.js:10515 (`PATCH
    /billing/addons/quantity`).
  - La "recurrencia" de un add-on con `renewal_mode: "automatico"` es
    **simulada a nivel de aplicación**, no nativa de Flow: un cron interno
    (`node-cron`, server.js:15550-15560, `0 5 * * *`) llama
    `chargeRecurringAddons()` (definida en server.js:12284-12387), que
    recorre `tenant_addons` con `status='active' AND renewal_mode='automatico'
    AND (last_charged_at IS NULL OR last_charged_at <= now()-30d)` y por cada
    fila due dispara **otro** `/customer/charge` individual:
    ```js
    // server.js:12328-12333
    await flowApiRequest("/customer/charge", {
      customerId: subscription.flow_customer_id,
      amount: applyIva(netAmount),
      subject: `Add-on recurrente: ${row.addon_key} x${row.quantity}`,
      commerceOrder: `addon_recurring_${row.tenant_id}_${row.addon_key}_${Date.now()}`,
    });
    ```
  - Tras 3 fallos consecutivos (`MAX_FAILED_ATTEMPTS = 3`,
    server.js:12285), el add-on pasa `renewal_mode` a `"manual"`
    automáticamente (server.js:12363-12368) — el tenant debe reactivarlo a
    mano.
  - También existe una recarga automática independiente por saldo bajo de
    `wa_confirmacion` (`triggerLowBalanceRecharge`, referenciada en
    server.js:691 y definida cerca de la línea 12396), que usa el mismo
    patrón de `/customer/charge` puntual, no suscripción.

En resumen: **el plan es una suscripción Flow real; los add-ons son cargos
únicos repetidos por un cron propio de Orbyx**, no suscripciones Flow. Esto
es relevante para cualquier rediseño porque el "estado de recurrencia" de un
add-on vive enteramente en `tenant_addons.renewal_mode`/`last_charged_at`,
no en Flow.

#### Otros endpoints de add-ons

- `GET /billing/addons` — server.js:10040 (catálogo + límites + add-ons
  activos).
- `POST /billing/addons/activate` — server.js:10291.
- `PATCH /billing/addons/quantity` — server.js:10435.
- `POST /billing/addons/cancel` — server.js:10591.
- `PATCH /billing/addons/renewal-mode` — server.js:10658 (manual↔automático,
  con registro de consentimiento explícito, ver `recordAddonAutoChargeConsent`
  server.js:9611-9631 y tabla `addon_auto_charge_consents`).
- `PATCH /billing/addons/low-balance-recharge` — server.js:10759 (solo
  `wa_confirmacion`).

Precio escalonado por unidad (pack1/pack2/pack3+) vive en
`addonUnitTierPrice` (server.js:435-441) y `tieredAddonChargeAmount`
(server.js:443-449) — fix reciente (commit `d54163a` según git log) que
corrigió un bug de subcobro al comprar más de una unidad de golpe.

### 1.4 "WhatsApp AI" / IA conversations (`ia_wa` / `max_ia_wa`) — inventario completo

Toda referencia a este add-on/capacidad, para removerla en una sesión
futura (CLAUDE.md ya marca esto como **"Not built (explicitly out of
scope)"** para el envío real — solo existe el andamiaje de límites/catálogo):

| Archivo | Línea | Contexto |
|---|---|---|
| `server.js` | 106, 116, 126, 136 | `max_ia_wa: 0/0/500/1500` en `DEFAULT_PLAN_CAPS` (pro/premium/vip/platinum) |
| `server.js` | 160 | `max_ia_wa: row.max_ia_wa` en `refreshPlanCapsCache` |
| `server.js` | 310-323 | Definición completa del add-on `ia_wa` en `DEFAULT_ADDON_CATALOG` (ver 1.3) |
| `server.js` | 632 | `ia_wa: "max_ia_wa"` en `MONTHLY_RESOURCE_CAP_KEY` |
| `server.js` | 10120 | `ia_wa: usageEntry(caps.max_ia_wa, "ia_wa")` — respuesta de `GET /billing/addons` |
| `server.js` | 10221 | Comentario: `// GET /billing/addons (limits.wa_confirmacion / limits.ia_wa), sin...` |
| `server.js` | 15422 | `"max_ia_wa"` en `PLAN_CONFIG_EDITABLE_FIELDS` (panel admin de planes) |
| `orbyx-web/lib/plans.ts` | 5, 38, 67, 105, 142, 179 | `ExtraKey` incluye `"ia_wa"`; `includedIaWa: 0/0/500/1500` por plan; feature copy "IA WhatsApp 500/1.500 conversaciones/mes" |
| `orbyx-web/app/planes/comparar/page.tsx` | ~187-191 | Fila de comparación "IA WhatsApp" con valores por plan (pro sin fila, vip "500 conversaciones/mes", platinum "1.500...") |
| `orbyx-web/components/billing/AccountStatusWidget.tsx` | (ver CLAUDE.md, sección "Account Status Widget — Realtime Cupo") | Pill `ia_wa` con alerta de umbral (80%/100%), igual que `wa_confirmacion` |

No se encontró ningún endpoint de **envío** real de mensajes de IA por
WhatsApp (`POST` que dispare una conversación IA) — solo el límite/cupo y el
catálogo de venta del add-on existen hoy. Confirma lo que CLAUDE.md ya
declara explícitamente como no construido.

### 1.5 Cambio de plan (upgrade/downgrade) y prorrateo

Tres endpoints principales, todos en `server.js`:

- **`GET /billing/preview-change`** (server.js ~9770-9867): calcula el
  cambio sin aplicarlo.
  - Si `subscription.currentPlan === targetPlan` → `change_type: "same_plan"`.
  - Si es upgrade (`isUpgradePlanChange`, server.js:819-821, compara
    `getPlanLevel`): llama `flowApiRequest("/subscription/changePlanPreview",
    ...)` (server.js:9832) contra la suscripción Flow real, y devuelve el
    prorrateo (`amount_today`) que Flow calcula internamente.
  - Si es downgrade (`isDowngradePlanChange`, server.js:823-825): no llama a
    Flow, simplemente informa `amount_today: 0` y
    `scheduled_change_at: subscription.billingEnd` — el downgrade **siempre
    queda programado para el fin del ciclo actual**, nunca es inmediato.

- **`POST /billing/change-plan`** (server.js:9872-10032): aplica el cambio.
  - **Upgrade**: inmediato. Llama `flowApiRequest("/subscription/changePlan",
    ...)` (server.js:9927) que prorratea Y cobra en una sola llamada atómica
    contra Flow (comentario explícito en el código, server.js:9918-9924,
    aclara que no se llama `customer/charge` aparte para evitar doble cobro).
    Actualiza `tenants.plan_slug` de inmediato (server.js:9944-9954) y
    `subscriptions.plan_id/monto` (server.js:9970-9977).
  - **Downgrade**: no se aplica de inmediato. Solo escribe
    `tenants.scheduled_plan_slug` / `scheduled_change_at` /
    `pending_change_type: "downgrade"` (server.js:9999-10006).

- **`POST /billing/apply-scheduled-changes`** (server.js:10879-10932+, cron
  diario implícito — buscar el cron/endpoint que lo dispara): recorre
  tenants con `scheduled_change_at <= now()`, aplica `plan_slug = newPlan`,
  resetea el ciclo de facturación (server.js:10911-10926), y luego:
  ```js
  // server.js:10982 (fuera del rango leído completo, confirmado por grep)
  const canceledAddons = await cancelUnsupportedAddons(tenant.id, newPlan);
  ```
  `cancelUnsupportedAddons` (server.js:548-586) cancela cualquier
  `tenant_addons` activo cuyo `addon_key` ya no sea
  `isAddonAvailableForPlan(..., newPlan)` para el plan nuevo — **esto es la
  única validación real de "el plan destino soporta lo que el tenant tiene
  activo"**, y **solo cubre add-ons**, no recursos "duros".

  **Lo que NO se valida en ningún punto del cambio de plan (upgrade
  inmediato, downgrade programado, ni en `apply-scheduled-changes`):**
  si el tenant tiene más `staff` activos o más `branches` activas que el
  límite del plan destino, esos recursos **no se desactivan ni se bloquean
  automáticamente** — el tenant simplemente queda "sobre el límite" hasta
  que el propio frontend detecte el exceso. Esto coincide con lo que ya
  hacen `staff/page.tsx` y `branches/page.tsx` del lado cliente (ver 2.1):
  ambos calculan `excessStaff`/`excessBranches` y fuerzan al usuario a
  elegir cuáles desactivar, pero es un flujo de UI, no un enforcement de
  backend en el momento del cambio de plan.

  Nota adicional: `apply-scheduled-changes` también sincroniza la
  suscripción de Flow con el plan nuevo (server.js:10940-10973),
  best-effort — si falla, no bloquea el downgrade local porque
  `tenants.plan_slug` ya es la fuente de verdad de acceso.

### 1.6 Strings/enums de plan en el código

- `PLAN_PRICES` (server.js:188-193): `{ pro: 12990, premium: 29990, vip:
  54990, platinum: 149990 }`.
- `PLAN_ORDER` (server.js:195-200): `{ pro: 1, premium: 2, vip: 3, platinum:
  4 }` — fuente de `getPlanLevel` (server.js:815-817).
- `normalizePlan` (server.js:69-76) y `normalizePlanSlug` (server.js:244-249)
  — dos funciones de normalización de plan **distintas**, ambas mapean
  `"starter"` → `"pro"` (la segunda de forma explícita en una rama `if`; la
  primera implícitamente porque cualquier valor no reconocido cae al
  `return "pro"` final).
- `getPriorityByPlan` (server.js:239-242): mapea plan → prioridad de soporte
  (`normal/media/alta/maxima`) — un cuarto mapeo por plan, no relacionado con
  límites.
- **Confirmado: `"starter"` ya está normalizado a `"pro"` en el backend**, en
  al menos 2 lugares (`getPlanCapabilities` línea 174-176,
  `normalizePlanSlug` línea 246). No hay ningún plan llamado `"business"` en
  el backend todavía — la migración a los 3 planes nuevos (Starter/Business/
  Premium) no tiene ningún soporte de datos hoy más allá de este alias
  `starter→pro` ya existente (que en la nomenclatura vieja significa otra
  cosa: ahí "starter" es sinónimo informal de "pro", no un plan propio).

---

## 2. FRONTEND — dashboard (`orbyx-web/app/dashboard/[slug]/`)

### 2.1 Archivos pedidos explícitamente

**`staff/page.tsx`** (fuente real desde API, no hardcodeada):
- `plan_slug` en el tipo de negocio: línea 16.
- `normalizePlanSlug` local (duplicada, ver Duplicaciones): líneas 276-277.
- `maxStaff` viene de `GET /billing/addons`, no hardcodeado:
  ```ts
  // línea 471
  const [maxStaff, setMaxStaff] = useState<number | null>(null);
  // línea 583
  `${BACKEND_URL}/billing/addons?tenant_id=${tenantId}`
  // línea 588
  setMaxStaff(Number(data.limits.staff.total));
  ```
- Cálculo de exceso tras un downgrade: `reachedLimit` (línea 517),
  `excessStaff` (línea 518), lógica de selección de cuáles desactivar
  (líneas 563-570).
- Copy dinámico con el número real: línea 3456-3457, `` `Tu plan ${plan}
  permite ${maxStaff} profesional${...}` ``.

**`branches/page.tsx`** (misma arquitectura: número real desde API, pero
**labels/orden de plan hardcodeados**):
- `PLAN_LABELS` hardcodeado (líneas 81-86):
  ```ts
  const PLAN_LABELS: Record<string, string> = {
    starter: "Starter",
    pro: "Pro",
    premium: "Premium",
    vip: "VIP",
    platinum: "Platinum",
  };
  ```
- `NEXT_PLAN_BY_CURRENT` hardcodeado (líneas 89-94) — mapeo de "a qué plan
  subir para tener más sucursales":
  ```ts
  const NEXT_PLAN_BY_CURRENT: Record<string, string | null> = {
    starter: "premium",
    pro: "premium",
    premium: "vip",
    vip: "platinum",
    platinum: null,
  };
  ```
- `normalizePlanSlug` local (líneas 183-189), tercera copia de esta función
  (backend tiene la suya, `staff/page.tsx` tiene la suya).
- `maxBranches` real desde API (líneas 331, 720, 725):
  `setMaxBranches(Number(data.limits.sucursales.total))`.
- Exceso/selección de cuáles desactivar: líneas 695-709.

**`campaigns/page.tsx`**:
- No tiene tabla de límites propia — usa `channelLimitInfo.limit` derivado de
  `GET /billing/addons` → `data.limits.emails_campana` (líneas 1706-1723):
  ```ts
  if (res.ok && data?.limits?.emails_campana) {
    // total / used / remaining
  }
  ```
- `normalizePlan` propio (referenciado línea 1691) — no se confirmó su
  definición exacta en este barrido, pero es otro punto más de
  normalización de plan en el frontend.

**`billing/page.tsx`** (2.065 líneas):
- Importa `plans as PLAN_DEFS, cycleTotalPrice` desde `@/lib/plans` (línea
  10) — el **catálogo hardcodeado central del frontend** (ver 2.2).
  Monta `<AddonManager tenantId={tenantId} />` (línea 1633) para el tab de
  add-ons.
- Maneja el flujo de suscripción (activar/reintentar/cancelar) contra
  `/billing/flow/subscribe` y afines — `activateSubscription` (línea 800),
  `handleCancelSubscription` (línea 1054).
- Tabs definidos en línea 750 (al menos `{ id: "suscripcion", label:
  "Suscripción" }` confirmado; hay más tabs no transcritos en este barrido —
  ver 2.2 para el resto de la estructura de tabs).

### 2.2 Tabs del panel de facturación — qué archivo implementa cada uno

| Tab | Archivo | Cómo obtiene datos |
|---|---|---|
| Suscripción (plan actual, cambio de plan, cobro) | `orbyx-web/app/dashboard/[slug]/billing/page.tsx` (inline, líneas 727-946+) | `GET`/`POST` contra `/billing/flow/*`, `/billing/change-plan`, `/billing/preview-change` (backend real) |
| Add-ons | `orbyx-web/components/addons/AddonManager.tsx` (1.313 líneas), montado desde `billing/page.tsx:1633` | `GET /billing/addons?tenant_id=` (backend real, sin catálogo propio hardcodeado — confirmado por grep, no se encontró ninguna tabla de límites local en este archivo) |
| Historial de pagos | No identificado como archivo separado en este barrido — probablemente una sección más dentro de `billing/page.tsx` | (pendiente de confirmar en detalle si una sesión futura lo necesita) |
| Ajustes de límites por plan / admin | `orbyx-web/app/admin/planes/page.tsx` | `GET/PATCH /admin/plans` y `/admin/plans/:slug` (backend real, tabla `plan_config`) — este es el **panel admin**, no el panel del tenant |

### 2.3 Otros archivos del dashboard con nombres de plan o límites hardcodeados (grep amplio)

Grep de `plan_id|planId|max_staff|max_branches|max_services|pro|premium|vip|
platinum|starter` sobre `orbyx-web/app/dashboard` (excluyendo los 4 ya
cubiertos) encontró 3 archivos adicionales:

**`services/page.tsx`** — hallazgo relevante, **divergencia real, no solo
duplicación**:
```tsx
// líneas 414-422
const planCaps: Record<string, { max_services: number }> = {
  pro: { max_services: 10 },
  premium: { max_services: 25 },
  vip: { max_services: 50 },
  platinum: { max_services: 100 },
};

const caps = planCaps[plan] || planCaps.pro;
const maxServices = caps.max_services;

const servicesLimitReached = services.length >= maxServices;
const servicesRemainingCount = Math.max(0, maxServices - services.length);
```
El backend real (`DEFAULT_PLAN_CAPS`/`plan_config`) usa `max_services:
999999` para los 4 planes — es decir, **el frontend bloquea la creación de
servicios en 10/25/50/100 mientras el backend nunca bloquearía antes de
999.999 servicios**. Es la divergencia número real más clara encontrada en
todo el barrido (ver Duplicaciones).

**`layout.tsx`** (shell del dashboard):
- `planLabel` hardcodeado con ternarios (líneas 298-305):
  ```ts
  const planLabel =
    plan === "platinum" ? "Platinum" : plan === "vip" ? "VIP"
    : plan === "premium" ? "Premium" : "Pro";
  ```
  Quinta copia de un mapeo nombre-de-plan → label, sin pasar por `lib/plans.ts`.

**`page.tsx`** (home del dashboard):
- `PlanSlug` type + `PLAN_LABELS` + `PLAN_ORDER` hardcodeados (líneas 34-49):
  ```ts
  type PlanSlug = "pro" | "premium" | "vip" | "platinum" | "starter";

  const PLAN_LABELS: Record<PlanSlug, string> = {
    starter: "Pro",
    pro: "Pro",
    premium: "Premium",
    vip: "VIP",
    platinum: "Platinum",
  };

  const PLAN_ORDER: Record<PlanSlug, number> = {
    pro: 1,
    premium: 2,
    vip: 3,
    platinum: 4,
  };
  ```
  Nótese que aquí `starter` se mapea a label `"Pro"` (consistente con el
  backend), pero en `branches/page.tsx` (2.1) `PLAN_LABELS.starter` es
  `"Starter"` — **dos archivos frontend distintos le dan un label distinto a
  la misma clave `starter`**.

---

## 3. FRONTEND — checkout y páginas públicas

### 3.1 `checkout/page.tsx` — confirmado stub (37 líneas completas)

```tsx
export default function Checkout({
  searchParams,
}: {
  searchParams: { plan?: string };
}) {
  const plan = (searchParams?.plan || "starter").toLowerCase();

  const planName =
    plan === "enterprise" ? "Enterprise" : plan === "pro" ? "Pro" : "Starter";

  return (
    <main style={{ fontFamily: "Arial", padding: "60px", maxWidth: "900px", margin: "auto" }}>
      <h1 style={{ fontSize: "40px", marginBottom: 10 }}>Checkout</h1>
      <p style={{ opacity: 0.8, marginBottom: 30 }}>
        Plan seleccionado: <b>{planName}</b>
      </p>

      <div style={{ border: "1px solid #ddd", padding: 24, marginBottom: 20 }}>
        <p>
          Aquí irá el pago (Stripe o MercadoPago).
        </p>
        <p style={{ fontSize: 14, opacity: 0.75 }}>
          Por ahora es una pantalla de prueba para el flujo.
        </p>
      </div>

      <a href={`/signup?plan=${plan}`}>
        <button style={{ padding: "12px 18px", cursor: "pointer" }}>
          Continuar a crear cuenta
        </button>
      </a>

      <p style={{ marginTop: 20 }}>
        <a href="/planes">← Volver a planes</a>
      </p>
    </main>
  );
}
```

Notas: menciona **"Enterprise"**, un nombre de plan que no existe en ningún
otro lugar del código (ni backend ni `lib/plans.ts`); menciona **Stripe o
MercadoPago**, no Flow (la pasarela real usada en todo el resto del
sistema); enlaza a `/signup?plan=${plan}` con el plan tal cual viene de la
URL, sin pasar por `normalizePlanSlug`. Es, en la práctica, código muerto
que no participa del flujo de pago real (Flow vive enteramente en
`checkout-premium/page.tsx` y en los endpoints `/signup/*` y
`/billing/flow/*` de `server.js`).

### 3.2 Página pública de planes

**`orbyx-web/app/planes/page.tsx`** (1.910 líneas) — página principal de
planes, usa el catálogo central:
```ts
import {
  ... // (varios exports)
} from "@/lib/plans";
```
Consume `includedStaff`, `includedBranches`, etc. de `lib/plans.ts`
directamente para render y para **validación de downgrade en el cliente**:
```ts
// línea 700-701
if (activeStaff > target.includedStaff) {
  return `Tienes ${activeStaff} profesionales activos. El plan ${target.name} incluye solo ${target.includedStaff}. Desactiva profesionales antes de continuar.`;
}
```
Esta es una validación **solo de UI** (bloquea el botón/mensaje en el
cliente) — el backend, como se documentó en 1.5, no impone esto en
`POST /billing/change-plan` ni en `apply-scheduled-changes`.

**`orbyx-web/app/planes/comparar/page.tsx`** (473 líneas) — página de
comparación de planes, con **su propio catálogo hardcodeado, independiente
de `lib/plans.ts`** (solo importa `TRIAL_LABEL` de ahí, línea 14):
```tsx
type PlanKey = "pro" | "premium" | "vip" | "platinum";

type Plan = {
  key: PlanKey;
  name: string;
  priceLabel: string;
  ...
};

const plans: Plan[] = [ /* array local propio, no reutiliza Plan de lib/plans.ts */ ];
```
Con filas de comparación con números repetidos otra vez a mano, por
ejemplo (líneas 85-101, 165-212):
```ts
values: { pro: "1", premium: "2", vip: "3", platinum: "10" },  // sucursales
values: { pro: "2", premium: "5", vip: "10", platinum: "25" }, // staff
values: { pro: "200 / mes", premium: "1.000 / mes", vip: "2.000 / mes", platinum: "5.000 / mes" }, // emails
values: { pro: "100 msgs / mes *", premium: "200 msgs / mes", vip: "300 msgs / mes", platinum: "500 msgs / mes" }, // wa_confirmacion
values: { vip: "500 conversaciones / mes", platinum: "1.500 conversaciones / mes" }, // ia_wa
values: { pro: "10 personas", premium: "25 personas", vip: "50 personas", platinum: "100 personas" }, // group_capacity
```
Fila de servicios (línea 105-111) sí dice explícitamente `"Los servicios
son ilimitados en todos los planes"` — es decir, **esta página está
alineada con el backend real (999999)**, a diferencia de
`services/page.tsx` del dashboard (2.3), que bloquea en 10/25/50/100.

**`orbyx-web/app/admin/planes/page.tsx`** — panel admin (interno, no
público), consume el backend real:
```tsx
authFetch('/admin/plans'),
authFetch(`/admin/plans/${plan.plan_slug}`, { ... })
```
Este es el único lugar del frontend que lee/escribe directamente
`plan_config` sin ningún valor hardcodeado intermedio.

### 3.3 Onboarding

`orbyx-web/app/onboarding/page.tsx` (872 líneas): **no tiene ningún paso que
liste o seleccione plan**. Única mención relacionada, un texto genérico de
ayuda (línea 549): `"Agrega tu primer profesional. Después podrás agregar
más según tu plan."` — no hay lógica de plan, límites, ni selección aquí.

---

## 4. FLOW.CL

No existe un archivo dedicado tipo `flow.js`/`flow.ts` — **toda la
integración vive dentro de `server.js`** (confirmado: no se encontró ningún
archivo `flow.*` fuera de `node_modules` en `orbyx-web/`, y ninguno en la
raíz del repo backend salvo el propio `server.js`).

- **Función base de llamadas**: `flowApiRequest(endpoint, params, method)`
  (server.js:2389-2415) — firma HMAC-SHA256 (`signFlowParams`, no transcrita
  en este barrido) sobre `FLOW_SANDBOX_API_KEY`/`FLOW_SANDBOX_SECRET_KEY`,
  contra `FLOW_API_URL` (env vars). Nota: los nombres de las env vars dicen
  literalmente `SANDBOX` (`FLOW_SANDBOX_API_KEY`, `FLOW_SANDBOX_SECRET_KEY`)
  — no se verificó en este barrido si en producción apuntan igual a
  sandbox.flow.cl o a las credenciales de producción de Flow bajo el mismo
  nombre de variable; queda como punto a confirmar en una sesión futura, no
  se asume nada aquí.
- **`planId` de Flow**: no lo genera Flow, lo define el comercio
  (Orbyx) de forma determinística:
  ```js
  // server.js:2466
  const flowPlanId = `orbyx_${plan_id}_${periodicidad}`;
  ```
  Cacheado en la tabla `flow_plans` (`plan_id, periodicidad → flow_plan_id`,
  `onConflict: "plan_id,periodicidad"`, server.js:2486-2491) para no
  recrearlo — `getOrCreateFlowPlan` (server.js:2450-2495) es idempotente:
  primero busca en `flow_plans`, si no existe llama `/plans/create`, y si
  Flow responde "ya existe" (regex `/there is a plan|plan.*(already|exist)/i`,
  línea 2480) hace fallback a `/plans/get`.
- **Recurrencia nativa**: los "planes" de Flow (`/plans/create`) sí tienen
  intervalo real:
  ```js
  // server.js:2441-2445
  const PERIODICIDAD_TO_FLOW_INTERVAL = {
    mensual: { interval: 3, interval_count: 1 },
    semestral: { interval: 3, interval_count: 6 },
    anual: { interval: 4, interval_count: 1 },
  };
  ```
  Comentario explícito en el código (server.js:2438-2440): Flow no tiene
  "semestral" nativo, se modela como mensual (`interval: 3`) con
  `interval_count: 6`.
- Las **suscripciones de tenant** (`subscription/create`,
  `subscription/changePlan`, `subscription/cancel`) sí son objetos de
  suscripción reales de Flow — cobro recurrente gestionado por Flow, con
  `urlCallback: "https://orbyx-backend.onrender.com/billing/flow/webhook"`
  fijado en la creación del plan (server.js:2477).
- Los **add-ons NO tienen equivalente de "Flow Plan"** — como se documentó
  en 1.3, se cobran siempre con `/customer/charge` (cargo puntual), nunca
  con `/subscription/create`. No existe ningún `flow_plan_id` para add-ons
  en el esquema (`flow_plans` solo tiene `(plan_id, periodicidad)`, ligado a
  los 4 planes base, no a `addon_key`).
- Todos los `planId`/`plan_id` de Flow observados en el código usan
  únicamente los 4 slugs actuales (`pro`, `premium`, `vip`, `platinum`) —
  no se encontró ninguna referencia a `starter`/`business` como `plan_id`
  real de negocio (el alias `starter→pro` de 1.6 ocurre *antes* de llegar a
  cualquier llamada a Flow, vía `normalizePlanSlug`).

---

## Duplicaciones detectadas

Lista exhaustiva de lugares donde el mismo límite, precio, o mapeo de
nombre-de-plan está definido más de una vez, con la fuente de verdad real
(cuando existe) marcada en **negrita**:

### A. Límites numéricos por plan (staff, sucursales, servicios, wa_confirmacion, ia_wa, campanas_wa, emails, group_capacity)

1. **`plan_config`** (tabla Supabase) — fuente de verdad real, editable vía
   `/admin/plans`.
2. `DEFAULT_PLAN_CAPS` — `server.js:97-138` — fallback hardcodeado del
   backend, usado solo si `plan_config` no cargó (arranque, error puntual).
3. `orbyx-web/lib/plans.ts:53-205` — catálogo hardcodeado completo del
   frontend (`includedStaff`, `includedBranches`, `includedServices`,
   `includedWaConfirmacion`, `includedIaWa`, `includedEmailCampaigns`,
   `includedGroupCapacity`, precios) — **no se sincroniza con
   `plan_config`**; si un admin cambia un límite desde `/admin/plans`, este
   archivo no se entera y sigue mostrando/comparando con el valor viejo.
4. `orbyx-web/app/planes/comparar/page.tsx:85-212` — tercera copia
   hardcodeada, independiente de `lib/plans.ts`, con los mismos números
   (staff, sucursales, emails, wa_confirmacion, ia_wa, group_capacity)
   escritos a mano en `values: {...}`.
5. `orbyx-web/app/dashboard/[slug]/services/page.tsx:414-422` — cuarta
   copia, **solo de `max_services`**, y **divergente del valor real**: usa
   `10/25/50/100` mientras `plan_config`/`DEFAULT_PLAN_CAPS` usan `999999`
   para los 4 planes. Es la única divergencia de valor confirmada (no solo
   duplicación de código, sino de dato real vs. dato mostrado/enforced).

   `PLAN_LIMITS` (server.js:62-67, imágenes de campaña) es un caso aparte:
   no duplica los mismos campos que los anteriores, pero es una **quinta
   tabla de límites por plan independiente**, sin ningún archivo hermano en
   el frontend que la refleje (no se encontró un límite de "cantidad de
   imágenes" mostrado en el dashboard en este barrido) — riesgo de que el
   frontend no muestre ese límite en absoluto, o de que si existe esté en
   un archivo no cubierto por este barrido.

### B. Nombre/label de plan (`pro`→"Pro", etc.)

1. `server.js` no tiene una tabla de labels de UI (son strings de negocio,
   no de presentación) — los labels solo existen en frontend.
2. `orbyx-web/app/dashboard/[slug]/branches/page.tsx:81-86` —
   `PLAN_LABELS`, incluye `starter: "Starter"`.
3. `orbyx-web/app/dashboard/[slug]/page.tsx:36-42` — `PLAN_LABELS`, incluye
   `starter: "Pro"` — **valor distinto para la misma clave `starter`** vs.
   el archivo anterior.
4. `orbyx-web/app/dashboard/[slug]/layout.tsx:298-305` — ternario inline
   equivalente, sin incluir `starter` como caso propio (cae al `else` final
   → `"Pro"`).
5. `orbyx-web/lib/plans.ts:56,95,131,168` — `name: "Pro"/"Premium"/"VIP"/
   "Platinum"` dentro del objeto `Plan`, sin entrada para `starter`.
6. `orbyx-web/app/planes/comparar/page.tsx` — nombres otra vez en su
   array `plans` local (línea ~40 en adelante).

### C. Normalización de plan (`normalizePlan`/`normalizePlanSlug`, alias `starter→pro`)

1. `server.js:69-76` — `normalizePlan`.
2. `server.js:244-249` — `normalizePlanSlug` (función distinta, mismo
   propósito).
3. `orbyx-web/app/dashboard/[slug]/staff/page.tsx:276-277` —
   `normalizePlanSlug` local.
4. `orbyx-web/app/dashboard/[slug]/branches/page.tsx:183-189` —
   `normalizePlanSlug` local (distinta de la de `staff/page.tsx`: esta usa
   `"starter"` como default de entrada en vez de `"pro"`, línea 184).
5. `orbyx-web/app/dashboard/[slug]/campaigns/page.tsx` — `normalizePlan`
   propio (uso confirmado línea 1691; definición no transcrita en este
   barrido).
6. `orbyx-web/app/dashboard/[slug]/page.tsx:52` — `normalizePlan` propio
   (mencionado, ver `PlanSlug` type en la misma zona).

### D. Orden/jerarquía de plan (`PLAN_ORDER`, para saber qué es upgrade/downgrade)

1. `server.js:195-200` — `PLAN_ORDER`, fuente de `getPlanLevel`.
2. `orbyx-web/app/dashboard/[slug]/page.tsx:44-49` — `PLAN_ORDER` local,
   mismos valores (1/2/3/4).

### E. Precio por plan (`PLAN_PRICES`)

1. `server.js:188-193` — `PLAN_PRICES`, usado para calcular montos de cobro
   real vía Flow.
2. `orbyx-web/lib/plans.ts` — `price: 12990/29990/54990/149990` dentro de
   cada objeto `Plan` (líneas 57, 96, 132, 169) — mismos valores, copiados a
   mano.
3. `orbyx-web/app/planes/comparar/page.tsx` — `priceLabel` en su array
   local de planes (no confirmado si son los mismos montos exactos o solo
   labels de texto — pendiente de revisar en detalle en sesión futura).

### F. Validación de downgrade contra recursos activos (staff/branches)

1. **Backend**: no valida nada al aplicar el downgrade (`POST
   /billing/change-plan` para el registro del cambio,
   `POST /billing/apply-scheduled-changes` para la aplicación real) — solo
   `cancelUnsupportedAddons` (server.js:548-586) actúa, y **solo sobre
   add-ons**, nunca sobre staff/branches.
2. **Frontend, capa 1**: `staff/page.tsx` (líneas 517-570) y
   `branches/page.tsx` (líneas 695-709) calculan el exceso post-downgrade
   usando el límite real (`GET /billing/addons`) y fuerzan al usuario a
   elegir manualmente cuáles desactivar — pero esto corre en el dashboard
   normal, no está atado al momento del cambio de plan en sí.
3. **Frontend, capa 2**: `orbyx-web/app/planes/page.tsx:700-701` bloquea el
   botón de cambio de plan en el selector de planes mismo, comparando
   `activeStaff` contra `target.includedStaff` — pero `includedStaff` viene
   del catálogo hardcodeado `lib/plans.ts` (Duplicación A.3), no de
   `plan_config` en vivo, así que si un admin cambia `staff_limit` desde
   `/admin/plans`, este mensaje de validación puede quedar desalineado con
   el límite real del backend.

---

## Resumen de lo NO tocado (según instrucción explícita de la tarea)

Se detectaron, pero no se profundizó ni se citó en detalle, referencias a:
`resolveBranchId`, `getEffectiveBusinessAvailability`,
`getEffectiveStaffAvailability`, `applySpecialDatesToWindows`,
`subtractAppointmentsFromWindows`, `buildSlotsFromWindows`,
`filterSlotsForServiceDuration`, `filterPastSlots`, lógica de
`orbyx-web/app/[slug]/page.tsx`, `orbyx-web/app/dashboard/[slug]/agenda/
page.tsx`, y el patrón `branch_id`/`orbyx_active_branch_${slug}`/
`orbyx-branch-changed` — todos aparecieron incidentalmente en algunos greps
(por ejemplo, `resolveBranchId` dentro de `POST /staff` y `POST /services`,
que sí se citaron por su parte de gating) pero no se analizó su lógica de
disponibilidad ni de multi-sucursal, tal como se indicó.
