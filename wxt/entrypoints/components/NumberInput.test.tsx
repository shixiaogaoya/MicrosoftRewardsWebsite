(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import NumberInput from '@/entrypoints/components/NumberInput';

// happy-dom supplies document. The field is driven through real events, so the
// draft rules — what typing may leave on screen, what Enter and blur do with
// it — are the ones a user gets. A commit feeds the new value back as the prop,
// the way the popup's useStorage value would.
describe('NumberInput', () => {
  let host: HTMLDivElement;
  let root: Root;
  let committed: number[];

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    committed = [];
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  function render(value: number): void {
    act(() => {
      root.render(
        <NumberInput
          id="searches"
          kind="searches"
          label="搜索次数"
          unit="次"
          hint="1～999 的整数"
          value={value}
          onChange={(next) => {
            committed.push(next);
            render(next);
          }}
        />
      );
    });
  }

  function input(): HTMLInputElement {
    const el = host.querySelector('input');
    if (!el) throw new Error('input missing');
    return el;
  }

  function type(text: string): void {
    act(() => {
      const el = input();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  function pressEnter(): void {
    act(() => {
      input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
  }

  function blur(): void {
    act(() => {
      input().dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
  }

  it('replaces an invalid draft on Enter and on blur', () => {
    render(5);

    type('abc');
    expect(input().value).toBe('abc');
    expect(input().getAttribute('aria-invalid')).toBe('true');

    pressEnter();
    expect(input().value).toBe('5');
    expect(input().getAttribute('aria-invalid')).toBe('false');
    expect(committed).toEqual([]);

    type('1e3');
    expect(input().getAttribute('aria-invalid')).toBe('true');

    blur();
    expect(input().value).toBe('5');
    expect(input().getAttribute('aria-invalid')).toBe('false');
    expect(committed).toEqual([]);
  });

  it('commits a valid draft on Enter', () => {
    render(5);

    type('12');
    pressEnter();
    expect(committed).toEqual([12]);
    expect(input().value).toBe('12');
  });
});
