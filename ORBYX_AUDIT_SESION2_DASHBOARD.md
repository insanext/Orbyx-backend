# Auditoría de producción — Sesión 2 de 3: dashboard del tenant (día a día)

Fecha: 2026-09-29 · Alcance: todo lo que un dueño o miembro del equipo usa dentro del dashboard ya autenticado (Agenda, Clientes, Servicios, Staff, Campañas, Indicadores, Mi Negocio/Sucursales, permisos, Activaciones).
**Solo auditoría: no se modificó ningún archivo de código.**

Método: lectura y trazado del código real (`server.js`, `orbyx-web/app/dashboard/[slug]/**`, `components/billing/AccountStatusWidget.tsx`, `middleware.ts`, `lib/api.ts`, `lib/permissions-context.tsx`), siguiendo cada botón hasta el endpoint que llama y el middleware que lo protege. No se ejecutó nada con efectos reales; las verificaciones que requieren prod quedan en la tabla de pruebas pendientes.

Severidad: **Crítico** = rompe una función central, pierde citas o expone datos · **Importante** = problema real para usuarios, privacidad o costo · **Menor** = detalle, inconsistencia o caso raro.

---

## CRÍTICOS

### C1. "Eliminar profesional", "eliminar fecha especial" y "eliminar excepción de un profesional" fallan siempre (desde junio)
- **Dónde (frontend):** `staff/page.tsx:1492` (eliminar staff), `staff/page.tsx:1731` y `:1774` (eliminar excepciones/vacaciones del profesional), `branches/page.tsx:573` y `business/BusinessPanel.tsx:1213` (eliminar fechas especiales / cierres del negocio o sucursal). Todas mandan `DELETE` **sin `tenant_id`** (ni en la URL ni en el cuerpo). `lib/api.ts` no lo agrega solo.
- **Dónde (backend):** `DELETE /staff/:id` (`server.js:5273`), `DELETE /staff-special-dates/:id` (`server.js:5774`), `DELETE /business-special-dates/:id` (`server.js:4812`) usan `tenantAuthWrite`, cuyo paso `enforceTenantId` (`server.js:1984`) responde **400 "tenant_id es obligatorio"** si no viene. Las tres rutas quedaron así en el commit de endurecimiento del 2026-06-29 (`16016258`).
- **Contraste:** los demás borrados sí mandan `tenant_id` (`services/page.tsx:1404`, `service-groups` en `:2350`, `quick-blocks` en `agenda/page.tsx:2805`), por eso esos funcionan.
- **Impacto:**
  - Un cierre o feriado cargado por error no se puede quitar → ese día queda **cerrado en la página pública** (solo queda editarlo, si el formulario lo permite).
  - Vacaciones/excepciones de un profesional no se pueden borrar.
  - No se puede eliminar un profesional. Como el límite del plan cuenta **también los desactivados** (`getStaffCount`, `server.js:1580`, a propósito), un Starter (máx. 2) que quiere reemplazar a alguien **no puede** ni borrar al antiguo ni crear al nuevo.
- **Cómo lo confirmé:** trazado de código (botón → `apiFetch` → middleware). Prueba pendiente P1 para verlo en vivo.
- **¿Decisión previa?** No — regresión accidental del endurecimiento de junio.

### C2. `PATCH /appointments/:id/clinical` no verifica a qué negocio pertenece la cita ni el rol del usuario
- **Dónde:** `server.js:7004` usa `tenantAuthSlugWrite`, pero `enforceSlugOwnership` hace `if (!slug) return next();` (`server.js:1998`) — si la petición no trae `slug`, **se salta la verificación de pertenencia**. El frontend nunca manda `slug` a este endpoint (`customers/[id]/page.tsx:839` y `:1210`), y el handler lee la cita por `id` sin filtrar por negocio y la actualiza (motivo, notas, próximo control) y crea/edita `clinical_notes` y `pet_followups` con el `tenant_id` de la cita.
- **Consecuencias:**
  - Cualquier usuario con sesión en Orbyx (de cualquier negocio, incluida una cuenta gratis recién creada) que conozca el ID de una cita puede **sobrescribir la ficha clínica de una atención de otro negocio**.
  - Dentro del mismo negocio, un miembro con rol **solo lectura** o con "Clientes/Agenda: sin acceso" también puede editar fichas: como no se resolvió la membresía, `requireWriteAccess` no conoce su rol y lo deja pasar.
  - Mitigante: los IDs de cita son UUID (difíciles de adivinar), pero aparecen en los links de cancelación que reciben los clientes.
