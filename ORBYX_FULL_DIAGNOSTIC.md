1. Arquitectura GeneralOrbyx es una app SaaS de reservas con frontend Next.js App Router y backend Express monolítico.
Capa	Ubicación	Rol
Frontend	orbyx-web/app	Landing, booking público, dashboard, agenda, staff, servicios, campañas, clientes, sucursales
Backend	server.js	API Express, reglas de negocio, disponibilidad, reservas, Supabase, calendario, emails
Supabase	usado desde backend y algunas rutas Next	DB, storage, service role
Email	email.js	Confirmación de reserva vía Resend
Next API proxy	orbyx-web/app/api	Proxies para booking público y uploads
El frontend usa muchos fetch directos a https://orbyx-backend.onrender.com. El booking público usa principalmente proxies Next para servicios, staff, slots y creación de reserva.
Tablas Supabase detectadas en código:
tenants, tenant_users, branches, calendars, calendar_tokens, calendar_connections, business_hours, business_special_dates, staff, staff_hours, staff_special_dates, staff_services, services, appointments, customers, pets, pet_followups, campaign_history, campaign_delivery_logs, campaign_images.
2. Horarios Y DisponibilidadLa lógica crítica está en server.js (line 405).
Funciones principales:
Función	Rol
resolveBranchId	Valida o resuelve sucursal activa por tenant
getEffectiveBusinessAvailability	Calcula disponibilidad efectiva del negocio considerando global/sucursal
getEffectiveStaffAvailability	Calcula disponibilidad efectiva del staff intersectando negocio + staff
applySpecialDatesToWindows	Aplica cierres/aperturas especiales
subtractAppointmentsFromWindows	Resta reservas existentes
buildSlotsFromWindows	Genera slots en timezone Santiago
filterSlotsForServiceDuration	Exige bloques consecutivos para duración + buffers
filterPastSlots	Aplica anticipación mínima
Prioridad actual de reglas:
Se resuelve tenant_id y branch_id.
Se cargan horarios globales (business_hours.branch_id IS NULL) y de sucursal.
Si la sucursal use_global_hours !== false, usa horario global si existe; si no, fallback a horario de sucursal.
Si la sucursal use_global_hours === false, usa horario de sucursal si existe; si no, fallback global.
Se aplican fechas especiales globales siempre.
Si la sucursal use_global_special_dates === false, además se aplican fechas especiales de sucursal.
Para staff:si use_business_hours es true, usa disponibilidad efectiva de negocio;
si es false, intersecta disponibilidad efectiva de negocio con staff_hours.

