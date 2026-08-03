-- Instrucciones para el cliente, configurables por servicio (ej. "Trae tu
-- carnet de identidad", "Ven con ropa cómoda"). Se muestran en el email de
-- confirmación de reserva (sendBookingEmail, email.js) cuando están seteadas;
-- si el servicio no tiene nada configurado, la sección se omite por completo.

alter table services
  add column if not exists customer_instructions text;
