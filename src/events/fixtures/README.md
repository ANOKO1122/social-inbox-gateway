# Webhook fixtures

**手写样本，必须在 Meta 测试账号联调时用真实脱敏载荷核对后才算验证。**

These files are hand-written from memory and inference of the Meta webhook
structure; they were not checked against the official documentation or any real
capture. They are NOT real captures. All IDs (`PAGE_ID_1`, `PSID_1`, `IG_ID_1`, ...), names
and texts are obviously fake; there are no real users, tokens or pages in here.
Never replace them with unredacted production payloads.

## Fields and behaviours that are assumptions

Unverified until compared with a redacted payload from a Meta test account:

- **Time units**: `messaging[].timestamp` is Unix milliseconds; `entry.time` and
  Facebook `changes[].value.created_time` are Unix seconds. (`entry.time` on
  messaging entries may be milliseconds, but the normalizer never reads it for
  messages, so the fixtures only guess at it.)
- **Facebook comment** (`object: "page"`, `changes[].field: "feed"`):
  `value.item`, `value.verb` (`add` / `edited` / `remove`), `value.comment_id`,
  `value.post_id`, `value.parent_id` (equals `post_id` for top-level comments),
  `value.from.id`, `value.message`, `value.created_time`.
- **Instagram comment** (`object: "instagram"`, `changes[].field: "comments"`):
  `value.id`, `value.parent_id` (absent on top-level comments), `value.from.id`,
  `value.text`; there is no per-comment timestamp, so `entry.time` is used.
- **Private messages** (both platforms, `entry[].messaging[]`): `sender.id`,
  `timestamp`, `message.mid`, `message.text`, `message.is_echo`,
  `message.attachments`; `delivery` / `read` / `postback` items carry no `message`.
- **Echo / self detection**: that the page's or account's own messages arrive with
  `message.is_echo: true`, and its own comments with `from.id === entry.id`.
- Fields such as `recipient`, `media`, `from.name`, `from.username`, and
  `unknown_future_field` exist only to check that unknown fields are ignored.

## Behaviours added by the implementation (not from any Meta spec)

- `message.is_echo` fails closed: the message is processed only when `is_echo`
  is absent, `false` or `null`. Any other value (`true`, `'true'`, `'false'`,
  `1`, ...) is treated as an echo and skipped; dropping a real message by
  mistake is preferred over auto-replying to our own.
- A private message is also skipped when `sender.id === entry.id`, even without
  `is_echo` (second reply-loop guard).
- Numeric IDs (`sender.id`, `from.id`, `message.mid`, `comment_id`, Instagram
  `value.id`) are never converted to strings; such an event is skipped. Large
  integers have already lost precision after `JSON.parse`, so a stringified
  value could silently be a wrong ID.
- An empty-string text is treated like a missing one (`text: null`).
- Timestamps must fall in the window 2000-01-01T00:00:00Z (inclusive) to
  2100-01-01T00:00:00Z (exclusive); anything else, including `0`, is treated as
  invalid and the event is skipped. This guards against unit mix-ups.

## Files

| File | Purpose |
| --- | --- |
| `facebook-comment.json` | Top-level Facebook comment (`parent_id` equals `post_id`) |
| `facebook-comment-reply.json` | Reply to a comment (`parent_id` is the parent comment) |
| `facebook-comment-by-page.json` | Comment authored by the page itself (must be skipped) |
| `facebook-comment-edited.json` | `verb: "edited"` (must be skipped) |
| `facebook-comment-removed.json` | `verb: "remove"` (must be skipped) |
| `facebook-message.json` | Facebook private message |
| `facebook-message-echo.json` | Message sent by the page, `is_echo: true` (must be skipped) |
| `facebook-message-delivery.json` | Delivery receipt (must be skipped) |
| `facebook-message-read.json` | Read receipt (must be skipped) |
| `facebook-message-attachment-only.json` | Message with an attachment and no text (kept, `text: null`) |
| `instagram-comment.json` | Top-level Instagram comment |
| `instagram-comment-reply.json` | Instagram reply (`parent_id` set) |
| `instagram-comment-by-account.json` | Comment authored by the account itself (must be skipped) |
| `instagram-message.json` | Instagram private message |
| `mixed-batch.json` | One payload with several valid, skipped and malformed events |
| `unknown-object.json` | Unsupported top-level `object` (must yield no events) |
