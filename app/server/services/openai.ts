import OpenAI from "openai";

// the newest OpenAI model is "gpt-4o" which was released May 13, 2024. do not change this unless explicitly requested by the user
const openai = new OpenAI({ 
  apiKey: process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY_ENV_VAR || "default_key" 
});

export interface StatuteQuestion {
  id: number;
  text: string;
  category: string;
}

export interface StatuteAnalysis {
  questionId: number;
  answer: string;
  sourceReference: string;
  confidence: number;
}

export async function generateQuestionsForDomain(
  domainName: string,
  domainDescription: string,
  sampleStatutes: string[]
): Promise<StatuteQuestion[]> {
  try {
    const prompt = `You are analyzing municipal statutes for the domain "${domainName}" (${domainDescription}).

Based on the following sample statutes, generate a comprehensive list of plain-language questions that would help residents understand the key differences between municipalities in this domain.

Sample statutes:
${sampleStatutes.map((statute, i) => `--- Sample ${i + 1} ---\n${statute.substring(0, 2000)}`).join('\n\n')}

Generate 5-10 important questions that would reveal meaningful differences between municipalities. Focus on practical aspects that residents care about like:
- Requirements and procedures
- Fees and penalties  
- Restrictions and permissions
- Timelines and processes
- Exceptions and exemptions

Return your response as JSON in this format:
{
  "questions": [
    {
      "id": 1,
      "text": "What are the permit requirements for tree removal on private property?",
      "category": "permits"
    },
    {
      "id": 2, 
      "text": "What are the penalties for unauthorized tree removal?",
      "category": "penalties"
    }
  ]
}`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    });

    const result = JSON.parse(response.choices[0].message.content || "{}");
    return result.questions || [];
  } catch (error) {
    console.error("Failed to generate questions:", error);
    throw new Error(`Failed to generate questions for domain ${domainName}: ${error}`);
  }
}

export async function analyzeStatuteForQuestion(
  statute: string,
  question: string,
  municipalityName: string,
  domainName: string
): Promise<StatuteAnalysis> {
  try {
    const prompt = `You are analyzing a municipal statute to answer a specific question in plain language.

Municipality: ${municipalityName}
Domain: ${domainName}
Question: ${question}

Statute text:
${statute}

Please analyze this statute and provide a clear, plain-language answer to the question. If the statute doesn't directly address the question, indicate that in your response.

Your answer should:
- Be written in plain English that residents can understand
- Include specific details like fees, timeframes, requirements
- Reference the relevant statute section if identifiable
- Be honest about limitations or unclear areas

Return your response as JSON in this format:
{
  "answer": "A clear, detailed answer to the question in plain language",
  "sourceReference": "Specific statute section or code reference if identifiable", 
  "confidence": 0.85
}`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    });

    const result = JSON.parse(response.choices[0].message.content || "{}");
    
    return {
      questionId: 0, // Will be set by caller
      answer: result.answer || "Unable to analyze statute for this question",
      sourceReference: result.sourceReference || "",
      confidence: result.confidence || 0
    };
  } catch (error) {
    console.error("Failed to analyze statute:", error);
    throw new Error(`Failed to analyze statute: ${error}`);
  }
}
