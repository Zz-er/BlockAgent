/**
 * cli/ui/ContextView.tsx — /context, /apps, /status, results view (impl-cli-ui owned).
 *
 * Design: ai_com/block-agent-cli-design.md §5. Renders the CtxView payload a slash
 * command pushed via setView. The DATA is built read-only in commands.ts /
 * context_view.ts (renderer.render(snapshot), registry.list(), runtime.state); this
 * component only renders it — it never reads core itself.
 */

import { Box, Text } from '../ink.js';
import type { CtxView } from '../types.js';

export interface ContextViewProps {
  view: CtxView | null;
}

export function ContextView({ view }: ContextViewProps): JSX.Element | null {
  if (view === null) return null;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      {renderBody(view)}
    </Box>
  );
}

function renderBody(view: CtxView): JSX.Element {
  switch (view.kind) {
    case 'context':
      return (
        <Box flexDirection="column">
          <Text bold>{`context  ·  ${view.segments.length} segments  ·  hash ${view.snapshot_hash.slice(0, 12)}`}</Text>
          {view.segments.map((s, i) => (
            <Box key={i} flexDirection="row">
              <Text color="yellow">{s.tier.padEnd(10)}</Text>
              <Text dimColor>{`${String(s.bytes).padStart(6)}b `}</Text>
              <Text color={s.cache_boundary ? 'magenta' : 'gray'}>{s.cache_boundary ? '┤cache ' : '       '}</Text>
              <Text wrap="truncate-end">{s.preview}</Text>
            </Box>
          ))}
        </Box>
      );

    case 'apps':
      return (
        <Box flexDirection="column">
          <Text bold>{`apps  ·  ${view.apps.length} installed`}</Text>
          {view.apps.map((a) => (
            <Box key={a.id} flexDirection="column" marginTop={1}>
              <Text>
                <Text color="cyan" bold>{a.id}</Text>
                <Text dimColor>{` v${a.version}`}</Text>
              </Text>
              {a.blocks.length > 0 ? <Text dimColor>{`  blocks: ${a.blocks.join(', ')}`}</Text> : null}
              {a.commands.map((c) => (
                <Text key={c.full_name}>
                  <Text>{`  ${c.full_name}`}</Text>
                  {c.user_only ? <Text color="red">{'  (user-only)'}</Text> : null}
                </Text>
              ))}
            </Box>
          ))}
        </Box>
      );

    case 'status':
      return (
        <Box flexDirection="column">
          <Text bold>status</Text>
          <Text>{`  runtime   ${view.runtime_state}`}</Text>
          <Text>{`  provider  ${view.provider_id}`}</Text>
          <Text>{`  apps      ${view.app_count}`}</Text>
          <Text>{`  turns     ${view.turns}`}</Text>
        </Box>
      );

    case 'command_result':
      return (
        <Box flexDirection="column">
          <Text color={view.ok ? 'green' : 'red'} bold>{view.ok ? 'ok' : 'error'}</Text>
          <Text wrap="wrap">{view.text}</Text>
        </Box>
      );

    case 'message':
      return <Text wrap="wrap">{view.text}</Text>;
  }
}