- **Cómo lo confirmé:** trazado de código. Es el mismo patrón que la auditoría de seguridad Fase 1 corrigió en otros endpoints; este quedó fuera porque *sí* está declarado con `tenantAuthSlugWrite` y parece protegido.
- **Nota:** las demás rutas `tenantAuthSlug*` sin `:slug` en la URL (`PATCH /customers/:id`, `/customers/:id/extra-data`, `/pets/:id`, `/appointments/:id/clinical-pending`, `/appointments/:id/session-notes`, `POST /customers`, `POST /pets`, campañas) **sí exigen `slug`** con un 400 y quedan cubiertas. Solo esta no.
- **¿Decisión previa?** No, bug de seguridad.

---

## IMPORTANTES

### Agenda

**I1. Reserva manual desde Agenda de un servicio con depósito → se cancela sola a los 15 minutos.**
La reserva manual (`agenda/page.tsx:2915`) pasa por el mismo `POST /appointments/slot` que la pública. Ahí, si el negocio tiene depósito activo y el servicio lo exige (`server.js:6357`), la cita queda en "depósito pendiente" con un plazo de 15 min. El cron `releaseExpiredDeposits` (`server.js:11784`) cancela toda cita pendiente **sin comprobante** cuando vence ese plazo. El dueño no sube comprobante de su propia reserva, y la pantalla de éxito de la reserva manual no menciona nada del depósito (no hay ninguna referencia a `deposit_*` en ese flujo). Resultado: la cita que el dueño agendó a mano **desaparece sola** a los 15 min, salvo que vaya a "Depósitos pendientes" y la confirme.
- Además, la reserva manual hereda la anticipación mínima y los días máximos de la reserva pública: si el negocio exige, p.ej., 2 h de anticipación, **no puede registrar un cliente que llegó sin reserva** para ahora mismo.
- Severidad real depende de que el cron esté corriendo (según memoria, `SIGNUP_MAINTENANCE_SECRET` faltaba en Render — ver P6). Si corre, es crítico para negocios con depósito.
- ¿Decisión previa? No documentada — **pregunta de producto** (¿las reservas del dashboard deben saltarse depósito y anticipación mínima?).

**I2. Una cita cancelada con depósito pendiente sigue en "Depósitos pendientes", y "Confirmar" le manda al cliente la confirmación de una cita cancelada.**
Cancelar desde Agenda (`PATCH /appointments/:id/status`, `server.js:11365`) o desde el link del cliente (`cancelById`, `server.js:~11840`) cambia `status` a `canceled` pero **no toca `deposit_status`**, que queda en `pending`. La lista de pendientes (`server.js:11554`) filtra solo por `deposit_status = 'pending'`, y `POST /appointments/:id/deposit/confirm` (`server.js:11620`) solo revisa `deposit_status`, no `status`. Si el tenant revisa la lista y confirma, se envía el correo + WhatsApp "reserva confirmada" (consumiendo cupo) de una cita que ya no existe, y el horario **no** se vuelve a bloquear.
- ¿Decisión previa? No, bug.

