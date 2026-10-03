// test/setup.ts — minimal Node globals + DOM fakes so the pure redact helpers
// run under `node --test` without jsdom.

/** Minimal element fake exposing only the API `redactElementHTML` touches. */
export class FakeElement {
  tagName: string;
  private attrs = new Map<string, string>();
  private children: FakeElement[];

  constructor(tagName: string, attrs: Record<string, string> = {}, children: FakeElement[] = []) {
    this.tagName = tagName;
    for (const [k, v] of Object.entries(attrs)) this.attrs.set(k, v);
    this.children = children;
  }

  get attributes(): { name: string; value: string }[] {
    return Array.from(this.attrs, ([name, value]) => ({ name, value }));
  }

  cloneNode(deep: boolean): FakeElement {
    return new FakeElement(
      this.tagName,
      Object.fromEntries(this.attrs),
      deep ? this.children.map((c) => c.cloneNode(true)) : [],
    );
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }

  // `redactElementHTML` calls `querySelectorAll("*")` once, expecting all
  // descendants (not just direct children), so flatten recursively.
  querySelectorAll(_selector: string): FakeElement[] {
    const out: FakeElement[] = [];
    for (const c of this.children) out.push(c, ...c.querySelectorAll("*"));
    return out;
  }

  get outerHTML(): string {
    const attrs = Array.from(this.attrs, ([k, v]) => ` ${k}="${v}"`).join("");
    const inner = this.children.map((c) => c.outerHTML).join("");
    return `<${this.tagName}${attrs}>${inner}</${this.tagName}>`;
  }
}

// `sanitizeURL` reads `document.baseURI` as the base for relative URLs; provide
// a stable base so absolute-URL scrubbing works in Node (no DOM otherwise).
(globalThis as unknown as { document: { baseURI: string } }).document = {
  baseURI: "http://localhost/",
};
