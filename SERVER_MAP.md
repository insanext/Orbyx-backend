# SERVER_MAP.md
Mapa de funciones y endpoints de `server.js`.
Generado desde el archivo completo. Actualizar manualmente o re-generar cuando haya cambios grandes.

---

## HELPERS / FUNCIONES INTERNAS

| Función | Descripción |
|---|---|
| `normalizePlan` | Normaliza nombre de plan a string válido |
| `isValidMime` | Valida MIME de imagen (jpeg/png/webp) |
| `normalizeNullableUrl` | Limpia URL o retorna null |
| `normalizeNullableNumber` | Limpia número o retorna null |
| `getPlanCapabilities` | Retorna límites por plan (staff, servicios, sucursales, emails) |
| `normalizePlanSlug` | Normaliza slug de plan (starter → pro) |
| `getPlanPrice` | Precio mensual por plan |
| `getPlanLevel` | Nivel numérico del plan para comparar |
| `isUpgradePlanChange` | Compara si es upgrade |
| `isDowngradePlanChange` | Compara si es downgrade |
| `addDays` | Suma días a una fecha |
| `addOneMonth` | Suma un mes calendario exacto |
| `ensureBillingDates` | Resuelve fechas de ciclo de billing |
| `calculateProration` | Calcula prorrateo entre planes |
| `getTenantSubscriptionRow` | Lee fila de billing del tenant |
| `getStaffCount` | Cuenta staff activo de un tenant |
| `getPlan` | Obtiene plan actual del tenant |
| `getServicesCount` | Cuenta servicios del tenant |
| `getBranchesCount` | Cuenta sucursales activas del tenant |
| `getMainBranchByTenantId` | Primera sucursal activa del tenant |
| `getBranchById` | Sucursal por ID con todos sus campos |
| `resolveBranchId` | Valida branch_id o cae a primera activa |
| `parseDateToWeekday` | Fecha YYYY-MM-DD → día de la semana (0-6) |
| `timeToMinutes` | "HH:MM" → minutos desde medianoche |
| `isoToMinutesInDate` | ISO UTC → minutos locales Santiago para una fecha |
| `subtractRange` | Resta un bloque de un array de ventanas |
| `intersectWindows` | Intersección de dos arrays de ventanas |
| `santiagoLocalToUtcIso` | Hora local Santiago → ISO UTC |
| `buildSlotsFromWindows` | Ventanas + fecha + intervalo → array de slots |
| `getStaffAvailabilityWindows` | **LEGACY** Disponibilidad de staff (usa helpers viejos) |
| `subtractAppointmentsFromWindows` | Resta appointments existentes de ventanas |
| `getServiceStaffIds` | IDs de staff asignados a un servicio |
| `getBusinessAvailabilityWindows` | **LEGACY** Disponibilidad de negocio (helper viejo) |
| `rowsToAvailabilityWindows` | Filas DB → array de ventanas |
| `applySpecialDatesToWindows` | Aplica fechas especiales a ventanas |
| `getBusinessHoursRows` | Lee filas de business_hours (global o sucursal) |
| `getBusinessSpecialDateRows` | Lee filas de business_special_dates (global o sucursal) |
| `getEffectiveBusinessAvailability` | **NUEVO** Disponibilidad efectiva del negocio con lógica global/sucursal |
| `getStaffHoursRows` | Lee filas de staff_hours |
| `getStaffSpecialDateRows` | Lee filas de staff_special_dates |
| `getEffectiveStaffAvailability` | **NUEVO** Disponibilidad efectiva del staff intersectando negocio + staff |
| `filterSlotsByWindows` | Filtra slots que caen dentro de ventanas |
| `filterSlotsForServiceDuration` | Filtra slots que tienen bloques consecutivos para duración total |
| `filterSlotsByVisibleStep` | Filtra slots según step visible (evita mostrar cada bloque base) |
| `filterPastSlots` | Filtra slots pasados o dentro del mínimo de anticipación |
| `recalculateCustomerStats` | Recalcula total_visits y last_visit_at de un cliente |
| `upsertCustomerFromAppointment` | Crea o actualiza cliente desde datos de reserva |
| `resolvePetFromAppointment` | Resuelve o crea mascota desde customer_data |
| `sendCampaignEmail` | Envía email de campaña via Resend |
| `escapeHtml` | Escapa caracteres HTML |
| `sanitizeRichHtml` | Limpia HTML de scripts y eventos |
| `htmlToPlainText` | HTML → texto plano |
| `buildCampaignEmailTemplate` | Construye HTML y texto plano para email de campaña |
| `getGoogleCalendarClientByCalendarId` | Cliente Google Calendar desde calendar_tokens legacy |
| `findActiveCalendarConnection` | Busca conexión activa en calendar_connections (staff → branch → tenant) |
| `findLegacyCalendarTokenConnection` | Busca token legacy en calendar_tokens |
| `resolveCalendarConnection` | Resuelve conexión de calendario (nuevo → legacy) |
| `getGoogleCalendarClientFromConnection` | Cliente Google Calendar desde connection row |
| `deleteCalendarEventForAppointment` | Borra evento externo al cancelar reserva |
| `getGoogleCalendarClientFixed` | Cliente Google Calendar modo fijo (legacy demo) |
| `isValidDayOfWeek` | Valida que day_of_week sea 0-6 |
| `normalizeNullableText` | Limpia string o retorna null |
| `normalizeColor` | Color o default #0f172a |
| `normalizeNullablePetText` | Limpia string de datos de mascota |
| `addMonths` | Suma meses a una fecha |
| `addYears` | Suma años a una fecha |
| `resolveNextControlDate` | Calcula fecha próximo control veterinario según modo |
| `insertCampaignDeliveryLog` | Inserta log de entrega de campaña |
| `normalizeCampaignError` | Normaliza error de campaña a string |

