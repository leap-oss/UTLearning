import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { z } from 'zod';
import { getEnvConfig } from '../../config/env.js';

export const SOURCE_LABELS = ['rangkuman', 'tes_formatif', 'materi'];
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export function isUtBoilerplateScoringFormula(text) {
  const lower = String(text || '').toLowerCase();
  if (!lower.trim()) return true;
  if (
    lower.includes('tingkat penguasaan') ||
    lower.includes('jumlah jawaban yang benar') ||
    lower.includes('jumlah jawaban benar') ||
    (lower.includes('70%') && lower.includes('79%') && lower.includes('80%')) ||
    (lower.includes('kurang') && lower.includes('cukup') && lower.includes('baik sekali'))
  ) {
    return true;
  }
  return false;
}

export const extractedPageSchema = z.object({
  sourceImageId: z.string(),
  pageOrder: z.number().int().min(1),
  pageTitle: z.string().optional().default(''),
  extractedText: z
    .string()
    .optional()
    .default('')
    .transform((txt) =>
      txt && txt.trim().length > 0
        ? txt.trim()
        : '(Tidak ada teks yang terbaca jelas pada halaman ini — silakan periksa foto atau ketik manual)'
    ),
  sections: z
    .array(
      z.object({
        heading: z.string(),
        content: z.string(),
      })
    )
    .optional()
    .default([]),
  keyTerms: z.array(z.string()).optional().default([]),
  formulasOrTables: z
    .array(z.string())
    .optional()
    .default([])
    .transform((arr) => (arr || []).filter((item) => !isUtBoilerplateScoringFormula(item))),
  transcribedQuestions: z
    .array(
      z.object({
        prompt: z.string(),
        options: z
          .array(
            z.object({
              key: z.string(),
              text: z.string(),
            })
          )
          .optional()
          .default([]),
        explicitAnswerInSource: z.string().nullable().optional().default(null),
      })
    )
    .optional()
    .default([]),
  ambiguousParts: z.array(z.string()).optional().default([]),
  needsReview: z.boolean().default(false),
});

export const extractionBatchOutputSchema = z.object({
  schemaVersion: z.number().int().optional().default(1),
  pages: z.array(extractedPageSchema).min(1),
});

export const EXTRACTION_RESPONSE_JSON_SCHEMA = {
  type: 'OBJECT',
  required: ['pages'],
  properties: {
    schemaVersion: { type: 'INTEGER' },
    pages: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        required: ['sourceImageId', 'pageOrder', 'extractedText', 'needsReview'],
        properties: {
          sourceImageId: { type: 'STRING' },
          pageOrder: { type: 'INTEGER' },
          pageTitle: { type: 'STRING' },
          extractedText: { type: 'STRING' },
          sections: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              required: ['heading', 'content'],
              properties: {
                heading: { type: 'STRING' },
                content: { type: 'STRING' },
              },
            },
          },
          keyTerms: {
            type: 'ARRAY',
            items: { type: 'STRING' },
          },
          formulasOrTables: {
            type: 'ARRAY',
            items: { type: 'STRING' },
          },
          transcribedQuestions: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              required: ['prompt'],
              properties: {
                prompt: { type: 'STRING' },
                options: {
                  type: 'ARRAY',
                  items: {
                    type: 'OBJECT',
                    required: ['key', 'text'],
                    properties: {
                      key: { type: 'STRING' },
                      text: { type: 'STRING' },
                    },
                  },
                },
                explicitAnswerInSource: { type: 'STRING', nullable: true },
              },
            },
          },
          ambiguousParts: {
            type: 'ARRAY',
            items: { type: 'STRING' },
          },
          needsReview: { type: 'BOOLEAN' },
        },
      },
    },
  },
};

