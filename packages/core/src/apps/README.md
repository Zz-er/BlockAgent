# src/apps/ — built-in standard apps (wave 2)

The three wave-2 built-in apps live here, one file per implementer. Each file
declares an `AppManifest` and is installed via `AppRegistry.install`. Implementers
import contracts only (`../app/types.js`, `../core/types.js`) — never the registry
class, never each other.

| file | owner | id | spec |
|---|---|---|---|
| `agent_identity.ts` | impl-identity | `agent_identity` | v3.1 §6.1 |
| `messages.ts` | impl-messages | `messages` | v3.1 §6.3 + §8.2 |
| `tools.ts` | impl-tools | `tools` | v3.1 §6.7 |

Full per-app spec (state / tree_namespace / commands / builders / cache_tier) and
the messages-wake seam: see `src/ARCHITECTURE.md` → "Standard-app implementer split"
and "messages-wake seam".

There is intentionally NO `thoughts` app — thinking is emitted on the runtime's UI
channel (`AgentRuntime.onThinking`), never an app/tree (ARCHITECTURE.md
"thinking-channel", DR-27).
