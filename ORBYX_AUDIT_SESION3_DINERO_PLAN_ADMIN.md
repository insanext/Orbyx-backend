# Auditoría de producción — Sesión 3 de 3: dinero, plan y panel Super Admin

Fecha: 2026-09-30 · Alcance: trial, cambio de plan, add-ons (con tarjeta y pago único), Flow (suscripción, webhooks, reintentos), checkout/IVA, panel Super Admin y facturación.
**Solo auditoría: no se modificó ningún archivo de código.**

Método:
- Lectura y trazado del código real: `server.js` (Flow, billing, add-ons, signup pagado, crons, admin), `orbyx-web/middleware.ts`, `app/dashboard/[slug]/billing/page.tsx`, `app/dashboard/[slug]/layout.tsx`, `app/planes/page.tsx`, `app/checkout-premium/page.tsx`, `components/addons/AddonManager.tsx`, `app/terminos/page.tsx` y `email.js`.
- **Consultas de solo lectura** a Supabase prod: `plan_config`, `addon_config`, `subscriptions`, `tenants`, `tenant_addons`, `addon_purchase_intents`, `signup_intents`, `flow_plans` y `admin_tenant_actions`.
- **Consultas GET de solo lectura a Flow sandbox**: `subscription/get`, `subscription/list`, `plans/get` y `customer/get`. No se hizo ningún cobro, alta, cambio ni cancelación en Flow.
- Todo lo que requiere efectos reales quedó en la tabla de **pruebas pendientes**.

Los reportes previos que mencionaba la instrucción (`ORBYX_CHECKOUT_IVA_ADDONS_FIX_REPORTE.md`, `ORBYX_ADDONS_*`) **no existen** en el repo ni en el equipo. La lógica de IVA y add-ons se verificó directo contra el código y los datos (ver "Bugs previos: siguen cerrados").

Severidad: **Crítico** = pérdida o cobro indebido de dinero, o acceso pagado sin pagar · **Importante** = problema real para el cliente, legal o de ingresos · **Menor** = detalle, copy o caso raro.

---

## CRÍTICOS

### C1. `POST /billing/flow/subscribe` confía en el plan y el monto que manda el navegador
- **Dónde:** `server.js:15501` lee `plan_id`, `periodicidad` y `monto` del body y los usa tal cual:
  - `getOrCreateFlowPlan(plan_id, periodicidad, monto)` en `:15548` crea en Flow un plan con **ese** monto.
  - `:15579-15585` guarda `subscriptions.plan_id` y `monto`.
  - Después, el webhook fija `tenants.plan_slug = subscriptions.plan_id` (`:15449`).
  - El frontend calcula el monto en el navegador (`billing/page.tsx:782-784`, `:798-803`).
- **Impacto:** cualquier dueño con sesión puede llamar la API con `{plan_id:"premium", monto: 1000}`. Queda suscrito a Premium pagando lo que eligió, y el primer pago confirmado le activa Premium.
  - Es el mismo tipo de bug que se corrigió en `/signup/start-paid` (commit `12eb0ae`, `computePlanNetAmount`), pero este endpoint quedó fuera.
- **Cómo lo confirmé:** trazado de código. Prueba pendiente E8 en sandbox.
- **¿Decisión previa?** No. Bug de seguridad/fraude.

### C2. Cualquier tenant puede "bajar" a un plan legacy (`platinum`, `vip`, `pro`) y quedarse con sus límites pagando precio Starter
- **Dónde:**
  - `normalizePlanSlug` deja pasar los slugs legacy (`server.js:263-268`).
  - `getPlanLevel` les da nivel 1 (`:1492-1494`), así que `isUpgradePlanChange("starter","platinum")` es falso y `POST /billing/change-plan` lo trata como **downgrade** (`:13313-13352`).
  - El chequeo de exceso usa los límites de `platinum` y no bloquea.
  - Al llegar la fecha, `applyScheduledPlanChanges` escribe `plan_slug = "platinum"` (`:14947`).
  - La sincronización con Flow cobra `getPlanCyclePrice("platinum")`, que cae a `PLAN_PRICES.starter` = $14.990 (`:270-277`, `:14984-14990`).
