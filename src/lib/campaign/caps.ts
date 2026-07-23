/**
 * Campaign cap enforcement — pure decision module.
 *
 * Decides whether an iteration should continue, checkpoint (soft cap),
 * or be killed (hard cap) based on token usage and wall-clock elapsed.
 *
 * Design invariants:
 * - Pure function: no side effects, no process I/O.
 * - Hard cap = 1.5× the soft cap on the **tripped axis only**.
 * - Once soft is signaled, follow-up calls return 'continue' until
 *   the hard threshold on that axis (no flapping).
 * - Orchestrator owns signaling and killing; this module only decides.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CapsConfig {
  /** Soft cap: max tokens before requesting checkpoint. Default 100_000. */
  tokens_soft: number;
  /** Soft cap: max wall-clock milliseconds before requesting checkpoint. Default 1_800_000 (30 min). */
  walltime_soft_ms: number;
}

export interface UsageSnapshot {
  /** Tokens consumed so far in this iteration. */
  tokens: number;
  /** Wall-clock milliseconds elapsed since iteration start. */
  elapsed_ms: number;
  /**
   * If a soft cap was already signaled, which axis tripped it.
   * Caller is responsible for persisting this from the previous result.
   * `null` means soft has not yet been signaled.
   */
  soft_tripped_axis: 'tokens' | 'walltime' | null;
}

export type CapActionType = 'continue' | 'soft_signal' | 'hard_kill';

export interface CapAction {
  action: CapActionType;
  reason: string;
  /** Which axis drove this decision. `null` only when action is 'continue'. */
  axis: 'tokens' | 'walltime' | null;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_CAPS: CapsConfig = {
  tokens_soft: 100_000,
  // 45 minutes (TK-135): Fable-class iterations run longer at higher effort;
  // hard kill stays 1.5× soft (67.5m).
  walltime_soft_ms: 45 * 60 * 1000,
};

// ---------------------------------------------------------------------------
// Decision function
// ---------------------------------------------------------------------------

/**
 * Evaluate current usage against caps and return the appropriate action.
 *
 * Call this at each checkpoint opportunity. The caller must feed back
 * `result.axis` as `soft_tripped_axis` on subsequent calls whenever
 * `result.action === 'soft_signal'`.
 */
export function evaluateCaps(config: CapsConfig, usage: UsageSnapshot): CapAction {
  const { tokens_soft, walltime_soft_ms } = config;
  const { tokens, elapsed_ms, soft_tripped_axis } = usage;

  // Hard caps are 1.5× of the corresponding soft cap.
  const tokens_hard = tokens_soft * 1.5;
  const walltime_hard_ms = walltime_soft_ms * 1.5;

  // ----- Post-soft phase: soft already signaled on one axis -----
  if (soft_tripped_axis !== null) {
    // Check hard kill on the tripped axis only.
    if (soft_tripped_axis === 'tokens' && tokens >= tokens_hard) {
      return {
        action: 'hard_kill',
        reason: `Token hard cap reached: ${tokens} >= ${tokens_hard} (1.5× soft ${tokens_soft})`,
        axis: 'tokens',
      };
    }
    if (soft_tripped_axis === 'walltime' && elapsed_ms >= walltime_hard_ms) {
      return {
        action: 'hard_kill',
        reason: `Walltime hard cap reached: ${elapsed_ms}ms >= ${walltime_hard_ms}ms (1.5× soft ${walltime_soft_ms}ms)`,
        axis: 'walltime',
      };
    }
    // Between soft and hard on the tripped axis → continue (no flapping).
    return {
      action: 'continue',
      reason: `Soft already signaled on ${soft_tripped_axis}; below hard cap`,
      axis: null,
    };
  }

  // ----- Pre-soft phase: check both axes -----

  const tokens_over = tokens >= tokens_soft;
  const walltime_over = elapsed_ms >= walltime_soft_ms;

  if (!tokens_over && !walltime_over) {
    return { action: 'continue', reason: 'Below soft caps', axis: null };
  }

  // One or both axes hit soft. Determine which axis to report.
  // If both are over, pick the one proportionally further past its threshold.
  let axis: 'tokens' | 'walltime';

  if (tokens_over && !walltime_over) {
    axis = 'tokens';
  } else if (!tokens_over && walltime_over) {
    axis = 'walltime';
  } else {
    // Both over — compare how far past each is, proportionally.
    const tokenRatio = tokens / tokens_soft;
    const walltimeRatio = elapsed_ms / walltime_soft_ms;
    axis = tokenRatio >= walltimeRatio ? 'tokens' : 'walltime';
  }

  if (axis === 'tokens') {
    return {
      action: 'soft_signal',
      reason: `Token soft cap reached: ${tokens} >= ${tokens_soft}`,
      axis: 'tokens',
    };
  }

  return {
    action: 'soft_signal',
    reason: `Walltime soft cap reached: ${elapsed_ms}ms >= ${walltime_soft_ms}ms`,
    axis: 'walltime',
  };
}
