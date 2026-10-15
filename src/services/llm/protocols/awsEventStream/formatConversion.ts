/**
 * CodeWhisperer ↔ OpenAI format conversion
 * Ported from 9router's kiro MITM handler
 */

const INLINE_IMAGE_MIME_BY_FORMAT = new Map([
  ['png', 'image/png'],
  ['jpeg', 'image/jpeg'],
  ['jpg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
]);

/**
 * Safely stringify a tool-call input value.
 * OpenAI expects `function.arguments` to be a JSON string, never an object.
 */
function safeArgsString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '{}';
  try { return JSON.stringify(value); } catch { return '{}'; }
}

/**
 * Convert a CodeWhisperer userInputMessage to one or more OpenAI messages.
 */
export function convertUserInputMessage(uim: Record<string, unknown>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const toolResults = (uim.userInputMessageContext?.toolResults as unknown[]) || [];

  // Emit one "tool" message per tool result (OpenAI multi-tool format)
  for (const tr of toolResults) {
    const text = ((tr.content as unknown[]) || []).map(c => (c as Record<string, unknown>).text || '').join('\n');
    out.push({
      role: 'tool',
      tool_call_id: (tr as Record<string, unknown>).toolUseId || '',
      content: text,
    });
  }

  const images = Array.isArray(uim.images) ? uim.images : [];
  const imageParts = images
    .filter(image =>
      image !== null
      && typeof image === 'object'
      && !Array.isArray(image)
      && (image as Record<string, unknown>).source !== null
      && typeof (image as Record<string, unknown>).source === 'object'
      && !Array.isArray((image as Record<string, unknown>).source)
      && INLINE_IMAGE_MIME_BY_FORMAT.has((image as Record<string, unknown>).format as string)
      && typeof ((image as Record<string, unknown>).source as Record<string, unknown>).bytes === 'string'
      && ((image as Record<string, unknown>).source as Record<string, unknown>).bytes.length > 0
    )
    .map(image => ({
      type: 'image_url',
      image_url: {
        url: `data:${INLINE_IMAGE_MIME_BY_FORMAT.get((image as Record<string, unknown>).format as string)};base64,${((image as Record<string, unknown>).source as Record<string, unknown>).bytes}`,
      },
    }));

  const text = ((uim.content as string) || '').trim();
  if (imageParts.length > 0) {
    const content = [];
    if (text) content.push({ type: 'text', text });
    content.push(...imageParts);
    out.push({ role: 'user', content });
  } else if (text || toolResults.length === 0) {
    out.push({ role: 'user', content: text });
  }

  return out;
}

/**
 * Convert a CodeWhisperer assistantResponseMessage to an OpenAI assistant message.
 */
export function convertAssistantResponseMessage(arm: Record<string, unknown>): Record<string, unknown> {
  const toolUses = (arm.toolUses as unknown[]) || [];

  if (toolUses.length > 0) {
    return {
      role: 'assistant',
      content: arm.content || null,
      tool_calls: toolUses.map(tu => ({
        id: (tu as Record<string, unknown>).toolUseId || `call_${Date.now()}`,
        type: 'function',
        function: {
          name: (tu as Record<string, unknown>).name || '',
          arguments: safeArgsString((tu as Record<string, unknown>).input),
        },
      })),
    };
  }

  return { role: 'assistant', content: arm.content || '' };
}

/**
 * Convert AWS CodeWhisperer conversationState to an OpenAI messages array.
 */
export function codeWhispererToMessages(body: Record<string, unknown>): Record<string, unknown>[] {
  const cs = (body.conversationState as Record<string, unknown>) || {};
  const history = (cs.history as unknown[]) || [];
  const currentMsg = cs.currentMessage as Record<string, unknown>;
  const messages: Record<string, unknown>[] = [];

  for (const item of history) {
    const itemRec = item as Record<string, unknown>;
    if (itemRec.userInputMessage) {
      messages.push(...convertUserInputMessage(itemRec.userInputMessage as Record<string, unknown>));
    } else if (itemRec.assistantResponseMessage) {
      messages.push(convertAssistantResponseMessage(itemRec.assistantResponseMessage as Record<string, unknown>));
    }
  }

  // Append the current (latest) turn
  if (currentMsg?.userInputMessage) {
    messages.push(...convertUserInputMessage(currentMsg.userInputMessage as Record<string, unknown>));
  }

  return messages;
}

/**
 * Extract tool definitions from a CodeWhisperer request and convert to OpenAI format.
 */
export function extractTools(body: Record<string, unknown>): Record<string, unknown>[] {
  const cs = (body.conversationState as Record<string, unknown>) || {};

  // Tools are typically on the currentMessage; may also appear on the first history item
  const fromCurrent = (cs.currentMessage as Record<string, unknown>)?.userInputMessage?.userInputMessageContext?.tools as unknown[] || [];
  const fromHistory = (cs.history as unknown[])?.find(h => (h as Record<string, unknown>).userInputMessage?.userInputMessageContext?.tools)
    ?.userInputMessage?.userInputMessageContext?.tools as unknown[] || [];
  const cwTools = fromCurrent.length > 0 ? fromCurrent : fromHistory;

  if (!cwTools.length) return [];

  return cwTools.map(item => {
    const spec = (item as Record<string, unknown>).toolSpecification || item;
    return {
      type: 'function',
      function: {
        name: (spec as Record<string, unknown>).name || '',
        description: (spec as Record<string, unknown>).description || `Tool: ${(spec as Record<string, unknown>).name || 'unknown'}`,
        parameters: ((spec as Record<string, unknown>).inputSchema as Record<string, unknown>)?.json || { type: 'object', properties: {}, required: [] },
      },
    };
  });
}