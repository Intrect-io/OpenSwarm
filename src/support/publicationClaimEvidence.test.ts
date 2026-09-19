import { describe, expect, it } from 'vitest';
import { publicationClaimEvidence } from './publicationClaimEvidence.js';

describe('publication claim evidence (AGT-4408)', () => {
  const sha = 'a'.repeat(40);
  it('blocks a ready PR that claims deployment/approval without same-head evidence', () => {
    expect(publicationClaimEvidence('Deployed to production and approved.\nCloses CGF-612', sha)).toMatchObject({ ready: false });
  });
  it('accepts the cgf-portal shape only when its evidence names the pushed head', () => {
    expect(publicationClaimEvidence(`CGF portal deployment complete.\nExecution evidence: run 612 on ${sha}\nCloses CGF-612`, sha)).toEqual({ ready: true });
  });
  it('keeps an operator-pending external claim draft-only', () => {
    expect(publicationClaimEvidence('승인 완료 예정. 운영자 조치 대기.\nCloses CGF-612', sha)).toMatchObject({ ready: false, section: expect.stringContaining('Operator action pending') });
  });
});