**I3. La vista "Día" no muestra citas sin profesional ni de profesionales desactivados; desactivar un profesional deja sus citas futuras "huérfanas".**
- La vista Día arma columnas solo con profesionales **activos** (`agenda/page.tsx:3782`, y la carga de staff pide `active=true`, `:1918`) y cada columna muestra solo `appt.staff_id === staff.id` (`:6142`). Una cita con `staff_id` vacío o de un profesional desactivado **no aparece en la vista Día**, aunque sí en la vista Semana → las dos vistas no muestran lo mismo.
- Desactivar un profesional (`PUT /staff/:id`, `server.js:5185`; también el "ajuste" masivo en `staff/page.tsx:1042`) no revisa ni avisa de sus citas futuras. Esas citas siguen `booked`, el cliente recibe su recordatorio y llega, pero el profesional ya no aparece en el filtro de Agenda ni en la vista Día.
- La página pública sí respeta la desactivación (`getEffectiveStaffAvailability` devuelve 0 horarios si `is_active = false`), así que no se generan reservas nuevas.
- ¿Decisión previa? No, caso no contemplado. Prueba pendiente P4 para dimensionarlo.

**I4. "Reagendó" en una clase grupal deja el cupo ocupado.**
Marcar a un asistente como "Reagendó" cambia su estado a `rescheduled`. Tanto el backend (`server.js:6365` y `:18406`) como el trigger nuevo `appointments_booking_guard` cuentan `booked, completed, no_show, rescheduled` como cupos usados en servicios grupales. El cupo de esa persona **no se libera** para otro cliente.
- En servicios individuales sí se libera (solo `booked` bloquea).
- ¿Decisión previa? El criterio de contar `rescheduled` es anterior y consistente en los 3 lugares, pero no encontré justificación — **pregunta de producto**.

**I5. Mover o reactivar una cita no tiene protección contra solapamiento — respuesta a la pregunta del brief.**
- **No existe función para mover/reagendar una cita** a otra fecha/hora desde el dashboard: `PATCH /appointments/:id` (`server.js:12006`) solo edita nombre, email, teléfono y notas. "Reagendó" es solo un estado final; el tenant debe crear una reserva nueva (que sí pasa por todas las validaciones y el trigger).
- **Reactivar una cancelada**: la interfaz no ofrece volver a `booked` (el tipo de `handleUpdateStatus` no lo incluye, `agenda/page.tsx:2290`), pero el backend lo acepta si se llama directo (`allowed` incluye `booked`, `server.js:11370`) **sin revisar solapamiento** — el trigger solo actúa en INSERT. Hoy el riesgo es solo por API, no por un botón.
- Tampoco hay validación de transiciones: una cita cancelada puede marcarse "Asistió" o "No asistió" (los botones solo se deshabilitan si ya tiene ese mismo estado), lo que la vuelve a contar como visita del cliente.

### Zona horaria (bug pendiente de la sesión 1)

**I6. Indicadores: "Hoy" y todos los rangos están corridos 3 horas (hora UTC, no de Chile).**
Dos errores que se suman:
1. **Frontend** (`app/dashboard/[slug]/page.tsx:121-150`): `toKey()` usa `toISOString()`, que da la fecha en UTC. Desde las **21:00 (horario de verano, hoy) / 20:00 (invierno)**, "Hoy", "7 días" y "30 días" ya consultan **el día de mañana**.
2. **Backend** `GET /stats/:slug` (`server.js:7791`): arma `${fecha}T00:00:00` / `T23:59:59` **sin zona**, así que Postgres lo toma en UTC. El "día" que se consulta va de las 21:00 del día anterior a las 20:59 del día pedido (hora Chile).
- **Efecto:** las citas desde las 21:00 del último día del rango no se cuentan, y se cuelan las de 21:00-23:59 del día anterior al rango. Afecta totales, tasas de no-show/cancelación, servicios top, ingresos estimados, desempeño por profesional y "clientes nuevos del período" (misma consulta sobre `created_at`).
- El mapa de calor y la agrupación por día **sí** usan hora de Chile (`Intl ... America/Santiago`), así que el error está solo en qué citas entran a la consulta.
- ¿Decisión previa? No, es el bug pendiente anunciado.

