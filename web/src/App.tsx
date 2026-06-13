// The web inspector shell: conversation pane on the LEFT, the animated context
// sidebar on the RIGHT (D3 §4). All session state lives in useSession; this is a
// thin layout that wires it to the two panels.

import { ConversationPane } from './components/ConversationPane.js';
import { ContextSidebar } from './components/ContextSidebar.js';
import { useSession } from './session/useSession.js';

export function App(): JSX.Element {
  const session = useSession();

  return (
    <div className="app">
      <ConversationPane
        chat={session.chat}
        thinking={session.thinking}
        errors={session.errors}
        lastTurn={session.lastTurn}
        connection={session.connection}
        model={session.model}
        onSubmit={session.submit}
      />
      <ContextSidebar
        tierGroups={session.tierGroups}
        churn={session.churn}
        onExpandBlock={session.fetchBlockBody}
        onAcknowledgeChurn={session.acknowledgeChurn}
      />
    </div>
  );
}
