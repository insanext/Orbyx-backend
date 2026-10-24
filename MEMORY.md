# MEMORY.md

Registro corto de cambios por sesión (lo que no cabe o no corresponde en CLAUDE.md).
Las reglas permanentes siguen en `CLAUDE.md`.

## 2026-10-24 — Servicios móvil: mover a categoría sin arrastre + arreglos de header

Repo `orbyx-web`, rama `claude/nice-sagan-hzghit` (pusheada, **sin PR**). Backend sin cambios.

- **Diagnóstico**: el arrastre usa dnd-kit (no HTML5 nativo). El problema táctil era `touch-none` + listeners en toda la fila: bloqueaba el scroll.
- **Endpoint único**: arrastre, "Mover a…" y el campo "Categoría" guardan por `PATCH /services/reorder` (`{ tenant_id, order: [{ id, group_id, sort_order }] }`). `POST /services` y `PATCH /services/:id` NO aceptan `group_id` (deliberado: no se tocó el backend). `persistServicesOrder` / `persistServiceGroup` en `services/page.tsx` son el único punto de guardado. "Mover a…" y los formularios mandan un solo ítem con `sort_order` = al final.
- **UI** (`orbyx-web/app/dashboard/[slug]/services/page.tsx`): botón "Mover a…" junto a Editar/Eliminar (modal tipo hoja inferior en móvil, marca la categoría actual, revierte y avisa si falla); `Select` de "Categoría" en crear/editar (solo si hay categorías; se resetea al cambiar de sucursal); `useFinePointer()` (hover+pointer fine) decide el modo.
- **Arrastre**: desktop igual que antes (MouseSensor, 5px, toda la fila). Táctil: TouchSensor con long-press 250 ms, solo desde el handle ⋮⋮ (`touch-action: none`); el resto de la fila deja pasar el scroll. Antes `PointerSensor`.
- **Contraste**: los títulos usaban `text-slate-900 dark:text-white`. En Tailwind v4 `dark:` sigue `prefers-color-scheme` del SO, NO el `data-theme="nocturno"` de Orbyx → texto oscuro sobre fondo oscuro. Ahora `var(--text-main)` / `var(--text-muted)`. Ojo: el mismo patrón puede existir en otras páginas del dashboard (no auditado).
- **Header** (`dashboard/[slug]/layout.tsx`): en <640px copiar URL / QR / tema pasan a un menú "⋯" (`aria-label="Acciones rápidas"`; "Más opciones" ya lo usa la barra inferior). Quedan ⋯, Activaciones, notificaciones y avatar. El nombre del negocio ahora usa `line-clamp-2` en móvil (≥640px sigue `truncate`). Los hooks nuevos del menú se pusieron antes del early return de `/clinical-report/`.
- **Verificación** (Playwright, 390 y 360 px, tema nocturno, backend/Supabase mockeados con harness temporal ya borrado): swipe sobre el cuerpo de la fila hace scroll sin guardar nada; long-press 350 ms en ⋮⋮ + mover → un `PATCH /services/reorder`; "Mover a…" y Editar → Categoría correctos; desktop 1280 arrastra desde la fila; sin overflow horizontal; `tsc` limpio y `next build` OK. NO probado contra el backend/Supabase reales ni en un teléfono físico.
- **Pendiente / notas**: (1) `PATCH /services/reorder` ignora errores por fila de Supabase y no valida que `group_id` sea de la sucursal/tenant (preexistente). (2) En `next dev` el arrastre dispara el PATCH dos veces (StrictMode + efecto dentro del updater de `handleDragEnd`, preexistente; en producción no). (3) `next dev` genera `AGENTS.md`/`CLAUDE.md` en `orbyx-web`; no commitearlos. (4) Deploy: build + Vercel (solo frontend).
- **Nota de sesión**: este `MEMORY.md` no existía en ninguno de los dos repos ni en la máquina; se creó aquí.
