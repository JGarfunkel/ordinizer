import { TextEncoder, TextDecoder } from 'util';
import { ReadableStream } from 'node:stream/web';
const { MessageChannel } = require('worker_threads');

global.MessageChannel = MessageChannel;
global.MessagePort = MessageChannel.MessagePort;

Object.defineProperty(globalThis, 'ReadableStream', {
  value: ReadableStream,
});

Object.assign(global, { TextDecoder, TextEncoder });

class FakeElement {
  attrs: Record<string, string>;
  textContent: string;
  parentElement: FakeElement | null;

  constructor(attrs: Record<string, string>, textContent: string, parentElement: FakeElement | null = null) {
    this.attrs = attrs;
    this.textContent = textContent;
    this.parentElement = parentElement;
  }

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }
}

function stripTags(input: string): string {
  return input.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function parseAttrs(tagText: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const regex = /(\w[\w-]*)\s*=\s*"([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(tagText)) !== null) {
    attrs[match[1]] = match[2];
  }
  return attrs;
}

function buildDocumentFromHtml(html: string) {
  const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? stripTags(titleMatch[1]) : "";

  const byId = new Map<string, FakeElement>();
  const byCprole = new Map<string, FakeElement>();
  const candidates: FakeElement[] = [];

  const pageOpenMatch = html.match(/<div([^>]*\bid="page"[^>]*)>/i);
  const pageMatch = html.match(/<div[^>]*\bid="page"[^>]*>([\s\S]*?)<\/div>/i);
  const pageAttrs = pageOpenMatch ? parseAttrs(pageOpenMatch[1]) : {};
  const pageInner = pageMatch ? pageMatch[1] : "";
  const pageText = stripTags(pageInner);
  const pageEl = new FakeElement(pageAttrs, pageText, null);

  if (pageAttrs.id) {
    byId.set(pageAttrs.id, pageEl);
    candidates.push(pageEl);
  }

  const h1OpenMatch = html.match(/<h1([^>]*)>/i);
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1OpenMatch && h1Match) {
    const h1Attrs = parseAttrs(h1OpenMatch[1]);
    const h1Text = stripTags(h1Match[1]);
    const h1El = new FakeElement(h1Attrs, h1Text, pageEl);
    if (h1Attrs.id) {
      byId.set(h1Attrs.id, h1El);
      candidates.push(h1El);
    }
  }

  const inputRegex = /<input([^>]*\bid="([^"]+)"[^>]*)>/gi;
  let inputMatch: RegExpExecArray | null;
  while ((inputMatch = inputRegex.exec(html)) !== null) {
    const attrs = parseAttrs(inputMatch[1]);
    const el = new FakeElement(attrs, "", pageEl);
    byId.set(attrs.id, el);
    candidates.push(el);
  }

  const cproleOpenMatch = html.match(/<div([^>]*\bdata-cprole="([^"]+)"[^>]*)>/i);
  if (cproleOpenMatch) {
    const attrs = parseAttrs(cproleOpenMatch[1]);
    const cprole = cproleOpenMatch[2];
    const text = stripTags(html);
    const cproleEl = new FakeElement(attrs, text, null);
    byCprole.set(cprole, cproleEl);
    candidates.push(cproleEl);
  }

  const doc = {
    title,
    querySelector: (selector: string): FakeElement | null => {
      const idAndClass = selector.match(/^#([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/);
      if (idAndClass) {
        const el = byId.get(idAndClass[1]);
        if (!el) return null;
        const classList = (el.getAttribute("class") || "").split(/\s+/).filter(Boolean);
        return classList.includes(idAndClass[2]) ? el : null;
      }

      const idOnly = selector.match(/^#([A-Za-z0-9_-]+)$/);
      if (idOnly) {
        return byId.get(idOnly[1]) || null;
      }

      const cprole = selector.match(/^\[data-cprole='([^']+)'\]$/);
      if (cprole) {
        return byCprole.get(cprole[1]) || null;
      }

      return null;
    },
    querySelectorAll: (selector: string): FakeElement[] => {
      if (selector === "[id], [data-cprole], main, article, section") {
        return candidates;
      }
      return [];
    },
  };

  return doc;
}

import { discoverContentSelector, extractContentBlockText } from "../lib/spiderPageAnalysis";

describe("spiderPageAnalysis", () => {
  it("extracts proper content for Dobbs Ferry HTML", () => {
    const html = `
      <html>
        <body>
        <p>
        Header stuff!
        </p>
                <div class="pane-content">
          <article class="node-35 node node-department clearfix" about="/conservation-advisory-board" typeof="sioc:Item foaf:Document" role="article">
          <header>
                      <span property="dc:title" content="" class="rdf-meta element-hidden"></span><span property="sioc:num_replies" content="0" datatype="xsd:integer" class="rdf-meta element-hidden"></span>    </header>
      
      <div class="content">
        
        <!-- Main free content area -->
        
      <section class="field field-name-field-description field-type-text-with-summary field-label-hidden">
        <p style="text-align:center"><a href="https://www.dobbsferry.com/home/webforms/contact-us"><strong><span style="color:#0000FF">Contact Conservation Advisory Board</span></strong></a></p><p>The Conservation Advisory Board evaluates environmental concerns and impacts of development as well as advising the Village in the development, management and protection of its natural resources.Furthermore, this advisory board is responsible for reviewing environmental impact statements of proposed development in the Village, drafting natural resource protection legislation slopes law, tree protection law, and researches, develops and updates open space and natural resource inventories used by the Village.This board consists of 9 members on 3 year terms. </p><table border="1" cellpadding="1" cellspacing="1" style="width:100%"><thead><tr><th style="text-align:right"> </th><th> </th></tr></thead><tr class="odd"><td>Matthew Scott-Hansen</td><td>Chair</td></tr><tr class="even"><td>Jason Baird</td><td>Regular Member</td></tr><tr class="odd"><td>David Duarte</td><td>Regular Member</td></tr><tr class="even"><td>Liz Okin Gabay</td><td>Regular Member</td></tr><tr class="odd"><td>Caitlin Horsfield</td><td>Regular Member</td></tr><tr class="even"><td>Graham Nalle</td><td>Regular Member</td></tr><tr class="odd"><td>David Santini</td><td>Regular Member</td></tr><tr class="even"><td>Daniel Werges</td><td>Regular Member</td></tr><tr class="odd"><td>Allen Hale</td><td>Chairman of the Planning Board</td></tr><tr class="even"><td>Trustee Matt Rosenberg</td><td>Trustee Liaison</td></tr><tr class="odd"><td>Kendra Garrison</td><td>Staff Liaison</td></tr><tr class="even"><td>McCarthy Fingar</td><td>Village Attorney</td></tr></table><p> </p>  </section>

        <!-- Staff and Member Tables -->
            
        <!-- Custom Person Tables -->
        
        <!-- BAC Import -->
          </div>

        
    </article>
        </div>

        <p>footer stuff!</p>
        </body>      </html>
    `;

    // write a test to verify the text extracted from the selector is correct and does not include header/footer text
    const text = extractContentBlockText(html, "https://www.dobbsferry.com/conservation-advisory-board", "article");

    expect(text).toBeTruthy();
    expect(text).toContain("The Conservation Advisory Board evaluates environmental concerns and impacts of development");
    expect(text).toContain("Matthew");
    expect(text).not.toContain("Header stuff!");
    expect(text).not.toContain("footer stuff!");


  });

  it("finds #page from title-based fallback without moduleContent selector hints", () => {
    const mainHtml = `
      <html>
        <head><title>Living Here</title></head>
        <body>
            <div>
                bread crumbs and other menu stuff
            </div>
          <div id="page" class="somenewclass">
            <input id="hdnPageStatus" name="hdnPageStatus" type="hidden" value="Published">
            <h1 id="versionHeadLine" class="headline">Living Here</h1>
            <p>Living Here provides resident services, permits, collection schedules, and neighborhood programs.</p>
            <p>Find parks, sanitation guidance, recreation details, and local events in this section.</p>
            <p>This additional paragraph ensures the block is long enough for selector scoring.</p>
          </div>
          <div id="footer">
            <p>Contact info, social media links, and other boilerplate content.</p>
            </div>
        </body>
      </html>
    `;

    const secondaryHtml = `
      <html>
        <head><title>Community Services</title></head>
            <div>
                bread crumbs and other menu stuff
            </div>
        <body>
          <div id="page" class="somenewclass">
            <input id="hdnPageID" name="hdnPageID" type="hidden" value="32">
            <h1 id="versionHeadLine" class="headline">Community Services</h1>
              <p>Zoological expeditions coordinate aviary habitats, estuary salinity surveys, and migratory telemetry.</p>
              <p>Astronomical observatories catalog nebular spectra, pulsar harmonics, and ionospheric diffraction anomalies.</p>
              <p>Hydrodynamic laboratories measure baroclinic turbulence, thermocline inversions, and benthic fluorescence.</p>
          </div>
          <div id="footer">
            <p>Contact info, social media links, and other boilerplate content.</p>
            </div>
        </body>
      </html>
    `;

    const selector = discoverContentSelector(
        { name: "Bedford", type: "Town", state: "NY" },
      secondaryHtml,
      "https://example.org/community-services",
      mainHtml,
      "https://example.org/",
    );

    expect(selector).toBe("#page");
  });

  it("falls back to comment-delimited content areas when no stable selector exists", () => {
    const html = `
      <html>
        <head><title>Conservation Advisory Council</title></head>
        <body>
          <div class="shell">
            <!--Center Content Area Starts-->
            <div>
              <h1>Conservation Advisory Council</h1>
              <p>This council reviews development impacts, watershed concerns, and habitat preservation plans.</p>
              <p>Public meetings include reports, recommendations, and implementation updates for residents.</p>
            </div>
            <!--Center Content Area Ends-->
          </div>
        </body>
      </html>
    `;

    const selector = discoverContentSelector(
      { name: "Bedford", type: "Town", state: "NY" },
      html,
      "https://example.org/conservation-advisory-council.html",
    );

    expect(selector).toBe("__comment_content_area__");

    const text = extractContentBlockText(
      html,
      "https://example.org/conservation-advisory-council.html",
      selector || "",
    );

    expect(text).toBeTruthy();
    expect(text || "").toContain("Conservation Advisory Council");
    expect(text || "").toContain("watershed concerns");
  });
});
