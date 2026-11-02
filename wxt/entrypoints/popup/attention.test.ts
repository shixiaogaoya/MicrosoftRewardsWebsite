import { describe, expect, it } from 'vitest';
import type { TaskResult } from '@/entrypoints/utils/runState';
import { countAttention, needsAttention } from './App';

function result(status: TaskResult['status']): TaskResult {
  return { status };
}

describe('needsAttention', () => {
  it('ignores a task that is still running', () => {
    expect(needsAttention(result('running'))).toBe(false);
    expect(needsAttention(result('completed'))).toBe(false);
    expect(needsAttention(result('not-needed'))).toBe(false);
    expect(needsAttention(undefined)).toBe(false);
  });

  it('counts only results the user still has to look at', () => {
    expect(needsAttention(result('failed'))).toBe(true);
    expect(needsAttention(result('unconfirmed'))).toBe(true);
    expect(needsAttention(result('cancelled'))).toBe(true);
  });

  it('does not count an in-progress search toward 待确认', () => {
    expect(countAttention({
      search: result('running'),
    })).toBe(0);
    expect(countAttention({
      search: result('running'),
      daily: result('unconfirmed'),
      claim: result('completed'),
    })).toBe(1);
  });
});
