// The conversation pane (left): user messages + agent replies, a thinking stream,
// an error banner, a turn footer, and the composer. The composer's submit is the
// ONLY write the client sends (§4.7).

import { useEffect, useRef, useState } from 'react';
import type {
  ChatEntry,
  ErrorEntry,
  ThinkingEntry,
  TurnInfo,
} from '../session/types.js';
import type { ConnectionState } from '../protocol/client.js';
import { formatWeight } from '../lib/weight.js';

interface ConversationPaneProps {
  chat: ChatEntry[];
  thinking: ThinkingEntry[];
  errors: ErrorEntry[];
  lastTurn: TurnInfo | null;
  connection: ConnectionState;
  model: string | null;
  onSubmit: (text: string) => void;
}

export function ConversationPane({
  chat,
  thinking,
  errors,
  lastTurn,
  connection,
  model,
  onSubmit,
}: ConversationPaneProps): JSX.Element {
  return (
    <main className="conversation">
      <header className="conversation__header">
        <h1>block-agent</h1>
        <span className={`conn conn--${connection}`}>{connection}</span>
        {model && <span className="model-tag">{model}</span>}
      </header>

      {errors.length > 0 && <ErrorBanner errors={errors} />}

      <MessageList chat={chat} />

      {thinking.length > 0 && <ThinkingStream thinking={thinking} />}

      {lastTurn && <TurnFooter turn={lastTurn} />}

      <Composer onSubmit={onSubmit} disabled={connection !== 'open'} />
    </main>
  );
}

function MessageList({ chat }: { chat: ChatEntry[] }): JSX.Element {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chat.length]);

  return (
    <div className="messages">
      {chat.length === 0 && <div className="messages__empty">Say something to the agent…</div>}
      {chat.map((entry) => (
        <div key={entry.id} className={`message message--${entry.role}`}>
          <span className="message__role">{entry.role}</span>
          <span className="message__text">{entry.text}</span>
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}

function ThinkingStream({ thinking }: { thinking: ThinkingEntry[] }): JSX.Element {
  const recent = thinking.slice(-8);
  return (
    <div className="thinking">
      <span className="thinking__label">thinking</span>
      {recent.map((t) => (
        <div key={t.id} className="thinking__line" data-depth={t.spawn_depth}>
          {t.text}
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
