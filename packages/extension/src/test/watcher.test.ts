import { describe, it, expect, vi } from 'vitest';
import { Debouncer } from '../rag/watcher';

describe('Debouncer', () => {
  it('coalesces adds and flushes unique paths once', () => {
    vi.useFakeTimers();
    const flush = vi.fn();
    const d = new Debouncer(1000, flush);
    d.add('a.ts'); d.add('b.ts'); d.add('a.ts');
    vi.advanceTimersByTime(999);
    expect(flush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(flush).toHaveBeenCalledWith(['a.ts', 'b.ts']);
    vi.useRealTimers();
  });
});
