/**
 * cli/external_task_adapter.ts — ExternalTaskAdapter: the trust membrane for
 * task ingestion from OUTSIDE the agent (impl-cli owned).
 *
 * Design: ai_com/design/blockapp-multi-app-architecture.md §3.6 (three audiences) +
 * §4.2 (task.ingest) + ai_com/design/exec-wave4/_briefing.md §2 (ExternalTaskAdapter).
 *
 * A ChannelAdapter, modeled on cli_channel.ts:37 (self-authentication at the membrane).
 * Where the CLI channel stamps every user keystroke `invoker:'user'`, this adapter
 * stamps an external task source as `invoker:'app'` with an `identity:'ext:<src>'`
 * tag — so a webhook / CI hook / cron job can drop a task into the tracker WITHOUT
 * being mistaken for the operator or the model:
 *   - `invoker:'app'`  → PolicyEngine treats it as a peer-app call (task.ingest's
 *     `allowed_invokers` is `['user','app']`, AI-3/§3.6 — the AGENT is excluded,
 *     so the model can never forge an external task; an app/operator source can).
 *   - `identity:'ext:<src>'` → an audit tag (who outside fed this), set AFTER the
 *     adapter "authenticates" the source. NEVER trusted for capability decisions
 *     (the PolicyEngine keys only off `invoker`); it is provenance, not authority.
 *
 * Every action routes through `Operations.invoke_command` (the single mutation
 * chokepoint, INV #11) — the adapter NEVER writes the tree directly and NEVER forges
 * `invoker:'user'`/`'agent'`. `task.ingest` durably appends the task and fires
 * `ctx.wake({kind:'app_event', source:'task', reason:'task_arrived', ref:<id>})`, so
 * the consume-refresh path picks up the new `task_count` on the next render and the
 * agent is woken to react (§4.2 / §5 trace).
 *
 * Holds only the live Operations handle — no React, no Ink — so it is unit-testable
 * on its own (mirrors cli_channel.ts).
 */

import type { Operations, InvokerContext } from '@block-agent/core/core/types.js';

/**
 * ExternalTaskAdapter — the seam an external integration uses to ingest a task.
 *   - `source` is a stable label for the origin (`'webhook'`, `'github'`, `'cron'`,
 *     …); it becomes the `identity:'ext:<source>'` provenance tag.
 *   - `authenticate()` returns the membrane-stamped InvokerContext (invoker=app +
 *     the source-tagged identity) — exposed for parity with CliChannel and so a
 *     caller can inspect the stamp without ingesting.
 *   - `ingest(args)` routes `task.ingest(args)` through the Operations chokepoint
 *     with that context and resolves with the command's CommandResult-shaped return
 *     (the caller can read the assigned id from `.data`). It awaits the chokepoint
 *     only — the turn loop the wake schedules is fire-and-forget from here (§8.2),
 *     exactly as `messages.ingest` is for the CLI channel.
 */

/**
 * ExternalTaskIngest — the `task.ingest` argument contract (§4.2, confirmed with
 * impl-apps). The task's PRIMARY id is internal/deterministic (`task_N`); an external
 * source supplies its own reference via `ext_id` (stored as a SEPARATE foreign-ref
 * field, never the primary id), so the origin can later correlate. `title` is the only
 * required field — the rest mirror the task command's optional knobs.
 */
export interface ExternalTaskIngest {
  /** Human-facing task title (required). */
  title: string;
  /** The source's own id for this item (foreign ref; e.g. a webhook event id). */
  ext_id?: string;
  description?: string;
  priority?: string;
  due?: string;
  tags?: string[];
}

export interface ExternalTaskAdapter {
  readonly id: 'external_task';
  readonly source: string;
  authenticate(): InvokerContext;
  ingest(args: ExternalTaskIngest): Promise<unknown>;
}

/**
 * makeExternalTaskAdapter — build an ExternalTaskAdapter over the live Operations and
 * a source label. The adapter is a thin trust membrane: it authenticates the source as
 * `invoker:'app'` + `identity:'ext:<source>'` and hands every ingest to the chokepoint.
 *
 * `operations` is the SAME `Operations` the launch graph built — so the ingested task
 * flows through PolicyEngine (task.ingest's `['user','app']` invoker gate), the durable
 * jsonl store, and the wake seam, identically to any other app-driven call.
 */
export function makeExternalTaskAdapter(
  operations: Operations,
  source: string,
): ExternalTaskAdapter {
  // The provenance tag stamped on every ingest from this source. Computed once: a
  // source label is fixed per adapter. `ext:` prefix marks "outside the agent".
  const identity = `ext:${source}`;

  return {
    id: 'external_task',
    source,

    authenticate(): InvokerContext {
      // invoker=app (peer-app trust; task.ingest's allowed_invokers excludes the
      // agent, so an external source is NOT the model) + the source-tagged identity
      // (audit provenance only; PolicyEngine never keys capability off identity).
      return { invoker: 'app', identity };
    },

    async ingest(args: ExternalTaskIngest): Promise<unknown> {
      // External task → the chokepoint. task.ingest({title, ext_id?, …}) durably appends
      // + fires the task_arrived wake (fire-and-forget: it returns before the turn loop
      // finishes). We pass the authenticated app-context — never forge user/agent, never
      // touch the tree. The caller reads the assigned task id from the returned
      // CommandResult.data. `args` is the typed §4.2 shape (title required), so a caller
      // cannot accidentally pass `{content}` (the messages.ingest shape) here.
      return operations.invoke_command('task.ingest', args, this.authenticate());
    },
  };
}