- **Límites legacy que siguen vivos en `plan_config`** (consulta de hoy):
  - `platinum`: 25 profesionales, 10 sucursales, capacidad grupal 100, 5.000 emails.
  - `vip`: 10 profesionales, 3 sucursales, capacidad grupal 50.
  - Hoy **ningún tenant real usa esos planes** (los 3 tenants legacy ya no existen), pero sus filas se siguen leyendo.
- **Impacto:** un Starter (o un Business) consigue límites de Premium o superiores al precio de Starter con una sola llamada a la API.
- **Cómo lo confirmé:** trazado de código y datos reales de `plan_config`. Prueba pendiente E7.
- **¿Decisión previa?** Mantener las filas legacy fue a propósito (memoria de la migración a 3 planes). Que se puedan **elegir como destino** no lo es.

### C3. "Cambiar tarjeta" con una suscripción activa crea una **segunda suscripción** en Flow (doble cobro mensual)
- **Dónde:**
  - El botón "Cambiar tarjeta" se muestra también con suscripción `active`/`trialing` (`billing/page.tsx:1565-1588`).
  - Llama a `register-card` y, a la vuelta, `POST /billing/flow/register-card-callback` **sobrescribe** el estado a `card_registered` sin mirar el anterior (`server.js:15315-15321`).
  - La página de facturación tiene un efecto que, al ver `card_status=ok` y `card_registered`, llama solo a `activateSubscription()` (`billing/page.tsx:929-937`).
  - Eso ejecuta `subscription/create` en Flow (`server.js:15550`). La suscripción anterior **nunca se cancela** y su ID queda pisado en la base.
- **Impacto:**
  - Dos suscripciones cobrando cada mes. La antigua queda invisible para Orbyx: no está en la base y no se puede cancelar desde el panel.
  - Si el cambio de tarjeta falla o se cancela en Flow, el estado pasa a `error` (`:15318`). Un tenant que venía de trial queda **bloqueado de inmediato** aunque su suscripción en Flow siga pagando bien (ver I6).
- **Cómo lo confirmé:** trazado de código. Prueba pendiente E1.
- **¿Decisión previa?** No.

### C4. Borrar un tenant no cancela su suscripción en Flow: ya hay 6 suscripciones "huérfanas" activas en sandbox
- **Dónde:** `DELETE /admin/tenants/:id` (`server.js:21800-21935`) borra Storage, llama `delete_tenant_cascade` (que borra `subscriptions` y con eso el `flow_subscription_id`) y el usuario de Auth. No hay ninguna llamada a Flow `subscription/cancel` ni `customer/unRegister`.
- **Evidencia (Flow sandbox, solo lectura):** 8 suscripciones activas en los planes de Orbyx. Solo 2 existen en la tabla `subscriptions`. Las otras 6 siguen cobrando cada mes sin dueño en la base:

  | Suscripción | Plan | Creada |
  |---|---|---|
  | `sus_ef1b74bce9` | premium_v2 | 2026-07-21 |
  | `sus_df46a22f89` | business | 2026-09-04 |
  | `sus_vfddc02463` | business | 2026-09-04 |
  | `sus_m18c8c337b` | business | 2026-09-05 |
  | `sus_lbe9898010` | premium | 2026-09-05 |
  | `sus_j8e08b0981` | starter | 2026-09-20, $17.838 |

  - `sus_j8e08b0981` pertenece a un tenant (`ccdece95-…`) que ya no existe, y **no tiene registro en `admin_tenant_deletions`**: se borró por otra vía.
- **Impacto:** en producción, a un negocio borrado se le seguiría cobrando la tarjeta todos los meses y Orbyx no tendría cómo verlo ni cancelarlo desde el panel.
- **Acción independiente del fix:** antes de pasar a producción conviene cancelar estas 6 en sandbox (es una acción con efecto, la debe autorizar Camilo).
- **¿Decisión previa?** No.

### C5. Cancelar el plan, pausar al tenant o quedar bloqueado **no detiene los cobros de add-ons**
- **Dónde:** `chargeRecurringAddons` (`server.js:16528-16569`) cobra toda fila `active` + `automatico` con 30 días desde el último cobro. Solo exige que exista `flow_customer_id`:
  - no mira si la suscripción del plan está `canceled`/`error`;
  - no mira si el tenant está pausado, bloqueado o inactivo.
  - `POST /billing/flow/cancel-subscription` (`:15668-15705`) y `POST /admin/tenants/:id/pause` (`:21683-21729`) no tocan `tenant_addons`.