Se aplican staff_special_dates.
Para reservas individuales se restan appointments existentes.
Para reservas grupales no se restan appointments; se calcula cupo por capacidad.
Se filtra por duración total: duration_minutes + buffer_before_minutes + buffer_after_minutes.
Se filtra por anticipación mínima.
Riesgo importante: la semántica de use_global_special_dates es algo contraintuitiva. Las fechas especiales globales se aplican siempre; cuando use_global_special_dates === false, se agregan las locales, pero no se reemplazan las globales. Si una sucursal necesita ignorar una fecha global cerrada, el código actual no parece permitirlo.
Otro riesgo: existe lógica vieja getBusinessAvailabilityWindows y getStaffAvailabilityWindows. /public/slots y /appointments/slot usan la lógica efectiva nueva, pero /slots usa mezcla con lógica antigua. Puede haber diferencias entre disponibilidad pública y endpoint /slots.
3. Lógica De ReservasFlujo público:
Usuario entra a /{slug} en orbyx-web/app/[slug]/page.tsx (line 426).
Carga servicios vía /api/public-services/:slug.
Selecciona sucursal, servicio, staff y fecha.
Carga slots vía /api/public-slots/:slug/:serviceId.
Envía reserva a /api/appointments/slot.
Next reenvía a backend /appointments/slot.
Validaciones backend en server.js (line 3743):
Validación	Estado
Campos obligatorios	Confirmado
Email válido	Confirmado
Teléfono móvil chileno	Confirmado
Calendario activo	Confirmado
Sucursal pertenece al tenant y está activa	Confirmado
Servicio pertenece a branch/tenant y no está borrado	Confirmado
Anticipación mínima	Confirmado
Máximo días hacia adelante	Confirmado
Cupo grupal	Confirmado
Duplicado mismo slot individual	Confirmado
Reservas futuras por persona	Confirmado, solo no grupal
Solapamiento por customer_id	Confirmado
Slot aún disponible	Confirmado
Campos guardados en appointments: tenant_id, branch_id, calendar_id, service_id, staff_id, customer_id, pet_id, service_name_snapshot, duration_minutes_snapshot, customer_name, customer_phone, customer_email, start_at, end_at, source, status, reason, notes, next_control_at, cancel_token, customer_data, campos de calendario (event_id, calendar_provider, calendar_connection_id, calendar_sync_status, etc.).
Google Calendar:
Busca conexión en calendar_connections: primero staff, luego branch, luego tenant.
Si no encuentra, intenta legacy calendar_tokens.
Si crea evento exitosamente, guarda event_id y estado synced.
Si falla o no hay conexión, la reserva queda creada y se marca calendar_sync_status = "error".
Si Resend no está configurado, email se omite sin romper.
Riesgo: si se llama directamente /appointments/slot con staff_id, el backend recalcula disponibilidad de ese staff, pero no confirma explícitamente que ese staff esté asignado al servicio. El endpoint público de slots sí valida relación staff-servicio; el endpoint de creación debería reforzarlo para evitar payloads manipulados.
4. Multi-SucursalLa sucursal activa del dashboard se maneja en layout.tsx (line 161).
Mecanismo:
Key: orbyx_active_branch_${slug}.
Se guarda en localStorage.
Se emite evento orbyx-branch-changed.
Páginas como agenda, staff, servicios y clientes escuchan el evento y recargan.
Módulos filtrados por branch_id:
Módulo	Estado
Staff	Filtra por branch
Servicios	Filtra por branch
Staff-services	Filtra por branch si se entrega
Agenda by-range	Filtra por branch
Pending close	Filtra por branch
Search appointments	Filtra por branch
Clientes	Filtra indirectamente por appointments del branch
Booking público	Usa branch seleccionada
Public staff/services/slots	Filtra por branch
Riesgos multi-sucursal:
GET /staff-hours carga por tenant y no exige branch; frontend filtra localmente.
GET /staff-special-dates puede traer todo por tenant si no se pasa branch.
Campañas no parecen tener filtro branch propio fuerte; dependen de customers globales o audiencia curada.
Clientes no tienen branch_id directo confirmado; el filtro por sucursal se reconstruye desde appointments.
resolveBranchId cae a primera sucursal activa si no se envía branch_id; esto es cómodo pero riesgoso si algún frontend omite la sucursal.
5. Servicios Y StaffServicios viven en services y pertenecen a tenant_id + branch_id.
Staff vive en staff y pertenece a tenant_id + branch_id.
Relación staff-servicio:
Tabla staff_services.
PUT /staff-services reemplaza todas las relaciones de un staff en una sucursal.
Public booking solo muestra servicios con al menos un staff asignado.
Public staff solo muestra profesionales asignados al servicio.
Duración:
duration_minutes define largo base.
buffer_before_minutes y buffer_after_minutes existen.
El slot se valida con duración total.
El end_at de appointment incluye duración + buffers.
Group booking:
services.is_group.
services.capacity.
Frontend dashboard solo muestra controles grupales si business_category === "group_booking".
Booking público también trata como group-like: fitness, clases, talleres, eventos, group_booking.
Bug detectado: POST /staff referencia address aunque no está destructurado en el body. Eso causaría ReferenceError al crear staff desde ese endpoint. Está en server.js (line 2946). No lo modifiqué.
6. AgendaArchivo crítico: agenda/page.tsx.
Carga:
Negocio y calendario desde /public/business/:slug.
Sucursales desde /branches.
Staff desde /staff?tenant_id&branch_id&active=true.
Servicios desde /services?tenant_id&branch_id&active=true.
Appointments desde /appointments/by-range/:slug?from&to&branch_id&staff_id.
Pendientes desde /appointments/pending-close/:slug.
Filtros:
branch_id: obligatorio en agenda para cargar.
staff_id: opcional.
service_id: filtro frontend.
status: filtro frontend con estados booked, completed, no_show, rescheduled, canceled, y una vista “active/pending_close”.
Estados:
Estado	Interpretación
booked	Reserva activa
completed	Atendida
no_show	No asistió
rescheduled	Reagendada
canceled	Cancelada
Reservas grupales:
Backend enriquece appointments con service_is_group y service_capacity.
Frontend agrupa por bloque/hora/staff/servicio.
Muestra inscritos activos vs capacidad.
Funciones/componentes sensibles:
Agrupación visual de bloques grupales.
Cálculo de slots visuales de agenda con horarios locales.
handleUpdateStatus.
handleCloseVeterinaryAppointment.
handleConfirmManualBooking.
Cálculo local de cierres/horarios para mostrar bloques cerrados.
7. Página Pública De ReservasRuta: orbyx-web/app/[slug]/page.tsx.
Responsabilidades frontend:
Detecta slug.
Carga servicios, sucursales y negocio.
Permite seleccionar branch.
Carga staff por servicio.
Carga slots por semana y próximos slots.
Valida campos del formulario.
Maneja campos veterinarios y campos configurables.
Muestra cupos si negocio es group-like.
Envía reserva.
Responsabilidades backend:
Resolver tenant/branch.
Validar servicio/staff/horario.
Calcular disponibilidad real.
Evitar duplicados.
Crear appointment.
Upsert customer/pet.
Sincronizar calendario.
Enviar email.
8. Campañas Y ClientesClientes:
customers se asocia a tenant.
No confirmé branch_id directo en customers.
El endpoint /customers/:slug filtra por sucursal usando appointments del branch.
Segmentos: new, recurrent, frequent, inactive.
Campañas:
Email real por Resend en /campaigns/send-email.
WhatsApp solo guarda historial/logs en /campaigns/save-whatsapp.
Historial en campaign_history.
Logs en campaign_delivery_logs.
Riesgo de mezcla entre sucursales:
Campañas sin audiencia curada usan customers globales del tenant, no branch.
Si el frontend curó audiencia usando filtro branch, puede respetarse indirectamente.
No confirmado que campaign_history guarde branch_id.
9. Planes Y LímitesPlanes detectados: pro, premium, vip, platinum; starter normaliza a pro.
Límites backend en getPlanCapabilities:
Plan	Staff	Servicios	Sucursales	Emails/campaña
pro	2	10	1	50
premium	5	25	2	150
vip	10	50	3	400
platinum	20	100	10	1000
Implementado:
Límite staff en creación.
Límite servicios en creación.
Límite sucursales en creación/reactivación.
Límite emails por campaña.
Límites de imágenes de campaña con otra tabla PLAN_LIMITS.
Pendiente/no confirmado:
Límite real para recordatorios.
Addons.
Enforcement completo de WhatsApp.
Validación de downgrade contra recursos existentes.
UI y backend tienen tablas de límites duplicadas; podrían divergir.
10. Riesgos TécnicosArchivos críticos:
server.js: monolito con toda la lógica.
agenda/page.tsx: agenda muy grande y sensible.
app/[slug]/page.tsx: booking público.
services/page.tsx: servicios + staff relation + group booking.
staff/page.tsx: staff + horarios + fechas especiales.
Posibles bugs/riesgos:
POST /staff usa address no definido.
POST /billing/change-plan tiene un console.log usando logo_url fuera de scope; podría romper downgrades.
sendBookingEmail solo reconoce veterinaria exacta "veterinaria", no "vet".
/public/business/:slug devuelve google_connected: false fijo.
Upload staff photo no valida MIME ni tamaño explícito.
Rutas Next con service role para uploads dependen de que no sean abusables; no se ve autenticación en route handler.
Muchos endpoints no muestran autenticación/autorización explícita; usan tenant/slug/ids enviados.
Duplicación de lógica de disponibilidad antigua/nueva.
Timezone usa Santiago, pero hay lugares con offset fijo -03:00 o -04:00; puede fallar con DST.
Group booking permite múltiples reservas en mismo slot, pero la consistencia concurrente depende de DB/constraints no confirmadas.
Clientes/campañas pueden mezclar sucursales si no se cura audiencia por branch.
11. Mapa De ArchivosArchivo	Qué hace	Lógica	Riesgo	Conexiones
server.js	Backend completo	API, disponibilidad, reservas, planes, campañas, calendario	Muy alto	Todo frontend, Supabase, Resend, Google
email.js	Email reserva	Plantilla Resend	Medio	/appointments/slot
supabaseClient.js	Cliente Supabase	Service role	Alto	Backend
orbyx-web/app/[slug]/page.tsx	Booking público	Servicios, staff, slots, submit, vet/group	Muy alto	API Next + backend
orbyx-web/app/api/appointments/slot/route.ts	Proxy reserva	Normaliza ids y reenvía	Alto	Backend /appointments/slot
orbyx-web/app/api/public-services/[slug]/route.ts	Proxy servicios	Carga servicios + branches	Alto	Backend /public/services, /branches
orbyx-web/app/api/public-staff/[slug]/[service_id]/route.ts	Proxy staff público	Staff por servicio	Medio	Backend /public/staff
orbyx-web/app/api/public-slots/[slug]/[serviceId]/route.ts	Proxy slots	Slots públicos	Alto	Backend /public/slots
orbyx-web/app/dashboard/[slug]/layout.tsx	Shell dashboard	Navegación, theme, branch activa	Alto	Páginas dashboard
orbyx-web/app/dashboard/[slug]/agenda/page.tsx	Agenda	Appointments, estados, grupos, cierre vet	Muy alto	Appointments, staff, services
orbyx-web/app/dashboard/[slug]/services/page.tsx	Servicios	CRUD, staff-services, group controls	Alto	Staff, services
orbyx-web/app/dashboard/[slug]/staff/page.tsx	Staff	CRUD, horarios, especiales	Alto	Staff, services, hours
orbyx-web/app/dashboard/[slug]/business/page.tsx	Config negocio	Perfil, horarios, booking fields	Alto	Tenants, hours, calendar
orbyx-web/app/dashboard/[slug]/branches/page.tsx	Sucursales	CRUD branch	Alto	Branch-aware modules
orbyx-web/app/dashboard/[slug]/customers/page.tsx	Clientes	Segmentos, filtro branch indirecto	Medio	Customers, appointments
orbyx-web/app/dashboard/[slug]/campaigns/page.tsx	Campañas	Audiencia, email/whatsapp mock	Alto	Customers, campaigns
orbyx-web/lib/use-theme.ts	Tema dashboard	clasico, nocturno, data-theme	Medio	Layout/UI
12. CONTEXTO PARA CLAUDE CODEOrbyx es un SaaS de reservas tipo AgendaPro. Frontend Next.js App Router en orbyx-web/; backend Node/Express monolítico en server.js; DB/storage Supabase; emails con Resend; calendario con Google OAuth y tabla nueva calendar_connections.
Reglas importantes: hacer cambios mínimos, no refactors grandes, preservar multi-sucursal, preservar timezone America/Santiago, preservar booking público, preservar modos veterinaria/vet, generic y group booking. Antes de editar, indicar archivos y razón.
Flujo público: /{slug} carga negocio/branches/services vía proxies Next. Selección de servicio carga staff. Fecha/staff carga slots. Submit llama /api/appointments/slot, que reenvía a backend /appointments/slot. Backend valida tenant, branch, service, horario efectivo, duración, buffers, duplicados, cupos grupales, customer/pet, crea appointment, intenta Google Calendar, envía email.
Disponibilidad: usar helpers efectivos de server.js: getEffectiveBusinessAvailability, getEffectiveStaffAvailability, applySpecialDatesToWindows, subtractAppointmentsFromWindows, buildSlotsFromWindows, filterSlotsForServiceDuration, filterPastSlots. Sucursal tiene use_global_hours y use_global_special_dates. Staff tiene use_business_hours. Fechas especiales globales se aplican siempre; locales se agregan cuando la sucursal no usa global specials. Cuidado con esta semántica.
Multi-sucursal: dashboard guarda sucursal en localStorage como orbyx_active_branch_${slug} y emite orbyx-branch-changed. Staff, servicios, agenda, slots y booking público deben llevar branch_id. No omitir branch_id; si se omite, backend cae a primera sucursal activa.
Módulos sensibles: server.js, booking público orbyx-web/app/[slug]/page.tsx, agenda orbyx-web/app/dashboard/[slug]/agenda/page.tsx, servicios, staff, business, branches. server.js tiene duplicación antigua/nueva de disponibilidad; tocar solo bloques exactos.
Riesgos recomendados para revisar después: bug POST /staff con address no definido; posible bug downgrade billing con logo_url fuera de scope; validación directa de /appointments/slot debería confirmar que staff_id realiza service_id; google_connected fijo en false; campañas sin branch pueden mezclar clientes de sucursales; uso de offsets -03/-04 junto a timezone Santiago; upload routes con service role necesitan cuidado de auth/validación.
Comandos ejecutados: solo lectura (Get-ChildItem, rg, Get-Content, Select-String, git status). Resultado: orbyx-web aparece modificado antes de este diagnóstico. No se corrieron builds/tests porque el pedido fue documentación/análisis sin cambios. No requiere build ni deploy.