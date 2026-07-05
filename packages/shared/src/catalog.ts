import { z } from 'zod';
import rawCatalog from './catalog.json';

const fileSchema = z.object({
  name: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().positive(),
});

const modelSchema = z.object({
  id: z.string(),
  family: z.enum(['gemma3', 'gpt-oss', 'embedding']),
  displayName: z.string(),
  hfRepo: z.string(),
  files: z.array(fileSchema).min(1),
  memoryBytes: z.number().int().positive(), // incl. 8192-ctx KV cache
  ramTierBytes: z.number().int().positive(), // minimum machine RAM to recommend
  toolCalling: z.boolean(),
  license: z.string(),
  extraArgs: z.array(z.string()),
  embedding: z.boolean().optional(),
  dims: z.number().int().positive().optional(),
});

export type CatalogModel = z.infer<typeof modelSchema>;

export function loadCatalog(): CatalogModel[] {
  return z.array(modelSchema).parse(rawCatalog);
}

export function hfUrl(m: CatalogModel, fileName: string): string {
  return `https://huggingface.co/${m.hfRepo}/resolve/main/${fileName}`;
}
