#!/usr/bin/env tsx

import fs from "fs/promises";
import { JSDOM, VirtualConsole } from "jsdom";

function extractStructuredText(root: Element | Document): string {
	if (typeof (root as Element).querySelectorAll !== "function") {
		return "";
	}

	const blocks = Array.from(
		(root as Element).querySelectorAll("h1, h2, h3, h4, h5, h6, p, li, div.para"),
	);
	const segments: string[] = [];

	for (const block of blocks) {
		const raw = (block.textContent || "").replace(/\s+/g, " ").trim();
		if (!raw) {
			continue;
		}

		if (/^h[1-6]$/i.test(block.tagName)) {
			segments.push(`\n${raw}\n`);
			continue;
		}

		if (block.tagName.toLowerCase() === "li") {
			segments.push(`- ${raw}`);
			continue;
		}

		segments.push(raw);
	}

	return segments.join("\n\n").trim();
}

export function convertHtmlToTextSimple(html: string): string {
	try {
		const virtualConsole = new VirtualConsole();
		virtualConsole.forwardTo(console, { jsdomErrors: "none" });
		const dom = new JSDOM(html, { virtualConsole });
		const document = dom.window.document;

		document.querySelectorAll("script, style, noscript").forEach((element) => {
			element.remove();
		});

		const root: Element | Document =
			document.body || document.documentElement || document;
		const blocks = Array.from(
			(root as Element).querySelectorAll(
				"h1, h2, h3, h4, h5, h6, p, li, blockquote, pre, td, th",
			),
		);

		const segments: string[] = [];
		for (const block of blocks) {
			const raw = (block.textContent || "").replace(/\s+/g, " ").trim();
			if (!raw) {
				continue;
			}
			if (block.tagName.toLowerCase() === "li") {
				segments.push(`- ${raw}`);
				continue;
			}
			segments.push(raw);
		}

		if (segments.length > 0) {
			return segments.join("\n\n").trim();
		}

		return ((root.textContent || "") as string).replace(/\s+/g, " ").trim();
	} catch {
		return html
			.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
			.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
			.replace(/<[^>]*>/g, " ")
			.replace(/\s+/g, " ")
			.trim();
	}
}

export function normalizeExtractedText(rawText: string): string {
	let text = rawText;

	// Preserve paragraph structure by converting multiple whitespace to proper newlines
	text = text.replace(/\n\s*\n/g, "\n\n"); // Double newlines for paragraphs
	text = text.replace(/\t+/g, "\t"); // Preserve tabs
	text = text.replace(/[ ]+/g, " "); // Collapse multiple spaces to single
	text = text.replace(/\n /g, "\n"); // Remove leading spaces after newlines

	// Better newline preservation - don't collapse all newlines
	text = text.replace(/\n{3,}/g, "\n\n"); // Maximum of 2 consecutive newlines
	text = text.replace(/([a-z])([A-Z])/g, "$1 $2"); // Split merged CamelCase tokens

	const preFilterText = text;

	// More lenient line filtering: keep most content, only remove obvious navigation
	const lines = text.split("\n");
	const filteredLines: string[] = [];

	for (let i = 0; i < lines.length; i++) {
		const currentLine = lines[i].trim();

		// Keep empty lines for spacing
		if (currentLine === "") {
			filteredLines.push(lines[i]);
			continue;
		}

		// Remove lines that are clearly navigation/UI elements
		const isNavigationLine =
			/^(back|next|home|menu|search|login|logout)$/i.test(currentLine) || // Common navigation terms
			/^[\d\s\-\.]{1,10}$/.test(currentLine) || // Lines with only numbers/punctuation
			/^(©|®|™|\(c\))/i.test(currentLine) || // Copyright notices
			currentLine.match(/^(print|email|share|download|pdf)$/i); // Action buttons

		// Keep everything else - be much more inclusive for statute content
		if (!isNavigationLine) {
			filteredLines.push(lines[i]);
		}
	}

	text = filteredLines.join("\n");
	if (text.trim().length < 50 && preFilterText.trim().length > text.trim().length) {
		// Avoid dropping substantive content when line filtering is too aggressive for a page structure.
		text = preFilterText;
	}

	return text.trim();
}

/**
 * Convert HTML content to clean, readable text
 * This function removes scripts, styles, and navigation elements while preserving
 * meaningful paragraph structure and content.
 * @param html - The HTML content to convert
 * @param anchorId - Optional anchor ID to extract only a specific section
 */
