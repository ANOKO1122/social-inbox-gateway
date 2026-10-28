const EVENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INTENT = /^[a-z0-9_]{1,64}$/;

export interface SuggestionDb {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface StoredSuggestion {
  eventId: string;
  staffId: string;
  intent: string;
  suggestedReply: string;
  needsHuman: boolean;
  sources: string[];
}

export interface SuggestionRecords {
  save(input: StoredSuggestion): Promise<string>;
  markAdopted(input: { id: string; eventId: string; staffId: string }): Promise<void>;
}

export class SuggestionStore implements SuggestionRecords {
  constructor(private readonly db: SuggestionDb) {}

  async save(input: StoredSuggestion): Promise<string> {
    if (!EVENT_ID.test(input.eventId) || !EVENT_ID.test(input.staffId) || !INTENT.test(input.intent)) {
      throw new Error('suggestion_invalid');
    }
    const reply = input.suggestedReply.trim();
    if (reply.length === 0 || reply.length > 8000) {
      throw new Error('suggestion_invalid');
    }
    const result = await this.db.query(
      `INSERT INTO reply_suggestions (
         normalized_event_id, staff_user_id, intent, suggested_reply, needs_human, sources
       )
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       RETURNING id`,
      [input.eventId, input.staffId, input.intent, reply, input.needsHuman, JSON.stringify(input.sources)],
    );
    const id = result.rows[0]?.id;
    if (typeof id !== 'string' || !EVENT_ID.test(id)) {
      throw new Error('suggestion_invalid');
    }
    return id;
  }

  async markAdopted(input: { id: string; eventId: string; staffId: string }): Promise<void> {
    if (!EVENT_ID.test(input.id) || !EVENT_ID.test(input.eventId) || !EVENT_ID.test(input.staffId)) {
      return;
    }
    await this.db.query(
      `UPDATE reply_suggestions
       SET adopted_at = now()
       WHERE id = $1
         AND normalized_event_id = $2
         AND staff_user_id = $3
         AND adopted_at IS NULL`,
      [input.id, input.eventId, input.staffId],
    );
  }
}
