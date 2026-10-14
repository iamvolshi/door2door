/**
 * Deciding which address a request really came from.
 *
 * `req.socket.remoteAddress` is the only address in a request a caller cannot choose, so
 * it is the default and the fallback for everything that attributes a request to someone:
 * the rate-limit bucket, the session audit row, the OTP delivery trail. Behind a reverse
 * proxy it is the *proxy's* address, which puts every customer in one rate-limit bucket
 * and writes the proxy into every session row.
 *
 * A forwarded header fixes that only if it is believed selectively. A proxy appends what
 * it observed to the end of the list, so the header reads left-to-right as "whatever the
 * client claimed" followed by each hop's own observation. The chain is therefore walked
 * from the server outwards, and the rightmost hop that is not itself a trusted proxy is
 * the closest thing to the real client the header can prove; anything to its left —
 * including a value an attacker typed — is discarded. Headers are only read at all when
 * the immediate peer is a proxy the operator named in `TRUST_PROXY`.
 *
 * Two header spellings are understood: `X-Forwarded-For`, the de-facto list of addresses,
 * and RFC 7239's `Forwarded`, which is the same chain with each hop's observations grouped
 * into one element (`for`, `by`, `proto`, `host`) so they can be correlated. Which of them
 * a deployment's proxies actually maintain is declared in `TRUSTED_FORWARD_HEADER`, never
 * guessed: reading a header the proxies do not maintain is precisely how a caller gets to
 * name itself. See `resolveClientAddress` for how the two are combined when both are read.
 */

/**
 * A header is client-controlled input, so the chain it yields is bounded. The bound is on
 * the hops nearest the server, because that is the end a proxy appended to.
 */
const MAX_FORWARDED_ENTRIES = 32;

/** A token, as RFC 7230 defines it: the characters a parameter name may use. */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/;

/** A URI scheme name (RFC 3986 §3.1), which is what RFC 7239 §5.4 requires of `proto`. */
const URI_SCHEME = /^[a-z][a-z0-9+.-]{0,31}$/;

interface IpRange {
  bytes: Uint8Array;
  prefix: number;
  /** The configuration token this range came from, echoed back in logs. */
  source: string;
}

export interface TrustedProxyPolicy {
  /** Human-readable form of the configured value, for boot logs. */
  readonly description: string;
  /** True when every peer is trusted, so the header is believed unconditionally. */
  readonly trustsEveryone: boolean;
  isTrusted(address: string): boolean;
}

/** Which forwarded header a deployment's proxies maintain. */
export type ForwardedHeaderMode = 'x-forwarded-for' | 'forwarded' | 'both';

export const FORWARDED_HEADER_MODES: readonly ForwardedHeaderMode[] = [
  'x-forwarded-for',
  'forwarded',
  'both'
];

/** Parses `TRUSTED_FORWARD_HEADER`. An unrecognised value throws: see TRUST_PROXY. */
export function parseForwardedHeaderMode(value: string): ForwardedHeaderMode {
  const normalized = value.trim().toLowerCase();
  if ((FORWARDED_HEADER_MODES as readonly string[]).includes(normalized)) {
    return normalized as ForwardedHeaderMode;
  }
  throw new Error(`Unrecognised forwarded header '${value}'`);
}

/** The reason a `TRUSTED_FORWARD_HEADER` value would not parse, or null when it is usable. */
export function describeForwardedHeaderProblem(value: string): string | null {
  try {
    parseForwardedHeaderMode(value);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'invalid value';
  }
}

const IPV4_OCTET = /^(0|[1-9]\d{0,2})$/;
const IPV6_GROUP = /^[0-9a-f]{1,4}$/;

/**
 * Drops a port and IPv6 brackets from one header entry: both spellings appear in the
 * wild (`1.2.3.4:5678`, `[2001:db8::1]:443`), and neither is part of the address.
 */
