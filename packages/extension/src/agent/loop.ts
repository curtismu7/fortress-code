import * as vscode from 'vscode';
import type { ChatMessage, ToolCall } from '@fortress-code/shared';
import { TOOL_SCHEMAS, executeTool, type ToolExtras } from './tools';
import type { Session } from '../chat/session';
import type { ResolvedTarget } from '../providers/target';
import type { Usage } from '../providers/stream';

export const MAX_ITERATIONS = 10;

export async function completeOnce(
  target: ResolvedTarget, messages: ChatMessage[], signal: AbortSignal,
  extraTools: object[] = [],
): Promise<{ content: string; toolCalls: ToolCall[]; usage?: Usage }> {
  const res = await fetch(target.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...target.headers },
    body: JSON.stringify({ ...(target.model ? { model: target.model } : {}), messages, tools: [...TOOL_SCHEMAS, ...extraTools], stream: false, ...target.bodyExtra }),
    signal,
  });
  if (!res.ok) throw new Error(`Model server HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  const json = await res.json();
  const msg = json?.choices?.[0]?.message ?? {};
  const usage = json?.usage ? { promptTokens: json.usage.prompt_tokens ?? 0, completionTokens: json.usage.completion_tokens ?? 0 } : undefined;
  return { content: typeof msg.content === 'string' ? msg.content : '', toolCalls: Array.isArray(msg.tool_calls) ? msg.tool_calls : [], usage };
}

export async function runAgentTurn(
  target: ResolvedTarget, session: Session, systemPrompt: string,
  onStep: (step: string) => void, signal: AbortSignal,
  deps: { complete?: typeof completeOnce; execute?: typeof executeTool; workspaceRoot?: string; extraTools?: object[]; toolExtras?: ToolExtras } = {},
): Promise<void> {
  const complete = deps.complete ?? completeOnce;
  const execute = deps.execute ?? executeTool;
  const root = deps.workspaceRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) throw new Error('Agent mode needs an open workspace folder');
  const extraTools = deps.extraTools ?? [];
  const toolExtras = deps.toolExtras;

  const agentSystem = `${systemPrompt}\nYou can use tools to inspect and edit files in the user's workspace. Use tools when needed; when you have the answer, reply in plain text without tool calls.`;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (signal.aborted) throw new Error('cancelled');
    const { content, toolCalls } = await complete(target, session.toRequestMessages(agentSystem), signal, extraTools);
    if (toolCalls.length === 0) {
      session.addAssistant(content || '(no reply)');
      return;
    }
    const assistantMsg: ChatMessage = { role: 'assistant', content: content ?? '', tool_calls: toolCalls };
    const results: ChatMessage[] = [];
    for (const tc of toolCalls) {
      onStep(`${tc.function.name}(${tc.function.arguments.slice(0, 120)})`);
      let result: string;
      try {
        let parsed: unknown;
        try { parsed = JSON.parse(tc.function.arguments); }
        catch { result = 'error: invalid arguments (not valid JSON)'; results.push({ role: 'tool', content: result, tool_call_id: tc.id }); continue; }
        result = await execute(tc.function.name, parsed, root, toolExtras);
      } catch (e) {
        result = `error: ${e}`;
      }
      results.push({ role: 'tool', content: result, tool_call_id: tc.id });
    }
    session.addToolExchange(assistantMsg, results);
  }
  session.addAssistant('Stopped: agent iteration limit (10) reached without a final answer.');
}
