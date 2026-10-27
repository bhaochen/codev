import { c as _c } from "react/compiler-runtime";
import * as React from 'react';
import type { CommandResultDisplay } from '../../types/command.js';
import { Box, Text } from '../../ink.js';
import type { LocalJSXCommandCall } from '../../types/command.js';
import { saveCustomApiConfig, getCustomApiConfig } from '../../utils/auth.js';
import { getCustomBaseUrl, isCustomConfigured } from '../../utils/model/providers.js';
import { clearStoredProviderCache } from '../../utils/model/providers.js';

type Step = 'select' | 'custom-config';

function ProviderSelectScreen({ onDone }: { onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void }) {
  const $ = _c(8);
  const providers = [
    { id: 'openai', label: '9router (default)', description: 'Local gateway at localhost:20128' },
    { id: 'openrouter', label: 'OpenRouter', description: 'OpenRouter.ai API' },
    { id: 'local', label: 'Local (OpenAI-compatible)', description: 'Custom local endpoint' },
    { id: 'custom', label: 'Custom OpenAI-compatible', description: 'Any OpenAI-compatible API (llama.cpp, vLLM, etc.)' },
  ];

  return React.createElement(Box, { flexDirection: 'column', paddingX: 2 },
    React.createElement(Text, { bold: true }, 'Select API Provider'),
    React.createElement(Box, { marginTop: 1 },
      providers.map((p, i) =>
        React.createElement(Box, { key: p.id, flexDirection: 'column', marginBottom: 1 },
          React.createElement(Text, { color: 'cyan' }, `${i + 1}. ${p.label}`),
          React.createElement(Text, { dimColor: true }, p.description)
        )
      )
    )
  );
}

function CustomConfigScreen({ onDone }: { onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void }) {
  const $ = _c(16);
  const [baseUrl, setBaseUrl] = React.useState('');
  const [modelName, setModelName] = React.useState('');
  const [apiKey, setApiKey] = React.useState('');
  const [status, setStatus] = React.useState<'idle' | 'verifying' | 'success' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = React.useState('');
  const [, forceUpdate] = React.useState(0);

  async function verifyAndSave() {
    if (!baseUrl.trim() || !modelName.trim()) return;
    setStatus('verifying');
    setErrorMsg('');

    try {
      const url = new URL(baseUrl);
      const modelsUrl = url.origin + '/v1/models';
      const headers: Record<string, string> = {};
      if (apiKey.trim()) headers['Authorization'] = `Bearer ${apiKey.trim()}`;

      const res = await fetch(modelsUrl, { headers, signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

      const json = (await res.json()) as { data?: Array<{ id: string }> };
      const ids = (json.data ?? []).map(m => m.id);
      if (ids.length === 0) throw new Error('No models returned from API');

      await saveCustomApiConfig(baseUrl, modelName, apiKey || undefined);
      clearStoredProviderCache();
      setStatus('success');
      setTimeout(() => onDone(`Custom API configured: ${modelName} @ ${baseUrl}`), 1000);
    } catch (e) {
      setStatus('error');
      setErrorMsg(e instanceof Error ? e.message : 'Verification failed');
    }
  }

  return React.createElement(Box, { flexDirection: 'column', paddingX: 2 },
    React.createElement(Text, { bold: true }, 'Configure Custom OpenAI-compatible API'),
    React.createElement(Box, { marginTop: 1, flexDirection: 'column' },
      React.createElement(Text, null, 'API Base URL (e.g. http://localhost:8080/v1):'),
      React.createElement(Box, { marginTop: 1 },
        React.createElement(Text, null, '> ' + baseUrl)
      ),
      React.createElement(Text, { marginTop: 1, dimColor: true }, 'Paste URL and press Enter to confirm')
    ),
    React.createElement(Box, { marginTop: 1, flexDirection: 'column' },
      React.createElement(Text, null, 'Model Name:'),
      React.createElement(Box, { marginTop: 1 },
        React.createElement(Text, null, '> ' + modelName)
      ),
      React.createElement(Text, { marginTop: 1, dimColor: true }, 'Enter model ID (e.g. llama-3-8b)')
    ),
    React.createElement(Box, { marginTop: 1, flexDirection: 'column' },
      React.createElement(Text, null, 'API Key (optional):'),
      React.createElement(Box, { marginTop: 1 },
        React.createElement(Text, null, '> ' + (apiKey ? '***' : '(none)'))
      ),
      React.createElement(Text, { marginTop: 1, dimColor: true }, 'Press Enter to skip')
    ),
    status === 'verifying' && React.createElement(Text, { marginTop: 1, color: 'yellow' }, 'Verifying connection...'),
    status === 'success' && React.createElement(Text, { marginTop: 1, color: 'green' }, 'Connected! Saved.'),
    status === 'error' && React.createElement(Text, { marginTop: 1, color: 'red' }, `Error: ${errorMsg}`),
    React.createElement(Box, { marginTop: 1 },
      React.createElement(Text, { dimColor: true }, 'Enter: verify | Esc: cancel')
    )
  );
}

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  const [screen] = args;
  if (screen === 'custom') {
    return React.createElement(CustomConfigScreen, { onDone });
  }
  return React.createElement(ProviderSelectScreen, { onDone });
};
