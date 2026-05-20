import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "../ui";
import { ExternalLink, Files } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui";
import * as React from "react";

export interface SourceMapLink {
  url: string;
  title: string;
}

export interface SourcesPopupProps {
  entity: string;
  domainName: string;
  sources: SourceMapLink[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SourcesPopup({ entity, domainName, sources, open, onOpenChange }: SourcesPopupProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto z-[1100]" overlayClassName="z-[1050] bg-black/50">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold">
            Sources for {entity}
          </DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            {domainName} domain ({sources.length} source{sources.length !== 1 ? 's' : ''})
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {sources.length === 0 ? (
            <p className="text-sm text-muted-foreground">No sources found for this combination.</p>
          ) : (
            <ul className="space-y-2">
              {sources.map((source, index) => (
                <li key={index}>
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-civic-blue hover:text-civic-blue-dark font-medium text-sm flex items-center gap-2 group"
                    title={source.title || source.url}
                  >
                    <span className="truncate">{source.title || source.url}</span>
                    <ExternalLink className="w-3 h-3 flex-shrink-0 opacity-60 group-hover:opacity-100" />
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export interface SourcesIconButtonProps {
  onClick: () => void;
  count?: number;
  className?: string;
  "data-testid"?: string;
}

export function SourcesIconButton({ onClick, count, className, ...props }: SourcesIconButtonProps) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={onClick}
            className={`inline-flex items-center justify-center text-civic-blue hover:text-civic-blue-dark mt-0.5 cursor-pointer ${className || ""}`}
            aria-label="Show sources"
            {...props}
          >
            <Files className="w-4 h-4" />
            {typeof count === "number" && (
              <span className="ml-1 text-xs text-gray-500">{count}</span>
            )}
            <span className="sr-only">Show sources</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" align="center">
          Show sources
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
