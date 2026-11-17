// Git smart HTTP, implemented from the wire protocol: pkt-lines, protocol v2 ls-refs and fetch,
// protocol v0 fetch, and receive-pack with sideband report-status. Objects are read from and
// written to the repo's own store; packs the server sends are plain (no deltas), while the pack
// reader resolves OFS and REF deltas (against the pack itself and the repo's objects).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { inflateSync, deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  type Repo,
  type ObjType,
  type GObj,
  CODE_TYPE,
  ZERO_OID,
  getObject,
  putObject,
  parseCommit,
  parseTag,
  peelToCommit,
  collectObjects,
  commitGenerations,
  hashObject,
  typeCode,
} from './store.ts';

// --------------------------------------------------------------------------- pkt-lines

/** Encode one pkt-line (4 hex digits of total length + payload). */
export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

/** Parse pkt-lines from a buffer; throws on anything malformed (callers answer 400). */
export function parsePktLines(body: Buffer, start = 0): { payload: Buffer; kind: 'data' | 'flush' | 'delim' | 'response-end'; next: number }[] {
  const out: { payload: Buffer; kind: 'data' | 'flush' | 'delim' | 'response-end'; next: number }[] = [];
  let offset = start;
  while (offset < body.length) {
    if (offset + 4 > body.length) throw new Error('truncated pkt-line header');
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('malformed pkt-line header');
    const length = parseInt(header, 16);
    if (length === 0) {
      out.push({ payload: Buffer.alloc(0), kind: 'flush', next: offset + 4 });
      offset += 4;
      continue;
    }
    if (length === 1) {
      out.push({ payload: Buffer.alloc(0), kind: 'delim', next: offset + 4 });
      offset += 4;
      continue;
    }
    if (length === 2) {
      out.push({ payload: Buffer.alloc(0), kind: 'response-end', next: offset + 4 });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > body.length) throw new Error('malformed pkt-line length');
    out.push({ payload: body.subarray(offset + 4, offset + length), kind: 'data', next: offset + length });
    offset += length;
  }
  return out;
}

/** The byte offset just past the pkt-line section of a receive-pack body (where the pack starts). */
function offsetAfterCommands(body: Buffer): number {
  let offset = 0;
  while (offset < body.length) {
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('malformed pkt-line header');
    const length = parseInt(header, 16);
    if (length === 0) return offset + 4;
    if (length < 4 || offset + length > body.length) throw new Error('malformed pkt-line length');
    offset += length;
  }
  return offset;
}

// --------------------------------------------------------------------------- packs

