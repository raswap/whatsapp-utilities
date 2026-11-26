# Template variables

Rule templates are logic-less Mustache (`{{variable}}`, tech-stack T30). Validation (FR-R4) parses every
template on save and rejects a variable that is not in this namespace, so a typo is an error, not an
empty render. Partials (`{{> name}}`) are never allowed. Sections (`{{#x}}...{{/x}}`) name a variable
from the same list. The list is data in `packages/core/src/rules/templates.ts` (`TEMPLATE_VARIABLES`).

| Namespace | Fields |
| --- | --- |
| `event.*` | `id`, `type`, `chat_id`, `sender_id`, `occurred_at`, `received_at`, `is_backfill`, `is_from_me`, `origin` |
| `message.*` | `id`, `provider_id`, `body`, `type`, `media_mime`, `quoted_body`, `is_from_me`, `occurred_at` |
| `contact.*` | `id`, `display_name`, `phone` (requires `policy.expose_phone: true` on the rule) |
| `chat.*` | `id`, `name`, `type`, `automation_state`, `unread_count` |
| `group.*` | `id`, `name`, `description`, `participant_count` |
| `understand.*` | any field (P2; empty in P1 renders) |
| `facts.*` | any fact key remembered for the chat or contact |
| `account.*` | `name`, `timezone`, `persona`, `sla_reply_minutes` and any custom setting |
| `now.*` | `iso`, `date`, `time`, `weekday`, `hour`, `business_hours` |

Templates appear in `send_message.text`, `notify_operator.title/text`, `notify.title/text`,
`remember_fact.value`, `escalate.reason` and string values of `call_tool.args`. A `remember_fact`
whose value uses `message.*`, `understand.*` or `contact.display_name` is classed `side_effecting`
(FR-R10). Rendered text is escaped per destination channel and capped at 4 096 characters (FR-R3).
