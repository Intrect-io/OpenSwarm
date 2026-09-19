// Claims about external operations must remain reviewable against this branch.
const EXTERNAL_SUCCESS = /\b(?:deployed|deployment (?:succeeded|complete)|approved|approval granted|production (?:verified|updated)|released)\b|(?:배포|승인)\s*(?:완료|성공|됨)/i;
const OPERATOR_PENDING = /operator action pending|운영자 (?:조치|작업) 대기/i;

export interface PublicationClaimEvidence {
  ready: boolean;
  section?: string;
}

/**
 * A PR that closes an issue must not present an external success as finished
 * unless its body names execution evidence for the immutable head it pushes.
 * An explicit operator-pending statement is honest but still draft-only.
 */
export function publicationClaimEvidence(body: string, headSha: string): PublicationClaimEvidence {
  if (!EXTERNAL_SUCCESS.test(body)) return { ready: true };
  const sameHead = new RegExp(`(?:execution|실행) (?:evidence|증거)[^\\n]*${headSha}`, 'i').test(body);
  if (sameHead) return { ready: true };
  const pending = OPERATOR_PENDING.test(body);
  return {
    ready: false,
    section: [
      '## External-claim evidence',
      pending
        ? 'Operator action pending — this PR is draft until the external action is evidenced for this HEAD.'
        : `Ready publication blocked — external success claim has no execution evidence for HEAD ${headSha}.`,
    ].join('\n'),
  };
}
