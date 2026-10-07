// Free-form-prose URL-credential redaction (`redactFreeText`) lives in this LOW-LEVEL helper module so
// both the delivery-graph compiler (`deliveryGraphCompiler.ts`, which embeds redacted prompts into the
// generated BPMN display name/documentation) AND `deliveryHuman.ts` (which redacts a decoded live
// prompt / human labels) can import it WITHOUT a cycle. Previously `redactFreeText` was defined in the
// compiler and `deliveryHuman.ts` imported the compiler solely for it — a direct `compiler ⇄ human`
// import cycle that reversed `deliveryHuman.ts`'s documented pure-helper layering and made module init
// depend on ESM cycle ordering (PR #863 review — thread deliveryGraphCompiler.ts / deliveryHuman.ts).
// This module depends only on the character-class strip (`deliveryGraph.ts`) and the canonical URL
// redactors (`readiness.ts`), both strictly lower layers, so nothing here can import back.

import { stripXmlInvalidChars } from "./deliveryGraph.ts";
import { redactEmbeddedCredential, redactString } from "./readiness.ts";

/** Redact credential-bearing pieces of any URL embedded in FREE-FORM prose (a node's authored
 * `prompt`), IN PLACE. Unlike {@link redactString} — tuned for a single opaque target string, where it
 * truncates from the first `?`/`#` to end-of-string — this finds each URL-shaped token *within*
 * surrounding prose (`scheme://…` or a scheme-relative `//…`) and strips only that token's
 * `user:pass@` userinfo and `?query`/`#fragment` via `redactString`, leaving the prose (and ordinary
 * punctuation such as a `?` ending a sentence) intact. Applied to the DISPLAY name/documentation only —
 * a prompt is up to 20 000 chars of arbitrary text that can embed a bearer token or private URL, and
 * the deployed `<bpmn:documentation>`/name is visible to modeler/explorer readers; the RAW prompt still
 * reaches the runtime job input (`appendPrompt`/`prompt`) unmodified (issue #778 review). Deterministic
 * and total. */
export function redactFreeText(value: string): string {
  // Strip XML-invalid display characters BEFORE tokenizing/redacting so every scan runs on the exact
  // string the renderer emits. Otherwise a control char embedded in a URL (`//us\x0Ber:pass@…`) breaks
  // the `//[^\s]+` token match, escapes redaction, then reconstructs the credential once `escapeXml`/
  // `stripXmlInvalidChars` drops the control at render time (issue #778 review — same class as the
  // connector/probe strip-before-classify fix).
  const cleaned = stripXmlInvalidChars(value);
  // Embedded credential userinfo: DERIVE from the ONE canonical redactor {@link redactEmbeddedCredential}
  // (`EMBEDDED_CREDENTIAL_SRC` = `//[^/?#]*@`) rather than a bespoke belt heuristic. Its `[^/?#]` class
  // spans spaces/TABs/newlines up to the LAST `@` before a `/`/`?`/`#`, so EVERY `//<userinfo>@` shape
  // collapses uniformly to `//***@` — a colon-prefix `//user:pass@`, a colon-LESS bearer separated from
  // its `@host` by a word or space (`//token part@host`, `//token @host`), a userinfo split by a raw
  // CR/LF/TAB, and a malformed multi-`@` authority (`//user:pass@ss@host`) — with NO second "what is a
  // credential" implementation that can drift from the canonical redactor/validator (`hasEmbeddedCredential`)
  // (issue #783 review — thread deliveryGraphCompiler.ts:1140; the earlier bespoke colon-less bridge
  // stopped on the first non-whitespace char after the space and leaked `//token part@host`). A `//…@`
  // span is UNAMBIGUOUSLY a credential wherever it sits, so redacting a prose `//word …@host` too is the
  // SAFE direction: the RAW prompt still reaches the runtime job input unmodified — only the operator-
  // visible display doc loses the span. The `[^/?#]` bound also keeps the userinfo from swallowing a `?`
  // marker (`//host?token=secret@tail` has no userinfo — its `@` rides the query), leaving that tail to
  // the query/fragment belt below.
  const credStripped = redactEmbeddedCredential(cleaned);
  // Query/fragment across a whitespace BREAK: the primary `//[^\s]+` token below stops at the break, so a
  // `//host/?\nTOKEN=secret` would leave the value visible in the XML-preserved doc. The linear belt walks
  // each SPACE-bounded `//`-run (crossing an embedded CR/LF/TAB the primary token stopped at) and
  // CONSERVATIVELY redacts its `?query`/`#fragment` tail through the span's space boundary — a continuation
  // past the break is indistinguishable from a split value, so we never keep the far side (issue #778
  // review — thread deliveryGraphCompiler.ts:1115).
  const belted = redactQueryFragmentSpans(credStripped);
  return belted.replace(/(?:[a-z][a-z0-9+.-]*:)?\/\/[^\s]+/gi, (m) => redactString(m));
}

/** Linear (backtracking-free) newline-aware belt companion to {@link redactFreeText}'s primary
 * whitespace-bounded pass. Each `//`-run is bounded by a literal SPACE (0x20) — so a single span may
 * cross a CR/LF/TAB *inside* the URL that the primary `//[^\s]+` token stopped at. Credential userinfo is
 * already collapsed to `//***@` by the canonical {@link redactEmbeddedCredential} before this runs, so the
 * belt's SOLE remaining job is a `?query`/`#fragment` tail: it redacts CONSERVATIVELY from the first
 * `?`/`#` marker through the span's space boundary — a continuation past an embedded break is
 * indistinguishable from a split value, so the far side is never kept. A span with no `?`/`#` (ordinary
 * prose — a `//comment` reference, an already-collapsed `//***@host`) is returned untouched. The scan is a
 * single left-to-right walk using `indexOf`/`charCodeAt` over spans bounded by the next SPACE, with no
 * regex backtracking, so a 20 000-char adversarial prompt cannot trigger catastrophic backtracking (issue
 * #778 review). Deterministic and total. */
function redactQueryFragmentSpans(text: string): string {
  let out = "";
  let i = 0;
  for (;;) {
    const start = text.indexOf("//", i);
    if (start < 0) return out + text.slice(i);
    out += text.slice(i, start);
    let end = start;
    while (end < text.length && text.charCodeAt(end) !== 0x20 /* SPACE */) end++;
    const span = text.slice(start, end);
    const qMark = span.indexOf("?");
    const hMark = span.indexOf("#");
    const qi = qMark < 0 ? hMark : hMark < 0 ? qMark : Math.min(qMark, hMark);
    // CONSERVATIVE: keep everything up to and including the `?`/`#` marker, then collapse the whole tail
    // (any continuation past an embedded CR/LF/TAB) to `***`. A value/prose resuming after the break is
    // INDISTINGUISHABLE from a split-credential continuation, so we never keep the post-break side; the RAW
    // prompt still reaches the runtime job input unmodified (issue #778 review — thread
    // deliveryGraphCompiler.ts:1115).
    out += qi < 0 ? span : `${span.slice(0, qi + 1)}***`;
    i = end;
  }
}
