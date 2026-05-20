import {
  convertHtmlToText,
  convertHtmlToTextSimple,
  normalizeExtractedText,
} from "../lib/simpleHtmlToText";

describe("normalizeExtractedText", () => {
  it("splits merged camel-case words", () => {
    const result = normalizeExtractedText("PermitApplicationRequired\nMainBodyText");
    expect(result).toContain("Permit Application Required");
    expect(result).toContain("Main Body Text");
  });

  it("preserves paragraph breaks while limiting excessive blank lines", () => {
    const result = normalizeExtractedText("Section One\n\n\n\nSection Two");
    expect(result).toBe("Section One\n\nSection Two");
  });

  it("collapses repeated spaces without removing normal words", () => {
    const result = normalizeExtractedText("Policy    language      stays readable");
    expect(result).toBe("Policy language stays readable");
  });

  it("preserves lightweight structure for headers and paragraphs", () => {
    const html = `
      <html>
        <body>
          <h1>Town Board Rules</h1>
          <p>First paragraph about procedures.</p>
          <p>Second paragraph about meetings.</p>
        </body>
      </html>
    `;

    const result = convertHtmlToText(html);

    expect(result).toContain("Town Board Rules");
    expect(result).toContain("First paragraph about procedures.");
    expect(result).toContain("Second paragraph about meetings.");
    expect(result).toMatch(/Town Board Rules\n\nFirst paragraph about procedures\./);
  });

  it("formats blocks with double newlines in simple converter", () => {
    const html = `
      <html>
        <body>
          <h1>Policy Summary</h1>
          <p>First paragraph text.</p>
          <p>Second paragraph text.</p>
          <ul>
            <li>Item one</li>
            <li>Item two</li>
          </ul>
        </body>
      </html>
    `;

    const result = convertHtmlToTextSimple(html);

    expect(result).toContain("Policy Summary\n\nFirst paragraph text.\n\nSecond paragraph text.");
    expect(result).toContain("\n\n- Item one\n\n- Item two");
  });

  it("reads definition lists", () => {
    const html = `
    <article>
    <a alt="122-3C" class="litem_number" href="6237007#6237007" onclick="return false;" title="122-3C">C. </a>
    <div class="litem_content content"><div class="para">It is the intent of this chapter to incorporate the 
    consideration of wetlands protection into the Town's extant land use and development approval procedures.</div>
    <div class="footnotes"></div></div></div></div><div class="footnotes"></div></div>                </article>
              <article>
                  <header>
        <label class="selectionLabel" id="6237008_label" for="6237008_input">
    <div class="titleLinkContainer">
    <a href="#6237008"        class="titleLink"     >
    <span class="titleNumber">      § 122-4    </span>
    <span class="titleTitle"          data-guid="6237008"     >
        Word usage; definitions.    </span>
    </a>
  </div>
      </label>
              </header>

        <div class="notes" id="notes-6237008" data-guid="6237008"></div>
        <div id="questions-6237008" data-guid="6237008" class="questions"></div>
          <div class="section_content content" id="6237008_content" title-footnotes="0">
          <div class="level"><div class="litem" id="6237009">
          <a alt="122-4A" class="litem_number" href="6237009#6237009" onclick="return false;" title="122-4A">
          A. </a><div class="litem_content content"><div class="para">Except where specifically defined herein, 
          all words used in this chapter shall carry their customary meanings. Words used in the present tense include the 
          future and the plural includes the singular. The word "shall" is intended to be mandatory.</div>
          <div class="footnotes"></div></div></div><div class="litem" id="6237010"><a alt="122-4B" class="litem_number" 
          ref="6237010#6237010" onclick="return false;" title="122-4B">B. </a><div class="litem_content content">
          <div class="para">As used in this chapter, the following terms shall have the meanings indicated:</div>
          <section class="definition" id="6237011"><dfn class="term"><a class="termLink"
           href="6237011#6237011" onclick="return false;">APPLICANT</a></dfn><div class="deftext">See "person."</div></section>
           <section class="definition" id="6237012"><dfn class="term"><a class="termLink" href="6237012#6237012" onclick="return false;">
           BEDFORD REGULATED WETLAND AREA MAP</a></dfn><div class="deftext">A series of maps, dated January 1991, prepared 
           by Evans Associates that show areas which may constitute regulated wetlands.</div></section><section class="definition"
            id="6237013"><dfn class="term"><a class="termLink" href="6237013#6237013" onclick="return false;">BUILDING</a></dfn><div 
            class="deftext">Any structure having a roof, supported by columns or by walls or self-supporting, and intended for the shelter,
             housing or enclosure of natural persons, animals or chattel.</div></section><section class="definition" id="6237014"><dfn
              class="term"><a class="termLink" href="6237014#6237014" onclick="return false;">BUILDING INSPECTOR</a></dfn><div 
              class="deftext">The duly appointed Building Inspector of the Town of Bedford.</div></section>
          </div></div></div></div></article>`;

    const result = convertHtmlToText(html);

    expect(result).toContain("Word usage; definitions.");
    expect(result).toContain("A. Except where specifically defined herein, all words used in this chapter shall carry their customary meanings. Words used in the present tense include the future and the plural includes the singular. The word \"shall\" is intended to be mandatory.");
    expect(result).toContain("B. As used in this chapter, the following terms shall have the meanings indicated:");
    expect(result).toContain("APPLICANT: See \"person.\"");
    expect(result).toContain("BEDFORD REGULATED WETLAND AREA MAP: A series of maps, dated January 1991, prepared by Evans Associates that show areas which may constitute regulated wetlands.");
    expect(result).toContain("BUILDING: Any structure having a roof, supported by columns or by walls or self-supporting, and intended for the shelter, housing or enclosure of natural persons, animals or chattel.");
    expect(result).toContain("BUILDING INSPECTOR: The duly appointed Building Inspector of the Town of Bedford.");
  });

});