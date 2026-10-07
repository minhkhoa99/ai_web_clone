import { expect, test } from "vitest";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "@/core/errors";
import { assetLibrary, readUploads, sanitizeSvg, sniffImage, storeUpload, UPLOAD_ORIGIN } from "@/core/upload";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const JPG = Buffer.from("ffd8ffe000104a464946", "hex");
const GIF = Buffer.from("GIF89a\x01\x00\x01\x00", "latin1");
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]);
const AVIF = Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from("ftypavif"), Buffer.alloc(4)]);
const SVG = Buffer.from('<?xml version="1.0"?>\n<!-- logo -->\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>');
const codeOf = async (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof AppError ? e.code : String(e)));

test("sniffImage reads png/jpg/gif/webp/avif/svg magic bytes and nothing else", () => {
  expect([PNG, JPG, GIF, WEBP, AVIF, SVG].map(sniffImage)).toEqual(["png", "jpg", "gif", "webp", "avif", "svg"]);
  for (const other of [Buffer.from("<html><body>hi</body></html>"), Buffer.from("%PDF-1.7"), Buffer.alloc(0), Buffer.from("RIFF\0\0\0\0WAVE")]) expect(sniffImage(other)).toBeUndefined();
  // a DOCTYPE with an internal subset (entity definitions) is not an image we take
  expect(sniffImage(Buffer.from('<!DOCTYPE svg [<!ENTITY x "y">]><svg/>'))).toBeUndefined();
  expect(sniffImage(Buffer.from("<!-- a --><!-- b -->\n<svg/>"))).toBe("svg");
  const started = Date.now(); // the comment prefix must not backtrack exponentially
  expect(sniffImage(Buffer.from(`${"<!---->".repeat(140)}x`))).toBeUndefined();
  expect(Date.now() - started).toBeLessThan(500);
});

