import { describe, it, expect, vi } from 'vitest';
import { waitForMatch } from './waitForMatch';

function freshRoot(): HTMLElement {
    const root = document.createElement('div');
    document.body.append(root);
    return root;
}

describe('waitForMatch', () => {
    it('resolves without waiting when the match is already there', async () => {
        const root = freshRoot();
        root.innerHTML = '<span id="target"></span>';

        const found = await waitForMatch(() => root.querySelector('#target'), 1000, root);

        expect((found as HTMLElement)?.id).toBe('target');
    });

    it('resolves as soon as the match is added later', async () => {
        const root = freshRoot();
        const pending = waitForMatch(() => root.querySelector('#target'), 1000, root);

        root.innerHTML = '<span id="target"></span>';

        expect(((await pending) as HTMLElement)?.id).toBe('target');
    });

    it('sees a match added deep inside an existing subtree', async () => {
        const root = freshRoot();
        root.innerHTML = '<div><section></section></div>';
        const pending = waitForMatch(() => root.querySelector('#target'), 1000, root);

        root.querySelector('section')!.innerHTML = '<span id="target"></span>';

        expect(((await pending) as HTMLElement)?.id).toBe('target');
    });

    // A probe's answer can flip on an attribute edit alone: the flyout's claim
    // control toggles data-disabled on the same node, and an observer watching
    // only childList never re-probes that.
    it('sees a match that appears through an attribute change on an existing node', async () => {
        const root = freshRoot();
        root.innerHTML = '<button type="button" data-disabled="true"></button>';
        const probe = () => (root.querySelector('button')!.getAttribute('data-disabled') === 'false'
            ? root.querySelector('button')
            : null);
        const pending = waitForMatch(probe, 1000, root);

        root.querySelector('button')!.setAttribute('data-disabled', 'false');

        expect(((await pending) as HTMLElement)?.tagName).toBe('BUTTON');
    });

    // The claim-flow probes also key on [role="dialog"]: a flyout that turns an
    // existing node into a dialog via a role edit (not a node insertion) must
    // still re-run the probe, so role stays in the attribute filter.
    it('sees a match that appears through a role attribute change on an existing node', async () => {
        const root = freshRoot();
        root.innerHTML = '<section></section>';
        const pending = waitForMatch(() => root.querySelector('[role="dialog"]'), 1000, root);

        root.querySelector('section')!.setAttribute('role', 'dialog');

        expect(((await pending) as HTMLElement)?.tagName).toBe('SECTION');
    });

    it('resolves null when the match never appears, instead of hanging', async () => {
        const root = freshRoot();

        expect(await waitForMatch(() => root.querySelector('#target'), 20, root)).toBeNull();
    });

    it('treats an empty result as "not yet" so callers can wait on a collection', async () => {
        const root = freshRoot();
        const probe = () => {
            const found = [...root.querySelectorAll('a')];
            return found.length > 0 ? found : null;
        };
        const pending = waitForMatch(probe, 1000, root);

        root.innerHTML = '<a></a><a></a>';

        expect((await pending) as unknown[]).toHaveLength(2);
    });

    it('stops probing once it has resolved', async () => {
        const root = freshRoot();
        root.innerHTML = '<span id="target"></span>';
        const probe = vi.fn(() => root.querySelector('#target'));

        await waitForMatch(probe, 1000, root);
        const callsAtResolve = probe.mock.calls.length;
        root.append(document.createElement('span'));
        await new Promise((r) => setTimeout(r, 20));

        expect(probe.mock.calls.length).toBe(callsAtResolve);
    });

    it('resolves null when there is no root to observe', async () => {
        expect(await waitForMatch(() => null, 1000, null)).toBeNull();
    });
});