- **Impacto:** un cliente que canceló (y que después de su ciclo ya no puede entrar al dashboard) sigue pagando cada mes sus add-ons (+1 profesional, packs, etc.). Lo mismo pasa con un tenant pausado por Orbyx.
  - Además los Términos (8.1) dicen que la cancelación termina el servicio al fin del ciclo.
- **Cómo lo confirmé:** trazado de código. Prueba pendiente E10.
- **¿Decisión previa?** Los add-ons se facturan "con independencia del ciclo del Plan base" (Términos 6.2), pero eso no cubre seguir cobrando a una cuenta cancelada o pausada.

### C6. El estado de pago depende 100 % del webhook de Flow, no hay evidencia de que haya funcionado nunca y no existe reconciliación
- **Dónde:** `POST /billing/flow/webhook` (`server.js:15356-15491`) es el **único** lugar que:
  - pasa `subscriptions.status` a `active` o `error`;
  - extiende `billing_cycle_end`.
  - Ningún cron consulta a Flow el estado real (`subscription/get`, `invoice/get`).
- **Evidencia (solo lectura):**
  - Los 2 únicos signups pagados reales (`sower`, business, 2026-09-06; `red-salud`, premium, 2026-09-15) tienen en Flow su primera factura **pagada** (status 1).
  - Pero en la base su fila de `subscriptions` tiene `updated_at == created_at` y `billing_cycle_end` sigue exactamente en la fecha del alta + 1 mes.
  - Es decir, el webhook de ese primer cobro nunca se procesó.
- **Por qué pasa o puede pasar:**
  1. **Carrera en el signup pagado:** `subscription/create` cobra en el mismo request (`:16206`) y el tenant y su fila `subscriptions` se crean *después* (`:16260` → `:16020`). Si Flow notifica antes, el webhook no encuentra la suscripción, devuelve 200 y el aviso se pierde para siempre (`:15386-15389`).
  2. El webhook busca por `payment.customerId || payment.customer?.customerId` (`:15372`). No está confirmado que `payment/getStatus` devuelva el `customerId` en los cobros de suscripción. Si no lo devuelve, **ningún** cobro recurrente se procesaría nunca (prueba pendiente E3).
  3. Siempre responde 200, incluso si falla al escribir en Supabase (`:15485-15489`). Flow no reintenta y el evento se pierde.
  4. No está confirmado que Flow notifique los cobros **fallidos** (el plan tiene `charges_retries_number: 3`). Si no lo hace, un tenant con tarjeta rechazada queda `active` para siempre: `blocked` exige `!hasActiveSubscription`.
  5. Un pago en estado 1 (pendiente) se marca como `error` (`:15371`, `:15466-15470`).
- **Impacto en producción, en los dos sentidos:**
  - tenants que dejan de pagar y conservan acceso indefinidamente;
  - o pagos que no se registran (ciclo congelado, "próxima facturación" equivocada).
- **¿Decisión previa?** No. El script `scripts/reconcile-katherine-barberia-invoice-1174923.js` muestra que esto ya pasó una vez (julio) y se resolvió a mano.

---

## IMPORTANTES

### Flow / suscripción

**I1. Los cobros con tarjeta no revisan si Flow aprobó el pago.**
- `/customer/charge` se llama en 5 lugares y en ninguno se lee el `status` de la respuesta:
  - activar add-on (`server.js:13783`);
  - subir cantidad (`:14442`);
  - renovación mensual (`:16564`);
  - recarga por saldo bajo (`:16696`);
  - add-ons del signup (`:16058`).
- Solo se considera fallo si la llamada lanza una excepción. Si Flow responde 200 con el pago rechazado (3) o pendiente (1), el add-on se activa, se suma saldo o se registra la renovación igual.
- A confirmar con E2. Si se confirma, sube a **crítico**.

**I2. Doble registro de tarjeta en el signup pagado, o doble clic en "Activar suscripción": dos suscripciones en Flow.**
- `register-card-callback` del signup revisa `intent.status === "started"` y después llama `subscription/create` **sin reclamo atómico** (`server.js:16184-16233`), aunque `claimSignupIntentStatus` existe (`:15968`).
- Un doble POST (refresh, botón atrás) crea dos suscripciones.
- `POST /billing/flow/subscribe` tiene el mismo problema con dos pestañas (`:15509-15554`).
- En add-ons, `POST /billing/addons/activate` cobra **antes** de escribir. Con dos requests simultáneos, el segundo insert choca con el índice único `tenant_addons_unique_active` y responde 500 **después de haber cobrado**: doble cobro, una sola unidad.

