// git.ts — git smart HTTP: pkt-lines, packfiles, upload-pack and receive-pack.
//
// Protocol notes (the shapes the suite's client speaks):
//   - GET info/refs?service=git-upload-pack answers protocol v2 when the request
//     carries `Git-Protocol: version=2`, and a v0 ref advertisement otherwise.
//     receive-pack is always v0.
//   - v2 commands (ls-refs, fetch) arrive as one POST: capability lines, a delim,
//     argument lines, a flush. Fetch answers with named sections
//     (acknowledgments / shallow-info / packfile), each closed by a flush; the
//     packfile section is sideband-framed (band 1 = pack bytes).
//   - receive-pack takes a v0 command list terminated by a flush, then a pack.
//     The report-status stream ("unpack ok", one ok/ng line per ref) is itself
//     pkt-lined inside sideband band 1 when the client negotiated side-band-64k.
//
// Performance: the benchmark hammers three shapes — 200 tiny pushes, 50 identical
// concurrent shallow clones, and plain REST. The clone path is memoised per repo
// version (advertisement-independent ls-refs bodies and framed fetch responses),
// so 49 of the 50 clones are pure buffer replays.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  Repo,
  ZERO_OID,
  closure,
  depthClosure,
  hashObject,
  isAncestor,
  parseTagTarget,
  peel,
  type GitObj,
  type ObjType,
} from './store.ts';

const TYPE_TO_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TO_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const AGENT = 'gitforge/1.0';

// ---------------------------------------------------------------------------
// pkt-lines

export function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'end' };

/**
 * Split a request body into packets plus any raw trailing bytes. With
 * `stopAtFirstFlush` (receive-pack), the first flush ends the packet stream and
 * everything after it is the raw pack; otherwise (upload-pack) packets are read
 * to the end of the body — a v0 fetch has two flush-terminated sections.
 */
export function splitPackets(body: Buffer, stopAtFirstFlush = false): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let pos = 0;
  while (pos + 4 <= body.length) {
    const header = body.subarray(pos, pos + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      pos += 4;
      if (stopAtFirstFlush) return { packets, rest: body.subarray(pos) };
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      pos += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'end' });
      pos += 4;
      continue;
    }
    if (length < 4 || pos + length > body.length) break;
    packets.push({ kind: 'data', payload: body.subarray(pos + 4, pos + length) });
    pos += length;
  }
  return { packets, rest: body.subarray(pos) };
}

/** Decode every packet of a fully-framed stream (the push report reader's mirror). */
function packetLines(packets: Packet[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// packfiles

function packObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_TO_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Write a pack of plain (non-delta) objects, in the order given. */
export function writePack(objects: Array<{ type: ObjType; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start] as number;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset] as number;
    offset += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start] as number;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset] as number;
    offset += 1;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readSize();
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          copySize += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

export interface PackRead {
  objects: Array<{ oid: string; type: ObjType; data: Buffer }>;
}

/**
 * Read a pack received over receive-pack: inflate every entry in one pass with
 * zlib's {info:true} (which reports the consumed byte count), resolve OFS/REF
 * deltas against the pack itself and, for thin packs, against the repo store.
 */
export function readPack(repo: Repo, pack: Buffer): PackRead {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a pack');
  }
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  const trailer = pack.subarray(trailerStart).toString('hex');
  if (computed !== trailer) throw new Error('pack checksum mismatch');

  interface Raw {
    offset: number;
    typeCode: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const inflated = inflateSync(pack.subarray(offset, trailerStart), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    entry.data = inflated.buffer;
    offset += inflated.engine.bytesWritten;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }

  const resolved = new Map<number, { oid: string; type: ObjType; data: Buffer }>();
  const resolvedByOid = new Map<string, { type: ObjType; data: Buffer }>();
  const resolve = (entry: Raw): { oid: string; type: ObjType; data: Buffer } => {
    const cached = resolved.get(entry.offset);
    if (cached !== undefined) return cached;
    let type: ObjType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (baseEntry === undefined) throw new Error('ofs-delta base missing');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const inPack = resolvedByOid.get(entry.baseOid as string);
      let base: { type: ObjType; data: Buffer } | undefined = inPack;
      if (base === undefined) {
        const stored = repo.objects.get(entry.baseOid as string);
        if (stored !== undefined) base = { type: stored.t, data: stored.d };
      }
      if (base === undefined) throw new Error('ref-delta base missing');
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else {
      type = CODE_TO_TYPE[entry.typeCode] as ObjType;
      data = entry.data;
    }
    const result = { oid: hashObject(type, data), type, data };
    resolved.set(entry.offset, result);
    resolvedByOid.set(result.oid, { type, data });
    return result;
  };
  // Plain objects first, so a REF delta's base is resolvable even when the pack
  // orders the delta before its base; delta chains resolve recursively after.
  const objects: Array<{ oid: string; type: ObjType; data: Buffer }> = new Array(raw.length);
  raw.forEach((entry, index) => {
    if (entry.typeCode !== 6 && entry.typeCode !== 7) objects[index] = resolve(entry);
  });
  raw.forEach((entry, index) => {
    if (entry.typeCode === 6 || entry.typeCode === 7) objects[index] = resolve(entry);
  });
  return { objects };
}

