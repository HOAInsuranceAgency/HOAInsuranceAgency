import { migrationPendingHeld, migrationPendingKey } from "../migration-pending";
import { get, row, save, type Row } from "./store";

type Position = { nextToken?: string; through?: string };
export type QueueCursor = { id: string; previous?: Row<Position>; nextToken?: string; through: string };

/** A bounded sweep resumes beyond held history, without rewriting that history.
 * A fixed upper deadline makes each sweep finite even while new work arrives.
 * The existing optimistic version prevents overlapping ticks from overwriting
 * another tick's checkpoint. Business rows still use their own send/claim locks.
 */
export async function openQueueCursor(name: string, now: string): Promise<QueueCursor> {
  const id = migrationPendingKey(`queue-cursor:${name}`);
  const previous = await get<Position>(id);
  if (previous && (previous.kind !== "QUEUE_CURSOR" || migrationPendingHeld(previous))) {
    throw new Error("Queue progress has unreviewed migration provenance");
  }
  const nextToken = previous?.data.nextToken;
  const through = nextToken ? previous?.data.through : now;
  if ((nextToken !== undefined && (typeof nextToken !== "string" || !nextToken || nextToken.length > 32_768))
    || typeof through !== "string" || !Number.isFinite(Date.parse(through)) || Date.parse(through) > Date.parse(now)) {
    throw new Error("Queue progress is invalid; review it before resuming");
  }
  return { id, previous, nextToken, through };
}

export async function saveQueueCursor(cursor: QueueCursor, nextToken?: string) {
  return save(row("QUEUE_CURSOR", cursor.id, { nextToken, through: nextToken ? cursor.through : undefined }, { previous: cursor.previous }), cursor.previous);
}