### Multi-sucursal y permisos

**I7. "Acceso por sucursal" de los miembros del equipo no se aplica en ningún lado.**
Al invitar a alguien, la pantalla de Configuración ofrece "Acceso por sucursal" (`configuracion/page.tsx:866-893`, con el texto "Si no seleccionas ninguna, el usuario verá información de todas las sucursales"). Eso se guarda en `tenant_users.branch_ids`, pero:
- **Ningún archivo lo lee** fuera de esa pantalla: el selector de sucursal del layout (`layout.tsx:603-638`) muestra todas las activas a cualquier miembro, y `GET /branches` las devuelve todas.
- En el backend, `resolveTenantMembership` calcula `req.authenticatedUser.branch_ids` (`server.js:1856`) desde la tabla `branch_access`, pero **ningún endpoint lo usa**. (Además, las invitaciones actuales son rol `operator`, que nunca crea filas en `branch_access`.)
- **Impacto:** un miembro "limitado a la Sucursal Centro" ve y edita agenda, clientes y staff de **todas** las sucursales. La pantalla promete una restricción que no existe.
- ¿Decisión previa? No encontré ninguna; bug/función a medio implementar.

**I8. "Sin acceso" a un módulo solo esconde el menú: la página y la API siguen entregando los datos.**
- El layout filtra el menú lateral (`layout.tsx:733-759`), pero ninguna página revisa `canView` (búsqueda en todo `app/dashboard`: 0 usos) y `middleware.ts` solo verifica que el usuario sea miembro del negocio.
- En el backend, los permisos por módulo solo se aplican a **escrituras** (`requireWriteAccess`); todas las lecturas (`GET /customers/:slug`, `/stats/:slug` con ingresos estimados, `/campaigns/history`, `/appointments/by-range`, etc.) están abiertas a cualquier miembro.
- **Impacto:** un miembro con "Clientes: sin acceso" o "Indicadores: sin acceso" puede escribir la URL (`/dashboard/{slug}/customers`) y ver la base de clientes completa o los ingresos.
- ¿Decisión previa? No documentada — **pregunta de producto**: ¿"sin acceso" debe bloquear también la lectura? (el nombre lo sugiere).

**I9. Se puede desactivar la única sucursal activa, o una con citas futuras, sin ningún aviso.**
`PATCH /branches/:id` (`server.js:17107`, bloque `is_active` en `:17215`) solo valida el límite del plan al **reactivar**. Al desactivar:
- Si era la única activa: la página pública se queda sin sucursal para reservar (`resolveBranchId` → "No se encontró sucursal activa") y el dashboard queda sin sucursal seleccionable (Agenda, Staff y Servicios dependen de ella).
- Si tenía citas futuras: siguen `booked` (recordatorios incluidos), pero ya no se pueden ver en la Agenda porque la sucursal no aparece en el selector; los endpoints que usan `resolveBranchId` responden "La sucursal está inactiva".
- Frontend (`branches/page.tsx:933`) tampoco avisa.
- ¿Decisión previa? No, caso no contemplado.

### Mi Negocio

**I10. Guardar el horario de atención borra el horario anterior antes de validar el nuevo.**
`PUT /business-hours` (`server.js:4561`) primero **borra** todas las filas del ámbito (ignorando si el borrado falla) y después inserta las nuevas, sin transacción y **sin validar** formato ni que la hora de inicio sea menor que la de término (a diferencia de `PUT /staff-hours`, que sí valida). Si el insert falla (dato inválido, error de red a Supabase), el negocio queda **sin horario** → sin disponibilidad pública hasta que alguien lo note y vuelva a guardar.
- Respuesta a la pregunta del brief: cuando el guardado funciona, **sí se refleja de inmediato** en la disponibilidad pública (no hay ninguna caché de horarios; se leen en cada consulta).
- ¿Decisión previa? No, bug.

