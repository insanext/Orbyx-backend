// Script de prueba manual (no forma parte del server). Ejecutar con:
//   node scripts/test-flow-sandbox.js
// Requiere .env en la raíz con SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY.
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const BACKEND_URL = "https://orbyx-backend.onrender.com";
const TENANT_SLUG = "katherine-barberia";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function fail(step, err) {
  console.error(`\n❌ FALLÓ EN: ${step}`);
  console.error(err);
  process.exit(1);
}

async function main() {
  // 1. Resolver tenant camilo-demo
  const { data: tenant, error: tenantErr } = await supabaseAdmin
    .from("tenants")
    .select("id, slug, name, email")
    .eq("slug", TENANT_SLUG)
    .single();
  if (tenantErr || !tenant) return fail("lookup tenant camilo-demo", tenantErr || "no encontrado");
  console.log(`✅ Tenant: id=${tenant.id} slug=${tenant.slug} email=${tenant.email}`);

  // 2. Buscar un owner/admin activo de ese tenant
  const { data: membership, error: memErr } = await supabaseAdmin
    .from("tenant_users")
    .select("user_id, role")
    .eq("tenant_id", tenant.id)
    .in("role", ["owner", "admin"])
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();
  if (memErr || !membership) return fail("lookup owner/admin de tenant_users", memErr || "no encontrado");
  console.log(`✅ Membership: user_id=${membership.user_id} role=${membership.role}`);

  // 3. Obtener email del usuario
  const { data: userData, error: userErr } = await supabaseAdmin.auth.admin.getUserById(membership.user_id);
  if (userErr || !userData?.user?.email) return fail("auth.admin.getUserById", userErr || "sin email");
  const email = userData.user.email;
  console.log(`✅ Usuario: ${email}`);

  // 4. Generar magic link (no envía correo, solo genera el token)
  const { data: linkData, error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  const hashedToken = linkData?.properties?.hashed_token;
  if (linkErr || !hashedToken) return fail("auth.admin.generateLink", linkErr || "sin hashed_token");

  // 5. Canjear el token por una sesión real (access_token)
  const { data: sessionData, error: verifyErr } = await supabaseAdmin.auth.verifyOtp({
    token_hash: hashedToken,
    type: "magiclink",
  });
  const accessToken = sessionData?.session?.access_token;
  if (verifyErr || !accessToken) return fail("auth.verifyOtp", verifyErr || "sin access_token");
  console.log(`✅ Sesión obtenida (access_token de ${accessToken.length} chars)`);

  // 6. POST /billing/flow/create-customer
  console.log(`\n--- POST /billing/flow/create-customer ---`);
  const createRes = await fetch(`${BACKEND_URL}/billing/flow/create-customer`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      tenant_id: tenant.id,
      plan_id: "premium",
      monto: 29990,
      periodicidad: "mensual",
      texto_autorizacion_version: "v1",
    }),
  });
  const createBody = await createRes.json().catch(() => null);
  console.log(`status: ${createRes.status}`);
  console.log(JSON.stringify(createBody, null, 2));
  if (!createRes.ok) return fail("POST /billing/flow/create-customer", createBody);

  // 7. Verificar fila en subscriptions
  const { data: subRow, error: subErr } = await supabaseAdmin
    .from("subscriptions")
    .select("*")
    .eq("tenant_id", tenant.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  console.log(`\n--- Fila en subscriptions tras create-customer ---`);
  console.log(JSON.stringify(subRow, null, 2));
  if (subErr || !subRow) return fail("verificar subscriptions tras create-customer", subErr || "sin fila");

  // 8. POST /billing/flow/register-card
  console.log(`\n--- POST /billing/flow/register-card ---`);
  const registerRes = await fetch(`${BACKEND_URL}/billing/flow/register-card`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ tenant_id: tenant.id }),
  });
  const registerBody = await registerRes.json().catch(() => null);
  console.log(`status: ${registerRes.status}`);
  console.log(JSON.stringify(registerBody, null, 2));
  if (!registerRes.ok) return fail("POST /billing/flow/register-card", registerBody);

  // 9. Verificar fila en subscriptions tras register-card
  const { data: subRow2 } = await supabaseAdmin
    .from("subscriptions")
    .select("status")
    .eq("id", subRow.id)
    .maybeSingle();
  console.log(`\n--- Estado subscriptions tras register-card: ${subRow2?.status} ---`);

  console.log(`\n=== RESULTADO FINAL ===`);
  console.log(`URL_ENROLAMIENTO: ${registerBody.url}`);
  console.log(`TOKEN_FLOW: ${registerBody.token}`);
}

main().catch((e) => fail("excepción no capturada", e));
