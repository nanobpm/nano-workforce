// Test-only doubles for the SUPPLY cockpit core (H5 / #148): an in-memory DOM that satisfies the
// renderer's structural {@link ElementLike} / {@link DocumentLike} types, and a fake relay socket that
// satisfies {@link RawSocket}. They let the supply renderer + boot layer be exercised on Node with no
// DOM library, no real WebSocket, and no `as` cast — the fakes are STRUCTURALLY the same subsets the
// browser's real `Document`/`Element`/`WebSocket` provide (mirrors the packaged cockpit's own fakes).
import { decodeFrame, encodeFrame, type Frame } from "@nanobpm/agentic/protocol";
import type { DocumentLike, ElementLike, RawSocket } from "@nanobpm/agentic/cockpit";

export class FakeElement implements ElementLike {
  className = "";
  textContent: string | null = null;
  readonly tagName: string;
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  readonly #listeners = new Map<string, Array<() => void>>();

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | undefined {
    return this.attributes.get(name);
  }

  appendChild(child: ElementLike): ElementLike {
    if (child instanceof FakeElement) this.children.push(child);
    return child;
  }

  replaceChildren(): void {
    this.children.length = 0;
  }

  addEventListener(type: string, handler: () => void): void {
    const list = this.#listeners.get(type) ?? [];
    list.push(handler);
    this.#listeners.set(type, list);
  }

  /** Fire every listener registered for `type` (test driver for clicks). */
  dispatch(type: string): void {
    for (const handler of this.#listeners.get(type) ?? []) handler();
  }

  /** Depth-first walk of this element and its descendants. */
  *walk(): IterableIterator<FakeElement> {
    yield this;
    for (const child of this.children) yield* child.walk();
  }

  /** Every descendant (and self) whose className contains `cls`. */
  byClass(cls: string): FakeElement[] {
    const out: FakeElement[] = [];
    for (const node of this.walk()) {
      if (node.className.split(/\s+/).includes(cls)) out.push(node);
    }
    return out;
  }

  /** Every descendant (and self) with `data-<key>` equal to `value` (any value if omitted). */
  byData(key: string, value?: string): FakeElement[] {
    const attr = `data-${key}`;
    const out: FakeElement[] = [];
    for (const node of this.walk()) {
      const got = node.attributes.get(attr);
      if (got !== undefined && (value === undefined || got === value)) out.push(node);
    }
    return out;
  }

  /** The concatenated text content of this subtree (own text then children). */
  text(): string {
    let out = this.textContent ?? "";
    for (const child of this.children) out += child.text();
    return out;
  }
}

export class FakeDocument implements DocumentLike {
  createElement(tagName: string): ElementLike {
    return new FakeElement(tagName);
  }
}

/** A fake relay socket: records sent frames and lets a test drive open/close/deliver by hand. */
export class FakeSocket implements RawSocket {
  readonly sent: Uint8Array[] = [];
  closed = false;
  #onMessage: ((bytes: Uint8Array) => void) | undefined;
  #onOpen: (() => void) | undefined;
  #onClose: (() => void) | undefined;

  send(bytes: Uint8Array): void {
    this.sent.push(bytes);
  }

  close(): void {
    this.closed = true;
  }

  onMessage(listener: (bytes: Uint8Array) => void): void {
    this.#onMessage = listener;
  }

  onOpen(listener: () => void): void {
    this.#onOpen = listener;
  }

  onClose(listener: () => void): void {
    this.#onClose = listener;
  }

  /** Fire the open listener (a successful connect). */
  fireOpen(): void {
    this.#onOpen?.();
  }

  /** Fire the close listener (the socket dropped). */
  fireClose(): void {
    this.#onClose?.();
  }

  /** Deliver one inbound frame to the client. */
  deliver(frame: Frame): void {
    this.#onMessage?.(encodeFrame(frame));
  }

  /** The relay-family frames this socket sent, decoded. */
  subscribeFrames(): Frame[] {
    return this.sent.map(decodeFrame).filter((f) => f.family === "relay");
  }
}
