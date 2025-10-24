#!/usr/bin/env tsx

import fs from 'fs-extra';
import path from 'path';

// Create the New Castle analysis directly with the recovered data we had earlier
const newCastleAnalysis = {
  "municipality": {
    "id": "NY-NewCastle-Town",
    "displayName": "New Castle - Town"
  },
  "domain": {
    "id": "property-maintenance",
    "displayName": "Property Maintenance"
  },
  "questions": [
    {
      "id": "1",
      "question": "What are the specific property maintenance requirements for residents, such as lawn care or exterior building upkeep?",
      "answer": "Residents of New Castle are required to keep their properties well-maintained and sanitary to avoid negatively impacting the neighborhood. Specifically, in residential areas, the area within 15 feet of the main building must be kept free of uncultivated vegetation taller than 10 inches, like grasses and brush, but this does not include trees, shrubs, or cultivated plants like flower gardens. Additionally, steps, walkways, driveways, and similar areas must be kept clear to ensure safe access. If a violation is observed, the owner or occupant will receive a notice and must correct the issue within 30 days. Failure to comply may lead to further action if the violation poses a public nuisance or safety risk.",
      "confidence": 95,
      "sourceRefs": ["§ 93-2", "§ 93-4"]
    },
    {
      "id": "2", 
      "question": "What procedures must be followed to obtain permits for renovations or additions to a property?",
      "answer": "Not specified in the statute.",
      "confidence": 20,
      "sourceRefs": []
    },
    {
      "id": "3",
      "question": "Are there any fees associated with property maintenance violations, and how are they calculated?",
      "answer": "Yes, there are fees associated with property maintenance violations. If a property owner violates the Property Maintenance Code, they can be fined up to $200 for each day the violation continues (Section 93-3). Additionally, if the Town incurs costs to correct or remove the violation, these costs will be billed to the property owner. The owner must pay these costs within 30 days of receiving the bill. If not paid, the costs become a lien on the property and are added to the property taxes, accruing interest like unpaid taxes (Sections 93-4C, 93-4D).",
      "confidence": 95,
      "sourceRefs": ["93-3", "93-4C", "93-4D"]
    },
    {
      "id": "4",
      "question": "What are the penalties for failing to comply with property maintenance regulations?",
      "answer": "If you fail to comply with property maintenance regulations in New Castle, you can be fined up to $200 for each day the violation continues. Additionally, if you don't fix the issue within 10 days after a public hearing, the Town may step in to correct the problem and charge you for all related costs and penalties. These costs will be sent to you via certified mail.",
      "confidence": 90,
      "sourceRefs": ["93-3", "93-4C"]
    },
    {
      "id": "5",
      "question": "What restrictions are in place regarding the disposal of solid waste on private properties?",
      "answer": "Not specified in the statute.",
      "confidence": 0,
      "sourceRefs": []
    },
    {
      "id": "6",
      "question": "What is the timeline for resolving a property maintenance violation before penalties are applied?",
      "answer": "Once a property maintenance violation is observed, the Building Inspector will send a notice to the property owner and occupant, giving them 30 days to correct the violation. If the violation is not corrected within 10 days after a public hearing, the Town may step in to fix the issue and charge the costs to the property owner. If the violation poses an immediate danger, the owner must start fixing it within 10 days of receiving the notice and complete the work quickly. If not, the Town will fix it and charge the owner. All costs must be paid within 30 days of receiving the bill, or they will become a lien on the property and added to the property taxes.",
      "confidence": 100,
      "sourceRefs": ["93-4A", "93-4C", "93-4E"]
    },
    {
      "id": "7",
      "question": "Are there any exceptions to the property maintenance rules for historical properties or other special cases?",
      "answer": "Not specified in the statute.",
      "confidence": 0,
      "sourceRefs": []
    },
    {
      "id": "8",
      "question": "How can residents appeal a citation for a property maintenance violation?",
      "answer": "Not specified in the statute.",
      "confidence": 0,
      "sourceRefs": []
    },
    {
      "id": "9",
      "question": "What permissions are needed to erect fences or other structures on residential properties?",
      "answer": "Not specified in the statute.",
      "confidence": 0,
      "sourceRefs": []
    },
    {
      "id": "10",
      "question": "Are there any programs or assistance available for low-income residents to meet property maintenance standards?",
      "answer": "Not specified in the statute.",
      "confidence": 0,
      "sourceRefs": []
    },
    {
      "id": "11",
      "question": "Does the property maintenance law go beyond the property lot lines (such as to the curb)?",
      "answer": "Not specified in the statute.",
      "confidence": 0,
      "sourceRefs": []
    },
    {
      "id": "12",
      "question": "What are the inspection procedures for property maintenance compliance?",
      "answer": "Not specified in the statute.",
      "confidence": 0,
      "sourceRefs": []
    }
  ]
};

async function createAnalysis() {
  const analysisPath = path.join(process.cwd(), '..', 'data', 'property-maintenance', 'NY-NewCastle-Town', 'analysis.json');
  await fs.writeJson(analysisPath, newCastleAnalysis, { spaces: 2 });
  console.log('✅ Created New Castle Property Maintenance analysis with detailed Q&A');
}

createAnalysis().catch(console.error);