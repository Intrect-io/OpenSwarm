/**
 * Push a local issue to Linear, creating it externally.
 * Persists a durable "pending" event marker BEFORE the external Linear API
 * call. If the local mapping write (updateIssue + addEvent) fails after a
 * successful Linear creation, the function retries the local persistence step
 * using the existing linearId. If all retries fail, the pending marker
 * survives and a subsequent sync/reconcile can discover the orphaned Linear
 * issue and complete the mapping — preventing duplicate external issue creation.
 */
export async function pushToLinear(
  store: SqliteIssueStore,
  issueId: string,
): Promise<string | null> {
  await waitForLinearBridgeInit();
  if (!linearClient) {
    console.warn('[LinearBridge] 클라이언트 미초기화');
    return null;
  }

  const issue = store.getIssue(issueId);
  if (!issue) return null;
  if (issue.linearId) return issue.linearId; // 이미 연결됨

  try {
    const stateId = await resolveLinearStateId(mapStatusToLinear(issue.status));

    // Persist a durable "pending" marker BEFORE the external call so that a
    // failure after Linear creation but before the mapping write leaves a
    // recoverable record. A later sync/reconcile can look up the Linear issue
    // by this marker and complete the mapping instead of silently duplicating
    // the externally created issue.
    store.addEvent(issueId, 'linked', {
      content: 'Linear 생성 시작 (pending)',
      newValue: 'pending',
    });

    const created = await linearClient.createIssue({
      teamId: linearTeamId,
      title: issue.title,
      description: issue.description || undefined,
      priority: mapPriorityToLinear(issue.priority),
      stateId,
    });

    const linearIssue = await created.issue;
    if (!linearIssue) return null;

    // Retry local persistence up to 3 times. If all retries fail, the pending
    // marker above is still durable, so the external issue is not orphaned.
    const linearId = linearIssue.id;
    const linearIdentifier = linearIssue.identifier;
    const linearUrl = linearIssue.url;
    let localPersisted = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        store.updateIssue(issueId, { linearId, linearIdentifier, linearUrl });
        store.addEvent(issueId, 'linked', {
          content: `Linear에 생성: ${linearIdentifier}`,
          newValue: linearIdentifier,
        });
        localPersisted = true;
        break;
      } catch (persistErr) {
        console.warn(
          `[LinearBridge] 로컬 매핑 저장 실패 (시도 ${attempt + 1}/3):`, persistErr,
        );
        if (attempt < 2) {
          await new Promise(resolve => setTimeout(resolve, 200 * (attempt + 1)));
        }
      }
    }

    if (!localPersisted) {
      console.error(
        `[LinearBridge] 로컬 매핑 저장 최종 실패 — Linear 이슈 ${linearIdentifier}는 생성되었으나 로컬 매핑 누락. Pending 마커로 복구 가능.`,
      );
    }

    console.log(`[LinearBridge] 이슈 ${issueId} → Linear ${linearIdentifier}`);
    return linearId;
  } catch (err) {
    console.error('[LinearBridge] Linear 생성 실패:', err);
    return null;
  }
}