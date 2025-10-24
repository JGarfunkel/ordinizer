export default function FAQ() {
  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow-sm border-b">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-6">
            <div className="flex items-center">
              <a href="/" className="text-2xl font-bold text-civic-blue hover:text-civic-blue-dark transition-colors">
                Ordinizer
              </a>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="bg-white rounded-lg shadow-sm p-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-6">Frequently Asked Questions</h1>
          
          <div className="prose prose-lg max-w-none">
            <p className="text-lg text-gray-700 mb-8">
              The NY Environmental Ordinizer (for "Ordinance Organizer") is a way of analyzing and illustrating environmental statutes across different municipalities.
            </p>

            <div className="space-y-8">
              <div>
                <h3 className="text-xl font-semibold text-gray-900 mb-3">
                  Q: Who is responsible for this website?
                </h3>
                <p className="text-gray-700">
                  The data collection is a collaboration between NYSACC and Healthy Yards. CivillyEngaged did the programming.
                </p>
              </div>

              <div>
                <h3 className="text-xl font-semibold text-gray-900 mb-3">
                  Q: How is the statute analysis done?
                </h3>
                <p className="text-gray-700">
                  For each domain, we've come up with a set of domain-specific questions. We then review the AI analysis vs the statute text to ensure it is correct.
                </p>
              </div>

              <div>
                <h3 className="text-xl font-semibold text-gray-900 mb-3">
                  Q: How are the ratings done?
                </h3>
                <p className="text-gray-700">
                  We set weights to the questions based on environmental impact.
                </p>
              </div>

              <div>
                <h3 className="text-xl font-semibold text-gray-900 mb-3">
                  Q: Can we add data from our county?
                </h3>
                <p className="text-gray-700">
                  Yes, contact us, we are looking to add additional counties through NY State.
                </p>
              </div>

              <div>
                <h3 className="text-xl font-semibold text-gray-900 mb-3">
                  Q: Can we use the Ordinizer tool for statutes?
                </h3>
                <p className="text-gray-700">
                  Contact CivillyEngaged.
                </p>
              </div>

              <div>
                <h3 className="text-xl font-semibold text-gray-900 mb-3">
                  Q: What are the future goals of the project?
                </h3>
                <div className="text-gray-700 space-y-4">
                  <p>
                    Producing this data in this format can help citizens & residents understand the laws better. Additionally, we aim to assist municipal environmental (conservation & sustainability) boards in identifying gaps in their current laws and adapting them to align with other towns' legislation.
                  </p>
                  <p>
                    Ultimately, we want to be able to measure success -- will better laws, and better awareness of the laws, lead to the desired behavior? It is currently hard to measure this currently -- even measuring violations could be misleading (a high number of violations might be indicative of rigorous enforcement or otherwise lax fidelity to the laws). This is in our future work.
                  </p>
                </div>
              </div>
            </div>

            <div className="mt-12 pt-8 border-t border-gray-200">
              <p className="text-gray-600 text-center">
                <a href="/" className="text-civic-blue hover:text-civic-blue-dark font-medium">
                  ← Back to Ordinizer
                </a>
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}