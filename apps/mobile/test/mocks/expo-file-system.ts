/** In-memory stand-in for expo-file-system's File/Directory API (the subset Sealed uses). */
const files = new Map<string, Uint8Array>();
const dirs = new Set<string>(["file:///document", "file:///cache"]);

function join(base: string, ...names: string[]): string {
  return [base.replace(/\/+$/, ""), ...names.map((n) => n.replace(/^\/+|\/+$/g, ""))].join("/");
}

function parentOf(uri: string): string {
  return uri.slice(0, uri.lastIndexOf("/"));
}

type Parent = Directory | string;
const uriOf = (p: Parent) => (typeof p === "string" ? p : p.uri);

export class Directory {
  readonly uri: string;
  constructor(parent: Parent, ...names: string[]) {
    this.uri = join(uriOf(parent), ...names);
  }
  get exists(): boolean {
    return dirs.has(this.uri);
  }
  create(_opts?: { intermediates?: boolean; idempotent?: boolean }): void {
    let u = this.uri;
    while (u.startsWith("file:///") && !dirs.has(u)) {
      dirs.add(u);
      u = parentOf(u);
    }
  }
  delete(): void {
    for (const k of [...files.keys()]) if (k.startsWith(`${this.uri}/`)) files.delete(k);
    for (const d of [...dirs]) if (d === this.uri || d.startsWith(`${this.uri}/`)) dirs.delete(d);
  }
}

class Handle {
  private offset = 0;
  constructor(private readonly uri: string) {}
  readBytes(n: number): Uint8Array {
    const data = files.get(this.uri) ?? new Uint8Array(0);
    const out = data.slice(this.offset, this.offset + n);
    this.offset += out.length;
    return out;
  }
  writeBytes(b: Uint8Array): void {
    const data = files.get(this.uri) ?? new Uint8Array(0);
    const next = new Uint8Array(Math.max(data.length, this.offset + b.length));
    next.set(data);
    next.set(b, this.offset);
    files.set(this.uri, next);
    this.offset += b.length;
  }
  close(): void {}
}

export class File {
  readonly uri: string;
  constructor(parent: Parent, name?: string) {
    this.uri = name === undefined ? uriOf(parent) : join(uriOf(parent), name);
  }
  get exists(): boolean {
    return files.has(this.uri);
  }
  get size(): number {
    return files.get(this.uri)?.length ?? 0;
  }
  get parentDirectory(): Directory {
    return new Directory(parentOf(this.uri));
  }
  create(): void {
    if (!dirs.has(parentOf(this.uri))) throw new Error(`no directory ${parentOf(this.uri)}`);
    files.set(this.uri, new Uint8Array(0));
  }
  delete(): void {
    files.delete(this.uri);
  }
  open(): Handle {
    if (!files.has(this.uri)) throw new Error(`no file ${this.uri}`);
    return new Handle(this.uri);
  }
  async bytes(): Promise<Uint8Array> {
    return (files.get(this.uri) ?? new Uint8Array(0)).slice();
  }
  write(b: Uint8Array): void {
    files.set(this.uri, b.slice());
  }
  move(target: File): void {
    const data = files.get(this.uri);
    if (!data) throw new Error("move of a missing file");
    files.set(target.uri, data);
    files.delete(this.uri);
  }
}

export const Paths = { document: new Directory("file:///document"), cache: new Directory("file:///cache") };

/** Test helpers. */
export const __fs = {
  files,
  reset(): void {
    files.clear();
    dirs.clear();
    dirs.add("file:///document");
    dirs.add("file:///cache");
  },
};
