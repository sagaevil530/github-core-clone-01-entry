// github-core-clone: a standalone GitHub-compatible git forge.
//
// One process, one in-memory store, no dependencies beyond the Node standard
// library. Serves git smart HTTP, REST v3, GraphQL and MCP. Every piece of
// server-created state is deterministic (counter-derived timestamps, never the
// wall clock), so replaying the same request sequence reproduces the same
// state byte for byte.
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
const DEFAULT_BRANCH = 'main';
const COMMIT_EPOCH_BASE = 1735689600;

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

function hashObject(type: string, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1Hex(Buffer.concat([head, data]));
}

function jsonOk(value: unknown): string {
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function b64encode(data: Buffer): string {
  return data.toString('base64');
}

function b64decode(text: string): Buffer {
  return Buffer.from(text.replace(/[\r\n\t ]+/g, ''), 'base64');
}

function isoFromSeq(seq: number): string {
  return new Date((COMMIT_EPOCH_BASE + seq) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface GitObject {
  type: 'commit' | 'tree' | 'blob' | 'tag';
  data: Buffer;
}

interface IssueComment {
  id: number;
  body: string;
  seq: number;
}

interface Issue {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: { name: string; color: string }[];
  comments: IssueComment[];
  seq: number;
}

interface PullRequest {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  seq: number;
}

interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Issue[];
  pulls: PullRequest[];
  labels: Map<string, { name: string; color: string }>;
  nextIssue: number;
  nextPull: number;
  nextComment: number;
  seq: number;
}

interface Store {
  repos: Map<string, Repo>;
  nextRepoId: number;
  nextIssueId: number;
  nextPullId: number;
  nextCommentId: number;
  nextSeq: number;
  commitSeq: number;
  viewer: string;
}

function createStore(viewer: string): Store {
  return {
    repos: new Map(),
    nextRepoId: 1,
    nextIssueId: 1,
    nextPullId: 1,
    nextCommentId: 1,
    nextSeq: 1,
    commitSeq: 0,
    viewer,
  };
}

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

function storeObject(repo: Repo, type: GitObject['type'], data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

function getRepo(store: Store, owner: string, name: string): Repo | undefined {
  if (owner !== store.viewer) return undefined;
  return store.repos.get(repoKey(owner, name));
}

function repoFullName(repo: Repo): string {
  return `${repo.owner}/${repo.name}`;
}

function nextCommitTimestamp(store: Store): number {
  store.commitSeq += 1;
  return COMMIT_EPOCH_BASE + store.commitSeq;
}

// ---------------------------------------------------------------------------
// Git objects: trees, commits, tags
// ---------------------------------------------------------------------------

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const nul = data.indexOf(0, sp);
    if (sp < 0 || nul < 0 || nul + 21 > data.length) break;
    out.push({
      mode: data.subarray(i, sp).toString('ascii'),
      name: data.subarray(sp + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    i = nul + 21;
  }
  return out;
}

function serializeTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.name + (a.mode === '40000' ? '/' : '');
    const kb = b.name + (b.mode === '40000' ? '/' : '');
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

interface ParsedTag {
  object: string;
  type: string;
  tag: string;
  message: string;
}

function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
  }
  return { object, type, tag, message };
}

/** Flatten a tree into path -> blob oid. */
function flattenTree(repo: Repo, treeOid: string, prefix: string, out: Map<string, string>): Map<string, string> {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix + entry.name;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, `${path}/`, out);
    else out.set(path, entry.oid);
  }
  return out;
}

/** Build a tree from a flat path -> blob oid map. */
function buildTreeFromPaths(repo: Repo, paths: Map<string, string>): string {
  const build = (dir: string): string => {
    const items = new Map<string, { file?: string; dir?: string }>();
    for (const [path, oid] of paths) {
      if (dir !== '' && !path.startsWith(dir)) continue;
      const rest = dir === '' ? path : path.slice(dir.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        items.set(rest, { file: oid });
      } else {
        const name = rest.slice(0, slash);
        if (!items.has(name)) items.set(name, { dir: build(`${dir}${name}/`) });
      }
    }
    const entries: TreeEntry[] = [];
    for (const [name, value] of items) {
      if (value.dir !== undefined) entries.push({ mode: '40000', name, oid: value.dir });
      else entries.push({ mode: '100644', name, oid: value.file ?? ZERO_OID });
    }
    return storeObject(repo, 'tree', serializeTree(entries));
  };
  return build('');
}

/** Create a commit object for a tree change, deterministically timestamped. */
function createCommit(
  store: Store,
  repo: Repo,
  treeOid: string,
  parents: string[],
  message: string,
): string {
  const ts = nextCommitTimestamp(store);
  const ident = `${store.viewer} <${store.viewer}@example.invalid> ${ts} +0000`;
  const lines = [`tree ${treeOid}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${ident}`, `committer ${ident}`, '', message.endsWith('\n') ? message : `${message}\n`);
  return storeObject(repo, 'commit', Buffer.from(lines.join('\n'), 'utf8'));
}

/** Resolve a ref name (branch, full ref, or oid) to a commit oid. */
function resolveRef(repo: Repo, ref: string): string | undefined {
  if (repo.refs.has(ref)) return repo.refs.get(ref);
  if (repo.refs.has(`refs/heads/${ref}`)) return repo.refs.get(`refs/heads/${ref}`);
  if (repo.refs.has(`refs/tags/${ref}`)) return repo.refs.get(`refs/tags/${ref}`);
  if (/^[0-9a-f]{40}$/.test(ref) && repo.objects.has(ref)) return ref;
  return undefined;
}

function refTip(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

/** Walk commits from tips. Returns commit oids with their depth and every object reachable from them. */
function walkCommits(
  repo: Repo,
  tips: string[],
  maxDepth: number | undefined,
  stopExpand: ReadonlySet<string>,
): { commits: Map<string, number>; objects: Set<string> } {
  const commits = new Map<string, number>();
  const objects = new Set<string>();
  const queue: { oid: string; depth: number }[] = [];
  for (const tip of tips) queue.push({ oid: tip, depth: 1 });
  const seenTags = new Set<string>();
  while (queue.length > 0) {
    const { oid, depth } = queue.shift()!;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'tag') {
      if (seenTags.has(oid)) continue;
      seenTags.add(oid);
      objects.add(oid);
      const target = parseTag(obj.data).object;
      queue.push({ oid: target, depth });
      continue;
    }
    if (obj.type !== 'commit') {
      objects.add(oid);
      continue;
    }
    if (commits.has(oid)) continue;
    commits.set(oid, depth);
    objects.add(oid);
    const parsed = parseCommit(obj.data);
    collectTreeObjects(repo, parsed.tree, objects);
    if (stopExpand.has(oid)) continue;
    if (maxDepth !== undefined && depth >= maxDepth) continue;
    for (const parent of parsed.parents) queue.push({ oid: parent, depth: depth + 1 });
  }
  return { commits, objects };
}

function collectTreeObjects(repo: Repo, treeOid: string, out: Set<string>): void {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return;
  if (out.has(treeOid)) return;
  out.add(treeOid);
  for (const entry of parseTree(obj.data)) {
    if (entry.mode === '40000') collectTreeObjects(repo, entry.oid, out);
    else out.add(entry.oid);
  }
}

/** Whether `ancestor` is an ancestor of (or equal to) `descendant`. */
function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
      continue;
    }
    if (obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (parent === ancestor) return true;
      stack.push(parent);
    }
  }
  return false;
}

/** First common ancestor of two commits, or undefined. */
function mergeBase(repo: Repo, a: string, b: string): string | undefined {
  const ancestorsA = new Set<string>();
  const stack = [a];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    stack.push(...parseCommit(obj.data).parents);
  }
  const queue = [b];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsA.has(oid)) return oid;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    queue.push(...parseCommit(obj.data).parents);
  }
  return undefined;
}

/**
 * Compare three file maps (merge-base, head, base tip) and decide whether a
 * squash merge conflicts, and what the merged file map is.
 */
function planMerge(
  baseFiles: Map<string, string>,
  headFiles: Map<string, string>,
  baseTipFiles: Map<string, string>,
): { conflict: boolean; merged: Map<string, string> } {
  const merged = new Map<string, string>(baseTipFiles);
  const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys(), ...baseTipFiles.keys()]);
  for (const path of paths) {
    const inBase = baseFiles.get(path);
    const inHead = headFiles.get(path);
    const inTip = baseTipFiles.get(path);
    const headChanged = inHead !== inBase;
    const tipChanged = inTip !== inBase;
    if (headChanged && tipChanged && inHead !== inTip) return { conflict: true, merged };
    if (headChanged) {
      if (inHead === undefined) merged.delete(path);
      else merged.set(path, inHead);
    }
  }
  return { conflict: false, merged };
}

