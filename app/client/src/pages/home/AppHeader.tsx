import { Scale, Grid } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui";
import type { Realm } from "@civillyengaged/ordinizer-core";
import type { ReactNode } from "react";
import { useBasePath } from "../../contexts/BasePathContext";

interface AppHeaderProps {
  selectedRealmId: string;
  realms: Realm[] | undefined;
  showRealmSelector: boolean;
  onRealmChange: (realmId: string) => void;
  children?: ReactNode;
}

export function AppHeader({
  selectedRealmId,
  realms,
  showRealmSelector,
  onRealmChange,
  children,
}: AppHeaderProps) {
  const { buildPath } = useBasePath();
  const matrixHref = selectedRealmId ? buildPath(`/matrix/${selectedRealmId}`) : buildPath("/");

  return (
    <div className="flex flex-col xl:flex-row xl:items-center xl:justify-between gap-3">
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-9 h-9 bg-civic-blue rounded-lg flex items-center justify-center shrink-0">
          <Scale className="text-white text-lg" />
        </div>
        {children}
      </div>

      <div className="flex flex-col md:flex-row md:items-center gap-2 md:gap-3">
        {showRealmSelector && (
          <Select value={selectedRealmId} onValueChange={onRealmChange}>
            <SelectTrigger
              className="h-9 text-sm border-gray-300 w-full md:w-[18rem] max-w-full [&>span]:truncate"
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
        )}

        <a
          href={matrixHref}
          className="h-9 w-9 rounded-md border border-gray-300 text-civic-gray-light hover:text-gray-900 hover:bg-gray-50 transition-colors flex items-center justify-center"
          title="View complete analysis matrix"
          aria-label="View matrix"
        >
          <Grid className="w-4 h-4" />
        </a>
      </div>
    </div>
  );
}
