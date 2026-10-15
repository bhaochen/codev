/**
 * AWS EventStream Protocol Handler for Kiro (Amazon Q)
 * Speaks directly to q.{region}.amazonaws.com / runtime.{region}.kiro.dev
 * Ported from 9router's MITM handler
 */

import type { LLMRoute } from '../../types.js';
import type { LLMRequest } from '../../runtime/types.js';
import type { StreamEvent, AssistantMessage, SystemAPIErrorMessage } from '../../../types/message.js';
import { httpRequest } from '../../transport/http.js';
import { requestWithRetry } from '../../transport/retryHttpRequest.js';
import { parseOpenAIChunksFromSSE } from '../../transport/sse.js';
import { detectUpstreamFailures } from '../upstreamError.js';
import { getSessionId } from '../../../bootstrap/state.js';
import { logForDebugging } from '../../../utils/debug.js';
import {
  createAssistantAPIErrorMessage,
  normalizeContentFromAPI,
  normalizeMessagesForAPI,
} from '../../../utils/messages.js';
import type { AgentId } from '../../../types/ids.js';
import { toolToAPISchema } from '../../../utils/api.js';
import { calculateUSDCost } from '../../../utils/modelCost.js';
import { addToTotalSessionCost } from '../../../cost-tracker.js';
import { isAbortError } from '../../../utils/errors.js';
import { resolveAuth } from '../../auth/resolveAuth.js';
import { codeWhispererToMessages, extractTools } from './formatConversion.js';
import { initKiroState, convertOpenAIToKiro } from './responseConverter.js';
import { getKiroAccessToken, getKiroProfileArn, getKiroRegion, getKiroBaseUrl } from '../../../utils/auth.js';
import { buildEventStreamFrame, withInitialFrame } from './frameBuilder.js';

export type ProtocolHandler = (
  route: LLMRoute,
  request: LLMRequest,
) => AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void>;

/**
 * Transform CodeWhisperer request body to OpenAI format for internal processing
 */
function buildOpenAIRequestBody(route: LLMRoute, request: LLMRequest): Record<string, unknown> {
  const { messages, systemPrompt, tools, config } = request;
  const messagesForAPI = normalizeMessagesForAPI(messages, tools);
  
  // Convert agent messages to OpenAI format
  // We'll use the same normalization but with CodeWhisperer-specific handling
  const openAIMessages = messagesForAPI.map(msg => {
    if (msg.role === 'user') {
      return {
        role: 'user',
        content: msg.content,
        userInputMessageContext: msg.toolResults ? { toolResults: msg.toolResults } : undefined,
      };
    } else if (msg.role === 'assistant') {
      return {
        role: 'assistant',
        content: msg.content,
        toolUses: msg.tool_calls?.map(tc => ({
          toolUseId: tc.id,
          name: tc.function?.name,
          input: tc.function?.arguments,
        })),
      };
    }
    return msg;
  });

  return {
    conversationState: {
      history: openAIMessages.slice(0, -1),
      currentMessage: openAIMessages[openAIMessages.length - 1],
    },
    // Forward tools so the model uses structured tool_calls
    ...(tools.length > 0 && { tools: extractTools({ conversationState: { currentMessage: openAIMessages[openAIMessages.length - 1] } }) }),
  };
}

/**
 * Main protocol handler for AWS EventStream
 */