function stripPort(entry: string): string {
  const trimmed = entry.trim();
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    return end === -1 ? trimmed.slice(1) : trimmed.slice(1, end);
  }

  // Exactly one colon means host:port for IPv4; two or more means it is the address.
  const colons = trimmed.split(':').length - 1;
  if (colons === 1) {
    const [host] = trimmed.split(':');
    if (IPV4_OCTET.test(host.split('.')[0] ?? '')) return host;
  }
  return trimmed;
}

function ipv4ToBytes(value: string): Uint8Array | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;

  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i += 1) {
    const part = parts[i];
    // Leading zeros are refused rather than read: `010.0.0.1` is octal to some software
    // and decimal to others, and a value that two systems disagree about is not an
    // identity worth trusting. The entry is dropped and a safer value is used instead.
    if (!IPV4_OCTET.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    bytes[i] = octet;
  }
  return bytes;
}

function ipv6ToBytes(value: string): Uint8Array | null {
  let expanded = value;

  // An embedded dotted quad (`::ffff:127.0.0.1`) is two more groups, not a separate form.
  if (expanded.includes('.')) {
    const lastColon = expanded.lastIndexOf(':');
    if (lastColon === -1) return null;
    const tail = ipv4ToBytes(expanded.slice(lastColon + 1));
    if (!tail) return null;
    const high = ((tail[0] << 8) | tail[1]).toString(16);
    const low = ((tail[2] << 8) | tail[3]).toString(16);
    expanded = `${expanded.slice(0, lastColon)}:${high}:${low}`;
  }

  const halves = expanded.split('::');
  if (halves.length > 2) return null;

  const head = halves[0] === '' ? [] : halves[0].split(':');
  const tail = halves.length === 2 ? (halves[1] === '' ? [] : halves[1].split(':')) : null;

  if (tail === null) {
    if (head.length !== 8) return null;
  } else if (head.length + tail.length > 7) {
    // `::` must stand for at least one group, so it cannot appear alongside eight.
    return null;
  }

  const groups = tail === null ? head : [...head, ...Array<string>(8 - head.length - tail.length).fill('0'), ...tail];
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i += 1) {
    const group = groups[i];
    if (!IPV6_GROUP.test(group)) return null;
    const parsed = parseInt(group, 16);
    bytes[i * 2] = parsed >> 8;
    bytes[i * 2 + 1] = parsed & 0xff;
  }
  return bytes;
}

/**
 * Canonicalises one address for comparison, or returns null when it is not an address.
 * An IPv4-mapped IPv6 address is folded to its IPv4 form so that a dual-stack socket
 * peer and an IPv4 header entry are recognised as the same host.
 */
export function normalizeAddress(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const stripped = stripPort(raw).toLowerCase();
  if (stripped === '') return null;

  const mapped = stripped.startsWith('::ffff:') ? stripped.slice(7) : null;
  if (mapped !== null) {
    const dotted = ipv4ToBytes(mapped);
    if (dotted) return Array.from(dotted).join('.');
    const bytes = ipv6ToBytes(stripped);
    if (bytes) return Array.from(bytes.slice(12)).join('.');
    return null;
  }

  const v4 = ipv4ToBytes(stripped);
  if (v4) return Array.from(v4).join('.');

  return ipv6ToBytes(stripped) ? stripped : null;
}

function ipToBytes(address: string): Uint8Array | null {
  const normalized = normalizeAddress(address);
  if (!normalized) return null;
  if (normalized.includes('.')) return ipv4ToBytes(normalized);
  return ipv6ToBytes(normalized);
}

function bytesWithin(bytes: Uint8Array, range: IpRange): boolean {
  const whole = Math.floor(range.prefix / 8);
  for (let i = 0; i < whole; i += 1) {
    if (bytes[i] !== range.bytes[i]) return false;
  }

  const remaining = range.prefix % 8;
  if (remaining === 0) return true;
  const mask = 0xff << (8 - remaining);
  return (bytes[whole] & mask) === (range.bytes[whole] & mask);
}

