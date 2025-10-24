#!/usr/bin/env tsx

import fs from 'fs-extra';
import path from 'path';

// Manually extract and format New Castle Property Maintenance statute
const formattedText = `Chapter 93 Property Maintenance

[HISTORY: Adopted by the Town Board of the Town of New Castle 9-20-2022 by L.L. No. 11-2022. Amendments noted where applicable.]

§ 93-1 Purpose.

The existence of unsanitary or deteriorating building and/or property conditions, which typically occur on so-called "zombie" properties, can endanger public welfare, jeopardize the security of private property, and adversely affect the value of surrounding buildings and properties. It is the purpose of this chapter to provide the Town's Building Inspector with the enforcement tools needed to ensure that such conditions are remediated in a prompt, fair and effective manner in order to safeguard the interests of public health, safety, and welfare.

§ 93-2 Compliance required.
[Amended 2-25-2025 by L.L. No. 3-2025]

	A. It is the responsibility of every owner or occupant of real property to keep their property in a well maintained and sanitary appearance and condition so as not to adversely affect the value and condition of surrounding properties and the neighborhood.

	B. It shall be unlawful for the owner or occupant of any residential, commercial, or industrial property to allow any condition on their property that violates any provision of the Property Maintenance Code of the State of New York or the Town Code of the Town of New Castle. Residential, commercial, and industrial buildings, whether occupied or vacant, and accessory structures, shall be maintained in conformity with the provisions of this chapter.

	C. Steps, walks, driveways, egress windows and doors, and similar areas shall be maintained so as to afford safe passage to all principal and accessory structures under normal use and weather conditions. Any obstructions or hazards that impede such access areas shall be promptly removed or corrected to ensure safe passage to occupants, emergency medical services, police and fire personnel.

	D. In residential districts, the curtilage, defined as up to 15 feet of the perimeter of the principal structure, shall be maintained free from uncultivated vegetation in excess of 10 inches, such as grasses, brush, and briars, but excluding trees, shrubs, and other cultivated vegetation plants, such as flower and pollinator gardens, propagules or plants germinated from garden-grown stock as well as naturally recruited from wild populations and grown or cared for in a controlled environment.

§ 93-3 Penalties for offenses.

Any owner or occupant who violates any provision of the Property Maintenance Code of the State of New York or this chapter shall be subject to a penalty of up to $200 for each day during which such violation continues.

§ 93-4 Compliance procedures.

Pursuant to the authority provided in Sections 106 and 301 of the Property Maintenance Code of the State of New York, the following compliance procedures are established:

	A. Upon observing a violation of the Property Maintenance Code or this chapter, the Building Inspector shall serve upon the owner and (if the subject premises is not owner-occupied) the occupant of the subject property, by certified mail, return receipt requested, and first-class mail addressed to the premises and (if different) the owner's last-known address, a written notice of violation and order to correct such violation within 30 days. If an owner or occupant of the subject premises cannot be located with reasonable diligence, such notice may be provided by causing same to be published once in the official newspaper of the Town.

	B. If an owner or occupant fails to comply with such notice of violation within 30 days of mailing or publication thereof, and the Building Inspector further determines that such violation has created a public nuisance or a condition that endangers public health, safety or welfare, the Building Inspector shall so advise the Town Board in writing. Thereafter, the Town Board shall hold a public hearing in regard to the violation. The public hearing shall be held upon notice given pursuant to Chapter 16 and served upon the owners, occupants, and any other persons having an interest in the premises as shown on the Town tax records or on the records of the Westchester County Clerk's office. Such notice shall be mailed to such person(s) by certified mail, return receipt requested, and first-class mail, at the last known address as shown on the Town of New Castle tax records, advising of their right to attend the public hearing and opportunity to be heard. The Building Inspector shall also post at each entrance to such premises the following notice: "This property is the subject of a pending Notice of Violation issued by the Town of New Castle Building Department for violating New York State and Town of New Castle property maintenance standards."

	C. If the owner or occupant of the subject premises fails to correct or remove such violation within 10 days of the public hearing, the Town may correct or remove the violation and take such further actions as reasonably necessary to prevent further violations arising from neglect or abandonment of the premises. All costs and expenses incurred by the Town in furtherance thereof, including all penalties, shall be charged against the owner of the property. An itemized bill of costs and expenses incurred by the Town shall be mailed to the property owner by certified mail, return receipt requested. The owner shall pay the Town such costs, expenses, and penalties within 30 days of mailing of the itemized bill of costs.

	D. In the event such bill of costs is not paid in full within 30 days following mailing thereof, such costs shall become and be a lien upon the real property that was the subject of the violation and shall be added to and become part of the property taxes to be assessed and levied upon such property by the Town and shall bear interest at the same rate as and be collected and enforced in the same manner as unpaid taxes.

	E. In the case of any violation of this chapter that, in the opinion of the Building Inspector, involves a clear and imminent danger to human life, safety, or health, the Building Inspector shall promptly provide written notice of such violation to the owner or occupant of the subject premises personally or by certified mail, which notice shall include a description of the premises, an explanation of the dangerous condition, and an order requiring such condition to be removed or made safe within a stated time. The owner or occupant of the subject premises shall commence correction of the unsafe condition within 10 days from service of such notice and shall complete all necessary remedial work with reasonable dispatch. If such remedial action is not timely commenced or completed, the Building Inspector shall enter the subject premises and remedy the dangerous condition at such cost as may be reasonably necessary. All such costs incurred by the Town shall become a lien upon the real property that was the subject of the violation in the same manner as described in Subsections C and D of this section.

§ 93-5 Supplemental remedies.

In addition to the remedies set forth in this chapter, the Town reserves the right to pursue any and all remedies available, including, but not limited to, those set forth in Articles 13 and 19-A of the New York State Real Property Actions and Proceedings Law, and the Building Inspector is authorized to take any and all action specified in these articles.

§ 93-6 Severability.

If any clause, sentence, paragraph, section, or part of this chapter shall be adjudged by any court of competent jurisdiction to be invalid, such judgment shall not affect, impair, or invalidate the remainder of this chapter but shall be confined in operation to the clause, sentence, paragraph, section, or part adjudged invalid.

§ 93-7 When effective.

This chapter shall be effective immediately upon filing with the Secretary of State.`;

async function updateNewCastleStatute() {
  const statutePath = path.join(process.cwd(), '..', 'data', 'property-maintenance', 'NY-NewCastle-Town', 'statute.txt');
  await fs.writeFile(statutePath, formattedText, 'utf-8');
  console.log('✅ New Castle statute manually formatted with proper sections and structure');
}

updateNewCastleStatute().catch(console.error);