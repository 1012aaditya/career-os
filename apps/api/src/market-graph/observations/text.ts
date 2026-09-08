/*
 * Text handling for market payloads.
 *
 * Pure and deterministic. The order of operations here is part of the
 * ruleset version: changing it changes what every posting is read to say,
 * so it may not be changed without bumping that number.
 */

/*
 * The named entities that actually occur in ATS job bodies, plus the five
 * that HTML escaping produces. Deliberately not a general entity table:
 * an open-ended decoder is a place for surprises, and every entity here is
 * one a real payload contained.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  /*
   * An ordinary space, not U+00A0. A non-breaking space survives
   * tokenization as part of a word, so "Node&nbsp;.js" would fold to a
   * single token that matches nothing - and a real skill would vanish
   * because of an invisible character.
   */
  nbsp: '\u0020',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
  bull: '•',
  middot: '·',
  reg: '®',
  copy: '©',
  trade: '™',
  eacute: 'é',
  egrave: 'è',
  uuml: 'ü',
  ouml: 'ö',
  auml: 'ä',
  ccedil: 'ç',
  plus: '+',
};

/*
 * Surrogates are refused because String.fromCodePoint throws on them and a
 * lone surrogate cannot be stored in Postgres text anyway; NUL is refused
 * because Postgres text cannot hold it, and letting the driver strip it
 * later would leave the stored description differing from the hashed one.
 */
function isDecodableCodePoint(code: number): boolean {
  return (
    Number.isInteger(code) &&
    code > 0 &&
    code <= 0x10ffff &&
    !(code >= 0xd800 && code <= 0xdfff)
  );
}

/*
 * Decodes ONE level of entity escaping.
 *
 * Exactly one, deliberately. Greenhouse's `content` is entity-escaped HTML
 * - it arrives literally as `&lt;div class=&quot;content-intro&quot;&gt;` -
 * so one pass turns it into HTML that stripTags can read. Decoding
 * repeatedly would turn a posting that legitimately contains the literal
 * text "&amp;lt;" into markup, which is how an escaped code sample in a
 * job description becomes a tag.
 *
 * The regex is built per call rather than hoisted to a module constant: a
 * module-level /g regex used with .test() carries lastIndex between calls
 * and returns alternating answers. .replace() does not have that bug, but
 * the pattern of hoisting does, and this file is exactly where somebody
 * would later add a .test().
 */
export function decodeEntitiesOnce(input: string): string {
  return input.replace(
    /&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g,
    (match: string, body: string) => {
      if (body.startsWith('#x') || body.startsWith('#X')) {
        const code = Number.parseInt(body.slice(2), 16);

        return isDecodableCodePoint(code) ? String.fromCodePoint(code) : match;
      }

      if (body.startsWith('#')) {
        const code = Number.parseInt(body.slice(1), 10);

        return isDecodableCodePoint(code) ? String.fromCodePoint(code) : match;
      }

      return NAMED_ENTITIES[body.toLowerCase()] ?? match;
    },
  );
}

/*
 * Strips tags, leaving a space where each one was.
 *
 * A space rather than nothing, so "<li>React</li><li>Go</li>" does not read
 * as the single token "ReactGo". Script and style bodies are dropped
 * entirely - their contents are not job requirements, and a JavaScript
 * identifier list is a rich source of false skill matches.
 */
export function stripTags(input: string): string {
  return input
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ');
}

/*
 * Removes characters that are invisible, unstorable, or that would make two
 * visually identical strings hash differently: NUL, zero-width space, ZWNJ,
 * ZWJ, and the byte-order mark.
 */
export function stripInvisible(input: string): string {
  return (
    input
      /*
       * Split/join rather than a regex: a NUL inside a character class
       * trips the control-character lint, and zero-width joiners adjacent
       * in a class trip the misleading-character-class one. Both warnings
       * are about regexes that are easy to misread, and the point of this
       * function is that what it removes is unambiguous.
       */
      .split('\u0000')
      .join('')
      .split('\u200b')
      .join('')
      .split('\u200c')
      .join('')
      .split('\u200d')
      .join('')
      .split('\ufeff')
      .join('')
  );
}

export function collapseWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

/**
 * Entity-escaped HTML in, plain readable text out.
 *
 * decode -> strip tags -> decode again -> remove invisibles -> collapse.
 *
 * The second decode is not belt-and-braces. Greenhouse escapes its HTML
 * once on the wire, so the first pass yields real HTML whose text nodes
 * still contain their own entities ("&nbsp;", "&amp;"); stripping tags
 * exposes those, and stopping there would leave the literal string
 * "&nbsp;" sitting in the description we index for skills.
 */
export function htmlToText(input: string): string {
  const once = decodeEntitiesOnce(input);
  const stripped = stripTags(once);
  const decoded = decodeEntitiesOnce(stripped);

  return collapseWhitespace(stripInvisible(decoded));
}

/*
 * The folding every lookup key goes through.
 *
 * NFKC first, so fullwidth and other compatibility forms converge on the
 * ASCII they are equivalent to. Then invisibles, then case, then
 * whitespace. toLowerCase and never toLocaleLowerCase: the locale-aware
 * form maps a Turkish dotted capital I to a different character, so the
 * same term would resolve to two different skills depending on the
 * machine's locale.
 */
export function foldTerm(input: string): string {
  return collapseWhitespace(
    stripInvisible(input.normalize('NFKC')).toLowerCase(),
  );
}
