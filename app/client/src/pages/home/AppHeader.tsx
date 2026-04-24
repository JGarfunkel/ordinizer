import { Scale, AlertCircle, Grid } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui";
import type { Realm } from "@ordinizer/core";

const contextPath = import.meta.env.BASE_URL;

interface AppHeaderProps {
  selectedRealmId: string;
  realms: Realm[] | undefined;
  entityType: string;
  documentTypeCapitalized: string;
  onRealmChange: (realmId: string) => void;
}

export function AppHeader({
  selectedRealmId,
  realms,
  entityType,
  documentTypeCapitalized,
  onRealmChange,
}: AppHeaderProps) {
  return (
    <header className="bg-white shadow-sm border-b border-gray-200">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 bg-civic-blue rounded-lg flex items-center justify-center">
              <Scale className="text-white text-lg" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-gray-900">Ordinizer</h1>
              <p className="text-sm text-civic-gray-light">
                {entityType} {documentTypeCapitalized} Comparison
              </p>
            </div>
          </div>
          <div className="flex items-center space-x-4">
            <div className="flex items-center space-x-2">
              <Select value={selectedRealmId} onValueChange={onRealmChange}>
                <SelectTrigger
                  className="w-96 h-8 text-sm border-gray-300"
                  data-testid="select-realm"
                >
                  <SelectValue placeholder="Select realm..." />
                </SelectTrigger>
                <SelectContent>
                  {realms?.map((realm: any) => (
                    <SelectItem
                      key={realm.id}
                      value={realm.id}
                      data-testid={`realm-${realm.id}`}
                    >
                      {realm.displayName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <a
              href={`${contextPath}matrix/${selectedRealmId}`}
              className="text-civic-gray-light hover:text-gray-900 transition-colors font-medium flex items-center gap-1"
              title="View complete analysis matrix for all municipalities and domains"
            >
              <Grid className="w-4 h-4" />
              Matrix
            </a>
          </div>
        </div>
      </div>
    </header>
  );
}
