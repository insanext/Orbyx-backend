// imageCompression.js
// Compresión/resize compartida para toda subida de imagen a Supabase
// Storage, aplicada server-side antes de subir el buffer final. 3 perfiles
// (duplicados también en orbyx-web/lib/imageCompression.ts porque ese
// frontend es un repo/deploy separado y no puede importar de acá):
//
// - avatar: foto de staff / logo del negocio.
// - campana: imágenes de campañas WhatsApp/email.
// - documento: comprobante de depósito / adjunto de ticket, con reducción
//   de calidad en pasos hasta quedar bajo maxBytes (o llegar al piso).
const sharp = require("sharp");

const PROFILES = {
  avatar: { maxWidth: 800, format: "webp", quality: 80 },
  campana: { maxWidth: 1600, format: "webp", quality: 83 },
  documento: {
    maxWidth: 2200,
    format: "jpeg",
    qualitySteps: [90, 85, 80, 75],
    maxBytes: 2 * 1024 * 1024,
  },
};

async function compressImage(buffer, profileName) {
  const profile = PROFILES[profileName];
  if (!profile) {
    throw new Error(`Perfil de compresión desconocido: ${profileName}`);
  }

  const pipeline = sharp(buffer, { failOn: "none" })
    .rotate()
    .resize({ width: profile.maxWidth, withoutEnlargement: true });

  if (profile.format === "jpeg") {
    let out = null;
    for (const quality of profile.qualitySteps) {
      out = await pipeline.clone().jpeg({ quality, mozjpeg: true }).toBuffer();
      if (out.length <= profile.maxBytes) break;
    }
    return { buffer: out, contentType: "image/jpeg", extension: "jpg" };
  }

  const out = await pipeline.webp({ quality: profile.quality }).toBuffer();
  return { buffer: out, contentType: "image/webp", extension: "webp" };
}

module.exports = { compressImage, PROFILES };