/** Serialize objects into a packfile (version 2, plain entries, SHA-1 trailer). */
export function writePack(objects: readonly { type: ObjType; data: Buffer }[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const chunks: Buffer[] = [header];
  for (const object of objects) {
    let size = object.data.length;
    const first = (typeCode(object.type) << 4) | (size & 0x0f);
    size >>= 4;
    const headBytes: number[] = [];
    if (size > 0) {
      headBytes.push(first | 0x80);
      while (size > 0) {
        let byte = size & 0x7f;
        size >>= 7;
        if (size > 0) byte |= 0x80;
        headBytes.push(byte);
      }
    } else {
      headBytes.push(first);
    }
    chunks.push(Buffer.from(headBytes));
    chunks.push(deflateSync(object.data));
  }
  const body = Buffer.concat(chunks);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** A parsed pack entry before delta resolution. */
interface RawEntry {
  type: ObjType | 'ofs-delta' | 'ref-delta';
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
  entryStart: number;
}

/**
 * Apply a delta buffer to a base object's bytes. The wire format: source size varint, target
 * size varint, then copy/insert opcodes. Throws on a malformed delta.
 */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('truncated delta');
      const byte = delta[offset] as number;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if ((op & (1 << bit)) !== 0) {
          copyOffset |= (delta[offset] as number) << (8 * bit);
          offset += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if ((op & (0x10 << bit)) !== 0) {
          copySize |= (delta[offset] as number) << (8 * bit);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy out of range');
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op !== 0) {
      out.push(delta.subarray(offset, offset + op));
      produced += op;
      offset += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (produced !== targetSize || result.length !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

/**
 * Read a packfile into resolved objects. Delta bases come from the pack itself or from
 * `lookupBase` (the repo's store, for thin packs). Returns the objects; throws on bad input.
 */
export function readPack(pack: Buffer, lookupBase?: (oid: string) => GObj | undefined): GObj[] {
  if (pack.length < 12 + 20) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack signature');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  let offset = 12;
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, number>();
  for (let i = 0; i < count; i += 1) {
    const entryStart = offset;
    if (offset >= pack.length) throw new Error('pack truncated in object header');
    let byte = pack[offset] as number;
    offset += 1;
    const code = (byte >> 4) & 0x07;
    // The size is decoded for completeness; the inflated length is authoritative.
    while ((byte & 0x80) !== 0) {
      byte = pack[offset] as number;
      offset += 1;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (code === 6) {
      // OFS_DELTA: a negative offset varint to the base entry's start.
      let b = pack[offset] as number;
      offset += 1;
      let back = b & 0x7f;
      while ((b & 0x80) !== 0) {
        b = pack[offset] as number;
        offset += 1;
        back = ((back + 1) << 7) | (b & 0x7f);
      }
      baseOffset = entryStart - back;
    } else if (code === 7) {
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    // Inflate exactly this entry's stream: feed inflate a slice and let it report consumption.
    const compressed = pack.subarray(offset);
    const { result, consumed } = inflateWithLength(compressed);
    offset += consumed;
    const type: RawEntry['type'] = code === 6 ? 'ofs-delta' : code === 7 ? 'ref-delta' : (CODE_TYPE[code] as ObjType);
    if (type === undefined) throw new Error(`unknown pack object type ${code}`);
    raw.push({ type, data: result, baseOffset, baseOid, entryStart });
    byOffset.set(entryStart, raw.length - 1);
  }
  const resolved: (GObj | undefined)[] = raw.map(() => undefined);
  const resolve = (index: number, depth: number): GObj => {
    const done = resolved[index];
    if (done !== undefined) return done;
    if (depth > 512) throw new Error('delta chain too deep');
    const entry = raw[index] as RawEntry;
    let object: GObj;
    if (entry.type === 'ofs-delta') {
      const baseIndex = byOffset.get(entry.baseOffset as number);
      if (baseIndex === undefined) throw new Error('ofs-delta base not in pack');
      const base = resolve(baseIndex, depth + 1);
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else if (entry.type === 'ref-delta') {
      let base: GObj | undefined;
      const packIndex = raw.findIndex((candidate, candidateIndex) => {
        if (candidate.type === 'ofs-delta' || candidate.type === 'ref-delta') return false;
        return hashObject(candidate.type, candidate.data) === entry.baseOid;
      });
      if (packIndex >= 0) base = resolve(packIndex, depth + 1);
      else if (lookupBase !== undefined) base = lookupBase(entry.baseOid as string);
      if (base === undefined) throw new Error('ref-delta base not found');
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      object = { type: entry.type, data: entry.data };
    }
    resolved[index] = object;
    return object;
  };
  return raw.map((_, index) => resolve(index, 0));
}

/** Inflate one deflate stream and report how many input bytes it used. */
function inflateWithLength(compressed: Buffer): { result: Buffer; consumed: number } {
  // zlib reports the consumed input length with { info: true } (engine.bytesWritten): one call.
  const inflated = inflateSync(compressed, { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  const written = inflated.engine?.bytesWritten ?? 0;
  if (written > 0) return { result: inflated.buffer, consumed: written };
  return { result: inflated.buffer, consumed: compressed.length };
}

// --------------------------------------------------------------------------- advertisements

const AGENT = 'gitforge/1.0';

function jsonReply(res: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': body.length });
  res.end(body);
}

/** The refs a forge advertises: HEAD first (for v0), then every ref in name order. */
function advertisedRefs(repo: Repo): { name: string; oid: string }[] {
  const out: { name: string; oid: string }[] = [];
  const head = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (head !== undefined) out.push({ name: 'HEAD', oid: head });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) out.push({ name, oid: repo.refs.get(name) as string });
  return out;
}

/** The peeled target of an annotated tag ref, or null when the ref is not an annotated tag. */
function peeled(repo: Repo, oid: string): string | null {
  const object = getObject(repo, oid);
  if (object === undefined || object.type !== 'tag') return null;
  return parseTag(object.data).object;
}

/** The v0-style ref lines (with the capability list riding the first line). */
function v0RefLines(repo: Repo, capabilities: string): Buffer[] {
  const refs = advertisedRefs(repo);
  const lines: Buffer[] = [];
  if (refs.length === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${capabilities}\n`));
    return lines;
  }
  refs.forEach((ref, index) => {
    const suffix = index === 0 ? `\0${capabilities}` : '';
    lines.push(pktLine(`${ref.oid} ${ref.name}${suffix}\n`));
    const target = peeled(repo, ref.oid);
    if (target !== null) lines.push(pktLine(`${target} ${ref.name}^{}\n`));
  });
  return lines;
}

/** GET info/refs?service=... — the advertisement for either service. */
export function handleInfoRefs(req: IncomingMessage, res: ServerResponse, repo: Repo | undefined, service: string, protocolV2: boolean): void {
  if (repo === undefined) {
    jsonReply(res, 404, { message: 'Not Found' });
    return;
  }
  const isUpload = service === 'git-upload-pack';
  res.setHeader('content-type', `application/x-git-${isUpload ? 'upload-pack' : 'receive-pack'}-advertisement`);
  res.setHeader('cache-control', 'no-cache');
  if (isUpload && protocolV2) {
    const body = Buffer.concat([
      pktLine('version 2\n'),
      pktLine(`agent=${AGENT}\n`),
      pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow\n'),
      pktLine('object-format=sha1\n'),
      PKT_FLUSH,
    ]);
    res.writeHead(200, { 'content-length': body.length });
    res.end(body);
    return;
  }
  const capabilities = isUpload
    ? `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow agent=${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch}`
    : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const banner = pktLine(`# service=git-${isUpload ? 'upload-pack' : 'receive-pack'}\n`);
  const body = Buffer.concat([banner, PKT_FLUSH, ...v0RefLines(repo, capabilities), PKT_FLUSH]);
  res.writeHead(200, { 'content-length': body.length });
  res.end(body);
}

// --------------------------------------------------------------------------- upload-pack

/** Split a POST body into its pkt-line section and the raw remainder (for receive-pack). */
function splitBody(body: Buffer): { lines: { payload: Buffer; kind: string }[]; rest: Buffer; restOffset: number } {
  const lines: { payload: Buffer; kind: string }[] = [];
  let offset = 0;
  while (offset < body.length) {
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('malformed pkt-line header');
    const length = parseInt(header, 16);
    if (length === 0) {
      lines.push({ payload: Buffer.alloc(0), kind: 'flush' });
      offset += 4;
      return { lines, rest: body.subarray(offset), restOffset: offset };
    }
    if (length === 1) {
      lines.push({ payload: Buffer.alloc(0), kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      lines.push({ payload: Buffer.alloc(0), kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > body.length) throw new Error('malformed pkt-line length');
    lines.push({ payload: body.subarray(offset + 4, offset + length), kind: 'data' });
    offset += length;
  }
  return { lines, rest: Buffer.alloc(0), restOffset: offset };
}

/** ls-refs (protocol v2). */
function lsRefs(res: ServerResponse, repo: Repo, argLines: readonly string[]): void {
  let wantPeel = false;
  let wantSymrefs = false;
  let wantUnborn = false;
  const prefixes: string[] = [];
  for (const line of argLines) {
    if (line === 'peel') wantPeel = true;
    else if (line === 'symrefs') wantSymrefs = true;
    else if (line === 'unborn') wantUnborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: Buffer[] = [];
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headTarget);
  if (matches('HEAD')) {
    if (headOid !== undefined) {
      let line = `${headOid} HEAD`;
      if (wantSymrefs) line += ` symref-target:${headTarget}`;
      const target = peeled(repo, headOid);
      if (wantPeel && target !== null) line += ` peeled:${target}`;
      lines.push(pktLine(`${line}\n`));
    } else if (wantUnborn) {
      let line = 'unborn HEAD';
      if (wantSymrefs) line += ` symref-target:${headTarget}`;
      lines.push(pktLine(`${line}\n`));
    }
  }
  for (const name of [...repo.refs.keys()].sort()) {
    if (!matches(name)) continue;
    const oid = repo.refs.get(name) as string;
    let line = `${oid} ${name}`;
    const target = peeled(repo, oid);
    if (wantPeel && target !== null) line += ` peeled:${target}`;
    lines.push(pktLine(`${line}\n`));
  }
  const body = Buffer.concat([...lines, PKT_FLUSH]);
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': body.length });
  res.end(body);
}

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallows: string[];
  depth: number | undefined;
  done: boolean;
}

/** Build the pack bytes for a fetch: the object set minus what the client holds. */
function fetchPack(repo: Repo, request: FetchRequest): { pack: Buffer; shallow: string[]; unshallow: string[]; anyHave: boolean } {
  // A full clone (no haves, no depth) of an unchanged store is a pure function of the want set,
  // and the clone workload asks for the same one many times concurrently: memoize it. The store
  // is append-only within a repo's life, so its size identifies its contents for a given want set.
  if (request.depth === undefined && request.haves.length === 0 && request.shallows.length === 0) {
    const key = `${repo.objects.size}|${[...request.wants].sort().join(',')}`;
    const cached = repo.packCache.get(key);
    if (cached !== undefined) return { pack: cached, shallow: [], unshallow: [], anyHave: false };
    const computed = fetchPackUncached(repo, request);
    if (repo.packCache.size > 8) repo.packCache.clear();
    repo.packCache.set(key, computed.pack);
    return computed;
  }
  return fetchPackUncached(repo, request);
}

function fetchPackUncached(repo: Repo, request: FetchRequest): { pack: Buffer; shallow: string[]; unshallow: string[]; anyHave: boolean } {
  const parentless = new Set(request.shallows);
  const clientClosure =
    request.haves.length === 0 && request.shallows.length === 0
      ? new Set<string>()
      : collectObjects(repo, [...request.haves, ...request.shallows], { parentless });
  let wanted: Set<string>;
  const boundary: string[] = [];
  if (request.depth === undefined) {
    wanted = collectObjects(repo, request.wants, { exclude: clientClosure });
  } else {
    // The depth walk runs over the server's full history: the client's shallow boundary limits
    // what the client holds (clientClosure above), never what the server can see.
    wanted = collectObjects(repo, request.wants, { exclude: clientClosure, depth: request.depth });
    // The new shallow boundary: included commits at exactly the depth whose parents stay behind.
    const generations = commitGenerations(repo, request.wants);
    for (const oid of wanted) {
      const object = getObject(repo, oid);
      if (object === undefined || object.type !== 'commit') continue;
      if (generations.get(oid) !== request.depth) continue;
      const parents = parseCommit(object.data).parents;
      if (parents.length > 0) boundary.push(oid);
    }
  }
  const unshallow: string[] = [];
  for (const oid of request.shallows) {
    if (wanted.has(oid) && !boundary.includes(oid)) unshallow.push(oid);
  }
  const objects: { type: ObjType; data: Buffer }[] = [];
  for (const oid of wanted) {
    const object = getObject(repo, oid);
    if (object !== undefined) objects.push(object);
  }
  const anyHave = request.haves.some((have) => getObject(repo, have) !== undefined);
  return { pack: writePack(objects), shallow: boundary, unshallow, anyHave };
}

/** Sideband-1 packets carrying a pack, each packet's total length within the 65520 limit. */
function sidebandPackets(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 65512;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    packets.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (pack.length === 0) packets.push(pktLine(Buffer.from([1])));
  return packets;
}

/** A protocol v2 response section: header line, content lines, delimiter. */
function section(name: string, lines: readonly Buffer[], terminator: Buffer): Buffer {
  return Buffer.concat([pktLine(`${name}\n`), ...lines, terminator]);
}

/** fetch (protocol v2). */
function fetchV2(res: ServerResponse, repo: Repo, argLines: readonly string[]): void {
  const request: FetchRequest = { wants: [], haves: [], shallows: [], depth: undefined, done: false };
  for (const line of argLines) {
    if (line.startsWith('want ')) request.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.shallows.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) request.depth = Number(line.slice(7).trim());
    else if (line === 'done') request.done = true;
  }
  const { pack, shallow, unshallow, anyHave } = fetchPack(repo, request);
  const parts: Buffer[] = [];
  parts.push(section('acknowledgments', [pktLine(anyHave ? 'ready\n' : 'NAK\n')], PKT_DELIM));
  if (shallow.length > 0 || unshallow.length > 0) {
    const lines = [
      ...shallow.map((oid) => pktLine(`shallow ${oid}\n`)),
      ...unshallow.map((oid) => pktLine(`unshallow ${oid}\n`)),
    ];
    parts.push(section('shallow-info', lines, PKT_DELIM));
  }
  parts.push(section('packfile', sidebandPackets(pack), PKT_FLUSH));
  const body = Buffer.concat(parts);
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': body.length });
  res.end(body);
}

/** Parse every pkt-line in a body that is entirely pkt-lines (fetch requests carry no raw tail). */
function parseAllLines(body: Buffer): { payload: Buffer; kind: string }[] {
  const lines: { payload: Buffer; kind: string }[] = [];
  let offset = 0;
  while (offset < body.length) {
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('malformed pkt-line header');
    const length = parseInt(header, 16);
    if (length === 0) {
      lines.push({ payload: Buffer.alloc(0), kind: 'flush' });
      offset += 4;
    } else if (length === 1) {
      lines.push({ payload: Buffer.alloc(0), kind: 'delim' });
      offset += 4;
    } else if (length === 2) {
      lines.push({ payload: Buffer.alloc(0), kind: 'response-end' });
      offset += 4;
    } else {
      if (length < 4 || offset + length > body.length) throw new Error('malformed pkt-line length');
      lines.push({ payload: body.subarray(offset + 4, offset + length), kind: 'data' });
      offset += length;
    }
  }
  return lines;
}

/** fetch (protocol v0). */
function fetchV0(res: ServerResponse, repo: Repo, body: Buffer): void {
  const lines = parseAllLines(body);
  const request: FetchRequest = { wants: [], haves: [], shallows: [], depth: undefined, done: false };
  for (const line of lines) {
    if (line.kind !== 'data') continue;
    const text = line.payload.toString('utf8').replace(/\n$/, '');
    const [head] = text.split('\0');
    const clean = (head as string).trim();
    if (clean.startsWith('want ')) request.wants.push(clean.slice(5).trim());
    else if (clean.startsWith('have ')) request.haves.push(clean.slice(5).trim());
    else if (clean.startsWith('deepen ')) request.depth = Number(clean.slice(7).trim());
    else if (clean === 'done') request.done = true;
  }
  const { pack, shallow, anyHave } = fetchPack(repo, request);
  const parts: Buffer[] = [];
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  if (shallow.length > 0) parts.push(PKT_FLUSH);
  // ACK the newest have the server also holds, else NAK.
  let ack: string | null = null;
  for (const have of request.haves) if (getObject(repo, have) !== undefined) ack = have;
  parts.push(pktLine(ack !== null && anyHave ? `ACK ${ack}\n` : 'NAK\n'));
  parts.push(...sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  const bodyOut = Buffer.concat(parts);
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': bodyOut.length });
  res.end(bodyOut);
}

/** POST git-upload-pack: dispatch on the negotiated protocol version and command. */
export function handleUploadPack(res: ServerResponse, repo: Repo | undefined, body: Buffer, protocolV2: boolean): void {
  if (repo === undefined) {
    jsonReply(res, 404, { message: 'Not Found' });
    return;
  }
  try {
    if (!protocolV2) {
      fetchV0(res, repo, body);
      return;
    }
    const lines = parseAllLines(body);
    let command = '';
    const argLines: string[] = [];
    let inArgs = false;
    for (const line of lines) {
      if (line.kind === 'delim') {
        inArgs = true;
        continue;
      }
      if (line.kind !== 'data') continue;
      const text = line.payload.toString('utf8').replace(/\n$/, '');
      if (!inArgs) {
        if (text.startsWith('command=')) command = text.slice('command='.length);
      } else {
        argLines.push(text);
      }
    }
    if (command === 'ls-refs') lsRefs(res, repo, argLines);
    else if (command === 'fetch') fetchV2(res, repo, argLines);
    else jsonReply(res, 400, { message: `unknown command ${command}` });
  } catch {
    if (!res.headersSent) jsonReply(res, 400, { message: 'Bad Request' });
    else res.end();
  }
}

// --------------------------------------------------------------------------- receive-pack

interface RefCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST git-receive-pack: apply ref updates from a push, reporting each ref's outcome. */
export function handleReceivePack(res: ServerResponse, repo: Repo | undefined, body: Buffer): void {
  if (repo === undefined) {
    jsonReply(res, 404, { message: 'Not Found' });
    return;
  }
  let commands: RefCommand[] = [];
  let capabilities = '';
  let pack = Buffer.alloc(0);
  try {
    const { lines, rest } = splitBody(body);
    pack = rest;
    let first = true;
    for (const line of lines) {
      if (line.kind !== 'data') continue;
      let text = line.payload.toString('utf8').replace(/\n$/, '');
      if (first) {
        const nul = text.indexOf('\0');
        if (nul >= 0) {
          capabilities = text.slice(nul + 1);
          text = text.slice(0, nul);
        }
        first = false;
      }
      const parts = text.trim().split(/\s+/);
      if (parts.length === 3) {
        commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
      }
    }
  } catch {
    jsonReply(res, 400, { message: 'Bad Request' });
    return;
  }
  const useSideband = capabilities.includes('side-band-64k');
  const report: string[] = [];
  let unpackOk = true;
  if (pack.length > 0) {
    try {
      const objects = readPack(pack, (oid) => getObject(repo, oid));
      for (const object of objects) putObject(repo, object.type, object.data);
    } catch {
      unpackOk = false;
    }
  }
  report.push(unpackOk ? 'unpack ok\n' : 'unpack error\n');
  if (unpackOk) {
    for (const command of commands) {
      report.push(`${applyRefUpdate(repo, command)}\n`);
    }
  } else {
    for (const command of commands) report.push(`ng ${command.ref} unpack failed\n`);
  }
  const reportBody = Buffer.concat(report.map((line) => pktLine(line)));
  let out: Buffer;
  if (useSideband) {
    const packets: Buffer[] = [];
    const CHUNK = 65512;
    for (let offset = 0; offset < reportBody.length; offset += CHUNK) {
      packets.push(pktLine(Buffer.concat([Buffer.from([1]), reportBody.subarray(offset, Math.min(reportBody.length, offset + CHUNK))])));
    }
    packets.push(PKT_FLUSH);
    out = Buffer.concat(packets);
  } else {
    out = Buffer.concat([reportBody, PKT_FLUSH]);
  }
  res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'content-length': out.length });
  res.end(out);
}

/** Apply one ref update from a push; answers its report-status line (`ok ...` / `ng ...`). */
function applyRefUpdate(repo: Repo, command: RefCommand): string {
  const { oldOid, newOid, ref } = command;
  const current = repo.refs.get(ref) ?? ZERO_OID;
  if (newOid === ZERO_OID) {
    // A deletion.
    if (!repo.refs.has(ref)) return `ng ${ref} reference does not exist`;
    if (oldOid !== ZERO_OID && oldOid !== current) return `ng ${ref} stale info`;
    repo.refs.delete(ref);
    return `ok ${ref}`;
  }
  const target = getObject(repo, newOid);
  if (target === undefined) return `ng ${ref} unknown object`;
  if (oldOid === ZERO_OID) {
    if (repo.refs.has(ref)) return `ng ${ref} reference already exists`;
    repo.refs.set(ref, newOid);
    return `ok ${ref}`;
  }
  if (current !== oldOid) return `ng ${ref} stale info`;
  // An update: commits must move fast-forward; tags and other objects move freely.
  if (target.type === 'commit') {
    const from = peelToCommit(repo, oldOid);
    if (from !== null && !isAncestorSafe(repo, from, newOid)) return `ng ${ref} non-fast-forward`;
  }
  repo.refs.set(ref, newOid);
  return `ok ${ref}`;
}

function isAncestorSafe(repo: Repo, ancestor: string, tip: string): boolean {
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = getObject(repo, oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return false;
}
