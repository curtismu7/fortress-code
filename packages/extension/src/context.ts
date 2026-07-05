import { buildCodebaseBlock } from './rag/retriever';

export interface AttachedFile { id: string; relPath: string; language: string; content: string; truncated: boolean; diagnostics: string[] }
export interface SelectionCtx { id: string; relPath: string; startLine: number; endLine: number; text: string }
export interface ChatContext {
  file: AttachedFile | null;
  selection: SelectionCtx | null;
  mentions: AttachedFile[];
  codebase?: { file: string; startLine: number; endLine: number; text: string }[] | null;
}

export function parseMentions(input: string): string[] {
  const out: string[] = [];
  // Require @ at start-of-string or after whitespace so emails (a@b.com) and
  // decorators mid-word are not misread as file mentions.
  const re = /(?:^|\s)@([^\s@]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input))) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

export function capContent(text: string, maxBytes = 30_000): { content: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return { content: text, truncated: false };
  // Truncate on a byte boundary, dropping a trailing partial multibyte char.
  const head = buf.subarray(0, maxBytes).toString('utf8').replace(/�+$/, '');
  return { content: head + '\n…(truncated)', truncated: true };
}

function fileBlock(label: string, f: AttachedFile): string {
  const head = `[context] ${label} ${f.relPath} (${f.language})${f.truncated ? ', truncated' : ''}`;
  const diag = f.diagnostics.length ? `\n[diagnostics] ${f.relPath}:\n${f.diagnostics.map((d) => '  ' + d).join('\n')}` : '';
  return `${head}\n\`\`\`${f.language}\n${f.content}\n\`\`\`${diag}`;
}

export function buildContextPreamble(ctx: ChatContext): string {
  const parts: string[] = [];
  if (ctx.file) parts.push(fileBlock('active file', ctx.file));
  if (ctx.selection) parts.push(`[context] selection ${ctx.selection.relPath} L${ctx.selection.startLine}-${ctx.selection.endLine}\n\`\`\`\n${ctx.selection.text}\n\`\`\``);
  for (const mn of ctx.mentions) parts.push(fileBlock('mentioned file', mn));
  if (ctx.codebase && ctx.codebase.length) parts.push(buildCodebaseBlock(ctx.codebase));
  return parts.join('\n\n');
}
