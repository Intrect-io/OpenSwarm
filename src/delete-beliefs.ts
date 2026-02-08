/**
 * 실패한 Beliefs 삭제 스크립트
 * 대상: "서비스 end-to-end 테스트 및 버그 수정" failed 항목
 */
import { connect } from '@lancedb/lancedb';
import { resolve } from 'path';
import { homedir } from 'os';

const MEMORY_DIR = resolve(homedir(), '.claude-swarm/memory');

async function deleteFailedBeliefs() {
  console.log('[Delete] Connecting to LanceDB at:', MEMORY_DIR);

  const db = await connect(MEMORY_DIR);
  const tables = await db.tableNames();

  console.log('[Delete] Available tables:', tables);

  const tableName = tables.find(t => t.includes('memory') || t === 'cognitive_memory');
  if (!tableName) {
    console.log('[Delete] No memory table found');
    return;
  }

  const table = await db.openTable(tableName);

  // 삭제 전 확인
  const beforeCount = await table.countRows();
  console.log(`[Delete] Total records before: ${beforeCount}`);

  // LanceDB delete 사용 - SQL where 조건
  // content에 특정 문자열 포함된 belief 타입 삭제
  const deleteFilter = `type = 'belief' AND content LIKE '%서비스 end-to-end 테스트 및 버그 수정%' AND content LIKE '%failed%'`;

  console.log('[Delete] Applying filter:', deleteFilter);

  await table.delete(deleteFilter);

  const afterCount = await table.countRows();
  console.log(`[Delete] Total records after: ${afterCount}`);
  console.log(`[Delete] Deleted: ${beforeCount - afterCount} records`);

  console.log('[Delete] Done!');
}

deleteFailedBeliefs().catch(console.error);
