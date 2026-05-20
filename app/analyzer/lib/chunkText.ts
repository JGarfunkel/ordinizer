function estimateTokens(text: string): number {
	const base = Math.ceil(text.length / 3);
	const punct = (text.match(/[§\(\)\[\]\.,:;]/g) || []).length * 0.1;
	const nums = (text.match(/\d+/g) || []).length * 0.2;
	return Math.ceil(base + punct + nums);
}

/** Split statute text into token-safe chunks for embedding */
export function chunkText(text: string, maxChunkSize = 1000): string[] {
	const chunks: string[] = [];
	const maxTokens = 5000;
	console.log(`Starting intelligent chunking: ${text.length} characters, max chunk size: ${maxChunkSize}`);

	let sections: string[];
	const doubleNL = text.split(/\.\n\n/).filter(s => s.trim())
		.map((s, i, a) => i < a.length - 1 && !s.endsWith(".") ? s + "." : s);

	if (doubleNL.length > 1 && doubleNL.every(s => s.length < maxChunkSize)) {
		sections = doubleNL;
		console.log(`Split into ${sections.length} sections by .\\n\\n separators`);
	} else {
		const singleNL = text.split(/\.\n/).filter(s => s.trim())
			.map((s, i, a) => i < a.length - 1 && !s.endsWith(".") ? s + "." : s);
		if (singleNL.length > 1 && singleNL.some(s => s.length < maxChunkSize * 0.8)) {
			sections = singleNL;
			console.log(`Split into ${sections.length} sections by .\\n separators`);
		} else {
			sections = text.split(/(?=§\s*\d+|Section\s+\d+|SECTION\s+\d+|Article\s+[IVXLCDM]+)/i).filter(s => s.trim());
			console.log(`Split into ${sections.length} sections by § markers (fallback)`);
		}
	}

	for (const section of sections) {
		const sectionTokens = estimateTokens(section);
		if (section.length <= maxChunkSize && sectionTokens <= maxTokens) {
			chunks.push(section.trim());
		} else {
			const sentences = section.split(/(?<=[.!?])\s+/).filter(s => s.trim());
			let current = "";
			for (const sentence of sentences) {
				const proposed = current + (current ? " " : "") + sentence;
				if ((proposed.length > maxChunkSize || estimateTokens(proposed) > maxTokens) && current.trim()) {
					chunks.push(current.trim());
					current = sentence;
				} else {
					current = proposed;
				}
			}
			if (current.trim()) chunks.push(current.trim());
		}
	}

	const minTokens = 100;
	const merged: string[] = [];
	for (const chunk of chunks) {
		if (estimateTokens(chunk) < minTokens && merged.length > 0) {
			merged[merged.length - 1] = merged[merged.length - 1] + " " + chunk;
		} else {
			merged.push(chunk);
		}
	}

	const validated = merged.filter(c => {
		const t = estimateTokens(c);
		if (t > maxTokens) { console.warn(`⚠️ Filtering oversized chunk: ~${t} tokens`); return false; }
		if (c.length > 12000) { console.warn(`⚠️ Filtering large character chunk: ${c.length} chars`); return false; }
		return true;
	});

	console.log(`Chunking complete: ${chunks.length} raw → ${merged.length} after merge → ${validated.length} validated`);
	return validated;
}
