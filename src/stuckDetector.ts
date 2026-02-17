// ============================================
// Claude Swarm - Stuck Detector
// OpenHands-style infinite loop detection
// ============================================

export interface StuckThresholds {
  sameOutputRepeat: number;    // Same output repeat threshold
  sameErrorRepeat: number;     // Same error repeat threshold
  revisionLoop: number;        // REVISE loop threshold
  monologue: number;           // Consecutive agent message threshold
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
   * Add entry to history
   */
  addEntry(entry: HistoryEntry): void {
    this.history.push(entry);

    // Keep only the last 20 entries
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

    // 1. Detect same error loop
    const errorLoop = this.detectErrorLoop();
    if (errorLoop.isStuck) return errorLoop;

    // 2. Detect REVISE infinite loop
    const revisionLoop = this.detectRevisionLoop();
    if (revisionLoop.isStuck) return revisionLoop;

    // 3. Detect same output repeat
    const outputRepeat = this.detectOutputRepeat();
    if (outputRepeat.isStuck) return outputRepeat;

    // 4. Detect Worker monologue (continuous execution without Reviewer)
    const monologue = this.detectMonologue();
    if (monologue.isStuck) return monologue;

    return { isStuck: false };
  }

  /**
   * Detect same error loop
   */
  private detectErrorLoop(): StuckResult {
    const recentErrors = this.history
      .filter(e => !e.success && e.error)
      .slice(-this.thresholds.sameErrorRepeat);

    if (recentErrors.length < this.thresholds.sameErrorRepeat) {
      return { isStuck: false };
    }

    // Check if all errors are the same (compare first 100 chars)
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
   * Detect REVISE infinite loop
   */
  private detectRevisionLoop(): StuckResult {
    const recentReviews = this.history
      .filter(e => e.stage === 'reviewer' && e.decision)
      .slice(-this.thresholds.revisionLoop);

    if (recentReviews.length < this.thresholds.revisionLoop) {
      return { isStuck: false };
    }

    // Check if all are REVISE
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
   * Detect same output repeat
   */
  private detectOutputRepeat(): StuckResult {
    const recentOutputs = this.history
      .filter(e => e.output)
      .slice(-this.thresholds.sameOutputRepeat);

    if (recentOutputs.length < this.thresholds.sameOutputRepeat) {
      return { isStuck: false };
    }

    // Compare output hash (first 500 chars)
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
   * Detect monologue (single stage executing repeatedly)
   */
  private detectMonologue(): StuckResult {
    const recent = this.history.slice(-this.thresholds.monologue);

    if (recent.length < this.thresholds.monologue) {
      return { isStuck: false };
    }

    // Check if all are the same stage
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
   * Output hash (for simple comparison)
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
   * Reset history
   */
  reset(): void {
    this.history = [];
  }

  /**
   * Get current history
   */
  getHistory(): HistoryEntry[] {
    return [...this.history];
  }
}

/**
 * Create detector instance (can be created per session)
 */
export function createStuckDetector(
  thresholds?: Partial<StuckThresholds>
): StuckDetector {
  return new StuckDetector(thresholds);
}
