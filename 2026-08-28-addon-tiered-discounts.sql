-- 2026-08-28-addon-tiered-discounts.sql
--
-- Extiende el descuento marginal por tramo (2ª unidad -10%, 3ª+ -15%,
-- mismo modelo que ya usa wa_confirmacion desde el inicio) a los otros 5
-- add-ons del catálogo, que hasta ahora cobraban precio plano sin importar
-- la cantidad (pack2_price = pack3_price = price).
--
-- Confirmado con Camilo el 2026-08-28: se mantiene el modelo MARGINAL
-- actual (cada unidad se cobra en su propio tramo — 1ª completa, 2ª al
-- 90%, 3ª+ al 85% cada una — no un % plano sobre el total del lote).
--
-- Hallazgo adicional detectado al preparar este cambio: el frontend
-- (orbyx-web/components/addons/AddonManager.tsx) ya tenía hardcodeados
-- pack2_price/pack3_price de campanas_wa con estos mismos valores
-- (6291/5942), pero la tabla real en Supabase seguía plana (6990/6990) —
-- o sea, el preview de precio y el texto de consentimiento legal ya
-- mostraban un descuento que la tabla real no aplicaba. Este UPDATE
-- corrige eso también (no solo agrega descuento a addons que no tenían
-- ninguno).
--
-- Redondeo: Math.round(price * 0.90) y Math.round(price * 0.85), mismo
-- criterio ya usado en wa_confirmacion (2990 -> 2691 / 2542).

UPDATE addon_config SET pack2_price = 6291, pack3_price = 5942 WHERE addon_key = 'campanas_wa';
UPDATE addon_config SET pack2_price = 1791, pack3_price = 1692 WHERE addon_key = 'emails_campana';
UPDATE addon_config SET pack2_price = 5391, pack3_price = 5092 WHERE addon_key = 'staff';
UPDATE addon_config SET pack2_price = 8991, pack3_price = 8492 WHERE addon_key = 'sucursal';
UPDATE addon_config SET pack2_price = 4491, pack3_price = 4242 WHERE addon_key = 'group_capacity';

-- Verificación rápida tras correr el UPDATE:
-- SELECT addon_key, price, pack2_price, pack3_price FROM addon_config ORDER BY addon_key;
