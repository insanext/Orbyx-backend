# Orbyx Backlog

Backlog técnico y de producto para ordenar próximas tareas. Este documento no modifica lógica funcional.

## Reglas Operativas

- No ejecutar `git push` automáticamente.
- El usuario ejecuta manualmente los deploys.
- Entregar bloques de deploy solamente en el chat, listos para copiar/pegar y separados entre frontend/backend, después de cambios funcionales.
- No agregar comandos de deploy dentro de documentación técnica salvo pedido explícito.
- Mantener cambios mínimos y seguros.
- Antes de editar código, explicar archivos a tocar y motivo.
- Priorizar compatibilidad entre modo genérico, veterinaria y group booking.

## Fase 1: Cerrar Lógica Crítica Actual

Objetivo: terminar comportamientos de producto que afectan operación diaria antes de refactors o rediseños grandes.

- Group booking panel.
- Cupos por plan.
- Lista de inscritos por clase/bloque.
- Asistencia/no-show.
- Estado visual real Google Calendar.
- Probar campaigns después de cambios.

Notas:

- Validar siempre `business_category`.
- Cuidar branch, staff, service y appointment consistency.
- Evitar cambios amplios en `server.js`; tocar solo endpoints/helpers exactos.
- Group booking debe mantener compatibilidad con reservas individuales.
- Asistencia/no-show debe convivir con flujo veterinario de cierre de atención.

## Fase 2: Estabilización Técnica

Objetivo: reducir duplicación y riesgo en frontend sin cambiar comportamiento visible.

- Centralizar `BACKEND_URL`.
- Crear helper `business_category`.
- Crear hook/context para tenant + branch.
- Normalizar fetches frontend.
- Revisar `branch_id` en flujos críticos.

Notas:

- Hacer esto incrementalmente por pantalla o flujo.
- No introducir un state manager grande.
- Mantener `orbyx-branch-changed` y `localStorage` hasta tener reemplazo seguro.
- No romper modo clásico/nocturno.
- Mantener response shapes actuales del backend.

## Fase 3: Arquitectura Backend

Objetivo: reducir fragilidad del monolito cuando la lógica crítica ya esté cerrada.

- Separar `server.js` por dominios.
- Extraer availability helpers.
- Crear routers:
  - appointments
  - services
  - staff
  - campaigns
  - google
- Mejorar manejo transaccional reservas + Google Calendar.

Notas:

- Esta fase debe hacerse con mucho cuidado.
- Primero extraer código sin cambiar comportamiento.
- Agregar pruebas/manual checks para disponibilidad y creación de reservas.
- Mantener compatibilidad de endpoints mientras exista frontend actual.
- Priorizar `appointments` y `availability` como primeros candidatos.

## Fase 4: Rediseño Panel

Objetivo: lograr un panel del cliente más funcional, minimalista y fácil de operar.

- Dashboard más minimalista.
- Navegación más clara.
- Branch selector mejor.
- Menos cards decorativas.
- Modo clásico/nocturno consistente.

Notas:

- Hacer rediseño después de cerrar lógica crítica.
- Evitar landing-style UI dentro del panel operativo.
- Priorizar escaneo rápido, acciones claras y densidad útil.
- Mantener flujos existentes mientras se rediseña por módulos.
- Rediseñar pantalla por pantalla, no todo el dashboard de una vez.