### Clientes

**I11. El listado de clientes muestra como máximo 300 y, con sucursal activa, oculta a los clientes creados a mano.**
`GET /customers/:slug` (`server.js:8856`) trae los 300 clientes editados más recientemente, sin paginación. Luego, como el dashboard siempre manda la sucursal activa (`customers/page.tsx:257`), filtra y deja solo los que tienen citas en esa sucursal. Consecuencias:
- Negocios con más de 300 clientes no pueden ver al resto (solo buscándolos por nombre/email/teléfono).
- Un cliente creado a mano con "Nuevo cliente" y sin citas **nunca aparece en el listado** (el formulario redirige a su ficha, por eso no se nota al crearlo).
- ¿Decisión previa? No, bug. Prueba P5 para ver si algún negocio ya supera 300.

**I12. Los clientes creados o editados a mano no se normalizan igual que en la reserva pública → duplicados.**
`POST /customers` (`server.js:9039`) y la ficha (`customers/new/page.tsx:204`) guardan el teléfono tal como se escribió y el email sin pasar a minúsculas. La reserva pública busca al cliente existente por teléfono exacto en formato `+569…` o por email en minúsculas (`server.js:3043-3070`). Si el dueño cargó "9 1234 5678" o "Juan@Mail.cl", cuando ese cliente reserva online **se crea un segundo cliente** y el historial queda partido.
- Además, `POST /customers` no valida formato de email ni teléfono (solo `PATCH` valida el email).
- ¿Decisión previa? No, bug.

### Campañas

**I13. Los correos de campaña no incluyen forma de darse de baja.**
Ni `buildCampaignEmailTemplate` ni `sendCampaignEmail` (`server.js:3512`) agregan un enlace de desuscripción, y no existe ningún campo de "no quiero recibir más" en `customers` (búsqueda de unsubscribe/desuscrib/opt-out: 0 resultados). La Ley 19.496 (art. 28 B) exige que toda comunicación promocional por correo indique una forma expedita de pedir que se suspenda. También afecta la reputación del dominio de envío ante Resend/Gmail.
- ¿Decisión previa? No encontrada — **pregunta de producto/legal**.

**I14. Una campaña cortada a la mitad deja registros inconsistentes y no se puede retomar sin duplicar.**
Respuesta a la pregunta del brief. El envío es síncrono, uno por uno, dentro de la misma petición HTTP (`server.js:10405-10590` email, `:10790` WhatsApp):
- **Sí queda registro por destinatario**: cada envío escribe en `campaign_delivery_logs` (enviado/fallido) apenas ocurre.
- **Pero** el contador del historial (`campaign_history.sent_count`) y el **descuento del cupo de email** (`consumeResourceUsage`) se hacen **al final**. Si el servidor se reinicia a mitad (deploy en Render, caída), los correos enviados **no se descuentan** del cupo y el historial queda con 0 enviados.
- No hay idempotencia ni "reanudar": si el dueño ve un error (por ejemplo, el navegador corta la espera en una campaña larga) y vuelve a enviar, los que ya recibieron **reciben de nuevo**.
- No hay pausa entre envíos: con listas grandes se puede chocar con el límite de velocidad de Resend y marcar correos como "fallidos" (prueba P7).
- ¿Decisión previa? Arquitectura original, no documentada como riesgo.

**I15. Campañas WhatsApp: se puede enviar más de lo que queda de saldo.**
El saldo de WhatsApp Marketing se descuenta recién cuando Twilio confirma "entregado" (diseño correcto para no cobrar fallidos). Pero el tope de cada campaña se calcula con el saldo **al momento de empezar** (`remainingBudget = usage.remaining`, `server.js:10863`), que todavía no incluye los mensajes de una campaña anterior que siguen "en camino". Dos campañas seguidas (o un doble clic) pueden gastar el doble del saldo. Cuando luego llegan las confirmaciones, el saldo se corta en 0 (nunca negativo), así que el exceso **lo paga Orbyx** a Twilio.
- Tampoco se eliminan teléfonos repetidos dentro de una misma campaña (sí se hace en email).
- ¿Decisión previa? No, efecto no previsto del conteo por "entregado".

