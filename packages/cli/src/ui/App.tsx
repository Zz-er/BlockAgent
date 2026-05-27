/**
 * cli/ui/App.tsx — top-level Ink composition (impl-cli-ui owned).
 *
 * Design: ai_com/block-agent-cli-design.md §4. Holds session message state, the live
 * thinking stream, the optional ContextView payload, and the lifted draft input;
 * composes the leaf components. In a useEffect (mounted once per agent) it wires the
 * two core side-channels, symmetric to core's own:
 *   - agent.runtime.onThinking → ThinkingStream
 *   - agent.runtime.onError → ContextView (a failed turn surfaces, never silent)
 *   - channel.onDeliver (→ agent.messages.onReply, reply=Option B §6) → MessageList
 * onSubmit classifies plain text vs /slash: plain text goes through CliChannel.submit
 * (messages.ingest, invoker=user, awaiting the turn); /slash goes to commands.dispatch
 * with a setView sink into ContextView. The chokepoint stays intact — the CLI never
 * writes the tree directly and never forges invoker:'agent' (§9).
 */

import { useEffect, useMemo, useState } from 'react';
import { Box, Text } from '../ink.js';
import type { LaunchedAgent, CtxView } from '../types.js';
import type { ThinkingEvent } from '@block-agent/core/core/types.js';
import { makeCliChannel } from '../cli_channel.js';
import { dispatch } from '../commands.js';
import { MessageList, type UiMessage } from './MessageList.js';
import { ThinkingStream } from './ThinkingStream.js';
import { ContextView } from './ContextView.js';
import { SlashHint } from './SlashHint.js';
import { PromptInput } from './PromptInput.js';

export interface AppProps {
  agent: LaunchedAgent;
}

export function App({ agent }: AppProps): JSX.Element {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [thinking, setThinking] = useState<ThinkingEvent[]>([]);
  const [ctxView, setCtxView] = useState<CtxView | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  // One channel per agent — holds the chokepoint submit + the onReply delivery seam.
  const channel = useMemo(() => makeCliChannel(agent), [agent]);

  // Mount the two side-channel subscriptions once; both are isolated in core so a
  // render-time throw here never breaks a turn (agent_runtime / messages emit guards).
  useEffect(() => {
    const offThinking = agent.runtime.onThinking((e) => setThinking((prev) => [...prev, e]));
    // A failed turn (e.g. the provider call erroring) no longer throws out of
    // channel.submit — the runtime catches it and emits here, so this is the ONLY way
    // the UI learns of it. Surface it as an error view instead of silent nothing.
    const offError = agent.runtime.onError((e) =>
      setCtxView({ kind: 'command_result', ok: false, text: `agent turn failed (${e.phase}): ${e.message}` }),
    );
    const offDeliver = channel.onDeliver((reply) =>
      setMessages((prev) => [...prev, { role: 'agent', content: reply.content }]),
    );
    return () => {
      offThinking();
      offError();
      offDeliver();
    };
  }, [agent, channel]);

  async function onSubmit(text: string): Promise<void> {
    const t = text.trim();
    setDraft('');
    if (t === '') return;

    if (t.startsWith('/')) {
      // Slash path — local command; result is pushed to ContextView via setCtxView.
      await dispatch(agent, t, setCtxView);
      return;
    }

    // Plain text → chokepoint (messages.ingest, invoker=user). Local echo first,
    // clear the prior turn's thinking + any open view, then await the turn while
    // onThinking/onReply keep re-rendering.
    setMessages((prev) => [...prev, { role: 'user', content: t }]);
    setThinking([]);
    setCtxView(null);
    setBusy(true);
    try {
      await channel.submit(t);
    } catch (err) {
      setCtxView({ kind: 'command_result', ok: false, text: errorText(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color="cyan">block-agent</Text>
        <Text dimColor>{`${agent.provider_id} · type a message, or /help for commands · Ctrl-C to quit`}</Text>
      </Box>
      <MessageList items={messages} />
      <ThinkingStream events={thinking} />
      <ContextView view={ctxView} />
      <SlashHint input={draft} />
      <PromptInput value={draft} onChange={setDraft} onSubmit={onSubmit} busy={busy} />
    </Box>
  );
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