export async function* queryAWSEventStream(
  route: LLMRoute,
  request: LLMRequest,
): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void> {
  const { messages, systemPrompt, tools, signal, config, context } = request;
  let ttftMs = 0;
  const start = Date.now();

  try {
    const model = route.model;
    const region = getKiroRegion() || 'us-east-1';
    const endpoint = `https://q.${region}.amazonaws.com`;
    
    // Get auth credentials
    const accessToken = getKiroAccessToken();
    const profileArn = getKiroProfileArn();
    
    if (!accessToken || !profileArn) {
      throw new Error('Kiro authentication required: missing access token or profile ARN. Run /login and select Kiro provider.');
    }

    // Build CodeWhisperer request body
    const cwBody = buildOpenAIRequestBody(route, request);

    // Forward to CodeWhisperer/Amazon Q
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-amz-json-1.0',
      'Accept': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
      'X-Amz-Target': 'AmazonCodeWhispererService.SendMessage',
    };

    // Add profile ARN as header
    headers['x-amz-codewhisperer-profile-arn'] = profileArn;

    logForDebugging(`[Kiro EventStream] POST ${endpoint} model=${model} profileArn=${profileArn}`);

    // We need to handle streaming - the AWS EventStream response is binary
    // Use the standard httpRequest but handle binary response
    const response = await requestWithRetry(
      () => httpRequest({
        method: 'POST',
        url: endpoint,
        headers,
        body: JSON.stringify(cwBody),
        signal,
        responseType: 'stream', // We need streaming response
      }),
      { maxRetries: 2, baseDelayMs: 1000 }
    );

    if (!response.ok) {
      const errorText = await response.text();
      logForDebugging(`[Kiro EventStream] Error: ${response.status} ${errorText}`);
      yield createAssistantAPIErrorMessage(
        `Kiro API error: ${response.status} ${errorText}`,
        'api_error',
        response.status
      );
      return;
    }

    // Process the EventStream binary response
    // The response is a stream of binary EventStream frames
    // We need to parse them and convert to our internal format
    
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body reader');
    }

    const decoder = new TextDecoder();
    let buffer = new Uint8Array(0);
    const converterState = initKiroState(model);

    // Helper to parse EventStream frames
    function parseEventStreamFrames(data: Uint8Array): { frames: Array<{ eventType: string; payload: Record<string, unknown> }>; remaining: Uint8Array } {
      const frames: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
      let offset = 0;

      while (offset + 12 <= data.length) {
        const view = new DataView(data.buffer, data.byteOffset + offset, data.length - offset);
        const totalLen = view.getUint32(0, false);
        const headersLen = view.getUint32(4, false);

        if (offset + totalLen > data.length) {
          break; // Incomplete frame
        }

        const preludeCRC = view.getUint32(8, false);
        // Verify prelude CRC (optional but recommended)

        const headersEnd = 12 + headersLen;
        const payloadStart = headersEnd;
        const payloadLen = totalLen - 4 - headersEnd;
        const payloadEnd = payloadStart + payloadLen;
        const messageCRC = view.getUint32(totalLen - 4, false);

        // Verify message CRC (optional)

        // Parse headers
        const headersData = data.slice(12, headersEnd);
        let hOffset = 0;
        let eventType = '';
        let contentType = 'application/json';

        while (hOffset < headersData.length) {
          const nameLen = headersData[hOffset++];
          const name = decoder.decode(headersData.slice(hOffset, hOffset + nameLen));
          hOffset += nameLen;
          const type = headersData[hOffset++]; // Should be 7 for string
          const valueLen = new DataView(headersData.buffer, headersData.byteOffset + hOffset, 2).getUint16(0, false);
          hOffset += 2;
          const value = decoder.decode(headersData.slice(hOffset, hOffset + valueLen));
          hOffset += valueLen;

          if (name === ':event-type') eventType = value;
          if (name === ':content-type') contentType = value;
        }

        // Parse payload
        const payloadData = data.slice(payloadStart, payloadEnd);
        let payload: Record<string, unknown> = {};
        if (payloadData.length > 0) {
          try {
            payload = JSON.parse(decoder.decode(payloadData));
          } catch {
            // Ignore parse errors
          }
        }

        frames.push({ eventType, payload });
        offset += totalLen;
      }

      return { frames, remaining: data.slice(offset) };
    }

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Append new data to buffer
      const newBuffer = new Uint8Array(buffer.length + value.length);
      newBuffer.set(buffer);
      newBuffer.set(value, buffer.length);
      buffer = newBuffer;

      // Parse frames
      const { frames, remaining } = parseEventStreamFrames(buffer);
      buffer = remaining;

      for (const frame of frames) {
        // Convert CodeWhisperer EventStream events to our internal format
        yield* convertEventStreamFrameToInternal(frame, converterState);
      }
    }

    // Flush any remaining
    const flushFrames = convertOpenAIToKiro(null, converterState);
    if (flushFrames) {
      // These are binary frames, we'd need to parse them again
      // For simplicity, just emit termination
      yield { type: 'message_stop' } as StreamEvent;
    }

  } catch (error) {
    logForDebugging(`[Kiro EventStream] Request failed: ${error instanceof Error ? error.message : String(error)}`);
    if (isAbortError(error)) {
      return;
    }
    yield createAssistantAPIErrorMessage(
      error instanceof Error ? error.message : String(error),
      'api_error',
      500
    );
  }
}

/**
 * Convert a parsed CodeWhisperer EventStream frame to our internal stream events
 */
async function* convertEventStreamFrameToInternal(
  frame: { eventType: string; payload: Record<string, unknown> },
  state: ReturnType<typeof initKiroState>
): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void> {
  const { eventType, payload } = frame;

  switch (eventType) {
    case 'initial-response':
      // Initial response - just acknowledge
      break;

    case 'assistantResponseEvent':
      if (payload.content) {
        yield {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: payload.content as string },
        } as StreamEvent;
      }
      break;

    case 'reasoningContentEvent':
      if (payload.content) {
        yield {
          type: 'content_block_delta',
          delta: { type: 'thinking_delta', thinking: payload.content as string },
        } as StreamEvent;
      }
      break;

    case 'toolUseEvent':
      if (payload.stop) {
        // Tool call complete
        yield {
          type: 'content_block_stop',
          index: 0, // Would need proper index tracking
        } as StreamEvent;
      } else if (payload.input) {
        // Tool call input fragment
        yield {
          type: 'content_block_delta',
          delta: { type: 'input_json_delta', partial_json: payload.input as string },
        } as StreamEvent;
      } else if (payload.name && payload.toolUseId) {
        // Tool call start
        yield {
          type: 'content_block_start',
          content_block: {
            type: 'tool_use',
            id: payload.toolUseId as string,
            name: payload.name as string,
            input: {},
          },
          index: 0,
        } as StreamEvent;
      }
      break;

    case 'messageStopEvent':
      yield { type: 'message_stop' } as StreamEvent;
      break;

    case 'usageEvent':
      // Usage tracking handled elsewhere
      break;

    case 'exception':
    case 'error':
      yield createAssistantAPIErrorMessage(
        (payload.message as string) || 'Kiro EventStream error',
        'api_error',
        500
      );
      break;
  }
}