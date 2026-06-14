// The conversation pane (left): user messages + agent replies, a thinking stream,
// an error banner, a turn footer, and the composer. The composer's submit is the
// ONLY write the client sends (§4.7).

import { useEffect, useRef, useState } from 'react';
import type {
  ChatEntry,
  ErrorEntry,
  TurnActivity,
  TurnInfo,
} from '../session/types.js';
import type { ConnectionState } from '../protocol/client.js';
import { formatWeight } from '../lib/weight.js';

interface ConversationPaneProps {
  chat: ChatEntry[];
  liveActivity: TurnActivity | null;
  errors: ErrorEntry[];
  lastTurn: TurnInfo | null;
  connection: ConnectionState;
  model: string | null;
  onSubmit: (text: string) => void;
}

export function ConversationPane({
  chat,
  liveActivity,
  errors,
  lastTurn,
  connection,
  model,
  onSubmit,
}: ConversationPaneProps): JSX.Element {
  const live = hasContent(liveActivity) ? liveActivity : null;
  return (
    <main className="conversation">
      <header className="conversation__header">
        <h1>block-agent</h1>
        <span className={`conn conn--${connection}`}>{connection}</span>
        {model && <span className="model-tag">{model}</span>}
      </header>

      {errors.length > 0 && <ErrorBanner errors={errors} />}

      <MessageList chat={chat} live={live} />

      {lastTurn && <TurnFooter turn={lastTurn} />}

      <Composer onSubmit={onSubmit} disabled={connection !== 'open'} />
    </main>
  );
}

/** Does a turn activity have anything to show (thinking or tool calls)? */
function hasContent(a: TurnActivity | null): a is TurnActivity {
  return a !== null && (a.thinking.length > 0 || a.toolCalls.length > 0);
}

function MessageList({ chat, live }: { chat: ChatEntry[]; live: TurnActivity | null }): JSX.Element {
  const endRef = useRef<HTMLDivElement>(null);
  // Re-scroll as messages arrive AND as live activity streams in during a turn.
  const liveLen = (live?.thinking.length ?? 0) + (live?.toolCalls.length ?? 0);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chat.length, liveLen]);

  return (
    <div className="messages">
      {chat.length === 0 && <div className="messages__empty">Say something to the agent…</div>}
      {chat.map((entry) => (
        <div key={entry.id} className={`message message--${entry.role}`}>
          <span className="message__role">{entry.role}</span>
          <span className="message__text">{entry.text}</span>
          {/* The reply's reasoning + tool calls, collapsed under the bubble (expand to inspect). */}
          {entry.activity && <ActivityDisclosure activity={entry.activity} />}
        </div>
      ))}
      {/* The in-flight turn: thinking + tool calls shown LIVE + expanded until the reply lands. */}
      {live && <LiveActivity activity={live} />}
      <div ref={endRef} />
    </div>
  );
}

/** A one-line summary of a turn activity, e.g. "2 thinking · 3 tools". */
function activitySummary(a: TurnActivity): string {
  const parts: string[] = [];
  if (a.thinking.length > 0) parts.push(`${a.thinking.length} thinking`);
  if (a.toolCalls.length > 0) {
    parts.push(`${a.toolCalls.length} tool${a.toolCalls.length > 1 ? 's' : ''}`);
  }
  return parts.join(' · ') || 'details';
}

/** Collapsed reasoning + tool-call trace attached to a completed agent reply. */
function ActivityDisclosure({ activity }: { activity: TurnActivity }): JSX.Element {
  return (
    <details className="activity activity--collapsed">
      <summary className="activity__summary">{activitySummary(activity)}</summary>
      <ActivityBody activity={activity} />
    </details>
  );
}

/** The in-flight turn's activity, shown expanded (no fold) while the agent is working. */
function LiveActivity({ activity }: { activity: TurnActivity }): JSX.Element {
  return (
    <div className="activity activity--live">
      <span className="activity__label">working… ({activitySummary(activity)})</span>
      <ActivityBody activity={activity} />
    </div>
  );
}

/** The shared body: tool calls (name + ✓/✗) then the reasoning lines. */
function ActivityBody({ activity }: { activity: TurnActivity }): JSX.Element {
  return (
    <div className="activity__body">
      {activity.toolCalls.length > 0 && (
        <ul className="tool-calls">
          {activity.toolCalls.map((t, i) => (
            <li key={i} className={`tool-call tool-call--${t.ok ? 'ok' : 'fail'}`}>
              <span className="tool-call__name">{t.name}</span>
              <span className="tool-call__status">{t.ok ? '✓' : '✗'}</span>
            </li>
          ))}
        </ul>
      )}
      {activity.thinking.map((text, i) => (
        <div key={i} className="thinking__line">
          {text}
        </div>
      ))}
    </div>
  );
}

function ErrorBanner({ errors }: { errors: ErrorEntry[] }): JSX.Element {
  const latest = errors[errors.length - 1];
  if (!latest) return <></>;
  return (
    <div className="error-banner" role="alert">
      <strong>{latest.phase} error:</strong> {latest.message}
      {errors.length > 1 && <span className="error-banner__more"> (+{errors.length - 1} more)</span>}
    </div>
  );
}

function TurnFooter({ turn }: { turn: TurnInfo }): JSX.Element {
  const total = Object.values(turn.perTierBytes).reduce<number>((s, n) => s + (n ?? 0), 0);
  return (
    <div className="turn-footer">
      turn {turn.turn_id} · ended by <strong>{turn.ended_by}</strong> · {formatWeight(total)}
    </div>
  );
}

function Composer({
  onSubmit,
  disabled,
}: {
  onSubmit: (text: string) => void;
  disabled: boolean;
}): JSX.Element {
  const [text, setText] = useState('');

  const send = () => {
    if (!text.trim()) return;
    onSubmit(text);
    setText('');
  };

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <input
        className="composer__input"
        value={text}
        placeholder={disabled ? 'connecting…' : 'message the agent'}
        onChange={(e) => setText(e.target.value)}
        disabled={disabled}
      />
      <button className="composer__send" type="submit" disabled={disabled || !text.trim()}>
        send
      </button>
    </form>
  );
}