function parseRange(token: string): IpRange | null {
  const slash = token.lastIndexOf('/');
  const addressPart = slash === -1 ? token : token.slice(0, slash);
  const prefixPart = slash === -1 ? null : token.slice(slash + 1).trim();

  const bytes = ipToBytes(addressPart);
  if (!bytes) return null;
  const maxPrefix = bytes.length * 8;

  if (prefixPart === null) return { bytes, prefix: maxPrefix, source: token };
  if (!/^\d{1,3}$/.test(prefixPart)) return null;

  const prefix = Number(prefixPart);
  if (prefix > maxPrefix) return null;
  return { bytes, prefix, source: token };
}

/** `127.0.0.0/8` and `::1`, the addresses a proxy on the same host connects from. */
const LOOPBACK_RANGES = ['127.0.0.0/8', '::1/128'];

/** Addresses that can only be reached from the host or a private network. */
const NON_PUBLIC_RANGES: readonly string[] = [
  '127.0.0.0/8',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  '::1/128',
  'fc00::/7',
  'fe80::/10'
];

const PRIVATE_RANGES: readonly IpRange[] = NON_PUBLIC_RANGES.map(parseRange).filter(
  (range): range is IpRange => range !== null
);

/**
 * Parses `TRUST_PROXY`. Accepts nothing (the default, and the only safe setting with no
 * proxy), `true`/`all`/`*`, the keyword `loopback`, and a comma-separated list of
 * addresses and CIDR ranges — for example `loopback,10.0.0.0/8,2001:db8::/32`.
 *
 * An unrecognised token throws: a typo must stop the boot, not silently resolve to "trust
 * nobody" (which would quietly bucket every client together) or to "trust everyone"
 * (which would let any caller name itself).
 */
export function parseTrustedProxies(spec?: string | null): TrustedProxyPolicy {
  const raw = (spec ?? '').trim();

  if (raw === '') {
    return {
      description: 'none (the socket address is used; X-Forwarded-For is ignored)',
      trustsEveryone: false,
      isTrusted: () => false
    };
  }

  const keyword = raw.toLowerCase();
  if (keyword === 'true' || keyword === 'all' || keyword === '*') {
    return {
      description: 'every peer (X-Forwarded-For is believed from anyone)',
      trustsEveryone: true,
      isTrusted: () => true
    };
  }

  const ranges: IpRange[] = [];
  for (const token of raw.split(',')) {
    const value = token.trim();
    if (value === '') continue;

    if (value.toLowerCase() === 'loopback') {
      for (const loopback of LOOPBACK_RANGES) {
        const range = parseRange(loopback);
        if (range) ranges.push(range);
      }
      continue;
    }

    const range = parseRange(value);
    if (!range) throw new Error(`Unrecognised trusted proxy '${value}'`);
    ranges.push(range);
  }

  if (ranges.length === 0) {
    throw new Error('TRUST_PROXY was set but named no proxies');
  }

  return {
    description: ranges.map((range) => range.source).join(', '),
    trustsEveryone: false,
    isTrusted: (address: string): boolean => {
      const bytes = ipToBytes(address);
      if (!bytes) return false;
      // Families are never mixed: an IPv4 range cannot match an IPv6 peer, or vice versa.
      return ranges.some((range) => range.bytes.length === bytes.length && bytesWithin(bytes, range));
    }
  };
}

/** The reason a `TRUST_PROXY` value would not parse, or null when it is usable. */
export function describeTrustProxyProblem(spec?: string | null): string | null {
  try {
    parseTrustedProxies(spec);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'invalid value';
  }
}

/** True for loopback and private addresses: a peer that can only be an internal hop. */
export function isLocalOrPrivateAddress(address?: string | null): boolean {
  const bytes = ipToBytes(address ?? '');
  if (!bytes) return false;
  return PRIVATE_RANGES.some((range) => range.bytes.length === bytes.length && bytesWithin(bytes, range));
}