test("sanitizeSvg drops script, foreignObject, on* handlers, javascript:/data: hrefs (keeps data:image raster), DOCTYPE/ENTITY; keeps the drawing", () => {
  const dirty = `<!DOCTYPE svg [<!ENTITY x "boom">]><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" onload="alert(1)">
<script>alert(2)</script><foreignObject><div onclick="x"><script>alert(3)</script></div></foreignObject>
<a href="javascript:alert(4)"><text>link</text></a><a xlink:href=" JaVa&#x09;script:alert(5)"/>
<image href="data:text/html,&lt;b&gt;x"/><image href="data:image/png;base64,AAAA"/>
<animate attributeName="href" values="#a;javascript:alert(6)"/><rect ONMOUSEOVER='y' width="1"/></svg>`;
  const clean = sanitizeSvg(dirty);
  expect(clean).not.toMatch(/<script|foreignObject|onload|onclick|onmouseover|DOCTYPE|ENTITY|data:text|javascript|alert\(/i);
  expect(clean).toContain('<image href="data:image/png;base64,AAAA"/>');
  expect(clean).toContain("<a><text>link</text></a>");
  expect(clean).toContain('<rect width="1"/>');
  expect(clean).toContain('xmlns:xlink="http://www.w3.org/1999/xlink"');
  expect(() => sanitizeSvg("<html><body></body></html>")).toThrow(/svg/i);
});

// --- sanitizeSvg: one assertion per bypass it guards ---------------------------------------------------------
const NS = 'xmlns="http://www.w3.org/2000/svg"';
const XL = 'xmlns:xlink="http://www.w3.org/1999/xlink"';
const wrap = (inner: string, attrs = "") => sanitizeSvg(`<svg ${NS}${attrs}>${inner}</svg>`);
const body = (inner: string, attrs = "") => wrap(inner, attrs).replace(/^<svg[^>]*>|<\/svg>$/g, "");

test("sanitizeSvg: only allowlisted SVG elements survive; anything else (any case, any prefix) goes with its content", () => {
  for (const bad of [
    "<SCRIPT>alert(1)</SCRIPT>", "<Script>alert(1)</Script>", "<svg:script>alert(1)</svg:script>",
    '<h:script xmlns:h="http://www.w3.org/1999/xhtml">alert(1)</h:script>', '<html:img src="x" onerror="alert(1)"/>',
    '<iframe src="javascript:alert(1)"></iframe>', '<embed src="x.swf"/>', '<object data="x"><p>t</p></object>',
    '<handler type="application/ecmascript">alert(1)</handler>', "<listener event='click' handler='#h'/>",
    "<foreignobject><img src=x onerror=alert(1)></foreignobject>", "<unknown><rect/></unknown>",
  ]) expect(body(bad), bad).toBe("");
  expect(body('<g fill="red"><path d="M0 0h1"/><linearGradient id="g"><stop offset="0"/></linearGradient></g>')).toBe(
    '<g fill="red"><path d="M0 0h1"/><linearGradient id="g"><stop offset="0"/></linearGradient></g>',
  );
  expect(body("<G><LINEARGRADIENT/></G>")).toBe("<g><linearGradient/></g>"); // canonical names
});

test("sanitizeSvg: attributes — on* in any case, foreign prefixes and namespace rebinding are dropped", () => {
  expect(body('<rect OnLoad="a" onClick="b" onfocusin="c" width="1"/>')).toBe('<rect width="1"/>');
  // a prefix bound to the XLink (or XHTML) namespace under another name
  expect(body('<a x:href="javascript:alert(1)" xmlns:x="http://www.w3.org/1999/xlink"/>')).toBe("<a/>");
  expect(body('<g xmlns="http://www.w3.org/1999/xhtml"><rect/></g>')).toBe("<g><rect/></g>");
  expect(wrap("", ' xmlns:xlink="http://www.w3.org/1999/xhtml"')).toBe(`<svg ${NS}></svg>`);
  expect(body('<rect inkscape:label="x" sodipodi:type="y" xml:space="preserve" xml:base="javascript:alert(1)//"/>')).toBe('<rect xml:space="preserve"/>');
  expect(body('<rect width="1" width="2"/>')).toBe('<rect width="1"/>'); // a duplicate would make the file unparsable
});

test("sanitizeSvg: href is allowlisted — local #refs, raster data: on <image>, http(s)/mailto on <a>", () => {
  expect(body(`<use href="#a"/><use xlink:href="#b"/>`, ` ${XL}`)).toBe('<use href="#a"/><use xlink:href="#b"/>');
  for (const ext of ["http://evil.test/s.svg#a", "data:image/svg+xml;base64,PHN2Zz4=#a", "//evil.test/x#a", "x.svg#a"]) expect(body(`<use href="${ext}"/>`)).toBe("<use/>");
  expect(body('<image href="data:image/svg+xml,&lt;svg onload=alert(1)&gt;"/>')).toBe("<image/>");
  expect(body('<image href="https://evil.test/track.png"/>')).toBe("<image/>");
  expect(body('<feImage href="data:image/png;base64,AA"/>')).toBe('<feImage href="data:image/png;base64,AA"/>');
  expect(body('<a href="https://x.test/?a=1&amp;b=2"><text>t</text></a>')).toBe('<a href="https://x.test/?a=1&amp;b=2"><text>t</text></a>');
  expect(body('<a HREF="vbscript:x"/><a href="&#106;avascript:alert(1)"/><a href="&#x6A;&#x61;vascript:alert(1)"/><a href="java&#10;script:alert(1)"/>')).toBe("<a/><a/><a/><a/>");
  expect(body('<a href="data:text/html,x"/>')).toBe("<a/>");
});

test("sanitizeSvg: animation that targets href or an event attribute is dropped whole; values naming javascript: dropped", () => {
  for (const bad of [
    '<set attributeName="href" to="javascript:alert(1)"/>', '<animate attributeName="xlink:href" values="javascript:alert(1)"/>',
    '<set attributeName="HREF" to="#a"/>', '<set attributeName="onclick" to="alert(1)"/>', '<animate attributeName="onbegin" values="x"><rect/></animate>',
  ]) expect(body(bad), bad).toBe("");
  expect(body('<animate attributeName="opacity" values="0;1" dur="1s"/>')).toBe('<animate attributeName="opacity" values="0;1" dur="1s"/>');
  expect(body('<animate attributeName="fill" values="red; javascript:alert(1)"/>')).toBe('<animate attributeName="fill"/>');
});

test("sanitizeSvg: CSS — url() only to #refs, no @import/escapes/expression/binding in <style> or any attribute", () => {
  expect(body('<rect fill="url(#g)" style="fill:red;stroke:url(\'#s\')"/>')).toBe('<rect fill="url(#g)" style="fill:red;stroke:url(\'#s\')"/>');
  for (const bad of [
    'fill="url(http://evil.test/x)"', 'style="background:url(javascript:alert(1))"', 'style="b:u\\72l(x)"',
    'style="x:expression(alert(1))"', 'style="-moz-binding:url(x.xml#b)"', 'style="behavior: url(x.htc)"', 'fill="u&#x72;l(//evil.test/x)"',
  ]) expect(body(`<rect ${bad}/>`), bad).toBe("<rect/>");
  for (const bad of [
    "@import url(http://evil.test/x.css);", "@import 'x.css';", "@&#x69;mport 'x.css';", ".a{fill:url(javascript:alert(1))}",
    ".a{fill:u\\72l(x)}", "@font-face{src:url(http://evil.test/f.woff)}", ".a{fill:red}<![CDATA[@import 'x';]]>",
    "@font-face{font-family:x}", '.a{background:image-set("http://evil.test/x.png" 1x)}', '.a{background:-webkit-image-set("x.png" 1x)}',
    '.a{background-image:src("http://evil.test/x.png")}',
  ]) expect(body(`<style>${bad}</style><rect/>`), bad).toBe("<rect/>");
  expect(body('<rect style="background:image-set(\'x.png\' 1x)"/>')).toBe("<rect/>");
  expect(body("<style>.a{fill:red}<g/></style><rect/>")).toBe("<rect/>"); // markup inside <style>
  expect(body("<style><![CDATA[.b > .c{fill:url(#g)} .d{fill:red}]]></style>")).toBe("<style>.b > .c{fill:url(#g)} .d{fill:red}</style>");
  expect(body('<style type="text/css">.a &gt; .b{fill:red}</style>')).toBe('<style type="text/css">.a > .b{fill:red}</style>');
  expect(body("<style/>")).toBe("");
});

test("sanitizeSvg: entities, PIs, CDATA and comments never smuggle markup; output is always well-formed", () => {
  expect(body('<?xml-stylesheet href="evil.xsl" type="text/xsl"?><!-- <script>alert(1)</script> --><rect/>')).toBe("<rect/>");
  expect(body("<text><![CDATA[<script>alert(1)</script>]]></text>")).toBe("<text>&lt;script>alert(1)&lt;/script></text>");
  expect(body("<text>a &amp; b &lt; c &unknown; &colon; &#60;</text>")).toBe("<text>a &amp; b &lt; c &amp;unknown; &amp;colon; &lt;</text>");
  // decoded once, re-encoded: no RangeError, no char the XML parser rejects, no HTML-only entity left live
  expect(body('<rect id="a&colon;b" data-x="&#x110000;&#0;\x01&#xD800;"/>')).toBe('<rect id="a&amp;colon;b" data-x="\ufffd\ufffd\ufffd\ufffd"/>');
  expect(sanitizeSvg(`<!DOCTYPE svg [<!ENTITY x "]><svg onload='alert(1)'>">]><svg ${NS}>&x;</svg>`)).toBe(`<svg ${NS}>&amp;x;</svg>`);
  expect(sanitizeSvg(`junk <svg ${NS}><g><rect></svg> <script>alert(1)</script><svg/>`)).toBe(`<svg ${NS}><g><rect></rect></g></svg>`);
  expect(sanitizeSvg(`<svg ${NS}><g></rect></text><rect/>`)).toBe(`<svg ${NS}><g><rect/></g></svg>`); // stray closes, unclosed root
  expect(sanitizeSvg(`<svg ${NS}><script></g>alert(1)</script><rect/></svg>`)).toBe(`<svg ${NS}><rect/></svg>`);
  // malformed XML is refused rather than guessed at
  for (const bad of ['<rect title="<x>"/>', "<rect", "a < b", "<!-- open", "<![CDATA[ open", "<?pi open", "<!ELEMENT x ANY>", '<!DOCTYPE svg [<!ENTITY x "open']) expect(() => wrap(bad), bad).toThrow(/svg/i);
  expect(() => sanitizeSvg(`<g/><svg ${NS}/>`)).toThrow(/svg/i); // the root element must be <svg>
});

test("sanitizeSvg: text escapes only & and < (and ]]>); a kept xlink:* gets its namespace declared on the root", () => {
  expect(body("<text>\"a\" > b ]]> c</text>")).toBe("<text>\"a\" > b ]]&gt; c</text>");
  expect(body("<rect id='a\"b>c'/>")).toBe('<rect id="a&quot;b>c"/>');
  expect(wrap('<use xlink:href="#a"/>')).toBe(`<svg ${NS} ${XL}><use xlink:href="#a"/></svg>`);
  expect(sanitizeSvg(`<svg ${NS} xlink:title="t"/>`)).toBe(`<svg ${NS} xlink:title="t" ${XL}/>`);
  expect(wrap('<use xlink:href="#a"/>', ` ${XL}`)).toBe(`<svg ${NS} ${XL}><use xlink:href="#a"/></svg>`); // declared once
});

test("sanitizeSvg: nesting is capped at 1024 levels; stray closes against a deep stack stay O(1)", () => {
  expect(() => wrap("<g>".repeat(1024))).toThrow(/1024/);
  expect(() => wrap(`<script>${"<g>".repeat(1024)}</script>`)).toThrow(/1024/); // dropped content counts too
  expect(wrap("<g>".repeat(1022))).toBe(`<svg ${NS}>${"<g>".repeat(1022)}${"</g>".repeat(1022)}</svg>`);
  const started = Date.now();
  expect(wrap(`${"<g>".repeat(1000)}${"</rect>".repeat(8_000)}`)).toBe(`<svg ${NS}>${"<g>".repeat(1000)}${"</g>".repeat(1000)}</svg>`);
  expect(wrap(`<script>${"<g>".repeat(1000)}${"</rect>".repeat(8_000)}</script><rect/>`)).toBe(`<svg ${NS}><rect/></svg>`);
  expect(Date.now() - started).toBeLessThan(200);
  const big = Date.now(); // and at upload scale (~2.4 MB of stray closes)
  wrap(`${"<g>".repeat(1000)}${"</rect>".repeat(300_000)}`);
  wrap(`<script>${"<g>".repeat(1000)}${"</rect>".repeat(300_000)}`);
  expect(Date.now() - big).toBeLessThan(1_000);
});

test("sanitizeSvg stays linear on unterminated constructs (25 MB uploads)", () => {
  const started = Date.now();
  for (const unit of ['<a b="x" ', "<!--", "<![CDATA[", "<?x ", "<!DOCTYPE [", '<a b="<a b="', "<", "<a "]) {
    expect(() => sanitizeSvg(`<svg ${NS}>${unit.repeat(200_000)}`)).toThrow(/svg/i);
    expect(() => sanitizeSvg(`<svg ${NS}><script>${unit.repeat(200_000)}`)).toThrow(/svg/i);
  }
  const big = `<svg ${NS}>${'<g><rect x="1"/>t</g>'.repeat(200_000)}</svg>`;
  expect(sanitizeSvg(big)).toBe(big);
  expect(Date.now() - started).toBeLessThan(5_000);
});

test("storeUpload: assets/<sha>.<ext> + uploads.json key, idempotent; extension and bytes must agree; svg sanitized; 25 MB and the project budget hold", async () => {
  const ws = await mkdtemp(join(tmpdir(), "upload-"));
  const a = await storeUpload(ws, "Logo.PNG", PNG);
  expect(a.file).toMatch(/^assets\/[0-9a-f]{64}\.png$/);
  expect(a.key).toBe(`${UPLOAD_ORIGIN}${a.file.slice("assets/".length)}`);
  expect(await readFile(join(ws, a.file))).toEqual(PNG);
  expect(await readUploads(ws)).toEqual({ [a.key]: a.file });
  expect(await storeUpload(ws, "again.png", PNG)).toEqual(a);
  expect((await storeUpload(ws, "photo.jpeg", JPG)).file).toMatch(/\.jpg$/);
  const svg = await storeUpload(ws, "x.svg", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'));
  expect(await readFile(join(ws, svg.file), "utf8")).toBe('<svg xmlns="http://www.w3.org/2000/svg"/>');
  expect(await codeOf(storeUpload(ws, "fake.jpg", PNG))).toBe("UPLOAD_INVALID");
  expect(await codeOf(storeUpload(ws, "page.png", Buffer.from("<html>")))).toBe("UPLOAD_INVALID");
  expect(await codeOf(storeUpload(ws, "x.bmp", PNG))).toBe("UPLOAD_INVALID");
  expect(await codeOf(storeUpload(ws, "bad.svg", Buffer.from([0x3c, 0x73, 0x76, 0x67, 0xff, 0xfe])))).toBe("UPLOAD_INVALID");
  expect(await codeOf(storeUpload(ws, "big.png", Buffer.concat([PNG, Buffer.alloc(25 * 1024 * 1024)])))).toBe("ASSET_TOO_LARGE");
  expect(await codeOf(storeUpload(ws, "g.gif", GIF, 10))).toBe("PROJECT_SIZE_LIMIT");
  expect((await readdir(join(ws, "assets"))).filter((f) => f.includes(".tmp-"))).toEqual([]);
});

test("storeUpload never derives a path from the client name; an svg that is html, or an html named .svg, is refused", async () => {
  const ws = await mkdtemp(join(tmpdir(), "upload-"));
  const up = await storeUpload(ws, "../../../evil/x.png", PNG);
  expect(up.file).toMatch(/^assets\/[0-9a-f]{64}\.png$/);
  expect(await readdir(ws)).toEqual(["assets", "uploads.json"]);
  expect(await codeOf(storeUpload(ws, "x.svg", Buffer.from("<html><svg/></html>")))).toBe("UPLOAD_INVALID");
  expect(await codeOf(storeUpload(ws, "x.png.svg", PNG))).toBe("UPLOAD_INVALID");
  expect(await codeOf(storeUpload(ws, "png", PNG))).toBe("UPLOAD_INVALID");
  // a tampered uploads.json maps nothing outside assets/ (the emitter copies what the map names)
  await writeFile(join(ws, "uploads.json"), JSON.stringify({ [up.key]: up.file, "https://upload.aiwc.invalid/x.png": "../../etc/passwd", "http://x.test/a.png": `assets/${"a".repeat(64)}.png` }));
  expect(await readUploads(ws)).toEqual({ [up.key]: up.file });
  for (const junk of ["null", "[1]", '"x"', "{broken"]) {
    await writeFile(join(ws, "uploads.json"), junk);
    expect(await readUploads(ws), junk).toEqual({}); // emitOpts never fails on it; the next upload rewrites it
  }
});

test("storeUpload: the sanitized svg obeys the 25 MB cap too (escaping grows it)", async () => {
  const ws = await mkdtemp(join(tmpdir(), "upload-"));
  const grows = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><text>${"&".repeat(6 * 1024 * 1024)}</text></svg>`); // 6 MB in, 30 MB out
  expect(await codeOf(storeUpload(ws, "x.svg", grows))).toBe("ASSET_TOO_LARGE");
  expect(await readdir(ws)).toEqual([]);
});

test("assetLibrary: image files of the asset map once each (uploads first) with size and type; fonts and missing files are left out", async () => {
  const ws = await mkdtemp(join(tmpdir(), "library-"));
  const up = await storeUpload(ws, "a.png", PNG);
  await writeFile(join(ws, "assets", `${"b".repeat(64)}.woff2`), "font");
  await writeFile(join(ws, "assets", `${"c".repeat(64)}.jpg`), JPG);
  const map = {
    "http://x.test/f.woff2": `assets/${"b".repeat(64)}.woff2`,
    "http://x.test/c.jpg": `assets/${"c".repeat(64)}.jpg`,
    "http://x.test/c2.jpg": `assets/${"c".repeat(64)}.jpg`,
    "http://x.test/gone.png": `assets/${"d".repeat(64)}.png`,
    [up.key]: up.file,
  };
  expect(await assetLibrary(ws, map, (f) => `/files/${f}`)).toEqual([
    { key: up.key, url: `/files/${up.file}`, size: PNG.length, type: "png" },
    { key: "http://x.test/c.jpg", url: `/files/assets/${"c".repeat(64)}.jpg`, size: JPG.length, type: "jpg" },
  ]);
});