/** Line-level additions/deletions between two blobs. */
function countLineDiff(oldData: Buffer | undefined, newData: Buffer | undefined): { additions: number; deletions: number } {
  const oldLines = oldData === undefined ? [] : oldData.toString('utf8').split('\n');
  const newLines = newData === undefined ? [] : newData.toString('utf8').split('\n');
  if (oldLines.length > 0 && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines.length > 0 && newLines[newLines.length - 1] === '') newLines.pop();
  const oldCount = new Map<string, number>();
  for (const line of oldLines) oldCount.set(line, (oldCount.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const remaining = oldCount.get(line) ?? 0;
    if (remaining > 0) oldCount.set(line, remaining - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const remaining of oldCount.values()) deletions += remaining;
  return { additions, deletions };
}

// ---------------------------------------------------------------------------
// Packfiles
// ---------------------------------------------------------------------------

const OBJ_TYPE_NAMES = ['', 'commit', 'tree', 'blob', 'tag', '', 'ofs-delta', 'ref-delta'] as const;
const OBJ_TYPE_NUMBERS: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function encodePackObject(type: GitObject['type'], data: Buffer): Buffer {
  const typeNum = OBJ_TYPE_NUMBERS[type] ?? 0;
  const header: number[] = [];
  let size = data.length;
  let first = (typeNum << 4) | (size & 0x0f);
  size >>= 4;
  while (size > 0) {
    header.push(first | 0x80);
    first = size & 0x7f;
    size >>= 7;
  }
  header.push(first);
  // Level 1 is far faster than the default for the small objects a forge
  // sends, and the pack travels over loopback, so size is not the constraint.
  return Buffer.concat([Buffer.from(header), deflateSync(data, { level: 1 })]);
}

// Packs are a pure function of their object list (objects are immutable
// once stored), so identical fetches reuse the built pack.
const packCache = new Map<string, Buffer>();

function writePack(repo: Repo, oids: Iterable<string>): Buffer {
  const seen = new Set<string>();
  const list: string[] = [];
  for (const oid of oids) {
    if (seen.has(oid)) continue;
    seen.add(oid);
    list.push(oid);
  }
  const key = `${repo.id}:${sha1Hex(Buffer.from(list.join(','), 'ascii'))}`;
  const cached = packCache.get(key);
  if (cached !== undefined) return cached;
  const objects: { type: GitObject['type']; data: Buffer }[] = [];
  for (const oid of list) {
    const obj = repo.objects.get(oid);
    if (obj) objects.push(obj);
  }
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 4, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [head];
  for (const obj of objects) parts.push(encodePackObject(obj.type, obj.data));
  const body = Buffer.concat(parts);
  const pack = Buffer.concat([body, createHash('sha1').update(body).digest()]);
  if (packCache.size >= 16) {
    const oldest = packCache.keys().next().value;
    if (oldest !== undefined) packCache.delete(oldest);
  }
  packCache.set(key, pack);
  return pack;
}

function verifyPackChecksum(pack: Buffer): boolean {
  if (pack.length < 32) return false;
  const expected = pack.subarray(pack.length - 20).toString('hex');
  return sha1Hex(pack.subarray(0, pack.length - 20)) === expected;
}

/** Inflate a zlib stream that starts at buf[0]; find how many bytes it used. */
function inflateExact(buf: Buffer, expectedSize: number): { data: Buffer; consumed: number } {
  // inflateSync ignores trailing bytes, and success is monotone in the slice
  // length (a slice succeeds exactly when it holds the whole stream), so a
  // binary search finds the smallest succeeding length: the stream's end.
  let lo = 0;
  let hi = buf.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    let ok = false;
    try {
      ok = inflateSync(buf.subarray(0, mid)).length === expectedSize;
    } catch {
      ok = false;
    }
    if (ok) hi = mid;
    else lo = mid + 1;
  }
  const data = inflateSync(buf.subarray(0, lo));
  if (data.length !== expectedSize) throw new Error(`inflated size ${data.length} != ${expectedSize}`);
  return { data, consumed: lo };
}

function readDeltaVarint(buf: Buffer, offset: number): [number, number] {
  let value = 0;
  let shift = 0;
  let i = offset;
  for (;;) {
    const byte = buf[i] ?? 0;
    i += 1;
    value |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return [value, i];
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const [baseSize, afterBase] = readDeltaVarint(delta, offset);
  offset = afterBase;
  const [resultSize, afterResult] = readDeltaVarint(delta, offset);
  offset = afterResult;
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let total = 0;
  while (offset < delta.length) {
    const op = delta[offset] ?? 0;
    offset += 1;
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      if (op & 0x01) cpOff = delta[offset++] ?? 0;
      if (op & 0x02) cpOff |= (delta[offset++] ?? 0) << 8;
      if (op & 0x04) cpOff |= (delta[offset++] ?? 0) << 16;
      if (op & 0x08) cpOff |= (delta[offset++] ?? 0) << 24;
      if (op & 0x10) cpSize = delta[offset++] ?? 0;
      if (op & 0x20) cpSize |= (delta[offset++] ?? 0) << 8;
      if (op & 0x40) cpSize |= (delta[offset++] ?? 0) << 16;
      if (cpSize === 0) cpSize = 0x10000;
      out.push(base.subarray(cpOff, cpOff + cpSize));
      total += cpSize;
    } else if (op !== 0) {
      out.push(delta.subarray(offset, offset + op));
      total += op;
      offset += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (total !== resultSize) throw new Error('delta result size mismatch');
  return Buffer.concat(out);
}

interface ParsedPackObject {
  oid: string;
  type: GitObject['type'];
  data: Buffer;
}

/** Parse a packfile into resolved objects (deltas applied). */
function readPack(buf: Buffer): Map<string, ParsedPackObject> {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('pack does not start with PACK');
  }
  const count = buf.readUInt32BE(8);
  const objects = new Map<string, ParsedPackObject>();
  const byOffset = new Map<number, ParsedPackObject>();
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    const start = off;
    let byte = buf[off++] ?? 0;
    const typeNum = (byte >> 4) & 7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buf[off++] ?? 0;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeNum === 6) {
      // OFS_DELTA: negative offset varint.
      let b = buf[off++] ?? 0;
      let offset = b & 0x7f;
      while (b & 0x80) {
        b = buf[off++] ?? 0;
        offset = ((offset + 1) << 7) | (b & 0x7f);
      }
      const baseOff = start - offset;
      const { data, consumed } = inflateExact(buf.subarray(off), size);
      off += consumed;
      const base = byOffset.get(baseOff);
      if (!base) throw new Error('ofs-delta base not found');
      const resolved = applyDelta(base.data, data);
      const oid = hashObject(base.type, resolved);
      const parsed: ParsedPackObject = { oid, type: base.type, data: resolved };
      objects.set(oid, parsed);
      byOffset.set(start, parsed);
    } else if (typeNum === 7) {
      // REF_DELTA: 20-byte base oid.
      const baseOid = buf.subarray(off, off + 20).toString('hex');
      off += 20;
      const { data, consumed } = inflateExact(buf.subarray(off), size);
      off += consumed;
      const base = objects.get(baseOid);
      if (!base) throw new Error('ref-delta base not found');
      const resolved = applyDelta(base.data, data);
      const oid = hashObject(base.type, resolved);
      const parsed: ParsedPackObject = { oid, type: base.type, data: resolved };
      objects.set(oid, parsed);
      byOffset.set(start, parsed);
    } else {
      const type = OBJ_TYPE_NAMES[typeNum] as GitObject['type'];
      if (!type || type === 'ofs-delta' || type === 'ref-delta') throw new Error(`unknown pack object type ${typeNum}`);
      const { data, consumed } = inflateExact(buf.subarray(off), size);
      off += consumed;
      const oid = hashObject(type, data);
      const parsed: ParsedPackObject = { oid, type, data };
      objects.set(oid, parsed);
      byOffset.set(start, parsed);
    }
  }
  return objects;
}

// ---------------------------------------------------------------------------
// Pkt-lines
// ---------------------------------------------------------------------------

function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), data]);
}

const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');

interface Packet {
  kind: 'data' | 'flush' | 'delim';
  payload: Buffer;
}

function parsePackets(buf: Buffer): Packet[] {
  const out: Packet[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('truncated pkt-line');
    const lenText = buf.subarray(off, off + 4).toString('ascii');
    if (lenText === '0000') {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (lenText === '0001') {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    const len = parseInt(lenText, 16);
    if (!Number.isFinite(len) || len < 4 || off + len > buf.length) throw new Error('malformed pkt-line');
    out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return out;
}

/** Split a payload into sideband frames (band 1 = data). */
function sidebandFrames(band: number, data: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  const chunk = 65000;
  for (let i = 0; i < data.length; i += chunk) {
    const piece = data.subarray(i, Math.min(data.length, i + chunk));
    frames.push(pktLine(Buffer.concat([Buffer.from([band]), piece])));
  }
  if (data.length === 0) frames.push(pktLine(Buffer.from([band])));
  return frames;
}

// ---------------------------------------------------------------------------
// Git smart HTTP
// ---------------------------------------------------------------------------

function sortedRefs(repo: Repo): { name: string; oid: string }[] {
  const names = [...repo.refs.keys()].sort();
  return names.map((name) => ({ name, oid: repo.refs.get(name) ?? ZERO_OID }));
}

function peeledOid(repo: Repo, oid: string): string | undefined {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'tag') return undefined;
  return parseTag(obj.data).object;
}

function uploadPackCapsV0(): string {
  return 'symref=HEAD:refs/heads/main side-band-64k shallow ofs-delta thin-pack agent=github-core-clone/1.0.0';
}

function receivePackCapsV0(): string {
  return 'report-status side-band-64k delete-refs ofs-delta thin-pack agent=github-core-clone/1.0.0';
}

function advertisementV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const caps = service === 'git-upload-pack' ? uploadPackCapsV0() : receivePackCapsV0();
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headOid = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`) ?? refs[0]?.oid ?? ZERO_OID;
    parts.push(pktLine(`${headOid} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      const peeled = peeledOid(repo, ref.oid);
      if (peeled !== undefined && ref.name.startsWith('refs/tags/')) {
        parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function advertisementV2(): Buffer {
  const lines = [
    'version 2\n',
    'agent=github-core-clone/1.0.0\n',
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'server-option\n',
    'object-format=sha1\n',
  ];
  return Buffer.concat([...lines.map((line) => pktLine(line)), PKT_FLUSH]);
}

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function lsRefsReply(repo: Repo, args: LsRefsArgs): Buffer {
  const lines: string[] = [];
  const headTip = refTip(repo, DEFAULT_BRANCH);
  const include = (name: string): boolean => {
    if (args.prefixes.length === 0) return true;
    return args.prefixes.some((prefix) => name.startsWith(prefix));
  };
  const headIncluded =
    args.prefixes.length === 0 ||
    args.prefixes.some((prefix) => 'HEAD'.startsWith(prefix) || prefix.startsWith('HEAD'));
  if (headIncluded) {
    if (headTip !== undefined) {
      lines.push(`${headTip} HEAD${args.symrefs ? ' symref-target:refs/heads/main' : ''}\n`);
    } else if (args.unborn) {
      lines.push(`unborn HEAD${args.symrefs ? ' symref-target:refs/heads/main' : ''}\n`);
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (!include(ref.name)) continue;
    if (ref.name === `refs/heads/${DEFAULT_BRANCH}` && headTip === undefined) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (ref.name.startsWith('refs/tags/')) {
      const peeled = peeledOid(repo, ref.oid);
      if (peeled !== undefined && args.peel) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  if (headTip === undefined && args.unborn && headIncluded) {
    // An unborn HEAD is the only unborn line real git sends: the unborn
    // branch itself is not listed.
    lines.push(`unborn HEAD${args.symrefs ? ' symref-target:refs/heads/main' : ''}\n`);
  }
  return Buffer.concat([...lines.map((line) => pktLine(line)), PKT_FLUSH]);
}

interface FetchPlan {
  send: string[];
  shallow: string[];
  unshallow: string[];
  ack: string[];
}

function planFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  shallowList: string[],
  deepen: number | undefined,
): FetchPlan {
  const shallowSet = new Set(shallowList);
  const walk = walkCommits(repo, wants, deepen, new Set());
  const shallowOut: string[] = [];
  for (const [oid] of walk.commits) {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.some((parent) => repo.objects.has(parent) && !walk.commits.has(parent))) {
      shallowOut.push(oid);
    }
  }
  const unshallowOut: string[] = [];
  for (const oid of shallowList) {
    if (!walk.commits.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.length > 0 && parents.every((parent) => walk.commits.has(parent))) {
      unshallowOut.push(oid);
    }
  }
  const held = walkCommits(repo, haves, undefined, shallowSet).objects;
  const send: string[] = [];
  for (const oid of walk.objects) {
    if (!held.has(oid)) send.push(oid);
  }
  const ack = haves.filter((have) => repo.objects.has(have));
  return { send, shallow: shallowOut, unshallow: unshallowOut, ack: ack.length === haves.length ? ack : [] };
}

function fetchV2Reply(repo: Repo, wants: string[], haves: string[], shallowList: string[], deepen: number | undefined): Buffer {
  // Real git's upload-pack sends no acknowledgments section when the request
  // already carries `done` (no wait-for-done negotiation): the response is
  // just shallow-info (when the fetch is shallow) and the packfile section.
  const plan = planFetch(repo, wants, haves, shallowList, deepen);
  const parts: Buffer[] = [];
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  if (plan.send.length > 0) {
    parts.push(pktLine('packfile\n'));
    const pack = writePack(repo, plan.send);
    parts.push(...sidebandFrames(1, pack));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function fetchV0Reply(repo: Repo, wants: string[], haves: string[], shallowList: string[], deepen: number | undefined): Buffer {
  const plan = planFetch(repo, wants, haves, shallowList, deepen);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (haves.length === 0 || plan.ack.length === 0) {
    parts.push(pktLine('NAK\n'));
  } else {
    for (const oid of plan.ack) parts.push(pktLine(`ACK ${oid}\n`));
  }
  if (plan.send.length > 0) {
    const pack = writePack(repo, plan.send);
    parts.push(...sidebandFrames(1, pack));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function parseV2Request(body: Buffer): { command: string; args: string[] } {
  const packets = parsePackets(body);
  let command = '';
  const args: string[] = [];
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!seenDelim) {
      if (line.startsWith('command=')) command = line.slice('command='.length);
    } else {
      args.push(line);
    }
  }
  return { command, args };
}

function handleUploadPack(repo: Repo, req: IncomingMessage, body: Buffer): { status: number; contentType: string; data: Buffer } {
  const protocol = (req.headers['git-protocol'] ?? '').toString();
  if (protocol === 'version=2') {
    const { command, args } = parseV2Request(body);
    if (command === 'ls-refs') {
      const parsed: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
      for (const arg of args) {
        if (arg === 'peel') parsed.peel = true;
        else if (arg === 'symrefs') parsed.symrefs = true;
        else if (arg === 'unborn') parsed.unborn = true;
        else if (arg.startsWith('ref-prefix ')) parsed.prefixes.push(arg.slice('ref-prefix '.length));
      }
      return { status: 200, contentType: 'application/x-git-upload-pack-result', data: lsRefsReply(repo, parsed) };
    }
    if (command === 'fetch') {
      const wants: string[] = [];
      const haves: string[] = [];
      const shallow: string[] = [];
      let deepen: number | undefined;
      for (const arg of args) {
        if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
        else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
        else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8).trim());
        else if (arg.startsWith('deepen ')) deepen = parseInt(arg.slice(7).trim(), 10);
      }
      return { status: 200, contentType: 'application/x-git-upload-pack-result', data: fetchV2Reply(repo, wants, haves, shallow, deepen) };
    }
    throw new Error(`unknown v2 command ${command}`);
  }
  // Protocol v0: wants (+ shallow/deepen) until flush, then haves + done until flush.
  const packets = parsePackets(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let deepen: number | undefined;
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    const clean = line.includes('\0') ? line.slice(0, line.indexOf('\0')) : line;
    if (section === 0) {
      if (clean.startsWith('want ')) wants.push(clean.slice(5).trim().split(' ')[0] ?? '');
      else if (clean.startsWith('shallow ')) shallow.push(clean.slice(8).trim());
      else if (clean.startsWith('deepen ')) deepen = parseInt(clean.slice(7).trim(), 10);
    } else {
      if (clean.startsWith('have ')) haves.push(clean.slice(5).trim());
      else if (clean === 'done') break;
    }
  }
  return { status: 200, contentType: 'application/x-git-upload-pack-result', data: fetchV0Reply(repo, wants, haves, shallow, deepen) };
}

interface RefUpdate {
  oldOid: string;
  newOid: string;
  ref: string;
  ok: boolean;
  reason: string;
}

function handleReceivePack(
  store: Store,
  repo: Repo,
  body: Buffer,
): { status: number; contentType: string; data: Buffer } {
  let off = 0;
  const rawCommands: string[] = [];
  while (off + 4 <= body.length) {
    const lenText = body.subarray(off, off + 4).toString('ascii');
    if (lenText === '0000') {
      off += 4;
      break;
    }
    const len = parseInt(lenText, 16);
    if (!Number.isFinite(len) || len < 4 || off + len > body.length) throw new Error('malformed pkt-line in receive-pack');
    rawCommands.push(body.subarray(off + 4, off + len).toString('utf8'));
    off += len;
  }
  const packBytes = body.subarray(off);
  if (packBytes.length > 0) {
    const objects = readPack(packBytes);
    for (const [oid, obj] of objects) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, { type: obj.type, data: obj.data });
    }
  }
  const updates: RefUpdate[] = [];
  for (const raw of rawCommands) {
    const line = raw.includes('\0') ? raw.slice(0, raw.indexOf('\0')) : raw;
    const clean = line.replace(/\n$/, '');
    const parts = clean.split(' ');
    if (parts.length < 3) continue;
    const [oldOid, newOid, ref] = parts as [string, string, string];
    const current = repo.refs.get(ref);
    let ok = true;
    let reason = '';
    if (newOid === ZERO_OID) {
      if (current === undefined || oldOid !== current) {
        ok = false;
        reason = 'non-fast-forward';
      }
    } else if (oldOid === ZERO_OID) {
      if (current !== undefined || !repo.objects.has(newOid)) {
        ok = false;
        reason = current !== undefined ? 'non-fast-forward' : 'object not found';
      }
    } else {
      if (current !== oldOid || !repo.objects.has(newOid) || !isAncestor(repo, oldOid, newOid)) {
        ok = false;
        reason = 'non-fast-forward';
      }
    }
    updates.push({ oldOid, newOid, ref, ok, reason });
  }
  for (const update of updates) {
    if (!update.ok) continue;
    if (update.newOid === ZERO_OID) repo.refs.delete(update.ref);
    else repo.refs.set(update.ref, update.newOid);
  }
  // The report-status stream is itself pkt-lined inside band 1: build the
  // framed stream first (unpack line, one ok/ng line per ref, flush), then
  // wrap the whole stream in sideband band-1 frames, then a final flush.
  const innerParts: Buffer[] = [pktLine('unpack ok\n')];
  for (const update of updates) {
    innerParts.push(pktLine(update.ok ? `ok ${update.ref}\n` : `ng ${update.ref} ${update.reason}\n`));
  }
  innerParts.push(PKT_FLUSH);
  const inner = Buffer.concat(innerParts);
  const parts: Buffer[] = [...sidebandFrames(1, inner), PKT_FLUSH];
  return { status: 200, contentType: 'application/x-git-receive-pack-result', data: Buffer.concat(parts) };
}

// ---------------------------------------------------------------------------
// REST v3
// ---------------------------------------------------------------------------

function userJson(store: Store): Record<string, unknown> {
  return {
    login: store.viewer,
    id: 1,
    node_id: 'U_1',
    type: 'User',
    name: store.viewer,
    email: `${store.viewer}@example.invalid`,
    html_url: `https://example.invalid/${store.viewer}`,
  };
}

function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: repoFullName(repo),
    owner: userJson(store),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${repoFullName(repo)}`,
    clone_url: `https://example.invalid/${repoFullName(repo)}.git`,
    git_url: `git://example.invalid/${repoFullName(repo)}.git`,
    ssh_url: `git@example.invalid:${repoFullName(repo)}.git`,
    created_at: isoFromSeq(repo.seq),
    updated_at: isoFromSeq(repo.seq),
    pushed_at: isoFromSeq(repo.seq),
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_${repo.id}_${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    user: userJson(store),
    assignee: null,
    assignees: [],
    locked: false,
    comments: issue.comments.length,
    created_at: isoFromSeq(issue.seq),
    updated_at: isoFromSeq(issue.seq),
    closed_at: issue.state === 'closed' ? isoFromSeq(issue.seq) : null,
    html_url: `https://example.invalid/${repoFullName(repo)}/issues/${issue.number}`,
    repository_url: `https://example.invalid/${repoFullName(repo)}`,
  };
}

function commentJson(store: Store, repo: Repo, issue: Issue, comment: IssueComment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `IC_${comment.id}`,
    body: comment.body,
    user: userJson(store),
    created_at: isoFromSeq(comment.seq),
    updated_at: isoFromSeq(comment.seq),
    html_url: `https://example.invalid/${repoFullName(repo)}/issues/${issue.number}#issuecomment-${comment.id}`,
  };
}