/**
 * One hop of a forwarding chain, in the order the header lists it: the leftmost hop is
 * whatever the client claimed, the rightmost is what the proxy next to this server
 * observed. `address` is null when the hop disclosed no address at all — an obfuscated
 * identifier, `unknown`, a value that is not an address, or a field-value that breaks the
 * grammar — which is different from a hop that is simply absent.
 */
interface ForwardedHop {
  address: string | null;
  /** RFC 7239 `proto`, validated to a URI scheme name. */
  protocol?: string;
  /** RFC 7239 `host`, validated to the Host grammar. */
  host?: string;
}

/** One header's answer: an address, or the peer plus the reason there is no address. */
interface HeaderResolution {
  address: string;
  protocol?: string;
  host?: string;
  /** False when the header was present but disclosed nothing usable. */
  disclosed: boolean;
}

/** The address a request is attributed to, and what the trusted hop said about it. */
export interface ClientAddressResolution {
  address: string;
  /** The scheme of the connection the address came from (RFC 7239 `proto`). */
  protocol?: string;
  /** The host the client addressed, as the trusted hop received it (RFC 7239 `host`). */
  host?: string;
  /**
   * The trusted hop hid its client (obfuscated identifier, `unknown`, or an unreadable
   * element), so the answer is the proxy and every client of it shares one bucket.
   */
  hidden?: true;
  /** Both headers were present and named different clients, so neither was believed. */
  conflict?: true;
}

export interface ClientAddressRequest {
  socketAddress?: string | null;
  /** `X-Forwarded-For`, as Node hands it over (an array when the header repeats). */
  xForwardedFor?: string | string[];
  /** RFC 7239 `Forwarded`, as Node hands it over. */
  forwarded?: string | string[];
  /** Which header(s) the proxies maintain. Defaults to `x-forwarded-for`. */
  mode?: ForwardedHeaderMode;
}

/**
 * The address to attribute a request to, with whatever the trusted hop said about the
 * connection it came from.
 *
 * The peer decides everything: if it is not a trusted proxy, no header is read at all — an
 * untrusted peer's forwarded headers are its own claims about itself. If it is trusted,
 * each maintained header is walked from the server outwards and the rightmost hop that is
 * not itself a trusted proxy is the client, with older hops discarded.
 */
export function resolveClientAddress(
  request: ClientAddressRequest,
  policy: TrustedProxyPolicy
): ClientAddressResolution {
  const socket = normalizeAddress(request.socketAddress) ?? 'unknown';
  if (!policy.isTrusted(socket)) return { address: socket };

  const mode = request.mode ?? 'x-forwarded-for';
  const fromXff =
    mode === 'forwarded' ? null : interpretHops(xForwardedForHops(request.xForwardedFor), socket, policy);
  const fromForwarded =
    mode === 'x-forwarded-for' ? null : interpretHops(forwardedHops(request.forwarded), socket, policy);

  if (fromXff === null && fromForwarded === null) return { address: socket };

  if (fromXff !== null && fromForwarded !== null) {
    if (fromXff.disclosed && fromForwarded.disclosed) {
      if (fromXff.address === fromForwarded.address) {
        // Both maintained headers agree, so the RFC 7239 one supplies the fields it alone
        // carries; the answer itself is the same either way.
        return { address: fromForwarded.address, ...hopFields(fromForwarded) };
      }
      // Two headers the deployment maintains name two different clients. That is either a
      // misconfiguration or someone forging one of them, and there is no way to tell which
      // — so neither is believed and the request is attributed to the peer, which cannot
      // be spoofed and cannot identify an innocent party as the caller.
      return { address: socket, conflict: true };
    }

    // At most one of them disclosed an address: a header that answered `unknown` or used an
    // obfuscated identifier is not a competing answer.
    const disclosed = fromXff.disclosed ? fromXff : fromForwarded.disclosed ? fromForwarded : null;
    if (disclosed) return { address: disclosed.address, ...hopFields(disclosed) };
    return { address: socket, hidden: true };
  }

  const single = fromForwarded ?? fromXff;
  if (single === null) return { address: socket };
  return single.disclosed
    ? { address: single.address, ...hopFields(single) }
    : { address: socket, hidden: true };
}