---

## MENORES

**Zona horaria (resto del bug pendiente):**
- **M1. Agenda semanal con offset fijo `-04:00`** (`server.js:7222-7223`, `GET /appointments/by-range`). En horario de verano (sep–abr, es decir, **ahora**) Chile es UTC-3, así que la consulta empieza a la 01:00 del lunes: una cita entre 00:00 y 00:59 del primer día no aparece, y se cuela la de 00:00-00:59 del día siguiente al rango. Impacto real bajo (citas a medianoche son raras), pero es el mismo bug.
- **M2. `GET /dashboard/metrics/:slug` (`server.js:7545`) y `GET /appointments/by-day/:slug/:date` (`server.js:7166`)** tienen el mismo problema de fechas sin zona, pero **ningún archivo del frontend los usa** (código muerto). Se pueden corregir o retirar.
- **M3. Ficha clínica con fecha UTC:** `clinical_notes.date` se guarda como `start_at.split("T")[0]` (`server.js:11258` y `:7093`) → una atención de las 21:30 queda registrada con la fecha del día siguiente. Lo mismo con la fecha "hoy" por defecto en `customers/new/page.tsx:45` y `customers/[id]/page.tsx:519` después de las 21:00.
- **M4. `/stats` sin fechas** usa por defecto `from/to` en UTC (`server.js:7784`). Hoy el frontend siempre las manda, así que no se nota.
- Las horas mostradas en Agenda usan la zona del navegador (igual que la página pública, I2 de la sesión 1). Consistente si el equipo está en Chile continental.

**Agenda / depósitos:**
- **M5.** "Depósitos pendientes" muestra los de **todas las sucursales**, no de la activa (`server.js:11554` no filtra `branch_id`). Puede ser deseado, pero rompe la regla del proyecto de no mezclar sucursales en pantallas por sucursal — **pregunta de producto**.
- **M6.** Editar los datos de contacto de una cita (`PATCH /appointments/:id`, `server.js:12006`) no valida email ni teléfono y no actualiza la ficha del cliente; la cita y el cliente quedan con datos distintos.
- **M7.** La notificación "cita cancelada" del layout compara con `prevRow.status`, pero el propio comentario del arreglo reciente advierte que `payload.old` puede traer solo el ID. Si es así, editar cualquier cosa de una cita ya cancelada vuelve a disparar la notificación "cancelada" (probable, no confirmado).
- **M8.** Bloqueo rápido de sucursal completa = una fila por profesional **activo en ese momento** (diseño conocido). Un profesional agregado o reactivado después no queda bloqueado. Respuesta al brief: para los profesionales incluidos, **sí bloquea la disponibilidad pública** (se aplica en `getEffectiveStaffAvailability`, y la página pública siempre calcula por profesional).

**Staff / servicios:**
- **M9.** Respuesta al brief sobre compartir profesionales: **el diseño no lo permite**. `staff.branch_id` es una sola sucursal y todo (horarios, servicios, disponibilidad) filtra por ella. Una persona que trabaja en 2 sucursales debe crearse 2 veces y ocupa 2 cupos del plan — **pregunta de producto**.
- **M10.** Eliminar o desactivar un servicio con citas futuras no avisa; las citas siguen válidas (correcto), pero el dueño no se entera.
- **M11.** `POST /services` no valida que la duración, precio o márgenes sean números positivos (texto → error 500 genérico).
- **M12.** Qué pasa al borrar un profesional con citas (cuando C1 se arregle) depende de la clave foránea `appointments.staff_id`, que no está en el repo: podría fallar con error genérico, dejar las citas sin profesional (invisibles en vista Día, ver I3) o, en el peor caso, borrarlas. Prueba P2.