---

## ENDPOINTS

### OAuth / Calendar

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/auth` | Inicia OAuth Google Calendar |
| GET | `/auth/microsoft` | Inicia OAuth Microsoft Calendar |
| GET | `/oauth2callback` | Callback OAuth Google (guarda token en calendar_tokens o calendar_connections) |
| GET | `/oauth2callback/microsoft` | Callback OAuth Microsoft (guarda en calendar_connections) |
| GET | `/calendar-connections` | Lista conexiones de calendario por tenant/staff/branch |
| GET | `/test-event` | Crea evento de prueba en Google Calendar |

### Business Hours

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/business-hours` | Lee horarios globales o de sucursal |
| PUT | `/business-hours` | Reemplaza horarios (soporta múltiples bloques por día) |

### Business Special Dates

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/business-special-dates` | Lista fechas especiales globales o de sucursal |
| POST | `/business-special-dates` | Crea fecha especial |
| PUT | `/business-special-dates/:id` | Actualiza fecha especial |
| DELETE | `/business-special-dates/:id` | Elimina fecha especial |

### Staff

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/staff` | Lista staff por tenant/branch |
| POST | `/staff` | Crea staff (valida límite de plan) |
| PUT | `/staff/:id` | Actualiza staff |
| DELETE | `/staff/:id` | Elimina staff |

### Staff Services

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/staff-services` | Lista relaciones staff-servicio |
| PUT | `/staff-services` | Reemplaza relaciones de un staff en una sucursal |
| DELETE | `/staff-services/:id` | Elimina relación staff-servicio |

### Staff Hours

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/staff-hours` | Lee horarios de staff (por tenant y opcionalmente staff_id) |
| PUT | `/staff-hours` | Reemplaza horarios semanales de un staff |

### Staff Special Dates

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/staff-special-dates` | Lista fechas especiales de staff |
| POST | `/staff-special-dates` | Crea fecha especial de staff |
| PUT | `/staff-special-dates/:id` | Actualiza fecha especial de staff |
| DELETE | `/staff-special-dates/:id` | Elimina fecha especial de staff |

### Slots (legacy)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/slots` | Slots por calendar_id (usa mezcla de helpers viejos/nuevos) |

### Appointments

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/appointments/slot` | **CRÍTICO** Crea reserva (validación completa + calendar + email) |
| GET | `/appointments` | Lista reservas por calendar_id |
| GET | `/appointments/by-day/:slug/:date` | Reservas de un día por slug |
| GET | `/appointments/by-range/:slug` | Reservas por rango de fechas (enriquecidas con service_is_group, staff_name) |
| GET | `/appointments/pending-close/:slug` | Reservas pasadas con status booked (pendientes de cierre) |
| GET | `/appointments/customer-history/:slug` | Historial de reservas por cliente |
| GET | `/appointments/search/:slug` | Búsqueda de reservas por nombre/email/teléfono |
| GET | `/appointments/:id` | Info pública de reserva (requiere cancel_token) |
| PATCH | `/appointments/:id` | Edita campos de cliente en reserva |
| PATCH | `/appointments/:id/status` | Cambia status de reserva |
| PATCH | `/appointments/:id/clinical` | Guarda ficha clínica veterinaria |
| POST | `/appointments/:id/close` | Cierre veterinario con followup |
| POST | `/appointments/:id` | Cancela reserva por token (compat) |
| DELETE | `/appointments/:id` | Cancela reserva por token |

### Dashboard

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/dashboard/metrics/:slug` | Métricas de reservas (hoy, semana, mes, comparaciones) |

