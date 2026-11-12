import { z } from 'zod';
import { mcqQuestionSchema } from '../studyPack/studyPackSchemas.js';

export const submitAttemptPayloadSchema = z.object({
  answers: z
    .array(
      z.object({
        questionId: z.string().uuid('Format questionId tidak valid.'),
        selectedOption: z.string().trim().min(1).max(16).transform((s) => s.toUpperCase()),
      })
    )
    .min(1, 'Minimal satu jawaban harus dikirim.'),
});

export const remedialBatchOutputSchema = z.object({
  schemaVersion: z.number().int().optional().default(1),
  title: z
    .string()
    .optional()
    .default('Remedial Terfokus')
    .transform((s) => (s && s.trim().length >= 2 ? s.trim() : 'Remedial Terfokus')),
  diagnosticFeedback: z.object({
    overallDiagnosis: z
      .string()
      .optional()
      .default('Analisis miskonsepsi berdasarkan jawaban yang salah.')
      .transform((s) =>
        s && s.trim().length >= 2
          ? s.trim()
          : 'Analisis miskonsepsi berdasarkan jawaban yang salah.'
      ),
    topicDiagnostics: z
      .array(
        z.object({
          topicLabel: z
            .string()
            .optional()
            .default('Topik Remedial')
            .transform((s) => (s && s.trim() ? s.trim() : 'Topik Remedial')),
          misconceptionAnalysis: z
            .string()
            .optional()
            .default('')
            .transform((s) => (s && s.trim() ? s.trim() : 'Perlu penguatan konsep pada topik ini.')),
          whyYouWereTripped: z
            .string()
            .optional()
            .default('')
            .transform((s) => (s && s.trim() ? s.trim() : '')),
          bmpKeyRule: z
            .string()
            .optional()
            .default('')
            .transform((s) => (s && s.trim() ? s.trim() : '')),
          practicalAnalogy: z
            .string()
            .optional()
            .default('')
            .transform((s) => (s && s.trim() ? s.trim() : '')),
          reviewGuidance: z
            .string()
            .optional()
            .default('')
            .transform((s) => (s && s.trim() ? s.trim() : 'Baca kembali bagian rangkuman BMP.')),
          sourceRefs: z.array(z.string()).optional().default(['Sumber Modul BMP']),
        })
      )
      .min(1),
  }),
  remedialQuestions: z.array(mcqQuestionSchema).min(1).max(25),
});

export const REMEDIAL_BATCH_JSON_SCHEMA = {
  type: 'OBJECT',
  required: ['title', 'diagnosticFeedback', 'remedialQuestions'],
  properties: {
    schemaVersion: { type: 'INTEGER' },
    title: { type: 'STRING' },
    diagnosticFeedback: {
      type: 'OBJECT',
      required: ['overallDiagnosis', 'topicDiagnostics'],
      properties: {
        overallDiagnosis: { type: 'STRING' },
        topicDiagnostics: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            required: ['topicLabel', 'misconceptionAnalysis', 'reviewGuidance', 'sourceRefs'],
            properties: {
              topicLabel: { type: 'STRING' },
              misconceptionAnalysis: { type: 'STRING' },
              whyYouWereTripped: {
                type: 'STRING',
                description:
                  'Analisis kontras mengapa opsi salah yang dipilih siswa tampak mengecoh dibanding jawaban benar BMP (hindari merangkum ulang bab, fokus pada titik beda).',
              },
              bmpKeyRule: {
                type: 'STRING',
                description: '1-2 kalimat kaidah/aturan kunci BMP yang wajib diingat.',
              },
              practicalAnalogy: {
                type: 'STRING',
                description:
                  'Analogi intuitif atau jembatan logika praktis agar konsep mudah dipahami.',
              },
              reviewGuidance: { type: 'STRING' },
              sourceRefs: { type: 'ARRAY', items: { type: 'STRING' } },
            },
          },
        },
      },
    },
    remedialQuestions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        required: [
          'topicLabel',
          'prompt',
          'options',
          'correctOption',
          'explanation',
          'difficulty',
          'sourceRefs',
        ],
        properties: {
          topicLabel: { type: 'STRING' },
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
          correctOption: { type: 'STRING' },
          explanation: { type: 'STRING' },
          difficulty: { type: 'STRING' },
          sourceRefs: { type: 'ARRAY', items: { type: 'STRING' } },
        },
      },
    },
  },
};

export const examSimulationQuestionSchema = z
  .object({
    moduleNumber: z
      .union([z.number(), z.string()])
      .optional()
      .default(1)
      .transform((v) => {
        const n = Number.parseInt(String(v).replace(/[^0-9]/g, ''), 10);
        return Number.isInteger(n) && n >= 1 ? n : 1;
      }),
    topicLabel: z.string().optional(),
    prompt: z.string(),
    options: z.any(),
    correctOption: z.string(),
    explanation: z.string().optional(),
    difficulty: z.string().optional(),
    sourceRefs: z.array(z.string()).optional(),
  })
  .transform((raw) => {
    const parsedMcq = mcqQuestionSchema.parse(raw);
    return {
      ...parsedMcq,
      moduleNumber: raw.moduleNumber,
    };
  });

export const examSimulationOutputSchema = z.object({
  schemaVersion: z.number().int().optional().default(1),
  title: z.string().trim().min(2),
  questions: z.array(examSimulationQuestionSchema).min(2).max(60),
});

export const EXAM_SIMULATION_JSON_SCHEMA = {
  type: 'OBJECT',
  required: ['title', 'questions'],
  properties: {
    schemaVersion: { type: 'INTEGER' },
    title: { type: 'STRING' },
    questions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        required: [
          'moduleNumber',
          'topicLabel',
          'prompt',
          'options',
          'correctOption',
          'explanation',
          'difficulty',
          'sourceRefs',
        ],
        properties: {
          moduleNumber: { type: 'INTEGER' },
          topicLabel: { type: 'STRING' },
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
          correctOption: { type: 'STRING' },
          explanation: { type: 'STRING' },
          difficulty: { type: 'STRING' },
          sourceRefs: { type: 'ARRAY', items: { type: 'STRING' } },
        },
      },
    },
  },
};