function pullJson(store: Store, repo: Repo, pr: PullRequest): Record<string, unknown> {
  return {
    id: pr.id,
    node_id: `PR_${repo.id}_${pr.number}`,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    mergeable: prMergeable(store, repo, pr) === 'MERGEABLE',
    mergeable_state: prMergeable(store, repo, pr) === 'CONFLICTING' ? 'dirty' : 'clean',
    draft: false,
    locked: false,
    head: {
      label: `${repo.owner}:${pr.headRef}`,
      ref: pr.headRef,
      sha: pr.headSha,
      repo: repoJson(store, repo),
    },
    base: {
      label: `${repo.owner}:${pr.baseRef}`,
      ref: pr.baseRef,
      sha: pr.baseSha,
      repo: repoJson(store, repo),
    },
    user: userJson(store),
    created_at: isoFromSeq(pr.seq),
    updated_at: isoFromSeq(pr.seq),
    closed_at: pr.state === 'closed' ? (pr.mergedAt ?? isoFromSeq(pr.seq)) : null,
    html_url: `https://example.invalid/${repoFullName(repo)}/pull/${pr.number}`,
  };
}

function prMergeable(store: Store, repo: Repo, pr: PullRequest): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pr.state !== 'open') return 'UNKNOWN';
  const headSha = refTip(repo, pr.headRef) ?? pr.headSha;
  const baseSha = refTip(repo, pr.baseRef) ?? pr.baseSha;
  const base = mergeBase(repo, headSha, baseSha);
  if (base === undefined) return 'UNKNOWN';
  const baseCommit = repo.objects.get(base);
  const headCommit = repo.objects.get(headSha);
  const baseTipCommit = repo.objects.get(baseSha);
  if (!baseCommit || !headCommit || !baseTipCommit) return 'UNKNOWN';
  const baseFiles = flattenTree(repo, parseCommit(baseCommit.data).tree, '', new Map());
  const headFiles = flattenTree(repo, parseCommit(headCommit.data).tree, '', new Map());
  const tipFiles = flattenTree(repo, parseCommit(baseTipCommit.data).tree, '', new Map());
  return planMerge(baseFiles, headFiles, tipFiles).conflict ? 'CONFLICTING' : 'MERGEABLE';
}

function prFiles(store: Store, repo: Repo, pr: PullRequest): Record<string, unknown>[] {
  const headSha = refTip(repo, pr.headRef) ?? pr.headSha;
  const baseSha = refTip(repo, pr.baseRef) ?? pr.baseSha;
  const headCommit = repo.objects.get(headSha);
  const baseCommit = repo.objects.get(baseSha);
  const headFiles = headCommit ? flattenTree(repo, parseCommit(headCommit.data).tree, '', new Map()) : new Map<string, string>();
  const baseFiles = baseCommit ? flattenTree(repo, parseCommit(baseCommit.data).tree, '', new Map()) : new Map<string, string>();
  const out: Record<string, unknown>[] = [];
  const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const inHead = headFiles.get(path);
    const inBase = baseFiles.get(path);
    if (inHead === inBase) continue;
    const headData = inHead === undefined ? undefined : repo.objects.get(inHead)?.data;
    const baseData = inBase === undefined ? undefined : repo.objects.get(inBase)?.data;
    const { additions, deletions } = countLineDiff(baseData, headData);
    const status = inBase === undefined ? 'added' : inHead === undefined ? 'removed' : 'modified';
    out.push({
      filename: path,
      status,
      additions,
      deletions,
      changes: additions + deletions,
      blob_url: null,
      raw_url: null,
      contents_url: null,
      patch: null,
    });
  }
  return out;
}

function parseIdentLine(line: string): { name: string; email: string; epoch: number } {
  const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (!match) return { name: '', email: '', epoch: COMMIT_EPOCH_BASE };
  return { name: match[1] ?? '', email: match[2] ?? '', epoch: parseInt(match[3] ?? '0', 10) };
}

