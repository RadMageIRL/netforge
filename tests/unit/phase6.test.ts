/** Release-preparation fixes that are not covered by the suites of the modules they touch. */
import { describe, expect, it } from 'vitest';
import { junosConfig, JUNOS_INSTANCE_NAME } from '../../src/core/infra/junos';
import { examplePlan } from '../../src/core/plan/example';
import { lockDown } from '../../src/tools/util-shared/worker-lockdown';

describe('worker lockdown', () => {
  /** A stand-in for a worker's global object: interfaces on the object and on its prototypes. */
  function fakeScope() {
    const grandparent = { fetch: () => 'fetched', WebSocket: function WebSocket() { return {}; } };
    const parent = Object.create(grandparent) as Record<string, unknown>;
    parent.XMLHttpRequest = function XMLHttpRequest() { return {}; };
    parent.importScripts = () => 'imported';
    const scope = Object.create(parent) as Record<string, unknown>;
    scope.EventSource = function EventSource() { return {}; };
    scope.postMessage = () => 'posted';
    scope.navigator = { sendBeacon: () => true, userAgent: 'x' };
    return scope;
  }

  it('replaces every network interface, wherever it lives on the prototype chain, with a refusal', () => {
    const scope = fakeScope();
    const removed = lockDown(scope);
    expect(removed.sort()).toEqual(['EventSource', 'WebSocket', 'XMLHttpRequest', 'fetch', 'importScripts']);
    for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'WebSocketStream', 'EventSource', 'WebTransport', 'RTCPeerConnection', 'importScripts', 'BroadcastChannel', 'SharedWorker', 'Worker']) {
      const value = scope[name] as (...args: unknown[]) => unknown;
      expect([name, typeof value]).toEqual([name, 'function']);
      expect(() => value('https://example.com/')).toThrow('NetForge workers have no network access.');
      expect(() => new (value as unknown as new (u: string) => unknown)('https://example.com/')).toThrow('NetForge workers have no network access.');
    }
    expect(() => (scope.navigator as { sendBeacon: (u: string) => boolean }).sendBeacon('https://example.com/')).toThrow('NetForge workers have no network access.');
  });

  it('cannot be undone: the refusals are neither writable nor configurable', () => {
    const scope = fakeScope();
    lockDown(scope);
    const original = scope.fetch;
    expect(() => { 'use strict'; scope.fetch = () => 'restored'; }).toThrow(TypeError);
    expect(() => Object.defineProperty(scope, 'fetch', { value: () => 'restored' })).toThrow(TypeError);
    expect(Reflect.deleteProperty(scope, 'fetch')).toBe(false);
    expect(scope.fetch).toBe(original);
    // The originals are gone from the prototypes too, so nothing can reach around the refusal.
    expect(Object.getPrototypeOf(Object.getPrototypeOf(scope)).fetch).toBeUndefined();
    expect(Object.getPrototypeOf(scope).XMLHttpRequest).toBeUndefined();
  });

  it('leaves everything else alone and can run twice', () => {
    const scope = fakeScope();
    lockDown(scope);
    expect(lockDown(scope)).toEqual([]);
    expect((scope.postMessage as () => string)()).toBe('posted');
    expect((scope.navigator as { userAgent: string }).userAgent).toBe('x');
  });
});

describe('Junos routing-instance names', () => {
  it('refuses the names Junos uses for its own instances, and names that start with a hyphen', () => {
    for (const name of ['default', 'Default', 'MASTER', 'master', '-GUEST', '_GUEST', '', 'a b', 'a.b']) expect([name, JUNOS_INSTANCE_NAME.test(name)]).toEqual([name, false]);
    for (const name of ['GUEST', 'guest-1', 'Guest_HQ', '1st', 'defaults', 'master2', 'x-default']) expect([name, JUNOS_INSTANCE_NAME.test(name)]).toEqual([name, true]);
  });

  it('writes no IRB interface into an instance with a reserved name', () => {
    const run = (name: string) => junosConfig(examplePlan(), { context: { scope: { siteId: 's1', vrfId: '', namespaceId: '' }, globalVrfId: 'r1', vrfNames: { r2: name } }, sections: { vlans: true, irb: true } });
    const good = run('GUEST');
    expect(good.files[0]!.text).toContain('set routing-instances GUEST interface irb.200');
    for (const name of ['default', 'master', '-GUEST']) {
      const out = run(name);
      expect(out.ok).toBe(true);
      expect(out.files[0]!.text).not.toContain('routing-instances');
      expect(out.files[0]!.text).not.toContain('irb unit 200');
      const guest = out.items.find(i => i.subject === 'VLAN 200 Guest')!;
      expect(guest.notes.some(n => n.fidelity === 'unsupported' && n.field === 'IRB interface')).toBe(true);
    }
  });
});