export function convertHtmlToText(html: string, anchorId?: string): string {
	try {
		// Configure JSDOM to suppress console output
		const virtualConsole = new VirtualConsole();
		virtualConsole.forwardTo(console, { jsdomErrors: "none" });
		const dom = new JSDOM(html, { virtualConsole });
		const document = dom.window.document;

		// Remove script and style elements only - keep content
		const scripts = document.querySelectorAll("script, style");
		scripts.forEach((script) => script.remove());

		let targetElement: Element | Document =
			document.body || document.documentElement || document;

		// If we have an anchor ID, try to extract only the relevant section
		if (anchorId) {
			console.log(`  🎯 Looking for anchor section: ${anchorId}`);
      
			// Try to find the anchor element
			const anchorElement = document.getElementById(anchorId);
			if (anchorElement) {
				console.log(`  ✅ Found anchor element: ${anchorElement.tagName}#${anchorElement.id}`);
        
				// Strategy 1: Look for content div with pattern {anchorId}_content
				// For ecode360 URLs, skip content element strategy and go directly to litem extraction
				let contentElement = document.getElementById(`${anchorId}_content`);
				const isEcode360 = document.querySelector('.litem') !== null;
        
				if (contentElement && isEcode360) {
					console.log(`  📍 Found content element: ${anchorId}_content`);
          
					// Check if the content element has proper section content (not just a fragment)
					const contentText = contentElement.textContent?.trim() || '';
					const contentLines = contentText.split('\n').filter(line => line.trim().length > 10);
          
					// For ecode360, ensure content starts properly and contains section structure
					const hasProperStart = /^(§\s*\d+-\d+|[A-Z]\.)/m.test(contentText) || 
																 contentText.includes('Surface and subsurface water');
					const hasSubsections = /[A-Z]\.\s+/.test(contentText); // Look for A., B., C. pattern
          
					if (contentLines.length >= 5 && contentText.length > 200 && hasProperStart && hasSubsections) {
						// Content seems substantial, use it
						const sectionContainer = document.createElement('div');
						sectionContainer.appendChild(anchorElement.cloneNode(true));
						sectionContainer.appendChild(contentElement.cloneNode(true));
						targetElement = sectionContainer;
						console.log(`  📍 Extracted title + content elements (${contentText.length} chars, ${contentLines.length} lines)`);
					} else {
						// Content is too brief, fall back to litem extraction
						console.log(`  ⚠️  Content element too brief (${contentText.length} chars, ${contentLines.length} lines), trying litem extraction`);
						contentElement = null; // Force fallback to Strategy 2
					}
				}
        
				if (!contentElement) {
					// Strategy 2: Extract all content for this section including litem divs
					// For ecode360, look beyond immediate siblings to find all related content
					const sectionContainer = document.createElement('div');
          
					// Add the title element
					sectionContainer.appendChild(anchorElement.cloneNode(true));
          
					// Get the section number from the anchor element
					const sectionMatch = anchorElement.textContent?.match(/§\s*(\d+-\d+)/);
					const currentSectionNumber = sectionMatch ? sectionMatch[1] : null;
          
					console.log(`  📍 Looking for content related to section: ${currentSectionNumber}`);
          
					// Find all litem divs that follow this section until the next section
					const allElements = Array.from(document.querySelectorAll('*'));
					const anchorElementIndex = allElements.indexOf(anchorElement);
          
					let extractedItems = 0;
					for (let i = anchorElementIndex + 1; i < allElements.length; i++) {
						const elem = allElements[i] as Element;
            
						// Stop at the next major section (different § number)
						if (elem.className && elem.className.includes('contentTitle')) {
							const nextSectionMatch = elem.textContent?.match(/§\s*(\d+-\d+)/);
							if (nextSectionMatch && nextSectionMatch[1] !== currentSectionNumber) {
								console.log(`  📍 Found next section ${nextSectionMatch[1]}, stopping extraction`);
								break;
							}
						}
            
						// Extract litem content divs that contain the detailed statute text
						if (elem.className && elem.className.includes('litem')) {
							// Check if this litem belongs to our section by looking at the alt attribute
							const altAttr = elem.querySelector('a')?.getAttribute('alt');
							if (altAttr && currentSectionNumber && altAttr.startsWith(currentSectionNumber.replace('-', '-'))) {
								sectionContainer.appendChild(elem.cloneNode(true));
								extractedItems++;
								console.log(`  📍 Added litem part: ${altAttr}`);
							} else if (!altAttr || !currentSectionNumber) {
								// Fallback: if we can't determine section ownership, include it
								sectionContainer.appendChild(elem.cloneNode(true));
								extractedItems++;
							}
						}
					}
          
					targetElement = sectionContainer;
					console.log(`  📍 Extracted title + ${extractedItems} content items for section ${currentSectionNumber}`);
				}
			} else {
				console.log(`  ⚠️  Anchor element #${anchorId} not found, using full page`);
			}
		}

		const structuredText = extractStructuredText(targetElement);

		// Fallback extraction for pages with little semantic markup.
		let text = structuredText ||
			((targetElement && "textContent" in targetElement
				? targetElement.textContent
				: "") ||
			document.textContent ||
			"");

		// Replace "chevron_right" with newlines for better navigation structure
		text = text.replace(/chevron_right/g, "\n");

		// Remove specific navigation elements that commonly appear
		const navigationTerms = [
			"arrow_back",
			"arrow_forward",
			"chevron_right",
			"chevron_left",
			"add_alert",
			"help_center",
			"material-icons",
		];

		navigationTerms.forEach((term) => {
			text = text.replace(new RegExp(`\\b${term}\\b`, "gi"), "");
		});

		// Look for municipality name pattern and remove everything before it
		const municipalityPatterns = [
			/(?:Village|Town|City)\s+of\s+[A-Za-z\s\-]+/i,
			/[A-Za-z][A-Za-z\s\-]{0,80}\s+(?:Village|Town|City)\b/i,
		];

		for (const pattern of municipalityPatterns) {
			const match = text.match(pattern);
			if (match) {
				const startIndex = text.indexOf(match[0]);
				// Only trim when municipality header appears near the top; late matches
				// often come from footer/contact blocks and can hide main content.
				if (startIndex > 50 && startIndex <= 1200) {
					// Remove content before municipality name only when enough content remains.
					const candidate = text.substring(startIndex).trim();
					if (candidate.length > 200) {
						text = candidate;
						break;
					}
				}
			}
		}

		text = normalizeExtractedText(text);

		if (!text.trim()) {
			const regexFallback = html
				.replace(/<(h[1-6]|p|li|div|section|article|br|tr|td|th)[^>]*>/gi, "\n")
				.replace(/<\/\s*(h[1-6]|p|li|div|section|article|tr|td|th)\s*>/gi, "\n")
				.replace(/<[^>]*>/g, " ");
			text = normalizeExtractedText(regexFallback);
		}

		// If we extracted a specific section, add metadata
		if (anchorId && document.body && targetElement !== document.body) {
			const sectionInfo = `[Extracted from anchor #${anchorId}]\n\n`;
			text = sectionInfo + text;
			console.log(`  ✅ Successfully extracted ${text.length} characters from anchor section`);
		}

		// Improved validation: Check for meaningful content rather than just length ratio
		// Modern web pages have lots of CSS/JS, so 10% ratio is too strict
		const hasSubstantialContent = text.length > 500; // At least 500 characters
		const hasStatuteKeywords =
			/\b(chapter|section|article|ordinance|code|§|subsection|violation|penalty)\b/i.test(
				text,
			);
		const seemsLikeStatute = hasSubstantialContent && hasStatuteKeywords;

		// Only reject conversion if we got almost nothing or it doesn't look like legal text
		if (text.length < 50) {
			console.log(
				"  Warning: HTML conversion resulted in very short text (<50 chars), keeping conversion anyway",
			);
		}

		// Additional check for completely garbled content
		if (text.length > 0 && !seemsLikeStatute && text.length < 200) {
			console.log(
				"  Warning: Converted text appears to lack statute content, but using conversion",
			);
		}

		return text;
	} catch (error) {
		// Truncate error message to prevent CSS dumping
		const truncatedMessage = error instanceof Error && error.message.length > 200 
			? error.message.substring(0, 200) + "...[truncated]"
			: error instanceof Error ? error.message : String(error);
		console.log(
			"  Warning: Failed to parse HTML, keeping conversion attempt:",
			truncatedMessage,
		);
		// Even if JSDOM fails, try to do basic HTML stripping
		return html
			.replace(/<[^>]*>/g, " ")
			.replace(/\s+/g, " ")
			.trim();
	}
}

