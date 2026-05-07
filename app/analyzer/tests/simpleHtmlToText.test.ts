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
});
