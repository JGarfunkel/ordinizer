import { Ban, RotateCcw, X, Check, ChevronsUpDown } from "lucide-react";
import { Button } from "../../ui";
import { Popover, PopoverContent, PopoverTrigger } from "../../ui";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "../../ui";
import { queryClient } from "../../lib/queryClient";
import { apiPath } from "../../lib/apiConfig";
import type { Entity, Realm } from "@civillyengaged/ordinizer-core";

interface EntityComboboxProps {
  selectedEntityId: string;
  selectedDomainId: string;
  selectedRealmId: string;
  municipalities: Entity[] | undefined;
  municipalityComboOpen: boolean;
  currentRealm: Realm | undefined;
  onOpenChange: (open: boolean) => void;
  onEntityChange: (entityId: string) => void;
  onClearEntity: () => void;
  onResetAll: () => void;
}

export function EntityCombobox({
  selectedEntityId,
  selectedDomainId,
  selectedRealmId,
  municipalities,
  municipalityComboOpen,
  currentRealm,
  onOpenChange,
  onEntityChange,
  onClearEntity,
  onResetAll,
}: EntityComboboxProps) {
  const entityLabel =
    currentRealm?.entityType === "school-districts" ? "school district" : "municipality";

  const handleRefreshCache = () => {
    queryClient.invalidateQueries({ queryKey: [apiPath("municipalities")] });
    queryClient.invalidateQueries({ queryKey: [apiPath("domains")] });
    queryClient.invalidateQueries({
      queryKey: [apiPath(`map-boundaries?realm=${selectedRealmId}`)],
    });
    if (selectedEntityId && selectedDomainId) {
      queryClient.invalidateQueries({
        queryKey: [apiPath("analyses"), selectedEntityId, selectedDomainId],
      });
      queryClient.invalidateQueries({
        queryKey: [apiPath("municipalities"), selectedEntityId, "domains"],
      });
    }
    if (selectedDomainId) {
      queryClient.invalidateQueries({
        queryKey: [apiPath("domains"), selectedDomainId, "summary"],
      });
    }
  };

  return (
    <div className="flex items-center gap-2 relative z-10">
      <Popover open={municipalityComboOpen} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={municipalityComboOpen}
            className="w-1/2 justify-between"
          >
            {selectedEntityId
              ? municipalities?.find((m) => m.id === selectedEntityId)?.displayName
              : `Choose a ${entityLabel}...`}
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[400px] p-0" style={{ zIndex: 9999 }}>
          <Command>
            <CommandInput placeholder={`Search ${entityLabel}s...`} />
            <CommandEmpty>No {entityLabel} found.</CommandEmpty>
            <CommandGroup>
              <CommandList>
                {municipalities?.map((municipality) => (
                  <CommandItem
                    key={municipality.id}
                    value={`${municipality.id} ${municipality.displayName}`}
                    onSelect={() => {
                      onEntityChange(municipality.id);
                      onOpenChange(false);
                    }}
                  >
                    <Check
                      className={`mr-2 h-4 w-4 ${
                        selectedEntityId === municipality.id ? "opacity-100" : "opacity-0"
                      }`}
                    />
                    {municipality.displayName}
                  </CommandItem>
                ))}
              </CommandList>
            </CommandGroup>
          </Command>
        </PopoverContent>
      </Popover>

      {(selectedEntityId || selectedDomainId) && (
        <div className="flex gap-1">
          {selectedEntityId && (
            <Button
              variant="outline"
              size="sm"
              onClick={onClearEntity}
              className="text-gray-600 hover:text-gray-900"
              title="Clear selected municipality"
            >
              <Ban size={14} />
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefreshCache}
            className="text-gray-600 hover:text-gray-900"
            title="Refresh data from server"
          >
            <RotateCcw size={14} />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onResetAll}
            className="text-gray-600 hover:text-gray-900"
            title="Reset all selections"
          >
            <X size={14} />
          </Button>
        </div>
      )}
    </div>
  );
}
