import { describe, expect, it } from 'vitest';
import {
  describeForwardedHeaderProblem,
  describeTrustProxyProblem,
  isLocalOrPrivateAddress,
  normalizeAddress,
  parseForwardedHeaderMode,
  parseTrustedProxies,
  resolveClientAddress,
  type ClientAddressResolution,
  type ForwardedHeaderMode
} from '../src/http/clientIp';

/** Resolves as the running API would, for a given TRUST_PROXY value. */
function resolve(spec: string, socket: string | undefined, forwardedFor?: string | string[]): string {
  return resolveClientAddress({ socketAddress: socket, xForwardedFor: forwardedFor }, parseTrustedProxies(spec)).address;
}

/** Resolves a request carrying either or both headers, in a chosen mode. */
function resolveHeaders(
  spec: string,
  socket: string,
  headers: { xForwardedFor?: string | string[]; forwarded?: string | string[]; mode?: ForwardedHeaderMode }
): ClientAddressResolution {
  return resolveClientAddress({ socketAddress: socket, ...headers }, parseTrustedProxies(spec));
}

describe('Client address resolution behind a proxy', () => {
  describe('normalizeAddress', () => {
    it('folds an IPv4-mapped IPv6 address to its IPv4 form', () => {
      expect(normalizeAddress('::ffff:127.0.0.1')).toBe('127.0.0.1');
      expect(normalizeAddress('::ffff:7f00:1')).toBe('127.0.0.1');
      expect(normalizeAddress('::FFFF:10.0.0.7')).toBe('10.0.0.7');
    });

    it('drops ports and IPv6 brackets', () => {
      expect(normalizeAddress('203.0.113.9:51234')).toBe('203.0.113.9');
      expect(normalizeAddress('[2001:db8::1]:443')).toBe('2001:db8::1');
    });

    it('refuses anything that is not an address', () => {
      expect(normalizeAddress('unknown')).toBeNull();
      expect(normalizeAddress('_hidden')).toBeNull();
      expect(normalizeAddress('203.0.113.300')).toBeNull();
      expect(normalizeAddress('203.0.113')).toBeNull();
      expect(normalizeAddress('::ffff:zzzz')).toBeNull();
      // Read as octal by some software and decimal by others: not an identity to trust.
      expect(normalizeAddress('010.0.0.1')).toBeNull();
      expect(normalizeAddress('')).toBeNull();
      expect(normalizeAddress(undefined)).toBeNull();
    });
  });

  describe('with no proxy configured', () => {
    it('ignores X-Forwarded-For entirely', () => {
      expect(resolve('', '203.0.113.50', '198.51.100.7')).toBe('203.0.113.50');
      expect(resolve('', '127.0.0.1', '198.51.100.7, 203.0.113.9')).toBe('127.0.0.1');
    });

    it('reports an unknown peer rather than failing', () => {
      expect(resolve('', undefined, '198.51.100.7')).toBe('unknown');
      expect(resolve('', 'garbage', '198.51.100.7')).toBe('unknown');
    });
  });

  describe('with a trusted proxy', () => {
    it('believes the forwarded client', () => {
      expect(resolve('loopback', '127.0.0.1', '198.51.100.7')).toBe('198.51.100.7');
      expect(resolve('loopback', '::1', '2001:db8::5')).toBe('2001:db8::5');
      // A dual-stack listener reports the IPv4 peer as IPv4-mapped, so it must still match.
      expect(resolve('loopback', '::ffff:127.0.0.1', '198.51.100.7')).toBe('198.51.100.7');
    });

    it('still ignores the header when the peer is not a trusted proxy', () => {
      expect(resolve('loopback', '203.0.113.50', '1.2.3.4')).toBe('203.0.113.50');
      expect(resolve('10.0.0.0/8', '192.168.1.5', '1.2.3.4')).toBe('192.168.1.5');
    });

    it('discards what the client claims to the left of the proxy that saw it', () => {
      // The attacker writes "1.2.3.4"; the proxy appends the address it accepted from.
      expect(resolve('loopback', '127.0.0.1', '1.2.3.4, 198.51.100.7')).toBe('198.51.100.7');
      // Two hops: the second proxy is trusted too, so the first untrusted entry wins.
      expect(resolve('loopback,10.0.0.0/8', '127.0.0.1', '198.51.100.7, 10.0.0.5')).toBe(
        '198.51.100.7'
      );
    });

    it('falls back to the peer when every hop is a trusted stopover', () => {
      expect(resolve('loopback,10.0.0.0/8', '127.0.0.1', '203.0.113.9, 10.0.0.5')).toBe(
        '203.0.113.9'
      );
      expect(resolve('loopback', '127.0.0.1', '')).toBe('127.0.0.1');
      expect(resolve('loopback', '127.0.0.1', undefined)).toBe('127.0.0.1');
    });

    it('drops entries that are not addresses instead of storing them', () => {
      expect(resolve('loopback', '127.0.0.1', 'not-an-address, 198.51.100.7')).toBe(
        '198.51.100.7'
      );
      expect(resolve('loopback', '127.0.0.1', '<script>, unknown')).toBe('127.0.0.1');
    });

    it('reads a chain of claim, proxy, proxy from right to left', () => {
      const chain = ['203.0.113.9', '10.0.0.5', '10.0.0.6'];
      expect(resolve('loopback,10.0.0.0/8', '127.0.0.1', chain.join(', '))).toBe('203.0.113.9');
      // A proxy the configuration does not name becomes the answer: the chain stops there.
      expect(resolve('loopback', '127.0.0.1', chain.join(', '))).toBe('10.0.0.6');
    });

    it('accepts a repeated header', () => {
      expect(resolve('loopback', '127.0.0.1', ['198.51.100.7', '10.0.0.5'])).toBe('10.0.0.5');
    });

    it('keeps the hops nearest the server when the header is padded', () => {
      // A client can add entries for free, and they land to the left of the proxy's own
      // observation, so padding must never push the believable hop out of view.
      const flood = Array.from({ length: 500 }, (_, i) => `188.0.${i % 250}.1`);
      expect(resolve('loopback', '127.0.0.1', [...flood, '198.51.100.7'].join(','))).toBe(
        '198.51.100.7'
      );
      expect(resolve('loopback', '127.0.0.1', flood.join(','))).toBe('188.0.249.1');
    });
  });

  describe('the trusted proxy list itself', () => {
    it('matches a CIDR range at its boundary', () => {
      const policy = parseTrustedProxies('172.16.0.0/12');
      expect(policy.isTrusted('172.31.255.255')).toBe(true);
      expect(policy.isTrusted('172.16.0.0')).toBe(true);
      expect(policy.isTrusted('172.32.0.0')).toBe(false);
      expect(policy.isTrusted('172.15.255.255')).toBe(false);
    });

    it('matches IPv6 ranges, and never mixes address families', () => {
      const policy = parseTrustedProxies('2001:db8::/32');
      expect(policy.isTrusted('2001:db8:1234::9')).toBe(true);
      expect(policy.isTrusted('2001:db9::1')).toBe(false);

      const v4Only = parseTrustedProxies('127.0.0.0/8');
      expect(v4Only.isTrusted('::1')).toBe(false);
      expect(v4Only.isTrusted('::ffff:127.0.0.1')).toBe(true);
    });

    it('matches loopback, and only loopback, for the loopback keyword', () => {
      const policy = parseTrustedProxies('loopback');
      expect(policy.isTrusted('127.0.0.1')).toBe(true);
      expect(policy.isTrusted('127.255.255.254')).toBe(true);
      expect(policy.isTrusted('::1')).toBe(true);
      expect(policy.isTrusted('128.0.0.1')).toBe(false);
      expect(policy.isTrusted('::2')).toBe(false);
    });

    it('trusts every peer only when it is asked to', () => {
      const policy = parseTrustedProxies('true');
      expect(policy.trustsEveryone).toBe(true);
      expect(resolve('true', '127.0.0.1', '1.2.3.4, 198.51.100.7')).toBe('1.2.3.4');
      expect(parseTrustedProxies('loopback').trustsEveryone).toBe(false);
      expect(parseTrustedProxies('').trustsEveryone).toBe(false);
    });

    it('refuses a value it cannot use, naming the offending token', () => {
      expect(() => parseTrustedProxies('proxy.example.com')).toThrow(/proxy\.example\.com/);
      expect(() => parseTrustedProxies('10.0.0.0/33')).toThrow(/10\.0\.0\.0\/33/);
      expect(() => parseTrustedProxies('2001:db8::/129')).toThrow(/2001:db8::\/129/);
      expect(() => parseTrustedProxies(',,')).toThrow(/named no proxies/);

      expect(describeTrustProxyProblem('loopback,10.0.0.0/8')).toBeNull();
      expect(describeTrustProxyProblem('')).toBeNull();
      expect(describeTrustProxyProblem('10.0.0.1/8/2')).toMatch(/Unrecognised trusted proxy/);
    });
  });

  describe('the RFC 7239 Forwarded header', () => {
    it('reads the client, the protocol and the host from one element', () => {
      const resolved = resolveHeaders('loopback', '127.0.0.1', {
        forwarded: 'for=192.0.2.60;proto=https;host=orders.example',
        mode: 'forwarded'
      });
      expect(resolved).toEqual({
        address: '192.0.2.60',
        protocol: 'https',
        host: 'orders.example'
      });
    });

    it('accepts the node spellings the RFC allows, quoted or not', () => {
      const cases: Array<[string, string]> = [
        ['for=192.0.2.43', '192.0.2.43'],
        ['for=192.0.2.43:47011', '192.0.2.43'],
        ['for="192.0.2.43:47011"', '192.0.2.43'],
        ['for="[2001:db8:cafe::17]:4711"', '2001:db8:cafe::17'],
        ['for="[2001:db8:cafe::17]"', '2001:db8:cafe::17'],
        // Technically it has to be quoted, but proxies emit it bare often enough that
        // refusing it would turn a working deployment into a broken one.
        ['for=2001:db8:cafe::17', '2001:db8:cafe::17'],
        // An obfuscated port is not part of the address.
        ['for="192.0.2.43:_port"', '192.0.2.43']
      ];

      for (const [header, expected] of cases) {
        expect(resolveHeaders('loopback', '127.0.0.1', { forwarded: header, mode: 'forwarded' }))
          .toMatchObject({ address: expected });
      }
    });

    it('treats parameter names as case-insensitive and skips surrounding whitespace', () => {
      const resolved = resolveHeaders('loopback', '127.0.0.1', {
        forwarded: 'FOR=192.0.2.60 ; Proto = HTTPS ; HOST = Orders.Example',
        mode: 'forwarded'
      });
      expect(resolved).toMatchObject({
        address: '192.0.2.60',
        protocol: 'https',
        host: 'orders.example'
      });
    });

    it('reads a repeated header as one list, walking from the server outwards', () => {
      const resolved = resolveHeaders('loopback,10.0.0.0/8', '127.0.0.1', {
        forwarded: ['for=198.51.100.7', 'for=10.0.0.5'],
        mode: 'forwarded'
      });
      expect(resolved.address).toBe('198.51.100.7');
    });

    it('skips trusted hops and stops at the first untrusted one', () => {
      const resolved = resolveHeaders('127.0.0.1,10.0.0.0/8', '127.0.0.1', {
        forwarded: 'for=198.51.100.9, for=10.0.0.7;proto=https;host=hop.example',
        mode: 'forwarded'
      });
      // The fields belong to the element that named the client, not to a later hop.
      expect(resolved).toEqual({ address: '198.51.100.9' });
    });

    it('takes the protocol and host from the connection the address came from', () => {
      const resolved = resolveHeaders('127.0.0.1,10.0.0.0/8', '127.0.0.1', {
        forwarded:
          'for=198.51.100.9;proto=https;host=orders.example, for=10.0.0.7;proto=http;host=inner.example',
        mode: 'forwarded'
      });
      // The client reached the first proxy over https; `inner.example` is a later hop's
      // own view and is not this client's scheme or host.
      expect(resolved).toEqual({
        address: '198.51.100.9',
        protocol: 'https',
        host: 'orders.example'
      });
    });

    it('reads an obfuscated identifier as a hop that hid its client', () => {
      for (const header of ['for=_hidden', 'for="_SEVKISEK"', 'for=_hidden;proto=https']) {
        expect(resolveHeaders('loopback', '127.0.0.1', { forwarded: header, mode: 'forwarded' })).toEqual({
          address: '127.0.0.1',
          hidden: true
        });
      }
    });

    it('reads unknown as a hop that disclosed nothing', () => {
      for (const header of ['for=unknown', 'for=UNKNOWN', 'for="unknown"', 'for=unknown:4711']) {
        expect(resolveHeaders('loopback', '127.0.0.1', { forwarded: header, mode: 'forwarded' })).toEqual({
          address: '127.0.0.1',
          hidden: true
        });
      }
    });

    it('stops at a hop that hides the client instead of reading older elements', () => {
      // The trusted proxy itself obfuscated: the element to its left is exactly the part
      // of the header the walk exists to discard.
      const resolved = resolveHeaders('loopback', '127.0.0.1', {
        forwarded: 'for=198.51.100.7, for=_hidden',
        mode: 'forwarded'
      });
      expect(resolved).toEqual({ address: '127.0.0.1', hidden: true });
    });

    it('refuses an element that repeats a parameter', () => {
      const resolved = resolveHeaders('loopback', '127.0.0.1', {
        forwarded: 'for=192.0.2.43;for=198.51.100.7',
        mode: 'forwarded'
      });
      expect(resolved).toEqual({ address: '127.0.0.1', hidden: true });
    });

    it('refuses elements it cannot read whole', () => {
      for (const header of [
        'for="192.0.2.43', // unterminated quoted string
        'proto=https', // no `for` at all
        'for=not-an-address',
        'for=<script>',
        '>=192.0.2.43' // not a parameter name
      ]) {
        expect(resolveHeaders('loopback', '127.0.0.1', { forwarded: header, mode: 'forwarded' })).toEqual({
          address: '127.0.0.1',
          hidden: true
        });
      }
    });

    it('ignores extension parameters', () => {
      const resolved = resolveHeaders('loopback', '127.0.0.1', {
        forwarded: 'for=192.0.2.60;by=203.0.113.43;secret=x;tls=a:b:c',
        mode: 'forwarded'
      });
      expect(resolved).toEqual({ address: '192.0.2.60' });
    });

    it('drops a proto or host that could not have come from a real request', () => {
      const cases: Array<[string, Record<string, unknown>]> = [
        ['for=192.0.2.60;proto=javascript:alert(1)', { address: '192.0.2.60' }],
        ['for=192.0.2.60;proto="http s"', { address: '192.0.2.60' }],
        ['for=192.0.2.60;host=exa mple.com', { address: '192.0.2.60' }],
        ['for=192.0.2.60;host=<script>', { address: '192.0.2.60' }],
        ['for=192.0.2.60;host=example.com:99999', { address: '192.0.2.60' }],
        ['for=192.0.2.60;host=..', { address: '192.0.2.60' }]
      ];

      for (const [header, expected] of cases) {
        expect(resolveHeaders('loopback', '127.0.0.1', { forwarded: header, mode: 'forwarded' }))
          .toEqual(expected);
      }

      // A host with a port, and an address literal, do survive.
      expect(
        resolveHeaders('loopback', '127.0.0.1', {
          forwarded: 'for=192.0.2.60;host="[2001:db8::1]:8080"',
          mode: 'forwarded'
        })
      ).toEqual({ address: '192.0.2.60', host: '[2001:db8::1]:8080' });
    });

    it('does not read the RFC header unless the deployment maintains it', () => {
      // The default mode is today's behaviour: X-Forwarded-For only, so a client that
      // invents a Forwarded header changes nothing at all.
      const decoy = { xForwardedFor: '198.51.100.7', forwarded: 'for=1.2.3.4' };
      expect(resolveHeaders('loopback', '127.0.0.1', decoy).address).toBe('198.51.100.7');
      expect(resolveHeaders('loopback', '127.0.0.1', { ...decoy, mode: 'x-forwarded-for' }).address).toBe(
        '198.51.100.7'
      );

      // And in the RFC mode the legacy header is the decoy instead.
      expect(resolveHeaders('loopback', '127.0.0.1', { ...decoy, mode: 'forwarded' }).address).toBe(
        '1.2.3.4'
      );
    });

    it('believes neither header when the deployment maintains both and they disagree', () => {
      const agreed = resolveHeaders('loopback', '127.0.0.1', {
        xForwardedFor: '203.0.113.9',
        forwarded: 'for=203.0.113.9;proto=https;host=orders.example',
        mode: 'both'
      });
      expect(agreed).toEqual({
        address: '203.0.113.9',
        protocol: 'https',
        host: 'orders.example'
      });

      // Disagreement cannot be resolved in the caller's favour, so the peer is used.
      const conflicting = resolveHeaders('loopback', '127.0.0.1', {
        xForwardedFor: '203.0.113.9',
        forwarded: 'for=198.51.100.7',
        mode: 'both'
      });
      expect(conflicting).toEqual({ address: '127.0.0.1', conflict: true });
    });

    it('uses whichever header answered in both mode', () => {
      expect(
        resolveHeaders('loopback', '127.0.0.1', {
          xForwardedFor: '203.0.113.9',
          mode: 'both'
        }).address
      ).toBe('203.0.113.9');
      expect(
        resolveHeaders('loopback', '127.0.0.1', { forwarded: 'for=198.51.100.7', mode: 'both' })
          .address
      ).toBe('198.51.100.7');

      // A header that answered `unknown` is not a competing answer: the other one stands.
      expect(
        resolveHeaders('loopback', '127.0.0.1', {
          xForwardedFor: '203.0.113.9',
          forwarded: 'for=_hidden',
          mode: 'both'
        })
      ).toEqual({ address: '203.0.113.9' });

      // Neither disclosing an address leaves the peer, and says why.
      expect(
        resolveHeaders('loopback', '127.0.0.1', {
          xForwardedFor: 'unknown',
          forwarded: 'for=unknown',
          mode: 'both'
        })
      ).toEqual({ address: '127.0.0.1', hidden: true });
    });

    it('reads no header at all from a peer that is not a trusted proxy', () => {
      const resolved = resolveHeaders('loopback', '203.0.113.50', {
        xForwardedFor: '198.51.100.7',
        forwarded: 'for=1.2.3.4;proto=https',
        mode: 'both'
      });
      expect(resolved).toEqual({ address: '203.0.113.50' });
    });

    it('bounds a padded chain to the hops nearest the server', () => {
      const pad = Array.from({ length: 100 }, (_, i) => `for=188.0.0.${i}`);
      expect(
        resolveHeaders('loopback', '127.0.0.1', {
          forwarded: [...pad, 'for=198.51.100.7'].join(', '),
          mode: 'forwarded'
        }).address
      ).toBe('198.51.100.7');
    });

    it('parses the configured header name, and refuses one it does not know', () => {
      expect(parseForwardedHeaderMode('X-Forwarded-For')).toBe('x-forwarded-for');
      expect(parseForwardedHeaderMode(' forwarded ')).toBe('forwarded');
      expect(parseForwardedHeaderMode('BOTH')).toBe('both');
      expect(() => parseForwardedHeaderMode('xforwardedfor')).toThrow(/xforwardedfor/);
      expect(describeForwardedHeaderProblem('xforwardedfor')).toMatch(/Unrecognised/);
      expect(describeForwardedHeaderProblem('both')).toBeNull();
    });
  });

  describe('isLocalOrPrivateAddress', () => {
    it('recognises the addresses only an internal hop can hold', () => {
      expect(isLocalOrPrivateAddress('127.0.0.1')).toBe(true);
      expect(isLocalOrPrivateAddress('10.1.2.3')).toBe(true);
      expect(isLocalOrPrivateAddress('192.168.0.9')).toBe(true);
      expect(isLocalOrPrivateAddress('::1')).toBe(true);
      expect(isLocalOrPrivateAddress('fd00::1')).toBe(true);
      expect(isLocalOrPrivateAddress('203.0.113.9')).toBe(false);
      expect(isLocalOrPrivateAddress('2001:db8::1')).toBe(false);
      expect(isLocalOrPrivateAddress(undefined)).toBe(false);
    });
  });
});
