import { X } from "lucide-react";
import type { Entity } from "@civillyengaged/ordinizer-core";

interface MunicipalityAnswerPopupData {
  questionId: number;
  municipalityId: string;
  answer: string;
  score: number;
  confidence: number;
}

interface MunicipalityAnswerPopupProps {
  popup: MunicipalityAnswerPopupData | null;
  municipalities: Entity[] | undefined;
  onClose: () => void;
  onViewFullAnalysis: (municipalityId: string) => void;
}

export function MunicipalityAnswerPopup({
  popup,
  municipalities,
  onClose,
  onViewFullAnalysis,
}: MunicipalityAnswerPopupProps) {
  if (!popup) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg max-w-2xl w-full max-h-[80vh] overflow-y-auto">
        <div className="p-6">
          <div className="flex justify-between items-start mb-4">
            <div>
              <h3 className="text-lg font-semibold">
                {municipalities?.find((m) => m.id === popup.municipalityId)?.displayName}
              </h3>
              <p className="text-sm text-gray-600">Question {popup.questionId} Response</p>
            </div>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
              <X size={24} />
            </button>
          </div>
          <div className="space-y-4">
            <div className="flex gap-4 text-sm text-gray-600">
              <span>Score: {(popup.score * 10).toFixed(1)}/10.0</span>
              <span>Confidence: {popup.confidence}%</span>
            </div>
            <div className="p-4 bg-gray-50 rounded-lg">
              <p className="text-gray-800 leading-relaxed">{popup.answer}</p>
            </div>
            <div className="text-center pt-2">
              <button
                onClick={() => onViewFullAnalysis(popup.municipalityId)}
                className="text-sm text-civic-blue hover:text-civic-blue-dark underline"
              >
                View full analysis for this municipality
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
