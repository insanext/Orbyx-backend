ORBYX - CAMBIOS SERVER.JS PARA AGENDA + SOFT DELETE

Archivo base revisado:
server.js

======================================================
1) REEMPLAZAR COMPLETO EL BLOQUE GET /services
======================================================

app.get("/services", async (req, res) => {
  try {
    const { tenant_id, active } = req.query;

    if (!tenant_id) {
      return res.status(400).json({ error: "tenant_id es obligatorio" });
    }

    let query = supabase
      .from("services")
      .select("*")
      .eq("tenant_id", tenant_id)
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
      services: data || [],
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

======================================================
2) AGREGAR ESTE BLOQUE DEBAJO DE PATCH /services/:id
======================================================

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

======================================================
3) REEMPLAZAR COMPLETO EL BLOQUE GET /public/services/:slug
======================================================

app.get("/public/services/:slug", async (req, res) => {
  try {
    const { slug } = req.params;

    const { data: tenant, error: tenantError } = await supabase
      .from("tenants")
      .select("*")
      .eq("slug", slug)
      .single();

    if (tenantError || !tenant) {
      return res.status(404).json({ error: "Negocio no encontrado" });
    }

    const { data: services, error: servicesError } = await supabase
      .from("services")
      .select("*")
      .eq("tenant_id", tenant.id)
      .eq("active", true)
      .is("deleted_at", null)
      .order("created_at", { ascending: true });

    if (servicesError) {
      return res.status(500).json({ error: servicesError.message });
    }

    return res.json({
      business: tenant,
      services: services || [],
    });
  } catch (error) {
    console.error("Error en /public/services/:slug", error);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

======================================================
4) EN GET /public/slots/:slug/:service_id
REEMPLAZAR SOLO EL BLOQUE DE BÚSQUEDA DEL SERVICIO
======================================================

const { data: service, error: serviceError } = await supabase
  .from("services")
  .select("*")
  .eq("id", service_id)
  .eq("tenant_id", tenant.id)
  .eq("active", true)
  .is("deleted_at", null)
  .single();

======================================================
5) AGREGAR ESTE ENDPOINT NUEVO
PONERLO DEBAJO DE POST /appointments/slot
Y ANTES DE GET /appointments
======================================================

app.get("/appointments/by-day/:slug/:date", async (req, res) => {
  try {
    const { slug, date } = req.params;

    const { data: tenant, error: tenantError } = await supabase
      .from("tenants")
      .select("id")
      .eq("slug", slug)
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
      .eq("status", "booked")
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

======================================================
ORDEN RECOMENDADO
======================================================

1. Reemplazar GET /services
2. Agregar DELETE /services/:id
3. Reemplazar GET /public/services/:slug
4. Agregar .is("deleted_at", null) en /public/slots/:slug/:service_id
5. Agregar GET /appointments/by-day/:slug/:date
6. Guardar
7. git add .
8. git commit -m "Agenda negocio y soft delete servicios"
9. git push