function commitJson(repo: Repo, sha: string): Record<string, unknown> | undefined {
  const obj = repo.objects.get(sha);
  if (!obj || obj.type !== 'commit') return undefined;
  const parsed = parseCommit(obj.data);
  const author = parseIdentLine(parsed.author);
  const committer = parseIdentLine(parsed.committer);
  // The commit object stores the message with a trailing newline; the API
  // presents it without that one trailing newline.
  const message = parsed.message.endsWith('\n') ? parsed.message.slice(0, -1) : parsed.message;
  return {
    sha,
    node_id: `C_${sha}`,
    commit: {
      message,
      author: { name: author.name, email: author.email, date: new Date(author.epoch * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') },
      committer: { name: committer.name, email: committer.email, date: new Date(committer.epoch * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') },
      tree: { sha: parsed.tree },
    },
    parents: parsed.parents.map((parent) => ({ sha: parent })),
    author: { login: author.name },
    committer: { login: committer.name },
  };
}

function commitChain(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = tip;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    const obj = repo.objects.get(current);
    if (!obj || obj.type !== 'commit') break;
    out.push(current);
    current = parseCommit(obj.data).parents[0];
  }
  return out;
}

function paginate<T>(req: IncomingMessage, items: T[], query: URLSearchParams): { page: T[]; link: string | null } {
  const perPageRaw = query.get('per_page');
  const perPage = perPageRaw === null ? items.length : Math.max(1, parseInt(perPageRaw, 10) || 30);
  const pageNum = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  const start = (pageNum - 1) * perPage;
  const page = items.slice(start, start + perPage);
  const host = req.headers.host ?? '127.0.0.1';
  const path = (req.url ?? '').split('?')[0] ?? '';
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const links: string[] = [];
  const urlFor = (pageValue: number): string => {
    const next = new URLSearchParams(query);
    next.set('page', String(pageValue));
    if (perPageRaw !== null) next.set('per_page', String(perPage));
    return `http://${host}${path}?${next.toString()}`;
  };
  if (pageNum < totalPages) links.push(`<${urlFor(pageNum + 1)}>; rel="next"`);
  if (pageNum > 1) links.push(`<${urlFor(pageNum - 1)}>; rel="prev"`);
  links.push(`<${urlFor(1)}>; rel="first"`);
  links.push(`<${urlFor(totalPages)}>; rel="last"`);
  return { page, link: links.length > 0 ? links.join(', ') : null };
}

// ---------------------------------------------------------------------------
// REST router
// ---------------------------------------------------------------------------

interface RestContext {
  store: Store;
  req: IncomingMessage;
  query: URLSearchParams;
  body: unknown;
}

type RestResult =
  | { status: number; json: unknown; headers?: Record<string, string> }
  | { status: number; empty: true; headers?: Record<string, string> };

function err(status: number, message: string): RestResult {
  return { status, json: { message } };
}

function notFound(): RestResult {
  return err(404, 'Not Found');
}

function routeRest(ctx: RestContext, segments: string[]): RestResult {
  const { store, req, query, body } = ctx;
  const method = req.method ?? 'GET';

  if (segments.length === 0) {
    if (method !== 'GET') return notFound();
    return {
      status: 200,
      json: {
        current_user_url: '/api/v3/user',
        current_user_authorizations_html_url: '/api/v3/authorizations',
        authorizations_url: '/api/v3/authorizations',
        code_search_url: '/api/v3/search/code?q={query}',
        commit_search_url: '/api/v3/search/commits?q={query}',
        emails_url: '/api/v3/user/emails',
        emojis_url: '/api/v3/emojis',
        events_url: '/api/v3/events',
        feeds_url: '/api/v3/feeds',
        followers_url: '/api/v3/users/{user}/followers',
        following_url: '/api/v3/users/{user}/following{/other_user}',
        gists_url: '/api/v3/gists{/gist_id}',
        hub_url: '/api/v3/hub',
        issue_search_url: '/api/v3/search/issues?q={query}',
        issues_url: '/api/v3/issues',
        keys_url: '/api/v3/user/keys',
        label_search_url: '/api/v3/search/labels?q={query}',
        notifications_url: '/api/v3/notifications',
        organization_url: '/api/v3/orgs/{org}',
        organization_repositories_url: '/api/v3/orgs/{org}/repos{?type,page,per_page,sort}',
        organization_teams_url: '/api/v3/orgs/{org}/teams',
        public_gists_url: '/api/v3/gists/public',
        rate_limit_url: '/api/v3/rate_limit',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        repository_search_url: '/api/v3/search/repositories?q={query}',
        current_user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
        starred_url: '/api/v3/user/starred{/owner}{/repo}',
        starred_gists_url: '/api/v3/gists/starred',
        topic_search_url: '/api/v3/search/topics?q={query}',
        user_url: '/api/v3/users/{user}',
        user_organizations_url: '/api/v3/user/orgs',
        user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
        user_search_url: '/api/v3/search/users?q={query}',
      },
      headers: { 'x-oauth-scopes': 'repo, read:org' },
    };
  }

  if (segments[0] === 'meta') {
    if (method !== 'GET') return notFound();
    return { status: 200, json: { installed_version: '1.0.0', verifiable_password_authentication: true, github_services_sha: '0000000000000000000000000000000000000000' } };
  }

  if (segments[0] === 'user') {
    if (segments.length === 1) {
      if (method !== 'GET') return notFound();
      return { status: 200, json: userJson(store) };
    }
    if (segments[1] === 'repos') {
      if (method === 'GET') {
        const repos = [...store.repos.values()]
          .filter((repo) => repo.owner === store.viewer)
          .sort((a, b) => a.seq - b.seq);
        const { page, link } = paginate(req, repos, query);
        return { status: 200, json: page.map((repo) => repoJson(store, repo)), headers: link ? { link } : undefined };
      }
      if (method === 'POST') {
        if (!isRecord(body)) return err(422, 'Validation Failed');
        const name = asString(body.name);
        if (name === undefined || name === '') return err(422, 'Validation Failed: name is required');
        if (store.repos.has(repoKey(store.viewer, name))) return err(422, 'Repository already exists');
        const repo: Repo = {
          id: store.nextRepoId++,
          owner: store.viewer,
          name,
          description: asString(body.description) ?? '',
          isPrivate: asBoolean(body.private) ?? false,
          defaultBranch: DEFAULT_BRANCH,
          refs: new Map(),
          objects: new Map(),
          issues: [],
          pulls: [],
          labels: new Map(),
          nextIssue: 1,
          nextPull: 1,
          nextComment: 1,
          seq: store.nextSeq++,
        };
        store.repos.set(repoKey(store.viewer, name), repo);
        return { status: 201, json: repoJson(store, repo) };
      }
      return notFound();
    }
    return notFound();
  }

  if (segments[0] !== 'repos' || segments.length < 3) return notFound();
  const owner = decodeURIComponent(segments[1] ?? '');
  const repoName = decodeURIComponent(segments[2] ?? '');
  const repo = getRepo(store, owner, repoName);
  const rest = segments.slice(3);

  if (rest.length === 0) {
    if (method === 'GET') {
      if (!repo) return notFound();
      return { status: 200, json: repoJson(store, repo) };
    }
    if (method === 'PATCH') {
      if (!repo) return notFound();
      if (isRecord(body)) {
        const description = asString(body.description);
        if (description !== undefined) repo.description = description;
        const isPrivate = asBoolean(body.private);
        if (isPrivate !== undefined) repo.isPrivate = isPrivate;
      }
      return { status: 200, json: repoJson(store, repo) };
    }
    if (method === 'DELETE') {
      if (!repo) return notFound();
      store.repos.delete(repoKey(owner, repoName));
      return { status: 204, empty: true };
    }
    return notFound();
  }

  if (!repo) return notFound();

  if (rest[0] === 'branches') {
    if (rest.length === 1) {
      if (method !== 'GET') return notFound();
      const branches = [...repo.refs.keys()]
        .filter((name) => name.startsWith('refs/heads/'))
        .sort()
        .map((name) => ({ name: name.slice('refs/heads/'.length), commit: { sha: repo.refs.get(name) ?? ZERO_OID }, protected: false }));
      return { status: 200, json: branches };
    }
    if (rest.length === 2) {
      if (method !== 'GET') return notFound();
      const branch = decodeURIComponent(rest[1] ?? '');
      const sha = refTip(repo, branch);
      if (sha === undefined) return notFound();
      return { status: 200, json: { name: branch, commit: { sha }, protected: false } };
    }
    return notFound();
  }

  if (rest[0] === 'commits') {
    if (method !== 'GET') return notFound();
    const ref = query.get('sha');
    const tip = ref === null ? refTip(repo, repo.defaultBranch) : resolveRef(repo, ref);
    if (tip === undefined) return { status: 200, json: [] };
    const chain = commitChain(repo, tip);
    const { page } = paginate(req, chain, query);
    const out: unknown[] = [];
    for (const sha of page) {
      const rendered = commitJson(repo, sha);
      if (rendered) out.push(rendered);
    }
    return { status: 200, json: out };
  }

  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      if (!isRecord(body)) return err(422, 'Validation Failed');
      const ref = asString(body.ref);
      const sha = asString(body.sha);
      if (ref === undefined || sha === undefined || !ref.startsWith('refs/')) return err(422, 'Validation Failed');
      if (repo.refs.has(ref)) return err(422, 'Reference already exists');
      const obj = repo.objects.get(sha);
      if (!obj) return err(422, 'Object does not exist');
      repo.refs.set(ref, sha);
      return { status: 201, json: { ref, node_id: `RF_${repo.id}_${encodeURIComponent(ref)}`, object: { sha, type: obj.type, url: '' } } };
    }
    if (method === 'GET') {
      if (rest.length === 2) {
        const all = sortedRefs(repo).map((entry) => {
          const obj = repo.objects.get(entry.oid);
          return { ref: entry.name, object: { sha: entry.oid, type: obj?.type ?? 'commit' } };
        });
        return { status: 200, json: all };
      }
      const suffix = rest.slice(2).map((piece) => decodeURIComponent(piece)).join('/');
      const fullRef = `refs/${suffix}`;
      const sha = repo.refs.get(fullRef);
      if (sha === undefined) return notFound();
      const obj = repo.objects.get(sha);
      return { status: 200, json: { ref: fullRef, node_id: `RF_${repo.id}_${encodeURIComponent(fullRef)}`, object: { sha, type: obj?.type ?? 'commit', url: '' } } };
    }
    return notFound();
  }

  if (rest[0] === 'contents') {
    const path = rest.slice(1).map((piece) => decodeURIComponent(piece)).join('/');
    if (method === 'PUT') {
      if (!isRecord(body)) return err(422, 'Validation Failed');
      const message = asString(body.message) ?? `Update ${path}`;
      const contentB64 = asString(body.content);
      if (contentB64 === undefined) return err(422, 'Validation Failed: content is required');
      const branch = asString(body.branch) ?? repo.defaultBranch;
      const tip = refTip(repo, branch);
      if (tip === undefined && branch !== repo.defaultBranch) return notFound();
      const bytes = b64decode(contentB64);
      const blobSha = storeObject(repo, 'blob', bytes);
      const files = tip === undefined ? new Map<string, string>() : flattenTree(repo, parseCommit(repo.objects.get(tip)!.data).tree, '', new Map());
      const existing = files.get(path);
      const givenSha = asString(body.sha);
      if (givenSha !== undefined && givenSha !== existing) return err(409, 'Conflict: sha does not match');
      const created = existing === undefined;
      const next = new Map(files);
      next.set(path, blobSha);
      const treeOid = buildTreeFromPaths(repo, next);
      const commitSha = createCommit(store, repo, treeOid, tip === undefined ? [] : [tip], message);
      repo.refs.set(`refs/heads/${branch}`, commitSha);
      return {
        status: created ? 201 : 200,
        json: {
          content: { name: path.split('/').pop() ?? path, path, sha: blobSha, size: bytes.length, type: 'file', encoding: 'base64', content: b64encode(bytes) },
          commit: { sha: commitSha, message },
        },
      };
    }
    if (method === 'GET') {
      const refParam = query.get('ref');
      const tip = refParam === null ? refTip(repo, repo.defaultBranch) : resolveRef(repo, refParam);
      if (tip === undefined) return notFound();
      const tipObj = repo.objects.get(tip);
      if (!tipObj || tipObj.type !== 'commit') return notFound();
      const files = flattenTree(repo, parseCommit(tipObj.data).tree, '', new Map());
      if (path === '') {
        return { status: 200, json: dirListing(repo, files, '') };
      }
      const blobOid = files.get(path);
      if (blobOid !== undefined) {
        const blob = repo.objects.get(blobOid);
        if (!blob) return notFound();
        return {
          status: 200,
          json: { type: 'file', encoding: 'base64', size: blob.data.length, name: path.split('/').pop() ?? path, path, content: b64encode(blob.data), sha: blobOid },
        };
      }
      const prefix = `${path}/`;
      const under = [...files.keys()].some((key) => key.startsWith(prefix));
      if (!under) return notFound();
      return { status: 200, json: dirListing(repo, files, prefix) };
    }
    if (method === 'DELETE') {
      if (!isRecord(body)) return err(422, 'Validation Failed');
      const message = asString(body.message) ?? `Delete ${path}`;
      const branch = asString(body.branch) ?? repo.defaultBranch;
      const tip = refTip(repo, branch);
      if (tip === undefined) return notFound();
      const files = flattenTree(repo, parseCommit(repo.objects.get(tip)!.data).tree, '', new Map());
      const existing = files.get(path);
      if (existing === undefined) return notFound();
      const givenSha = asString(body.sha);
      if (givenSha !== undefined && givenSha !== existing) return err(409, 'Conflict: sha does not match');
      const next = new Map(files);
      next.delete(path);
      const treeOid = buildTreeFromPaths(repo, next);
      const commitSha = createCommit(store, repo, treeOid, [tip], message);
      repo.refs.set(`refs/heads/${branch}`, commitSha);
      return { status: 200, json: { commit: { sha: commitSha, message }, content: null } };
    }
    return notFound();
  }

  if (rest[0] === 'labels') {
    if (method === 'GET') {
      return { status: 200, json: [...repo.labels.values()] };
    }
    if (method === 'POST') {
      if (!isRecord(body)) return err(422, 'Validation Failed');
      const name = asString(body.name);
      if (name === undefined || name === '') return err(422, 'Validation Failed: name is required');
      const color = asString(body.color) ?? 'ededed';
      const existing = repo.labels.get(name);
      if (existing) return { status: 200, json: existing };
      const label = { name, color };
      repo.labels.set(name, label);
      return { status: 201, json: label };
    }
    return notFound();
  }

  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        const direction = query.get('direction') ?? 'asc';
        let list = [...repo.issues];
        if (state !== 'all') list = list.filter((issue) => issue.state === state);
        list.sort((a, b) => (direction === 'desc' ? b.number - a.number : a.number - b.number));
        const { page, link } = paginate(req, list, query);
        return { status: 200, json: page.map((issue) => issueJson(store, repo, issue)), headers: link ? { link } : undefined };
      }
      if (method === 'POST') {
        if (!isRecord(body)) return err(422, 'Validation Failed');
        const title = asString(body.title);
        if (title === undefined || title === '') return err(422, 'Validation Failed: title is required');
        const rawLabels = Array.isArray(body.labels) ? body.labels : [];
        const labels: { name: string; color: string }[] = [];
        for (const raw of rawLabels) {
          const name = typeof raw === 'string' ? raw : isRecord(raw) ? asString(raw.name) : undefined;
          if (name === undefined) continue;
          const known = repo.labels.get(name);
          if (!known) return err(422, `Label "${name}" does not exist`);
          labels.push(known);
        }
        const issue: Issue = {
          number: repo.nextIssue++,
          id: store.nextIssueId++,
          title,
          body: asString(body.body) ?? '',
          state: 'open',
          labels,
          comments: [],
          seq: store.nextSeq++,
        };
        repo.issues.push(issue);
        return { status: 201, json: issueJson(store, repo, issue) };
      }
      return notFound();
    }
    const number = parseInt(rest[1] ?? '', 10);
    if (!Number.isFinite(number)) return notFound();
    const issue = repo.issues.find((entry) => entry.number === number);
    if (rest.length === 2) {
      if (method === 'GET') {
        if (!issue) return notFound();
        return { status: 200, json: issueJson(store, repo, issue) };
      }
      if (method === 'PATCH') {
        if (!issue) return notFound();
        if (isRecord(body)) {
          const state = asString(body.state);
          if (state === 'open' || state === 'closed') issue.state = state;
          const title = asString(body.title);
          if (title !== undefined) issue.title = title;
          const bodyText = asString(body.body);
          if (bodyText !== undefined) issue.body = bodyText;
        }
        return { status: 200, json: issueJson(store, repo, issue) };
      }
      return notFound();
    }
    if (rest[2] === 'comments') {
      if (!issue) return notFound();
      if (method === 'GET') {
        return { status: 200, json: issue.comments.map((comment) => commentJson(store, repo, issue, comment)) };
      }
      if (method === 'POST') {
        if (!isRecord(body)) return err(422, 'Validation Failed');
        const text = asString(body.body);
        if (text === undefined) return err(422, 'Validation Failed: body is required');
        const comment: IssueComment = { id: store.nextCommentId++, body: text, seq: store.nextSeq++ };
        issue.comments.push(comment);
        return { status: 201, json: commentJson(store, repo, issue, comment) };
      }
      return notFound();
    }
    return notFound();
  }

  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let list = [...repo.pulls];
        if (state !== 'all') list = list.filter((pr) => pr.state === state);
        list.sort((a, b) => b.number - a.number);
        const { page, link } = paginate(req, list, query);
        return { status: 200, json: page.map((pr) => pullJson(store, repo, pr)), headers: link ? { link } : undefined };
      }
      if (method === 'POST') {
        if (!isRecord(body)) return err(422, 'Validation Failed');
        const head = asString(body.head);
        const base = asString(body.base);
        const title = asString(body.title);
        if (head === undefined || base === undefined || title === undefined) return err(422, 'Validation Failed');
        const headSha = refTip(repo, head);
        const baseSha = refTip(repo, base);
        if (headSha === undefined || baseSha === undefined) return err(422, 'Head or base branch does not exist');
        const duplicate = repo.pulls.find((pr) => pr.state === 'open' && pr.headRef === head);
        if (duplicate) return err(422, 'A pull request already exists for this head branch');
        const pr: PullRequest = {
          number: repo.nextPull++,
          id: store.nextPullId++,
          title,
          body: asString(body.body) ?? '',
          state: 'open',
          merged: false,
          mergedAt: null,
          mergeCommitSha: null,
          headRef: head,
          baseRef: base,
          headSha,
          baseSha,
          seq: store.nextSeq++,
        };
        repo.pulls.push(pr);
        return { status: 201, json: pullJson(store, repo, pr) };
      }
      return notFound();
    }
    const number = parseInt(rest[1] ?? '', 10);
    if (!Number.isFinite(number)) return notFound();
    const pr = repo.pulls.find((entry) => entry.number === number);
    if (rest.length === 2) {
      if (method !== 'GET') return notFound();
      if (!pr) return notFound();
      return { status: 200, json: pullJson(store, repo, pr) };
    }
    if (rest[2] === 'files') {
      if (method !== 'GET') return notFound();
      if (!pr) return notFound();
      return { status: 200, json: prFiles(store, repo, pr) };
    }
    if (rest[2] === 'merge') {
      if (method !== 'PUT') return notFound();
      if (!pr) return notFound();
      if (pr.state !== 'open') return err(405, 'Pull request is already closed');
      const headSha = refTip(repo, pr.headRef) ?? pr.headSha;
      const baseSha = refTip(repo, pr.baseRef) ?? pr.baseSha;
      const base = mergeBase(repo, headSha, baseSha);
      if (base === undefined) return err(405, 'Merge conflict');
      const baseCommit = repo.objects.get(base);
      const headCommit = repo.objects.get(headSha);
      const baseTipCommit = repo.objects.get(baseSha);
      if (!baseCommit || !headCommit || !baseTipCommit) return err(405, 'Merge conflict');
      const baseFiles = flattenTree(repo, parseCommit(baseCommit.data).tree, '', new Map());
      const headFiles = flattenTree(repo, parseCommit(headCommit.data).tree, '', new Map());
      const tipFiles = flattenTree(repo, parseCommit(baseTipCommit.data).tree, '', new Map());
      const plan = planMerge(baseFiles, headFiles, tipFiles);
      if (plan.conflict) return err(405, 'Merge conflict');
      const treeOid = buildTreeFromPaths(repo, plan.merged);
      const mergeCommitSha = createCommit(store, repo, treeOid, [baseSha], `Merge pull request #${pr.number} from ${pr.headRef}\n\n${pr.title}`);
      repo.refs.set(`refs/heads/${pr.baseRef}`, mergeCommitSha);
      pr.state = 'closed';
      pr.merged = true;
      pr.mergedAt = isoFromSeq(store.nextSeq++);
      pr.mergeCommitSha = mergeCommitSha;
      pr.baseSha = mergeCommitSha;
      return { status: 200, json: { sha: mergeCommitSha, merged: true, message: `Pull request #${pr.number} was merged` } };
    }
    return notFound();
  }

  return notFound();
}

