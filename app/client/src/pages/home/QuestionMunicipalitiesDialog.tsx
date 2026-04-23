import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "../../ui";

interface QuestionMunicipalitiesPopupData {
  questionId: string;
  municipalities: Array<{ name: string; answer: string }>;
}

interface QuestionMunicipalitiesDialogProps {
  popup: QuestionMunicipalitiesPopupData | null;
  onClose: () => void;
}

export function QuestionMunicipalitiesDialog({
  popup,
  onClose,
}: QuestionMunicipalitiesDialogProps) {
  return (
    <Dialog open={!!popup} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Municipalities with Specific Requirements</DialogTitle>
          <DialogDescription>
            The following municipalities have specified requirements for this question:
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 mt-4">
          {popup?.municipalities.map((municipality, index) => (
            <div key={index} className="border border-gray-200 rounded-lg p-4">
              <h4 className="font-semibold text-gray-900 mb-2">{municipality.name}</h4>
              <p className="text-sm text-gray-600 leading-relaxed">{municipality.answer}</p>
            </div>
          ))}
          {popup?.municipalities.length === 0 && (
            <p className="text-gray-500 text-center py-4">
              No municipalities have specified requirements for this question yet.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