**I3. El ciclo de facturación (`billing_cycle_end`) se ancla mal.**
- El webhook extiende siempre desde el `billing_cycle_end` anterior (`server.js:15432-15453`), no desde la fecha real del cobro. Casos:
  - Tenant que paga días o semanas después de vencer su trial: el nuevo ciclo queda en el pasado o desfasado respecto de Flow.
  - Trial extendido desde el admin: `PATCH /admin/tenants/:id/trial-end` (`:21649-21652`) no mueve `billing_cycle_end`, con el mismo efecto.
  - Webhook duplicado: suma otro mes cada vez (no hay idempotencia por token o `flowOrder`).
  - Si el webhook del primer cobro de un signup pagado llega después de crear la fila, el ciclo queda +2 meses (el alta ya fijó +1).
- **Consecuencias:**
  - "Próxima facturación" equivocada.
  - Un downgrade se programa para `billingEnd` (`:13348`); si esa fecha ya pasó, el cron lo aplica **dentro de la hora**, no al fin del ciclo real.

**I4. El downgrade programado se aplica *después* de que Flow ya cobró el plan antiguo, y puede revertirse solo.**
- **Dato real (`sower`):**
  - En Flow: `period_end 2026-10-05`, `next_invoice_date 2026-10-06 00:00` (hora Chile).
  - En la base: `billing_cycle_end 2026-10-06T05:46Z`.
  - Flow cobra la renovación con el plan antiguo ~3 h antes de que el cron horario (`:22087`) aplique el cambio. Después, `subscription/changePlan` aplica un prorrateo cuyo efecto real no está verificado (E5).
- **Además:** si la sincronización con Flow falla (se registra en el log y se sigue, `:15006-15011`), `subscriptions.plan_id` queda con el plan antiguo. El siguiente webhook exitoso **vuelve** a poner ese plan en `tenants.plan_slug` (`:15449`): el downgrade se deshace en silencio, pero los profesionales y sucursales no elegidos ya se desactivaron.

**I5. Signup Starter + add-ons: la tarjeta registrada se "pierde" y los add-ons nunca se renuevan.**
- En ese flujo no se inserta fila en `subscriptions` (`server.js:16018`), así que el `flow_customer_id` solo queda en `signup_intents`. Consecuencias:
  - `chargeRecurringAddons` salta esos add-ons "automáticos" para siempre (`:16554-16559`, sin contar fallos): capacidad y packs gratis desde el mes 2.
  - `getTenantPaymentMethod` (`:545-561`) dice que el tenant **no tiene tarjeta**. Para pagar tendrá que registrarla de nuevo, lo que crea otro customer en Flow.
- Hoy no hay tenants en este caso (la consulta no mostró intents Starter completados), pero el flujo está habilitado.

### Trial y bloqueo

**I6. Cancelar la suscripción (o un pago fallido) bloquea de inmediato a quien vino de trial, contra lo que promete la pantalla y los Términos.**
- El modal de cancelar dice "Podrás seguir usando tu plan hasta el final del ciclo actual" (`billing/page.tsx:1979`) y los Términos 8.1 dicen lo mismo.
- Pero `trialExpired = awaitingPayment && trial_ends_at <= ahora` (`server.js:13583-13585`, `middleware.ts:137-146`). Para un Starter que vino de trial, `trial_ends_at` ya pasó: al quedar la suscripción `canceled` o `error`, `blocked` es verdadero **en el acto**, con motivo `trial_expired` (etiqueta equivocada, `:13677`).
- Solo los tenants de signup pagado (`trial_ends_at` nulo) conservan acceso hasta `billing_cycle_end`.

**I7. Pago fallido: bloqueo sin aviso ni plazo de gracia.**
- Cuando el webhook marca `error` no se envía ningún correo, y el dashboard queda bloqueado en cuanto pasa `billing_cycle_end`, que es justo el día del cobro. En la práctica el bloqueo es inmediato (y aún más rápido con I6).
- Los Términos 6.5 prometen "previa notificación… y un plazo razonable para regularizar".
- La gracia de 7 días (Sesión 1) aplica solo a la página pública de reservas.

