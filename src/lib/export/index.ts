/* ==================================================================== *
 *  UMBRA·SCORE — STEM DELIVERY SUBSYSTEM (public surface)
 *
 *  Professional stem delivery, audio routing integrity, sync guarantees
 *  and post-production export packaging. Import from here; the modules
 *  inside are the implementation.
 *
 *    clock.ts           — the single authoritative time↔sample mapping
 *    stemPlan.ts        — taxonomy + pure pass planning (testable in Node)
 *    stemRender.ts      — Web Audio execution (same DSP as the monitor)
 *    referenceKernel.ts — test-only algebra mirror (never ships audio)
 *    wavio.ts           — PCM WAV + real BWF bext writer/parser
 *    naming.ts          — deterministic file names
 *    manifest.ts        — delivery manifest + cue sheet + credits glue
 *    preflight.ts       — validate-before-you-write
 *    package.ts         — ZIP via fflate (stored PCM, deflated docs)
 *    delivery.ts        — the EXPORT FOR POST pipeline
 * ==================================================================== */

export * from './clock';
export * from './stemPlan';
export * from './referenceKernel';
export * from './wavio';
export * from './naming';
export * from './referenceKernel';
export * from './naming';
export * from './wavio';
export * from './manifest';
export * from './preflight';
export type { DeliveryFile, DeliveryResult, PostExportOptions, PostExportPreset } from './delivery';
export { runPostExport, POST_PRESETS, resolvePreset, downloadDeliveryFile, fileObjectUrl, DeliveryPreflightError } from './delivery';
export { buildZip, deliveryZipName, type ZipEntry } from './package';
export { renderPassWebAudio, type PassRenderResult } from './stemRender';
