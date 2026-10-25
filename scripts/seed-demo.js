#!/usr/bin/env node
/* eslint-disable no-console */
// =============================================================================
// scripts/seed-demo.js — 4 tenants DEMO con datos ficticios (videos y demos).
//
//   npm run seed:demo         crea los tenants demo que falten (idempotente:
//                             si un tenant demo ya existe, no lo toca)
//   npm run seed:demo:reset   borra SOLO los tenants con is_demo = true (y slug
//                             demo-*) con todos sus datos y los regenera
//
// Requisitos (.env en la raíz del repo, nunca en el código):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DEMO_PASSWORD
// y la migración 2026-10-24-demo-tenants.sql aplicada (columna tenants.is_demo).
//
// Inserta DIRECTO en Supabase (service role), sin llamar al backend. Las fechas
// son relativas a HOY en America/Santiago: 3 semanas de historia (completadas,
// algunas canceladas y no-show) y 3 semanas de agenda futura (~80% de ocupación
// en días laborales), siempre dentro del horario de cada profesional y sin
// choques. Todos los correos son @demo.orbyx.cl y los teléfonos +56900000xxx:
// email.js y whatsapp.js nunca les envían nada.
// =============================================================================

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const RESET = process.argv.includes("--reset");
const TZ = "America/Santiago";
const DEMO_EMAIL_DOMAIN = "demo.orbyx.cl";
const DEMO_SLUG_PREFIX = "demo-";
const PAST_DAYS = 21;
const FUTURE_DAYS = 21;
const FAR_FUTURE = "2099-12-31T23:59:59.000Z";

// Deben coincidir con LEGAL_TERMS_VERSION / LEGAL_PRIVACY_VERSION de server.js.
const LEGAL_DOCS = [
  { document_type: "terms", document_version: "1.1", document_url: "https://www.orbyx.cl/terminos" },
  { document_type: "privacy", document_version: "2.0", document_url: "https://www.orbyx.cl/privacidad" },
];

// ─── Utilidades ──────────────────────────────────────────────────────────────

function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

// PRNG determinista (mulberry32): mismos nombres/clientes en cada corrida.
function makeRng(seedText) {
  let seed = 0;
  for (const ch of seedText) seed = (Math.imul(31, seed) + ch.charCodeAt(0)) | 0;
  return function rng() {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rng, list) => list[Math.floor(rng() * list.length)];
const randInt = (rng, min, max) => min + Math.floor(rng() * (max - min + 1));
function weightedPick(rng, items, weightOf) {
  const total = items.reduce((sum, item) => sum + weightOf(item), 0);
  if (total <= 0) return null;
  let r = rng() * total;
  for (const item of items) {
    r -= weightOf(item);
    if (r < 0) return item;
  }
  return items[items.length - 1];
}
function shuffle(rng, list) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
const chunk = (list, size) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};
const slugifyEmail = (text) =>
  text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z]+/g, ".")
    .replace(/^\.+|\.+$/g, "");

// ─── Fechas en America/Santiago ──────────────────────────────────────────────

const partsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
function zonedParts(date) {
  const p = Object.fromEntries(partsFormatter.formatToParts(date).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}
function tzOffsetMs(date) {
  const p = zonedParts(date);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(date.getTime() / 1000) * 1000;
}
// "YYYY-MM-DD" + minutos desde medianoche (hora de Santiago) → Date UTC.
function santiagoToUtc(ymd, minutes) {
  const [y, m, d] = ymd.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
  let t = guess - tzOffsetMs(new Date(guess));
  const second = guess - tzOffsetMs(new Date(t));
  if (second !== t) t = second;
  return new Date(t);
}
function todaySantiago() {
  const p = zonedParts(new Date());
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}
function addDaysYmd(ymd, days) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
const dayOfWeek = (ymd) => new Date(`${ymd}T12:00:00Z`).getUTCDay(); // 0 = domingo
const hm = (text) => {
  const [h, m] = text.split(":").map(Number);
  return h * 60 + m;
};
const toTime = (minutes) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:00`;

// ─── Datos chilenos ficticios ────────────────────────────────────────────────

const MALE_NAMES = [
  "Matías", "Benjamín", "Vicente", "Martín", "Agustín", "Joaquín", "Tomás", "Sebastián", "Diego",
  "Nicolás", "Felipe", "Cristóbal", "Ignacio", "Lucas", "Maximiliano", "Gabriel", "Francisco",
  "José", "Juan Pablo", "Rodrigo", "Andrés", "Pablo", "Gonzalo", "Javier", "Claudio", "Mauricio",
  "Patricio", "Luis", "Carlos", "Jorge", "Bastián", "Alonso", "Fernando", "Esteban", "Héctor",
  "Ricardo", "Álvaro", "Daniel", "Camilo", "Eduardo",
];
const FEMALE_NAMES = [
  "Sofía", "Isidora", "Agustina", "Florencia", "Antonella", "Emilia", "Josefa", "Martina", "Trinidad",
  "Catalina", "Valentina", "Javiera", "Fernanda", "Constanza", "Camila", "Francisca", "Daniela",
  "Carolina", "María José", "Paula", "Macarena", "Bárbara", "Natalia", "Claudia", "Andrea",
  "Paulina", "Lorena", "Marcela", "Patricia", "Verónica", "Carla", "Ignacia", "Antonia", "Rocío",
  "Gabriela", "Pía", "Belén", "Victoria", "Romina", "Ximena",
];
const SURNAMES = [
  "González", "Muñoz", "Rojas", "Díaz", "Pérez", "Soto", "Contreras", "Silva", "Martínez",
  "Sepúlveda", "Morales", "Rodríguez", "López", "Fuentes", "Hernández", "Torres", "Araya", "Flores",
  "Espinoza", "Valenzuela", "Castillo", "Tapia", "Reyes", "Gutiérrez", "Castro", "Pizarro",
  "Álvarez", "Vásquez", "Sánchez", "Fernández", "Ramírez", "Carrasco", "Gómez", "Cortés", "Herrera",
  "Núñez", "Jara", "Vergara", "Rivera", "Figueroa", "Riquelme", "García", "Miranda", "Bravo", "Vera",
  "Molina", "Vega", "Campos", "Sandoval", "Orellana", "Cárdenas", "Olivares", "Alarcón", "Gallardo",
  "Ortiz", "Garrido", "Salazar", "Guzmán", "Henríquez", "Saavedra", "Navarro", "Aguilera", "Parra",
  "Romero", "Aravena", "Vidal", "Moreno", "Lagos", "Sáez", "Mella", "Quezada", "Burgos", "Ulloa",
];

// Teléfonos +56900000001..+56900000999, únicos entre los 4 tenants.
let phoneCounter = 0;
function nextDemoPhone() {
  phoneCounter += 1;
  if (phoneCounter > 999) fail("Se acabaron los teléfonos demo (+56900000xxx).");
  return `+56900000${String(phoneCounter).padStart(3, "0")}`;
}

function rutWithDv(body) {
  let sum = 0;
  let mul = 2;
  for (const digit of String(body).split("").reverse()) {
    sum += Number(digit) * mul;
    mul = mul === 7 ? 2 : mul + 1;
  }
  const dv = 11 - (sum % 11);
  const dvText = dv === 11 ? "0" : dv === 10 ? "K" : String(dv);
  return `${String(body).replace(/\B(?=(\d{3})+(?!\d))/g, ".")}-${dvText}`;
}

// ─── Definición de los 4 tenants ─────────────────────────────────────────────
// hours: { día(0=dom..6=sáb): [["10:00","14:00"], ...] }. Duraciones múltiplos de 15.

const WEEKDAYS = [1, 2, 3, 4, 5];
const hoursFor = (days, blocks) => Object.fromEntries(days.map((d) => [d, blocks]));

const TENANTS = [
  {
    key: "barberia",
    kind: "generic",
    slug: "demo-barberia-el-puerto",
    name: "Barbería El Puerto",
    category: "generic",
    subcategory: null,
    commune: "Talcahuano",
    address: "Av. Colón 1250",
    description:
      "Barbería clásica en el corazón de Talcahuano. Cortes, fades y arreglo de barba con navaja. Reserva tu hora en línea.",
    customers: 80,
    customerSex: { female: 0.08 },
    businessHours: { ...hoursFor(WEEKDAYS, [["10:00", "20:00"]]), 6: [["10:00", "18:00"]] },
    staff: [
      {
        key: "matias",
        name: "Matías Fuentes",
        role: "Barbero",
        color: "#0f766e",
        hours: { ...hoursFor(WEEKDAYS, [["10:00", "14:00"], ["15:00", "20:00"]]), 6: [["10:00", "14:00"]] },
      },
      {
        key: "cristobal",
        name: "Cristóbal Rojas",
        role: "Barbero",
        color: "#1d4ed8",
        hours: { ...hoursFor([2, 3, 4, 5], [["11:00", "15:00"], ["16:00", "20:00"]]), 6: [["10:00", "18:00"]] },
      },
      {
        key: "diego",
        name: "Diego Muñoz",
        role: "Barbero",
        color: "#b45309",
        hours: { ...hoursFor(WEEKDAYS, [["10:00", "14:00"], ["15:00", "19:00"]]), 6: [["10:00", "14:00"]] },
      },
    ],
    services: [
      { key: "corte", name: "Corte de pelo", duration: 30, price: 10000, weight: 30, staff: "*" },
      { key: "corte_barba", name: "Corte + barba", duration: 60, price: 15000, weight: 22, staff: "*" },
      { key: "barba", name: "Barba (arreglo completo)", duration: 30, price: 8000, weight: 12, staff: "*" },
      { key: "fade", name: "Fade / degradado", duration: 45, price: 12000, weight: 20, staff: "*" },
      { key: "perfilado", name: "Perfilado de cejas y contorno", duration: 30, price: 5000, weight: 6, staff: "*" },
      { key: "corte_nino", name: "Corte niño (hasta 12 años)", duration: 30, price: 8000, weight: 10, staff: ["matias", "diego"] },
    ],
  },
  {
    key: "nails",
    kind: "generic",
    slug: "demo-studio-nails-beauty",
    name: "Studio Nails & Beauty",
    category: "generic",
    subcategory: null,
    commune: "Concepción",
    address: "Barros Arana 845, local 12",
    description:
      "Manicure, pedicure, uñas acrílicas, pestañas y cejas en el centro de Concepción. Atención con hora agendada.",
    customers: 90,
    customerSex: { female: 0.92 },
    businessHours: { ...hoursFor(WEEKDAYS, [["10:00", "20:00"]]), 6: [["10:00", "17:00"]] },
    staff: [
      {
        key: "valentina",
        name: "Valentina Sepúlveda",
        role: "Manicurista",
        color: "#db2777",
        hours: { ...hoursFor(WEEKDAYS, [["10:00", "14:00"], ["15:00", "19:00"]]), 6: [["10:00", "17:00"]] },
      },
      {
        key: "javiera",
        name: "Javiera Contreras",
        role: "Manicurista y pedicurista",
        color: "#7c3aed",
        hours: { ...hoursFor([2, 3, 4, 5], [["11:00", "15:00"], ["16:00", "20:00"]]), 6: [["10:00", "17:00"]] },
      },
      {
        key: "fernanda",
        name: "Fernanda Araya",
        role: "Cosmetóloga",
        color: "#0891b2",
        hours: { ...hoursFor(WEEKDAYS, [["10:00", "14:00"], ["15:00", "19:00"]]) },
      },
    ],
    services: [
      { key: "manicure", name: "Manicure tradicional", duration: 45, price: 12000, weight: 18, staff: ["valentina", "javiera"] },
      { key: "pedicure", name: "Pedicure", duration: 60, price: 18000, weight: 14, staff: ["valentina", "javiera"] },
      { key: "permanente", name: "Esmaltado permanente", duration: 60, price: 15000, weight: 24, staff: ["valentina", "javiera", "fernanda"] },
      { key: "acrilicas", name: "Uñas acrílicas", duration: 120, price: 28000, weight: 12, staff: ["valentina", "javiera"] },
      { key: "lifting", name: "Lifting de pestañas", duration: 60, price: 22000, weight: 12, staff: ["fernanda"] },
      { key: "cejas", name: "Perfilado de cejas", duration: 30, price: 8000, weight: 14, staff: ["fernanda", "valentina"] },
      { key: "facial", name: "Limpieza facial profunda", duration: 90, price: 30000, weight: 8, staff: ["fernanda"] },
    ],
  },
  {
    key: "veterinaria",
    kind: "vet",
    slug: "demo-clinica-veterinaria-patitas",
    name: "Clínica Veterinaria Patitas",
    category: "vet",
    subcategory: null,
    commune: "San Pedro de la Paz",
    address: "Av. Michimalonco 1630",
    description:
      "Medicina preventiva, vacunas, cirugía menor y peluquería canina en San Pedro de la Paz. Cuidamos a tu familia de cuatro patas.",
    customers: 60,
    customerSex: { female: 0.55 },
    businessHours: { ...hoursFor(WEEKDAYS, [["09:00", "19:00"]]), 6: [["10:00", "14:00"]] },
    staff: [
      {
        key: "francisca",
        name: "Francisca Pérez",
        role: "Médico veterinario",
        color: "#15803d",
        hours: { ...hoursFor(WEEKDAYS, [["09:00", "13:00"], ["14:30", "18:30"]]) },
      },
      {
        key: "ignacio",
        name: "Ignacio Vergara",
        role: "Médico veterinario",
        color: "#2563eb",
        hours: { ...hoursFor(WEEKDAYS, [["10:00", "14:00"], ["15:00", "19:00"]]), 6: [["10:00", "14:00"]] },
      },
      {
        key: "sebastian",
        name: "Sebastián Tapia",
        role: "Peluquero canino",
        color: "#c2410c",
        hours: { ...hoursFor([2, 3, 4, 5], [["09:30", "13:30"], ["14:30", "18:30"]]), 6: [["10:00", "14:00"]] },
      },
    ],
    services: [
      { key: "consulta", name: "Consulta general", duration: 30, price: 20000, weight: 30, staff: ["francisca", "ignacio"] },
      { key: "vacuna", name: "Vacunación", duration: 30, price: 15000, weight: 20, staff: ["francisca", "ignacio"] },
      { key: "desparasitacion", name: "Desparasitación", duration: 15, price: 8000, weight: 12, staff: ["francisca", "ignacio"] },
      { key: "control", name: "Control", duration: 30, price: 12000, weight: 22, staff: ["francisca", "ignacio"] },
      { key: "cirugia", name: "Cirugía menor", duration: 90, price: 90000, weight: 5, staff: ["francisca", "ignacio"] },
      { key: "peluqueria", name: "Peluquería canina", duration: 90, price: 25000, weight: 1, staff: ["sebastian"] },
    ],
  },
  {
    key: "clinica",
    kind: "clinica",
    slug: "demo-centro-medico-biobio",
    name: "Centro Médico Biobío",
    category: "clinica",
    subcategory: "salud_general",
    commune: "Concepción",
    address: "O'Higgins 1120, oficina 504",
    description:
      "Centro de salud integral en Concepción: medicina general, kinesiología, nutrición y psicología. Atención particular, Fonasa e Isapres.",
    customers: 100,
    customerSex: { female: 0.56 },
    businessHours: { ...hoursFor(WEEKDAYS, [["08:30", "19:30"]]), 6: [["09:00", "13:00"]] },
    staff: [
      {
        key: "medicina",
        name: "Andrés Navarro",
        role: "Médico general",
        specialty: "medicina_general",
        color: "#0369a1",
        hours: { ...hoursFor(WEEKDAYS, [["08:30", "13:00"], ["14:00", "17:30"]]) },
      },
      {
        key: "kine",
        name: "Catalina Riquelme",
        role: "Kinesióloga",
        specialty: "kinesiologia",
        color: "#0d9488",
        hours: { ...hoursFor(WEEKDAYS, [["09:00", "13:00"], ["14:00", "19:00"]]) },
      },
      {
        key: "nutricion",
        name: "Daniela Cárdenas",
        role: "Nutricionista",
        specialty: "nutricion",
        color: "#65a30d",
        hours: { ...hoursFor([1, 3, 5], [["09:00", "13:00"], ["14:00", "18:00"]]), 6: [["09:00", "13:00"]] },
      },
      {
        key: "psico",
        name: "Tomás Saavedra",
        role: "Psicólogo clínico",
        specialty: "psicologia",
        color: "#9333ea",
        hours: { ...hoursFor([1, 2, 3, 4], [["10:00", "14:00"], ["15:00", "19:00"]]) },
      },
    ],
    services: [
      { key: "mg_consulta", name: "Consulta medicina general", duration: 30, price: 25000, weight: 14, staff: ["medicina"] },
      { key: "mg_control", name: "Control medicina general", duration: 15, price: 15000, weight: 8, staff: ["medicina"] },
      { key: "kine_eval", name: "Evaluación kinesiológica", duration: 60, price: 28000, weight: 4, staff: ["kine"] },
      { key: "kine_sesion", name: "Sesión de kinesiología", duration: 45, price: 22000, weight: 14, staff: ["kine"] },
      { key: "nut_consulta", name: "Consulta nutricional", duration: 45, price: 30000, weight: 6, staff: ["nutricion"] },
      { key: "nut_control", name: "Control nutricional", duration: 30, price: 20000, weight: 10, staff: ["nutricion"] },
      { key: "psi_eval", name: "Primera evaluación psicológica", duration: 60, price: 40000, weight: 3, staff: ["psico"] },
      { key: "psi_sesion", name: "Sesión de psicoterapia", duration: 60, price: 35000, weight: 14, staff: ["psico"] },
    ],
  },
];

// ─── Contenido clínico ficticio ──────────────────────────────────────────────

const PET_PROFILES = {
  perro: {
    breeds: ["Mestizo", "Labrador Retriever", "Poodle", "Golden Retriever", "Beagle", "Bulldog Francés", "Pastor Alemán", "Schnauzer", "Yorkshire Terrier", "Border Collie", "Shih Tzu", "Cocker Spaniel"],
    names: ["Rocky", "Luna", "Max", "Canela", "Toby", "Kira", "Simba", "Coco", "Bruno", "Maya", "Thor", "Nala", "Pancho", "Lola", "Zeus", "Frida", "Chester", "Mora", "Bobby", "Pelusa"],
    weight: [4, 38],
  },
  gato: {
    breeds: ["Doméstico pelo corto", "Doméstico pelo largo", "Siamés", "Persa", "Maine Coon", "Angora"],
    names: ["Michi", "Garfield", "Pelusa", "Nina", "Felix", "Mía", "Oliver", "Cleo", "Salem", "Manchas", "Tom", "Kitty"],
    weight: [3, 7],
  },
};
const VET_CASES = [
  { reason: "Vómitos y decaimiento hace 2 días", diagnosis: "Gastroenteritis aguda leve", treatment: "Dieta blanda 5 días, protector gástrico (omeprazol) y antiemético. Hidratación oral." },
  { reason: "Se rasca las orejas y sacude la cabeza", diagnosis: "Otitis externa bilateral", treatment: "Limpieza ótica y gotas óticas con antibiótico/corticoide cada 12 h por 10 días." },
  { reason: "Cojea de la extremidad posterior derecha", diagnosis: "Esguince leve de rodilla", treatment: "Reposo relativo 10 días, antiinflamatorio (meloxicam) 5 días. Control si no mejora." },
  { reason: "Picazón y pérdida de pelo en el lomo", diagnosis: "Dermatitis alérgica por pulgas", treatment: "Antiparasitario externo, baño con champú medicado y antihistamínico 7 días." },
  { reason: "Tos seca después de ir a la guardería", diagnosis: "Traqueobronquitis infecciosa (tos de las perreras)", treatment: "Antitusivo 7 días, reposo y evitar contacto con otros perros." },
  { reason: "Mal aliento y sarro visible", diagnosis: "Enfermedad periodontal grado II", treatment: "Se indica limpieza dental bajo sedación. Cepillado diario y snacks dentales." },
  { reason: "Diarrea intermitente", diagnosis: "Parasitosis intestinal", treatment: "Desparasitación interna y probióticos 5 días. Examen de deposiciones de control." },
  { reason: "Ojo derecho lloroso y enrojecido", diagnosis: "Conjuntivitis", treatment: "Lavado con suero fisiológico y colirio antibiótico cada 8 h por 7 días." },
];
const VACCINES = {
  perro: ["Vacuna óctuple (refuerzo anual)", "Vacuna antirrábica", "Vacuna KC (tos de las perreras)"],
  gato: ["Vacuna triple felina", "Vacuna antirrábica", "Vacuna leucemia felina"],
};
const SURGERIES = [
  { reason: "Masa subcutánea en costado izquierdo", diagnosis: "Lipoma", treatment: "Extirpación quirúrgica de lipoma. Antibiótico 7 días, analgésico 3 días, collar isabelino. Retiro de puntos en 10 días." },
  { reason: "Limpieza dental programada", diagnosis: "Enfermedad periodontal", treatment: "Destartraje y pulido bajo sedación, extracción de 1 pieza. Dieta blanda 3 días." },
  { reason: "Herida en almohadilla plantar", diagnosis: "Laceración de almohadilla", treatment: "Sutura y vendaje. Antibiótico 7 días, cambio de vendaje cada 48 h." },
];

const CLINIC_CASES = {
  medicina: [
    { reason: "Dolor de garganta, fiebre 38,5 °C y congestión", symptoms: "Odinofagia, fiebre, rinorrea", diagnosis: "Infección respiratoria alta", treatment: "Reposo, hidratación y paracetamol 500 mg cada 8 h por 3 días.", medications: "Paracetamol 500 mg", followup: "Consultar si la fiebre persiste más de 72 h." },
    { reason: "Control de presión arterial", symptoms: "Asintomático", diagnosis: "Hipertensión arterial en control", treatment: "Mantener tratamiento, dieta baja en sodio y actividad física 30 min diarios.", medications: "Losartán 50 mg cada 12 h", followup: "Control en 3 meses con exámenes." },
    { reason: "Dolor lumbar después de levantar peso", symptoms: "Lumbalgia sin irradiación", diagnosis: "Lumbago mecánico", treatment: "Calor local, analgesia y pausas activas. Derivación a kinesiología.", medications: "Ibuprofeno 400 mg cada 8 h por 5 días", referrals: "Kinesiología (8 sesiones)", followup: "Control en 2 semanas." },
    { reason: "Cansancio y sed frecuente", symptoms: "Polidipsia, fatiga", diagnosis: "Resistencia a la insulina (en estudio)", treatment: "Se solicitan exámenes de sangre. Recomendaciones de alimentación.", referrals: "Nutrición", followup: "Control con resultados de exámenes." },
    { reason: "Ardor al orinar", symptoms: "Disuria, polaquiuria", diagnosis: "Infección urinaria baja", treatment: "Antibiótico 5 días y abundante agua.", medications: "Nitrofurantoína 100 mg cada 12 h por 5 días", followup: "Urocultivo de control si persisten síntomas." },
    { reason: "Chequeo preventivo anual", symptoms: "Sin molestias", diagnosis: "Examen de salud preventivo", treatment: "Se indican exámenes de rutina y actualización de vacunas.", followup: "Revisar resultados en próximo control." },
  ],
  kine: [
    { reason: "Dolor lumbar mecánico", symptoms: "Dolor EVA 6/10 al flexionar tronco", diagnosis: "Lumbago mecánico", treatment: "Terapia manual, ejercicios de control motor y estabilización lumbar." },
    { reason: "Dolor de hombro derecho al levantar el brazo", symptoms: "Dolor en abducción sobre 90°", diagnosis: "Tendinopatía del manguito rotador", treatment: "Ejercicios excéntricos, electroanalgesia y fortalecimiento escapular." },
    { reason: "Rehabilitación post esguince de tobillo", symptoms: "Inestabilidad y edema leve", diagnosis: "Esguince de tobillo grado II en recuperación", treatment: "Propiocepción, fortalecimiento de peroneos y progresión a carga." },
    { reason: "Dolor cervical por trabajo en computador", symptoms: "Cervicalgia con rigidez matinal", diagnosis: "Cervicalgia postural", treatment: "Movilización cervical, elongación y educación ergonómica." },
    { reason: "Dolor de rodilla al correr", symptoms: "Dolor peripatelar al bajar escaleras", diagnosis: "Síndrome patelofemoral", treatment: "Fortalecimiento de cuádriceps y glúteo medio, ajuste de carga de entrenamiento." },
  ],
  nutricion: [
    { reason: "Bajar de peso", diagnosis: "Sobrepeso", treatment: "Pauta de alimentación de 1.600 kcal, 3 comidas y 2 colaciones. Aumentar agua y verduras.", bmi: [26, 29.5] },
    { reason: "Mejorar alimentación por resistencia a la insulina", diagnosis: "Resistencia a la insulina", treatment: "Pauta de bajo índice glicémico, fraccionar comidas y actividad física.", bmi: [27, 32] },
    { reason: "Aumentar masa muscular", diagnosis: "Estado nutricional normal", treatment: "Pauta hiperproteica (1,6 g/kg) y distribución de proteína en el día.", bmi: [21, 24.5] },
    { reason: "Control de colesterol alto", diagnosis: "Dislipidemia", treatment: "Reducir grasas saturadas y ultraprocesados, aumentar fibra y pescado 2 veces por semana.", bmi: [24, 28] },
  ],
  psico: [
    { reason: "Angustia y dificultad para dormir por estrés laboral", diagnosis: "Sintomatología ansiosa (en evaluación)", treatment: "Psicoeducación en ansiedad, técnicas de respiración y registro de pensamientos." },
    { reason: "Desánimo y pérdida de interés hace 2 meses", diagnosis: "Sintomatología depresiva leve", treatment: "Activación conductual y seguimiento semanal." },
    { reason: "Duelo por pérdida de un familiar", diagnosis: "Proceso de duelo", treatment: "Acompañamiento en duelo, validación emocional y red de apoyo." },
    { reason: "Conflictos de pareja y comunicación", diagnosis: "Dificultades vinculares", treatment: "Trabajo en habilidades de comunicación asertiva y regulación emocional." },
  ],
};
const ALLERGIES = ["Penicilina", "AINES", "Sulfas", "Látex", "Mariscos"];
const CHRONIC = ["Hipertensión arterial", "Diabetes mellitus tipo 2", "Hipotiroidismo", "Asma", "Dislipidemia"];
// [masculino, femenino]
const OCCUPATIONS = [
  ["Profesor", "Profesora"], ["Ingeniero", "Ingeniera"], ["Técnico en enfermería", "Técnica en enfermería"],
  ["Estudiante", "Estudiante"], ["Comerciante", "Comerciante"], ["Administrativo", "Administrativa"],
  ["Operario portuario", "Operaria portuaria"], ["Contador", "Contadora"], ["Vendedor", "Vendedora"],
  ["Conductor", "Conductora"], ["Diseñador", "Diseñadora"],
];
const INSURANCE = ["Fonasa", "Fonasa", "Fonasa", "Isapre", "Isapre", "Particular / Ninguna", "Capredena"];

// ─── Supabase ────────────────────────────────────────────────────────────────

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) fail("Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en el .env.");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

const isMissingRelationError = (error) =>
  Boolean(error) &&
  (["42P01", "PGRST205", "42703", "PGRST204"].includes(error.code) ||
    /does not exist|could not find the table|schema cache/i.test(error.message || ""));

async function insertRows(supabase, table, rows, size = 400) {
  for (const part of chunk(rows, size)) {
    const { error } = await supabase.from(table).insert(part);
    if (error) throw new Error(`insert en ${table}: ${error.message}`);
  }
}

// Columnas que este script escribe. Se verifican contra el esquema real antes
// de escribir nada: si falta alguna, aborta sin dejar datos a medias.
const REQUIRED_COLUMNS = {
  tenants:
    "id, name, slug, plan_slug, is_trial, trial_ends_at, billing_cycle_start, billing_cycle_end, business_category, business_subcategory, address, commune, region, phone, whatsapp, email, description, is_active, is_demo, dashboard_welcome_seen_at, wa_confirmation_enabled, wa_reminder_enabled, deposit_required",
  calendars: "id, tenant_id, name, timezone, is_active, slot_minutes, buffer_minutes",
  branches: "id, tenant_id, name, is_active, use_global_hours, use_global_special_dates, use_global_socials, use_global_contact",
  tenant_users: "user_id, tenant_id, role, phone, full_name, is_active",
  legal_acceptances: "tenant_id, user_id, document_type, document_version, document_url, accepted_at, ip_address, user_agent",
  business_hours: "tenant_id, branch_id, day_of_week, enabled, start_time, end_time",
  staff: "id, tenant_id, branch_id, name, role, email, phone, color, is_active, sort_order, use_business_hours",
  staff_hours: "tenant_id, branch_id, staff_id, day_of_week, block_order, enabled, start_time, end_time",
  services: "id, tenant_id, branch_id, name, description, duration_minutes, buffer_before_minutes, buffer_after_minutes, price, active, is_group, capacity",
  staff_services: "tenant_id, branch_id, staff_id, service_id",
  customers:
    "id, tenant_id, name, email, phone, rut, birth_date, sex, occupation, health_insurance, emergency_contact_name, emergency_contact_phone, known_allergies, chronic_conditions, total_visits, last_visit_at, imported_last_visit_at, imported_visit_count, created_at",
  pets: "id, tenant_id, customer_id, name, species_base, species_custom, breed, sex, weight_kg, is_sterilized, notes",
  appointments:
    "id, tenant_id, branch_id, calendar_id, service_id, staff_id, customer_id, pet_id, service_name_snapshot, duration_minutes_snapshot, customer_name, customer_phone, customer_email, start_at, end_at, source, status, reason, notes, cancel_token, canceled_at, created_at, wa_recordatorio_enviado, email_recordatorio_enviado",
  clinical_notes:
    "tenant_id, branch_id, customer_id, pet_id, appointment_id, staff_id, date, control_type, reason, symptoms, diagnosis, treatment, medications, referrals, follow_up_notes, observations, next_control_at, next_control_label, extra_fields",
};

async function preflight(supabase) {
  const problems = [];
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    const { error } = await supabase.from(table).select(columns).limit(1);
    if (error) problems.push(`- ${table}: ${error.message}`);
  }
  if (problems.length) {
    fail(
      `El esquema no calza con lo que el script necesita (no se escribió nada):\n${problems.join("\n")}\n` +
        "¿Aplicaste 2026-10-24-demo-tenants.sql en este proyecto de Supabase?"
    );
  }
}

async function findAuthUserByEmail(supabase, email) {
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`auth.listUsers: ${error.message}`);
    const found = (data?.users || []).find((u) => String(u.email || "").toLowerCase() === email);
    if (found) return found;
    if ((data?.users || []).length < 1000) return null;
  }
  return null;
}

async function ensureAuthUser(supabase, { email, password, fullName }) {
  const existing = await findAuthUserByEmail(supabase, email);
  if (existing) {
    const { error } = await supabase.auth.admin.updateUserById(existing.id, {
      password,
      email_confirm: true,
    });
    if (error) throw new Error(`no se pudo actualizar la contraseña de ${email}: ${error.message}`);
    return { id: existing.id, created: false };
  }
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName, is_demo: true },
  });
  if (error) throw new Error(`no se pudo crear el usuario ${email}: ${error.message}`);
  return { id: data.user.id, created: true };
}

// Borra un tenant demo y todo lo que cuelga de él. Doble candado: is_demo =
// true Y slug demo-*. Mismo orden que delete_tenant_cascade (FKs), más las
// tablas nuevas. Tablas que no existan en este proyecto se saltan.
const RESET_TABLES = [
  "campaign_delivery_logs", "campaign_history", "campaign_images", "whatsapp_message_log",
  "clinical_notes", "pet_followups", "pet_notes", "pet_vaccines", "review_replies", "reviews",
  "review_request_tokens", "appointments", "calendar_connections", "staff_services", "staff_hours",
  "staff_special_dates", "staff", "blocked_contacts", "pets", "customers", "customer_imports",
  "availability_exceptions", "working_hours", "business_hours", "business_special_dates",
  "branch_access", "calendar_tokens", "calendars", "services", "service_groups", "branches",
  "tenant_addons", "tenant_monthly_usage", "addon_auto_charge_consents", "subscriptions",
  "support_ticket_messages", "support_tickets", "email_change_requests", "tenant_invitations",
  "signup_intents", "security_audit_log", "channels", "addon_purchase_intents",
  "marketing_email_preferences", "admin_tenant_notes", "admin_tenant_actions",
  "legal_acceptances", "tenant_users",
];

async function resetDemoTenants(supabase) {
  const { data: demoTenants, error } = await supabase
    .from("tenants")
    .select("id, slug, name")
    .eq("is_demo", true)
    .like("slug", `${DEMO_SLUG_PREFIX}%`);
  if (error) throw new Error(`no se pudieron leer los tenants demo: ${error.message}`);
  if (!demoTenants?.length) {
    console.log("  (no había tenants demo que borrar)");
    return;
  }
  const ids = demoTenants.map((t) => t.id);

  for (const table of RESET_TABLES) {
    const query =
      table === "support_ticket_messages"
        ? null // se borra vía support_tickets más abajo
        : supabase.from(table).delete().in("tenant_id", ids);
    if (!query) {
      const { data: tickets, error: ticketsErr } = await supabase
        .from("support_tickets")
        .select("id")
        .in("tenant_id", ids);
      if (ticketsErr && isMissingRelationError(ticketsErr)) continue;
      if (ticketsErr) throw new Error(`support_tickets: ${ticketsErr.message}`);
      if (tickets?.length) {
        const { error: msgErr } = await supabase
          .from("support_ticket_messages")
          .delete()
          .in("ticket_id", tickets.map((t) => t.id));
        if (msgErr && !isMissingRelationError(msgErr)) throw new Error(`support_ticket_messages: ${msgErr.message}`);
      }
      continue;
    }
    const { error: delErr } = await query;
    if (delErr && !isMissingRelationError(delErr)) {
      throw new Error(`borrando ${table}: ${delErr.message}`);
    }
  }

  const { error: tenantErr } = await supabase
    .from("tenants")
    .delete()
    .in("id", ids)
    .eq("is_demo", true)
    .like("slug", `${DEMO_SLUG_PREFIX}%`);
  if (tenantErr) throw new Error(`borrando tenants demo: ${tenantErr.message}`);

  for (const t of demoTenants) console.log(`  borrado: ${t.name} (${t.slug})`);
}

// ─── Generación de un tenant ─────────────────────────────────────────────────

function buildPerson(rng, femaleRatio) {
  const female = rng() < femaleRatio;
  const first = pick(rng, female ? FEMALE_NAMES : MALE_NAMES);
  const last1 = pick(rng, SURNAMES);
  let last2 = pick(rng, SURNAMES);
  while (last2 === last1) last2 = pick(rng, SURNAMES);
  const fullName = rng() < 0.6 ? `${first} ${last1} ${last2}` : `${first} ${last1}`;
  return { female, first, last1, last2, fullName };
}

function generateCustomers(rng, def) {
  const usedEmails = new Set();
  const customers = [];
  const staffKeys = def.staff.map((s) => s.key);
  for (let i = 0; i < def.customers; i++) {
    const person = buildPerson(rng, def.customerSex.female);
    let email = `${slugifyEmail(`${person.first}.${person.last1}`)}@${DEMO_EMAIL_DOMAIN}`;
    let n = 2;
    while (usedEmails.has(email)) email = `${slugifyEmail(`${person.first}.${person.last1}`)}${n++}@${DEMO_EMAIL_DOMAIN}`;
    usedEmails.add(email);

    // Perfil de frecuencia: 8% prospectos (nunca vinieron), 15% "dormidos"
    // (historial antiguo, salen como En riesgo / Inactivo), resto activos.
    const roll = rng();
    const profile = roll < 0.08 ? "prospect" : roll < 0.23 ? "dormant" : "active";
    const weight = profile !== "active" ? 0 : pick(rng, [1, 1, 2, 2, 3, 4]);

    // Profesionales habituales: en la clínica cada paciente se atiende con
    // 1-2 especialidades; en el resto prefiere 1-2 profesionales.
    const prefs = shuffle(rng, staffKeys).slice(0, rng() < 0.7 ? 1 : 2);
    if (def.kind === "vet") {
      // Los tutores van con cualquiera de los 2 veterinarios; el peluquero
      // atiende a quien pida peluquería.
      prefs.splice(0, prefs.length, ...staffKeys);
    }

    const row = {
      id: crypto.randomUUID(),
      tenant_id: def.tenantId,
      name: person.fullName,
      email,
      phone: nextDemoPhone(),
      created_at: null, // se completa con la primera cita
    };

    if (def.kind === "clinica") {
      const age = randInt(rng, 18, 78);
      const birthYear = new Date().getFullYear() - age;
      row.rut = rutWithDv(randInt(rng, age > 60 ? 5000000 : 9000000, age > 60 ? 9900000 : 24900000));
      row.birth_date = `${birthYear}-${String(randInt(rng, 1, 12)).padStart(2, "0")}-${String(randInt(rng, 1, 28)).padStart(2, "0")}`;
      row.sex = person.female ? "femenino" : "masculino";
      row.occupation = age > 66 ? (person.female ? "Jubilada" : "Jubilado") : pick(rng, OCCUPATIONS)[person.female ? 1 : 0];
      row.health_insurance = pick(rng, INSURANCE);
      const contact = buildPerson(rng, 0.5);
      row.emergency_contact_name = `${contact.first} ${person.last1}`;
      row.emergency_contact_phone = nextDemoPhone();
      row.known_allergies = rng() < 0.18 ? pick(rng, ALLERGIES) : null;
      row.chronic_conditions = age > 45 && rng() < 0.4 ? pick(rng, CHRONIC) : null;
    }

    customers.push({ row, profile, weight, prefs, lastDay: null, cases: {} });
  }
  return customers;
}

function generatePets(rng, def, customers) {
  const pets = [];
  for (const customer of customers) {
    const count = rng() < 0.3 ? 2 : 1;
    customer.pets = [];
    for (let i = 0; i < count; i++) {
      const species = rng() < 0.72 ? "perro" : "gato";
      const profile = PET_PROFILES[species];
      const age = rng() < 0.15 ? 0 : randInt(rng, 1, 14);
      const ageText = age === 0 ? `${randInt(rng, 3, 11)} meses` : `${age} ${age === 1 ? "año" : "años"}`;
      const pet = {
        id: crypto.randomUUID(),
        tenant_id: def.tenantId,
        customer_id: customer.row.id,
        name: pick(rng, profile.names),
        species_base: species,
        species_custom: null,
        breed: pick(rng, profile.breeds),
        sex: rng() < 0.5 ? "macho" : "hembra",
        weight_kg: Math.round((profile.weight[0] + rng() * (profile.weight[1] - profile.weight[0])) * 10) / 10,
        is_sterilized: age >= 1 && rng() < 0.65,
        notes: `Edad aprox.: ${ageText}.`,
      };
      pets.push(pet);
      customer.pets.push({ ...pet, ageYears: age });
    }
  }
  return pets;
}

// Llena cada bloque de horario de cada profesional con citas consecutivas
// (inicio alineado a 15 min) hasta la ocupación objetivo, repartiendo el
// tiempo libre como huecos. Nunca se sale del bloque ni se superpone.
function planDay(rng, blockStart, blockEnd, services, occupancy) {
  const length = blockEnd - blockStart;
  const target = Math.round(length * occupancy);
  const picked = [];
  let used = 0;
  for (let guard = 0; guard < 50; guard++) {
    const fitting = services.filter((s) => used + s.duration <= length);
    if (!fitting.length) break;
    if (used >= target) break;
    const service = weightedPick(rng, fitting, (s) => s.weight);
    if (used + service.duration > target + 15 && rng() < 0.7) {
      const small = fitting.filter((s) => used + s.duration <= target + 15);
      if (!small.length) break;
      const alt = weightedPick(rng, small, (s) => s.weight);
      picked.push(alt);
      used += alt.duration;
      continue;
    }
    picked.push(service);
    used += service.duration;
  }
  // Huecos en unidades de 15 min, repartidos al azar entre las citas.
  const freeUnits = Math.floor((length - used) / 15);
  const gaps = new Array(picked.length + 1).fill(0);
  for (let i = 0; i < freeUnits; i++) gaps[Math.floor(rng() * gaps.length)] += 1;
  const result = [];
  let cursor = blockStart + gaps[0] * 15;
  picked.forEach((service, index) => {
    result.push({ service, start: cursor, end: cursor + service.duration });
    cursor += service.duration + gaps[index + 1] * 15;
  });
  return result.filter((slot) => slot.end <= blockEnd);
}

function chooseCustomer(rng, customers, staffKey, ymd, kind) {
  const recentDay = (c) => c.lastDay && Math.abs(Date.parse(ymd) - Date.parse(c.lastDay)) < 3 * 86400000;
  const base = customers.filter((c) => c.weight > 0 && c.lastDay !== ymd);
  let pool = base.filter((c) => c.prefs.includes(staffKey) && !recentDay(c));
  if (kind === "clinica" && !pool.length) pool = base.filter((c) => c.prefs.includes(staffKey));
  if (!pool.length) pool = base.filter((c) => !recentDay(c));
  if (!pool.length) pool = base;
  return weightedPick(rng, pool, (c) => c.weight);
}

function vetNoteFor(rng, serviceKey, pet, date) {
  if (serviceKey === "vacuna") {
    const vaccine = pick(rng, VACCINES[pet.species_base]);
    const next = new Date(`${date}T12:00:00Z`);
    next.setUTCFullYear(next.getUTCFullYear() + 1);
    return {
      control_type: "Vacuna",
      reason: vaccine,
      diagnosis: "Paciente sano, apto para vacunación",
      treatment: `Se administra ${vaccine.toLowerCase()}. Sin reacciones inmediatas.`,
      observations: `Peso ${pet.weight_kg} kg. Temperatura normal. Mucosas rosadas.`,
      next_control_at: next.toISOString(),
      next_control_label: "1 año",
    };
  }
  if (serviceKey === "desparasitacion") {
    const next = new Date(`${date}T12:00:00Z`);
    next.setUTCMonth(next.getUTCMonth() + 3);
    return {
      control_type: "Procedimiento",
      reason: "Desparasitación interna y externa",
      diagnosis: "Control preventivo",
      treatment: `Antiparasitario interno según peso (${pet.weight_kg} kg) y pipeta externa.`,
      observations: "Tutor informado del próximo refuerzo.",
      next_control_at: next.toISOString(),
      next_control_label: "3 meses",
    };
  }
  if (serviceKey === "cirugia") {
    const c = pick(rng, SURGERIES);
    return { control_type: "Procedimiento", reason: c.reason, diagnosis: c.diagnosis, treatment: c.treatment, observations: "Recuperación anestésica sin complicaciones. Alta el mismo día.", next_control_at: null, next_control_label: "10 días" };
  }
  if (serviceKey === "control") {
    return { control_type: "Control", reason: "Control post tratamiento", diagnosis: "Evolución favorable", treatment: "Se completa tratamiento indicado. Alta del cuadro.", observations: `Peso ${pet.weight_kg} kg. Tutor refiere buen apetito y ánimo.`, next_control_at: null, next_control_label: null };
  }
  const c = pick(rng, VET_CASES);
  return { control_type: "Consulta", reason: c.reason, diagnosis: c.diagnosis, treatment: c.treatment, observations: `Peso ${pet.weight_kg} kg. ${pet.species_base === "perro" ? "Perro" : "Gato"} ${pet.breed.toLowerCase()}.`, next_control_at: null, next_control_label: "7 días" };
}

function clinicNoteFor(rng, staffKey, serviceKey, customer, visitIndex) {
  const cases = CLINIC_CASES[staffKey];
  if (!customer.cases[staffKey]) customer.cases[staffKey] = pick(rng, cases);
  const c = customer.cases[staffKey];
  const firstVisit = visitIndex === 0;
  const note = {
    control_type: firstVisit ? "Consulta" : "Control",
    reason: firstVisit ? c.reason : `Control: ${c.reason.charAt(0).toLowerCase()}${c.reason.slice(1)}`,
    symptoms: c.symptoms || null,
    diagnosis: c.diagnosis,
    treatment: c.treatment,
    medications: c.medications || null,
    referrals: firstVisit ? c.referrals || null : null,
    follow_up_notes: c.followup || null,
    observations: firstVisit
      ? "Paciente orientado, colaborador. Se explica plan de tratamiento."
      : pick(rng, ["Evolución favorable respecto a la sesión anterior.", "Refiere mejoría parcial. Se ajustan indicaciones.", "Buena adherencia a las indicaciones."]),
    extra_fields: null,
  };
  if (staffKey === "kine") {
    note.observations = `${note.observations} Sesión ${visitIndex + 1}.`;
  }
  if (staffKey === "medicina" || staffKey === "nutricion") {
    const talla = customer.row.sex === "femenino" ? randInt(rng, 152, 172) : randInt(rng, 163, 185);
    const bmiRange = c.bmi || [21, 30];
    const bmi = bmiRange[0] + rng() * (bmiRange[1] - bmiRange[0]) - visitIndex * 0.3;
    const peso = Math.round(bmi * (talla / 100) ** 2 * 10) / 10;
    note.extra_fields = {
      peso_kg: String(peso),
      talla_cm: String(talla),
      imc: (peso / (talla / 100) ** 2).toFixed(1),
    };
  }
  if (serviceKey === "psi_eval") note.control_type = "Evaluación";
  return note;
}

async function seedTenant(supabase, def, password) {
  const rng = makeRng(`orbyx-demo-${def.key}`);
  const nowIso = new Date().toISOString();
  const email = `demo-${def.key}@${DEMO_EMAIL_DOMAIN}`;
  const ownerPhone = nextDemoPhone();
  const businessPhone = nextDemoPhone();

  // 1. Tenant (sin trial, ciclo hasta 2099 → nunca se bloquea).
  def.tenantId = crypto.randomUUID();
  const { error: tenantErr } = await supabase.from("tenants").insert({
    id: def.tenantId,
    name: def.name,
    slug: def.slug,
    plan_slug: "premium",
    is_trial: false,
    trial_ends_at: null,
    billing_cycle_start: nowIso,
    billing_cycle_end: FAR_FUTURE,
    business_category: def.category,
    business_subcategory: def.subcategory,
    address: def.address,
    commune: def.commune,
    region: "Región del Biobío",
    phone: businessPhone,
    whatsapp: businessPhone,
    email,
    description: def.description,
    is_active: true,
    is_demo: true,
    dashboard_welcome_seen_at: nowIso,
    wa_confirmation_enabled: false,
    wa_reminder_enabled: false,
    deposit_required: false,
  });
  if (tenantErr) throw new Error(`creando tenant ${def.slug}: ${tenantErr.message}`);

  const calendarId = crypto.randomUUID();
  const branchId = crypto.randomUUID();
  await insertRows(supabase, "calendars", [
    { id: calendarId, tenant_id: def.tenantId, name: "Agenda Principal", timezone: TZ, is_active: true, slot_minutes: 30, buffer_minutes: 0 },
  ]);
  await insertRows(supabase, "branches", [
    { id: branchId, tenant_id: def.tenantId, name: "Principal", is_active: true, use_global_hours: true, use_global_special_dates: true, use_global_socials: true, use_global_contact: true },
  ]);

  // 2. Usuario dueño + términos aceptados (entra directo al panel).
  const ownerName = `Demo ${def.name}`;
  const authUser = await ensureAuthUser(supabase, { email, password, fullName: ownerName });
  await insertRows(supabase, "tenant_users", [
    { user_id: authUser.id, tenant_id: def.tenantId, role: "owner", phone: ownerPhone, full_name: ownerName, is_active: true },
  ]);
  await insertRows(
    supabase,
    "legal_acceptances",
    LEGAL_DOCS.map((doc) => ({
      ...doc,
      tenant_id: def.tenantId,
      user_id: authUser.id,
      accepted_at: nowIso,
      ip_address: null,
      user_agent: "scripts/seed-demo.js",
    }))
  );

  // 3. Horario del negocio (global) y profesionales con su horario propio.
  const businessHours = [];
  for (let day = 0; day <= 6; day++) {
    const blocks = def.businessHours[day];
    if (!blocks) {
      businessHours.push({ tenant_id: def.tenantId, branch_id: null, day_of_week: day, enabled: false, start_time: null, end_time: null });
      continue;
    }
    for (const [start, end] of blocks) {
      businessHours.push({ tenant_id: def.tenantId, branch_id: null, day_of_week: day, enabled: true, start_time: toTime(hm(start)), end_time: toTime(hm(end)) });
    }
  }
  await insertRows(supabase, "business_hours", businessHours);

  const staffIds = {};
  const staffRows = def.staff.map((s, index) => {
    staffIds[s.key] = crypto.randomUUID();
    return {
      id: staffIds[s.key],
      tenant_id: def.tenantId,
      branch_id: branchId,
      name: s.name,
      role: s.role,
      email: `${slugifyEmail(s.name)}@${DEMO_EMAIL_DOMAIN}`,
      phone: nextDemoPhone(),
      color: s.color,
      is_active: true,
      sort_order: index,
      use_business_hours: false,
    };
  });
  await insertRows(supabase, "staff", staffRows);

  const staffHours = [];
  for (const s of def.staff) {
    for (const [day, blocks] of Object.entries(s.hours)) {
      const businessBlocks = def.businessHours[day] || [];
      blocks.forEach(([start, end], index) => {
        const inside = businessBlocks.some(([bs, be]) => hm(start) >= hm(bs) && hm(end) <= hm(be));
        if (!inside) throw new Error(`${def.name}: horario de ${s.name} (${day} ${start}-${end}) fuera del horario del negocio`);
        staffHours.push({ tenant_id: def.tenantId, branch_id: branchId, staff_id: staffIds[s.key], day_of_week: Number(day), block_order: index + 1, enabled: true, start_time: toTime(hm(start)), end_time: toTime(hm(end)) });
      });
    }
  }
  await insertRows(supabase, "staff_hours", staffHours);

  // 4. Servicios y quién los hace.
  const serviceIds = {};
  await insertRows(
    supabase,
    "services",
    def.services.map((svc) => {
      serviceIds[svc.key] = crypto.randomUUID();
      return {
        id: serviceIds[svc.key],
        tenant_id: def.tenantId,
        branch_id: branchId,
        name: svc.name,
        description: null,
        duration_minutes: svc.duration,
        buffer_before_minutes: 0,
        buffer_after_minutes: 0,
        price: svc.price,
        active: true,
        is_group: false,
        capacity: 1,
      };
    })
  );
  const servicesByStaff = {};
  const staffServices = [];
  for (const s of def.staff) {
    servicesByStaff[s.key] = def.services.filter((svc) => svc.staff === "*" || svc.staff.includes(s.key));
    for (const svc of servicesByStaff[s.key]) {
      staffServices.push({ tenant_id: def.tenantId, branch_id: branchId, staff_id: staffIds[s.key], service_id: serviceIds[svc.key] });
    }
  }
  await insertRows(supabase, "staff_services", staffServices);

  // 5. Clientes (y mascotas en la veterinaria).
  const customers = generateCustomers(rng, def);
  const pets = def.kind === "vet" ? generatePets(rng, def, customers) : [];

  // 6. Citas: -21 días a +21 días desde hoy (hora de Santiago).
  const today = todaySantiago();
  const now = Date.now();
  const appointments = [];
  const clinicalNotes = [];
  const visitCounter = new Map();
  let futureCapacity = 0;
  let futureBooked = 0;

  for (let offset = -PAST_DAYS; offset <= FUTURE_DAYS; offset++) {
    const ymd = addDaysYmd(today, offset);
    const dow = dayOfWeek(ymd);
    for (const s of def.staff) {
      const blocks = s.hours[dow];
      if (!blocks) continue;
      const services = servicesByStaff[s.key];
      for (const [startText, endText] of blocks) {
        const blockStart = hm(startText);
        const blockEnd = hm(endText);
        // Ocupación objetivo: 75-85% entre semana, algo más los sábados;
        // la agenda futura lejana un poco más liviana.
        let occupancy = 0.75 + rng() * 0.1;
        if (dow === 6) occupancy = Math.min(0.92, occupancy + 0.06);
        if (offset > 14) occupancy -= 0.05;
        if (offset < 0) occupancy = 0.72 + rng() * 0.15;

        for (const slot of planDay(rng, blockStart, blockEnd, services, occupancy)) {
          const customer = chooseCustomer(rng, customers, s.key, ymd, def.kind);
          if (!customer) continue;
          customer.lastDay = ymd;

          let pet = null;
          if (def.kind === "vet") {
            const candidates = slot.service.key === "peluqueria" ? customer.pets.filter((p) => p.species_base === "perro") : customer.pets;
            pet = pick(rng, candidates.length ? candidates : customer.pets);
          }

          const startAt = santiagoToUtc(ymd, slot.start);
          const endAt = santiagoToUtc(ymd, slot.end);
          const isPast = endAt.getTime() <= now;
          let status = "booked";
          if (isPast) {
            const roll = rng();
            status = roll < 0.85 ? "completed" : roll < 0.94 ? "canceled" : "no_show";
          } else if (startAt.getTime() > now && rng() < 0.04) {
            status = "canceled";
          }

          if (offset >= 0 && dow >= 1 && dow <= 5 && status === "booked") {
            futureBooked += slot.end - slot.start;
          }

          // Creada entre 1 y 14 días antes de la hora, y siempre >26 h atrás:
          // así no cuenta para los topes de reservas públicas de las últimas 24 h.
          const createdAt = new Date(Math.min(startAt.getTime() - randInt(rng, 1, 14) * 86400000, now - (26 + randInt(rng, 0, 72)) * 3600000));
          const id = crypto.randomUUID();
          appointments.push({
            id,
            tenant_id: def.tenantId,
            branch_id: branchId,
            calendar_id: calendarId,
            service_id: serviceIds[slot.service.key],
            staff_id: staffIds[s.key],
            customer_id: customer.row.id,
            pet_id: pet ? pet.id : null,
            service_name_snapshot: slot.service.name,
            duration_minutes_snapshot: slot.service.duration,
            customer_name: customer.row.name,
            customer_phone: customer.row.phone,
            customer_email: customer.row.email,
            start_at: startAt.toISOString(),
            end_at: endAt.toISOString(),
            source: rng() < 0.65 ? "public_page" : "dashboard",
            status,
            reason: null,
            notes: null,
            cancel_token: crypto.randomBytes(24).toString("hex"),
            canceled_at: status === "canceled" ? new Date(Math.min(startAt.getTime() - 3600000 * randInt(rng, 2, 48), now)).toISOString() : null,
            created_at: createdAt.toISOString(),
            wa_recordatorio_enviado: true,
            email_recordatorio_enviado: true,
          });
          if (!customer.row.created_at || createdAt.toISOString() < customer.row.created_at) {
            customer.row.created_at = createdAt.toISOString();
          }

          // Fichas clínicas en las atenciones ya realizadas.
          if (status === "completed" && (def.kind === "vet" || def.kind === "clinica") && slot.service.key !== "peluqueria") {
            const key = `${customer.row.id}:${s.key}`;
            const visitIndex = visitCounter.get(key) || 0;
            visitCounter.set(key, visitIndex + 1);
            const base = def.kind === "vet" ? vetNoteFor(rng, slot.service.key, pet, ymd) : clinicNoteFor(rng, s.key, slot.service.key, customer, visitIndex);
            clinicalNotes.push({
              tenant_id: def.tenantId,
              branch_id: branchId,
              customer_id: customer.row.id,
              pet_id: pet ? pet.id : null,
              appointment_id: id,
              staff_id: staffIds[s.key],
              date: ymd,
              control_type: base.control_type,
              reason: base.reason,
              symptoms: base.symptoms || null,
              diagnosis: base.diagnosis,
              treatment: base.treatment,
              medications: base.medications || null,
              referrals: base.referrals || null,
              follow_up_notes: base.follow_up_notes || null,
              observations: base.observations || null,
              next_control_at: base.next_control_at || null,
              next_control_label: base.next_control_label || null,
              extra_fields: base.extra_fields || null,
            });
            const appt = appointments[appointments.length - 1];
            appt.reason = base.reason;
            appt.notes = base.observations || null;
          }
        }
      }
    }
  }

  // Ocupación real de la agenda futura (lun-vie) para el resumen.
  for (let offset = 0; offset <= FUTURE_DAYS; offset++) {
    const dow = dayOfWeek(addDaysYmd(today, offset));
    if (dow < 1 || dow > 5) continue;
    for (const s of def.staff) {
      for (const [a, b] of s.hours[dow] || []) futureCapacity += hm(b) - hm(a);
    }
  }

  // 7. Estadísticas de cliente (mismo criterio que recalculateCustomerStats)
  //    e historial "importado" para los dormidos (salen En riesgo / Inactivo).
  for (const customer of customers) {
    const own = appointments.filter((a) => a.customer_id === customer.row.id && a.status !== "canceled");
    customer.row.total_visits = own.length;
    customer.row.last_visit_at = own.length ? own.map((a) => a.start_at).sort().pop() : null;
    customer.row.imported_last_visit_at = null;
    customer.row.imported_visit_count = null;
    if (customer.profile === "dormant") {
      const daysAgo = rng() < 0.55 ? randInt(rng, 65, 115) : randInt(rng, 130, 320);
      customer.row.imported_last_visit_at = new Date(now - daysAgo * 86400000).toISOString();
      customer.row.imported_visit_count = randInt(rng, 1, 9);
      customer.row.created_at = new Date(now - (daysAgo + randInt(rng, 30, 400)) * 86400000).toISOString();
    }
    if (!customer.row.created_at) {
      customer.row.created_at = new Date(now - randInt(rng, 1, 40) * 86400000).toISOString();
    }
  }

  await insertRows(supabase, "customers", customers.map((c) => c.row));
  if (pets.length) await insertRows(supabase, "pets", pets);
  // Por día y profesional, en orden: el trigger appointments_booking_guard
  // valida cada fila y no hay choques posibles.
  await insertRows(supabase, "appointments", appointments, 300);
  if (clinicalNotes.length) await insertRows(supabase, "clinical_notes", clinicalNotes, 300);

  const count = (st) => appointments.filter((a) => a.status === st).length;
  return {
    name: def.name,
    slug: def.slug,
    email,
    staff: def.staff.length,
    services: def.services.length,
    customers: customers.length,
    pets: pets.length,
    appointments: appointments.length,
    completed: count("completed"),
    canceled: count("canceled"),
    noShow: count("no_show"),
    booked: count("booked"),
    clinicalNotes: clinicalNotes.length,
    occupancy: futureCapacity ? Math.round((futureBooked / futureCapacity) * 100) : 0,
    authCreated: authUser.created,
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const password = process.env.DEMO_PASSWORD;
  if (!password) fail("Falta DEMO_PASSWORD en el .env.");
  const supabase = getSupabase();

  console.log(`Orbyx · seed demo ${RESET ? "(--reset)" : ""}`);
  console.log(`Proyecto: ${process.env.SUPABASE_URL}`);
  await preflight(supabase);

  if (RESET) {
    console.log("Borrando tenants demo existentes…");
    await resetDemoTenants(supabase);
  }

  const results = [];
  for (const def of TENANTS) {
    const { data: existing, error } = await supabase
      .from("tenants")
      .select("id, is_demo")
      .eq("slug", def.slug)
      .maybeSingle();
    if (error) throw new Error(`leyendo ${def.slug}: ${error.message}`);
    if (existing && !existing.is_demo) {
      fail(`El slug ${def.slug} pertenece a un tenant REAL (is_demo = false). No se toca nada.`);
    }
    if (existing) {
      console.log(`• ${def.name}: ya existe, se deja igual (usa npm run seed:demo:reset para regenerarlo).`);
      continue;
    }
    console.log(`• Creando ${def.name}…`);
    results.push(await seedTenant(supabase, def, password));
  }

  if (results.length) {
    console.log("\nResumen:");
    console.table(
      results.map((r) => ({
        tenant: r.name,
        login: r.email,
        staff: r.staff,
        servicios: r.services,
        clientes: r.customers,
        mascotas: r.pets || "-",
        citas: r.appointments,
        completadas: r.completed,
        canceladas: r.canceled,
        no_show: r.noShow,
        futuras: r.booked,
        fichas: r.clinicalNotes || "-",
        "ocupación futura L-V": `${r.occupancy}%`,
      }))
    );
  }
  console.log(`\nListo. Contraseña de los 4 usuarios demo: la de DEMO_PASSWORD en tu .env.`);
}

if (require.main === module) {
  main().catch((err) =>
    fail(
      `${err.message || String(err)}\n  Si un tenant quedó a medias, corre: npm run seed:demo:reset`
    )
  );
}

module.exports = { TENANTS, planDay, santiagoToUtc, todaySantiago, rutWithDv, seedTenant, preflight, resetDemoTenants };