function hopFields(hop: { protocol?: string; host?: string }): { protocol?: string; host?: string } {
  return {
    ...(hop.protocol ? { protocol: hop.protocol } : {}),
    ...(hop.host ? { host: hop.host } : {})
  };
}

/**
 * The fields a trusted hop disclosed, ready to spread into a request context or a log
 * line, or nothing at all when it disclosed none: an absent field must not appear as
 * `undefined` next to a real one.
 */
export function clientAddressFields(resolution: ClientAddressResolution): {
  protocol?: string;
  host?: string;
} {
  return hopFields(resolution);
}

/**
 * Reads one chain, right to left. A hop that discloses nothing stops the walk: continuing
 * past it would mean believing an older element, which is exactly what walking from the
 * server outwards exists to avoid. Returns null when the header was not present at all.
 */
function interpretHops(
  hops: ForwardedHop[],
  socket: string,
  policy: TrustedProxyPolicy
): HeaderResolution | null {
  if (hops.length === 0) return null;

  for (let i = hops.length - 1; i >= 0; i -= 1) {
    const hop = hops[i];
    if (hop.address === null) return { address: socket, disclosed: false };
    if (!policy.isTrusted(hop.address)) {
      return { address: hop.address, disclosed: true, ...hopFields(hop) };
    }
  }

  // Every hop is a trusted stopover, so the furthest address the header names is the best
  // answer available.
  const leftmost = hops[0];
  if (leftmost.address === null) return { address: socket, disclosed: false };
  return { address: leftmost.address, disclosed: true, ...hopFields(leftmost) };
}

/** `X-Forwarded-For`: a bare list of addresses, leftmost first. */
function xForwardedForHops(value: string | string[] | undefined): ForwardedHop[] {
  return splitHeader(value, ',').map((entry) => ({ address: normalizeAddress(entry) }));
}

/**
 * RFC 7239 `Forwarded`: a list of semicolon-separated parameter groups, of which only
 * `for`, `proto` and `host` are read. Extensions are ignored, and `by` is left alone — the
 * adjacent proxy is already known from the connection it made.
 */
function forwardedHops(value: string | string[] | undefined): ForwardedHop[] {
  return splitHeader(value, ',').map(parseForwardedElement);
}

/**
 * One `forwarded-element`: `[ pair ] *( ";" [ pair ] )`, names case-insensitive, values
 * either tokens or quoted strings (which is how an IPv6 address or a host with a port has
 * to be written, since `:` is not a token character).
 *
 * An element that repeats a parameter is refused outright rather than half-read: RFC 7239
 * §4 says a parameter MUST NOT occur more than once per field-value, so an element doing
 * so is not something to guess at, and an attacker-written `for` is exactly what a
 * duplicate would be there to slip past a reader that took the wrong one.
 */
function parseForwardedElement(element: string): ForwardedHop {
  const fields: Partial<Record<'for' | 'proto' | 'host', string>> = {};
  const seen = new Set<string>();

  for (const pair of splitOutsideQuotes([element], ';')) {
    const equals = pair.indexOf('=');
    if (equals === -1) continue; // the grammar allows an empty pair between semicolons

    const name = pair.slice(0, equals).trim().toLowerCase();
    if (name === '' || !TOKEN.test(name)) continue; // not a parameter name we can read
    if (seen.has(name)) return { address: null };
    seen.add(name);

    const value = parseParameterValue(pair.slice(equals + 1));
    if (value === null) return { address: null }; // an unterminated quoted string
    if (name === 'for' || name === 'proto' || name === 'host') fields[name] = value;
  }

  if (fields.for === undefined) return { address: null };

  const address = nodeAddress(fields.for);
  const protocol = fields.proto === undefined ? undefined : validProtocol(fields.proto);
  const host = fields.host === undefined ? undefined : validHost(fields.host);
  return {
    address,
    ...(protocol === undefined ? {} : { protocol }),
    ...(host === undefined ? {} : { host })
  };
}