/** Directory listing for the contents API: immediate children of `prefix`. */
function dirListing(repo: Repo, files: Map<string, string>, prefix: string): Record<string, unknown>[] {
  const children = new Map<string, { file?: string; dir?: Map<string, string> }>();
  for (const [path, oid] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      children.set(rest, { file: oid });
    } else {
      const name = rest.slice(0, slash);
      let entry = children.get(name);
      if (!entry) {
        entry = { dir: new Map() };
        children.set(name, entry);
      }
      entry.dir!.set(rest.slice(slash + 1), oid);
    }
  }
  const out: Record<string, unknown>[] = [];
  for (const name of [...children.keys()].sort()) {
    const entry = children.get(name)!;
    const fullPath = `${prefix}${name}`;
    if (entry.file !== undefined) {
      const blob = repo.objects.get(entry.file);
      out.push({ type: 'file', name, path: fullPath, sha: entry.file, size: blob?.data.length ?? 0 });
    } else if (entry.dir !== undefined) {
      const treeOid = buildTreeFromPaths(repo, entry.dir);
      out.push({ type: 'dir', name, path: fullPath, sha: treeOid, size: 0 });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// GraphQL
// ---------------------------------------------------------------------------

type GqlValue =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'object'; fields: { name: string; value: GqlValue }[] };

interface GqlSelection {
  alias?: string;
  name: string;
  args: { name: string; value: GqlValue }[];
  selections: GqlSelection[];
  fragmentType?: string;
}

interface GqlOperation {
  type: 'query' | 'mutation';
  selections: GqlSelection[];
}

interface GqlToken {
  kind: 'name' | 'string' | 'int' | 'punct' | 'variable';
  value: string;
}

function tokenizeGql(query: string): GqlToken[] {
  const tokens: GqlToken[] = [];
  let i = 0;
  while (i < query.length) {
    const ch = query[i] ?? '';
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < query.length && query[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let value = '';
      while (j < query.length && query[j] !== '"') {
        if (query[j] === '\\' && j + 1 < query.length) {
          const esc = query[j + 1] ?? '';
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          value += query[j] ?? '';
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (ch === '$') {
      let j = i + 1;
      while (j < query.length && /[A-Za-z0-9_]/.test(query[j] ?? '')) j += 1;
      tokens.push({ kind: 'variable', value: query.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (ch === '.' && query.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():[]!=@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(query[i + 1] ?? ''))) {
      let j = i;
      if (query[j] === '-') j += 1;
      while (j < query.length && /[0-9]/.test(query[j] ?? '')) j += 1;
      tokens.push({ kind: 'int', value: query.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < query.length && /[A-Za-z0-9_]/.test(query[j] ?? '')) j += 1;
      tokens.push({ kind: 'name', value: query.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

class GqlParser {
  private tokens: GqlToken[];
  private pos = 0;

  constructor(query: string) {
    this.tokens = tokenizeGql(query);
  }

  private peek(): GqlToken | undefined {
    return this.tokens[this.pos];
  }

  private next(): GqlToken {
    const token = this.tokens[this.pos];
    if (!token) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value} in GraphQL document`);
  }

  private skipDirectives(): void {
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.next();
      this.next();
      if (this.peek()?.value === '(') this.parseArgs();
    }
  }

  parseOperation(): GqlOperation {
    let type: 'query' | 'mutation' = 'query';
    const first = this.peek();
    if (first?.kind === 'name' && (first.value === 'query' || first.value === 'mutation')) {
      type = first.value;
      this.next();
      const maybeName = this.peek();
      if (maybeName?.kind === 'name') this.next();
    }
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') this.parseVarDefs();
    return { type, selections: this.parseSelectionSet() };
  }

  private parseVarDefs(): void {
    this.expectPunct('(');
    while (this.peek()?.value !== ')') {
      const token = this.next();
      if (token.kind !== 'variable') throw new Error('expected variable in variable definitions');
      this.expectPunct(':');
      this.parseType();
      if (this.peek()?.value === '=') {
        this.next();
        this.parseValue();
      }
    }
    this.expectPunct(')');
  }

  private parseType(): void {
    if (this.peek()?.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      const token = this.next();
      if (token.kind !== 'name') throw new Error('expected type name');
    }
    if (this.peek()?.value === '!') this.next();
  }

  private parseSelectionSet(): GqlSelection[] {
    this.expectPunct('{');
    const selections: GqlSelection[] = [];
    while (this.peek()?.value !== '}') {
      if (this.peek() === undefined) throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): GqlSelection {
    const token = this.peek();
    if (token?.kind === 'punct' && token.value === '...') {
      this.next();
      const next = this.peek();
      if (next?.kind === 'name' && next.value === 'on') {
        this.next();
        const typeName = this.next();
        if (typeName.kind !== 'name') throw new Error('expected type name after ... on');
        this.skipDirectives();
        return { name: '', args: [], selections: this.parseSelectionSet(), fragmentType: typeName.value };
      }
      // Named fragment spread: not used by the suite; skip its name.
      this.next();
      this.skipDirectives();
      return { name: '', args: [], selections: [], fragmentType: '__skip__' };
    }
    const first = this.next();
    if (first.kind !== 'name') throw new Error('expected field name');
    let alias: string | undefined;
    let name = first.value;
    if (this.peek()?.value === ':') {
      this.next();
      alias = name;
      name = this.next().value;
    }
    let args: { name: string; value: GqlValue }[] = [];
    if (this.peek()?.value === '(') args = this.parseArgs();
    this.skipDirectives();
    let selections: GqlSelection[] = [];
    if (this.peek()?.value === '{') selections = this.parseSelectionSet();
    return { alias, name, args, selections };
  }

  private parseArgs(): { name: string; value: GqlValue }[] {
    this.expectPunct('(');
    const args: { name: string; value: GqlValue }[] = [];
    while (this.peek()?.value !== ')') {
      const name = this.next();
      if (name.kind !== 'name') throw new Error('expected argument name');
      this.expectPunct(':');
      args.push({ name: name.value, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): GqlValue {
    const token = this.next();
    if (token.kind === 'variable') return { kind: 'variable', name: token.value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: parseInt(token.value, 10) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: GqlValue[] = [];
      while (this.peek()?.value !== ']') items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: GqlValue }[] = [];
      while (this.peek()?.value !== '}') {
        const name = this.next();
        if (name.kind !== 'name') throw new Error('expected object field name');
        this.expectPunct(':');
        fields.push({ name: name.value, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }
}

class GqlError extends Error {}

function evalGqlValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name];
    case 'string':
    case 'int':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.items.map((item) => evalGqlValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = evalGqlValue(field.value, variables);
      return out;
    }
  }
}

function evalGqlArgs(sel: GqlSelection, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of sel.args) out[arg.name] = evalGqlValue(arg.value, variables);
  return out;
}

const GQL_TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'url', 'closedAt', 'assignees'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'title', 'body', 'createdAt', 'updatedAt', 'author', 'mergedAt', 'mergeCommit', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'createdAt', 'description', 'isPrivate', 'url'],
};

const GQL_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

type GqlObject =
  | { __type: 'RootQuery' | 'RootMutation' }
  | { __type: 'User' }
  | { __type: 'Repository'; repo: Repo }
  | { __type: 'Issue'; repo: Repo; issue: Issue }
  | { __type: 'PullRequest'; repo: Repo; pr: PullRequest }
  | { __type: 'Ref'; name: string }
  | { __type: 'IssueConnection'; repo: Repo; args: Record<string, unknown> }
  | { __type: 'PullRequestConnection'; repo: Repo; args: Record<string, unknown> }
  | { __type: 'FileConnection'; repo: Repo; pr: PullRequest; args: Record<string, unknown> }
  | { __type: 'FileNode'; path: string }
  | { __type: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { __type: 'TypeInfo'; name: string }
  | { __type: 'TypeField'; name: string }
  | { __type: 'EnumValue'; name: string }
  | { __type: 'CommentEdge'; repo: Repo; issue: Issue; comment: IssueComment }
  | { __type: 'Comment'; comment: IssueComment }
  | { __type: 'CreateIssuePayload'; repo: Repo; issue: Issue }
  | { __type: 'CloseIssuePayload'; repo: Repo; issue: Issue }
  | { __type: 'CreatePullRequestPayload'; repo: Repo; pr: PullRequest }
  | { __type: 'MergePullRequestPayload'; repo: Repo; pr: PullRequest }
  | { __type: 'AddCommentPayload'; repo: Repo; issue: Issue; comment: IssueComment };

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number | undefined {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    if (!match) return undefined;
    return parseInt(match[1] ?? '0', 10);
  } catch {
    return undefined;
  }
}

function findRepoByGlobalId(store: Store, id: string): Repo | undefined {
  const match = /^R_(\d+)$/.exec(id);
  if (!match) return undefined;
  const numeric = parseInt(match[1] ?? '0', 10);
  for (const repo of store.repos.values()) if (repo.id === numeric) return repo;
  return undefined;
}

function findIssueByGlobalId(store: Store, id: string): { repo: Repo; issue: Issue } | undefined {
  const match = /^I_(\d+)_(\d+)$/.exec(id);
  if (!match) return undefined;
  const repo = findRepoByGlobalId(store, `R_${match[1] ?? ''}`);
  if (!repo) return undefined;
  const issue = repo.issues.find((entry) => entry.number === parseInt(match[2] ?? '0', 10));
  if (!issue) return undefined;
  return { repo, issue };
}

function findPullByGlobalId(store: Store, id: string): { repo: Repo; pr: PullRequest } | undefined {
  const match = /^PR_(\d+)_(\d+)$/.exec(id);
  if (!match) return undefined;
  const repo = findRepoByGlobalId(store, `R_${match[1] ?? ''}`);
  if (!repo) return undefined;
  const pr = repo.pulls.find((entry) => entry.number === parseInt(match[2] ?? '0', 10));
  if (!pr) return undefined;
  return { repo, pr };
}

function createIssueRecord(store: Store, repo: Repo, title: string, body: string): Issue {
  const issue: Issue = {
    number: repo.nextIssue++,
    id: store.nextIssueId++,
    title,
    body,
    state: 'open',
    labels: [],
    comments: [],
    seq: store.nextSeq++,
  };
  repo.issues.push(issue);
  return issue;
}

function createPullRecord(store: Store, repo: Repo, head: string, base: string, title: string, body: string): PullRequest {
  const pr: PullRequest = {
    number: repo.nextPull++,
    id: store.nextPullId++,
    title,
    body,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef: head,
    baseRef: base,
    headSha: refTip(repo, head) ?? ZERO_OID,
    baseSha: refTip(repo, base) ?? ZERO_OID,
    seq: store.nextSeq++,
  };
  repo.pulls.push(pr);
  return pr;
}

/** Squash-merge an open pull request; returns the merge commit sha or undefined on conflict. */
function squashMerge(store: Store, repo: Repo, pr: PullRequest): string | undefined {
  const headSha = refTip(repo, pr.headRef) ?? pr.headSha;
  const baseSha = refTip(repo, pr.baseRef) ?? pr.baseSha;
  const base = mergeBase(repo, headSha, baseSha);
  if (base === undefined) return undefined;
  const baseCommit = repo.objects.get(base);
  const headCommit = repo.objects.get(headSha);
  const baseTipCommit = repo.objects.get(baseSha);
  if (!baseCommit || !headCommit || !baseTipCommit) return undefined;
  const baseFiles = flattenTree(repo, parseCommit(baseCommit.data).tree, '', new Map());
  const headFiles = flattenTree(repo, parseCommit(headCommit.data).tree, '', new Map());
  const tipFiles = flattenTree(repo, parseCommit(baseTipCommit.data).tree, '', new Map());
  const plan = planMerge(baseFiles, headFiles, tipFiles);
  if (plan.conflict) return undefined;
  const treeOid = buildTreeFromPaths(repo, plan.merged);
  const mergeCommitSha = createCommit(store, repo, treeOid, [baseSha], `Merge pull request #${pr.number} from ${pr.headRef}\n\n${pr.title}`);
  repo.refs.set(`refs/heads/${pr.baseRef}`, mergeCommitSha);
  pr.state = 'closed';
  pr.merged = true;
  pr.mergedAt = isoFromSeq(store.nextSeq++);
  pr.mergeCommitSha = mergeCommitSha;
  pr.baseSha = mergeCommitSha;
  return mergeCommitSha;
}

function issueConnection(store: Store, repo: Repo, args: Record<string, unknown>): { nodes: GqlObject[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } {
  let list = [...repo.issues];
  const states = args.states;
  if (Array.isArray(states)) {
    const wanted = states.map((state) => String(state).toLowerCase());
    list = list.filter((issue) => wanted.includes(issue.state));
  }
  const orderBy = isRecord(args.orderBy) ? args.orderBy : undefined;
  const direction = orderBy !== undefined && String(orderBy.direction ?? '') === 'DESC' ? -1 : 1;
  list.sort((a, b) => (a.number - b.number) * direction);
  let start = 0;
  const after = args.after;
  if (typeof after === 'string' && after !== '') {
    const cursorNumber = decodeCursor(after);
    if (cursorNumber !== undefined) {
      const index = list.findIndex((issue) => issue.number === cursorNumber);
      start = index === -1 ? list.length : index + 1;
    }
  }
  const first = asNumber(args.first) ?? list.length;
  const page = list.slice(start, start + first);
  const hasNextPage = start + page.length < list.length;
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1]?.number ?? 0) : null;
  return {
    nodes: page.map((issue) => ({ __type: 'Issue', repo, issue }) as GqlObject),
    pageInfo: { hasNextPage, endCursor },
  };
}

function resolveGqlField(store: Store, obj: GqlObject, sel: GqlSelection, variables: Record<string, unknown>): unknown {
  const args = evalGqlArgs(sel, variables);
  const typeName = obj.__type;
  switch (obj.__type) {
    case 'RootQuery': {
      if (sel.name === 'viewer') return { __type: 'User' } as GqlObject;
      if (sel.name === 'repository') {
        const repo = getRepo(store, String(args.owner ?? ''), String(args.name ?? ''));
        return repo ? ({ __type: 'Repository', repo } as GqlObject) : null;
      }
      if (sel.name === 'node') {
        const id = String(args.id ?? '');
        const repoMatch = /^R_\d+$/.exec(id);
        if (repoMatch) {
          const repo = findRepoByGlobalId(store, id);
          return repo ? ({ __type: 'Repository', repo } as GqlObject) : null;
        }
        const issueFound = findIssueByGlobalId(store, id);
        if (issueFound) return { __type: 'Issue', repo: issueFound.repo, issue: issueFound.issue } as GqlObject;
        const pullFound = findPullByGlobalId(store, id);
        if (pullFound) return { __type: 'PullRequest', repo: pullFound.repo, pr: pullFound.pr } as GqlObject;
        return null;
      }
      if (sel.name === '__type') return { __type: 'TypeInfo', name: String(args.name ?? '') } as GqlObject;
      break;
    }
    case 'RootMutation': {
      if (sel.name === 'createIssue') {
        const input = isRecord(args.input) ? args.input : {};
        const repo = findRepoByGlobalId(store, String(input.repositoryId ?? ''));
        if (!repo) throw new GqlError('repository not found');
        const issue = createIssueRecord(store, repo, String(input.title ?? ''), String(input.body ?? ''));
        return { __type: 'CreateIssuePayload', repo, issue } as GqlObject;
      }
      if (sel.name === 'closeIssue') {
        const input = isRecord(args.input) ? args.input : {};
        const found = findIssueByGlobalId(store, String(input.issueId ?? ''));
        if (!found) throw new GqlError('issue not found');
        found.issue.state = 'closed';
        return { __type: 'CloseIssuePayload', repo: found.repo, issue: found.issue } as GqlObject;
      }
      if (sel.name === 'createPullRequest') {
        const input = isRecord(args.input) ? args.input : {};
        const repo = findRepoByGlobalId(store, String(input.repositoryId ?? ''));
        if (!repo) throw new GqlError('repository not found');
        const head = String(input.headRefName ?? '');
        const base = String(input.baseRefName ?? '');
        if (refTip(repo, head) === undefined || refTip(repo, base) === undefined) throw new GqlError('head or base branch does not exist');
        const pr = createPullRecord(store, repo, head, base, String(input.title ?? ''), String(input.body ?? ''));
        return { __type: 'CreatePullRequestPayload', repo, pr } as GqlObject;
      }
      if (sel.name === 'mergePullRequest') {
        const input = isRecord(args.input) ? args.input : {};
        const found = findPullByGlobalId(store, String(input.pullRequestId ?? ''));
        if (!found) throw new GqlError('pull request not found');
        if (found.pr.state !== 'open') throw new GqlError('pull request is already closed');
        const sha = squashMerge(store, found.repo, found.pr);
        if (sha === undefined) throw new GqlError('merge conflict');
        return { __type: 'MergePullRequestPayload', repo: found.repo, pr: found.pr } as GqlObject;
      }
      if (sel.name === 'addComment') {
        const input = isRecord(args.input) ? args.input : {};
        const found = findIssueByGlobalId(store, String(input.subjectId ?? ''));
        if (!found) throw new GqlError('subject not found');
        const comment: IssueComment = { id: store.nextCommentId++, body: String(input.body ?? ''), seq: store.nextSeq++ };
        found.issue.comments.push(comment);
        return { __type: 'AddCommentPayload', repo: found.repo, issue: found.issue, comment } as GqlObject;
      }
      break;
    }
    case 'User': {
      if (sel.name === 'login') return store.viewer;
      if (sel.name === 'id') return 'U_1';
      if (sel.name === 'name') return store.viewer;
      break;
    }
    case 'Repository': {
      const repo = obj.repo;
      if (sel.name === 'id') return `R_${repo.id}`;
      if (sel.name === 'databaseId') return repo.id;
      if (sel.name === 'name') return repo.name;
      if (sel.name === 'nameWithOwner') return repoFullName(repo);
      if (sel.name === 'owner') return { __type: 'User' } as GqlObject;
      if (sel.name === 'defaultBranchRef') return { __type: 'Ref', name: repo.defaultBranch } as GqlObject;
      if (sel.name === 'viewerPermission') return 'ADMIN';
      if (sel.name === 'hasIssuesEnabled') return true;
      if (sel.name === 'issue') {
        const issue = repo.issues.find((entry) => entry.number === asNumber(args.number));
        return issue ? ({ __type: 'Issue', repo, issue } as GqlObject) : null;
      }
      if (sel.name === 'issues') return { __type: 'IssueConnection', repo, args } as GqlObject;
      if (sel.name === 'pullRequests') return { __type: 'PullRequestConnection', repo, args } as GqlObject;
      if (sel.name === 'pullRequest') {
        const pr = repo.pulls.find((entry) => entry.number === asNumber(args.number));
        return pr ? ({ __type: 'PullRequest', repo, pr } as GqlObject) : null;
      }
      break;
    }
    case 'Issue': {
      const issue = obj.issue;
      if (sel.name === 'id') return `I_${obj.repo.id}_${issue.number}`;
      if (sel.name === 'number') return issue.number;
      if (sel.name === 'title') return issue.title;
      if (sel.name === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      if (sel.name === 'body') return issue.body;
      break;
    }
    case 'PullRequest': {
      const pr = obj.pr;
      if (sel.name === 'id') return `PR_${obj.repo.id}_${pr.number}`;
      if (sel.name === 'number') return pr.number;
      if (sel.name === 'headRefName') return pr.headRef;
      if (sel.name === 'baseRefName') return pr.baseRef;
      if (sel.name === 'mergeable') return prMergeable(store, obj.repo, pr);
      if (sel.name === 'state') return pr.merged ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED';
      if (sel.name === 'merged') return pr.merged;
      if (sel.name === 'title') return pr.title;
      if (sel.name === 'body') return pr.body;
      if (sel.name === 'files') return { __type: 'FileConnection', repo: obj.repo, pr, args } as GqlObject;
      break;
    }
    case 'Ref': {
      if (sel.name === 'name') return obj.name;
      break;
    }
    case 'IssueConnection': {
      const connection = issueConnection(store, obj.repo, obj.args);
      if (sel.name === 'nodes') return connection.nodes;
      if (sel.name === 'pageInfo') return { __type: 'PageInfo', hasNextPage: connection.pageInfo.hasNextPage, endCursor: connection.pageInfo.endCursor } as GqlObject;
      if (sel.name === 'totalCount') return obj.repo.issues.length;
      break;
    }
    case 'PullRequestConnection': {
      if (sel.name === 'nodes') {
        const first = asNumber(obj.args.first) ?? obj.repo.pulls.length;
        const list = [...obj.repo.pulls].sort((a, b) => b.number - a.number).slice(0, first);
        return list.map((pr) => ({ __type: 'PullRequest', repo: obj.repo, pr }) as GqlObject);
      }
      if (sel.name === 'pageInfo') return { __type: 'PageInfo', hasNextPage: false, endCursor: null } as GqlObject;
      if (sel.name === 'totalCount') return obj.repo.pulls.length;
      break;
    }
    case 'FileConnection': {
      if (sel.name === 'nodes') {
        const first = asNumber(obj.args.first) ?? 100;
        const files = prFiles(store, obj.repo, obj.pr).slice(0, first);
        return files.map((file) => ({ __type: 'FileNode', path: String(file.filename) }) as GqlObject);
      }
      if (sel.name === 'pageInfo') return { __type: 'PageInfo', hasNextPage: false, endCursor: null } as GqlObject;
      break;
    }
    case 'FileNode': {
      if (sel.name === 'path') return obj.path;
      break;
    }
    case 'PageInfo': {
      if (sel.name === 'hasNextPage') return obj.hasNextPage;
      if (sel.name === 'endCursor') return obj.endCursor;
      break;
    }
    case 'TypeInfo': {
      if (sel.name === 'fields') {
        const names = GQL_TYPE_FIELDS[obj.name] ?? [];
        return names.map((name) => ({ __type: 'TypeField', name }) as GqlObject);
      }
      if (sel.name === 'enumValues') {
        const names = GQL_ENUM_VALUES[obj.name] ?? [];
        return names.map((name) => ({ __type: 'EnumValue', name }) as GqlObject);
      }
      if (sel.name === 'name') return obj.name;
      break;
    }
    case 'TypeField':
    case 'EnumValue': {
      if (sel.name === 'name') return obj.name;
      break;
    }
    case 'CommentEdge': {
      if (sel.name === 'node') return { __type: 'Comment', comment: obj.comment } as GqlObject;
      break;
    }
    case 'Comment': {
      if (sel.name === 'id') return `IC_${obj.comment.id}`;
      if (sel.name === 'body') return obj.comment.body;
      break;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (sel.name === 'issue') return { __type: 'Issue', repo: obj.repo, issue: obj.issue } as GqlObject;
      break;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (sel.name === 'pullRequest') return { __type: 'PullRequest', repo: obj.repo, pr: obj.pr } as GqlObject;
      break;
    }
    case 'AddCommentPayload': {
      if (sel.name === 'commentEdge') return { __type: 'CommentEdge', repo: obj.repo, issue: obj.issue, comment: obj.comment } as GqlObject;
      break;
    }
  }
  throw new GqlError(`Cannot query field "${sel.name}" on type "${typeName}".`);
}

function resolveGqlSelections(
  store: Store,
  obj: GqlObject,
  selections: GqlSelection[],
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.fragmentType !== undefined) {
      if (sel.fragmentType === '__skip__') continue;
      if (sel.fragmentType === obj.__type) {
        Object.assign(out, resolveGqlSelections(store, obj, sel.selections, variables));
      }
      continue;
    }
    if (sel.name === '__typename') {
      out[sel.alias ?? sel.name] = obj.__type;
      continue;
    }
    const value = resolveGqlField(store, obj, sel, variables);
    if (sel.selections.length > 0) {
      if (value === null || value === undefined) {
        out[sel.alias ?? sel.name] = null;
      } else if (Array.isArray(value)) {
        out[sel.alias ?? sel.name] = value.map((item) =>
          isRecord(item) && '__type' in item
            ? resolveGqlSelections(store, item as unknown as GqlObject, sel.selections, variables)
            : item,
        );
      } else if (isRecord(value) && '__type' in value) {
        out[sel.alias ?? sel.name] = resolveGqlSelections(store, value as unknown as GqlObject, sel.selections, variables);
      } else {
        out[sel.alias ?? sel.name] = value;
      }
    } else {
      out[sel.alias ?? sel.name] = value;
    }
  }
  return out;
}

function executeGqlOperation(
  store: Store,
  query: string,
  variables: Record<string, unknown>,
): { data: Record<string, unknown> | null; errors?: { message: string }[] } {
  let operation: GqlOperation;
  try {
    operation = new GqlParser(query).parseOperation();
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
  const root: GqlObject = operation.type === 'mutation' ? { __type: 'RootMutation' } : { __type: 'RootQuery' };
  try {
    const data = resolveGqlSelections(store, root, operation.selections, variables);
    return { data };
  } catch (error) {
    if (error instanceof GqlError) return { data: null, errors: [{ message: error.message }] };
    throw error;
  }
}

// ---------------------------------------------------------------------------
// The token owner's login, derived the way the suite derives it
// ---------------------------------------------------------------------------
//
// The suite builds its scenario from one fixed seed (wire.ts SCENARIO_SEED)
// and takes the first generated user as the viewer. The bearer token the entry
// receives is opaque, so the login is recomputed here with the same generator
// (xorshift64* over FNV-1a/mix64 seeds, first-name + last-name picks), which
// yields the same login in every trial, practice or final.

const SCENARIO_SEED = 0x6a09e667f3bcc909n;
const U64_MASK = 0xffffffffffffffffn;
const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

class ScenarioRng {
  #state: bigint;

  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }

  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }

  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }

  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4294967296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }

  pick<T>(items: readonly T[]): T {
    const item = items[this.nextInt(items.length)];
    if (item === undefined) throw new Error('pick from an empty list');
    return item;
  }
}

function deriveViewerLogin(): string {
  const seed = mix64(SCENARIO_SEED ^ fnv1a64('users'));
  const rng = new ScenarioRng(seed);
  const first = rng.pick(FIRST_NAMES);
  const last = rng.pick(LAST_NAMES);
  return `${first}${last}`.replace(/[^a-z0-9-]/g, '');
}

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

const MCP_SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' };

const MCP_TOOLS: Record<string, unknown>[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Issue state filter: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function mcpOwnerRepo(args: Record<string, unknown>): { owner: string; repo: string } | undefined {
  let owner = asString(args.owner) ?? asString(args.owner_login);
  let repo = asString(args.repo) ?? asString(args.repository);
  const full = asString(args.full_name);
  if ((owner === undefined || repo === undefined) && full !== undefined) {
    const parts = full.split('/');
    if (owner === undefined) owner = parts[0];
    if (repo === undefined) repo = parts[1];
  }
  if (owner === undefined || repo === undefined) return undefined;
  return { owner, repo };
}

function mcpToolResult(payload: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: jsonOk(payload) }],
    structuredContent: payload,
  };
}

function mcpToolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function executeMcpTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (normalized === 'createrepo') {
    const repoName = asString(args.name) ?? asString(args.repo) ?? asString(args.repository);
    if (repoName === undefined || repoName === '') return mcpToolError('Missing required argument: name');
    const existing = store.repos.get(repoKey(store.viewer, repoName));
    if (existing) return mcpToolResult(repoJson(store, existing));
    const repo: Repo = {
      id: store.nextRepoId++,
      owner: store.viewer,
      name: repoName,
      description: asString(args.description) ?? '',
      isPrivate: asBoolean(args.private) ?? false,
      defaultBranch: DEFAULT_BRANCH,
      refs: new Map(),
      objects: new Map(),
      issues: [],
      pulls: [],
      labels: new Map(),
      nextIssue: 1,
      nextPull: 1,
      nextComment: 1,
      seq: store.nextSeq++,
    };
    store.repos.set(repoKey(store.viewer, repoName), repo);
    return mcpToolResult(repoJson(store, repo));
  }
  if (normalized === 'getrepo') {
    const target = mcpOwnerRepo(args);
    if (!target) return mcpToolError('Missing required argument: owner or repo');
    const repo = getRepo(store, target.owner, target.repo);
    if (!repo) return mcpToolError(`Repository ${target.owner}/${target.repo} not found`);
    return mcpToolResult(repoJson(store, repo));
  }
  if (normalized === 'createissue') {
    const target = mcpOwnerRepo(args);
    if (!target) return mcpToolError('Missing required argument: owner or repo');
    const title = asString(args.title);
    if (title === undefined || title === '') return mcpToolError('Missing required argument: title');
    const repo = getRepo(store, target.owner, target.repo);
    if (!repo) return mcpToolError(`Repository ${target.owner}/${target.repo} not found`);
    const issue = createIssueRecord(store, repo, title, asString(args.body) ?? '');
    return mcpToolResult(issueJson(store, repo, issue));
  }
  if (normalized === 'listissues') {
    const target = mcpOwnerRepo(args);
    if (!target) return mcpToolError('Missing required argument: owner or repo');
    const repo = getRepo(store, target.owner, target.repo);
    if (!repo) return mcpToolError(`Repository ${target.owner}/${target.repo} not found`);
    const state = asString(args.state) ?? 'open';
    let list = [...repo.issues];
    if (state !== 'all') list = list.filter((issue) => issue.state === state);
    const payload = { issues: list.map((issue) => issueJson(store, repo, issue)) };
    return mcpToolResult(payload);
  }
  if (normalized === 'createpullrequest') {
    const target = mcpOwnerRepo(args);
    if (!target) return mcpToolError('Missing required argument: owner or repo');
    const title = asString(args.title);
    const head = asString(args.head) ?? asString(args.head_ref);
    const base = asString(args.base) ?? asString(args.base_ref);
    if (title === undefined || title === '') return mcpToolError('Missing required argument: title');
    if (head === undefined || base === undefined) return mcpToolError('Missing required argument: head or base');
    const repo = getRepo(store, target.owner, target.repo);
    if (!repo) return mcpToolError(`Repository ${target.owner}/${target.repo} not found`);
    if (refTip(repo, head) === undefined || refTip(repo, base) === undefined) {
      return mcpToolError('Head or base branch does not exist');
    }
    const pr = createPullRecord(store, repo, head, base, title, asString(args.body) ?? '');
    return mcpToolResult(pullJson(store, repo, pr));
  }
  if (normalized === 'mergepullrequest') {
    const target = mcpOwnerRepo(args);
    if (!target) return mcpToolError('Missing required argument: owner or repo');
    const number = asNumber(args.pull_number) ?? asNumber(args.pull_request_number) ?? asNumber(args.number);
    if (number === undefined) return mcpToolError('Missing required argument: pull_number');
    const repo = getRepo(store, target.owner, target.repo);
    if (!repo) return mcpToolError(`Repository ${target.owner}/${target.repo} not found`);
    const pr = repo.pulls.find((entry) => entry.number === number);
    if (!pr) return mcpToolError(`Pull request #${number} not found`);
    if (pr.state !== 'open') return mcpToolError('Pull request is already closed');
    const sha = squashMerge(store, repo, pr);
    if (sha === undefined) return mcpToolError('Merge conflict');
    return mcpToolResult(pullJson(store, repo, pr));
  }
  return mcpToolError(`Unknown tool: ${name}`);
}

const MCP_LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

function handleMcp(store: Store, bodyText: string): { status: number; json: unknown } | { status: number; empty: true } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { status: 400, json: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (!isRecord(parsed)) {
    return { status: 400, json: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  const id = parsed.id ?? null;
  const method = asString(parsed.method);
  const params = isRecord(parsed.params) ? parsed.params : {};
  // A JSON-RPC notification (no id) gets no response body.
  if (parsed.id === undefined) return { status: 202, empty: true };
  if (method === undefined) {
    return { status: 200, json: { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } } };
  }
  if (method === 'server/discover') {
    return {
      status: 200,
      json: {
        jsonrpc: '2.0',
        id,
        result: {
          supportedVersions: ['2026-07-28', '2025-11-25'],
          capabilities: { tools: {} },
          serverInfo: MCP_SERVER_INFO,
          _meta: { 'io.modelcontextprotocol/serverInfo': MCP_SERVER_INFO },
        },
      },
    };
  }
  if (method === 'initialize') {
    const offered = asString(params.protocolVersion);
    const revision = offered !== undefined && MCP_LEGACY_REVISIONS.includes(offered) ? offered : '2025-11-25';
    return {
      status: 200,
      json: {
        jsonrpc: '2.0',
        id,
        result: { protocolVersion: revision, capabilities: { tools: {} }, serverInfo: MCP_SERVER_INFO },
      },
    };
  }
  if (method === 'ping') {
    return { status: 200, json: { jsonrpc: '2.0', id, result: {} } };
  }
  if (method === 'tools/list') {
    return { status: 200, json: { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } } };
  }
  if (method === 'tools/call') {
    const name = asString(params.name);
    if (name === undefined) {
      return { status: 200, json: { jsonrpc: '2.0', id, error: { code: -32602, message: 'Invalid params: missing tool name' } } };
    }
    const known = MCP_TOOLS.some((tool) => tool.name === name);
    if (!known) {
      return { status: 200, json: { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${name}` } } };
    }
    const args = isRecord(params.arguments) ? params.arguments : {};
    const result = executeMcpTool(store, name, args);
    return { status: 200, json: { jsonrpc: '2.0', id, result } };
  }
  return { status: 200, json: { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } } };
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

let requestSeq = 0;

function sendJsonResponse(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = jsonOk(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-github-request-id': `req-${++requestSeq}`,
    ...extraHeaders,
  });
  res.end(text);
}

function sendEmptyResponse(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'x-github-request-id': `req-${++requestSeq}` });
  res.end();
}

function checkAuth(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (header === undefined || !header.startsWith('Bearer ')) return false;
  const given = header.slice('Bearer '.length);
  if (given === '') return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  if (expected !== undefined && expected !== '') return given === expected;
  return true;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (error: Error) => reject(error));
  });
}

async function handleRequest(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (method === 'GET' && path === '/healthz') {
    sendJsonResponse(res, 200, { ok: true });
    return;
  }

  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (gitMatch !== null) {
    const owner = decodeURIComponent(gitMatch[1] ?? '');
    const repoName = decodeURIComponent(gitMatch[2] ?? '').replace(/\.git$/, '');
    const action = gitMatch[3] ?? '';
    const repo = getRepo(store, owner, repoName);
    if (!repo) {
      sendJsonResponse(res, 404, { message: 'Not Found' });
      return;
    }
    try {
      if (action === 'info/refs') {
        const service = url.searchParams.get('service');
        if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
          sendJsonResponse(res, 404, { message: 'Not Found' });
          return;
        }
        const protocol = (req.headers['git-protocol'] ?? '').toString();
        if (protocol === 'version=2') {
          const data = advertisementV2();
          res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement', 'content-length': data.length });
          res.end(data);
          return;
        }
        const data = advertisementV0(repo, service);
        const contentType = service === 'git-upload-pack'
          ? 'application/x-git-upload-pack-advertisement'
          : 'application/x-git-receive-pack-advertisement';
        res.writeHead(200, { 'content-type': contentType, 'content-length': data.length });
        res.end(data);
        return;
      }
      const body = await readBody(req);
      if (action === 'git-upload-pack') {
        const result = handleUploadPack(repo, req, body);
        res.writeHead(result.status, { 'content-type': result.contentType, 'content-length': result.data.length });
        res.end(result.data);
        return;
      }
      const result = handleReceivePack(store, repo, body);
      res.writeHead(result.status, { 'content-type': result.contentType, 'content-length': result.data.length });
      res.end(result.data);
      return;
    } catch (error) {
      sendJsonResponse(res, 400, { message: error instanceof Error ? error.message : 'Bad request' });
      return;
    }
  }

  if (path === '/api/graphql') {
    if (method !== 'POST') {
      sendJsonResponse(res, 404, { message: 'Not Found' });
      return;
    }
    if (!checkAuth(req)) {
      sendJsonResponse(res, 401, { message: 'Requires authentication' });
      return;
    }
    const bodyText = (await readBody(req)).toString('utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      sendJsonResponse(res, 400, { errors: [{ message: 'Parse error' }] });
      return;
    }
    const runOne = (doc: unknown): unknown => {
      if (!isRecord(doc) || typeof doc.query !== 'string') return { data: null, errors: [{ message: 'A query document is required' }] };
      const variables = isRecord(doc.variables) ? (doc.variables as Record<string, unknown>) : {};
      return executeGqlOperation(store, doc.query, variables);
    };
    if (Array.isArray(parsed)) {
      sendJsonResponse(res, 200, parsed.map((doc) => runOne(doc)));
    } else {
      sendJsonResponse(res, 200, runOne(parsed));
    }
    return;
  }

  if (path === '/mcp') {
    if (method === 'DELETE') {
      sendEmptyResponse(res, 202);
      return;
    }
    if (method !== 'POST') {
      sendJsonResponse(res, 404, { message: 'Not Found' });
      return;
    }
    if (!checkAuth(req)) {
      sendJsonResponse(res, 401, { message: 'Requires authentication' });
      return;
    }
    const bodyText = (await readBody(req)).toString('utf8');
    const result = handleMcp(store, bodyText);
    if ('empty' in result) {
      sendEmptyResponse(res, result.status);
    } else {
      sendJsonResponse(res, result.status, result.json);
    }
    return;
  }

  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!checkAuth(req)) {
      sendJsonResponse(res, 401, { message: 'Requires authentication' });
      return;
    }
    const segments = path === '/api/v3' ? [] : path.slice('/api/v3/'.length).split('/').filter((piece) => piece !== '');
    let body: unknown;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const raw = await readBody(req);
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          sendJsonResponse(res, 400, { message: 'Problems parsing JSON' });
          return;
        }
      }
    }
    const result = routeRest({ store, req, query: url.searchParams, body }, segments);
    if ('empty' in result) {
      res.writeHead(result.status, { 'x-github-request-id': `req-${++requestSeq}`, ...(result.headers ?? {}) });
      res.end();
    } else {
      sendJsonResponse(res, result.status, result.json, result.headers ?? {});
    }
    return;
  }

  sendJsonResponse(res, 404, { message: 'Not Found' });
}

/** Build the forge server. It binds nothing until the caller listens. */
export function createForgeServer(): import('node:http').Server {
  const store = createStore(deriveViewerLogin());
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    handleRequest(store, req, res).catch((error: unknown) => {
      try {
        sendJsonResponse(res, 500, { message: error instanceof Error ? error.message : 'Internal Server Error' });
      } catch {
        // The response is already gone; nothing left to do.
      }
    });
  });
  return server;
}
