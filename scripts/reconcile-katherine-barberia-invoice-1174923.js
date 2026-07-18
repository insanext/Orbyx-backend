// RECONCILIACIÓN MANUAL, ÚNICA VEZ — no es el flujo real de reconciliación.
//
// Causa: el plan orbyx_premium_mensual se creó sin urlCallback (bug), así que
// Flow nunca notificó /billing/flow/webhook cuando procesó el primer cobro de
// la suscripción sus_o203afb907 (tenant katherine-barberia, 8c346c67-3abf-
// 451b-ac71-901dd6b128cc). Se confirmó manualmente contra GET /subscription/get
// que el invoice #1174923 ($29.990 CLP, período 2026-07-18/2026-08-17) ya
// quedó status=1 (pagado) del lado de Flow.
//
// Este script simula, una sola vez, lo que /billing/flow/webhook habría
// hecho en su rama de éxito (status='active' + flow_subscription_id), solo
// para dejar la fila de subscriptions consistente con la realidad en Flow.
// No reemplaza el webhook real: el fix del urlCallback (plan v2,
// orbyx_premium_mensual_v2) ya evita que esto vuelva a pasar hacia adelante.
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const SUBSCRIPTION_ROW_ID = "5ca4398e-4d74-4cf6-aad5-05d3fa51017b";
const FLOW_SUBSCRIPTION_ID = "sus_o203afb907";

(async () => {
  const { data, error } = await supabase
    .from("subscriptions")
    .update({
      status: "active",
      flow_subscription_id: FLOW_SUBSCRIPTION_ID,
      updated_at: new Date().toISOString(),
    })
    .eq("id", SUBSCRIPTION_ROW_ID)
    .select("*")
    .single();

  console.log(JSON.stringify(data, null, 2), error);
})();