// Command line interface
async function main() {
	const args = process.argv.slice(2);

	if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
		console.log(`Usage:
  tsx scripts/utils/simpleHtmlToText.ts <input.html> [output.txt]

Parameters:
  input.html     HTML file to convert
  output.txt     Output text file (optional, defaults to stdout)

Features:
  - Removes navigation elements and scripts/styles
  - Preserves paragraph structure and meaningful content
  - Supports anchor-based section extraction (when used as library)

Examples:
  tsx scripts/utils/simpleHtmlToText.ts policy.html policy.txt
  tsx scripts/utils/simpleHtmlToText.ts policy.html > output.txt

Library Usage:
  import { convertHtmlToText } from './lib/simpleHtmlToText.js';
  const text = convertHtmlToText(html);                    // Full document
  const text = convertHtmlToText(html, 'section-id');      // Specific section`);
		return;
	}

	const inputFile = args[0];
	const outputFile = args[1];

	try {
		console.log(`Reading HTML from: ${inputFile}`);
		const html = await fs.readFile(inputFile, "utf-8");
    
		console.log(`Converting HTML to text...`);
		const text = convertHtmlToText(html);

		if (outputFile) {
			console.log(`Writing text to: ${outputFile}`);
			await fs.writeFile(outputFile, text, "utf-8");
			console.log(`✅ Conversion complete! Output saved to ${outputFile}`);
		} else {
			console.log("📄 Converted text:");
			console.log("=" .repeat(50));
			console.log(text);
		}
	} catch (error) {
		console.error("❌ Error:", error);
		process.exit(1);
	}
}