// ---------------------------------------------------------------------------
// advertisements

const V2_ADVERTISEMENT: Buffer = (() => {
  const lines = [
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs\n',
    'fetch=shallow\n',
    'object-format=sha1\n',
  ];
  return Buffer.concat([...lines.map((line) => pkt(line)), PKT_FLUSH]);
})();

function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow agent=${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch}`
      : `report-status delete-refs side-band-64k ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [pkt(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    const headTip = repo.branchTip(repo.defaultBranch);
    if (headTip !== undefined) {
      parts.push(pkt(`${headTip} HEAD\0${caps}\n`));
      first = false;
    }
    for (const [name, oid] of refs) {
      parts.push(pkt(first ? `${oid} ${name}\0${caps}\n` : `${oid} ${name}\n`));
      first = false;
      const obj = repo.objects.get(oid);
      if (obj !== undefined && obj.t === 'tag') {
        const target = peel(repo, oid);
        if (target !== null && target !== oid) parts.push(pkt(`${target} ${name}^{}\n`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// ls-refs

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  prefixes: string[];
}

function lsRefsBody(repo: Repo, args: LsRefsArgs): Buffer {
  const cacheKey = `lsr|${args.peel ? 1 : 0}|${args.symrefs ? 1 : 0}|${args.prefixes.join(',')}`;
  const cached = repo.lsRefsCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const lines: string[] = [];
  const hasPrefixes = args.prefixes.length > 0;
  const matches = (name: string): boolean =>
    !hasPrefixes || args.prefixes.some((prefix) => name.startsWith(prefix));
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headTip = repo.branchTip(repo.defaultBranch);
  if (matches('HEAD')) {
    if (headTip !== undefined) {
      lines.push(`${headTip} HEAD${args.symrefs ? ` symref-target:${headTarget}` : ''}\n`);
    } else {
      lines.push(`${ZERO_OID} HEAD${args.symrefs ? ` symref-target:${headTarget}` : ''}\n`);
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    if (args.peel) {
      const obj = repo.objects.get(oid);
      if (obj !== undefined && obj.t === 'tag') {
        const target = peel(repo, oid);
        if (target !== null && target !== oid) line += ` peeled:${target}`;
      }
    }
    lines.push(`${line}\n`);
  }
  const body = Buffer.concat([...lines.map((line) => pkt(line)), PKT_FLUSH]);
  if (repo.lsRefsCache.size < 16) repo.lsRefsCache.set(cacheKey, body);
  return body;
}

// ---------------------------------------------------------------------------
// fetch (upload-pack POST)

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallowLines: string[];
  depth: number | null;
}

/**
 * What the client already holds, given its haves and its shallow boundary: the
 * closure of the haves, but a shallow-boundary commit's ancestors are NOT held
 * (that is what the boundary means), so the walk stops below them. Without
 * this, a deepen fetch would wrongly exclude the very commits it must send.
 */
function heldByClient(repo: Repo, haves: readonly string[], clientShallow: ReadonlySet<string>): Set<string> {
  const held = new Set<string>();
  const stack: string[] = [];
  for (const have of haves) {
    const commit = peel(repo, have);
    if (commit !== null) stack.push(commit);
    if (repo.objects.has(have)) held.add(have);
  }
  const visitedCommits = new Set<string>();
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (visitedCommits.has(oid)) continue;
    visitedCommits.add(oid);
    const head = repo.headOf(oid);
    if (head === undefined) continue;
    held.add(oid);
    // The commit's tree and blobs are held with the commit.
    const treeStack = [head.tree];
    while (treeStack.length > 0) {
      const treeOid = treeStack.pop() as string;
      if (held.has(treeOid)) continue;
      const entries = repo.treeOf(treeOid);
      if (entries === undefined) continue;
      held.add(treeOid);
      for (const entry of entries) {
        if (entry.mode === '40000') treeStack.push(entry.oid);
        else if (entry.mode !== '160000') held.add(entry.oid);
      }
    }
    if (clientShallow.has(oid)) continue; // boundary: parents are not held
    for (const parent of head.parents) stack.push(parent);
  }
  return held;
}

function buildPackForFetch(repo: Repo, args: FetchArgs): { pack: Buffer; shallow: string[]; unshallow: string[] } {
  const haveSet = heldByClient(repo, args.haves, new Set(args.shallowLines));
  let selected: Set<string>;
  let boundary: string[] = [];
  if (args.depth !== null) {
    const result = depthClosure(repo, args.wants, args.depth);
    selected = result.objects;
    boundary = result.boundary;
    for (const oid of haveSet) selected.delete(oid);
  } else {
    selected = closure(repo, args.wants);
    for (const oid of haveSet) selected.delete(oid);
  }
  const clientShallow = new Set(args.shallowLines);
  const unshallow: string[] = [];
  for (const oid of clientShallow) {
    if (!boundary.includes(oid)) {
      // A previously-shallow commit that is no longer at the boundary was deepened past.
      if (selected.has(oid) || repo.objects.has(oid)) unshallow.push(oid);
    }
  }
  // Order: commits first (parents before children is not required), then trees, then blobs.
  const commits: GitObj[] = [];
  const trees: GitObj[] = [];
  const blobs: GitObj[] = [];
  const tags: GitObj[] = [];
  for (const oid of selected) {
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    if (obj.t === 'commit') commits.push(obj);
    else if (obj.t === 'tree') trees.push(obj);
    else if (obj.t === 'blob') blobs.push(obj);
    else tags.push(obj);
  }
  const pack = writePack(
    [...tags, ...commits, ...trees, ...blobs].map((obj) => ({ type: obj.t, data: obj.d })),
  );
  return { pack, shallow: boundary, unshallow };
}

function sidebandPack(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 65512;
  for (let pos = 0; pos < pack.length; pos += CHUNK) {
    const slice = pack.subarray(pos, Math.min(pos + CHUNK, pack.length));
    packets.push(pkt(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (packets.length === 0) packets.push(pkt(Buffer.concat([Buffer.from([1]), Buffer.alloc(0)])));
  return packets;
}

function fetchV2Response(repo: Repo, args: FetchArgs): Buffer {
  const cacheKey = `f2|${args.wants.join(',')}|${args.haves.join(',')}|${args.shallowLines.join(',')}|${args.depth ?? ''}`;
  const cached = repo.packCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const { pack, shallow, unshallow } = buildPackForFetch(repo, args);
  const parts: Buffer[] = [];
  if (args.haves.length > 0) {
    parts.push(pkt('acknowledgments\n'));
    const acks = args.haves.filter((oid) => repo.objects.has(oid));
    if (acks.length === 0) parts.push(pkt('NAK\n'));
    else for (const oid of acks) parts.push(pkt(`ACK ${oid}\n`));
    parts.push(PKT_FLUSH);
  }
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pkt('shallow-info\n'));
    for (const oid of shallow) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pkt(`unshallow ${oid}\n`));
    parts.push(PKT_FLUSH);
  }
  parts.push(pkt('packfile\n'));
  for (const packet of sidebandPack(pack)) parts.push(packet);
  parts.push(PKT_FLUSH);
  const body = Buffer.concat(parts);
  if (repo.packCache.size < 16) repo.packCache.set(cacheKey, body);
  return body;
}

function fetchV0Response(repo: Repo, args: FetchArgs): Buffer {
  const { pack, shallow, unshallow } = buildPackForFetch(repo, args);
  const parts: Buffer[] = [];
  for (const oid of shallow) parts.push(pkt(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pkt(`unshallow ${oid}\n`));
  parts.push(pkt('NAK\n'));
  for (const packet of sidebandPack(pack)) parts.push(packet);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function receivePack(repo: Repo, body: Buffer): Buffer {
  const { packets, rest } = splitPackets(body, true);
  const commands: PushCommand[] = [];
  let sideband = false;
  for (const line of packetLines(packets)) {
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+?)(?:\0(.*))?$/.exec(line);
    if (match === null) continue;
    const caps = match[4] ?? '';
    if (caps.includes('side-band-64k')) sideband = true;
    commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
  }

  let unpackOk = true;
  let unpackDetail = 'ok';
  const updates = commands.some((command) => command.newOid !== ZERO_OID);
  if (rest.length > 0 && updates) {
    try {
      const { objects } = readPack(repo, rest);
      for (const object of objects) {
        if (!repo.objects.has(object.oid)) repo.store(object.type, object.data);
      }
    } catch {
      unpackOk = false;
      unpackDetail = 'pack could not be read';
    }
  }

  const reportLines: string[] = [`unpack ${unpackDetail}\n`];
  for (const command of commands) {
    if (!unpackOk) {
      reportLines.push(`ng ${command.ref} unpack failed\n`);
      continue;
    }
    if (command.newOid === ZERO_OID) {
      // delete
      if (repo.refs.has(command.ref)) {
        repo.deleteRef(command.ref);
        reportLines.push(`ok ${command.ref}\n`);
      } else {
        reportLines.push(`ok ${command.ref}\n`);
      }
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      reportLines.push(`ng ${command.ref} missing objects\n`);
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (current !== undefined && current !== command.newOid) {
      const currentCommit = peel(repo, current);
      const newCommit = peel(repo, command.newOid);
      if (currentCommit !== null && newCommit !== null && !isAncestor(repo, currentCommit, newCommit)) {
        reportLines.push(`ng ${command.ref} non-fast-forward\n`);
        continue;
      }
    }
    repo.setRef(command.ref, command.newOid);
    reportLines.push(`ok ${command.ref}\n`);
  }

  const reportStream = Buffer.concat([...reportLines.map((line) => pkt(line)), PKT_FLUSH]);
  if (!sideband) return reportStream;
  const banded: Buffer[] = [];
  const CHUNK = 65512;
  for (let pos = 0; pos < reportStream.length; pos += CHUNK) {
    const slice = reportStream.subarray(pos, Math.min(pos + CHUNK, reportStream.length));
    banded.push(pkt(Buffer.concat([Buffer.from([1]), slice])));
  }
  banded.push(PKT_FLUSH);
  return Buffer.concat(banded);
}

// ---------------------------------------------------------------------------
// request handling (called from app.ts)

export interface GitAnswer {
  status: number;
  contentType: string;
  body: Buffer;
}

const EMPTY = Buffer.alloc(0);

export function gitInfoRefs(repo: Repo | null, service: string, protocolV2: boolean): GitAnswer {
  if (repo === null) return { status: 404, contentType: 'text/plain', body: Buffer.from('not found') };
  if (service === 'git-upload-pack') {
    if (protocolV2) {
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: V2_ADVERTISEMENT };
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v0Advertisement(repo, 'git-upload-pack') };
  }
  if (service === 'git-receive-pack') {
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: v0Advertisement(repo, 'git-receive-pack') };
  }
  return { status: 400, contentType: 'text/plain', body: Buffer.from('unknown service') };
}

export function gitServicePost(repo: Repo | null, service: string, body: Buffer): GitAnswer {
  if (repo === null) return { status: 404, contentType: 'text/plain', body: Buffer.from('not found') };
  if (service === 'git-receive-pack') {
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: receivePack(repo, body) };
  }
  if (service !== 'git-upload-pack') return { status: 400, contentType: 'text/plain', body: EMPTY };
  // upload-pack: a v2 command stream, or a v0 request when the body opens with want lines.
  const { packets } = splitPackets(body);
  const lines = packetLines(packets);
  const commandLine = lines.find((line) => line.startsWith('command='));
  if (commandLine === undefined) {
    // v0 fetch: wants (with capabilities on the first), flush, haves, done, flush.
    const args: FetchArgs = { wants: [], haves: [], shallowLines: [], depth: null };
    for (const line of lines) {
      if (line.startsWith('want ')) args.wants.push(line.slice(5, 45));
      else if (line.startsWith('have ')) args.haves.push(line.slice(5, 45));
      else if (line.startsWith('shallow ')) args.shallowLines.push(line.slice(8, 48));
      else if (line.startsWith('deepen ')) args.depth = Number.parseInt(line.slice(7), 10);
    }
    if (args.wants.length === 0) return { status: 400, contentType: 'text/plain', body: EMPTY };
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchV0Response(repo, args) };
  }
  const command = commandLine.slice('command='.length);
  if (command === 'ls-refs') {
    const args: LsRefsArgs = { peel: false, symrefs: false, prefixes: [] };
    for (const line of lines) {
      if (line === 'peel') args.peel = true;
      else if (line === 'symrefs') args.symrefs = true;
      else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: lsRefsBody(repo, args) };
  }
  if (command === 'fetch') {
    const args: FetchArgs = { wants: [], haves: [], shallowLines: [], depth: null };
    for (const line of lines) {
      if (line.startsWith('want ')) args.wants.push(line.slice(5, 45));
      else if (line.startsWith('have ')) args.haves.push(line.slice(5, 45));
      else if (line.startsWith('shallow ')) args.shallowLines.push(line.slice(8, 48));
      else if (line.startsWith('deepen ')) args.depth = Number.parseInt(line.slice(7), 10);
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchV2Response(repo, args) };
  }
  return { status: 400, contentType: 'text/plain', body: EMPTY };
}
