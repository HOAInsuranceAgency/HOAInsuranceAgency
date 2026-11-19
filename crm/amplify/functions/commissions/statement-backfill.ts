import { GetCommand, QueryCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { statementIndexWrites, STATEMENT_INDEX_STATE } from './statement-index';
import type { Change } from './store';
/** Restartable online backfill. Source versions fence each projection batch against concurrent writes. */
export async function backfillStatementIndexes(db: Pick<DynamoDBDocumentClient, 'send'>, table: string, apply = false) {
  const ready = await db.send(new GetCommand({TableName:table,Key:{kind:'INDEX_STATE',id:STATEMENT_INDEX_STATE},ConsistentRead:true}));
  if (ready.Item) return {ready:true, records:0, applied:false};
  let records = 0;
  for (const kind of ['STATEMENT_INTAKE','INTAKE_SETTLEMENT']) {
    let cursor: Record<string, unknown> | undefined;
    do {
      const page = await db.send(new QueryCommand({TableName:table,ConsistentRead:true,KeyConditionExpression:'#kind = :kind',ExpressionAttributeNames:{'#kind':'kind'},ExpressionAttributeValues:{':kind':kind},Limit:25,ExclusiveStartKey:cursor}));
      for (const item of page.Items ?? []) {
        records++;
        let row = item;
        if (!Number.isInteger(row.version) || typeof row.id !== 'string') throw new Error('A source record requires review before lookup backfill.');
        if (!apply) {statementIndexWrites(table,{kind,value:row as Change['value']});continue;}
        for (let attempt=0;;attempt++) {
          const writes = statementIndexWrites(table,{kind,value:row as Change['value']});
          try {
            for(let offset=0;offset<writes.length;offset+=90) await db.send(new TransactWriteCommand({TransactItems:[
              {ConditionCheck:{TableName:table,Key:{kind,id:row.id},ConditionExpression:'#v = :v',ExpressionAttributeNames:{'#v':'version'},ExpressionAttributeValues:{':v':row.version}}},
              ...writes.slice(offset,offset+90),
            ]}));
            break;
          } catch(error) {
            if ((error as Error).name !== 'TransactionCanceledException' || attempt >= 4) throw error;
            const latest = await db.send(new GetCommand({TableName:table,Key:{kind,id:row.id},ConsistentRead:true}));
            if (!latest.Item) throw new Error('A source record disappeared during lookup backfill.');
            row=latest.Item;
          }
        }
      }
      cursor=page.LastEvaluatedKey;
    } while(cursor);
  }
  if(apply) await db.send(new TransactWriteCommand({TransactItems:[{Put:{TableName:table,Item:{kind:'INDEX_STATE',id:STATEMENT_INDEX_STATE,version:1,completedAt:new Date().toISOString()},ConditionExpression:'attribute_not_exists(id)'}}]}));
  return {ready:apply,records,applied:apply};
}
