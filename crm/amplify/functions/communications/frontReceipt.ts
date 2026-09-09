type Json = Record<string, unknown>;
const object = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const identifier = (value: unknown) => typeof value === "string" && /^(?:evt|cnv|msg|tea|cmp)_[a-z0-9]+$/.test(value) ? value : undefined;

/** Application hooks cover the company, independently of the API token's workspace scope. */
export function scopedFrontReceipt(envelope: Json, allowedInboxIds: string[]): Json | undefined {
  const event = object(envelope.payload), source = object(event.source);
  if (object(source._meta).type === "inboxes" && Array.isArray(source.data) && source.data.length) {
    const ids = source.data.map(value => object(value).id);
    // Only a complete, explicit source list can prove an event is out of scope.
    if (ids.every(id => typeof id === "string" && /^inb_[a-z0-9]+$/.test(id)) && !ids.some(id => allowedInboxIds.includes(id as string))) return;
  }
  const conversation = object(event.conversation), target = object(event.target);
  // Queue identifiers only. Message bodies, subjects, addresses and comments
  // are fetched later, after the worker verifies current inbox membership.
  return {
    type: typeof envelope.type === "string" ? envelope.type.slice(0, 100) : "",
    authorization: { id: identifier(object(envelope.authorization).id) },
    payload: {
      id: identifier(event.id),
      conversation: { id: identifier(conversation.id), assignee: { id: identifier(object(conversation.assignee).id) } },
      payload: { conversation_id: identifier(object(event.payload).conversation_id) },
      target: { data: { id: identifier(object(target.data).id) } },
      message: { id: identifier(object(event.message).id) },
    },
  };
}