**Permisos:**
- **M13.** Un miembro con "Negocio: editar" ve habilitado "Guardar" en Mi Negocio, pero `PATCH /tenants/:id` exige owner/admin (`WRITE_ACCESS_MODULE_RULES`, prefijo `/tenants`) → recibe "Esta acción requiere rol de administrador". Permiso y backend no coinciden.
- **M14.** Cualquier miembro puede listar a todo el equipo con sus correos (`GET /members`, solo `tenantAuth`).
- **M15.** El bloqueo por cuenta vencida/pausada solo existe en el frontend (`middleware.ts`); la API del dashboard no lo revisa. Un tenant bloqueado podría, llamando la API directo, seguir usando su cupo mensual (p.ej. campañas de email). Cae más en la sesión de facturación.

**Campañas / cupos:**
- **M16.** Gating Starter: el backend no bloquea WhatsApp Marketing por plan sino por saldo (`checkMonthlyUsage`, `server.js:10863`). Starter tiene cupo 0 y el add-on exige Business, así que en la práctica está bloqueado, **salvo** si arrastra saldo de add-on de un plan anterior (downgrade) o crédito del admin. Email para Starter está habilitado a propósito (decisión 2026-09-20). **Pregunta de producto:** ¿el saldo ya pagado debe seguir usable tras bajar a Starter?
- **M17.** La audiencia "curada" de email acepta cualquier correo que mande el navegador (no se verifica que sean clientes del negocio). Es lo que permite destinatarios manuales, pero también permite usar Orbyx para enviar a listas externas hasta el tope del cupo.
- **M18.** El contador de uso mensual se incrementa leyendo y reescribiendo el valor (`server.js:~1134`), no de forma atómica: dos envíos simultáneos pueden perder un incremento.

**Activaciones:**
- **M19.** Respuesta al brief: el botón refleja bien el estado — rojo con alerta si está bloqueada, alerta ámbar con pago pendiente, reloj en prueba, rayo en estado normal (`AccountStatusWidget.tsx:646-692`). Los toggles de WhatsApp se desbloquean según `wa_confirmacion.total` (cupo + saldo del add-on), **no** según `renewal_mode` — correcto.
- **M20.** Si la cuenta no está en prueba/pago pendiente y `wa_confirmacion.total` es 0, el widget completo devuelve `null` (`AccountStatusWidget.tsx:635`) y con él desaparece también la pestaña **Depósito previo**. Hoy ningún plan tiene cupo base 0, así que no ocurre, pero depende de `plan_config`.
- **M21.** `PATCH /tenants/:id/whatsapp-settings` no revisa el bloqueo del toggle; por API se puede dejar encendido. Inofensivo: el envío igual se frena por cupo.

---

## Lo que se revisó y está bien
- Indicador de perfil incompleto (punto rojo por dirección/teléfono): sigue funcionando; `/public/business` sigue entregando `phone` y `address`, y Mi Negocio avisa al guardar con `orbyx-business-updated`.
- Contador "Depósitos pendientes" en vivo (arreglo `589aea1`): escucha los eventos del canal del layout, que sí recibe cambios; la lógica es correcta (salvo el caso de I2, que es de datos, no del contador).
- Límite de capacidad grupal por plan: validado en el backend al crear y editar servicios.
- Horario y fechas especiales se leen en vivo en cada consulta de disponibilidad (sin caché).
- Endpoints de Agenda por recurso (`/status`, `/close`, depósito confirmar/rechazar, comprobante) sí verifican negocio y permiso con `requireTenantWriteAccessForResource`.
- Página pública no ofrece horarios de profesionales desactivados.

---

## Pruebas pendientes

**Solo lectura (puedes correrlas tú en el SQL editor de Supabase):**

