import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_CAPS,
  evaluateCaps,
  type CapsConfig,
  type UsageSnapshot,
} from './caps';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const defaultConfig: CapsConfig = { ...DEFAULT_CAPS };

function snap(
  tokens: number,
  elapsed_ms: number,
  soft_tripped_axis: UsageSnapshot['soft_tripped_axis'] = null,
): UsageSnapshot {
  return { tokens, elapsed_ms, soft_tripped_axis };
}

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

describe('DEFAULT_CAPS', () => {
  it('has sensible defaults', () => {
    expect(DEFAULT_CAPS.tokens_soft).toBe(100_000);
    expect(DEFAULT_CAPS.walltime_soft_ms).toBe(45 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// Pre-soft: everything under threshold
// ---------------------------------------------------------------------------

describe('evaluateCaps — under soft caps', () => {
  it('returns continue when both axes are well under', () => {
    const result = evaluateCaps(defaultConfig, snap(50_000, 10 * 60 * 1000));
    expect(result.action).toBe('continue');
    expect(result.axis).toBeNull();
  });

  it('returns continue at zero usage', () => {
    const result = evaluateCaps(defaultConfig, snap(0, 0));
    expect(result.action).toBe('continue');
  });

  it('returns continue just below both soft caps', () => {
    const result = evaluateCaps(defaultConfig, snap(99_999, 45 * 60 * 1000 - 1));
    expect(result.action).toBe('continue');
  });
});

// ---------------------------------------------------------------------------
// Soft signal: token axis
// ---------------------------------------------------------------------------

describe('evaluateCaps — token soft cap', () => {
  it('signals soft when tokens hit exactly the soft cap', () => {
    const result = evaluateCaps(defaultConfig, snap(100_000, 10 * 60 * 1000));
    expect(result.action).toBe('soft_signal');
    expect(result.axis).toBe('tokens');
  });

  it('signals soft when tokens exceed soft cap', () => {
    const result = evaluateCaps(defaultConfig, snap(110_000, 10 * 60 * 1000));
    expect(result.action).toBe('soft_signal');
    expect(result.axis).toBe('tokens');
  });
});

// ---------------------------------------------------------------------------
// Soft signal: walltime axis
// ---------------------------------------------------------------------------

describe('evaluateCaps — walltime soft cap', () => {
  it('signals soft when walltime hits exactly the soft cap', () => {
    const result = evaluateCaps(defaultConfig, snap(50_000, 45 * 60 * 1000));
    expect(result.action).toBe('soft_signal');
    expect(result.axis).toBe('walltime');
  });

  it('signals soft when walltime exceeds soft cap', () => {
    const result = evaluateCaps(defaultConfig, snap(50_000, 50 * 60 * 1000));
    expect(result.action).toBe('soft_signal');
    expect(result.axis).toBe('walltime');
  });
});

// ---------------------------------------------------------------------------
// Soft signal: both axes near-simultaneous
// ---------------------------------------------------------------------------

describe('evaluateCaps — both axes hit simultaneously', () => {
  it('picks the axis proportionally further past when both are exactly at soft', () => {
    // Both at exactly 1.0× — tokenRatio === walltimeRatio, tokens wins (>=)
    const result = evaluateCaps(defaultConfig, snap(100_000, 45 * 60 * 1000));
    expect(result.action).toBe('soft_signal');
    // Either axis is acceptable; the implementation picks tokens when ratios tie
    expect(result.axis).toBe('tokens');
  });

  it('picks walltime when walltime ratio is higher', () => {
    // Tokens at 1.05×, walltime at 1.10×
    const result = evaluateCaps(defaultConfig, snap(105_000, 49.5 * 60 * 1000));
    expect(result.action).toBe('soft_signal');
    expect(result.axis).toBe('walltime');
  });

  it('picks tokens when token ratio is higher', () => {
    // Tokens at 1.20×, walltime at 1.05×
    const result = evaluateCaps(defaultConfig, snap(120_000, 47.25 * 60 * 1000));
    expect(result.action).toBe('soft_signal');
    expect(result.axis).toBe('tokens');
  });
});

// ---------------------------------------------------------------------------
// Hard kill: token axis
// ---------------------------------------------------------------------------

describe('evaluateCaps — hard kill on token axis', () => {
  it('kills when tokens reach 1.5× after soft was signaled on tokens', () => {
    const result = evaluateCaps(defaultConfig, snap(150_000, 20 * 60 * 1000, 'tokens'));
    expect(result.action).toBe('hard_kill');
    expect(result.axis).toBe('tokens');
  });

  it('kills when tokens exceed 1.5× after soft was signaled on tokens', () => {
    const result = evaluateCaps(defaultConfig, snap(200_000, 20 * 60 * 1000, 'tokens'));
    expect(result.action).toBe('hard_kill');
    expect(result.axis).toBe('tokens');
  });

  it('does NOT kill on walltime even if walltime exceeds hard when soft tripped on tokens', () => {
    // Soft tripped on tokens. Walltime is past its hard cap, but that's irrelevant.
    const result = evaluateCaps(defaultConfig, snap(120_000, 70 * 60 * 1000, 'tokens'));
    expect(result.action).toBe('continue');
    expect(result.axis).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Hard kill: walltime axis
// ---------------------------------------------------------------------------

describe('evaluateCaps — hard kill on walltime axis', () => {
  it('kills when walltime reaches 1.5× after soft was signaled on walltime', () => {
    const result = evaluateCaps(defaultConfig, snap(50_000, 67.5 * 60 * 1000, 'walltime'));
    expect(result.action).toBe('hard_kill');
    expect(result.axis).toBe('walltime');
  });

  it('kills when walltime exceeds 1.5× after soft was signaled on walltime', () => {
    const result = evaluateCaps(defaultConfig, snap(50_000, 80 * 60 * 1000, 'walltime'));
    expect(result.action).toBe('hard_kill');
    expect(result.axis).toBe('walltime');
  });

  it('does NOT kill on tokens even if tokens exceed hard when soft tripped on walltime', () => {
    // Soft tripped on walltime. Tokens are past their hard cap, but that's irrelevant.
    const result = evaluateCaps(defaultConfig, snap(200_000, 50 * 60 * 1000, 'walltime'));
    expect(result.action).toBe('continue');
    expect(result.axis).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Anti-flapping: soft signaled, then continue until hard
// ---------------------------------------------------------------------------

describe('evaluateCaps — anti-flapping', () => {
  it('returns continue after soft was signaled, below hard on tripped axis', () => {
    // Soft tripped on tokens at 100k. Now at 120k — above soft, below hard (150k).
    const result = evaluateCaps(defaultConfig, snap(120_000, 20 * 60 * 1000, 'tokens'));
    expect(result.action).toBe('continue');
    expect(result.reason).toContain('Soft already signaled');
  });

  it('simulates a full lifecycle: continue → soft → continue → hard', () => {
    // Phase 1: under soft
    const r1 = evaluateCaps(defaultConfig, snap(80_000, 20 * 60 * 1000));
    expect(r1.action).toBe('continue');

    // Phase 2: soft tripped
    const r2 = evaluateCaps(defaultConfig, snap(105_000, 25 * 60 * 1000));
    expect(r2.action).toBe('soft_signal');
    expect(r2.axis).toBe('tokens');

    // Phase 3: between soft and hard — caller feeds back soft_tripped_axis
    const r3 = evaluateCaps(defaultConfig, snap(130_000, 28 * 60 * 1000, r2.axis));
    expect(r3.action).toBe('continue');

    // Phase 4: hard kill
    const r4 = evaluateCaps(defaultConfig, snap(155_000, 32 * 60 * 1000, r2.axis));
    expect(r4.action).toBe('hard_kill');
    expect(r4.axis).toBe('tokens');
  });
});

// ---------------------------------------------------------------------------
// Custom config
// ---------------------------------------------------------------------------

describe('evaluateCaps — custom config', () => {
  it('respects custom soft caps', () => {
    const config: CapsConfig = { tokens_soft: 50_000, walltime_soft_ms: 15 * 60 * 1000 };

    // Under custom soft
    expect(evaluateCaps(config, snap(40_000, 10 * 60 * 1000)).action).toBe('continue');

    // Over custom token soft
    const r = evaluateCaps(config, snap(55_000, 10 * 60 * 1000));
    expect(r.action).toBe('soft_signal');
    expect(r.axis).toBe('tokens');

    // Hard kill at 1.5× custom token soft = 75k
    expect(evaluateCaps(config, snap(75_000, 10 * 60 * 1000, 'tokens')).action).toBe('hard_kill');
  });

  it('computes hard cap as 1.5× of the custom soft, not default', () => {
    const config: CapsConfig = { tokens_soft: 200_000, walltime_soft_ms: 60 * 60 * 1000 };

    // Token hard = 300k
    expect(evaluateCaps(config, snap(250_000, 30 * 60 * 1000, 'tokens')).action).toBe('continue');
    expect(evaluateCaps(config, snap(300_000, 30 * 60 * 1000, 'tokens')).action).toBe('hard_kill');

    // Walltime hard = 90 min
    expect(evaluateCaps(config, snap(100_000, 80 * 60 * 1000, 'walltime')).action).toBe('continue');
    expect(evaluateCaps(config, snap(100_000, 90 * 60 * 1000, 'walltime')).action).toBe('hard_kill');
  });
});
