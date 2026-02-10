// ============================================
// Claude Swarm - Stuck Detector
// OpenHands 스타일 무한 루프 감지
// ============================================

export interface StuckThresholds {
  sameOutputRepeat: number;    // 같은 출력 반복 임계값
  sameErrorRepeat: number;     // 같은 에러 반복 임계값
  revisionLoop: number;        // REVISE 반복 임계값
  monologue: number;           // 연속 에이전트 메시지 임계값
}

export interface HistoryEntry {
  stage: string;
  success: boolean;
  output?: string;
  error?: string;
  decision?: string;  // Reviewer decision: APPROVE, REVISE, REJECT
  timestamp: number;
}

export interface StuckResult {
  isStuck: boolean;
  reason?: string;
  suggestion?: string;
}

const DEFAULT_THRESHOLDS: StuckThresholds = {
  sameOutputRepeat: 3,
  sameErrorRepeat: 2,
  revisionLoop: 4,
  monologue: 6,
};

/**
 * Stuck Detection 메인 클래스
 */
export class StuckDetector {
  private history: HistoryEntry[] = [];
  private thresholds: StuckThresholds;

  constructor(thresholds: Partial<StuckThresholds> = {}) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  }

  /**
   * 히스토리에 엔트리 추가
   */
  addEntry(entry: HistoryEntry): void {
    this.history.push(entry);

    // 최근 20개만 유지
    if (this.history.length > 20) {
      this.history = this.history.slice(-20);
    }
  }

  /**
   * Stuck 상태 체크
   */
  check(): StuckResult {
    if (this.history.length < 2) {
      return { isStuck: false };
    }

    // 1. 같은 에러 반복 감지
    const errorLoop = this.detectErrorLoop();
    if (errorLoop.isStuck) return errorLoop;

    // 2. REVISE 무한 루프 감지
    const revisionLoop = this.detectRevisionLoop();
    if (revisionLoop.isStuck) return revisionLoop;

    // 3. 같은 출력 반복 감지
    const outputRepeat = this.detectOutputRepeat();
    if (outputRepeat.isStuck) return outputRepeat;

    // 4. Worker 모놀로그 감지 (Reviewer 없이 계속 실행)
    const monologue = this.detectMonologue();
    if (monologue.isStuck) return monologue;

    return { isStuck: false };
  }

  /**
   * 같은 에러 반복 감지
   */
  private detectErrorLoop(): StuckResult {
    const recentErrors = this.history
      .filter(e => !e.success && e.error)
      .slice(-this.thresholds.sameErrorRepeat);

    if (recentErrors.length < this.thresholds.sameErrorRepeat) {
      return { isStuck: false };
    }

    // 모든 에러가 같은지 확인 (처음 100자 비교)
    const firstError = recentErrors[0].error?.slice(0, 100);
    const allSame = recentErrors.every(e =>
      e.error?.slice(0, 100) === firstError
    );

    if (allSame) {
      return {
        isStuck: true,
        reason: `Same error repeated ${recentErrors.length} times`,
        suggestion: 'Task may require manual intervention or different approach',
      };
    }

    return { isStuck: false };
  }

  /**
   * REVISE 무한 루프 감지
   */
  private detectRevisionLoop(): StuckResult {
    const recentReviews = this.history
      .filter(e => e.stage === 'reviewer' && e.decision)
      .slice(-this.thresholds.revisionLoop);

    if (recentReviews.length < this.thresholds.revisionLoop) {
      return { isStuck: false };
    }

    // 모두 REVISE인지 확인
    const allRevise = recentReviews.every(e =>
      e.decision?.toUpperCase() === 'REVISE' ||
      e.decision?.toUpperCase() === 'REVISION_NEEDED' ||
      e.decision?.toUpperCase() === 'REVISION NEEDED'
    );

    if (allRevise) {
      return {
        isStuck: true,
        reason: `Reviewer requested revision ${recentReviews.length} times consecutively`,
        suggestion: 'Task may be too complex or requirements unclear. Consider breaking down or clarifying.',
      };
    }

    return { isStuck: false };
  }

  /**
   * 같은 출력 반복 감지
   */
  private detectOutputRepeat(): StuckResult {
    const recentOutputs = this.history
      .filter(e => e.output)
      .slice(-this.thresholds.sameOutputRepeat);

    if (recentOutputs.length < this.thresholds.sameOutputRepeat) {
      return { isStuck: false };
    }

    // 출력 해시 비교 (처음 500자)
    const firstHash = this.hashOutput(recentOutputs[0].output!);
    const allSame = recentOutputs.every(e =>
      this.hashOutput(e.output!) === firstHash
    );

    if (allSame) {
      return {
        isStuck: true,
        reason: `Same output produced ${recentOutputs.length} times`,
        suggestion: 'Agent may be stuck in a loop. Consider resetting context.',
      };
    }

    return { isStuck: false };
  }

  /**
   * 모놀로그 감지 (한 스테이지만 계속 실행)
   */
  private detectMonologue(): StuckResult {
    const recent = this.history.slice(-this.thresholds.monologue);

    if (recent.length < this.thresholds.monologue) {
      return { isStuck: false };
    }

    // 모두 같은 스테이지인지 확인
    const firstStage = recent[0].stage;
    const allSameStage = recent.every(e => e.stage === firstStage);

    if (allSameStage) {
      return {
        isStuck: true,
        reason: `Stage "${firstStage}" executed ${recent.length} times without progression`,
        suggestion: 'Pipeline may be stuck. Check stage transitions.',
      };
    }

    return { isStuck: false };
  }

  /**
   * 출력 해시 (간단한 비교용)
   */
  private hashOutput(output: string): string {
    const normalized = output.slice(0, 500).toLowerCase().replace(/\s+/g, ' ');
    let hash = 0;
    for (let i = 0; i < normalized.length; i++) {
      const char = normalized.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash.toString(16);
  }

  /**
   * 히스토리 초기화
   */
  reset(): void {
    this.history = [];
  }

  /**
   * 현재 히스토리 조회
   */
  getHistory(): HistoryEntry[] {
    return [...this.history];
  }
}

/**
 * 글로벌 인스턴스 (세션별로 생성해도 됨)
 */
export function createStuckDetector(
  thresholds?: Partial<StuckThresholds>
): StuckDetector {
  return new StuckDetector(thresholds);
}