### Customers

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/customers/:slug` | Lista clientes con segmentación y filtro branch |

### Pets

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/pets/:slug` | Lista mascotas por cliente (por customer_id, phone o email) |
| POST | `/pets` | Crea mascota para un cliente |
| GET | `/pets/:id/clinical-pdf` | Genera PDF ficha clínica veterinaria |
| GET | `/pet-followups/:slug` | Lista próximos controles (followups) |
| GET | `/api/pets/:slug` | Alias legacy de /pets/:slug |

### Campaigns

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/campaigns/send-email` | Envía campaña email real via Resend (soporta audiencia curada o por segmento) |
| POST | `/campaigns/save-whatsapp` | Guarda campaña WhatsApp en historial (no envío real) |
| GET | `/campaigns/history/:slug` | Historial de campañas del negocio |
| GET | `/campaigns/logs/:campaignId` | Logs de entrega de una campaña |

### Tenants / Billing

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/tenants/provision` | Provisiona tenant + usuario + calendario inicial |
| PATCH | `/tenants/:id` | Actualiza perfil del negocio |
| GET | `/billing/preview-change` | Preview de cambio de plan con prorrateo |
| POST | `/billing/change-plan` | Aplica upgrade o programa downgrade |
| POST | `/billing/apply-scheduled-changes` | Aplica downgrades programados (cron o manual) |

### Branches

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/branches` | Lista sucursales del tenant |
| POST | `/branches` | Crea sucursal (valida límite de plan) |
| PATCH | `/branches/:id` | Actualiza sucursal (valida límite al reactivar) |

### Services

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/services` | Lista servicios del tenant/branch |
| POST | `/services` | Crea servicio (valida límite de plan) |
| PATCH | `/services/:id` | Actualiza servicio |
| DELETE | `/services/:id` | Soft-delete de servicio |

### Public Booking

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/public/services/:slug` | Servicios públicos con al menos 1 staff asignado |
| GET | `/public/business/:slug` | Config pública del negocio (calendar_id, booking limits, category) |
| GET | `/public/staff/:slug/:service_id` | Staff público asignado a un servicio |
| GET | `/public/slots/:slug/:service_id` | Slots públicos disponibles (con capacidad grupal si aplica) |

### Booking Fields

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/booking-fields/:slug` | Lee configuración de campos del formulario de reserva |
| PUT | `/booking-fields/:slug` | Guarda configuración de campos del formulario |

### Calendars

| Método | Ruta | Descripción |
|---|---|---|
| PATCH | `/calendars/:id/slot-minutes` | Actualiza intervalo de slots del calendario |

### Uploads / Campaign Images

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/upload/campaign-image` | Sube imagen de campaña a Supabase Storage |
| GET | `/campaign-images/:slug` | Lista imágenes de campaña del negocio |
| DELETE | `/campaign-images/:id` | Elimina imagen de campaña |

### Jobs / Misc

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/jobs/send-reminders` | Envía recordatorios 24h antes de reservas |
| POST | `/onboarding/setup` | Setup inicial de negocio desde onboarding |
| GET | `/_ping` | Healthcheck |

---

## NOTAS DE RIESGO

| Área | Riesgo |
|---|---|
| `getStaffAvailabilityWindows` / `getBusinessAvailabilityWindows` | Helpers LEGACY, usar solo en `/slots`. Para todo lo demás usar los `getEffective*` |
| `resolveBranchId` | Cae a primera sucursal activa si no se envía branch_id — puede ocultar bugs |
| `/appointments/slot` | No valida explícitamente que staff_id pertenezca a staff_services del service_id |
| `/appointments/by-range` | Usa offset fijo `-04:00` para construir rango de fechas |
| `POST /staff` | Versión anterior tenía bug con variable `address` no declarada — verificar si persiste |
| `POST /billing/change-plan` | Versión anterior tenía bug con `logo_url` fuera de scope en downgrade |
| `/public/business/:slug` | Retorna `google_connected: false` siempre (hardcodeado) |
| Campañas sin audiencia curada | Usan customers globales del tenant, no filtran por branch |
| Group booking | Sin garantía transaccional en DB para concurrencia de cupos |