/**
 * The address a node identifier names, or null when it names none.
 *
 * `unknown` and an obfuscated identifier (`_hidden`) both mean a hop happened whose client
 * is not disclosed, and an obfuscated *port* on a real address is not part of the address.
 * The ABNF literals are case-insensitive, so `UNKNOWN` counts and `_` is the marker that
 * distinguishes an obfuscated identifier from an address.
 */
function nodeAddress(value: string): string | null {
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  if (lower === 'unknown' || lower.startsWith('unknown:')) return null;
  if (trimmed.startsWith('_')) return null;
  return normalizeAddress(trimmed);
}

/** A pair value: a quoted string with its escapes removed, or a bare token. */
function parseParameterValue(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('"')) return trimmed;
  if (trimmed.length < 2 || !trimmed.endsWith('"')) return null;

  let unquoted = '';
  const inner = trimmed.slice(1, -1);
  for (let i = 0; i < inner.length; i += 1) {
    if (inner[i] === '\\' && i + 1 < inner.length) {
      i += 1;
      unquoted += inner[i];
      continue;
    }
    unquoted += inner[i];
  }
  return unquoted;
}

/**
 * `proto` has to be a URI scheme name (RFC 7239 §5.4), so an injected `proto=javascript:…`
 * or a value carrying whitespace is dropped rather than handed to a caller as a scheme.
 */
function validProtocol(raw: string): string | undefined {
  const candidate = raw.trim().toLowerCase();
  return URI_SCHEME.test(candidate) ? candidate : undefined;
}

/**
 * `host` has to be a Host header value (RFC 7239 §5.3): a name or an address literal, with
 * an optional port. Anything else — whitespace, a path, a quote — is dropped, so a value
 * that could not have been a Host header never becomes one here.
 */
function validHost(raw: string): string | undefined {
  const candidate = raw.trim().toLowerCase();
  if (candidate === '' || candidate.length > 260) return undefined;

  const match = /^(\[[0-9a-f:.]+\]|[a-z0-9_](?:[a-z0-9_.-]{0,61}[a-z0-9])?)(?::(\d{1,5}))?$/.exec(
    candidate
  );
  if (!match) return undefined;

  const [, name, port] = match;
  if (name.startsWith('[')) {
    if (!ipToBytes(name.slice(1, -1))) return undefined;
  } else if (name.includes('..')) {
    return undefined;
  }
  if (port !== undefined && Number(port) > 65535) return undefined;
  return candidate;
}

/**
 * Splits a header into its list elements, across a repeated header, ignoring separators
 * inside quoted strings. Only the hops nearest the server are kept: a client can pad a
 * header cheaply, and the part that matters is what the proxy appended last.
 */
function splitHeader(value: string | string[] | undefined, separator: string): string[] {
  const elements = splitOutsideQuotes(value, separator).filter((element) => element.trim() !== '');
  return elements.length > MAX_FORWARDED_ENTRIES
    ? elements.slice(-MAX_FORWARDED_ENTRIES)
    : elements;
}

function splitOutsideQuotes(value: string | string[] | undefined, separator: string): string[] {
  if (value === undefined) return [];
  const parts = Array.isArray(value) ? value : [value];

  const elements: string[] = [];
  for (const part of parts) {
    let current = '';
    let quoted = false;

    for (let i = 0; i < part.length; i += 1) {
      const char = part[i];
      if (char === '\\' && quoted && i + 1 < part.length) {
        current += char + part[i + 1];
        i += 1;
        continue;
      }
      if (char === '"') quoted = !quoted;
      if (char === separator && !quoted) {
        elements.push(current);
        current = '';
        continue;
      }
      current += char;
    }
    elements.push(current);
  }
  return elements;
}
