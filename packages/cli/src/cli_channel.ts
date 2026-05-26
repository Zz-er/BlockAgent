/**
 * cli/cli_channel.ts — the CLI ChannelAdapter (impl-cli-logic owned).
 *
 * Design: ai_com/block-agent-cli-design.md §1 (CLI channel), §6 (reply=onReply,
 * Option B), §9 (chokepoint invariant).
 *
 * makeCliChannel(agent) returns a CliChannel that:
 *   - authenticate() → { invoker: 'user' } (stamps every CLI action at the membrane).
 *   - submit(text)   → operations.invoke_command('messages.ingest', {content:text},
 *                      {invoker:'user'}); ingest durably appends + set_state + ctx.wake,
 *                      which fires AppRegistry.wakeHook → runtime.on_wake, so the whole
 *                      turn loop has run by the time the awaited promise resolves
 *                      (on_wake ignores a re-entrant wake, so no second loop starts).
 *                      NEVER writes the tree directly, NEVER forges invoker:'agent'/'app'.
 *   - onDeliver(cb)  → subscribes agent.messages.onReply and forwards each ReplyEvent
 *                      to cb (the UI's render callback). Returns an unsubscribe thunk.
 *
 * Holds only callbacks — no React import — so it is unit-testable on its own.
 */

import type { CliChannel, LaunchedAgent, ReplyEvent } from './types.js';
import type { InvokerContext } from '@block-agent/core/core/types.js';
import { awaitTurnsSettled } from './launch.js';

/**
 * makeCliChannel — build the CLI ChannelAdapter over a LaunchedAgent.
 *
 * The channel is the trust membrane: every action it submits is stamped invoker=user
 * (the only invoker the CLI may produce). It is the SINGLE delivery point for agent
 * replies — the UI registers its render callback via onDeliver and the channel relays
 * MessagesApp.onReply pushes to it, so reply delivery and submission share one seam.
 */
export function makeCliChannel(agent: LaunchedAgent): CliChannel {
  return {
    id: 'cli',

    authenticate(): InvokerContext {
      return { invoker: 'user' };
    },

    async submit(text: string): Promise<void> {
      // Plain user text → the §8.2 front door. ingest durably records the message + fires
      // the wake seam (fire-and-forget: ingest returns before the turn loop finishes). We
      // pass the authenticated invoker — the chokepoint (PolicyEngine inside Operations) is
      // the only writer; the CLI never touches the tree itself, never forges invoker.
      await agent.operations.invoke_command(
        'messages.ingest',
        { content: text },
        this.authenticate(),
      );
      // Then await the turn barrier so submit resolves only after the agent has finished
      // responding (replies already delivered to onDeliver subscribers, design §4 "AWAIT
      // 它"). launch chains every wake into this serialized tail.
      await awaitTurnsSettled(agent.runtime);
    },

    onDeliver(cb: (event: ReplyEvent) => void): () => void {
      // reply = Option B (§6): subscribe to the MessagesApp push channel. If the
      // messages app was disabled in config there is nothing to deliver, so return an
      // inert unsubscribe thunk (the UI degrades to command-only interaction).
      if (agent.messages === null) return () => undefined;
      return agent.messages.onReply((event) =>
        cb({ id: event.id, content: event.content, ...(event.reply_to ? { reply_to: event.reply_to } : {}) }),
      );
    },
  };
}