**I8. El aviso de trial no desaparece al inscribir la tarjeta durante el trial.**
- `trialActive` no excluye el estado `trialing` (`server.js:13583`; el comentario de `layout.tsx:420-426` asume que sí). Un tenant que ya inscribió tarjeta sigue viendo:
  - el banner "quedan X días" (≤5 días);
  - la píldora "Trial: N días";
  - el texto "Inscribe una tarjeta cuando quieras para no perder acceso" (`AccountStatusWidget.tsx:720-722`).
- El correo diario sí excluye `trialing` (`:19592`), así que las señales se contradicen.

**I9. El backend no aplica el bloqueo por falta de pago.**
- El bloqueo vive solo en `middleware.ts` y `layout.tsx`. Ningún endpoint del backend revisa `blocked` (`paused_at` solo se mira en la página pública y en los recordatorios).
- Un tenant vencido o pausado puede seguir usando la API directo: reservas manuales, envío de campañas con saldo, edición de servicios, etc.

### Add-ons

**I10. Un add-on en modo "manual" no vence nunca, y hay varios caminos para llegar ahí.**
- Es el bug conocido y "documentado aparte". Se confirma que **sigue abierto y ya hay un caso real**: el tenant `unreal-tournament` tiene "+1 Profesional" en `manual`, pagado una vez ($4.990) el 2026-09-29, sin vencimiento.
- Caminos:
  - `activate` inserta en `manual` (`server.js:13825`). Si la llamada encadenada a `renewal-mode` falla (`AddonManager.tsx:1148-1188`, solo muestra un aviso), queda así para siempre.
  - 3 renovaciones fallidas pasan el add-on a `manual` (`:16611-16613`): capacidad gratis indefinida.
  - Cancelar el plan, **eliminar la tarjeta** (permitido si el estado es `canceled`, `:15260`) y esperar 3 fallos lleva al mismo resultado.

**I11. Los recursos que superan el límite quedan activos al vencer o cancelar un add-on de capacidad, o al bajar la capacidad grupal.**
- `expireOneTimeAddons` (`server.js:14250-14264`), `POST /billing/addons/cancel` y `quantity=0` solo marcan el add-on como `canceled`. Nada desactiva profesionales o sucursales extra.
- La capacidad de un servicio grupal solo se valida **al configurarlo**, nunca al reservar (`:17925-17934`), y el chequeo de downgrade no mira capacidad grupal (`:744-790`).
- **Ejemplo:** pago único de "+1 Profesional" ($4.990), crear el profesional y dejar vencer el add-on → queda con 3 profesionales en Starter para siempre. Lo mismo con sucursal ($9.990) o con subir un servicio a 30 cupos.
- Pregunta de producto P4.

**I12. La recarga automática por saldo bajo sube para siempre el cobro mensual.**
- `triggerLowBalanceRecharge` hace `quantity: currentQty + 1` (`server.js:16706`), y `quantity` es lo que cobra la renovación mensual (`:16562`).
- Cada recarga automática aumenta en un pack la renovación de todos los meses siguientes, sin un consentimiento aparte para ese nuevo monto recurrente.

**I13. Pago único: intenciones sin reconciliar, y un crédito del admin bloquea la compra.**
- **Sin reconciliación:** no hay proceso que revise intents `pending` o `processing`.
  - Si `grantOneTimeAddonItems` lanza a mitad de camino, la intención queda en `processing` para siempre con el pago hecho (`:14149-14182`).
  - Hoy hay 3 intents `pending` del 2026-09-28 sin cerrar (probablemente checkouts abandonados, no se sabe).
- **Crédito del admin:** crea la fila en `manual` (`:21553-21562`). Si después el tenant quiere comprar un pack por pago único, `checkout` responde 409 "ya tiene cobro con tarjeta" (`:13926-13932`), mensaje falso.
  - Un tenant en trial (sin tarjeta) con un crédito de compensación **no puede comprar** ese pack por ningún camino.

### Legal / copy

