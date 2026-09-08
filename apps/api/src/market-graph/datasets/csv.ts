/** Minimal RFC-4180 reader. Shared so five adapters do not each grow one. */
export function parseCsv(text: string, sep = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];

    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') {
      quoted = true;
    } else if (c === sep) {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') {
      field += c;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  /* A byte-order mark survives decoding and would corrupt the first
   * header name, so it is stripped by code point rather than literally. */
  const head = rows[0];

  if (head !== undefined && head[0] !== undefined) {
    head[0] = head[0].replace(/^\uFEFF/, '');
  }

  return rows;
}

export function toObjects(rows: string[][]): Array<Record<string, string>> {
  const header = rows[0] ?? [];

  return rows.slice(1).flatMap((values) => {
    /*
     * A row whose width disagrees with the header is REFUSED, not zipped
     * up short. A short row is not a row with missing fields - every value
     * after the gap now belongs to the wrong column.
     */
    if (values.length !== header.length) {
      return [];
    }

    const out: Record<string, string> = {};

    header.forEach((name, i) => {
      out[name] = values[i] ?? '';
    });

    return [out];
  });
}

export async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { headers: { 'User-Agent': 'career-os' } });

  if (!response.ok) {
    throw new Error(`fetch failed: ${response.status}`);
  }

  return response.text();
}

export async function fetchJson(
  url: string,
  init?: RequestInit,
): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    headers: { 'User-Agent': 'career-os', ...init?.headers },
  });

  if (!response.ok) {
    throw new Error(`fetch failed: ${response.status}`);
  }

  return (await response.json()) as unknown;
}