| # | Qué confirma | Consulta |
|---|---|---|
| P2 | Qué pasa con las citas al borrar un profesional/servicio/sucursal (M12) | `SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'appointments'::regclass AND contype = 'f';` |
| P3 | Si la migración de bloqueos rápidos ya corrió (sin ella, crear un bloqueo da error 500) | `SELECT column_name FROM information_schema.columns WHERE table_name = 'staff_special_dates' AND column_name IN ('source','quick_block_group_id');` |
| P4 | Citas futuras "huérfanas" de profesionales desactivados (I3) | `SELECT a.tenant_id, count(*) FROM appointments a JOIN staff s ON s.id = a.staff_id WHERE a.status = 'booked' AND a.start_at > now() AND s.is_active = false GROUP BY 1;` |
| P4b | Citas futuras en sucursales desactivadas (I9) | `SELECT a.tenant_id, count(*) FROM appointments a JOIN branches b ON b.id = a.branch_id WHERE a.status = 'booked' AND a.start_at > now() AND b.is_active = false GROUP BY 1;` |
| P5 | Negocios con más de 300 clientes (I11) | `SELECT tenant_id, count(*) FROM customers GROUP BY 1 HAVING count(*) > 300;` |
| P6 | Depósitos "pendientes" de citas ya canceladas (I2) | `SELECT id, tenant_id, status, deposit_status, start_at FROM appointments WHERE deposit_status = 'pending' AND status <> 'booked';` |
| P7 | Si las campañas chocan con el límite de Resend (I14) | `SELECT error_message, count(*) FROM campaign_delivery_logs WHERE status = 'failed' AND channel = 'email' GROUP BY 1 ORDER BY 2 DESC LIMIT 20;` |
| P8 | Miembros con "acceso por sucursal" configurado que hoy ven todo (I7) | `SELECT tenant_id, user_id, role, branch_ids FROM tenant_users WHERE is_active AND branch_ids IS NOT NULL AND branch_ids::text NOT IN ('[]','{}');` |
| P9 | Si el cron de depósitos vencidos está corriendo (I1) | Revisar el historial del job en cron-job.org (respuesta 200 vs 401/500) y que `SIGNUP_MAINTENANCE_SECRET` exista en Render. |

**Con efectos reales (requieren tu autorización, idealmente en un negocio de prueba):**

| # | Qué confirma | Cómo |
|---|---|---|
| P1 | C1 | En un negocio de prueba, crear una excepción a un profesional y tratar de eliminarla. Esperado con el bug: error "tenant_id es obligatorio". |
| P10 | I1 | Negocio de prueba con depósito activo: crear una reserva manual de un servicio con depósito y ver si a los 15-30 min aparece cancelada. |
| P11 | I6 | Después de las 21:00, abrir Indicadores → "Hoy" y comparar con las citas del día en Agenda. |
| P12 | C2 | Desde una cuenta de prueba **sin** membresía, llamar `PATCH /appointments/{id-de-prueba}/clinical` sin `slug`. Esperado con el bug: 200. (Solo sobre una cita de prueba.) |

---

## Preguntas de producto
1. ¿Las reservas creadas desde el dashboard deben saltarse el depósito, la anticipación mínima y el máximo de días? (I1)
2. ¿"Reagendó" debe liberar el cupo en clases grupales? (I4)
3. ¿"Sin acceso" a un módulo debe impedir también **ver** esa información, no solo editarla? (I8)
4. ¿Qué debe pasar con las citas futuras al desactivar un profesional o una sucursal: bloquear la acción, avisar, o reasignar? (I3, I9)
5. ¿Se agrega un enlace de desuscripción en campañas y un campo de "no contactar" por cliente? (I13)
6. ¿Un mismo profesional debería poder atender en varias sucursales sin duplicarlo? (M9)
7. ¿El saldo de WhatsApp Marketing ya pagado sigue usable si el negocio baja a Starter? (M16)
8. ¿"Depósitos pendientes" debe filtrarse por la sucursal activa? (M5)