**I14. Los Términos publicados no coinciden con lo que se cobra.**
- `app/terminos/page.tsx:150-166` y el correo de aceptación (`email.js:788-803`) dicen:
  - planes Pro/Premium/VIP/Platinum a $12.990 / $29.990 / $54.990 / $149.990 que "**incluyen los impuestos**";
  - add-ons "**no acumulables**… se reinician cada mes".
- La realidad: Starter/Business/Premium a $14.990 / $29.990 / $54.990 **+ IVA** (Flow cobra $17.838 / $35.688 / $65.438, verificado en `plans/get`), saldo de add-ons acumulable y pago único.
- Un cliente cobra 19 % más de lo que dice el contrato que aceptó.
- También prometen "informar con anticipación la fecha y el monto de cada renovación" (6.4): no existe ese correo.

### Panel Super Admin

**I15. Editar precios en `/admin/planes` no cambia lo que se cobra.**
- `price_monthly`, `price_semestral_discount_pct` y `price_annual_discount_pct` se guardan en `plan_config` (`server.js:20612-20654`), pero **ningún cobro los lee**: el backend usa `PLAN_PRICES` y `BILLING_CYCLES` fijos en el código (`:180-200`, `:229-234`), y el frontend `lib/plans.ts`.
- Los campos `promo_*` de add-ons tampoco están conectados (ya anotado en memoria).
- Los cambios de configuración global (planes y add-ons) **no quedan en ningún log de auditoría**.

**I16. El borrado de tenant puede fallar a medias y borra evidencia legal.**
- Storage se borra **antes** de la transacción de base de datos (`server.js:21832-21850`).
- La función `delete_tenant_cascade` del repo (`2026-08-30-admin-tenant-deletion.sql`) es anterior a `reviews` y `review_request_tokens` (FK a `tenants` **sin** `on delete cascade`, `2026-09-12-reviews.sql:12`). Si en prod no se actualizó, borrar un tenant con reseñas falla después de haber borrado sus archivos. Ver R1.
- Además borra `legal_acceptances` y `addon_auto_charge_consents` (`2026-08-30-admin-tenant-deletion.sql:185-202`), que son la prueba del consentimiento del cliente. Los Términos (14) hablan de conservar datos 12 meses y la documentación tributaria por plazo legal.

**I17. El correo "prueba vencida" se envía todos los días, para siempre.**
- `sendTrialEndingReminders` toma todo tenant con `trial_ends_at <= ahora+3d`, sin límite inferior (`server.js:19546-19552`). Un trial abandonado recibe un correo diario indefinidamente, con riesgo de spam y de reputación del dominio en Resend.

---

## MENORES

- **M1. Renovar antes de tiempo pierde días.** Renovar por pago único un add-on de capacidad antes de que venza cobra la cantidad completa y fija `expires_at = pago + 30 días` (`server.js:14039-14041`, `:14076`), sin sumar los días que quedaban.
- **M2. Mensaje engañoso en upgrade con suscripción cancelada.** El upgrade con suscripción `canceled` (que aún tiene `flow_subscription_id`) falla en Flow y muestra "No se pudo cobrar… verifica tu tarjeta" (`:13232-13240`).
- **M3. No hay forma de cancelar un downgrade programado.** Elegir el plan actual responde 400 "ya está en ese plan" (`:13192-13196`), y lo no elegido se desactivará igual ese día.
- **M4. El "Total mensual" de `/planes` no es lo que se cobra.** En el dashboard, en un upgrade, suma el prorrateo de hoy más los add-ons ya activos con su IVA (`planes/page.tsx:459-462`, `:1000`), pero `change-plan` solo cobra el prorrateo.
- **M5. Posible diferencia de $1 en checkout-premium.** Muestra `applyIva(plan + add-ons)` (`checkout-premium/page.tsx:229`); el backend cobra `applyIva(plan)` en Flow y `applyIva(add-ons)` aparte (`server.js:3553`, `:16060`).
- **M6. Falla sobre 1.000 usuarios.** `auth.admin.listUsers({ perPage: 1000 })` en `claim-account` (`:16431`) y en los recordatorios de trial (`:19581`) deja de encontrar usuarios pasadas las 1.000 cuentas.
- **M7. Contraseña ignorada en silencio.** En `claim-account`, si el email ya tiene cuenta con contraseña, la contraseña escrita se ignora sin avisar (`:16455-16467`).
- **M8. Log de diagnóstico olvidado.** `[gating-debug]` sigue logueando en cada request del dashboard (`middleware.ts:153-180`).
- **M9. Comentario y código no coinciden en el trial.** Durante el trial, `getPlanCapabilities` pone en 0 solo WhatsApp (`:172-175`); los comentarios (`:108-111`, `:1056-1062`) dicen que también campañas. Hay que confirmar la intención (ver P7).
- **M10. Dominio distinto en los callbacks de tarjeta.** Redirigen a `https://orbyx.cl` (`:15288`, `:16141`) mientras el resto usa `https://www.orbyx.cl`.
- **M11. Estadísticas admin poco fiables.** El MRR no incluye add-ons (documentado) y cuenta como "activo" según la base, que puede estar desactualizada (C6).
- **M12. Consentimiento de cobro recurrente pendiente.** Sigue abierto el pendiente ya conocido: `texto_autorizacion_version: "v1"` fijo y sin UI de consentimiento antes de suscribirse desde el dashboard (`billing/page.tsx:837-841`).