export const updateSourceSchema = z.object({
  label: z.enum(SOURCE_LABELS).optional(),
  pageOrder: z
    .union([z.number(), z.string()])
    .transform((v) => Number.parseInt(String(v), 10))
    .refine((n) => Number.isInteger(n) && n >= 1 && n <= 500, {
      message: 'Urutan halaman harus bilangan bulat >= 1.',
    })
    .optional(),
  pageTitle: z.string().max(255).optional(),
  extractedText: z.string().min(1, 'Teks ekstraksi tidak boleh kosong.').optional(),
  ambiguousParts: z.array(z.string()).optional(),
  keyTerms: z.array(z.string()).optional(),
  formulasOrTables: z.array(z.string()).optional(),
  needsReview: z.boolean().optional(),
});

export function detectImageMimeFromMagicBytes(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
    return null;
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

export async function safeCleanupTempFiles(files = []) {
  for (const file of files) {
    if (file?.path) {
      await fs.unlink(file.path).catch(() => {});
    }
  }
}

export async function validateAndPrepareUploadedImages(files = [], metadata = {}) {
  const config = getEnvConfig();

  if (!Array.isArray(files) || files.length === 0) {
    const err = new Error('Minimal 1 gambar halaman BMP harus diunggah.');
    err.statusCode = 400;
    err.errorCode = 'NO_FILES_UPLOADED';
    throw err;
  }

  if (files.length > config.aiMaxImagesPerBatch) {
    const err = new Error(
      `Maksimal ${config.aiMaxImagesPerBatch} gambar per batch ekstraksi.`
    );
    err.statusCode = 400;
    err.errorCode = 'TOO_MANY_IMAGES';
    throw err;
  }

  let totalBytes = 0;
  const prepared = [];

  const labelsInput = Array.isArray(metadata.labels)
    ? metadata.labels
    : typeof metadata.labels === 'string'
      ? [metadata.labels]
      : [];
  const ordersInput = Array.isArray(metadata.pageOrders)
    ? metadata.pageOrders
    : typeof metadata.pageOrders === 'string'
      ? [metadata.pageOrders]
      : [];

  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    if (!file || typeof file.size !== 'number' || file.size <= 0) {
      const err = new Error(`File gambar ke-${i + 1} kosong atau tidak valid.`);
      err.statusCode = 400;
      err.errorCode = 'INVALID_IMAGE_FILE';
      throw err;
    }

    if (file.size > config.aiMaxImageBytes) {
      const err = new Error(
        `Ukuran file "${file.originalname}" melebihi batas per gambar (${Math.round(config.aiMaxImageBytes / 1_000_000)} MB).`
      );
      err.statusCode = 400;
      err.errorCode = 'IMAGE_TOO_LARGE';
      throw err;
    }

    totalBytes += file.size;
    if (totalBytes > config.aiMaxBatchBytes) {
      const err = new Error(
        `Total ukuran batch gambar melebihi batas (${Math.round(config.aiMaxBatchBytes / 1_000_000)} MB).`
      );
      err.statusCode = 400;
      err.errorCode = 'BATCH_TOO_LARGE';
      throw err;
    }

    const buffer = await fs.readFile(file.path);
    const detectedMime = detectImageMimeFromMagicBytes(buffer);
    if (!detectedMime || !ALLOWED_MIME_TYPES.has(detectedMime)) {
      const err = new Error(
        `File "${file.originalname}" bukan gambar JPEG, PNG, atau WebP yang valid.`
      );
      err.statusCode = 400;
      err.errorCode = 'UNSUPPORTED_IMAGE_FORMAT';
      throw err;
    }

    const checksum = crypto.createHash('sha256').update(buffer).digest('hex');
    const rawLabel = String(labelsInput[i] || 'materi').toLowerCase().trim();
    const label = SOURCE_LABELS.includes(rawLabel) ? rawLabel : 'materi';
    const parsedOrder = Number.parseInt(String(ordersInput[i] ?? i + 1), 10);
    const pageOrder = Number.isInteger(parsedOrder) && parsedOrder >= 1 ? parsedOrder : i + 1;

    prepared.push({
      tempPath: file.path,
      originalName: String(file.originalname || `page-${i + 1}.jpg`).slice(0, 255),
      mimeType: detectedMime,
      fileSize: file.size,
      checksum,
      label,
      pageOrder,
    });
  }

  return prepared;
}
