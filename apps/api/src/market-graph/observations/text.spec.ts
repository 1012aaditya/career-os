import { describe, expect, it } from 'vitest';

import {
  collapseWhitespace,
  decodeEntitiesOnce,
  foldTerm,
  htmlToText,
  stripTags,
} from './text.js';

/*
 * Text handling, and specifically the entity escaping that Greenhouse
 * really uses.
 *
 * `content` arrives as entity-escaped HTML - literally
 * `&lt;div class=&quot;content-intro&quot;&gt;` - so getting the decode
 * order wrong does not produce a subtle bug. It produces a skill extractor
 * reading the tokens "lt", "div", "class" and "quot" out of every posting
 * on every board.
 */

describe('entity decoding', () => {
  it('decodes exactly one level', () => {
    expect(decodeEntitiesOnce('&amp;lt;p&amp;gt;')).toBe('&lt;p&gt;');
  });

  /*
   * A posting that legitimately shows an escaped code sample must keep it
   * as text rather than have it become markup.
   */
  it('does not decode so far that escaped text becomes markup', () => {
    /*
     * Two passes, never a loop to a fixed point. A posting that shows an
     * escaped code sample has escaped it deliberately, and decoding until
     * nothing is left would turn that sample into a tag - then strip it,
     * losing the text the employer meant to display.
     */
    const output = htmlToText('&amp;amp;lt;script&amp;amp;gt;');

    expect(output).not.toContain('<script');
    expect(output).toBe('&lt;script&gt;');
  });

  it.each([
    ['&lt;', '<'],
    ['&gt;', '>'],
    ['&amp;', '&'],
    ['&quot;', '"'],
    ['&#39;', "'"],
    ['&#x27;', "'"],
    ['&nbsp;', ' '],
    ['&rsquo;', '’'],
  ])('decodes %s', (entity, expected) => {
    expect(decodeEntitiesOnce(entity)).toBe(expected);
  });

  it('leaves an entity it does not know alone rather than guessing', () => {
    expect(decodeEntitiesOnce('&notarealentity;')).toBe('&notarealentity;');
  });

  /*
   * Postgres cannot store a NUL in a text column, and a lone surrogate
   * cannot be encoded. Refusing to decode them keeps the stored value and
   * the hashed value identical - if the driver stripped them later, the
   * two would silently diverge.
   */
  it.each(['&#0;', '&#xD800;', '&#1114112;'])(
    'refuses to decode %s into something unstorable',
    (entity) => {
      expect(decodeEntitiesOnce(entity)).toBe(entity);
    },
  );
});

describe('tag stripping', () => {
  it('leaves a space where a tag was, so two list items do not merge', () => {
    expect(collapseWhitespace(stripTags('<li>React</li><li>Go</li>'))).toBe(
      'React Go',
    );
  });

  it('drops a script body entirely', () => {
    const stripped = stripTags('<script>var javascript = 1;</script>Hello');

    /*
     * A JavaScript identifier list inside a page script is a rich source
     * of skills nobody asked for.
     */
    expect(stripped).not.toContain('javascript');
    expect(stripped).toContain('Hello');
  });

  it('drops a style body entirely', () => {
    expect(stripTags('<style>.a{color:red}</style>Hi')).not.toContain('color');
  });
});

describe('the full pipeline', () => {
  it('reads escaped Greenhouse markup as plain sentences', () => {
    const greenhouse =
      '&lt;div class=&quot;content-intro&quot;&gt;&lt;h2&gt;About&lt;/h2&gt;' +
      '&lt;p&gt;We use &lt;b&gt;Postgres&lt;/b&gt; &amp;amp; Go.&lt;/p&gt;&lt;/div&gt;';

    expect(htmlToText(greenhouse)).toBe('About We use Postgres & Go.');
  });

  it('leaves no entity text behind for the extractor to tokenize', () => {
    const text = htmlToText('&lt;p&gt;A&amp;nbsp;B&lt;/p&gt;');

    expect(text).not.toContain('&');
    expect(text).not.toContain('nbsp');
  });

  it('removes invisible characters that would split a token', () => {
    expect(htmlToText('Type​Script')).toBe('TypeScript');
  });

  it('is idempotent on text that is already plain', () => {
    expect(htmlToText('Plain sentence.')).toBe('Plain sentence.');
  });
});

describe('term folding', () => {
  it.each([
    ['  TypeScript  ', 'typescript'],
    ['TYPESCRIPT', 'typescript'],
    ['Ｔｙｐｅ Ｓｃｒｉｐｔ', 'type script'],
    ['C++', 'c++'],
    ['.NET', '.net'],
    ['node​.js', 'node.js'],
  ])('folds %j to %j', (input, expected) => {
    expect(foldTerm(input)).toBe(expected);
  });

  /*
   * toLocaleLowerCase maps a Turkish dotted capital I differently under a
   * tr locale, so the same term would resolve to two different skills
   * depending on the machine. foldTerm uses the locale-INDEPENDENT
   * toLowerCase; that it continues to is asserted as a source rule in
   * market-graph-boundary.spec.ts, because a value test cannot see which
   * function was called.
   */
  it('folds ASCII case to a fixed result', () => {
    expect(foldTerm('I')).toBe('i');
    expect(foldTerm('TypeScript')).toBe('typescript');
  });
});