---

## Panel Super Admin: acceso y auditoría (lo que está bien)

- **Acceso controlado en el backend:** todas las rutas `/admin/*` usan `requireAdminAuth` (`server.js:20387-20416`): token válido de Supabase, fila activa en `admin_users` y sesión `aal2` (MFA).
  - La excepción es `/admin/access-check`, que solo informa si la cuenta es admin, no da acceso.
  - No hay rutas admin en las API routes de Next.
  - El layout del frontend es solo una capa adicional.
- **Acciones sobre tenants auditadas en `admin_tenant_actions`:** nota, ver como tenant, reenvío de bienvenida, reset de contraseña, crédito, trial, pausa, reactivación y borrado (este último también en `admin_tenant_deletions`).
  - El cambio de contraseña del admin va a `security_audit`.
  - Hay registros reales recientes (4 `trial_end_updated` el 2026-09-29).
  - Falta auditar los cambios de configuración de planes y add-ons (I15).
- **Herramienta de trial:** guarda fin del día en hora de Santiago, se niega si la suscripción está `active`/`trialing` y audita. Correcta. Pendiente: no mueve `billing_cycle_end` (I3).

## Facturación / boletas

- **Orbyx no emite ningún comprobante propio:** ni boleta ni factura electrónica (SII) ni recibo por correo. Solo existe el "Historial de pagos" (lista de cargos de Flow vía `customer/getCharges`) y el correo de pago que Flow manda por su cuenta.
- Como el servicio se cobra con IVA, esto requiere una decisión antes de cobrar en producción (P8).

## Bugs previos: siguen cerrados

- **IVA aplicado una sola vez**, justo antes de Flow (`applyIva`). Los montos de los planes en Flow coinciden con neto × 1,19.
- **`/signup/start-paid`** ya no confía en el monto del cliente. (Pero `/billing/flow/subscribe` sí, ver C1.)
- **Pago único:** los packs no vencen (`expires_at` nulo en datos reales), no se modifican por `PATCH quantity`, y la confirmación es idempotente (reclamo atómico y control de monto).
- **Downgrade:** los packs con saldo no se cancelan (M16 Sesión 2, en el código) y el cron horario de cambios programados existe.

---

## Pruebas pendientes

### Solo lectura (sin efectos; las puede correr Camilo o una sesión siguiente)

| # | Qué | Para qué |
|---|---|---|
| R1 | En el SQL Editor: `select pg_get_functiondef('delete_tenant_cascade'::regproc);` y las FK que apuntan a `tenants` sin `ON DELETE CASCADE` | Confirmar I16 (si borrar un tenant con reseñas falla) |
| R2 | Después del **2026-10-06** (renovación de `sower`) y del **2026-10-14** (`red-salud`): mirar `subscriptions.updated_at` y `tenants.billing_cycle_end` | Saber si el webhook recurrente funciona (C6) |
| R3 | Logs de Render: buscar `Flow webhook: pago confirmado`, `no se encontró subscription` y `POST /billing/flow/webhook error` desde septiembre | Ver si llegaron avisos y por qué se descartaron (C6) |
| R4 | `addon_purchase_intents` con `status in ('pending','processing')` más antiguos que 1 día | Dimensionar I13 |
| R5 | Flow sandbox `subscription/list` por plan (ya hecho: 6 huérfanas) | Repetir antes de pasar a producción |

### Con efectos reales (requieren autorización de Camilo; todas en **sandbox** y con tenant de prueba)

| # | Qué | Para qué |
|---|---|---|
| E1 | Con un tenant con suscripción activa en sandbox, usar "Cambiar tarjeta" y después mirar `subscription/list` del customer | Confirmar C3 (doble suscripción) |
| E2 | Activar un add-on con una tarjeta de prueba de Flow que rechace el cargo | Confirmar I1 (si se activa igual) |
| E3 | Forzar un cobro recurrente fallido y uno exitoso; registrar qué llega al webhook y si `payment/getStatus` trae `customerId` | Confirmar C6 puntos 2 y 4 |
| E4 | Doble clic o dos pestañas en: activar add-on, "Activar suscripción" y callback de tarjeta del signup | Confirmar I2 |
| E5 | Programar un downgrade y observar el cobro de Flow a las 00:00 y el efecto de `changePlan` a la hora siguiente | Confirmar I4 |
| E6 | Upgrade a mitad de ciclo: comparar el "Pagar hoy" mostrado con lo que Flow cobra de verdad y cuándo | Validar el prorrateo (y M4) |
| E7 | Con un tenant de prueba: `POST /billing/change-plan {new_plan:"platinum"}` y adelantar `scheduled_change_at` | Confirmar C2 |
| E8 | Con un tenant de prueba: `POST /billing/flow/subscribe` con `plan_id:"premium"` y un `monto` bajo | Confirmar C1 |
| E9 | Borrar desde el admin un tenant de prueba con suscripción sandbox activa | Confirmar C4 en vivo |
| E10 | Cancelar el plan de un Starter que vino de trial y tiene un add-on automático: ver el bloqueo y si el add-on se cobra al mes | Confirmar I6 y C5 |
| E11 | Pago único de "+1 Profesional", crear el profesional y forzar el vencimiento | Confirmar I11 |
| — | Cancelar las 6 suscripciones huérfanas de sandbox (C4) | Limpieza antes de producción |

## Preguntas de producto

1. **P1. Cancelación:** ¿el acceso se mantiene hasta el fin del ciclo para *todos*, incluidos los que vinieron de trial, como dicen el modal y los Términos? (I6)
2. **P2. Pago fallido:** ¿cuántos días de gracia, qué avisos (correo o banner) y cuántos reintentos antes de bloquear? (I7, Términos 6.5)
3. **P3. Add-ons tras cancelar o pausar:** ¿se cancelan junto con el plan o siguen cobrándose? (C5)
4. **P4. Exceso de límite al vencer o cancelar capacidad:** ¿desactivar lo que sobra (como en el downgrade con selección), bloquear nuevas reservas, o permitirlo? (I11)
5. **P5. Downgrade:** ¿debe poder cancelarse un downgrade programado? (M3)
6. **P6. Upgrade durante el trial:** ¿un Starter en trial que sube a Business debe tener Business gratis el resto del trial (hoy `changePlan` sobre una suscripción en trial cobra ~0)?
7. **P7. Trial Starter y campañas:** ¿durante el trial incluye los 100 emails de campaña (código) o 0 (comentarios)? (M9)
8. **P8. Boletas/facturas:** ¿Orbyx emitirá boleta o factura electrónica por cada cobro (proveedor de DTE), o se delega a algún servicio? Hay que decidirlo antes de cobrar en producción.
9. **P9. Términos:** actualizar la tabla de precios, "IVA incluido" frente a "+ IVA" y la cláusula de add-ons antes del lanzamiento. (I14)
10. **P10. Borrado de tenant:** ¿se conservan los consentimientos legales y los datos de cobro al borrar, y qué pasa con la suscripción en Flow? (C4, I16)
11. **P11. Correo de prueba vencida:** ¿hasta cuándo se envía? (I17)

## Antes de activar Flow en producción

Los `flow_customer_id` y `flow_subscription_id` actuales (`sower`, `red-salud`) son de sandbox y **no existen en producción**: sus cobros recurrentes y de add-ons fallarán, y los add-ons pasarán a `manual` tras 3 fallos (I10). Esos tenants necesitan volver a inscribir su tarjeta, o limpiar esos IDs de forma controlada.
